/* Grocair — penyimpanan IndexedDB per entitas.
   Tidak ada satu blob besar: setiap record disimpan dan disanitasi sendiri.
   Semua data yang masuk/keluar lewat GC.sanitize, sehingga field asing tidak
   pernah ikut tersimpan dan angka dihitung ulang secara konsisten. */
(function (root) {
  'use strict';

  var GC = root.GC = root.GC || {};

  var DB_NAME = 'grocair-portfolio-demo';
  var DB_VERSION = 1;

  var SKEMA = {
    meta: { keyPath: 'key', indexes: {} },
    staf: { keyPath: 'id', indexes: {} },
    products: { keyPath: 'id', indexes: {} },
    sales: { keyPath: 'id', indexes: { at: 'at' } },
    audit: { keyPath: 'id', indexes: { at: 'at' } },
    stokGerak: { keyPath: 'id', indexes: { produkId: 'produkId', at: 'at' } },
  };

  var SANITIZER = {
    products: 'product',
    sales: 'sale',
    staf: 'staf',
    audit: 'audit',
    stokGerak: 'stokGerak',
  };

  var SEMUA_STORE = Object.keys(SKEMA);
  var dbp = null;
  var kanal = null;
  var PING_KEY = 'grocair-portfolio-demo.ping';

  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!root.indexedDB) {
        reject(new Error('IndexedDB tidak tersedia di peramban ini'));
        return;
      }
      var permintaan = root.indexedDB.open(DB_NAME, DB_VERSION);

      permintaan.onupgradeneeded = function () {
        var db = permintaan.result;
        SEMUA_STORE.forEach(function (nama) {
          var spec = SKEMA[nama];
          var store = permintaan.transaction.objectStoreNames.contains(nama)
            ? permintaan.transaction.objectStore(nama)
            : db.createObjectStore(nama, { keyPath: spec.keyPath });
          Object.keys(spec.indexes).forEach(function (idx) {
            if (!store.indexNames.contains(idx)) {
              store.createIndex(idx, spec.indexes[idx], { unique: false });
            }
          });
        });
      };

      permintaan.onsuccess = function () {
        var db = permintaan.result;
        db.onversionchange = function () {
          try { db.close(); } catch (e) { /* sudah tertutup */ }
          dbp = null;
        };
        resolve(db);
      };

      permintaan.onerror = function () {
        dbp = null;
        reject(permintaan.error || new Error('Gagal membuka database'));
      };

      permintaan.onblocked = function () {
        // Tab lain masih memakai versi lama. Jangan menutup paksa;
        // permintaan akan selesai setelah tab itu ditutup.
      };
    });
    return dbp;
  }

  function tx(names, mode) {
    return openDb().then(function (db) {
      return db.transaction(names, mode);
    });
  }

  function selesai(t) {
    return new Promise(function (resolve, reject) {
      t.oncomplete = function () { resolve(); };
      t.onerror = function () { reject(t.error || new Error('Transaksi gagal')); };
      t.onabort = function () { reject(t.error || new Error('Transaksi dibatalkan')); };
    });
  }

  function bacaSemua(nama) {
    return tx(nama, 'readonly').then(function (t) {
      var selesaiBaca = new Promise(function (resolve, reject) {
        var r = t.objectStore(nama).getAll();
        r.onsuccess = function () { resolve(r.result || []); };
        r.onerror = function () { reject(r.error); };
      });
      return selesaiBaca;
    });
  }

  function bersihkan(nama, record) {
    if (!SKEMA[nama]) throw new Error('Store tidak dikenal: ' + nama);
    if (nama === 'meta') {
      return GC.sanitize.meta(record && record.key, record && record.value);
    }
    var fn = GC.sanitize[SANITIZER[nama]];
    return fn ? fn(record) : record;
  }

  function bacaMeta(records) {
    var meta = {};
    (records || []).forEach(function (rec) {
      var m = GC.sanitize.meta(rec && rec.key, rec && rec.value);
      if (m) meta[m.key] = m.value;
    });
    return meta;
  }

  async function loadAll() {
    var hasil = await Promise.all(SEMUA_STORE.map(function (nama) {
      return bacaSemua(nama);
    }));
    var keluar = {};
    SEMUA_STORE.forEach(function (nama, i) {
      if (nama === 'meta') {
        keluar.meta = bacaMeta(hasil[i]);
        return;
      }
      var fn = GC.sanitize[SANITIZER[nama]];
      keluar[nama] = (hasil[i] || []).map(fn).filter(Boolean);
    });
    return keluar;
  }

  async function writeTx(opsi) {
    var put = (opsi && opsi.put) || [];
    var del = (opsi && opsi.del) || [];
    var nama = [];
    put.concat(del).forEach(function (op) {
      if (nama.indexOf(op.store) < 0) nama.push(op.store);
    });
    if (!nama.length) return;

    var t = await tx(nama, 'readwrite');
    var janji = selesai(t);
    try {
      put.forEach(function (op) {
        var rec = bersihkan(op.store, op.record);
        if (!rec) throw new Error('Data tidak valid untuk ' + op.store);
        var store = t.objectStore(op.store);
        if (op.store === 'meta' && rec.key === 'pengaturan' && rec.value && typeof rec.value === 'object') {
          var r = store.get('pengaturan');
          r.onsuccess = function () {
            rec.value.lastSeenAt = Math.max(Number(rec.value.lastSeenAt) || 0,
              Number(r.result && r.result.value && r.result.value.lastSeenAt) || 0);
            store.put(rec);
          };
        } else store.put(rec);
      });
      del.forEach(function (op) {
        t.objectStore(op.store).delete(op.id);
      });
    } catch (e) {
      try { t.abort(); } catch (_) { /* sudah berhenti */ }
      throw e;
    }
    await janji;
    ping();
  }

  async function ingatWaktu(n) {
    var t = await tx('meta', 'readwrite');
    var done = selesai(t), store = t.objectStore('meta');
    var r = store.get('pengaturan');
    r.onsuccess = function () {
      if (!r.result) return;
      var rec = r.result;
      rec.value.lastSeenAt = Math.max(Number(rec.value.lastSeenAt) || 0, n);
      store.put(rec);
    };
    await done;
  }

  async function gantiLisensi(expected, record) {
    var t = await tx('meta', 'readwrite');
    var done = selesai(t), store = t.objectStore('meta'), changed = false;
    var r = store.get('lisensi');
    r.onsuccess = function () {
      var current = r.result && r.result.value && r.result.value.kunci;
      if ((current || null) !== expected) return;
      store.put({ key: 'lisensi', value: record });
      changed = true;
    };
    await done;
    if (changed) ping();
    return changed;
  }

  function put(nama, record) {
    return writeTx({ put: [{ store: nama, record: record }] });
  }

  function putMany(nama, records) {
    var ops = (records || []).map(function (record) {
      return { store: nama, record: record };
    });
    return writeTx({ put: ops });
  }

  function del(nama, id) {
    return writeTx({ del: [{ store: nama, id: id }] });
  }

  function writeSale(sale, movements) {
    var s = GC.sanitize.sale(sale);
    if (!s) return Promise.reject(new Error('Penjualan tidak valid'));
    var put = [{ store: 'sales', record: s }];
    (movements || []).forEach(function (m) {
      put.push({ store: 'stokGerak', record: m });
    });
    return writeTx({ put: put });
  }

  async function replaceAll(snapshot) {
    var snap = snapshot || {};
    var nama = SEMUA_STORE.slice();
    var ops = [];
    var meta = snap.meta || {};
    Object.keys(meta).forEach(function (k) {
      ops.push({ store: 'meta', record: { key: k, value: meta[k] } });
    });
    ['staf', 'products', 'sales', 'audit', 'stokGerak'].forEach(function (n) {
      (snap[n] || []).forEach(function (record) {
        ops.push({ store: n, record: record });
      });
    });

    var t = await tx(nama, 'readwrite');
    var janji = selesai(t);
    try {
      nama.forEach(function (n) { t.objectStore(n).clear(); });
      ops.forEach(function (op) {
        var rec = bersihkan(op.store, op.record);
        if (!rec) throw new Error('Data tidak valid untuk ' + op.store);
        t.objectStore(op.store).put(rec);
      });
    } catch (e) {
      try { t.abort(); } catch (_) { /* sudah berhenti */ }
      throw e;
    }
    await janji;
    ping();
  }

  async function migrateV1() { return { migrated: false }; }
  async function unusedLegacyMigration() {
    var ada = await loadAll();
    if (ada.meta.toko || ada.meta.installId || ada.meta.migrasi) {
      return { migrated: false };
    }

    var mentah;
    try {
      mentah = root.localStorage.getItem('warungpos.v1');
    } catch (e) {
      return { migrated: false, alasan: 'penyimpanan lama tidak bisa dibaca' };
    }
    if (mentah == null) return { migrated: false, alasan: 'tidak ada data lama' };

    // Salin mentah SEBELUM parse/apa pun, supaya data lama selalu bisa dipulihkan.
    try {
      root.localStorage.setItem('warungpos.v1.preupgrade', mentah);
    } catch (e) {
      return { migrated: false, alasan: 'tidak bisa membuat salinan data lama' };
    }

    var lama;
    try {
      lama = JSON.parse(mentah);
    } catch (e) {
      return { migrated: false, alasan: 'data lama rusak' };
    }
    if (!lama || typeof lama !== 'object') {
      return { migrated: false, alasan: 'data lama rusak' };
    }

    var produkSumber = Array.isArray(lama.products) ? lama.products : [];
    var jualSumber = Array.isArray(lama.sales) ? lama.sales : [];
    var produk = produkSumber.map(GC.sanitize.product).filter(Boolean);
    var jual = jualSumber.map(GC.sanitize.sale).filter(Boolean);

    // Jangan pernah "migrasi sebagian": kalau ada record yang hilang saat
    // sanitasi, batalkan seluruh migrasi dan biarkan data lama dipakai.
    if (produk.length !== produkSumber.length || jual.length !== jualSumber.length) {
      return { migrated: false, alasan: 'jumlah record tidak cocok' };
    }

    var meta = {
      migrasi: {
        at: new Date().toISOString(),
        produk: produk.length,
        penjualan: jual.length,
      },
    };
    if (lama.manualRecent && typeof lama.manualRecent === 'object') {
      meta.manualRecent = lama.manualRecent;
    }

    var catatan = GC.sanitize.audit({
      aksi: 'migrasi',
      detail: 'Data demo lama dipindahkan ke Grocair',
    });

    await replaceAll({
      meta: meta,
      staf: [],
      products: produk,
      sales: jual,
      audit: catatan ? [catatan] : [],
      stokGerak: [],
    });

    return { migrated: true, produk: produk.length, penjualan: jual.length };
  }

  function ping() {
    try {
      if (!kanal && root.BroadcastChannel) kanal = new root.BroadcastChannel('grocair-portfolio-demo');
      if (kanal) kanal.postMessage({ at: Date.now() });
    } catch (e) { /* BroadcastChannel tidak tersedia */ }
    try {
      root.localStorage.setItem(PING_KEY, String(Date.now()));
    } catch (e) { /* localStorage penuh/diblokir */ }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    var bc = null;
    try {
      if (root.BroadcastChannel) {
        bc = new root.BroadcastChannel('grocair-portfolio-demo');
        bc.onmessage = function () { cb(); };
      }
    } catch (e) { bc = null; }

    var lewatStorage = function (e) {
      if (e && e.key === PING_KEY) cb();
    };
    try { root.addEventListener('storage', lewatStorage); } catch (e) { /* bukan window */ }

    return function () {
      try { if (bc) bc.close(); } catch (e) { /* sudah tertutup */ }
      try { root.removeEventListener('storage', lewatStorage); } catch (e) { /* bukan window */ }
    };
  }

  GC.store = {
    NAMA_DB: DB_NAME,
    VERSI: DB_VERSION,
    STORE: SEMUA_STORE,
    open: openDb,
    loadAll: loadAll,
    put: put,
    putMany: putMany,
    del: del,
    writeTx: writeTx,
    writeSale: writeSale,
    replaceAll: replaceAll,
    migrateV1: migrateV1,
    onChange: onChange,
    ingatWaktu: ingatWaktu,
    gantiLisensi: gantiLisensi,
    ping: ping,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
