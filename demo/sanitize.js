/* Grocair — validator murni per entitas.
   Skrip klasik (bukan modul) supaya tetap jalan di file:// dan di Node untuk unit test.
   Aturan: setiap sanitizer MEMBANGUN objek baru dari field yang dikenal saja.
   Tidak pernah menyebar (...raw), sehingga field asing/berbahaya tidak ikut tersimpan. */
(function (root) {
  'use strict';

  var GC = root.GC = root.GC || {};

  var LIMITS = {
    teksPendek: 40,
    teks: 80,
    teksPanjang: 300,
    harga: 1e9,
    stok: 1e6,
    qty: 1000,
    total: 1e11,
    // Maksimum bilangan aman untuk integer: cukup untuk stempel waktu
    // (epoch ms) hingga tahun 292,5 miliar, aman dari overflow tapi
    // mencegah nilai berbahaya disimpan di meta. Sebelumnya 1e12 (~2001),
    // yang memotong Date.now() dan merusak penyeimbangan jam lisensi.
    nilaiMeta: Number.MAX_SAFE_INTEGER,
  };

  var STEP_PEMBULATAN = [0, 100, 500];

  function text(v, max) {
    if (v == null) return '';
    var s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    s = s.trim();
    var batas = typeof max === 'number' && max > 0 ? max : LIMITS.teks;
    return s.length > batas ? s.slice(0, batas) : s;
  }

  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') {
      var s = v.replace(/rp/gi, '').replace(/[\s.,]/g, '');
      if (!s) return 0;
      var n = Number(s);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  function clamp(n, min, max) {
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function money(v, max) {
    var batas = typeof max === 'number' && max > 0 ? max : LIMITS.harga;
    return Math.round(clamp(toNumber(v), 0, batas));
  }

  function int(v, max) {
    var batas = typeof max === 'number' && max > 0 ? max : LIMITS.stok;
    return Math.trunc(clamp(toNumber(v), 0, batas));
  }

  function signed(v, max) {
    var batas = typeof max === 'number' && max > 0 ? max : LIMITS.stok;
    return Math.trunc(clamp(toNumber(v), -batas, batas));
  }

  function uid(prefix) {
    var p = prefix || 'x';
    var rnd = '';
    try {
      var buf = new Uint8Array(8);
      if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(buf);
      else for (var i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
      for (var j = 0; j < buf.length; j++) rnd += ('0' + buf[j].toString(16)).slice(-2);
    } catch (e) {
      rnd = String(Date.now()) + Math.floor(Math.random() * 1e9).toString(16);
    }
    return p + '_' + rnd;
  }

  function id(v, prefix) {
    var s = text(v, 60).replace(/[^A-Za-z0-9_-]/g, '');
    return s || uid(prefix || 'x');
  }

  function iso(v) {
    if (typeof v === 'string' && v) {
      var t = Date.parse(v);
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
    return new Date().toISOString();
  }

  function roundToNearest(x, step) {
    var s = STEP_PEMBULATAN.indexOf(Number(step)) >= 0 ? Number(step) : 0;
    return s ? Math.round(x / s) * s : x;
  }

  function product(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = text(raw.name, LIMITS.teks);
    if (!name) return null;
    return {
      id: id(raw.id, 'p'),
      name: name,
      cat: text(raw.cat, LIMITS.teksPendek) || 'Lainnya',
      satuan: text(raw.satuan, 12) || 'pcs',
      barcode: text(raw.barcode, 40),
      cost: money(raw.cost, LIMITS.harga),
      price: money(raw.price, LIMITS.harga),
      autoPrice: raw.autoPrice === true,
      margin: money(raw.margin, 1000),
      stock: int(raw.stock, LIMITS.stok),
      stokMinimum: int(raw.stokMinimum, LIMITS.stok),
      aktif: raw.aktif !== false,
    };
  }

  function saleItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = text(raw.name, LIMITS.teks);
    if (!name) return null;
    var qty = int(raw.qty, LIMITS.qty);
    if (qty <= 0) return null;
    return {
      id: text(raw.id, 60) || id('li'),
      name: name,
      price: money(raw.price, LIMITS.harga),
      cost: money(raw.cost, LIMITS.harga),
      qty: qty,
    };
  }

  function manualEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var nama = text(raw.nama, LIMITS.teks);
    if (!nama) return null;
    return {
      nama: nama,
      harga: money(raw.harga, LIMITS.harga),
      hargaNormal: money(raw.hargaNormal, LIMITS.harga),
      produkId: text(raw.produkId, 60) || null,
      selisih: signed(raw.selisih, LIMITS.harga),
    };
  }

  function sale(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var items = [];
    if (Array.isArray(raw.items)) {
      for (var i = 0; i < raw.items.length; i++) {
        var it = saleItem(raw.items[i]);
        if (it) items.push(it);
      }
    }
    var subtotal = 0;
    for (var j = 0; j < items.length; j++) subtotal += items[j].price * items[j].qty;
    subtotal = clamp(subtotal, 0, LIMITS.total);

    var diskon = Math.min(money(raw.diskon, LIMITS.total), subtotal);
    var pembulatan = STEP_PEMBULATAN.indexOf(Number(raw.pembulatan)) >= 0 ? Number(raw.pembulatan) : 0;
    var total = clamp(roundToNearest(subtotal - diskon, pembulatan), 0, subtotal);
    var bayar = Math.max(total, money(raw.bayar, LIMITS.total));
    var laba = 0;
    var adaModal = false;
    for (var k = 0; k < items.length; k++) {
      if (items[k].cost > 0) {
        adaModal = true;
        laba += (items[k].price - items[k].cost) * items[k].qty;
      }
    }
    // Baris tanpa modal tidak dihitung sebagai laba. Diskon hanya mengurangi
    // laba bila memang ada baris bermodal; kalau tidak, laba tetap 0 (bukan negatif palsu).
    if (adaModal) laba -= diskon;
    else laba = 0;

    var manual = [];
    if (Array.isArray(raw.manual)) {
      for (var m = 0; m < raw.manual.length; m++) {
        var me = manualEntry(raw.manual[m]);
        if (me) manual.push(me);
      }
    }

    return {
      id: id(raw.id, 's'),
      at: iso(raw.at),
      kasirId: text(raw.kasirId, 60) || null,
      items: items,
      subtotal: subtotal,
      diskon: diskon,
      pembulatan: pembulatan,
      total: total,
      laba: laba,
      bayar: bayar,
      kembali: Math.max(0, bayar - total),
      status: raw.status === 'void' ? 'void' : 'selesai',
      disetujuiOleh: text(raw.disetujuiOleh, 60) || null,
      manual: manual,
    };
  }

  function pinRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.salt !== 'string' || typeof raw.hash !== 'string') return null;
    var iter = Number(raw.iter);
    if (!Number.isFinite(iter) || iter < 1000 || iter > 2000000) return null;
    return {
      salt: text(raw.salt, 64),
      hash: text(raw.hash, 128),
      iter: Math.round(iter),
    };
  }

  function staf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var nama = text(raw.nama, LIMITS.teksPendek);
    if (!nama) return null;
    return {
      id: id(raw.id, 'st'),
      nama: nama,
      peran: raw.peran === 'pemilik' ? 'pemilik' : 'kasir',
      pin: pinRecord(raw.pin),
      aktif: raw.aktif !== false,
    };
  }

  function audit(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var aksi = text(raw.aksi, LIMITS.teksPendek);
    if (!aksi) return null;
    var detail = '';
    if (typeof raw.detail === 'string') {
      detail = text(raw.detail, LIMITS.teksPanjang);
    } else if (raw.detail && typeof raw.detail === 'object') {
      try {
        detail = text(JSON.stringify(deep(raw.detail, 0)), LIMITS.teksPanjang);
      } catch (e) {
        detail = '';
      }
    }
    return {
      id: id(raw.id, 'a'),
      at: iso(raw.at),
      stafId: text(raw.stafId, 60) || null,
      aksi: aksi,
      detail: detail,
    };
  }

  var SUMBER_GERAK = ['jual', 'masuk', 'koreksi', 'hapus'];

  function stokGerak(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var produkId = text(raw.produkId, 60);
    if (!produkId) return null;
    return {
      id: id(raw.id, 'g'),
      at: iso(raw.at),
      stafId: text(raw.stafId, 60) || null,
      produkId: produkId,
      delta: signed(raw.delta, LIMITS.stok),
      sebelum: int(raw.sebelum, LIMITS.stok),
      sesudah: int(raw.sesudah, LIMITS.stok),
      alasan: text(raw.alasan, LIMITS.teks),
      sumber: SUMBER_GERAK.indexOf(raw.sumber) >= 0 ? raw.sumber : 'koreksi',
    };
  }

  var TERLARANG = { __proto__: 1, constructor: 1, prototype: 1 };

  function deep(v, depth) {
    if (v == null) return null;
    var t = typeof v;
    if (t === 'string') return text(v, 2000);
    if (t === 'number') return Number.isFinite(v) ? clamp(v, -LIMITS.nilaiMeta, LIMITS.nilaiMeta) : 0;
    if (t === 'boolean') return v;
    if (t !== 'object') return null;
    if (depth >= 4) return null;
    if (Array.isArray(v)) {
      var arr = [];
      var n = Math.min(v.length, 500);
      for (var i = 0; i < n; i++) arr.push(deep(v[i], depth + 1));
      return arr;
    }
    var out = {};
    var keys = Object.keys(v);
    var m = Math.min(keys.length, 60);
    for (var k = 0; k < m; k++) {
      var key = keys[k];
      if (Object.prototype.hasOwnProperty.call(TERLARANG, key)) continue;
      out[text(key, 40)] = deep(v[key], depth + 1);
    }
    return out;
  }

  function meta(key, raw) {
    var k = text(key, 40);
    if (!/^[a-z][A-Za-z0-9._-]*$/.test(k)) return null;
    return { key: k, value: deep(raw, 0) };
  }

  GC.sanitize = {
    LIMITS: LIMITS,
    text: text,
    money: money,
    int: int,
    signed: signed,
    id: id,
    product: product,
    saleItem: saleItem,
    sale: sale,
    staf: staf,
    audit: audit,
    stokGerak: stokGerak,
    meta: meta,
    deep: deep,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
