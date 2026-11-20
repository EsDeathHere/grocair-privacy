/* Hanya masuk build portfolio. Sumber aplikasi/Android tidak memuat file ini. */
'use strict';
(async function () {
  const banner = document.createElement('aside');
  banner.className = 'backup-banner';
  banner.setAttribute('aria-label', 'Mode demo');
  banner.innerHTML = '<span><strong>Mode demo</strong> · Data contoh, tersimpan di browser ini. PIN pemilik: <strong>123456</strong>. Pembelian bukan transaksi sungguhan.</span><a class="btn btn-ghost" href="../">Tentang proyek</a><button class="btn btn-ghost" id="resetDemo" type="button">Reset demo</button>';
  banner.style.flexWrap = 'wrap';
  document.body.prepend(banner);
  async function seed() {
    const now = Date.now();
    const pin = await GC.auth.hashPin('123456');
    await GC.store.replaceAll({
      meta: {
        toko: { nama: 'Warung Demo Grocair', alamat: '', hp: '' },
        pengaturan: { dipakaiBersama: false, pinBelumDiset: false, trialStart: now, lastBackupAt: now },
        installId: 'portfolio-demo', portfolioDemo: true,
      },
      staf: [{ id: 'demo-pemilik', nama: 'Pemilik demo', peran: 'pemilik', pin, aktif: true }],
      products: [
        { id:'demo-1', name:'Indomie Goreng', cat:'Makanan', price:3500, cost:2900, stock:48, barcode:'8992388101010' },
        { id:'demo-2', name:'Beras Premium 1 kg', cat:'Sembako', price:15000, cost:12500, stock:20, barcode:'' },
        { id:'demo-3', name:'Kopi Kapal Api', cat:'Minuman', price:2500, cost:1900, stock:35, barcode:'8991002505050' },
        { id:'demo-4', name:'Minyak Goreng 1 L', cat:'Sembako', price:18000, cost:15500, stock:12, barcode:'' },
        { id:'demo-5', name:'Gula Pasir 1 kg', cat:'Sembako', price:17000, cost:15000, stock:8, barcode:'' },
        { id:'demo-6', name:'Air Mineral 600 ml', cat:'Minuman', price:4000, cost:2500, stock:24, barcode:'' },
      ],
      sales: [{ id:'demo-sale', at:new Date(now).toISOString(), items:[{id:'demo-1',name:'Indomie Goreng',price:3500,cost:2900,qty:2}] }],
      audit: [], stokGerak: [],
    });
  }
  try {
    if (GC.store.NAMA_DB !== 'grocair-portfolio-demo') throw new Error('Database demo tidak terisolasi');
    await GC.store.open();
    const data = await GC.store.loadAll();
    if (!data.meta.portfolioDemo) await seed();
    document.querySelector('#resetDemo').addEventListener('click', async (event) => {
      if (!confirm('Reset seluruh data demo? Data toko asli tidak diubah.')) return;
      event.currentTarget.disabled = true;
      try { await seed(); location.reload(); }
      catch (_) { event.currentTarget.disabled = false; alert('Reset gagal. Data demo belum dapat dimuat ulang.'); }
    });
    const script = document.createElement('script');
    script.src = 'app.js';
    script.onerror = () => { banner.querySelector('span').textContent = 'Aplikasi gagal dimuat. Muat ulang halaman untuk mencoba lagi.'; };
    document.body.append(script);
  } catch (_) {
    banner.querySelector('span').textContent = 'Demo gagal membuka penyimpanan browser. Izinkan penyimpanan situs lalu muat ulang.';
  }
})();
