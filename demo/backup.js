/* =========================================================
   Grocair — cadangan (backup) & pemulihan.

   Aturan yang tidak boleh dilanggar:
   1. File backup TIDAK PERNAH membawa rahasia: lisensi, installId,
      hash PIN, dan hash kode pemulihan. File ini berpindah lewat
      WhatsApp; hash PIN di grup keluarga = kebocoran kredensial.
   2. Pemulihan harus bisa dibatalkan: snapshot `prerestore` diambil
      sebelum menulis, sehingga data lama selalu bisa kembali.
   3. Audit tidak pernah ditimpa. Record digabung (union).
   4. Checksum hanya pendeteksi kerusakan, bukan bukti keaslian —
      siapa pun yang mengedit JSON bisa menghitung ulang.

   Skrip klasik, tanpa dependensi. Jalan di browser dan di Node
   (unit test) karena hanya memakai Web Crypto bila tersedia.
   ========================================================= */
(function (root) {
  'use strict';

  var GC = root.GC = root.GC || {};
  var VERSI = 1;
  var MAKS_BACKUP = 40 * 1024 * 1024; // 40 MB: cukup untuk puluhan tahun warung
  var KUNCI_PRERESTORE = 'grocair-portfolio-demo.prerestore';
  var META_IKUT = ['toko', 'pengaturan'];
  var META_PERANGKAT = ['installId', 'lisensi', 'portfolioDemo'];
  // Pengaturan milik perangkat, bukan milik warung: jangan dibawa backup.
  var PENGATURAN_LOKAL = ['lockout', 'pinBelumDiset'];

  /* ------------------------------ util ------------------------------ */

  function salin(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }

  function angkaHex(n, lebar) {
    var s = Math.max(0, Math.round(Number(n) || 0)).toString(16);
    while (s.length < lebar) s = '0' + s;
    return s;
  }

  function hexDari(buf) {
    var b = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < b.length; i++) s += angkaHex(b[i], 2);
    return s;
  }

  /* JSON kanonik: key terurut rekursif, `checksum` dikecualikan.
     Dua objek dengan isi sama selalu menghasilkan teks sama. */
  function kanonik(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      return '[' + v.map(function (x) { return kanonik(x); }).join(',') + ']';
    }
    var kunci = Object.keys(v).filter(function (k) {
      return k !== 'checksum' && v[k] !== undefined;
    }).sort();
    return '{' + kunci.map(function (k) {
      return JSON.stringify(k) + ':' + kanonik(v[k]);
    }).join(',') + '}';
  }

  /* SHA-256 lewat Web Crypto (butuh secure context). Di `file://`
     crypto.subtle tidak ada, jadi dipakai FNV-1a 64-bit + panjang.
     Keduanya cukup untuk mendeteksi file rusak, dan nama algoritmanya
     ditulis di file supaya verifikasi tidak menebak. */
  function algoTersedia() {
    return (root.crypto && root.crypto.subtle && typeof root.crypto.subtle.digest === 'function')
      ? 'sha256' : 'fnv1a64';
  }

  function fnv1a(teks) {
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < teks.length; i++) {
      var c = teks.charCodeAt(i);
      h1 ^= c;
      h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 = ((h2 ^ c) * 16777619) >>> 0;
    }
    return 'fnv1a64:' + angkaHex(h1, 8) + angkaHex(h2, 8) + ':' + teks.length;
  }

  async function checksum(payload, algo) {
    var teks = kanonik(payload);
    var pilihan = algo === 'fnv1a64' ? 'fnv1a64' : algoTersedia();
    if (pilihan === 'sha256') {
      var buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(teks));
      return hexDari(buf);
    }
    return fnv1a(teks);
  }

  /* Perbandingan waktu-konstan sederhana untuk string hex. */
  function samaHex(a, b) {
    var x = String(a == null ? '' : a);
    var y = String(b == null ? '' : b);
    if (x.length !== y.length) return false;
    var beda = 0;
    for (var i = 0; i < x.length; i++) beda |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return beda === 0;
  }

  function tanggalFile(d) {
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  /* --------------------------- export --------------------------- */

  function stafTanpaRahasia(s) {
    return {
      id: s.id,
      nama: s.nama,
      peran: s.peran,
      aktif: s.aktif !== false,
    };
  }

  function pengaturanIkut(p) {
    var keluar = {};
    if (p && typeof p === 'object') {
      Object.keys(p).forEach(function (k) {
        if (PENGATURAN_LOKAL.indexOf(k) < 0) keluar[k] = salin(p[k]);
      });
    }
    return keluar;
  }

  async function exportBackup(snapshot) {
    var snap = snapshot || {};
    var meta = snap.meta || {};
    var toko = meta.toko && typeof meta.toko === 'object' ? salin(meta.toko) : {};

    var payload = {
      version: VERSI,
      exportedAt: new Date().toISOString(),
      toko: toko,
      pengaturan: pengaturanIkut(meta.pengaturan),
      products: (snap.products || []).map(salin),
      sales: (snap.sales || []).map(salin),
      stokGerak: (snap.stokGerak || []).map(salin),
      staf: (snap.staf || []).map(stafTanpaRahasia),
      audit: (snap.audit || []).map(salin),
      algo: algoTersedia(),
    };
    payload.checksum = await checksum(payload, payload.algo);

    return {
      json: JSON.stringify(payload),
      filename: 'grocair-backup-' + tanggalFile(new Date()) + '.json',
      checksum: payload.checksum,
    };
  }

  /* --------------------------- inspect --------------------------- */

  function ringkasanDari(snap) {
    var sales = snap.sales || [];
    var omzet = 0;
    var laba = 0;
    var terakhir = null;
    for (var i = 0; i < sales.length; i++) {
      var s = sales[i];
      if (s.status === 'void') continue;
      omzet += s.total || 0;
      laba += s.laba || 0;
      if (!terakhir || String(s.at) > terakhir) terakhir = s.at;
    }
    return {
      produk: (snap.products || []).length,
      penjualan: sales.filter(function (s) { return s.status !== 'void'; }).length,
      omzet: omzet,
      laba: laba,
      terakhir: terakhir,
    };
  }

  function summary(snapshot) {
    return ringkasanDari(snapshot || {});
  }

  /* Membentuk snapshot internal dari isi file. Semua record lewat
     sanitizer yang sama dengan yang dipakai IndexedDB, jadi file yang
     diedit tidak bisa menyelipkan bentuk data asing. */
  function snapshotDari(obj) {
    var sanitize = GC.sanitize;
    if (!sanitize) return null;

    function bersih(nama, fn, daftar) {
      if (daftar == null) return [];
      if (!Array.isArray(daftar)) return null;
      var out = [];
      for (var i = 0; i < daftar.length; i++) {
        var rec = fn(daftar[i]);
        if (!rec) return null; // satu record rusak = file tidak dipercaya
        out.push(rec);
      }
      return out;
    }

    var products = bersih('products', sanitize.product, obj.products);
    var sales = bersih('sales', sanitize.sale, obj.sales);
    var stokGerak = bersih('stokGerak', sanitize.stokGerak, obj.stokGerak);
    var audit = bersih('audit', sanitize.audit, obj.audit);
    if (!products || !sales || !stokGerak || !audit) return null;

    var staf = [];
    if (obj.staf != null) {
      if (!Array.isArray(obj.staf)) return null;
      for (var i = 0; i < obj.staf.length; i++) {
        var s = sanitize.staf ? sanitize.staf(obj.staf[i]) : null;
        if (!s) return null;
        // PIN dari file tidak pernah dipercaya, bahkan kalau ada.
        staf.push({ id: s.id, nama: s.nama, peran: s.peran, aktif: s.aktif !== false });
      }
    }

    var toko = obj.toko && typeof obj.toko === 'object' ? sanitize.meta('toko', obj.toko) : null;
    var pengaturan = obj.pengaturan && typeof obj.pengaturan === 'object'
      ? sanitize.meta('pengaturan', obj.pengaturan) : null;

    var meta = {};
    if (toko) meta.toko = toko.value;
    if (pengaturan) meta.pengaturan = pengaturan.value;

    return {
      meta: meta,
      staf: staf,
      products: products,
      sales: sales,
      stokGerak: stokGerak,
      audit: audit,
    };
  }

  async function inspect(text) {
    var mentah = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    if (!mentah) return { ok: false, error: 'Berkas kosong' };
    if (mentah.length > MAKS_BACKUP) return { ok: false, error: 'Berkas terlalu besar untuk backup Grocair' };

    var obj;
    try {
      obj = JSON.parse(mentah);
    } catch (_) {
      return { ok: false, error: 'Berkas rusak — isinya bukan JSON yang utuh' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, error: 'Berkas rusak — struktur tidak dikenal' };
    }
    if (Number(obj.version) !== VERSI) {
      return { ok: false, error: 'Versi backup tidak didukung (' + obj.version + ')' };
    }
    if (typeof obj.checksum !== 'string' || !obj.checksum) {
      return { ok: false, error: 'Checksum tidak ada — berkas bukan backup Grocair' };
    }

    var algo = obj.algo === 'fnv1a64' ? 'fnv1a64' : 'sha256';
    if (algoTersedia() === 'sha256' && algo === 'sha256') {
      // normal
    } else if (algoTersedia() === 'fnv1a64' && algo === 'sha256') {
      return { ok: false, error: 'Backup ini dibuat di perangkat yang mendukung SHA-256; buka aplikasi lewat http/https untuk memulihkannya' };
    }

    var hitung = await checksum(obj, algo);
    if (!samaHex(hitung, obj.checksum)) {
      return { ok: false, error: 'Checksum tidak cocok — berkas berubah atau rusak' };
    }

    var snap = snapshotDari(obj);
    if (!snap) return { ok: false, error: 'Isi backup rusak — ada data yang tidak valid' };
    return { ok: true, snapshot: snap, summary: ringkasanDari(snap), exportedAt: obj.exportedAt || null };
  }

  /* --------------------------- restore --------------------------- */

  function gabungAudit(lama, baru) {
    var ada = new Set();
    var out = [];
    (lama || []).forEach(function (r) {
      if (r && r.id && !ada.has(r.id)) { ada.add(r.id); out.push(r); }
    });
    (baru || []).forEach(function (r) {
      if (r && r.id && !ada.has(r.id)) { ada.add(r.id); out.push(r); }
    });
    return out;
  }

  function simpanPrerestore(snap) {
    try {
      root.localStorage.setItem(KUNCI_PRERESTORE, JSON.stringify(snap));
      return true;
    } catch (_) {
      return false;
    }
  }

  /* Pemulihan berurutan: cek izin → snapshot lama → tulis (satu transaksi
     IndexedDB, jadi atomik) → baca ulang & bandingkan → gabung audit.
     Bila verifikasi gagal, data lama ditulis kembali dari snapshot. */
  async function restore(snapshot, opsi) {
    if (!GC.store) return { ok: false, error: 'Penyimpanan belum siap' };

    var snap = snapshotDari(snapshot || {});
    if (!snap) return { ok: false, error: 'Data backup tidak valid' };

    var sebelum;
    try {
      sebelum = await GC.store.loadAll();
    } catch (_) {
      return { ok: false, error: 'Tidak bisa membaca data lama' };
    }

    // Izin: perangkat yang sudah punya PIN pemilik wajib PIN (sekali pakai).
    var adaPin = (sebelum.staf || []).some(function (s) {
      return s.peran === 'pemilik' && s.aktif && s.pin;
    });
    if (adaPin) {
      // Dua jalan yang sama-sama sah: sesi pemilik yang sudah terbuka, atau
      // token sekali pakai dari PIN pemilik. Sesi kasir TIDAK dinaikkan haknya;
      // token hanya membuka satu aksi ini lalu hangus.
      var sesiSekarang = GC.auth && GC.auth.session ? GC.auth.session() : null;
      var pemilikSesi = !!(sesiSekarang && sesiSekarang.peran === 'pemilik'
        && GC.auth.can('restore') === 'izin');
      var token = opsi && opsi.token ? opsi.token : null;
      var tokenSah = token ? GC.auth.consumeApproval(token, 'restore') : false;
      if (!pemilikSesi && !tokenSah) {
        return { ok: false, error: 'Pemulihan butuh PIN pemilik' };
      }
    }

    if (!simpanPrerestore(sebelum)) {
      // Tanpa snapshot pembatalan, pemulihan tidak boleh jalan.
      return { ok: false, error: 'Penyimpanan penuh — cadangan pembatalan gagal dibuat' };
    }

    var audit = gabungAudit(sebelum.audit, snap.audit);
    var sesi = GC.auth && GC.auth.session ? GC.auth.session() : null;
    var catatan = GC.sanitize.audit({
      aksi: 'restore',
      stafId: sesi ? sesi.stafId : null,
      detail: 'Pulihkan backup: ' + snap.products.length + ' barang, '
        + snap.sales.length + ' transaksi, audit ' + audit.length + ' record',
    });
    if (catatan) audit.push(catatan);

    var pengaturan = Object.assign({}, snap.meta.pengaturan || {}, {
      // PIN dari file tidak pernah dipakai: siapa pun yang memulihkan
      // wajib memasang PIN baru sebelum aplikasi bisa dipakai.
      pinBelumDiset: true,
      lockout: { gagal: 0, sampai: 0 },
    });

    var meta = {};
    META_PERANGKAT.forEach(function (k) {
      if (sebelum.meta && sebelum.meta[k] !== undefined) meta[k] = sebelum.meta[k];
    });
    if (snap.meta.toko) meta.toko = snap.meta.toko;
    meta.pengaturan = pengaturan;

    var lengkap = {
      meta: meta,
      staf: snap.staf,
      products: snap.products,
      sales: snap.sales,
      stokGerak: snap.stokGerak,
      audit: audit,
    };

    try {
      await GC.store.replaceAll(lengkap);
    } catch (e) {
      return { ok: false, error: 'Gagal menulis data — data lama tidak diubah' };
    }

    var sesudah;
    try {
      sesudah = await GC.store.loadAll();
    } catch (_) {
      sesudah = null;
    }
    var cocok = sesudah
      && sesudah.products.length === lengkap.products.length
      && sesudah.sales.length === lengkap.sales.length
      && sesudah.staf.length === lengkap.staf.length;

    if (!cocok) {
      try { await GC.store.replaceAll(sebelum); } catch (_) { /* sebaik mungkin */ }
      return { ok: false, error: 'Verifikasi gagal — data lama dikembalikan' };
    }

    if (GC.auth && GC.auth.logout) GC.auth.logout();
    return {
      ok: true,
      produk: sesudah.products.length,
      penjualan: sesudah.sales.length,
      audit: sesudah.audit.length,
      butuhPinBaru: true,
    };
  }

  function bacaPrerestore() {
    try {
      var mentah = root.localStorage.getItem(KUNCI_PRERESTORE);
      return mentah ? JSON.parse(mentah) : null;
    } catch (_) {
      return null;
    }
  }

  GC.backup = {
    VERSI: VERSI,
    KUNCI_PRERESTORE: KUNCI_PRERESTORE,
    MAKS_BACKUP: MAKS_BACKUP,
    export: exportBackup,
    exportBackup: exportBackup,
    checksum: checksum,
    kanonik: kanonik,
    inspect: inspect,
    summary: summary,
    restore: restore,
    simpanPrerestore: simpanPrerestore,
    bacaPrerestore: bacaPrerestore,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
