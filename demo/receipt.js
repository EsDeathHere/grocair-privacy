/* =========================================================
   Grocair — renderer struk 58 mm.
   Satu model, dua jalur: teks (Bagikan/WhatsApp) dan HTML (Cetak).

   Skrip klasik supaya bisa dipakai di browser dan di Node untuk
   unit test. Tidak ada dependensi, tidak ada jaringan.
   ========================================================= */
(function (root) {
  'use strict';

  var LEBAR = 32; // 58 mm pada mono 10-11 px ≈ 32–33 kolom
  var GC = root.GC = root.GC || {};

  function angka(n) {
    var v = Math.round(Number(n) || 0);
    var neg = v < 0;
    v = Math.abs(v);
    return (neg ? '-' : '') + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function bersih(v, max) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, max || 200);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pad2(n) {
    return String(Math.max(0, Math.round(Number(n) || 0))).padStart(2, '0');
  }

  function pecahKata(kata, n) {
    var out = [];
    var s = String(kata);
    while (s.length > n) {
      out.push(s.slice(0, n));
      s = s.slice(n);
    }
    if (s) out.push(s);
    return out;
  }

  /* Word-wrap ke maksimum n kolom. Kata yang lebih panjang dari n dipotong
     per n karakter supaya tidak ada baris yang melebihi lebar kertas. */
  function wrap(v, n) {
    var out = [];
    var paragraf = String(v == null ? '' : v).split('\n');
    paragraf.forEach(function (par) {
      var kata = par.split(/\s+/).filter(Boolean);
      var baris = '';
      if (!kata.length) { out.push(''); return; }
      kata.forEach(function (k) {
        var potongan = k.length > n ? pecahKata(k, n) : [k];
        potongan.forEach(function (bagian) {
          if (!baris) baris = bagian;
          else if (baris.length + 1 + bagian.length <= n) baris += ' ' + bagian;
          else { out.push(baris); baris = bagian; }
        });
      });
      if (baris) out.push(baris);
    });
    return out.length ? out : [''];
  }

  function spasi(n) {
    return n > 0 ? ' '.repeat(n) : '';
  }

  /* Kiri + kanan dalam satu baris. Null bila tidak muat, supaya pemanggil
     bisa memindahkan harga ke baris sendiri (harga tidak boleh terpotong). */
  function duaKolom(kiri, kanan, lebar) {
    var n = lebar || LEBAR;
    var sisa = n - String(kiri).length - String(kanan).length;
    return sisa >= 1 ? String(kiri) + spasi(sisa) + String(kanan) : null;
  }

  function tanggal(d) {
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear()
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function build(sale, toko) {
    var s = (sale && typeof sale === 'object') ? sale : {};
    var t = (toko && typeof toko === 'object') ? toko : {};
    var items = Array.isArray(s.items) ? s.items : [];
    var baris = [];

    function tambah(teksBaris, rata, kelas, kiri, kanan) {
      var teksAman = String(teksBaris == null ? '' : teksBaris).slice(0, LEBAR);
      baris.push({
        teks: teksAman,
        rata: rata || 'kiri',
        kelas: kelas || '',
        kiri: kiri == null ? teksAman : kiri,
        kanan: kanan == null ? null : kanan,
      });
    }

    function tambahWrap(v, rata, kelas) {
      wrap(bersih(v, 200), LEBAR).forEach(function (b) { tambah(b, rata, kelas); });
    }

    function pemisah() {
      tambah('-'.repeat(LEBAR), 'kiri', 'pemisah');
    }

    function uang(kiri, nilai, kelas, kanan) {
      var teksNilai = kanan == null ? angka(nilai) : String(kanan);
      var satu = duaKolom(kiri, teksNilai + (kanan == null ? '' : ''), LEBAR);
      if (satu) { tambah(satu, 'kiri', kelas, kiri, teksNilai); return; }
      tambah(kiri, 'kiri', kelas);
      tambah(spasi(LEBAR - teksNilai.length) + teksNilai, 'kanan', kelas, '', teksNilai);
    }

    // Nama toko disimpan apa adanya; huruf besar diurus CSS (text-transform)
    // supaya teks mentah tidak berubah dan escaping tetap bisa diuji.
    tambahWrap(bersih(t.nama || 'Grocair', 60), 'center', 'toko');
    if (t.alamat) tambahWrap(t.alamat, 'center');
    if (t.hp) tambahWrap(t.hp, 'center');
    pemisah();

    var at = s.at ? new Date(s.at) : new Date();
    if (!Number.isFinite(at.getTime())) at = new Date();
    tambahWrap(tanggal(at), 'center');
    if (s.id) tambahWrap('#' + bersih(String(s.id).slice(-8).toUpperCase(), 9), 'center');
    pemisah();

    var subtotal = 0;
    items.forEach(function (it) {
      var qty = Math.max(1, Math.round(Number(it.qty) || 1));
      var harga = Math.max(0, Math.round(Number(it.price) || 0)) * qty;
      subtotal += harga;
      var kiri = qty + 'x ' + bersih(it.name || 'Barang', 80);
      var teksHarga = angka(harga);
      var satu = duaKolom(kiri, teksHarga, LEBAR);
      if (satu) { tambah(satu, 'kiri', 'barang', kiri, teksHarga); return; }

      // Nama panjang: bungkus nama, harga tetap utuh di barisnya sendiri.
      wrap(kiri, LEBAR).forEach(function (b) { tambah(b, 'kiri', 'barang'); });
      tambah(spasi(LEBAR - teksHarga.length) + teksHarga, 'kanan', 'harga', '', teksHarga);
    });

    if (Number.isFinite(Number(s.subtotal)) && s.subtotal != null) {
      subtotal = Math.max(0, Math.round(Number(s.subtotal)));
    }
    var diskon = Math.max(0, Math.round(Number(s.diskon) || 0));
    var total = Math.max(0, Math.round(Number(s.total) || 0));
    var bayar = Math.max(0, Math.round(Number(s.bayar) || 0));
    var kembali = s.kembali != null
      ? Math.max(0, Math.round(Number(s.kembali) || 0))
      : Math.max(0, bayar - total);

    pemisah();
    uang('Subtotal', subtotal);
    if (diskon > 0) uang('Diskon', diskon, 'diskon', '-' + angka(diskon));
    var pembulatan = total - (subtotal - diskon);
    if (pembulatan !== 0) uang('Pembulatan', Math.abs(pembulatan), 'bulat', (pembulatan > 0 ? '+' : '-') + angka(Math.abs(pembulatan)));
    uang('TOTAL', total, 'total');
    uang('Bayar', bayar);
    uang('Kembali', kembali, 'kembali');
    pemisah();

    tambahWrap('Terima kasih', 'center', 'footer');
    tambahWrap('Selamat berjualan', 'center', 'footer');

    return {
      lebar: LEBAR,
      baris: baris,
      at: at.toISOString(),
      total: total,
      bayar: bayar,
      kembali: kembali,
      footer: 'Terima kasih · Selamat berjualan',
      toko: { nama: bersih(t.nama || 'Grocair', 60), alamat: bersih(t.alamat, 120), hp: bersih(t.hp, 40) },
    };
  }

  function toText(model) {
    var m = model || {};
    return (Array.isArray(m.baris) ? m.baris : []).map(function (b) {
      return String(b && b.teks != null ? b.teks : '').slice(0, LEBAR);
    }).join('\n');
  }

  function toHtml(model) {
    var m = model || {};
    var rows = Array.isArray(m.baris) ? m.baris : [];
    var isi = rows.map(function (b) {
      var kelas = b && b.kelas ? ' s-' + String(b.kelas).replace(/[^a-z0-9-]/gi, '') : '';
      // Baris dua kolom memakai flex supaya harga selalu menempel kanan.
      if (b && b.kanan != null) {
        return '<div class="s-row s-pair' + kelas + '"><span>' + esc(b.kiri)
          + '</span><span>' + esc(b.kanan) + '</span></div>';
      }
      var rata = b && b.rata === 'center' ? ' s-center' : (b && b.rata === 'kanan' ? ' s-kanan' : '');
      return '<div class="s-row' + rata + kelas + '"><span>' + esc(b && b.teks) + '</span></div>';
    }).join('');
    return '<div class="struk">' + isi + '</div>';
  }

  /* Tinggi halaman = tinggi node struk yang sudah dirender (58 mm) + padding
     cetak 4 mm. Minimal 40 mm supaya printer tidak membuang halaman kosong.
     Tanpa DOM (unit test), pakai perkiraan baris. */
  function pageHeightMm(model) {
    if (root.document && root.document.getElementById) {
      var el = root.document.getElementById('printArea');
      if (el && el.getBoundingClientRect) {
        var h = el.getBoundingClientRect().height;
        if (h > 0) return Math.max(40, Math.round((h / 96 * 25.4 + 4) * 10) / 10);
      }
    }
    var n = model && Array.isArray(model.baris) ? model.baris.length : 10;
    return Math.max(40, Math.round((n * 4.6 + 4) * 10) / 10);
  }

  GC.receipt = {
    LEBAR: LEBAR,
    build: build,
    toText: toText,
    toHtml: toHtml,
    pageHeightMm: pageHeightMm,
    angka: angka,
    esc: esc,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
