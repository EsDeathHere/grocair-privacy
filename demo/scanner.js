/* Kamera lokal; tidak mengunggah gambar. ZXing fallback berlisensi Apache-2.0. */
(function (global) {
  'use strict';
  const GC = global.GC = global.GC || {};
  const $ = id => document.getElementById(id);
  const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
  let active = null;
  let activeTrigger = null;
  function stopStream(stream) { if (stream) stream.getTracks().forEach(track => track.stop()); }
  function release(s) {
    clearTimeout(s.timer);
    stopStream(s.stream);
    s.stream = null;
    $('scannerVideo').srcObject = null;
  }
  function tutup() {
    const s = active;
    if (!s) return;
    active = null;
    release(s);
    if ($('scannerDialog').open) $('scannerDialog').close();
    const t = activeTrigger;
    activeTrigger = null;
    const modal = $('modalRoot');
    if (t && t.isConnected !== false && (!modal || modal.hidden)) t.focus();
  }
  async function buka({ onResult, onManual, trigger = document.activeElement }) {
    tutup();
    activeTrigger = trigger;
    const s = active = { onResult, onManual, trigger, stream: null, timer: null };
    const dialog = $('scannerDialog');
    dialog.showModal();
    $('scannerStatus').textContent = 'Izinkan kamera, lalu arahkan barcode ke tengah layar.';
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('camera');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (active !== s) { stopStream(stream); return; }
      s.stream = stream;
      const video = $('scannerVideo');
      video.srcObject = stream;
      await video.play().catch(() => {});
      if (active !== s) return;
      let detector = null;
      if (global.BarcodeDetector) {
        try {
          const supported = await global.BarcodeDetector.getSupportedFormats();
          if (formats.every(f => supported.includes(f))) detector = new global.BarcodeDetector({ formats });
        } catch (_) { /* WebView dapat mengekspos API tanpa dukungan retail. */ }
      }
      if (active !== s) return;
      const Z = global.ZXing;
      let reader, canvas, context;
      function fallback() {
        if (!Z) throw new Error('decoder');
        reader = new Z.MultiFormatReader();
        reader.setHints(new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]]]));
        canvas = document.createElement('canvas');
        context = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (!detector) fallback();
      async function tick() {
        if (active !== s) return;
        try {
          let code = '';
          if (detector) {
            try {
              const results = await detector.detect(video);
              code = results.find(r => formats.includes(r.format))?.rawValue || '';
            } catch (_) { detector = null; fallback(); }
          } else if (video.videoWidth) {
            canvas.width = Math.min(video.videoWidth, 1280);
            canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            // RGBLuminanceSource expects packed RGB or an 8-bit luminance array, not RGBA.
            const luminance = new Uint8ClampedArray(canvas.width * canvas.height);
            for (let i = 0; i < luminance.length; i++) luminance[i] = (pixels[i * 4] + 2 * pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 4;
            try {
              code = reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(luminance, canvas.width, canvas.height)))).getText();
            } catch (err) {
              if (!['NotFoundException', 'ChecksumException', 'FormatException'].includes(err.constructor.name) && !['NotFoundException', 'ChecksumException', 'FormatException'].includes(err.name)) throw err;
            }
          }
          if (active !== s) return;
          if (/^\d{8,13}$/.test(code)) {
            tutup();
            onResult(code);
            return;
          }
        } catch (_) {
          if (active === s) {
            release(s);
            $('scannerStatus').textContent = 'Pemindai tidak tersedia. Tutup lalu ketik angka barcode secara manual.';
          }
          return;
        }
        if (active === s) s.timer = setTimeout(tick, 180);
      }
      s.timer = setTimeout(tick, 0);
    } catch (_) {
      if (active !== s) return;
      release(s);
      $('scannerStatus').textContent = 'Kamera tidak tersedia atau izin ditolak. Tutup lalu ketik angka barcode secara manual.';
    }
  }
  $('scannerClose').addEventListener('click', tutup);
  $('scannerManual').addEventListener('click', () => { const fn = active && active.onManual; tutup(); if (fn) fn(); });
  $('scannerDialog').addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); tutup(); });
  $('scannerDialog').addEventListener('close', tutup);
  document.addEventListener('visibilitychange', () => { if (document.hidden) tutup(); });
  global.addEventListener('hashchange', tutup);
  global.addEventListener('pagehide', tutup);
  GC.scanner = { buka, tutup, get aktif() { return !!active; } };
})(window);
