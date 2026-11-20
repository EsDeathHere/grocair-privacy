/* Grocair — autentikasi & izin (murni, tanpa DOM, tanpa penyimpanan).
   Modul ini tidak pernah menyimpan ke IndexedDB/localStorage: pemanggil yang
   menyimpan (GC.store.put('meta', ...)). Tujuannya supaya aturan keamanan bisa
   diuji tanpa browser dan tidak bisa "dilewati" oleh kode UI.

   Aturan inti:
   - PIN disimpan sebagai PBKDF2-SHA256 (210.000 iterasi) + salt acak per PIN.
   - Sesi hanya di memori. Reload = sesi hilang.
   - Default-deny: tanpa sesi, semua aksi ditolak.
   - PIN pemilik TIDAK menaikkan peran. Ia hanya menerbitkan token sekali pakai
     untuk satu aksi, yang kedaluwarsa dalam 60 detik.
*/
(function (root) {
  'use strict';

  var GC = root.GC = root.GC || {};

  var ITERASI = 210000;
  var PANJANG_TOKEN_BYTE = 16;
  var TTL_APPROVAL_MS = 60000;
  var BATAS_DISKON_KASIR = 1000;
  var MANUAL_BAWAH = 0.9;   // kasir boleh turun 10% dari harga normal
  var MANUAL_ATAS = 1.2;    // dan naik 20%
  var MAKS_GAGAL = 5;
  var TUNGGU_MS = 30000;
  var IDLE_PEMILIK_MS = 5 * 60 * 1000;

  var ALFABET_KODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  var sesi = null;            // { stafId, peran, lastActive }
  var dipakaiBersama = false; // true = perangkat dipakai orang lain juga
  var approvals = new Map();  // token -> { aksi, refId, nominal, exp }

  function enc(str) {
    return new TextEncoder().encode(String(str));
  }

  function hex(buf) {
    var b = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }

  function dariHex(s) {
    var t = String(s || '');
    if (t.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(t)) return null;
    var out = new Uint8Array(t.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
    return out;
  }

  function acak(n) {
    var buf = new Uint8Array(n);
    if (root.crypto && root.crypto.getRandomValues) {
      root.crypto.getRandomValues(buf);
    } else {
      throw new Error('Sumber acak kriptografis tidak tersedia');
    }
    return buf;
  }

  function subtle() {
    var s = root.crypto && root.crypto.subtle;
    if (!s) throw new Error('WebCrypto (crypto.subtle) tidak tersedia');
    return s;
  }

  /* Perbandingan constant-time: waktu eksekusi tidak bergantung pada isi. */
  function samaPersis(a, b) {
    var x = String(a == null ? '' : a);
    var y = String(b == null ? '' : b);
    if (x.length !== y.length) return false;
    var beda = 0;
    for (var i = 0; i < x.length; i++) beda |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return beda === 0;
  }

  async function pbkdf2(pin, saltHex, iter) {
    var s = subtle();
    var kunci = await s.importKey('raw', enc(pin), 'PBKDF2', false, ['deriveBits']);
    var bit = await s.deriveBits(
      { name: 'PBKDF2', salt: dariHex(saltHex), iterations: iter, hash: 'SHA-256' },
      kunci,
      256
    );
    return hex(bit);
  }

  function pinValid(pin) {
    return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
  }

  /* Turunkan hash tanpa memeriksa bentuk masukan: dipakai PIN (angka) dan
     kode pemulihan (huruf+angka). Pemeriksaan bentuk ada di pemanggilnya. */
  async function turunkan(nilai, salt, iter) {
    var putaran = Number(iter) > 0 ? Math.min(Math.round(Number(iter)), 2000000) : ITERASI;
    var saltHex = typeof salt === 'string' && /^[0-9a-f]{16,64}$/i.test(salt) ? salt : hex(acak(16));
    var hasil = await pbkdf2(String(nilai), saltHex, putaran);
    return { salt: saltHex, hash: hasil, iter: putaran };
  }

  async function hashPin(pin, salt, iter) {
    if (!pinValid(pin)) throw new Error('PIN harus 4–8 angka');
    return turunkan(pin, salt, iter);
  }

  async function verifikasi(nilai, rec) {
    try {
      if (!rec || typeof rec.salt !== 'string' || typeof rec.hash !== 'string') return false;
      var iter = Number(rec.iter) > 0 ? Math.round(Number(rec.iter)) : ITERASI;
      var hasil = await pbkdf2(String(nilai), rec.salt, iter);
      return samaPersis(hasil, rec.hash);
    } catch (e) {
      return false;
    }
  }

  async function verifyPin(pin, rec) {
    if (!pinValid(pin)) return false;
    return verifikasi(pin, rec);
  }

  function newRecoveryCode() {
    var raw = acak(10);
    var kode = '';
    for (var i = 0; i < 10; i++) kode += ALFABET_KODE[raw[i] % ALFABET_KODE.length];
    return kode;
  }

  /* Kode pemulihan diketik manusia: buang spasi/strip, besarkan huruf.
     Alfabet sengaja tidak memuat 0/O/1/I/L, jadi tidak ada karakter ambigu
     yang perlu dipetakan — kode dengan huruf itu memang tidak valid. */
  function normalKode(kode) {
    return String(kode == null ? '' : kode).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  async function hashRecovery(code) {
    var kode = normalKode(code);
    if (kode.length !== 10) throw new Error('Kode pemulihan harus 10 karakter');
    return turunkan(kode, null, ITERASI);
  }

  async function verifyRecovery(code, rec) {
    var kode = normalKode(code);
    if (kode.length !== 10) return false;
    return verifikasi(kode, rec);
  }

  /* ---------------- token persetujuan sekali pakai ---------------- */

  function buangKedaluwarsa() {
    var now = Date.now();
    approvals.forEach(function (v, k) {
      if (!v || v.exp <= now) approvals.delete(k);
    });
  }

  function issueApproval(opsi) {
    var o = opsi || {};
    buangKedaluwarsa();
    // ttl negatif/0 = token yang sudah kedaluwarsa saat dibuat (dipakai test),
    // dan ttl tidak pernah boleh lebih dari 10 menit.
    var minta = Number(o.ttlMs);
    var ttl = Number.isFinite(minta) ? Math.min(minta, 10 * 60 * 1000) : TTL_APPROVAL_MS;
    var token = hex(acak(PANJANG_TOKEN_BYTE));
    var rec = {
      aksi: String(o.aksi == null ? '' : o.aksi),
      refId: o.refId == null ? null : String(o.refId),
      nominal: Number(o.nominal) || 0,
      exp: Date.now() + ttl,
    };
    approvals.set(token, rec);
    return { token: token, aksi: rec.aksi, refId: rec.refId, nominal: rec.nominal, exp: rec.exp };
  }

  /* Sekali pakai: token dibuang lebih dulu, jadi percobaan kedua selalu gagal
     walaupun aksi pertama belum selesai menyimpan. */
  function consumeApproval(token, aksi, refId) {
    var kunci = String(token == null ? '' : token);
    var rec = approvals.get(kunci);
    if (!rec) return false;
    approvals.delete(kunci);
    if (!(rec.exp > Date.now())) return false;
    if (rec.aksi !== String(aksi == null ? '' : aksi)) return false;
    var ref = refId == null ? null : String(refId);
    if (rec.refId !== ref) return false;
    return true;
  }

  /* ---------------- lockout ---------------- */

  function bacaLockout(pengaturan) {
    var l = pengaturan && pengaturan.lockout;
    var gagal = l && Number.isFinite(Number(l.gagal)) ? Math.max(0, Math.round(Number(l.gagal))) : 0;
    var sampai = l && Number.isFinite(Number(l.sampai)) ? Number(l.sampai) : 0;
    return { gagal: gagal, sampai: sampai };
  }

  function lockout(pengaturan, sekarang) {
    var now = Number.isFinite(Number(sekarang)) ? Number(sekarang) : Date.now();
    var l = bacaLockout(pengaturan);
    if (l.sampai > now) {
      return { terkunci: true, sisaDetik: Math.ceil((l.sampai - now) / 1000) };
    }
    return { terkunci: false, sisaDetik: 0 };
  }

  function fail(pengaturan, sekarang) {
    var now = Number.isFinite(Number(sekarang)) ? Number(sekarang) : Date.now();
    var l = bacaLockout(pengaturan);
    var dasar = pengaturan && typeof pengaturan === 'object' ? pengaturan : {};
    if (l.sampai > now) {
      // Masih terkunci: jangan menambah hitungan, jangan memperpanjang.
      return {
        pengaturan: dasar,
        terkunci: true,
        sisaDetik: Math.ceil((l.sampai - now) / 1000),
      };
    }
    var gagal = l.gagal + 1;
    var terkunci = gagal >= MAKS_GAGAL;
    var baru = Object.assign({}, dasar, {
      lockout: terkunci ? { gagal: 0, sampai: now + TUNGGU_MS } : { gagal: gagal, sampai: 0 },
    });
    return {
      pengaturan: baru,
      terkunci: terkunci,
      sisaDetik: terkunci ? Math.ceil(TUNGGU_MS / 1000) : 0,
    };
  }

  function resetLockout(pengaturan) {
    var dasar = pengaturan && typeof pengaturan === 'object' ? pengaturan : {};
    return { pengaturan: Object.assign({}, dasar, { lockout: { gagal: 0, sampai: 0 } }) };
  }

  /* ---------------- sesi & peran ---------------- */

  function setShared(v) {
    dipakaiBersama = v === true;
    if (!dipakaiBersama && sesi) sesi.lastActive = Date.now();
  }

  function isShared() {
    return dipakaiBersama;
  }

  function login(staf) {
    if (!staf || typeof staf !== 'object' || !staf.id) return null;
    var peran = staf.peran === 'pemilik' ? 'pemilik' : 'kasir';
    if (staf.aktif === false) return null;
    sesi = { stafId: String(staf.id), peran: peran, lastActive: Date.now() };
    return { stafId: sesi.stafId, peran: sesi.peran, lastActive: sesi.lastActive };
  }

  function logout() {
    sesi = null;
  }

  function touch() {
    if (sesi) sesi.lastActive = Date.now();
  }

  function session() {
    if (!sesi) return null;
    // Sesi pemilik berakhir setelah 5 menit tanpa interaksi, hanya di perangkat
    // yang dipakai bersama. Perangkat pribadi tidak dibuatkan gesekan ekstra.
    if (dipakaiBersama && sesi.peran === 'pemilik' && Date.now() - sesi.lastActive > IDLE_PEMILIK_MS) {
      sesi = null;
      return null;
    }
    return { stafId: sesi.stafId, peran: sesi.peran, lastActive: sesi.lastActive };
  }

  function angka(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /* can(action, ctx) -> 'izin' | 'pin' | 'tolak'
     'pin' berarti: boleh, TAPI butuh PIN pemilik sekali pakai untuk aksi ini.
     Jangan pernah memperlakukan 'pin' sebagai izin. */
  function can(action, ctx) {
    var s = session();
    if (!s) return 'tolak'; // default-deny

    var aksi = String(action == null ? '' : action);
    var c = ctx && typeof ctx === 'object' ? ctx : {};

    if (s.peran === 'pemilik') {
      return AKSI_DIKENAL.indexOf(aksi) >= 0 ? 'izin' : 'tolak';
    }

    switch (aksi) {
      case 'jual':
        return 'izin';

      case 'hargaManual': {
        var normal = angka(c.hargaNormal);
        var harga = angka(c.harga);
        if (!(harga > 0)) return 'tolak';
        // Tanpa harga pembanding = entri bebas: khusus pemilik.
        if (!(normal > 0)) return 'pin';
        if (harga < normal * MANUAL_BAWAH || harga > normal * MANUAL_ATAS) return 'pin';
        return 'izin';
      }

      case 'diskon': {
        var nominal = angka(c.nominal);
        if (nominal < 0) return 'tolak';
        return nominal > BATAS_DISKON_KASIR ? 'pin' : 'izin';
      }

      // Kasir hanya melihat stok; sisanya hak pemilik.
      case 'stokMasuk':
      case 'ubahBarang':
      case 'hapusBarang':
      case 'restore':
      case 'lisensi':
      case 'staf':
      case 'ekspor':
      case 'backup':
        return 'tolak';

      default:
        return 'tolak';
    }
  }

  var AKSI_DIKENAL = [
    'jual', 'hargaManual', 'diskon', 'stokMasuk', 'koreksi',
    'ubahBarang', 'hapusBarang', 'restore', 'lisensi', 'staf', 'ekspor', 'backup',
  ];

  GC.auth = {
    ITERASI: ITERASI,
    BATAS_DISKON_KASIR: BATAS_DISKON_KASIR,
    MAKS_GAGAL: MAKS_GAGAL,
    TUNGGU_DETIK: TUNGGU_MS / 1000,
    hashPin: hashPin,
    verifyPin: verifyPin,
    newRecoveryCode: newRecoveryCode,
    hashRecovery: hashRecovery,
    verifyRecovery: verifyRecovery,
    normalKode: normalKode,
    issueApproval: issueApproval,
    consumeApproval: consumeApproval,
    lockout: lockout,
    fail: fail,
    resetLockout: resetLockout,
    setShared: setShared,
    isShared: isShared,
    session: session,
    login: login,
    logout: logout,
    touch: touch,
    can: can,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
