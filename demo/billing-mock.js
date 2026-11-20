/* Bridge pembelian Google Play. Di browser / Playwright (tanpa plugin native)
   pakai mock yang selalu berhasil — tidak pernah error, untuk uji alur UI.
   Plugin native Android (`AndroidBilling`) dipanggil secara dinamis saat APK berjalan.
*/
(function (root) {
  'use strict';

  function getNative() {
    return (
      root.AndroidBilling ||
      (root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.AndroidBilling) ||
      null
    );
  }

  function parse(raw, fallback) {
    if (typeof raw !== 'string') return raw || fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  root.GC = root.GC || {};
  root.GC.billing = {
    beli: function (productId) {
      var n = getNative();
      if (n && typeof n.beli === 'function') {
        try {
          var res = n.beli(productId);
          return Promise.resolve(parse(res, { ok: false, error: 'parse_failed' }));
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return Promise.resolve({ ok: true, token: 'mock-' + productId, purchaseTime: Date.now() });
    },

    pulihkan: function () {
      var n = getNative();
      if (n && typeof n.pulihkan === 'function') {
        try {
          var res = n.pulihkan();
          return Promise.resolve(parse(res, []));
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return Promise.resolve([]);
    },

    status: function () {
      var n = getNative();
      if (n && typeof n.status === 'function') {
        try {
          var res = n.status();
          return Promise.resolve(parse(res, []));
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return Promise.resolve([]);
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
