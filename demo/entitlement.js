/* Entitlement & akses fitur — state machine tunggal (spec §5).
   Status: memeriksa | trial | aktif | kadaluwarsa.
   Fitur lanjutan: laporan, staf, backup_restore.
   Dasar: kasir, barang, kalkulator, lihat stok, riwayat sendiri.
   Tanpa server: pembelian disimpan di memori per sesi + cache (meta.entitlement),
   diverifikasi ulang saat boot & online. Grace 30 hari offline.
 */
(function (root) {
  'use strict';

  var TRIAL_MS = 30 * 86400000;
  var GRACE_MS = 30 * 86400000;
  var CLOCK_SKEW_MS = 6 * 60 * 60000;

  var LANJUTAN = { laporan: true, staf: true, backup_restore: true };
  var DASAR = { kasir: true, barang: true, kalkulator: true };

  var state = {
    status: 'memeriksa',
    trialStart: null,
    lastSeenAt: null,
    purchaseToken: null,
    productId: null,
    purchaseTime: null,
    verifiedAt: null,
    oldestSaleAt: null,
  };
  var listeners = [];
  var clockOverride = null;

  function emit() {
    listeners.forEach(function (cb) {
      try { cb(state.status); } catch (_) { /* abaikan listener yang error */ }
    });
  }

  function now() {
    return clockOverride !== null ? clockOverride : Date.now();
  }

  function validasiClock() {
    var n = now();
    var ls = state.lastSeenAt;
    if (ls && n < ls - CLOCK_SKEW_MS) {
      state.jamMundur = true;
    } else {
      state.jamMundur = false;
    }
    var effective = Math.max(n, ls || 0);
    state.lastSeenAt = effective;
    if (direct() && effective > (ls || 0) && root.GC.store && root.GC.store.ingatWaktu) {
      root.GC.store.ingatWaktu(effective).catch(function () { /* boot mencoba lagi; batas offline tanpa server */ });
    }
    return effective;
  }

  function direct() { return root.GC_FLAVOR && root.GC_FLAVOR.flavor === 'direct'; }

  function hitungStatus(n) {
    if (direct() && state.licenseExpires && n < state.licenseExpires) return 'aktif';
    if (!direct() && state.purchaseToken && state.verifiedAt && n - state.verifiedAt <= GRACE_MS) {
      return 'aktif';
    }
    var mulai = state.trialStart;
    if (state.oldestSaleAt && (!mulai || state.oldestSaleAt < mulai)) mulai = state.oldestSaleAt;
    if (!mulai) mulai = n;
    return n - mulai <= TRIAL_MS ? 'trial' : 'kadaluwarsa';
  }

  function simpan(status) {
    root.GC = root.GC || {};
    root.GC.entitlementCache = {
      status: status,
      purchaseToken: state.purchaseToken,
      productId: state.productId,
      purchaseTime: state.purchaseTime,
      verifiedAt: state.verifiedAt,
      trialStart: state.trialStart,
      lastSeenAt: state.lastSeenAt,
    };
  }

  root.GC = root.GC || {};
  root.GC.entitlement = {
    status: function () {
      if (direct() || (state.status === 'memeriksa' && (state.trialStart || state.purchaseToken))) {
        state.status = hitungStatus(validasiClock());
      }
      return state.status;
    },

    jamMundur: function () {
      return !!state.jamMundur;
    },

    sisaHariTrial: function () {
      if (this.status() !== 'trial' || !state.trialStart) return null;
      var sisa = Math.ceil((TRIAL_MS - (now() - state.trialStart)) / 86400000);
      return Math.max(0, sisa);
    },

    can: function (fitur) {
      var s = this.status();
      if (LANJUTAN[fitur]) {
        return s === 'trial' || s === 'aktif';
      }
      return DASAR[fitur] ? true : s !== 'memeriksa' ? true : true;
    },

    quota: function (produkAktif, transaksiHariIni) {
      var maxProduk = 30;
      var maxTransaksi = 20;
      var s = this.status();
      var takTerbatas = s === 'trial' || s === 'aktif';
      return {
        produkMax: maxProduk,
        transaksiMaxPerHari: maxTransaksi,
        bolehTambahProduk: takTerbatas || produkAktif < maxProduk,
        bolehTransaksi: takTerbatas || transaksiHariIni < maxTransaksi,
        sisaProduk: takTerbatas ? null : Math.max(0, maxProduk - produkAktif),
        sisaTransaksi: takTerbatas ? null : Math.max(0, maxTransaksi - transaksiHariIni),
      };
    },

    beli: function (productId) {
      if (direct()) return Promise.reject(new Error('Pembelian direct melalui WhatsApp'));
      return root.GC.billing.beli(productId).then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'pembelian gagal');
        var n = validasiClock();
        state.purchaseToken = res.token;
        state.productId = productId;
        state.purchaseTime = res.purchaseTime || n;
        state.verifiedAt = n;
        state.lastSeenAt = n;
        state.status = hitungStatus(n);
        simpan('aktif');
        emit();
        return { ok: true, productId: productId };
      });
    },

    pulihkan: function () {
      if (direct()) return Promise.reject(new Error('Masukkan ulang kode aktivasi'));
      return root.GC.billing.pulihkan().then(function (daftar) {
        var n = validasiClock();
        if (!daftar || daftar.length === 0) {
          state.status = hitungStatus(n);
          emit();
          return { restored: false };
        }
        var terbaru = daftar.reduce(function (terbaik, p) {
          return (p.purchaseTime || 0) > (terbaik.purchaseTime || 0) ? p : terbaik;
        }, { purchaseTime: 0 });
        state.purchaseToken = terbaru.token || null;
        state.productId = terbaru.productId || null;
        state.purchaseTime = terbaru.purchaseTime || n;
        state.verifiedAt = n;
        state.lastSeenAt = n;
        state.status = 'aktif';
        simpan('aktif');
        emit();
        return { restored: true, productId: state.productId };
      });
    },

    aktivasiLisensi: async function (kunciText, installId) {
      if (!direct()) return { ok: false, error: 'varian_play' };
      var res = await root.GC.license.verifyActive(kunciText, installId, validasiClock());
      if (!res.ok) return { ok: false, error: res.reason };
      if (state.licenseExpires && res.payload.expires < state.licenseExpires) return { ok: false, error: 'durasi_lebih_pendek' };
      var record = { kunci: kunciText.trim() };
      // Bandingkan dan ganti dalam transaksi; verifikasi signature di luar transaksi IDB.
      for (;;) {
        var saved = (await root.GC.store.loadAll()).meta.lisensi;
        var previous = saved && saved.kunci || null;
        if (previous) {
          var old = await root.GC.license.verifyActive(previous, installId, validasiClock());
          if (old.ok && old.payload.expires > res.payload.expires) return { ok: false, error: 'durasi_lebih_pendek' };
        }
        if (await root.GC.store.gantiLisensi(previous, record)) break;
      }
      state.licenseExpires = res.payload.expires;
      state.status = hitungStatus(validasiClock());
      simpan(state.status);
      emit();
      return { ok: true, expires: state.licenseExpires };
    },

    muatLisensi: async function (record, installId) {
      state.licenseExpires = null;
      if (direct() && record && record.kunci) {
        var res = await root.GC.license.verifyActive(record.kunci, installId, validasiClock());
        if (res.ok) state.licenseExpires = res.payload.expires;
      }
      state.status = hitungStatus(validasiClock());
      return state.status;
    },

    lisensiInfo: function () {
      var n = validasiClock();
      return { aktif: direct() && this.status() === 'aktif', expires: state.licenseExpires || null,
        sisaHari: state.licenseExpires ? Math.max(0, Math.ceil((state.licenseExpires - n) / 86400000)) : null };
    },

    init: function () {
      var cache = root.GC && root.GC.entitlementCache;
      if (cache) {
        state.status = cache.status;
        state.purchaseToken = cache.purchaseToken || null;
        state.productId = cache.productId || null;
        state.purchaseTime = cache.purchaseTime || null;
        state.verifiedAt = cache.verifiedAt || null;
        state.trialStart = cache.trialStart || null;
        state.lastSeenAt = cache.lastSeenAt || null;
      }
      if (!state.trialStart) {
        state.trialStart = now();
      }
      if (!state.lastSeenAt) {
        state.lastSeenAt = now();
      }
      state.status = hitungStatus(validasiClock());
      simpan(state.status);
      emit();
      return Promise.resolve(state.status);
    },

    onChange: function (cb) {
      listeners.push(cb);
      return function () {
        listeners = listeners.filter(function (l) { return l !== cb; });
      };
    },

    // --- helpers untuk uji (khusus testing) ---
    _reset: function () {
      state = {
        status: 'memeriksa', trialStart: null, lastSeenAt: null,
        purchaseToken: null, productId: null, purchaseTime: null,
        verifiedAt: null, oldestSaleAt: null, jamMundur: false,
      };
      listeners = [];
      clockOverride = null;
      delete root.GC.entitlementCache;
    },

    _setTrialStart: function (ts) { state.trialStart = ts; state.status = hitungStatus(validasiClock()); },
    _setLastSeen: function (ts) { state.lastSeenAt = ts; state.status = hitungStatus(validasiClock()); },
    _setNow: function (ts) { clockOverride = ts; state.status = hitungStatus(validasiClock()); },
    _setPurchase: function (p) {
      state.purchaseToken = p.token;
      state.productId = p.productId;
      state.purchaseTime = p.purchaseTime;
      state.verifiedAt = p.purchaseTime;
      state.status = p.status || 'aktif';
    },
    _setOldestSale: function (ts) { state.oldestSaleAt = ts; },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
