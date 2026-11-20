/* =========================================================
   Grocair — Sistem Lisensi & Trial

   Lisensi berbasis ECDSA P-256 (raw r‖s signature).
   Setiap perangkat punya installId unik. Trial 14 hari.
   File ini bebas dependensi eksternal; hanya memakai
   Web Crypto API yang ada di browser (secure context).

   Struktur payload (JSON, base64url):
   {
     toko: string,
     installId: string,
     trialStart: number,       // epoch ms mulai trial
     status: 'trial' | 'aktif' | 'kedaluwarsa',
     expires: number           // epoch ms batas waktu (opsional)
   }

   Kunci publik (SPKI base64) di-inject ke GC_PUBLIC_KEY_B64
   dari index.html sebelum file ini dimuat.

   Semua verifikasi pakai subtle.verify ECDSA P-256 dengan
   raw r‖s (IEEE P1363, 64 byte) — sesuai format Web Crypto.
   ========================================================= */

(function (root) {
  'use strict';

  var GC = root.GC = root.GC || {};
  var TRIAL_DAYS = 14;

  // -------------------------------------------------
  // Konfigurasi kunci publik (bisa di-override sebelum script dimuat untuk unit test)
  // -------------------------------------------------
  var DEFAULT_PUBLIC_KEY_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAENmSKv1u04lFYZOOv1lhii5BVvHm36nnqum/FwOtlmjmTLteevv4M5ccnHAacJK3lO2HK6vUu9WFEZ4SkvLpQIA==';
  var PUBLIC_KEY_B64 = root.GC_PUBLIC_KEY_B64 || DEFAULT_PUBLIC_KEY_B64;

  // -------------------------------------------------
  // Util: base64url <-> bytes (browser-compatible, tanpa Buffer)
  // -------------------------------------------------
  function b64urlToBytes(teks) {
    var s = String(teks).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function b64urlFromBytes(buf) {
    var raw = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
    return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function b64ToBytes(teks) {
    var s = String(teks);
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // -------------------------------------------------
  // Parsing kunci: base64url(JSON.stringify({payload, sig}))
  // Format yang dihasilkan tools/license-gen.js.
  // -------------------------------------------------
  function parseKey(keyText) {
    if (!keyText || typeof keyText !== 'string') return null;

    var decoded;
    try {
      decoded = JSON.parse(new TextDecoder().decode(b64urlToBytes(keyText)));
    } catch (_) {
      return null;
    }
    if (!decoded || typeof decoded !== 'object') return null;
    if (!decoded.payload || typeof decoded.payload !== 'object') return null;
    if (!decoded.sig || typeof decoded.sig !== 'string') return null;

    var sigBytes;
    try {
      sigBytes = b64urlToBytes(decoded.sig);
    } catch (_) {
      return null;
    }

    // signature harus 64 byte (r 32 + s 32)
    if (!(sigBytes instanceof Uint8Array) || sigBytes.length !== 64) return null;

    return {
      payloadSegment: b64urlFromBytes(new TextEncoder().encode(JSON.stringify(decoded.payload))),
      payload: decoded.payload,
      sig: sigBytes,
    };
  }

  // -------------------------------------------------
  // Verifikasi tanda tangan ECDSA P-256 raw r‖s (IEEE P1363).
  // Catatan: Web Crypto (Chrome & Node 22) memakai format raw 64-byte
  // untuk subtle.sign/subtle.verify ECDSA — BUKAN DER. Sudah diverifikasi
  // empiris di kedua runtime: verify(raw)=true, verify(DER)=false.
  // -------------------------------------------------
  async function verifySignature(payload, sigBytes, publicKeyB64) {
    var payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

    var key = await root.crypto.subtle.importKey(
      'spki',
      b64ToBytes(publicKeyB64),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );

    try {
      return await root.crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        key,
        sigBytes,
        payloadBytes
      );
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------
  // Core license object
  // -------------------------------------------------
  var license = {

    get PUBLIC_KEY_B64() { return PUBLIC_KEY_B64; },

    parse: function (keyText) {
      return parseKey(keyText);
    },

    verify: async function (keyText, installId, now) {
      if (!root.crypto || !root.crypto.subtle) {
        return { ok: false, reason: 'unsupported' };
      }

      var parsed = parseKey(keyText);
      if (!parsed) return { ok: false, reason: 'format' };

      if (parsed.payload.installId !== installId) {
        return { ok: false, reason: 'device' };
      }

      var exp = parsed.payload.expires || 0;
      if (exp > 0 && Number.isFinite(exp) && now > exp) {
        return { ok: false, reason: 'expired' };
      }

      var ok = await verifySignature(parsed.payload, parsed.sig, PUBLIC_KEY_B64);
      if (!ok) return { ok: false, reason: 'signature' };

      return { ok: true, reason: 'valid', payload: parsed.payload };
    },

    verifyActive: async function (keyText, installId, now) {
      if (typeof keyText !== 'string' || keyText.length > 8192 || !Number.isFinite(now)) return { ok: false, reason: 'format' };
      var res = await license.verify(keyText.trim(), installId, now);
      if (!res.ok) return res;
      var p = res.payload;
      if (typeof p.toko !== 'string' || !p.toko.trim() || p.toko.length > 200 ||
          typeof p.installId !== 'string' || !p.installId || p.status !== 'aktif' ||
          !Number.isSafeInteger(p.expires) || p.expires <= 0 || p.expires > 8640000000000000) return { ok: false, reason: 'format' };
      if (now >= p.expires) return { ok: false, reason: 'expired' };
      return res;
    },

    verifyWith: async function (keyText, installId, now, publicKeyB64) {
      var savedPublicKey = PUBLIC_KEY_B64;
      PUBLIC_KEY_B64 = publicKeyB64 || '';
      try {
        return await license.verify(keyText, installId, now);
      } finally {
        PUBLIC_KEY_B64 = savedPublicKey;
      }
    },

    evaluate: function (opts) {
      var verified = opts && opts.verified;
      var trialStart = opts && opts.trialStart || 0;
      var now = opts && opts.now || Date.now();

      if (verified === true) {
        return { state: 'aktif', sisaHari: 0 };
      }

      var elapse = now - trialStart;
      var sisa = TRIAL_DAYS * 24 * 60 * 60 * 1000 - elapse;
      if (sisa <= 0) {
        return { state: 'kedaluwarsa', sisaHari: 0 };
      }
      var hari = Math.ceil(sisa / (24 * 60 * 60 * 1000));
      return { state: 'trial', sisaHari: hari };
    },

    checkClock: function (now, lastSeenAt) {
      if (lastSeenAt == null || lastSeenAt === '') {
        return { ok: true, mundurMs: 0 };
      }
      var dif = now - lastSeenAt;
      if (dif > 0) {
        return { ok: true, mundurMs: 0 };
      }
      var mundur = Math.abs(dif);
      var batas = 6 * 60 * 60 * 1000;
      return { ok: mundur <= batas, mundurMs: mundur };
    },

    seen: async function (ts) {
      if (ts == null) ts = Date.now();
      var p = (root.GC && root.GC.app && typeof root.GC.app.pengaturanData === 'function')
        ? root.GC.app.pengaturanData()
        : null;
      p = p || {};
      try {
        await GC.store.put('meta', { key: 'pengaturan', value: Object.assign({}, p, { lastSeenAt: ts }) });
      } catch (_) { /* ringan aja */ }
    },

    TRIAL_DAYS: TRIAL_DAYS,
  };

  GC.license = license;

})(typeof globalThis !== 'undefined' ? globalThis : this);
