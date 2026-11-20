/* =========================================================
   Grocair — Konfigurasi varian pembuatan (flavor).

   `play` (default): versi Google Play. Billing native, tombol paket
   Play Store, pulihkan pembelian via AndroidBilling.
   `direct`: versi APK langsung dari penjual. Tombol beli dibuka lewat
   WhatsApp penjual; pembeli memasukkan kode aktivasi ECDSA yang diterbitkan
   penjual secara manual.

   Kode ini dimuat SEBELUM entitlement.js dan app.js. Nilai `direct` ditulis
   oleh tools/sync-web.js saat `GROCAIR_FLAVOR=direct`; tanpa env, nilai
   default adalah `play` sehingga APK build biasa tetap varian Play.
   ========================================================= */

(function (root) {
  'use strict';

  root.GC = root.GC || {};
  root.GC.pesanPembelian = function (toko, installId, paket) {
    var tahunan = paket === 'tahunan';
    var text = 'Halo Grocair, saya ingin membeli paket ' + (tahunan ? 'Tahunan Rp199.000 / 365 hari' : 'Bulanan Rp25.000 / 30 hari') +
      '\nToko: ' + toko + '\nKode instalasi: ' + installId + '\nMohon petunjuk pembayaran QRIS/transfer. Tidak diperpanjang otomatis.';
    return 'https://wa.me/6288294034375?text=' + encodeURIComponent(text);
  };

  root.GC_FLAVOR = root.GC_FLAVOR || {
    flavor: 'play',
    waNumber: '6288294034375',
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
