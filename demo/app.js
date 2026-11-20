/* =========================================================
   WarungPOS — demo aplikasi kasir
   Vanilla JS + localStorage. Tidak ada server.

   Fitur khusus warung:
   - Harga manual: jual barang volatil tanpa bikin produk
   - Harga otomatis: harga jual dihitung dari modal + margin
   - Edit harga cepat langsung di tabel barang
   ========================================================= */
(() => {
  'use strict';

  const IDR = new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 0,
  });
  const fmt = (n) => IDR.format(Math.round(Number(n) || 0));
  const numID = (n) => new Intl.NumberFormat('id-ID').format(Math.round(Number(n) || 0));
  const parseRupiah = (v) => Number(String(v == null ? '' : v).replace(/[^\d]/g, '')) || 0;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const DAY_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

  const state = {
    view: 'kasir',
    cart: [], // { lineId, type: 'product'|'manual', productId, name, price, hargaNormal, cost, qty }
    kasir: { q: '', cat: 'Semua' },
    barang: { q: '' },
    laporan: { mode: 'hari', dari: '', sampai: '' },
    diskon: 0,      // nominal, bukan persen
    pembulatan: 0,  // 0 | 100 | 500
    cartId: null,   // id transaksi yang sedang dibuka (untuk token persetujuan)
  };

  const LIMITS = {
    name: 80, cat: 30, barcode: 40, recent: 8,
    price: 1000000000,        // Rp 1 miliar per barang — jauh di atas kebutuhan warung
    stock: 1000000,           // 1 juta unit
    qty: 1000,                // per baris transaksi
    saleTotal: 100000000000,  // Rp 100 miliar per transaksi
  };

  // db selalu berbentuk sama dengan hasil GC.store.loadAll().
  let db = kosong();
  let storageWarned = false;

  function kosong() {
    return { meta: {}, staf: [], products: [], sales: [], audit: [], stokGerak: [] };
  }

  const cleanText = (v, max) => GC.sanitize.text(v, max);

  function cleanNumber(v, max, { round = true } = {}) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(round ? Math.round(n) : n, max);
  }

  const uid = (prefix = 'x') => GC.sanitize.id('', prefix);

  /* ---------------------------------------------------------
     Penyimpanan — semua lewat GC.store (IndexedDB per record).
     Tidak ada lagi satu blob localStorage untuk data dagang.
     --------------------------------------------------------- */
  const recentManual = () => (Array.isArray(db.meta.manualRecent) ? db.meta.manualRecent : []);

  function beriTahuGagalSimpan() {
    if (storageWarned) return;
    storageWarned = true;
    toast('Penyimpanan browser penuh/diblokir — data terbaru tidak tersimpan', true);
  }

  async function reload() {
    db = await GC.store.loadAll();
    renderAll();
  }

  async function persistProduct(produk, extraPut) {
    const p = GC.sanitize.product(produk);
    if (!p) throw new Error('Barang tidak valid');
    const put = [{ store: 'products', record: p }].concat(extraPut || []);
    await GC.store.writeTx({ put });
    await reload();
    return p;
  }

  async function persistMeta(key, value) {
    await GC.store.put('meta', { key, value });
    db.meta[key] = value;
  }

  async function persistSale(sale, movements) {
    await GC.store.writeTx({
      put: [{ store: 'sales', record: sale }]
        .concat((movements || []).map((record) => ({ store: 'stokGerak', record }))),
    });
    await reload();
  }

  /* ---------------------------------------------------------
     Buku gerak stok — append-only.
     Stok tidak pernah "ditimpa" tanpa jejak: setiap perubahan menulis
     satu baris stokGerak di transaksi IndexedDB yang sama dengan
     perubahan produknya. Itu sebabnya kegagalan simpan tidak bisa
     meninggalkan angka stok yang tidak cocok dengan riwayatnya.
     --------------------------------------------------------- */
  const stokMenipis = (p) => p.stock > 0 && p.stock <= (p.stokMinimum > 0 ? p.stokMinimum : 5);

  /* Koreksi di luar ±10% stok wajib persetujuan pemilik lagi.
     Minimal 1 unit supaya koreksi kecil di stok kosong tidak merepotkan. */
  const perluPinKoreksi = (sebelum, delta) =>
    Math.abs(delta) > Math.max(1, Math.round(Math.abs(sebelum) * 0.1));

  function gerakStok(p, delta, sebelum, sesudah, alasan, sumber, sesi) {
    return GC.sanitize.stokGerak({
      produkId: p.id,
      stafId: sesi ? sesi.stafId : null,
      delta,
      sebelum,
      sesudah,
      alasan,
      sumber,
    });
  }

  function auditStok(aksi, detail, sesi) {
    return GC.sanitize.audit({
      aksi,
      stafId: sesi ? sesi.stafId : null,
      detail,
    });
  }

  async function simpanGerakStok(produkBaru, gerak, audit, hapusId) {
    const put = [];
    if (produkBaru) put.push({ store: 'products', record: produkBaru });
    if (gerak) put.push({ store: 'stokGerak', record: gerak });
    if (audit) put.push({ store: 'audit', record: audit });
    const del = hapusId ? [{ store: 'products', id: hapusId }] : [];
    try {
      await GC.store.writeTx({ put, del });
    } catch (_) {
      toast('Gagal menyimpan perubahan stok — coba lagi', true);
      return false;
    }
    await reload();
    return true;
  }

  async function stockIn(productId, qty, newCost) {
    const sesi = GC.auth.session();
    if (!sesi || GC.auth.can('stokMasuk') !== 'izin') {
      toast('Stok masuk khusus pemilik', true);
      return false;
    }
    const p = findProduct(productId);
    if (!p) { toast('Barang tidak ditemukan', true); return false; }

    const masuk = cleanNumber(qty, LIMITS.stock);
    if (!(masuk > 0)) { toast('Jumlah masuk harus lebih dari 0', true); return false; }
    const kosong = newCost === undefined || newCost === null || newCost === '';
    const cost = kosong ? p.cost : cleanNumber(newCost, LIMITS.price);

    const sebelum = p.stock;
    const sesudah = Math.min(sebelum + masuk, LIMITS.stock);
    const delta = sesudah - sebelum;
    if (delta <= 0) { toast('Stok sudah di batas maksimum', true); return false; }

    // Modal baru ikut menghitung ulang harga hanya bila pemilik memilih mode auto.
    const produkBaru = GC.sanitize.product(Object.assign({}, p, {
      stock: sesudah,
      cost,
      price: p.autoPrice ? autoPrice(cost, p.margin) : p.price,
    }));
    if (!produkBaru) { toast('Data barang tidak valid', true); return false; }

    const alasan = cost !== p.cost ? `Modal jadi ${fmt(cost)}` : '';
    const gerak = gerakStok(p, delta, sebelum, sesudah, alasan, 'masuk', sesi);
    const audit = auditStok('stokMasuk',
      `${p.name} +${delta} (${sebelum}→${sesudah}) · modal ${fmt(cost)}`, sesi);
    return simpanGerakStok(produkBaru, gerak, audit, null);
  }

  async function adjustStock(productId, delta, alasan, opsi = {}) {
    const sesi = GC.auth.session();
    if (!sesi || GC.auth.can('koreksi') !== 'izin') {
      toast('Koreksi stok khusus pemilik', true);
      return false;
    }
    const p = findProduct(productId);
    if (!p) { toast('Barang tidak ditemukan', true); return false; }

    const minta = Math.round(Number(delta) || 0);
    if (!minta) return false;
    const sesudah = Math.max(0, Math.min(p.stock + minta, LIMITS.stock));
    const nyata = sesudah - p.stock;
    if (!nyata) { toast('Stok sudah di batas', true); return false; }

    if (perluPinKoreksi(p.stock, nyata)
        && !GC.auth.consumeApproval(opsi.token, 'koreksi', p.id)) {
      toast('Koreksi sebesar ini butuh PIN pemilik', true);
      return false;
    }

    const produkBaru = GC.sanitize.product(Object.assign({}, p, { stock: sesudah }));
    if (!produkBaru) { toast('Data barang tidak valid', true); return false; }

    const catatan = cleanText(alasan, LIMITS.name) || 'Koreksi stok';
    const gerak = gerakStok(p, nyata, p.stock, sesudah, catatan, 'koreksi', sesi);
    const audit = auditStok('koreksiStok',
      `${p.name} ${nyata > 0 ? '+' : ''}${nyata} (${p.stock}→${sesudah}) · ${catatan}`, sesi);
    return simpanGerakStok(produkBaru, gerak, audit, null);
  }

  function movementsFor(productId) {
    return db.stokGerak
      .filter((g) => g.produkId === productId)
      .sort((a, b) => {
        const beda = new Date(b.at) - new Date(a.at);
        return beda !== 0 ? beda : String(b.id).localeCompare(String(a.id));
      });
  }

  async function deleteProduct(id) {
    const sesi = GC.auth.session();
    if (!sesi || GC.auth.can('hapusBarang') !== 'izin') {
      toast('Hapus barang khusus pemilik', true);
      return false;
    }
    const p = findProduct(id);
    if (!p) return false;

    const gerak = gerakStok(p, -p.stock, p.stock, 0, 'Barang dihapus', 'hapus', sesi);
    const audit = auditStok('hapusBarang', `${p.name} · sisa stok ${p.stock}`, sesi);
    if (!gerak) { toast('Data stok tidak valid', true); return false; }

    state.cart = state.cart.filter((l) => l.productId !== id);
    return simpanGerakStok(null, gerak, audit, id);
  }

  function renderAll() {
    renderChips();
    renderProducts();
    renderCart();
    renderTodayTotal();
    if (state.view === 'barang') renderBarang();
    if (state.view === 'laporan') renderReports();
    renderPengaturan();
    renderBackupReminder();
  }

  function seed() {
    const base = [
      ['Indomie Goreng', 'Makanan', 3500, 2900, 48, '8992388101010'],
      ['Indomie Soto', 'Makanan', 3500, 2900, 42, '8992388101027'],
      ['Mie Sedaap Soto', 'Makanan', 3400, 2800, 6, '8992388202020'],
      ['Roti Tawar Sari', 'Makanan', 18000, 15000, 12, '8991002103030'],
      ['Telur Ayam (per kg)', 'Sembako', 28000, 25000, 20, ''],
      ['Beras Premium (per kg)', 'Sembako', 15000, 12500, 60, ''],
      ['Gula Pasir (per kg)', 'Sembako', 17000, 14500, 25, ''],
      ['Minyak Goreng 1L', 'Sembako', 19000, 16500, 18, '8991002404040'],
      ['Kopi Kapal Api', 'Minuman', 2500, 1900, 80, '8991002505050'],
      ['Teh Gelas Botol', 'Minuman', 5000, 3800, 36, '8991002606060'],
      ['Aqua 600ml', 'Minuman', 4000, 3000, 48, '8991002707070'],
      ['Susu Ultra 250ml', 'Minuman', 6500, 5200, 24, '8991002808080'],
      ['Sampoerna Mild 12', 'Rokok', 28000, 25000, 15, '8991002909090'],
      ['Sabun Lifebuoy', 'Kebersihan', 4500, 3500, 30, '8991003001010'],
      ['Pepsodent Sachet', 'Kebersihan', 1500, 900, 0, '8991003102020'],
    ];
    const products = base.map(([name, cat, price, cost, stock, barcode]) => ({
      id: uid('p'), name, cat, price, cost, stock, barcode, autoPrice: false, margin: null,
    }));

    const sales = [];
    const now = new Date();
    for (let d = 6; d >= 0; d--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
      const txCount = d === 0 ? 4 : 3 + Math.floor(Math.random() * 4);
      for (let t = 0; t < txCount; t++) {
        const items = [];
        const nItems = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < nItems; k++) {
          const p = products[Math.floor(Math.random() * products.length)];
          if (items.some((it) => it.id === p.id)) continue;
          const qty = 1 + Math.floor(Math.random() * 3);
          items.push({ id: p.id, name: p.name, price: p.price, cost: p.cost, qty });
        }
        if (!items.length) continue;
        const total = items.reduce((s, it) => s + it.price * it.qty, 0);
        const profit = items.reduce((s, it) => s + (it.price - it.cost) * it.qty, 0);
        const at = new Date(day);
        at.setHours(8 + Math.floor(Math.random() * 11), Math.floor(Math.random() * 60));
        sales.push({ id: uid('t'), at: at.toISOString(), items, total, profit, paid: total });
      }
    }

    return {
      products,
      sales,
      manualRecent: [
        { name: 'Beras Premium (per kg)', price: 15000 },
        { name: 'Gula Pasir (per kg)', price: 17000 },
        { name: 'Telur Ayam (per kg)', price: 28000 },
      ],
    };
  }

  /* ---------------------------------------------------------
     Util
     --------------------------------------------------------- */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function dayKey(d) {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }

  const timeStr = (iso) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const dateStr = (iso) => new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });

  function toast(msg, bad = false) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  const findProduct = (id) => db.products.find((p) => p.id === id);
  const findLine = (lineId) => state.cart.find((l) => l.lineId === lineId);
  const cartSubtotal = () => state.cart.reduce((s, l) => s + l.price * l.qty, 0);
  const cartCount = () => state.cart.reduce((s, l) => s + l.qty, 0);

  const STEP_BULAT = [0, 100, 500];
  const diskonAktif = () => Math.min(Math.max(0, Math.round(Number(state.diskon) || 0)), cartSubtotal());

  /* total = clamp(subtotal − diskon, 0, subtotal), pembulatan SETELAH diskon.
     Urutan ini sama dengan GC.sanitize.sale supaya angka di layar dan di
     struk tersimpan tidak pernah berbeda. */
  function cartTotal() {
    const sub = cartSubtotal();
    const d = diskonAktif();
    const step = STEP_BULAT.indexOf(Number(state.pembulatan)) >= 0 ? Number(state.pembulatan) : 0;
    const dasar = sub - d;
    const bulat = step ? Math.round(dasar / step) * step : dasar;
    return Math.max(0, Math.min(bulat, sub));
  }

  function transaksiId() {
    if (!state.cartId) state.cartId = uid('c');
    return state.cartId;
  }

  function todaySales() {
    const key = dayKey(new Date());
    return db.sales.filter((s) => s.status !== 'void' && dayKey(s.at) === key);
  }

  function autoPrice(cost, margin) {
    const c = Number(cost) || 0;
    const m = Number(margin) || 0;
    const raw = c * (1 + m / 100);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.ceil(raw / 100) * 100;
  }

  /* ---------------------------------------------------------
     Router
     --------------------------------------------------------- */
  const VIEWS = ['kasir', 'barang', 'kalkulator', 'laporan', 'pengaturan'];

  function showView(name) {
    if (!VIEWS.includes(name)) name = 'kasir';
    state.view = name;
    $$('.view').forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
    $$('.nav-btn').forEach((b) => {
      if (b.dataset.go === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const navLabel = $('#navMenuLabel');
    if (navLabel) navLabel.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    const navMenu = $('#navMenu');
    if (navMenu && navMenu.open) {
      navMenu.open = false;
      navMenu.querySelector('summary').focus();
    }

    // Kunci fitur lanjutan pasca trial (spec mobile §4.2)
    if (name === 'laporan' && !GC.entitlement.can('laporan')) {
      tampilkanLangganan('laporan');
      return;
    }
    tutupLangganan();

    if (name === 'kasir') { renderProducts(); renderCart(); }
    if (name === 'barang') renderBarang();
    if (name === 'laporan') renderReports();
    if (name === 'pengaturan') renderPengaturan();
    if (name !== 'kasir') closeReceipt();
    renderBottomBar();
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------------------------------------------------------
     Kasir — katalog
     --------------------------------------------------------- */
  function renderChips() {
    const aktif = db.products.filter((p) => p.aktif !== false);
    const cats = ['Semua', ...Array.from(new Set(aktif.map((p) => p.cat)))];
    if (state.kasir.cat !== 'Semua' && cats.indexOf(state.kasir.cat) < 0) state.kasir.cat = 'Semua';
    $('#categoryChips').innerHTML = cats.map((c) =>
      `<button class="chip" data-cat="${esc(c)}" aria-pressed="${c === state.kasir.cat}">${esc(c)}</button>`
    ).join('');
  }

  function renderProducts() {
    const grid = $('#productGrid');
    const { q, cat } = state.kasir;
    const query = q.trim().toLowerCase();
    const list = db.products.filter((p) => {
      if (p.aktif === false) return false;
      const matchQ = !query || p.name.toLowerCase().includes(query) || (p.barcode || '').includes(query);
      const matchCat = cat === 'Semua' || p.cat === cat;
      return matchQ && matchCat;
    });

    if (!list.length) {
      grid.innerHTML = `<p class="empty-table">Tidak ada barang yang cocok.</p>`;
      return;
    }

    grid.innerHTML = list.map((p) => {
      const out = p.stock <= 0;
      const low = stokMenipis(p);
      return `<button class="product-card${out ? ' out' : ''}" data-add="${esc(p.id)}" ${out ? 'disabled' : ''}>
        <span class="p-add" aria-hidden="true">+</span>
        <span class="p-cat">${esc(p.cat)}</span>
        <span class="p-name">${esc(p.name)}</span>
        <span class="p-foot">
          <span class="p-price">${fmt(p.price)}</span>
          <span class="p-stock${low ? ' low' : ''}">${out ? 'habis' : 'stok ' + esc(p.stock)}</span>
        </span>
      </button>`;
    }).join('');
  }

  /* ---------------------------------------------------------
     Layar langganan (spec §5, Task 5)
     --------------------------------------------------------- */
  const isDirect = () => window.GC_FLAVOR && GC_FLAVOR.flavor === 'direct';

  function tampilkanLangganan(fitur) {
    const el = $('#layarLangganan');
    if (!el) return;
    const desc = $('#lockDesc');
    const judul = $('#lockJudul');
    const status = GC.entitlement.status();
    if (status === 'kadaluwarsa') {
      if (judul) judul.textContent = 'Masa uji coba selesai';
      if (desc) desc.textContent = 'Fitur laporan, multi-staf, dan pencadangan memerlukan langganan Google Play. Kasir dan pencatatan transaksi dasar tetap gratis selamanya.';
    } else {
      if (judul) judul.textContent = 'Fitur lanjutan';
      if (desc) desc.textContent = 'Coba gratis selama 30 hari pertama, atau mulai langganan Play Store sekarang.';
    }
    if (isDirect()) {
      judul.textContent = 'Paket fitur lanjutan';
      desc.textContent = 'Trial 30 hari. Setelah itu, gratis 30 produk dan 20 transaksi/hari. Laporan, Staf, dan Pulihkan backup membutuhkan paket aktif. Unduh backup tetap gratis.';
      $('#directWaActions').hidden = false;
      $('#btnPulihkanPaket').hidden = true;
      $('#directInstallId').value = db.meta.installId || '';
      $('#directPesan').value = new URL(GC.pesanPembelian(db.meta.toko?.nama || 'Warung', db.meta.installId, 'bulanan')).searchParams.get('text');
      const info = GC.entitlement.lisensiInfo();
      $('#directStatus').textContent = info.aktif ? `Aktif hingga ${new Date(info.expires).toLocaleString('id-ID')}` : '';
      $$('[data-paket] .paket-sku').forEach(el => { el.hidden = true; });
      $$('[data-paket] .paket-harga span').forEach((el, i) => { el.textContent = i ? '/365 hari' : '/30 hari'; });
    }
    el.hidden = false;
  }

  function tutupLangganan() {
    const el = $('#layarLangganan');
    if (el) el.hidden = true;
  }

  /* Simpan status entitlement (termasuk token pembelian) ke meta supaya
     akses bertahan setelah reload; verifikasi ulang saat app dibuka. */
  async function simpanAksesCache() {
    const c = GC.entitlementCache || {};
    const ent = {
      status: GC.entitlement.status(),
      trialStart: c.trialStart || null,
      purchaseToken: c.purchaseToken || null,
      productId: c.productId || null,
      purchaseTime: c.purchaseTime || null,
      verifiedAt: c.verifiedAt || null,
      lastSeenAt: Date.now(),
    };
    try {
      await GC.store.put('meta', { key: 'entitlement', value: ent });
      db.meta.entitlement = ent;
    } catch (_) { /* cache gagal ditulis: coba lagi saat boot berikutnya */ }
  }

  function bindLangganan() {
    $('#btnPaketDirect').hidden = !isDirect();
    $('#btnPaketDirect').addEventListener('click', () => tampilkanLangganan('aktivasi'));
    $('#btnCopyInstallId').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#directInstallId').value); $('#directStatus').textContent = 'Kode disalin'; }
      catch (_) { $('#directInstallId').select(); $('#directStatus').textContent = 'Salin kode yang dipilih secara manual'; }
    });
    $('#btnAktifkanKode').addEventListener('click', async () => {
      const status = $('#directStatus');
      if (!isDirect()) return;
      const sesi = GC.auth.session();
      if (!sesi || sesi.peran !== 'pemilik') { status.textContent = 'Masuk sebagai pemilik di Pengaturan untuk aktivasi.'; return; }
      const btn = $('#btnAktifkanKode');
      btn.disabled = true;
      try {
        const result = await GC.entitlement.aktivasiLisensi($('#inputKodeLisensi').value.trim(), db.meta.installId);
        if (!result.ok) { status.textContent = `Kode ditolak: ${result.error}`; return; }
        db.meta.lisensi = { kunci: $('#inputKodeLisensi').value.trim() };
        document.body.dataset.akses = document.body.dataset.lisensi = GC.entitlement.status();
        $('#inputKodeLisensi').value = '';
        tutupLangganan(); renderBannerTrial(); toast('Paket aktif. Terima kasih!');
        if (state.view === 'laporan') renderReports();
      } catch (_) { status.textContent = 'Aktivasi gagal disimpan. Coba lagi; akses belum diubah.'; }
      finally { btn.disabled = false; }
    });
    $$('[data-paket]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (isDirect()) {
          const url = GC.pesanPembelian(db.meta.toko?.nama || 'Warung', db.meta.installId, btn.dataset.paket);
          $('#directPesan').value = new URL(url).searchParams.get('text');
          window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
        const sku = btn.dataset.paket === 'tahunan' ? 'grocair_tahunan' : 'grocair_bulanan';
        btn.disabled = true;
        try {
          await GC.entitlement.beli(sku);
          await simpanAksesCache();
          document.body.dataset.akses = 'aktif';
          tutupLangganan();
          renderBannerTrial();
          toast('Langganan aktif — terima kasih!');
          if (state.view === 'laporan') renderReports();
        } catch (e) {
          toast('Pembelian dibatalkan atau gagal', true);
        } finally {
          btn.disabled = false;
        }
      });
    });

    const btnPulihkan = $('#btnPulihkanPaket');
    if (btnPulihkan) {
      btnPulihkan.addEventListener('click', async () => {
        btnPulihkan.disabled = true;
        try {
          const res = await GC.entitlement.pulihkan();
          if (res.restored) {
            await simpanAksesCache();
            document.body.dataset.akses = 'aktif';
            tutupLangganan();
            renderBannerTrial();
            toast('Pembelian dipulihkan!');
            if (state.view === 'laporan') renderReports();
          } else {
            toast('Tidak ada pembelian yang ditemukan di akun Google Play ini', true);
          }
        } catch (_) {
          toast('Gagal memulihkan pembelian', true);
        } finally {
          btnPulihkan.disabled = false;
        }
      });
    }

    const btnTutup = $('#btnTutupPaket');
    if (btnTutup) {
      btnTutup.addEventListener('click', () => {
        tutupLangganan();
        showView('kasir');
      });
    }

    const btnTrial = $('#btnTrialLihatPaket');
    if (btnTrial) btnTrial.addEventListener('click', () => tampilkanLangganan('trial'));
  }
  function aksesKadaluwarsa() {
    return GC.entitlement.status() === 'kadaluwarsa';
  }
  function produkAktif() {
    return db.products.filter((p) => p.aktif !== false).length;
  }
  function transaksiHariIni() {
    const hari = new Date().toDateString();
    return db.sales.filter((s) => s.status !== 'void' && new Date(s.at).toDateString() === hari).length;
  }
  function kuotaSekarang() {
    return GC.entitlement.quota(produkAktif(), transaksiHariIni());
  }

  /* ---------------------------------------------------------
     Kasir — struk / keranjang
     --------------------------------------------------------- */
  function renderCart() {
    const itemsEl = $('#receiptItems');
    const totalsEl = $('#receiptTotals');

    $('#receiptDate').textContent = new Date().toLocaleString('id-ID', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    if (!state.cart.length) {
      state.diskon = 0;
      state.pembulatan = 0;
      itemsEl.innerHTML = `<p class="receipt-empty">Belum ada barang.<br />Klik barang di sebelah kiri, atau pakai Harga manual.</p>`;
      totalsEl.hidden = true;
      $('#btnPay').disabled = true;
      $('#btnClear').disabled = true;
      renderBottomBar();
      return;
    }

    itemsEl.innerHTML = state.cart.map((l) => `
      <div class="receipt-line">
        <div class="rl-top">
          <span class="rl-name">${esc(l.name)}${l.type === 'manual' ? '<span class="rl-tag">bebas</span>' : ''}</span>
          <span class="rl-price">${fmt(l.price * l.qty)}</span>
        </div>
        <div class="rl-bottom">
          <span class="qty">
            <button type="button" data-dec="${esc(l.lineId)}" aria-label="Kurangi ${esc(l.name)}">−</button>
            <span>${esc(l.qty)}</span>
            <button type="button" data-inc="${esc(l.lineId)}" aria-label="Tambah ${esc(l.name)}">+</button>
          </span>
          <button type="button" class="rl-del" data-del="${esc(l.lineId)}">hapus</button>
        </div>
      </div>`).join('');

    const sub = cartSubtotal();
    const diskon = diskonAktif();
    const total = cartTotal();

    totalsEl.hidden = false;
    $('#rtCount').textContent = cartCount();
    $('#rtSubtotal').textContent = fmt(sub);
    $('#rowDiskon').hidden = diskon <= 0;
    $('#rtDiskon').textContent = `−${fmt(diskon)}`;
    $('#rowBulat').hidden = !(state.pembulatan && total !== sub - diskon);
    $('#rtBulat').textContent = fmt(total - (sub - diskon));
    $('#rtTotal').textContent = fmt(total);
    $('#btnPay').disabled = !kuotaSekarang().bolehTransaksi;
    $('#btnClear').disabled = false;
    renderBottomBar();
  }

  /* Bar bawah: jumlah + total + Bayar. Hanya di Kasir, disembunyikan saat kosong. */
  function renderBottomBar() {
    const bar = $('#cartBar');
    if (!bar) return;
    const n = cartCount();
    const tampil = n > 0 && state.view === 'kasir' && $('#onboarding').hidden && $('#lock').hidden;
    bar.hidden = !tampil;
    $('#cartBarCount').textContent = `${n} barang`;
    $('#cartBarTotal').textContent = fmt(cartTotal());
    const pay = $('#cartBarPay');
    if (pay) pay.disabled = !kuotaSekarang().bolehTransaksi;
    if (tampil) document.body.classList.add('ada-cart-bar');
    else document.body.classList.remove('ada-cart-bar');
  }

  function pulseCartBar() {
    const bar = $('#cartBar');
    if (!bar || bar.hidden) return;
    bar.classList.remove('denyut');
    void bar.offsetWidth; // paksa reflow supaya animasi bisa diputar ulang
    bar.classList.add('denyut');
    setTimeout(() => bar.classList.remove('denyut'), 400);
  }

  function openReceipt() {
    // Di desktop struk sudah terlihat sebagai kolom: cukup sorot, jangan
    // biarkan panel geser (yang hanya ada di layar kecil) menutupi layar.
    if (!window.matchMedia('(max-width: 900px)').matches) {
      $('#receiptPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    $('#receiptPanel').classList.add('buka');
    document.body.classList.add('struk-terbuka');
    const tutup = $('#receiptClose');
    if (tutup) tutup.focus({ preventScroll: true });
  }

  function closeReceipt() {
    $('#receiptPanel').classList.remove('buka');
    document.body.classList.remove('struk-terbuka');
  }

  function addToCart(productId, qty = 1) {
    const p = findProduct(productId);
    if (!p) return false;
    const count = Number(qty);
    if (!Number.isInteger(count) || count < 1 || count > LIMITS.qty) { toast('Jumlah barang tidak valid', true); return false; }
    const line = state.cart.find((l) => l.type === 'product' && l.productId === productId);
    const current = line ? line.qty : 0;
    const remaining = p.stock - current;
    if (remaining <= 0) { toast(`Stok ${p.name} tinggal ${p.stock}`, true); return false; }
    if (count > remaining) { toast(`Stok ${p.name} tersisa ${remaining}`, true); return false; }
    if (line) line.qty += count;
    else state.cart.push({
      lineId: uid('L'), type: 'product', productId,
      name: p.name, price: p.price, hargaNormal: p.price, cost: p.cost, qty: count,
    });
    renderCart();
    pulseCartBar();
    return true;
  }

  function cariBarcode(kode) {
    const clean = cleanText(kode, LIMITS.barcode);
    if (!clean) return [];
    const forms = new Set([clean]);
    if (/^\d{12}$/.test(clean)) forms.add('0' + clean);
    if (/^0\d{12}$/.test(clean)) forms.add(clean.slice(1));
    return db.products.filter((p) => p.aktif !== false && p.barcode && forms.has(p.barcode));
  }

  function openScanQtyModal(p) {
    const line = state.cart.find((l) => l.type === 'product' && l.productId === p.id);
    const remaining = Math.max(0, p.stock - (line ? line.qty : 0));
    openModal(`
      <div class="modal-head">
        <h2>${esc(p.name)}</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">&times;</button>
      </div>
      <form class="form-grid" id="scanQtyForm" novalidate>
        <p>${esc(p.barcode)} · ${fmt(p.price)} · stok tersedia ${remaining}</p>
        <div class="field">
          <label for="scanQtyInput">Jumlah dibeli</label>
          <div class="tools-row">
            <button class="btn btn-ghost" type="button" id="btnScanQtyMinus" aria-label="Kurangi jumlah">−</button>
            <input type="number" id="scanQtyInput" min="1" max="${Math.max(1, remaining)}" step="1" inputmode="numeric" value="1" required />
            <button class="btn btn-ghost" type="button" id="btnScanQtyPlus" aria-label="Tambah jumlah">+</button>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-close>Batal</button>
          <button class="btn btn-primary" type="submit">Tambah ke keranjang</button>
        </div>
      </form>
    `);
    const input = $('#scanQtyInput');
    const step = (delta) => {
      const next = (parseInt(input.value, 10) || 1) + delta;
      input.value = String(Math.max(1, Math.min(Math.max(1, remaining), next)));
    };
    $('#btnScanQtyMinus').addEventListener('click', () => step(-1));
    $('#btnScanQtyPlus').addEventListener('click', () => step(1));
    $('#scanQtyForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const count = Number(input.value);
      if (addToCart(p.id, count)) {
        closeModal();
        toast(`${p.name} ×${count} ditambahkan`);
      }
    });
    input.focus();
    input.select();
  }

  function prosesBarcodeKasir(kode, langsung = false) {
    const clean = cleanText(kode, LIMITS.barcode);
    if (!clean) return false;
    const cocok = cariBarcode(clean);
    if (cocok.length === 1) {
      if (langsung) {
        if (addToCart(cocok[0].id, 1)) toast(`${cocok[0].name} ditambahkan`);
        return true;
      }
      openScanQtyModal(cocok[0]);
      return true;
    }
    if (cocok.length > 1) {
      openModal(`
        <div class="modal-head">
          <h2>Barcode ganda</h2>
          <button class="modal-close" type="button" data-close aria-label="Tutup">&times;</button>
        </div>
        <p>Barcode <strong>${esc(clean)}</strong> dipakai lebih dari satu barang: ${cocok.map((p) => esc(p.name)).join(', ')}. Perbaiki di menu Barang.</p>
        <div class="modal-actions"><button class="btn btn-ghost" type="button" data-close>Tutup</button></div>
      `);
      return false;
    }
    const bolehUbah = GC.auth.can('ubahBarang') === 'izin';
    openModal(`
      <div class="modal-head">
        <h2>Barcode belum terdaftar</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">&times;</button>
      </div>
      <p>Kode <strong>${esc(clean)}</strong> belum terdaftar pada barang aktif.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" data-close>Tutup</button>
        ${bolehUbah ? '<button class="btn btn-primary" type="button" id="btnDaftarBarcode">Daftarkan barang</button>' : ''}
      </div>
    `);
    if (bolehUbah) $('#btnDaftarBarcode').addEventListener('click', () => openProductModal(null, clean));
    return false;
  }

  /* hargaNormal = pembanding untuk aturan peran. Baris bebas tanpa produk
     memakai harga terakhir dengan nama yang sama; kalau tidak ada, 0. */
  function addManual(name, price, hargaNormal, produkId = null) {
    const clean = cleanText(name, LIMITS.name);
    const amount = cleanNumber(price, LIMITS.price);
    const normal = cleanNumber(hargaNormal, LIMITS.price);
    if (!clean || !amount) return;
    // Barang yang dipilih dari daftar tetap tertaut ke produknya: stoknya ikut
    // bergerak walau harganya diisi manual.
    const produk = produkId ? findProduct(produkId) : null;
    const existing = state.cart.find((l) =>
      l.type === 'manual' && l.name.toLowerCase() === clean.toLowerCase() && l.price === amount);
    if (existing) existing.qty = Math.min(existing.qty + 1, LIMITS.qty);
    else state.cart.push({
      lineId: uid('L'), type: 'manual', productId: produk ? produk.id : null,
      name: clean, price: amount, hargaNormal: normal,
      cost: produk ? produk.cost : 0, qty: 1,
    });

    const baru = [{ name: clean, price: amount }]
      .concat(recentManual().filter((r) => r.name.toLowerCase() !== clean.toLowerCase()))
      .slice(0, LIMITS.recent);
    persistMeta('manualRecent', baru).catch(beriTahuGagalSimpan);
    renderCart();
    pulseCartBar();
  }

  function changeQty(lineId, delta) {
    const line = findLine(lineId);
    if (!line) return;
    const next = line.qty + delta;
    if (next <= 0) {
      state.cart = state.cart.filter((l) => l.lineId !== lineId);
      renderCart();
      return;
    }
    if (line.type === 'product') {
      const p = findProduct(line.productId);
      if (p && next > p.stock) { toast(`Stok ${p.name} tinggal ${p.stock}`, true); return; }
    }
    line.qty = Math.min(next, LIMITS.qty);
    renderCart();
  }

  function removeLine(lineId) {
    state.cart = state.cart.filter((l) => l.lineId !== lineId);
    renderCart();
  }

  function resetTransaksi() {
    state.cart = [];
    state.diskon = 0;
    state.pembulatan = 0;
    state.cartId = null;
  }

  function clearCart() {
    resetTransaksi();
    renderCart();
  }

  /* ---------------------------------------------------------
     Persetujuan pemilik (satu aksi, satu token)
     --------------------------------------------------------- */
  function mintaPin({ aksi, refId, nominal, onSetuju }) {
    const pemilik = pemilikAktif();
    if (!pemilik) {
      toast('Buat PIN pemilik dulu di Pengaturan', true);
      closeModal();
      openBuatPin();
      return;
    }
    openModal(`
      <div class="modal-head">
        <h2>Butuh PIN pemilik</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
      </div>
      <div id="pinPrompt">
        <p class="modal-hint">Aksi ini di luar batas kasir. PIN hanya menyetujui aksi ini — sesi tetap kasir.</p>
        <form id="pinForm" class="form-grid" autocomplete="off">
          <label class="field">
            <span>PIN pemilik</span>
            <input type="password" id="pinOwner" inputmode="numeric" maxlength="6" autocomplete="off" />
          </label>
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" data-close>Batal</button>
            <button class="btn btn-primary" type="submit">Setujui</button>
          </div>
        </form>
      </div>
    `);

    $('#pinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = pengaturanData() || {};
      const l = GC.auth.lockout(p);
      if (l.terkunci) { toast(`Tunggu ${l.sisaDetik} detik`, true); return; }

      const pin = $('#pinOwner').value;
      if (!(await GC.auth.verifyPin(pin, pemilik.pin))) {
        const h = GC.auth.fail(p);
        await simpanPengaturan(h.pengaturan).catch(() => {});
        toast(h.terkunci ? `Terlalu banyak percobaan. Tunggu ${h.sisaDetik} detik.` : 'PIN salah', true);
        return;
      }

      await simpanPengaturan(GC.auth.resetLockout(p).pengaturan).catch(() => {});
      const token = GC.auth.issueApproval({ aksi, refId, nominal }).token;
      const berhasil = (await onSetuju(token)) === true;
      if (!berhasil) { toast('Aksi dibatalkan', true); return; }

      const sesi = GC.auth.session();
      const catatan = GC.sanitize.audit({
        aksi: 'persetujuan',
        stafId: sesi ? sesi.stafId : null,
        detail: `${aksi} oleh ${sesi ? sesi.stafId : '?'} disetujui ${pemilik.nama}`,
      });
      if (catatan) {
        GC.store.put('audit', catatan).then(() => { db.audit.push(catatan); }).catch(() => {});
      }
      closeModal();
    });
  }

  /* ---------------------------------------------------------
     Harga manual
     --------------------------------------------------------- */
  let manualContext = null; // { productId, name, hargaNormal }

  function renderManualHasil(query) {
    const box = $('#manualHasil');
    if (!box) return;
    const q = String(query || '').trim().toLowerCase();
    if (!q) { box.innerHTML = ''; return; }
    const list = db.products
      .filter((p) => p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q))
      .slice(0, 6);
    box.innerHTML = list.length
      ? list.map((p) => `<button type="button" class="manual-hasil-btn" data-pilih="${esc(p.id)}">
          <span>${esc(p.name)}</span><span class="mh-price">${fmt(p.price)}</span>
        </button>`).join('')
      : `<p class="modal-hint">Barang tidak ditemukan. Kasir hanya bisa harga manual untuk barang yang ada di daftar.</p>`;
  }

  function pilihManual(productId) {
    const p = findProduct(productId);
    if (!p) return;
    manualContext = { productId: p.id, name: p.name, hargaNormal: p.price };
    $('#manualHasil').innerHTML = `<p class="manual-dipilih">${esc(p.name)} · harga normal <strong>${fmt(p.price)}</strong></p>`;
    $('#manualHarga').value = p.price;
    $('#manualHarga').focus();
  }

  function openManualModal(prefillName = '') {
    manualContext = null;
    const sesi = GC.auth.session();
    const bolehBebas = !!sesi && sesi.peran === 'pemilik';

    openModal(`
      <div class="modal-head">
        <h2>Harga manual</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
      </div>
      <p class="modal-hint">Untuk barang yang harganya sering berubah. Cari barangnya dulu supaya ada harga pembanding.</p>
      <form id="manualForm" class="form-grid" autocomplete="off">
        <label class="field">
          <span>Cari barang</span>
          <input type="search" id="manualCari" placeholder="Ketik nama atau scan barcode…" autocomplete="off" value="${esc(prefillName)}" />
        </label>
        <div class="manual-hasil" id="manualHasil"></div>
        <label class="field">
          <span>Nama barang bebas</span>
          <input type="text" id="manualNama" maxlength="80" placeholder="${bolehBebas ? 'Contoh: Beras 2 kg' : 'Khusus pemilik'}" ${bolehBebas ? '' : 'disabled'} />
        </label>
        <label class="field">
          <span>Harga</span>
          <input type="number" id="manualHarga" min="1" max="1000000000" step="any" placeholder="0" inputmode="numeric" />
        </label>
        <p class="modal-hint" id="manualAturan">Kasir: harga boleh −10% sampai +20% dari harga normal. Di luar itu minta PIN pemilik.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-close>Batal</button>
          <button class="btn btn-primary" type="submit">Tambahkan</button>
        </div>
      </form>
    `);

    const cariEl = $('#manualCari');
    const namaEl = $('#manualNama');
    const hargaEl = $('#manualHarga');
    renderManualHasil(prefillName);

    cariEl.addEventListener('input', () => renderManualHasil(cariEl.value));
    cariEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = $('#manualHasil [data-pilih]');
      if (first) pilihManual(first.dataset.pilih);
    });
    $('#manualHasil').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pilih]');
      if (btn) pilihManual(btn.dataset.pilih);
    });

    $('#manualForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const harga = cleanNumber(hargaEl.value, LIMITS.price);
      const nama = manualContext ? manualContext.name : cleanText(namaEl.value, LIMITS.name);
      if (!nama) { toast('Cari dan pilih barang dulu', true); return; }
      if (harga <= 0) { toast('Harga harus lebih dari 0', true); return; }

      const recen = recentManual().find((r) => r.name.toLowerCase() === nama.toLowerCase());
      const hargaNormal = manualContext ? manualContext.hargaNormal : (recen ? recen.price : 0);
      const produkId = manualContext ? manualContext.productId : null;

      const izin = GC.auth.can('hargaManual', { hargaNormal, harga });
      if (izin === 'tolak') { toast('Tidak diizinkan untuk sesi ini', true); return; }

      const terapkan = () => {
        addManual(nama, harga, hargaNormal, produkId);
        closeModal();
        toast(`${nama} ditambahkan`);
        return true;
      };

      if (izin === 'izin') { terapkan(); return; }

      mintaPin({
        aksi: 'hargaManual',
        refId: transaksiId(),
        nominal: harga,
        onSetuju: (token) => {
          if (!GC.auth.consumeApproval(token, 'hargaManual', transaksiId())) return false;
          return terapkan();
        },
      });
    });

    cariEl.focus();
  }

  /* ---------------------------------------------------------
     Diskon & pembulatan
     --------------------------------------------------------- */
  function openDiskonModal() {
    if (!state.cart.length) return;
    const sub = cartSubtotal();
    openModal(`
      <div class="modal-head">
        <h2>Diskon</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
      </div>
      <form id="diskonForm" class="form-grid" autocomplete="off">
        <label class="field">
          <span>Diskon</span>
          <input type="number" id="diskonNominal" min="0" max="${sub}" step="any" inputmode="numeric" placeholder="0" value="${state.diskon || ''}" />
        </label>
        <div class="chips">
          ${[1000, 2000, 5000].filter((n) => n < sub).map((n) => `<button class="chip" type="button" data-diskon-cepat="${n}">${fmt(n)}</button>`).join('')}
        </div>
        <fieldset class="field">
          <legend>Pembulatan total</legend>
          <div class="chips" id="bulatChips">
            ${STEP_BULAT.map((s) => `<button class="chip" type="button" data-bulat="${s}" aria-pressed="${Number(state.pembulatan) === s}">${s === 0 ? 'Tanpa' : 'Ke ' + s}</button>`).join('')}
          </div>
        </fieldset>
        <p class="modal-hint">Kasir maksimal Rp 1.000 per transaksi. Lebih dari itu minta PIN pemilik.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-close>Batal</button>
          <button class="btn btn-primary" type="submit">Terapkan</button>
        </div>
      </form>
    `);

    const input = $('#diskonNominal');
    $$('[data-diskon-cepat]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.diskonCepat; }));

    $('#bulatChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-bulat]');
      if (!chip) return;
      state.pembulatan = Number(chip.dataset.bulat) || 0;
      $$('#bulatChips .chip').forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.bulat) === Number(state.pembulatan))));
    });

    $('#diskonForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const nominal = Math.min(cleanNumber(input.value, LIMITS.saleTotal), sub);
      const izin = GC.auth.can('diskon', { nominal });
      if (izin === 'tolak') { toast('Tidak diizinkan untuk sesi ini', true); return; }

      const terapkan = () => {
        state.diskon = nominal;
        renderCart();
        closeModal();
        toast(nominal > 0 ? `Diskon ${fmt(nominal)} diterapkan` : 'Diskon dihapus');
        return true;
      };

      if (izin === 'izin') { terapkan(); return; }

      mintaPin({
        aksi: 'diskon',
        refId: transaksiId(),
        nominal,
        onSetuju: (token) => {
          if (!GC.auth.consumeApproval(token, 'diskon', transaksiId())) return false;
          return terapkan();
        },
      });
    });

    input.focus();
  }

  function applyDiscount(nominal) {
    if (!state.cart.length) return false;
    const n = Math.min(cleanNumber(nominal, LIMITS.saleTotal), cartSubtotal());
    const izin = GC.auth.can('diskon', { nominal: n });
    if (izin === 'tolak') { toast('Tidak diizinkan untuk sesi ini', true); return false; }
    if (izin === 'izin') { state.diskon = n; renderCart(); return true; }
    mintaPin({
      aksi: 'diskon',
      refId: transaksiId(),
      nominal: n,
      onSetuju: (token) => {
        if (!GC.auth.consumeApproval(token, 'diskon', transaksiId())) return false;
        state.diskon = n;
        renderCart();
        return true;
      },
    });
    return false;
  }

  /* ---------------------------------------------------------
     Pembayaran — bottom sheet, tanpa autofocus
     --------------------------------------------------------- */
  function openPaySheet() {
    const kuota = kuotaSekarang();
    if (!kuota.bolehTransaksi) {
      toast(`Maksimal ${kuota.transaksiMaxPerHari} transaksi/hari di tier gratis — pasang langganan`, true);
      return;
    }
    const total = cartTotal();
    if (total <= 0) return;
    const sub = cartSubtotal();
    const diskon = diskonAktif();

    openModal(`
      <div class="sheet" role="document">
        <div class="modal-head">
          <h2>Bayar</h2>
          <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
        </div>
        <form id="payForm" autocomplete="off">
          <div class="pay-total">
            <span>TOTAL</span>
            <strong id="payTotal">${fmt(total)}</strong>
          </div>
          ${diskon > 0 ? `<p class="pay-sub">Subtotal ${fmt(sub)} · diskon ${fmt(diskon)}</p>` : ''}
          <label class="field pay-field">
            <span>Uang diterima (Rp)</span>
            <input id="payAmount" type="number" min="0" step="any" value="${total}" inputmode="numeric" />
          </label>
          <div class="chips pay-quick">
            <button class="chip" type="button" data-quick="${total}">Uang pas</button>
            <button class="chip" type="button" data-quick="20000">20.000</button>
            <button class="chip" type="button" data-quick="50000">50.000</button>
            <button class="chip" type="button" data-quick="100000">100.000</button>
          </div>
          <div class="receipt-row receipt-grand pay-change">
            <span>KEMBALIAN</span><span id="changeDue">${fmt(0)}</span>
          </div>
          <div class="modal-actions pay-actions">
            <button class="btn btn-ghost" type="button" data-close>Batal</button>
            <button class="btn btn-pay" type="submit" id="payConfirm">Bayar</button>
          </div>
        </form>
      </div>
    `, true);
    $('#modalRoot').classList.add('sheet-open');

    const input = $('#payAmount');
    const changeEl = $('#changeDue');
    const updateChange = () => {
      const got = Number(input.value) || 0;
      changeEl.textContent = fmt(Math.max(0, got - total));
      changeEl.style.color = got < total ? 'var(--red)' : 'var(--ink)';
    };
    input.addEventListener('input', updateChange);
    updateChange();

    $$('[data-quick]').forEach((b) => b.addEventListener('click', () => {
      input.value = b.dataset.quick;
      updateChange();
    }));

    // Tombol ✓ di keyboard = submit form. Tidak ada autofocus, jadi keyboard
    // tidak langsung menutupi tombol Bayar.
    $('#payForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const got = Number(input.value) || 0;
      if (got < total) { toast('Uang diterima kurang dari total', true); input.focus(); return; }
      finishSale(got);
    });
  }

  async function finishSale(paid) {
    const sesi = GC.auth.session();
    if (!sesi) { toast('Sesi tidak aktif — muat ulang halaman', true); return; }
    const kuota = kuotaSekarang();
    if (!kuota.bolehTransaksi) {
      toast(`Maksimal ${kuota.transaksiMaxPerHari} transaksi/hari di tier gratis — pasang langganan`, true);
      return;
    }
    if (GC.auth.can('jual', {}) !== 'izin') { toast('Tidak diizinkan untuk sesi ini', true); return; }

    const items = state.cart.map((l) => ({
      id: l.productId || null, name: l.name, price: l.price, cost: l.cost, qty: l.qty,
    }));
    const manual = state.cart
      .filter((l) => l.type === 'manual')
      .map((l) => ({
        nama: l.name,
        harga: l.price,
        hargaNormal: l.hargaNormal || 0,
        produkId: l.productId || null,
        selisih: (l.hargaNormal || 0) > 0 ? l.price - l.hargaNormal : 0,
      }));

    const sale = GC.sanitize.sale({
      id: uid('t'), at: new Date().toISOString(), items,
      kasirId: sesi.stafId,
      diskon: diskonAktif(),
      pembulatan: state.pembulatan,
      bayar: paid,
      manual,
    });
    if (!sale || !sale.items.length) { toast('Transaksi tidak valid', true); return; }

    // Gerak stok, penjualan, dan stok produk ditulis dalam SATU transaksi.
    // Kalau salah satu gagal, tidak ada yang tersimpan sebagian.
    const gerak = [];
    const produkBaru = [];
    const perProduk = new Map();
    state.cart.forEach((l) => {
      if (!l.productId) return;
      perProduk.set(l.productId, (perProduk.get(l.productId) || 0) + l.qty);
    });
    perProduk.forEach((qty, produkId) => {
      const p = findProduct(produkId);
      if (!p) return;
      const sesudah = Math.max(0, p.stock - qty);
      gerak.push({ produkId, delta: sesudah - p.stock, sebelum: p.stock, sesudah,
                   alasan: 'Penjualan', sumber: 'jual', stafId: sesi.stafId });
      produkBaru.push({ ...p, stock: sesudah });
    });

    const put = [{ store: 'sales', record: sale }]
      .concat(gerak.map((record) => ({ store: 'stokGerak', record })))
      .concat(produkBaru.map((record) => ({ store: 'products', record })));

    try {
      await GC.store.writeTx({ put });
    } catch (_) {
      toast('Gagal menyimpan transaksi — coba lagi', true);
      return;
    }

    resetTransaksi();
    await reload();
    closeReceipt();
    closeModal();
    showPrintedReceipt(sale, sale.kembali, true);
    toast('Pembayaran berhasil');
  }

  /* Void menyimpan status, bukan menghapus: jejak transaksi tetap ada dan
     dikecualikan dari semua agregat omzet/laba lewat todaySales(). */
  async function voidSale(id) {
    const sesi = GC.auth.session();
    if (!sesi) { toast('Sesi tidak aktif — muat ulang halaman', true); return; }

    const asli = db.sales.find((s) => s.id === id);
    if (!asli) { toast('Transaksi tidak ditemukan', true); return; }
    if (asli.status === 'void') return;

    const sale = GC.sanitize.sale(Object.assign({}, asli, { status: 'void' }));
    if (!sale) { toast('Transaksi tidak valid', true); return; }

    const catatan = GC.sanitize.audit({
      aksi: 'void',
      stafId: sesi.stafId,
      detail: `${sale.id} · ${fmt(sale.total)} · ${sale.items.length} baris · oleh ${sesi.peran}`,
    });
    const put = [{ store: 'sales', record: sale }];
    if (catatan) put.push({ store: 'audit', record: catatan });

    try {
      await GC.store.writeTx({ put });
    } catch (_) {
      toast('Gagal membatalkan transaksi — coba lagi', true);
      return;
    }
    await reload();
    toast('Transaksi dibatalkan, tidak masuk omzet');
  }

  /* ---------------------------------------------------------
     Cetak & bagikan struk — satu renderer, dua jalur.
     Cetak memakai #printArea (di luar .app) supaya tidak terpotong
     seperti modal position:fixed. Bagikan memakai teks 32 kolom yang
     sama, jadi WhatsApp dan kertas tidak pernah berbeda isi.
     --------------------------------------------------------- */
  async function preparePrint(sale) {
    const area = $('#printArea');
    const size = $('#pageSize');
    if (!area || !size || !GC.receipt) return 0;

    const model = GC.receipt.build(sale || {}, tokoData());
    area.innerHTML = GC.receipt.toHtml(model);
    void area.offsetHeight; // paksa layout sebelum diukur
    const tinggi = GC.receipt.pageHeightMm(model);
    // Satu-satunya cara Chrome memakai tinggi = isi struk.
    size.textContent = '@page{size:58mm ' + tinggi + 'mm;margin:0}';
    return tinggi;
  }

  async function cetakStruk(sale) {
    await preparePrint(sale);
    window.print();
  }

  function modalBagikan(teks) {
    openModal(`
      <div class="modal-head">
        <h2>Bagikan struk</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">&times;</button>
      </div>
      <p class="modal-hint">Salin teks di bawah lalu tempel ke WhatsApp atau SMS.</p>
      <textarea class="share-text" id="shareText" rows="14" readonly aria-label="Teks struk">${esc(teks)}</textarea>
      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" data-close>Tutup</button>
        <button class="btn btn-primary" type="button" id="btnSalinStruk">Salin teks</button>
      </div>
    `);
    $('#btnSalinStruk').addEventListener('click', () => {
      const ta = $('#shareText');
      ta.focus();
      ta.select();
      salinTeks(teks);
    });
  }

  async function bagikanStruk(sale) {
    const teks = GC.receipt.toText(GC.receipt.build(sale || {}, tokoData()));
    if (navigator.share) {
      try {
        await navigator.share({ title: tokoData().nama || 'Struk', text: teks });
        return;
      } catch (err) {
        // Pengguna menutup dialog share: bukan kegagalan, jangan dialihkan.
        if (err && err.name === 'AbortError') return;
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(teks);
        toast('Struk disalin — tempel ke WhatsApp');
        return;
      } catch (_) { /* jatuh ke modal salin manual */ }
    }
    modalBagikan(teks);
  }

  function showPrintedReceipt(sale, change, saved = true) {
    const toko = tokoData();
    openModal(`
      <div class="printed">
        <span class="receipt-shop">${esc(toko.nama || 'GROCAIR')}</span>
        <p class="receipt-sub" style="text-align:center;margin-top:4px;">${dateStr(sale.at)} · ${timeStr(sale.at)}</p>
        <div class="printed-sep"></div>
        ${sale.items.map((it) => `
          <div class="printed-line"><span>${esc(it.name)} ×${esc(it.qty)}</span><span>${fmt(it.price * it.qty)}</span></div>
        `).join('')}
        <div class="printed-sep"></div>
        ${sale.diskon > 0 ? `<div class="printed-line"><span>DISKON</span><span>−${fmt(sale.diskon)}</span></div>` : ''}
        ${sale.pembulatan > 0 && sale.total !== sale.subtotal - sale.diskon ? `<div class="printed-line"><span>PEMBULATAN</span><span>${fmt(sale.total - (sale.subtotal - sale.diskon))}</span></div>` : ''}
        <div class="printed-line printed-grand"><span>TOTAL</span><span>${fmt(sale.total)}</span></div>
        <div class="printed-line"><span>BAYAR</span><span>${fmt(sale.bayar)}</span></div>
        <div class="printed-line"><span>KEMBALI</span><span>${fmt(Math.max(0, change))}</span></div>
        <div class="printed-sep"></div>
        ${saved ? '' : '<p class="printed-warn">TRANSAKSI BELUM TERSIMPAN — penyimpanan browser penuh/diblokir. Catat manual atau kosongkan ruang penyimpanan.</p>'}
        <p class="printed-thanks">TERIMA KASIH · SELAMAT BERJUALAN</p>
        <div class="printed-actions">
          <button class="btn btn-ghost" type="button" data-cetak>Cetak</button>
          <button class="btn btn-ghost" type="button" data-bagikan>Bagikan</button>
        </div>
        <button class="btn btn-primary printed-close" type="button" data-close>Transaksi baru</button>
      </div>
    `, true);

    const tombolCetak = $('[data-cetak]');
    if (tombolCetak) tombolCetak.addEventListener('click', () => cetakStruk(sale));
    const tombolBagikan = $('[data-bagikan]');
    if (tombolBagikan) tombolBagikan.addEventListener('click', () => bagikanStruk(sale));
  }

  function renderTodayTotal() {
    const total = todaySales().reduce((s, x) => s + x.total, 0);
    $('#todayTotal').textContent = fmt(total);
  }

  /* ---------------------------------------------------------
     Barang
     --------------------------------------------------------- */
  function renderBarang() {
    const bolehUbah = GC.auth.can('ubahBarang') === 'izin';
    const btnTambah = $('#btnAddProduct');
    if (btnTambah) btnTambah.hidden = !bolehUbah;
    const thAksi = $('#thAksi');
    if (thAksi) thAksi.hidden = !bolehUbah;

    const q = state.barang.q.trim().toLowerCase();
    const list = db.products.filter((p) =>
      !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q)
    );
    const body = $('#barangBody');
    const empty = $('#barangEmpty');
    $('#barangCount').textContent = `${list.length} dari ${db.products.length} barang`;

    if (!list.length) { body.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;

    body.innerHTML = list.map((p) => {
      const margin = p.price > 0 ? ((p.price - p.cost) / p.price) * 100 : 0;
      const marginClass = margin < 10 ? 'margin-low' : 'margin-ok';
      const low = stokMenipis(p);
      const auto = p.autoPrice ? ' · auto' : '';
      const nonaktif = p.aktif === false;
      const harga = bolehUbah
        ? `<input class="price-input" type="text" inputmode="numeric" autocomplete="off" value="${numID(p.price)}" data-price="${esc(p.id)}" aria-label="Harga jual ${esc(p.name)}" />`
        : `<span class="price-static">${fmt(p.price)}</span>`;
      const aksi = bolehUbah
        ? `<td class="aksi-col">
          <span class="row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-edit="${esc(p.id)}">Ubah</button>
            <button class="btn btn-ghost btn-sm" type="button" data-delp="${esc(p.id)}">Hapus</button>
          </span>
        </td>`
        : '<td class="aksi-col"></td>';
      return `<tr>
        <td>
          <div class="t-name">${esc(p.name)}${nonaktif ? ' <span class="tag tag-muted">nonaktif</span>' : ''}</div>
          <div class="t-sub">${esc(p.barcode || 'tanpa barcode')}${auto} · ${esc(p.satuan || 'pcs')}</div>
        </td>
        <td><span class="tag">${esc(p.cat)}</span></td>
        <td class="num" data-label="Modal">${fmt(p.cost)}</td>
        <td class="num" data-label="Jual">${harga}</td>
        <td class="num" data-label="Margin"><span class="${marginClass}">${margin.toFixed(1)}%</span></td>
        <td class="num" data-label="Stok"><span class="${low ? 'stock-low' : ''}">${esc(p.stock)}</span></td>
        ${aksi}
      </tr>`;
    }).join('');
  }

  const SUMBER_GERAK_LABEL = { jual: 'Jual', masuk: 'Stok masuk', koreksi: 'Koreksi', hapus: 'Hapus' };

  function riwayatStokHtml(productId) {
    const list = movementsFor(productId).slice(0, 8);
    if (!list.length) {
      return '<p class="modal-hint">Belum ada gerak stok. Penjualan dan stok masuk akan muncul di sini.</p>';
    }
    return `<ul class="stok-history">${list.map((g) => {
      const plus = g.delta > 0;
      return `<li class="sh-row">
        <span class="sh-when">${dateStr(g.at)} ${timeStr(g.at)}</span>
        <span class="sh-why">${esc(SUMBER_GERAK_LABEL[g.sumber] || g.sumber)}${g.alasan ? ' · ' + esc(g.alasan) : ''}</span>
        <span class="sh-delta ${plus ? 'plus' : 'minus'}">${plus ? '+' : ''}${esc(g.delta)}</span>
        <span class="sh-after">sisa ${esc(g.sesudah)}</span>
      </li>`;
    }).join('')}</ul>`;
  }

  function openStokMasuk(id) {
    const p = findProduct(id);
    if (!p) return;
    if (GC.auth.can('stokMasuk') !== 'izin') { toast('Stok masuk khusus pemilik', true); return; }
    openModal(`
      <div class="modal-head">
        <h2>Stok masuk</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
      </div>
      <p class="modal-hint">${esc(p.name)} · stok sekarang <strong>${esc(p.stock)}</strong> ${esc(p.satuan || 'pcs')} · modal ${fmt(p.cost)}</p>
      <form id="stokMasukForm" class="form-grid" autocomplete="off">
        <label class="field">
          <span>Jumlah masuk</span>
          <input type="number" id="si-qty" min="1" max="1000000" step="1" inputmode="numeric" placeholder="0" required />
        </label>
        <label class="field">
          <span>Modal baru</span>
          <input type="number" id="si-cost" min="0" max="1000000000" step="any" inputmode="numeric" value="${esc(p.cost)}" required />
          <span class="hint-text">Harga modal per ${esc(p.satuan || 'pcs')}. Kosongkan perubahan bila modal tetap.</span>
        </label>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-close>Batal</button>
          <button class="btn btn-primary" type="submit">Simpan</button>
        </div>
      </form>
    `);

    $('#stokMasukForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const tombol = e.submitter;
      if (tombol) tombol.disabled = true;
      const ok = await stockIn(p.id,
        cleanNumber($('#si-qty').value, LIMITS.stock),
        cleanNumber($('#si-cost').value, LIMITS.price));
      if (!ok) { if (tombol) tombol.disabled = false; return; }
      closeModal();
      toast(`Stok ${p.name} bertambah`);
    });

    $('#si-qty').focus();
  }

  function openKoreksiStok(id) {
    const p = findProduct(id);
    if (!p) return;
    if (GC.auth.can('koreksi') !== 'izin') { toast('Koreksi stok khusus pemilik', true); return; }
    openModal(`
      <div class="modal-head">
        <h2>Koreksi stok</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
      </div>
      <p class="modal-hint">Masukkan hasil hitung fisik. Selisihnya dicatat sebagai gerak <strong>koreksi</strong>, bukan menimpa riwayat. ${esc(p.name)} · sistem mencatat <strong>${esc(p.stock)}</strong>.</p>
      <form id="koreksiForm" class="form-grid" autocomplete="off">
        <label class="field">
          <span>Stok fisik</span>
          <input type="number" id="sk-fisik" min="0" max="1000000" step="1" inputmode="numeric" value="${esc(p.stock)}" required />
        </label>
        <label class="field">
          <span>Alasan</span>
          <input type="text" id="sk-alasan" maxlength="80" placeholder="Contoh: hitung fisik, rusak, tumpah" />
        </label>
        <p class="modal-hint" id="sk-aturan">Koreksi lebih dari ±10% stok (minimal 1 ${esc(p.satuan || 'pcs')}) minta PIN pemilik.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-close>Batal</button>
          <button class="btn btn-primary" type="submit">Simpan</button>
        </div>
      </form>
    `);

    $('#koreksiForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fisik = cleanNumber($('#sk-fisik').value, LIMITS.stock);
      const delta = fisik - p.stock;
      const alasan = cleanText($('#sk-alasan').value, LIMITS.name) || 'Hitung fisik';
      if (!delta) { toast('Stok fisik sama dengan catatan', true); return; }

      if (!perluPinKoreksi(p.stock, delta)) {
        const ok = await adjustStock(p.id, delta, alasan);
        if (ok) { closeModal(); toast('Stok dikoreksi'); }
        return;
      }

      mintaPin({
        aksi: 'koreksi',
        refId: p.id,
        nominal: Math.abs(delta),
        onSetuju: async (token) => adjustStock(p.id, delta, alasan, { token }),
      });
    });

    $('#sk-fisik').focus();
    $('#sk-fisik').select();
  }

  function openProductModal(id = null, barcodeAwal = '') {
    if (GC.auth.can('ubahBarang') !== 'izin') { toast('Hanya pemilik yang bisa mengubah barang', true); return; }
    if (!id) {
      const kuota = kuotaSekarang();
      if (!kuota.bolehTambahProduk) {
        toast(`Maksimal ${kuota.produkMax} barang di tier gratis — pasang langganan`, true);
        tampilkanLangganan('barang');
        return;
      }
    }
    const p = id ? findProduct(id) : null;
    const cats = Array.from(new Set(db.products.map((x) => x.cat)));
    const isAuto = !!(p && p.autoPrice);
    openModal(`
      <div class="modal-head">
        <h2>${p ? 'Ubah barang' : 'Tambah barang'}</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">&times;</button>
      </div>
      <form class="form-grid" id="productForm" autocomplete="off">
        <label class="field">
          <span>Nama barang</span>
          <input type="text" id="f-name" required maxlength="80" value="${p ? esc(p.name) : ''}" placeholder="Contoh: Indomie Goreng" />
        </label>
        <div class="field-row">
          <label class="field">
            <span>Kategori</span>
            <input type="text" id="f-cat" list="catList" required maxlength="30" value="${p ? esc(p.cat) : ''}" placeholder="Makanan" />
            <datalist id="catList">${cats.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
          </label>
          <div class="field">
            <label for="f-barcode">Barcode (opsional)</label>
            <div class="tools-row">
              <input type="text" id="f-barcode" inputmode="numeric" maxlength="40" value="${esc(p ? p.barcode || '' : barcodeAwal)}" placeholder="boleh kosong" />
              <button class="btn btn-ghost" type="button" id="btnScanBarang">Scan</button>
            </div>
          </div>
        </div>
        <div class="field-row">
          <label class="field">
            <span>Satuan</span>
            <input type="text" id="f-satuan" list="satuanList" maxlength="12" value="${p ? esc(p.satuan || 'pcs') : 'pcs'}" placeholder="pcs" />
            <datalist id="satuanList">
              ${['pcs', 'kg', 'liter', 'bungkus', 'renceng', 'dus', 'ikat'].map((s) => `<option value="${s}"></option>`).join('')}
            </datalist>
          </label>
          <label class="field">
            <span>Stok minimum</span>
            <input type="number" id="f-min" min="0" max="1000000" step="1" inputmode="numeric" value="${p ? esc(p.stokMinimum || 0) : 5}" />
            <span class="hint-text">Peringatan muncul saat stok ≤ angka ini.</span>
          </label>
        </div>
        <div class="field-row">
          <label class="field">
            <span>Harga modal (Rp)</span>
            <input type="number" id="f-cost" min="0" max="1000000000" step="any" required value="${p ? esc(p.cost) : ''}" placeholder="0" inputmode="numeric" />
          </label>
          <label class="field">
            <span>Harga jual (Rp)</span>
            <input type="number" id="f-price" min="0" max="1000000000" step="any" required value="${p ? esc(p.price) : ''}" placeholder="0" inputmode="numeric" />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" id="f-auto" ${isAuto ? 'checked' : ''} />
          <span>Hitung harga jual otomatis dari margin</span>
        </label>
        <div class="field" id="marginField" ${isAuto ? '' : 'hidden'}>
          <span>Target margin di atas modal (%)</span>
          <input type="number" id="f-margin" min="0" step="any" value="${p && p.margin != null ? esc(p.margin) : 20}" />
          <span class="hint-text">Contoh: modal Rp 10.000 + margin 20% → harga jual Rp 12.000.</span>
        </div>
        <label class="field">
          <span>Stok${p ? ' (lewat buku stok)' : ''}</span>
          <input type="number" id="f-stock" min="0" max="1000000" step="1" required
                 value="${p ? esc(p.stock) : 0}"
                 ${p ? 'readonly class="readonly"' : ''} inputmode="numeric" />
          ${p ? '<span class="hint-text">Stok berubah lewat Stok masuk atau Koreksi stok, supaya riwayatnya tetap utuh.</span>' : '<span class="hint-text">Stok awal dicatat sebagai gerak masuk.</span>'}
        </label>
        <label class="check">
          <input type="checkbox" id="f-aktif" ${!p || p.aktif !== false ? 'checked' : ''} />
          <span>Tampilkan di Kasir (barang aktif)</span>
        </label>
        ${p ? `<div class="stok-tools">
          <button class="btn btn-ghost btn-sm" type="button" data-stokin="${esc(p.id)}">Stok masuk</button>
          <button class="btn btn-ghost btn-sm" type="button" data-koreksi="${esc(p.id)}">Koreksi stok</button>
        </div>
        <div class="stok-history-wrap">
          <h3>Riwayat stok</h3>
          ${riwayatStokHtml(p.id)}
        </div>` : ''}
        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" data-close>Batal</button>
          <button class="btn btn-primary" type="submit">${p ? 'Simpan perubahan' : 'Tambah barang'}</button>
        </div>
      </form>
    `);

    $('#btnScanBarang').addEventListener('click', (e) => {
      GC.scanner.buka({
        trigger: e.currentTarget,
        onResult(code) { $('#f-barcode').value = cleanText(code, LIMITS.barcode); $('#f-barcode').focus(); },
        onManual() { $('#f-barcode').focus(); },
      });
    });

    const costEl = $('#f-cost');
    const priceEl = $('#f-price');
    const autoEl = $('#f-auto');
    const marginField = $('#marginField');
    const marginEl = $('#f-margin');

    const recompute = () => {
      priceEl.value = autoPrice(costEl.value, marginEl.value);
    };
    const syncAuto = () => {
      const on = autoEl.checked;
      marginField.hidden = !on;
      priceEl.readOnly = on;
      priceEl.classList.toggle('readonly', on);
      if (on) recompute();
    };
    autoEl.addEventListener('change', syncAuto);
    costEl.addEventListener('input', () => { if (autoEl.checked) recompute(); });
    marginEl.addEventListener('input', () => { if (autoEl.checked) recompute(); });
    syncAuto();

    const tombolStok = $('[data-stokin]');
    if (tombolStok) tombolStok.addEventListener('click', () => openStokMasuk(p.id));
    const tombolKoreksi = $('[data-koreksi]');
    if (tombolKoreksi) tombolKoreksi.addEventListener('click', () => openKoreksiStok(p.id));

    $('#productForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = cleanText($('#f-name').value, LIMITS.name);
      const cat = cleanText($('#f-cat').value, LIMITS.cat) || 'Lainnya';
      const barcode = cleanText($('#f-barcode').value, LIMITS.barcode);
      const satuan = cleanText($('#f-satuan').value, 12) || 'pcs';
      const stokMinimum = cleanNumber($('#f-min').value, LIMITS.stock);
      const cost = cleanNumber(costEl.value, LIMITS.price);
      const stock = cleanNumber($('#f-stock').value, LIMITS.stock);
      const autoOn = autoEl.checked;
      const margin = autoOn ? cleanNumber(marginEl.value, 1000, { round: false }) : null;
      const price = cleanNumber(autoOn ? autoPrice(cost, margin) : priceEl.value, LIMITS.price);
      const aktif = $('#f-aktif').checked;

      if (!name) { toast('Nama barang wajib diisi', true); return; }
      if (price <= 0) { toast('Harga jual harus lebih dari 0', true); return; }

      const produk = {
        id: p ? p.id : uid('p'),
        name, cat, satuan, barcode, cost, price, stock, stokMinimum, aktif,
        autoPrice: autoOn, margin,
      };

      const extra = [];
      if (!p && stock > 0) {
        const sesi = GC.auth.session();
        const gerak = gerakStok({ id: produk.id }, stock, 0, stock, 'Stok awal', 'masuk', sesi);
        const audit = auditStok('stokMasuk', `${name} +${stock} · stok awal`, sesi);
        if (gerak) extra.push({ store: 'stokGerak', record: gerak });
        if (audit) extra.push({ store: 'audit', record: audit });
      }

      try {
        await persistProduct(produk, extra);
      } catch (_) {
        toast('Gagal menyimpan barang — coba lagi', true);
        return;
      }
      closeModal();
      toast(p ? 'Barang diperbarui' : 'Barang ditambahkan');
    });

    $('#f-name').focus();
  }

  async function editPriceInline(id, value) {
    if (GC.auth.can('ubahBarang') !== 'izin') { toast('Ubah harga khusus pemilik', true); renderBarang(); return; }
    const p = findProduct(id);
    if (!p) return;
    const val = cleanNumber(parseRupiah(value), LIMITS.price);
    if (!(val > 0)) { toast('Harga harus lebih dari 0', true); renderBarang(); return; }
    try {
      await persistProduct({ ...p, price: val, autoPrice: false }); // ubah manual = lepas dari mode otomatis
    } catch (_) {
      toast('Gagal menyimpan harga — coba lagi', true);
      renderBarang();
      return;
    }
    toast(`Harga ${p.name} diperbarui`);
  }

  /* ---------------------------------------------------------
     Kalkulator grosir → eceran
     --------------------------------------------------------- */
  function hitungKalkulator(e) {
    e.preventDefault();
    const nama = $('#k-nama').value.trim() || 'Barang';
    const grosir = cleanNumber($('#k-grosir').value, LIMITS.price);
    const isi = cleanNumber($('#k-isi').value, LIMITS.stock);
    const ops = cleanNumber($('#k-ops').value, LIMITS.price);
    const target = cleanNumber($('#k-margin').value, 1000, { round: false });
    const out = $('#kalkResult');

    if (grosir <= 0 || isi <= 0) {
      out.innerHTML = `<p class="kalk-empty">Harga grosir dan total isi eceran wajib diisi lebih dari 0.</p>`;
      return;
    }

    const hpp = grosir / isi + ops;
    const rekom = Math.ceil((hpp * (1 + target / 100)) / 500) * 500;
    const laba = rekom - hpp;
    const marginAktual = rekom > 0 ? (laba / rekom) * 100 : 0;

    let status = 'Margin sehat';
    let cls = '';
    if (marginAktual < 10) { status = 'Margin terlalu tipis'; cls = 'tipis'; }
    else if (marginAktual > 50) { status = 'Margin kemahalan'; cls = 'mahal'; }

    out.innerHTML = `
      <p class="kalk-title">${esc(nama)}</p>
      <div class="kalk-list">
        <div class="kalk-row"><span>HPP per unit</span><span>${fmt(hpp)}</span></div>
        <div class="kalk-row"><span>Harga jual rekomendasi</span><span>${fmt(rekom)}</span></div>
        <div class="kalk-row"><span>Laba per unit</span><span>${fmt(laba)}</span></div>
        <div class="kalk-row"><span>Margin aktual</span><span>${marginAktual.toFixed(1)}%</span></div>
        <div class="kalk-row highlight"><span>Laba 1 paket grosir</span><span>${fmt(laba * isi)}</span></div>
      </div>
      <span class="kalk-badge ${cls}">${status}</span>
    `;
  }

  /* ---------------------------------------------------------
     Laporan
     --------------------------------------------------------- */
  /* ---------------------------------------------------------
     Laporan — satu rentang tanggal, satu agregat.
     Semua angka dihitung dari db.sales dengan filter yang sama,
     jadi kartu ringkasan, peringkat, dan CSV tidak mungkin berbeda.
     Transaksi void dan baris tanpa modal tidak ikut dihitung.
     --------------------------------------------------------- */
  const RENTANG_LABEL = { hari: 'Hari ini', minggu: '7 hari terakhir', bulan: 'Bulan ini', rentang: 'Rentang pilihan' };

  function awalHari(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }

  function akhirHari(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  }

  /* Menerima 'YYYY-MM-DD' (dari <input type="date">, ditafsirkan sebagai
     tanggal lokal) atau ISO lengkap. Tanggal saja tanpa jam selalu
     diperluas ke awal/akhir hari supaya transaksi hari terakhir ikut. */
  function batasHari(nilai, akhir) {
    if (nilai == null || nilai === '') return null;
    const teks = String(nilai).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(teks);
    if (m) {
      const y = Number(m[1]);
      const bl = Number(m[2]) - 1;
      const t = Number(m[3]);
      return akhir ? new Date(y, bl, t, 23, 59, 59, 999) : new Date(y, bl, t, 0, 0, 0, 0);
    }
    const d = new Date(teks);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function tanggalInput(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /* Rentang aktif dari state.laporan. Mode 'rentang' memakai isi input
     tanggal; mode lain dihitung ulang tiap render supaya "hari ini"
     tetap benar walau aplikasi dibiarkan terbuka melewati tengah malam. */
  function rentangLaporan() {
    const l = state.laporan || { mode: 'hari' };
    const sekarang = new Date();
    if (l.mode === 'minggu') {
      return { dari: awalHari(new Date(sekarang.getFullYear(), sekarang.getMonth(), sekarang.getDate() - 6)), sampai: akhirHari(sekarang) };
    }
    if (l.mode === 'bulan') {
      return { dari: new Date(sekarang.getFullYear(), sekarang.getMonth(), 1, 0, 0, 0, 0), sampai: akhirHari(sekarang) };
    }
    if (l.mode === 'rentang') {
      const dari = batasHari(l.dari, false);
      const sampai = batasHari(l.sampai, true);
      if (dari && sampai && dari <= sampai) return { dari, sampai };
      if (dari && !sampai) return { dari, sampai: akhirHari(dari) };
      if (!dari && sampai) return { dari: awalHari(sampai), sampai };
    }
    return { dari: awalHari(sekarang), sampai: akhirHari(sekarang) };
  }

  function reportRange(fromISO, toISO) {
    const dari = batasHari(fromISO, false) || awalHari(new Date());
    const sampai = batasHari(toISO, true) || akhirHari(dari);
    const awal = dari.getTime();
    const akhir = sampai.getTime();

    const hasil = {
      dari: dari.toISOString(),
      sampai: sampai.toISOString(),
      omzet: 0,
      transaksi: 0,
      item: 0,
      laba: 0,
      rata: 0,
      diskon: 0,
      manual: { jumlah: 0, selisih: 0, nilai: 0 },
      tanpaModal: { jumlah: 0, nilai: 0 },
      perKasir: [],
      penyesuaianStok: [],
      daftar: [],
    };
    if (!(awal <= akhir)) return hasil;

    const kasir = new Map();

    for (let i = 0; i < db.sales.length; i++) {
      const s = db.sales[i];
      if (s.status === 'void') continue;
      const t = Date.parse(s.at);
      if (!(t >= awal && t <= akhir)) continue;

      hasil.daftar.push(s);
      hasil.transaksi += 1;
      hasil.omzet += s.total;
      hasil.laba += s.laba || 0;
      hasil.diskon += s.diskon || 0;

      for (let j = 0; j < s.items.length; j++) {
        const it = s.items[j];
        hasil.item += it.qty;
        if (!(it.cost > 0)) {
          hasil.tanpaModal.jumlah += 1;
          hasil.tanpaModal.nilai += it.price * it.qty;
        }
      }

      for (let k = 0; k < s.manual.length; k++) {
        const me = s.manual[k];
        hasil.manual.jumlah += 1;
        hasil.manual.selisih += me.selisih || 0;
        hasil.manual.nilai += me.harga || 0;
      }

      const kunci = s.kasirId || '';
      const grup = kasir.get(kunci) || { stafId: s.kasirId || null, transaksi: 0, omzet: 0, laba: 0 };
      grup.transaksi += 1;
      grup.omzet += s.total;
      grup.laba += s.laba || 0;
      kasir.set(kunci, grup);
    }

    hasil.rata = hasil.transaksi ? Math.round(hasil.omzet / hasil.transaksi) : 0;
    hasil.perKasir = Array.from(kasir.values())
      .map((g) => ({ ...g, nama: namaStaf(g.stafId) || (g.stafId ? 'Staf' : 'Tanpa kasir') }))
      .sort((a, b) => b.omzet - a.omzet);

    const namaProduk = new Map(db.products.map((p) => [p.id, p.name]));
    for (let i = 0; i < db.stokGerak.length; i++) {
      const g = db.stokGerak[i];
      if (g.sumber === 'jual') continue;
      const t = Date.parse(g.at);
      if (!(t >= awal && t <= akhir)) continue;
      hasil.penyesuaianStok.push({
        id: g.id,
        produkId: g.produkId,
        nama: namaProduk.get(g.produkId) || 'Barang dihapus',
        delta: g.delta,
        sesudah: g.sesudah,
        sumber: g.sumber,
        alasan: g.alasan,
        at: g.at,
        stafId: g.stafId,
        staf: namaStaf(g.stafId) || '',
      });
    }
    hasil.penyesuaianStok.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    return hasil;
  }

  /* CSV untuk Excel: BOM supaya UTF-8 terbaca, semua sel dikutip, dan
     teks yang dimulai = + - @ TAB/CR diberi kutip tunggal agar tidak
     dieksekusi sebagai rumus (CSV injection). Angka dibiarkan apa adanya. */
  function toCsv(rows) {
    const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    if (!list.length) return '\uFEFF';
    const kolom = Object.keys(list[0]);

    const sel = (v) => {
      let s = v == null ? '' : String(v);
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };

    const garis = [kolom.map((k) => sel(k)).join(',')];
    list.forEach((r) => garis.push(kolom.map((k) => sel(r[k])).join(',')));
    return '\uFEFF' + garis.join('\r\n');
  }

  function barisCsv(laporan) {
    return laporan.daftar
      .slice()
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((s) => {
        const d = new Date(s.at);
        return {
          Tanggal: tanggalInput(d),
          Jam: timeStr(s.at),
          ID: s.id,
          Kasir: namaStaf(s.kasirId) || (s.kasirId ? 'Staf' : ''),
          Barang: s.items.map((it) => `${it.qty}x ${it.name}`).join('; ').slice(0, 300),
          Item: s.items.reduce((a, it) => a + it.qty, 0),
          Subtotal: s.subtotal,
          Diskon: s.diskon,
          Pembulatan: s.total - (s.subtotal - s.diskon),
          Total: s.total,
          Laba: s.laba || 0,
          Status: s.status,
        };
      });
  }

  function unduhBerkas(teks, nama, tipe) {
    const blob = new Blob([teks], { type: tipe || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nama;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* Ekspor = seluruh riwayat mentah, bukan ringkasan layar. Kasir cukup
     melihat angka; file yang bisa dibawa keluar warung khusus pemilik. */
  const bolehEkspor = () => GC.auth.can('ekspor') === 'izin';

  function eksporCsv() {
    if (!aksesLaporan()) return;
    if (!bolehEkspor()) { toast('Ekspor CSV khusus pemilik', true); return; }
    const r = rentangLaporan();
    const laporan = reportRange(tanggalInput(r.dari), tanggalInput(r.sampai));
    const rows = barisCsv(laporan);
    if (!rows.length) { toast('Tidak ada transaksi di rentang ini', true); return; }
    unduhBerkas(toCsv(rows), `grocair-penjualan-${tanggalInput(new Date())}.csv`);
    toast(`${rows.length} transaksi diekspor`);
  }

  function aksesLaporan() {
    const status = GC.entitlement.status();
    document.body.dataset.akses = document.body.dataset.lisensi = status;
    if (GC.entitlement.can('laporan')) return true;
    $('#statsGrid').replaceChildren();
    if (state.view === 'laporan') tampilkanLangganan('laporan');
    return false;
  }

  function renderReports() {
    if (!aksesLaporan()) return;
    const { dari, sampai } = rentangLaporan();
    const lap = reportRange(tanggalInput(dari), tanggalInput(sampai));

    const statPenyesuaian = lap.penyesuaianStok.reduce((a, g) => a + g.delta, 0);
    $('#statsGrid').innerHTML = `
      <div class="stat accent"><div class="s-label">Pemasukan</div><div class="s-value">${fmt(lap.omzet)}</div></div>
      <div class="stat"><div class="s-label">Transaksi</div><div class="s-value">${lap.transaksi}</div></div>
      <div class="stat"><div class="s-label">Barang terjual</div><div class="s-value">${lap.item}</div></div>
      <div class="stat"><div class="s-label">Estimasi laba</div><div class="s-value">${fmt(lap.laba)}</div></div>
      <div class="stat"><div class="s-label">Rata-rata / transaksi</div><div class="s-value">${fmt(lap.rata)}</div></div>
      <div class="stat" title="${lap.penyesuaianStok.length} gerak stok di luar penjualan"><div class="s-label">Penyesuaian stok</div><div class="s-value">${statPenyesuaian > 0 ? '+' : ''}${statPenyesuaian}</div></div>
    `;

    const ket = $('#lapKet');
    if (ket) ket.textContent = `${RENTANG_LABEL[state.laporan.mode] || ''} · ${dateStr(dari.toISOString())} – ${dateStr(sampai.toISOString())}`;

    $$('[data-rentang]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.rentang === state.laporan.mode));
    });
    const inpDari = $('#lapDari');
    const inpSampai = $('#lapSampai');
    if (inpDari && inpDari.value !== tanggalInput(dari)) inpDari.value = tanggalInput(dari);
    if (inpSampai && inpSampai.value !== tanggalInput(sampai)) inpSampai.value = tanggalInput(sampai);

    const note = $('#stockNote');
    if (note) {
      const menipis = db.products.filter((p) => p.aktif !== false && stokMenipis(p));
      const bagian = [];
      if (lap.tanpaModal.jumlah) {
        bagian.push(`${lap.tanpaModal.jumlah} baris tanpa modal (${fmt(lap.tanpaModal.nilai)}) — tidak masuk laba`);
      }
      if (lap.manual.jumlah) {
        const tanda = lap.manual.selisih > 0 ? '+' : '';
        bagian.push(`${lap.manual.jumlah} harga manual · selisih ${tanda}${fmt(lap.manual.selisih)}`);
      }
      if (lap.diskon) bagian.push(`Diskon ${fmt(lap.diskon)}`);
      if (statPenyesuaian) bagian.push(`Penyesuaian stok <strong>${statPenyesuaian > 0 ? '+' : ''}${statPenyesuaian}</strong>`);
      if (menipis.length) bagian.push(`<strong>${menipis.length} barang menipis</strong>`);
      note.innerHTML = bagian.join(' · ');
      note.hidden = bagian.length === 0;
    }

    const btnEkspor = $('#btnCsv');
    if (btnEkspor) btnEkspor.hidden = !bolehEkspor();

    const tally = new Map();
    lap.daftar.forEach((s) => s.items.forEach((it) => {
      const cur = tally.get(it.name) || { qty: 0, nilai: 0 };
      cur.qty += it.qty;
      cur.nilai += it.price * it.qty;
      tally.set(it.name, cur);
    }));
    const top = Array.from(tally.entries()).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);
    $('#rankingList').innerHTML = top.length
      ? top.map(([name, v]) => `<li><span class="r-name">${esc(name)}</span><span class="r-qty">${esc(v.qty)}×</span></li>`).join('')
      : `<li><span class="r-empty">Belum ada penjualan di rentang ini.</span></li>`;

    const recent = lap.daftar.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6);
    $('#txList').innerHTML = recent.length
      ? recent.map((s) => `
        <div class="tx">
          <div>
            <div>${esc(s.items.length)} barang · ${esc(s.items.reduce((a, it) => a + it.qty, 0))} item</div>
            <div class="tx-meta">${dateStr(s.at)} · ${timeStr(s.at)}</div>
          </div>
          <div class="tx-total">${fmt(s.total)}</div>
        </div>`).join('')
      : `<p class="tx-empty">Belum ada transaksi.</p>`;

    // Grafik selalu 7 hari terakhir, tidak ikut filter: tujuannya melihat
    // pola mingguan, dan grafik yang berubah rentang akan menyesatkan.
    const sah = db.sales.filter((s) => s.status !== 'void');
    const perHari = new Map();
    sah.forEach((s) => {
      const k = dayKey(s.at);
      perHari.set(k, (perHari.get(k) || 0) + s.total);
    });
    const days = [];
    const now = new Date();
    for (let d = 6; d >= 0; d--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
      days.push({ day, total: perHari.get(dayKey(day)) || 0, isToday: d === 0 });
    }
    const max = Math.max(...days.map((d) => d.total), 1);
    $('#salesBars').innerHTML = days.map((d) => `
      <div class="bar-col${d.isToday ? ' today' : ''}" title="${dateStr(d.day.toISOString())}: ${fmt(d.total)}">
        <span class="bar-val">${d.total ? Math.round(d.total / 1000) + 'rb' : '0'}</span>
        <div class="bar" style="height:${Math.max(3, (d.total / max) * 100)}%"></div>
        <span class="bar-day">${d.isToday ? 'Hari ini' : DAY_SHORT[d.day.getDay()]}</span>
      </div>`).join('');
  }

  /* ---------------------------------------------------------
     Modal
     --------------------------------------------------------- */
  let lastFocus = null;

  function openModal(html, plain = false) {
    lastFocus = document.activeElement;
    const root = $('#modalRoot');
    root.innerHTML = plain ? html : `<div class="modal">${html}</div>`;
    root.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  let modalWajib = false;

  /* Modal wajib (mis. setelah pemulihan data): tidak bisa ditutup lewat
     backdrop, Escape, atau tombol X. Data yang baru dipulihkan belum punya
     PIN pemilik, jadi aplikasi memang belum boleh dipakai. */
  function closeModal(paksa) {
    if (modalWajib && paksa !== true) return;
    modalWajib = false;
    const root = $('#modalRoot');
    root.hidden = true;
    root.classList.remove('sheet-open');
    root.innerHTML = '';
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ---------------------------------------------------------
     Event binding
     --------------------------------------------------------- */
  function bind() {
    $$('[data-go]').forEach((el) => el.addEventListener('click', (e) => {
      e.preventDefault();
      showView(el.dataset.go);
    }));

    // Kasir: cari + barcode (Enter)
    const search = $('#kasirSearch');
    search.addEventListener('input', () => { state.kasir.q = search.value; renderProducts(); });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = search.value.trim();
      if (!q) return;
      if (cariBarcode(q).length) {
        e.preventDefault();
        search.value = '';
        state.kasir.q = '';
        renderProducts();
        prosesBarcodeKasir(q, true);
      }
    });
    $('#btnScanKasir').addEventListener('click', (e) => {
      GC.scanner.buka({
        trigger: e.currentTarget,
        onResult(code) { prosesBarcodeKasir(code, false); },
        onManual() { search.focus(); },
      });
    });

    // Harga manual
    $('#btnManual').addEventListener('click', () => openManualModal());

    // Kategori
    $('#categoryChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-cat]');
      if (!chip) return;
      state.kasir.cat = chip.dataset.cat;
      $$('#categoryChips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.cat === state.kasir.cat)));
      renderProducts();
    });

    // Klik produk
    $('#productGrid').addEventListener('click', (e) => {
      const card = e.target.closest('[data-add]');
      if (card) addToCart(card.dataset.add);
    });

    // Kontrol keranjang
    $('#receiptItems').addEventListener('click', (e) => {
      const inc = e.target.closest('[data-inc]');
      const dec = e.target.closest('[data-dec]');
      const del = e.target.closest('[data-del]');
      if (inc) changeQty(inc.dataset.inc, 1);
      else if (dec) changeQty(dec.dataset.dec, -1);
      else if (del) removeLine(del.dataset.del);
    });

    $('#btnPay').addEventListener('click', openPaySheet);
    $('#cartBarPay').addEventListener('click', openPaySheet);
    $('#cartBarOpen').addEventListener('click', openReceipt);
    $('#receiptClose').addEventListener('click', closeReceipt);
    $('#btnDiskon').addEventListener('click', openDiskonModal);
    $('#btnClear').addEventListener('click', () => { if (cartCount()) { clearCart(); toast('Keranjang dikosongkan'); } });

    // Barang
    $('#btnAddProduct').addEventListener('click', () => openProductModal());
    $('#barangSearch').addEventListener('input', (e) => { state.barang.q = e.target.value; renderBarang(); });
    $('#barangBody').addEventListener('click', (e) => {
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-delp]');
      if (edit) { openProductModal(edit.dataset.edit); return; }
      if (!del) return;
      const p = findProduct(del.dataset.delp);
      if (!p) return;
      if (!confirm(`Hapus "${p.name}" dari daftar barang? Riwayat penjualan dan stok tetap disimpan.`)) return;
      deleteProduct(p.id).then((ok) => { if (ok) toast('Barang dihapus'); });
    });
    // edit harga cepat
    $('#barangBody').addEventListener('focusin', (e) => {
      if (e.target.matches && e.target.matches('[data-price]')) e.target.select();
    });
    $('#barangBody').addEventListener('change', (e) => {
      const inp = e.target.closest('[data-price]');
      if (inp) editPriceInline(inp.dataset.price, inp.value);
    });
    $('#barangBody').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-price]')) { e.preventDefault(); e.target.blur(); }
    });

    // Kalkulator
    $('#kalkForm').addEventListener('submit', hitungKalkulator);
    $('#kalkForm').addEventListener('reset', () => {
      $('#kalkResult').innerHTML = `<p class="kalk-empty">Isi form, lalu tekan Hitung. Rincian modal dan harga jual muncul di sini.</p>`;
    });

    // Laporan: filter rentang + ekspor CSV
    $$('[data-rentang]').forEach((b) => b.addEventListener('click', () => {
      state.laporan.mode = b.dataset.rentang;
      renderReports();
    }));
    const lapDari = $('#lapDari');
    const lapSampai = $('#lapSampai');
    if (lapDari) lapDari.addEventListener('change', () => {
      state.laporan.dari = lapDari.value;
      state.laporan.mode = 'rentang';
      renderReports();
    });
    if (lapSampai) lapSampai.addEventListener('change', () => {
      state.laporan.sampai = lapSampai.value;
      state.laporan.mode = 'rentang';
      renderReports();
    });
    const btnCsv = $('#btnCsv');
    if (btnCsv) btnCsv.addEventListener('click', eksporCsv);

    // Data & cadangan
    const btnBackup = $('#btnBackup');
    if (btnBackup) btnBackup.addEventListener('click', () => unduhBackup());
    const btnBackupReminder = $('#btnBackupReminder');
    if (btnBackupReminder) btnBackupReminder.addEventListener('click', () => unduhBackup());
    const btnPulihkan = $('#btnPulihkan');
    const filePulihkan = $('#filePulihkan');
    if (btnPulihkan && filePulihkan) btnPulihkan.addEventListener('click', () => {
      if (!GC.entitlement.can('backup_restore')) {
        toast('Pulihkan data memerlukan langganan Google Play', true);
        tampilkanLangganan('backup_restore');
        return;
      }
      filePulihkan.click();
    });
    if (filePulihkan) filePulihkan.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = ''; // file yang sama boleh dipilih lagi
      await pilihBerkasPulihkan(file);
    });
    const btnReset = $('#btnReset');
    if (btnReset) btnReset.addEventListener('click', async () => {
      if (!confirm('Hapus SEMUA data di perangkat ini? Backup otomatis disimpan di kunci prerestore, tapi lebih aman unduh backup dulu.')) return;
      await resetData();
    });

    // Kunci layar
    $('#lockPad').addEventListener('click', (e) => {
      const digit = e.target.closest('[data-digit]');
      if (digit) { tekanDigit(digit.dataset.digit); return; }
      if (e.target.closest('[data-hapus]')) { antrePin = antrePin.slice(0, -1); updateLockDots(); return; }
      if (e.target.closest('[data-batal]')) { antrePin = ''; updateLockDots(); }
    });
    $('#btnLupaPin').addEventListener('click', openLupaPin);

    // Pengaturan: aksi akses
    $('#setAkses').addEventListener('click', (e) => {
      if (e.target.closest('[data-masuk-pemilik]')) openMasukPemilik();
      else if (e.target.closest('[data-buat-pin]')) openBuatPin();
      else if (e.target.closest('[data-keluar]')) keluarSesi();
    });

    // Modal: klik backdrop / tombol data-close / Escape
    $('#modalRoot').addEventListener('click', (e) => {
      if (e.target.id === 'modalRoot') closeModal();
      if (e.target.closest('[data-close]')) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const navMenu = $('#navMenu');
      if (navMenu && navMenu.open) {
        navMenu.open = false;
        navMenu.querySelector('summary').focus();
        return;
      }
      if ((!GC.scanner || !GC.scanner.aktif) && !$('#modalRoot').hidden) closeModal();
    });
    // Klik di luar menu menutup panel (perilaku dropdown yang diharapkan).
    document.addEventListener('click', (e) => {
      const navMenu = $('#navMenu');
      if (navMenu && navMenu.open && !e.target.closest('#navMenu')) navMenu.open = false;
    });
  }

  /* ---------------------------------------------------------
     Onboarding, kunci layar, pengaturan
     --------------------------------------------------------- */
  const tokoData = () => (db.meta.toko && typeof db.meta.toko === 'object' ? db.meta.toko : {});
  const pengaturanData = () => (db.meta.pengaturan && typeof db.meta.pengaturan === 'object' ? db.meta.pengaturan : null);
  const pemilikAktif = () => db.staf.find((s) => s.peran === 'pemilik' && s.aktif && s.pin) || null;
  const namaStaf = (id) => (db.staf.find((s) => s.id === id) || {}).nama || '';

  function simpanPengaturan(value) {
    return GC.store.put('meta', { key: 'pengaturan', value }).then(() => {
      db.meta.pengaturan = value;
      return value;
    });
  }

  function terapkanPengaturan() {
    const p = pengaturanData() || {};
    const t = tokoData();
    const nama = t.nama || 'Warung saya';
    const el = $('#tokoNama');
    if (el) el.textContent = nama;
    const shop = $('#receiptShop');
    if (shop) shop.textContent = nama.toUpperCase();
    const alamat = $('#receiptAlamat');
    if (alamat) alamat.textContent = t.alamat ? t.alamat.toUpperCase() : 'KASIR';
    document.body.dataset.pin = pemilikAktif() ? 'siap' : 'belum';
    GC.auth.setShared(p.dipakaiBersama === true);
    return p;
  }

  /* Integritas jam (spec §11.1 dipertahankan): jam mundur > 6 jam → banner + audit. */
  async function cekJam() {
    const p = pengaturanData() || {};
    const now = Date.now();
    const clock = GC.license.checkClock(now, Number(p.lastSeenAt) || 0);
    const warn = $('#clockWarn');
    if (!clock.ok) {
      if (warn) warn.hidden = false;
      const catatan = GC.sanitize.audit({
        aksi: 'jam mundur',
        detail: `Jam perangkat mundur ${Math.ceil(clock.mundurMs / 60000)} menit dari catatan terakhir`,
        at: new Date(now).toISOString(),
      });
      if (catatan) {
        try {
          await GC.store.put('audit', catatan);
          db.audit.push(catatan);
        } catch (_) { /* audit gagal ditulis tidak boleh menghentikan boot */ }
      }
    } else if (warn) {
      warn.hidden = true;
    }
  }

  /* Akses: state machine entitlement (trial 30 hari → langganan Play).
     trialStart = min(cache, pengaturan, transaksi tertua) — hapus data
     tidak mereset trial secara instan. */
  async function initAkses() {
    const p = pengaturanData() || {};
    const n = Date.now();
    const cache = db.meta.entitlement && typeof db.meta.entitlement === 'object'
      ? db.meta.entitlement : null;
    const dariCache = Number(cache && cache.trialStart) || 0;
    const dariPengaturan = Number(p.trialStart) || 0;
    let trialStart = dariCache || dariPengaturan || n;
    const tertua = db.sales.reduce((min, s) => {
      const t = Date.parse(s.at);
      return t > 0 && t < min ? t : min;
    }, Infinity);
    if (tertua < trialStart) trialStart = tertua;

    GC.entitlement._reset();
    GC.entitlement._setTrialStart(trialStart);
    GC.entitlement._setLastSeen(Number(p.lastSeenAt) || 0);
    if (!isDirect() && cache && cache.purchaseToken) {
      GC.entitlement._setPurchase({
        token: cache.purchaseToken,
        productId: cache.productId,
        purchaseTime: cache.purchaseTime,
      });
    }
    if (isDirect()) await GC.entitlement.muatLisensi(db.meta.lisensi, db.meta.installId);
    const status = GC.entitlement.status();
    document.body.dataset.akses = status;
    // Kompatibilitas dengan tes & CSS lama: cermin status entitlement.
    document.body.dataset.lisensi = status;

    const ent = {
      status,
      trialStart,
      purchaseToken: (cache && cache.purchaseToken) || null,
      productId: (cache && cache.productId) || null,
      purchaseTime: (cache && cache.purchaseTime) || null,
      verifiedAt: (cache && cache.verifiedAt) || null,
      lastSeenAt: Math.max(n, Number(p.lastSeenAt) || 0),
    };
    try {
      await GC.store.put('meta', { key: 'entitlement', value: ent });
      db.meta.entitlement = ent;
    } catch (_) { /* cache gagal ditulis: status dihitung ulang saat boot berikutnya */ }
    if (pengaturanData()) {
      try {
        if (isDirect()) await GC.store.ingatWaktu(ent.lastSeenAt);
        else await GC.license.seen(n);
      } catch (_) { /* penanda ringan */ }
    }
    renderBannerTrial();

    // Verifikasi latar dengan Google Play jika plugin native terpasang
    if (!isDirect() && typeof window !== 'undefined' && window.AndroidBilling && typeof GC.entitlement.pulihkan === 'function') {
      GC.entitlement.pulihkan().then(async (res) => {
        if (res && res.restored) {
          await simpanAksesCache();
          document.body.dataset.akses = 'aktif';
          document.body.dataset.lisensi = 'aktif';
          renderBannerTrial();
          if (state.view === 'laporan') renderReports();
        }
      }).catch(() => {});
    }

    return status;
  }

  /* Banner trial: hari ke-7 sampai habis. Fitur dasar tetap gratis. */
  function renderBannerTrial() {
    const el = $('#trialBanner');
    if (!el) return;
    const sisa = GC.entitlement.sisaHariTrial ? GC.entitlement.sisaHariTrial() : null;
    const tampil = GC.entitlement.status() === 'trial' && sisa !== null && sisa <= 23;
    el.hidden = !tampil;
    if (tampil) {
      const teks = $('#trialBannerText');
      if (teks) teks.textContent = `Uji coba gratis: sisa ${sisa} hari. Setelah itu Laporan, Staf, dan Pulihkan backup butuh langganan.`;
    }
  }

  /* Perangkat pribadi: kasir langsung terbuka (sesi kasir, bukan pemilik).
     Perangkat bersama: selalu mulai dari kunci layar. */
  function mulaiSesi() {
    const p = pengaturanData() || {};
    if (p.dipakaiBersama === true) {
      GC.auth.logout();
      renderLock();
      return;
    }
    if (!GC.auth.session()) {
      const kasir = db.staf.find((s) => s.peran === 'kasir' && s.aktif)
        || { id: 'st-kasir-utama', nama: 'Kasir', peran: 'kasir', aktif: true };
      GC.auth.login(kasir);
    }
    sembunyikanLock();
  }

  let jamSesi = null;
  function pasangJamSesi() {
    if (jamSesi) return;
    const sentuh = () => GC.auth.touch();
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
      document.addEventListener(ev, sentuh, { passive: true });
    });
    jamSesi = setInterval(() => {
      if (!GC.auth.isShared()) return;
      if (!GC.auth.session() && $('#lock').hidden) renderLock();
    }, 20000);
  }

  /* ------------------------------ Onboarding ------------------------------ */
  const onb = { langkah: 1, dipakaiBersama: false, nama: '', alamat: '', pinRec: null, kode: null, kodeRec: null };

  function renderOnboarding() {
    const ov = $('#onboarding');
    if (!ov) return;
    ov.hidden = false;
    document.body.dataset.pin = 'belum';
    onb.langkah = 1;
    renderOnbLangkah();
  }

  function renderOnbLangkah() {
    $('#onbLangkah').textContent = `${onb.langkah}/4`;
    if (onb.langkah === 1) return onbLangkah1();
    if (onb.langkah === 2) return onbLangkah2();
    if (onb.langkah === 3) return onbLangkah3();
    return onbLangkah4();
  }

  function onbLangkah1() {
    $('#onbJudul').textContent = 'Siapkan warung';
    const form = $('#onbForm');
    form.innerHTML = `
      <label class="field">
        <span>Nama warung</span>
        <input type="text" id="onbNama" maxlength="40" placeholder="Contoh: Warung Bu Sri" value="${esc(onb.nama)}" required />
      </label>
      <label class="field">
        <span>Alamat atau nomor HP (opsional)</span>
        <input type="text" id="onbAlamat" maxlength="80" value="${esc(onb.alamat)}" />
      </label>
      <div class="onb-actions">
        <button class="btn btn-primary" type="submit">Lanjut</button>
        <button class="btn btn-ghost" type="button" data-isi-nanti>Isi nanti</button>
      </div>
      <p class="onb-note">Nama warung muncul di struk. Bisa diubah nanti di Pengaturan.</p>
    `;
    form.onsubmit = (e) => {
      e.preventDefault();
      const nama = cleanText($('#onbNama').value, 40);
      if (!nama) { toast('Nama warung wajib diisi', true); return; }
      onb.nama = nama;
      onb.alamat = cleanText($('#onbAlamat').value, 80);
      onb.langkah = 2;
      renderOnbLangkah();
    };
    form.querySelector('[data-isi-nanti]').onclick = () => isiNanti();
  }

  function onbLangkah2() {
    $('#onbJudul').textContent = 'Siapa yang memakai HP ini?';
    const form = $('#onbForm');
    form.innerHTML = `
      <p class="onb-note">Kalau HP ini juga dipegang orang lain, layar akan dikunci PIN setiap dibuka. Kalau hanya Anda, kasir langsung terbuka dan PIN hanya diminta untuk aksi sensitif.</p>
      <div class="onb-actions">
        <button class="btn btn-primary" type="button" data-bersama="ya">Ya, dipakai bersama</button>
        <button class="btn btn-ghost" type="button" data-bersama="tidak">Tidak, hanya saya</button>
      </div>
    `;
    form.querySelectorAll('[data-bersama]').forEach((b) => {
      b.onclick = () => {
        onb.dipakaiBersama = b.dataset.bersama === 'ya';
        onb.langkah = 3;
        renderOnbLangkah();
      };
    });
  }

  function onbLangkah3() {
    $('#onbJudul').textContent = 'Buat PIN pemilik';
    const form = $('#onbForm');
    form.innerHTML = `
      <label class="field">
        <span>Nama pemilik</span>
        <input type="text" id="onbPemilik" maxlength="40" placeholder="Contoh: Sri" value="${esc(onb.namaPemilik || '')}" required />
      </label>
      <div class="field-row">
        <label class="field">
          <span>PIN</span>
          <input type="password" id="onbPin" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="6 angka" />
        </label>
        <label class="field">
          <span>Ulangi PIN</span>
          <input type="password" id="onbPin2" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="6 angka" />
        </label>
      </div>
      <div class="onb-kode" id="onbKode" hidden>
        <p class="onb-kode-label">Kode pemulihan — catat sekarang. Hanya tampil sekali.</p>
        <output class="onb-kode-nilai" id="kodePemulihan"></output>
        <button class="btn btn-ghost btn-sm" type="button" data-salin>Salin kode</button>
        <label class="field">
          <span>Ketik 4 karakter pertama</span>
          <input type="text" id="onbKodeUlang" maxlength="8" autocomplete="off" />
        </label>
      </div>
      <div class="onb-actions">
        <button class="btn btn-ghost" type="button" data-kembali>Kembali</button>
        <button class="btn btn-primary" type="button" data-buat-kode>Buat kode pemulihan</button>
        <button class="btn btn-primary" type="submit" id="onbLanjut" disabled>Lanjut</button>
      </div>
      <p class="onb-note">PIN dipakai untuk menyetujui aksi sensitif. Kode pemulihan untuk mengganti PIN kalau lupa.</p>
    `;

    const lanjut = $('#onbLanjut');
    const cekLanjut = () => {
      const kode = normalKode($('#onbKodeUlang').value).slice(0, 4);
      lanjut.disabled = !(onb.pinRec && onb.kodeRec && kode.length === 4 && kode === onb.kode.slice(0, 4));
    };

    form.querySelector('[data-kembali]').onclick = () => {
      onb.langkah = 2;
      onb.pinRec = null;
      onb.kode = null;
      onb.kodeRec = null;
      renderOnbLangkah();
    };

    form.querySelector('[data-buat-kode]').onclick = async (e) => {
      const btn = e.currentTarget;
      const nama = cleanText($('#onbPemilik').value, 40);
      const pin = $('#onbPin').value;
      const pin2 = $('#onbPin2').value;
      if (!nama) { toast('Nama pemilik wajib diisi', true); return; }
      if (!/^\d{6}$/.test(pin)) { toast('PIN harus 6 angka', true); return; }
      if (pin !== pin2) { toast('PIN dan Ulangi PIN tidak sama', true); return; }

      btn.disabled = true;
      const labelAsli = btn.textContent;
      btn.textContent = 'Menyiapkan…';
      try {
        onb.namaPemilik = nama;
        onb.pinRec = await GC.auth.hashPin(pin);
        onb.kode = GC.auth.newRecoveryCode();
        onb.kodeRec = await GC.auth.hashRecovery(onb.kode);
        $('#kodePemulihan').textContent = onb.kode;
        $('#onbKode').hidden = false;
        btn.hidden = true;
        $('#onbKodeUlang').oninput = cekLanjut;
        $('#onbKodeUlang').focus();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = labelAsli;
        toast(err && err.message ? err.message : 'Gagal membuat PIN', true);
      }
    };

    form.querySelector('[data-salin]').onclick = () => salinTeks(onb.kode);

    form.onsubmit = (e) => {
      e.preventDefault();
      cekLanjut();
      if (lanjut.disabled) { toast('Ketik 4 karakter pertama kode pemulihan', true); return; }
      onb.langkah = 4;
      renderOnbLangkah();
    };
  }

  function onbLangkah4() {
    $('#onbJudul').textContent = 'Mulai dengan apa?';
    const form = $('#onbForm');
    form.innerHTML = `
      <p class="onb-note">Data contoh berisi 15 barang dan riwayat 7 hari — enak untuk mencoba. Mulai kosong kalau langsung mau dagang sungguhan.</p>
      <div class="onb-actions">
        <button class="btn btn-primary" type="button" data-contoh="ya">Pakai contoh data</button>
        <button class="btn btn-ghost" type="button" data-contoh="tidak">Mulai kosong</button>
      </div>
    `;
    form.querySelectorAll('[data-contoh]').forEach((b) => {
      b.onclick = () => finishOnboarding(Object.assign({}, onb, { pakaiContoh: b.dataset.contoh === 'ya' }));
    });
  }

  function normalKode(v) {
    return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function salinTeks(teks) {
    const tulis = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(teks)
      : Promise.reject(new Error('tidak tersedia'));
    tulis.then(() => toast('Disalin')).catch(() => toast('Salin manual: ' + teks));
  }

  async function isiNanti() {
    const p = {
      dipakaiBersama: false,
      pinBelumDiset: true,
      trialStart: Date.now(),
      lastBackupAt: null,
      lockout: { gagal: 0, sampai: 0 },
    };
    const put = [
      { store: 'meta', record: { key: 'pengaturan', value: p } },
      { store: 'meta', record: { key: 'toko', value: { nama: 'Warung saya', alamat: '', hp: '' } } },
      { store: 'meta', record: { key: 'installId', value: uid('i') } },
    ];
    try {
      await GC.store.writeTx({ put });
    } catch (_) {
      toast('Gagal menyimpan pengaturan — coba lagi', true);
      return;
    }
    db = await GC.store.loadAll();
    $('#onboarding').hidden = true;
    terapkanPengaturan();
    mulaiSesi();
    renderAll();
    renderPengaturan();
    toast('Bisa diisi nanti di Pengaturan');
  }

  async function finishOnboarding(form) {
    const f = form || {};
    const pinRec = f.pinRec || null;
    const pengaturanBaru = {
      dipakaiBersama: f.dipakaiBersama === true,
      pinBelumDiset: !pinRec,
      trialStart: Date.now(),
      lastBackupAt: null,
      lockout: { gagal: 0, sampai: 0 },
    };
    const tokoBaru = {
      nama: cleanText(f.nama, 40) || 'Warung saya',
      alamat: cleanText(f.alamat, 80),
      hp: cleanText(f.hp, 20),
    };
    const stafBaru = pinRec && f.namaPemilik
      ? { id: uid('st'), nama: cleanText(f.namaPemilik, 40), peran: 'pemilik', pin: pinRec, aktif: true }
      : null;
    const catatan = GC.sanitize.audit({
      aksi: 'onboarding',
      detail: `${tokoBaru.nama} · ${pengaturanBaru.dipakaiBersama ? 'dipakai bersama' : 'dipakai sendiri'} · PIN ${pinRec ? 'dibuat' : 'belum'}`,
    });
    const meta = {
      toko: tokoBaru,
      pengaturan: pengaturanBaru,
      installId: db.meta.installId || uid('i'),
    };
    if (f.kodeRec) meta.kodePemulihan = f.kodeRec;

    try {
      if (f.pakaiContoh) {
        const contoh = seed();
        await GC.store.replaceAll({
          meta: Object.assign(meta, {
            contoh: { at: new Date().toISOString() },
            manualRecent: contoh.manualRecent,
          }),
          staf: stafBaru ? [stafBaru] : [],
          products: contoh.products,
          sales: contoh.sales,
          audit: catatan ? [catatan] : [],
          stokGerak: [],
        });
      } else {
        const put = Object.keys(meta).map((key) => ({ store: 'meta', record: { key, value: meta[key] } }));
        if (stafBaru) put.push({ store: 'staf', record: stafBaru });
        if (catatan) put.push({ store: 'audit', record: catatan });
        await GC.store.writeTx({ put });
      }
    } catch (_) {
      toast('Gagal menyimpan pengaturan — coba lagi', true);
      return false;
    }

    db = await GC.store.loadAll();
    $('#onboarding').hidden = true;
    terapkanPengaturan();
    mulaiSesi();
    renderAll();
    renderPengaturan();
    showView('kasir');
    toast('Warung siap dipakai');
    return true;
  }

  /* ------------------------------ Kunci layar ------------------------------ */
  let antrePin = '';
  let memprosesPin = false;
  let hitungTimer = null;

  function bangunPad() {
    const pad = $('#lockPad');
    if (!pad || pad.childElementCount) return;
    const tombol = [];
    for (let d = 1; d <= 9; d++) tombol.push(`<button type="button" class="lock-key" data-digit="${d}">${d}</button>`);
    tombol.push('<button type="button" class="lock-key lebar" data-hapus>Hapus</button>');
    tombol.push('<button type="button" class="lock-key" data-digit="0">0</button>');
    tombol.push('<button type="button" class="lock-key lebar" data-batal>Ulangi</button>');
    pad.innerHTML = tombol.join('');
  }

  function updateLockDots() {
    const n = memprosesPin ? 6 : Math.min(antrePin.length, 6);
    $$('#lockDots span').forEach((el, i) => el.classList.toggle('isi', i < n));
  }

  function setLockMsg(teks, buruk = false) {
    const el = $('#lockMsg');
    if (!el) return;
    el.textContent = teks;
    el.classList.toggle('bad', !!buruk);
  }

  function setLockDisabled(disabled) {
    $$('#lockPad button').forEach((b) => { b.disabled = disabled; });
  }

  function mulaiHitung(detik) {
    if (hitungTimer) clearInterval(hitungTimer);
    let sisa = Math.max(0, Math.round(Number(detik) || 0));
    const tampil = () => {
      if (sisa <= 0) {
        if (hitungTimer) clearInterval(hitungTimer);
        hitungTimer = null;
        setLockDisabled(false);
        setLockMsg('Silakan coba lagi.', false);
        return;
      }
      setLockDisabled(true);
      setLockMsg(`Terlalu banyak percobaan. Coba lagi dalam ${sisa} detik.`, true);
    };
    tampil();
    hitungTimer = setInterval(() => { sisa -= 1; tampil(); }, 1000);
  }

  function renderLock() {
    const ov = $('#lock');
    if (!ov) return;
    bangunPad();
    antrePin = '';
    const t = tokoData();
    $('#lockSub').textContent = t.nama || 'Warung saya';
    ov.hidden = false;
    const l = GC.auth.lockout(pengaturanData() || {});
    if (l.terkunci) mulaiHitung(l.sisaDetik);
    else {
      setLockDisabled(false);
      setLockMsg('');
    }
    updateLockDots();
    renderBottomBar();
  }

  function sembunyikanLock() {
    const ov = $('#lock');
    if (ov) ov.hidden = true;
    if (hitungTimer) { clearInterval(hitungTimer); hitungTimer = null; }
    antrePin = '';
    memprosesPin = false;
    if ($('#lockMsg')) setLockMsg('');
    renderBottomBar();
  }

  function tekanDigit(d) {
    if ($('#lock').hidden) return;
    if (GC.auth.lockout(pengaturanData() || {}).terkunci) return;
    antrePin += String(d).slice(-1);
    if (antrePin.length > 12) antrePin = antrePin.slice(-12);
    updateLockDots();
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) { /* getar tidak didukung */ } }
    prosesAntrePin();
  }

  async function prosesAntrePin() {
    if (memprosesPin) return;
    memprosesPin = true;
    try {
      while (antrePin.length >= 6) {
        const pin = antrePin.slice(0, 6);
        antrePin = antrePin.slice(6);
        updateLockDots();
        await cobaPin(pin);
        if ($('#lock').hidden) { antrePin = ''; break; }
        if (GC.auth.lockout(pengaturanData() || {}).terkunci) { antrePin = ''; break; }
      }
    } finally {
      memprosesPin = false;
      updateLockDots();
    }
  }

  async function cobaPin(pin) {
    const p = pengaturanData() || {};
    if (GC.auth.lockout(p).terkunci) {
      mulaiHitung(GC.auth.lockout(p).sisaDetik);
      return false;
    }
    if (!/^\d{6}$/.test(String(pin))) return false;

    let cocok = null;
    for (const s of db.staf) {
      if (!s.aktif || !s.pin) continue;
      if (await GC.auth.verifyPin(pin, s.pin)) { cocok = s; break; }
    }

    if (cocok) {
      GC.auth.login(cocok);
      try { await simpanPengaturan(GC.auth.resetLockout(p).pengaturan); } catch (_) { /* lockout tetap di memori */ }
      sembunyikanLock();
      renderAll();
      renderPengaturan();
      toast(`Halo, ${cocok.nama}`);
      return true;
    }

    const h = GC.auth.fail(p);
    try { await simpanPengaturan(h.pengaturan); } catch (_) { /* tetap tampilkan pesan */ }
    setLockMsg('');
    if (h.terkunci) {
      mulaiHitung(h.sisaDetik);
    } else {
      const sisa = Math.max(0, GC.auth.MAKS_GAGAL - ((h.pengaturan.lockout && h.pengaturan.lockout.gagal) || 0));
      setLockMsg(`PIN salah. Sisa percobaan: ${sisa}.`, true);
    }
    return false;
  }

  async function unlock(pin) {
    const hasil = await cobaPin(String(pin == null ? '' : pin));
    antrePin = '';
    updateLockDots();
    return hasil;
  }

  /* ------------------------------ Pengaturan ------------------------------ */
  function renderPengaturan() {
    const t = tokoData();
    const p = pengaturanData() || {};
    const pemilik = pemilikAktif();
    const s = GC.auth.session();
    const namaToko = t.nama || 'Warung saya';

    const elNama = $('#tokoNama');
    if (elNama) elNama.textContent = namaToko;
    const shop = $('#receiptShop');
    if (shop) shop.textContent = namaToko.toUpperCase();
    const alamat = $('#receiptAlamat');
    if (alamat) alamat.textContent = t.alamat ? t.alamat.toUpperCase() : 'KASIR';

    if (!$('#setToko')) return;
    renderDataPanel();

    $('#setToko').innerHTML = `
      <div><dt>Nama warung</dt><dd>${esc(namaToko)}</dd></div>
      <div><dt>Alamat</dt><dd>${esc(t.alamat || '—')}</dd></div>
      <div><dt>PIN pemilik</dt><dd>${pemilik ? 'aktif' : 'belum dibuat'}</dd></div>
      <div><dt>Perangkat</dt><dd>${p.dipakaiBersama ? 'dipakai bersama' : 'dipakai sendiri'}</dd></div>
    `;

    const judul = s ? (namaStaf(s.stafId) || (s.peran === 'pemilik' ? 'Pemilik' : 'Kasir')) : 'Terkunci';
    const ket = s
      ? (s.peran === 'pemilik' ? 'Akses penuh' : 'Akses kasir — aksi sensitif minta PIN pemilik')
      : 'Masukkan PIN untuk membuka';
    const tombol = [];
    if (!s || s.peran !== 'pemilik') {
      tombol.push('<button class="btn btn-primary" type="button" data-masuk-pemilik>Masuk sebagai pemilik</button>');
    }
    if (!pemilik) tombol.push('<button class="btn btn-ghost" type="button" data-buat-pin>Buat PIN pemilik</button>');
    if (s) tombol.push('<button class="btn btn-ghost" type="button" data-keluar>Keluar</button>');

    $('#setAkses').innerHTML = `
      <div class="akses-status${s ? '' : ' tanpa'}">
        <strong>${esc(judul)}</strong>
        <span>${esc(ket)}</span>
      </div>
      <div class="akses-actions">${tombol.join('')}</div>
      <p class="modal-hint" style="margin:14px 0 0;">PIN pemilik hanya menyetujui satu aksi. Sesi kasir tidak berubah menjadi pemilik.</p>
    `;
  }

  function keluarSesi() {
    GC.auth.logout();
    const p = pengaturanData() || {};
    if (p.dipakaiBersama === true) {
      renderLock();
    } else {
      mulaiSesi();
    }
    renderPengaturan();
    if (state.view === 'barang') renderBarang();
    if (state.view === 'laporan') renderReports();
    toast('Sesi ditutup');
  }

  function openMasukPemilik() {
    const pemilik = pemilikAktif();
    if (!pemilik) { openBuatPin(); return; }
    openModal(`
      <div class="modal-head">
        <h2>Masuk sebagai pemilik</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
      </div>
      <form class="form-grid" id="masukForm" autocomplete="off">
        <label class="field">
          <span>PIN pemilik</span>
          <input type="password" id="masukPin" inputmode="numeric" maxlength="6" required />
        </label>
        <div class="modal-actions"><button class="btn btn-primary" type="submit">Masuk</button></div>
      </form>
    `);
    $('#masukForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = pengaturanData() || {};
      const l = GC.auth.lockout(p);
      if (l.terkunci) { toast(`Tunggu ${l.sisaDetik} detik`, true); return; }
      const pin = $('#masukPin').value;
      if (!(await GC.auth.verifyPin(pin, pemilik.pin))) {
        const h = GC.auth.fail(p);
        await simpanPengaturan(h.pengaturan).catch(() => {});
        toast(h.terkunci ? `Terlalu banyak percobaan. Tunggu ${h.sisaDetik} detik.` : 'PIN salah', true);
        return;
      }
      GC.auth.login(pemilik);
      await simpanPengaturan(GC.auth.resetLockout(p).pengaturan).catch(() => {});
      closeModal();
      renderPengaturan();
      toast(`Halo, ${pemilik.nama}`);
    });
  }

  function tampilkanKodeBaru(kode) {
    openModal(`
      <div class="modal-head">
        <h2>Kode pemulihan</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
      </div>
      <p class="modal-hint">Catat sekarang — kode hanya tampil sekali. Dipakai kalau PIN lupa.</p>
      <output class="onb-kode-nilai" id="kodeBaru">${esc(kode)}</output>
      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" data-salin-kode>Salin</button>
        <button class="btn btn-primary" type="button" data-close>Sudah dicatat</button>
      </div>
    `);
    const salin = $('[data-salin-kode]');
    if (salin) salin.onclick = () => salinTeks(kode);
  }

  function openBuatPin(opsi) {
    const wajib = !!(opsi && opsi.wajib);
    // Setelah restore, pemilik lama sudah ada tapi tanpa PIN. Pakai record
    // yang sama supaya id di riwayat penjualan tetap menunjuk orang yang benar.
    const pemilikLama = db.staf.find((s) => s.peran === 'pemilik' && !s.pin) || null;
    modalWajib = wajib;
    openModal(`
      <div class="modal-head">
        <h2>Buat PIN pemilik</h2>
        ${wajib ? '' : '<button class="modal-close" type="button" data-close aria-label="Tutup">×</button>'}
      </div>
      <form class="form-grid" id="buatPinForm" autocomplete="off">
        <label class="field">
          <span>Nama pemilik</span>
          <input type="text" id="bpNama" maxlength="40" placeholder="Contoh: Sri" value="${pemilikLama ? esc(pemilikLama.nama) : ''}" required />
        </label>
        <div class="field-row">
          <label class="field">
            <span>PIN baru</span>
            <input type="password" id="bpPin" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="6 angka" />
          </label>
          <label class="field">
            <span>Ulangi PIN baru</span>
            <input type="password" id="bpPin2" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="6 angka" />
          </label>
        </div>
        <p class="modal-hint">${wajib
          ? 'Data sudah dipulihkan. Buat PIN baru dulu — file backup tidak pernah membawa PIN lama.'
          : 'Kode pemulihan baru akan ditampilkan sekali setelah PIN dibuat.'}</p>
        <div class="modal-actions"><button class="btn btn-primary" type="submit">Buat PIN</button></div>
      </form>
    `);
    $('#buatPinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nama = cleanText($('#bpNama').value, 40);
      const pin = $('#bpPin').value;
      const pin2 = $('#bpPin2').value;
      if (!nama) { toast('Nama pemilik wajib diisi', true); return; }
      if (!/^\d{6}$/.test(pin)) { toast('PIN harus 6 angka', true); return; }
      if (pin !== pin2) { toast('PIN dan Ulangi PIN tidak sama', true); return; }

      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const pinRec = await GC.auth.hashPin(pin);
        const kode = GC.auth.newRecoveryCode();
        const kodeRec = await GC.auth.hashRecovery(kode);
        const p = pengaturanData() || {};
        const pengaturanBaru = Object.assign({}, p, { pinBelumDiset: false, lockout: { gagal: 0, sampai: 0 } });
        const stafBaru = pemilikLama
          ? Object.assign({}, pemilikLama, { nama, pin: pinRec, aktif: true })
          : { id: uid('st'), nama, peran: 'pemilik', pin: pinRec, aktif: true };
        const catatan = GC.sanitize.audit({ aksi: 'buatPin', detail: `PIN pemilik dibuat untuk ${nama}` });
        const put = [
          { store: 'staf', record: stafBaru },
          { store: 'meta', record: { key: 'pengaturan', value: pengaturanBaru } },
          { store: 'meta', record: { key: 'kodePemulihan', value: kodeRec } },
        ];
        if (catatan) put.push({ store: 'audit', record: catatan });
        await GC.store.writeTx({ put });

        db = await GC.store.loadAll();
        modalWajib = false;
        GC.auth.login(stafBaru);
        terapkanPengaturan();
        renderAll();
        renderPengaturan();
        tampilkanKodeBaru(kode);
        toast('PIN pemilik dibuat');
      } catch (err) {
        btn.disabled = false;
        toast(err && err.message ? err.message : 'Gagal membuat PIN', true);
      }
    });
  }

  function openLupaPin() {
    const nama = tokoData().nama || '';
    openModal(`
      <div class="modal-head">
        <h2>Lupa PIN</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">×</button>
      </div>
      <p class="modal-hint">Reset hanya menghapus akses (staf dan PIN). Barang dan penjualan tetap utuh. Setelah reset, buat PIN baru di Pengaturan.</p>
      <form class="form-grid" id="lupaForm" autocomplete="off">
        <label class="field">
          <span>Ketik nama warung</span>
          <input type="text" id="lupaNama" maxlength="40" placeholder="${esc(nama)}" required />
        </label>
        <div class="modal-actions"><button class="btn btn-primary" type="submit">Reset akses</button></div>
      </form>
    `);
    $('#lupaForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const ketik = cleanText($('#lupaNama').value, 40).toLowerCase();
      if (!ketik || ketik !== String(nama).trim().toLowerCase()) {
        toast('Nama warung tidak cocok', true);
        return;
      }
      await resetAksesSaja();
    });
  }

  async function resetAksesSaja() {
    const p = pengaturanData() || {};
    const baru = Object.assign({}, p, { pinBelumDiset: true, lockout: { gagal: 0, sampai: 0 } });
    const catatan = GC.sanitize.audit({ aksi: 'resetAkses', detail: 'Staf dan PIN dihapus lewat Lupa PIN' });
    const del = db.staf.map((s) => ({ store: 'staf', id: s.id }));
    del.push({ store: 'meta', id: 'kodePemulihan' });
    const put = [{ store: 'meta', record: { key: 'pengaturan', value: baru } }];
    if (catatan) put.push({ store: 'audit', record: catatan });

    try {
      await GC.store.writeTx({ put, del });
    } catch (_) {
      toast('Gagal mereset akses — coba lagi', true);
      return;
    }

    db = await GC.store.loadAll();
    GC.auth.logout();
    GC.auth.login({ id: 'st-kasir-utama', nama: 'Kasir', peran: 'kasir', aktif: true });
    closeModal();
    terapkanPengaturan();
    sembunyikanLock();
    renderAll();
    renderPengaturan();
    showView('pengaturan');
    toast('Akses direset. Barang dan penjualan tetap utuh.');
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  async function boot() {
    // Migrasi hanya jalan sekali; kalau gagal, aplikasi tetap memakai data lama.
    let hasilMigrasi = null;
    try {
      hasilMigrasi = await GC.store.migrateV1();
    } catch (_) { /* data lama dibiarkan apa adanya */ }

    db = await GC.store.loadAll();

    // PWA: daftar Service Worker (hanya secure context; 127.0.0.1 dan
    // localhost dianggap aman oleh browser modern).
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Periksa lisensi & jam sebelum apa pun dirender, supaya atribut
    // data-lisensi sudah final saat test/UI membacanya.
    await cekJam();
    await initAkses();

    if (!pengaturanData()) {
      renderOnboarding();
    } else {
      terapkanPengaturan();
      mulaiSesi();
    }

    renderAll();
    showView(location.hash.slice(1) || 'kasir');
    window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'kasir'));
    bangunPad();
    bind();
    bindLangganan();
    pasangJamSesi();

    if (hasilMigrasi && hasilMigrasi.migrated) {
      toast(`Data demo lama dipindahkan: ${hasilMigrasi.produk} barang, ${hasilMigrasi.penjualan} transaksi`);
    }

    // Tab lain menyimpan data (mis. transaksi baru): muat ulang tanpa menimpa keranjang.
    GC.store.onChange(() => {
      GC.store.loadAll().then(async (baru) => {
        db = baru;
        if (isDirect()) await GC.entitlement.muatLisensi(db.meta.lisensi, db.meta.installId);
        renderAll();
      }).catch(() => { /* data tidak valid: biarkan data lama */ });
    });

    document.body.dataset.siap = 'ya';
  }

  // API untuk modul/UI lain dan untuk test.
  /* ---------------------------------------------------------
     Data & cadangan
     Backup dipisah dari layar laporan: isinya SELURUH data mentah,
     jadi hanya pemilik yang boleh membawanya keluar. File tidak
     pernah memuat lisensi, installId, hash PIN, atau kode pemulihan.
     --------------------------------------------------------- */
  const bolehCadang = () => GC.auth.can('backup') === 'izin';

  function backupTerakhir() {
    const p = pengaturanData() || {};
    return Number(p.lastBackupAt) || 0;
  }

  function penjualanSejakBackup() {
    const t = backupTerakhir();
    return db.sales.filter((s) => s.status !== 'void' && Date.parse(s.at) > t).length;
  }

  function backupPerlu() {
    const t = backupTerakhir();
    if (!t) return db.sales.length > 0;
    return (Date.now() - t) > 7 * 86400000 || penjualanSejakBackup() > 100;
  }

  function renderBackupReminder() {
    const el = $('#backupReminder');
    if (!el) return;
    const perlu = backupPerlu();
    el.hidden = !perlu;
    const tombol = $('#btnBackupReminder');
    const teks = el.querySelector('[data-reminder-text]');
    if (tombol) tombol.hidden = !bolehCadang();
    if (!perlu || !teks) return;

    const t = backupTerakhir();
    const jumlah = penjualanSejakBackup();
    if (!t) {
      teks.textContent = 'Data ini belum pernah dicadangkan. Bila browser dibersihkan, semuanya hilang.';
    } else {
      const hari = Math.max(1, Math.floor((Date.now() - t) / 86400000));
      teks.textContent = `${jumlah} transaksi sejak cadangan terakhir (${hari} hari lalu). Unduh backup sekarang.`;
    }
    if (!bolehCadang()) teks.textContent += ' Minta pemilik menekan Unduh backup.';
  }

  function renderDataPanel() {
    const status = $('#dataStatus');
    if (!status) return;
    const t = backupTerakhir();
    const jumlah = penjualanSejakBackup();
    const bagian = [];
    bagian.push(t ? `Cadangan terakhir: ${dateStr(new Date(t).toISOString())}` : 'Belum pernah dicadangkan');
    if (t) bagian.push(`${jumlah} transaksi sejak itu`);
    bagian.push(`${db.products.length} barang · ${db.sales.length} transaksi tersimpan`);
    status.textContent = bagian.join(' · ');

    const izin = bolehCadang();
    ['#btnBackup', '#btnPulihkan'].forEach((sel) => {
      const el = $(sel);
      if (el) el.hidden = !izin;
    });
    const resetBtn = $('#btnReset');
    if (resetBtn) resetBtn.hidden = !izin;
    const kunci = $('#dataKunci');
    if (kunci) kunci.hidden = izin;
  }

  async function unduhBackup() {
    if (!bolehCadang()) { toast('Unduh backup khusus pemilik', true); return null; }
    let hasil;
    try {
      hasil = await GC.backup.export(db);
    } catch (_) {
      toast('Gagal membuat backup', true);
      return null;
    }
    unduhBerkas(hasil.json, hasil.filename, 'application/json');
    try {
      const p = pengaturanData() || {};
      await simpanPengaturan(Object.assign({}, p, { lastBackupAt: Date.now() }));
    } catch (_) { /* pengingat saja, bukan alasan gagal */ }
    renderBackupReminder();
    renderDataPanel();
    toast('Backup diunduh — simpan di tempat aman');
    return hasil;
  }

  function barisBanding(label, lama, baru, uang) {
    const f = (v) => (uang ? fmt(v) : String(v));
    return `<tr><td>${esc(label)}</td><td class="num">${esc(f(lama))}</td><td class="num">${esc(f(baru))}</td></tr>`;
  }

  function modalPulihkan(teks, hasil) {
    const lama = GC.backup.summary(db);
    const baru = hasil.summary;
    openModal(`
      <div class="modal-head">
        <h2>Pulihkan backup</h2>
        <button class="modal-close" type="button" data-close aria-label="Tutup">&times;</button>
      </div>
      <p class="modal-hint">File dibuat ${esc(hasil.exportedAt ? dateStr(hasil.exportedAt) : 'tanpa tanggal')}.
        Data di perangkat ini akan <strong>diganti</strong> oleh isi file. Bandingkan dulu angkanya.</p>
      <table class="table restore-table">
        <thead><tr><th>Isi</th><th class="num">Sekarang</th><th class="num">Dari file</th></tr></thead>
        <tbody>
          ${barisBanding('Barang', lama.produk, baru.produk)}
          ${barisBanding('Transaksi', lama.penjualan, baru.penjualan)}
          ${barisBanding('Omzet', lama.omzet, baru.omzet, true)}
          ${barisBanding('Estimasi laba', lama.laba, baru.laba, true)}
        </tbody>
      </table>
      <p class="modal-hint">Catatan audit tidak dihapus — catatan lama dan baru digabung.
        Setelah dipulihkan, pemilik wajib membuat PIN baru.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" type="button" data-close>Batal</button>
        <button class="btn btn-primary" type="button" id="btnLanjutPulihkan">Lanjut, minta PIN</button>
      </div>
    `);

    $('#btnLanjutPulihkan').addEventListener('click', () => {
      closeModal();
      mintaPin({
        aksi: 'restore',
        onSetuju: async (token) => {
          const out = await restoreFromText(teks, { token });
          if (!out.ok) { toast(out.error || 'Gagal memulihkan', true); return false; }
          return true;
        },
      });
    });
  }

  async function pilihBerkasPulihkan(file) {
    if (!file) return;
    if (file.size > GC.backup.MAKS_BACKUP) { toast('Berkas terlalu besar untuk backup Grocair', true); return; }
    let teks;
    try {
      teks = await file.text();
    } catch (_) {
      toast('Berkas tidak bisa dibaca', true);
      return;
    }
    const hasil = await GC.backup.inspect(teks);
    if (!hasil.ok) { toast(hasil.error, true); return; }
    modalPulihkan(teks, hasil);
  }

  async function restoreFromText(teks, opsi) {
    const hasil = await GC.backup.inspect(teks);
    if (!hasil.ok) return hasil;

    const out = await GC.backup.restore(hasil.snapshot, opsi);
    if (!out.ok) return out;

    await reload();
    terapkanPengaturan();
    const ov = $('#onboarding');
    if (ov) ov.hidden = true;
    // Backup tidak membawa PIN, jadi perangkat ini belum punya pemilik.
    // Jangan tampilkan kunci layar (tidak ada PIN yang bisa diketik);
    // langsung minta PIN baru sebagai modal wajib.
    sembunyikanLock();
    GC.auth.logout();
    renderAll();
    renderPengaturan();
    renderBackupReminder();
    toast(`${out.penjualan} transaksi dipulihkan — buat PIN baru`);
    openBuatPin({ wajib: true });
    return out;
  }

  async function resetData() {
    if (GC.auth.can('restore') !== 'izin') { toast('Hapus data khusus pemilik', true); return false; }
    // Reset tetap meninggalkan jejak: snapshot lama disimpan di kunci
    // prerestore, jadi "hapus semua" yang salah klik masih bisa dipulihkan.
    if (!GC.backup.simpanPrerestore(db)) {
      toast('Penyimpanan penuh — cadangan pembatalan gagal dibuat', true);
      return false;
    }
    const meta = {};
    ['installId', 'lisensi'].forEach((k) => {
      if (db.meta[k] !== undefined) meta[k] = db.meta[k];
    });
    try {
      await GC.store.replaceAll({
        meta, staf: [], products: [], sales: [], stokGerak: [], audit: [],
      });
    } catch (_) {
      toast('Gagal menghapus data', true);
      return false;
    }
    GC.auth.logout();
    await reload();
    renderAll();
    renderPengaturan();
    renderBackupReminder();
    renderOnboarding();
    toast('Data dikosongkan');
    return true;
  }

  GC.app = {
    state,
    reload: reload,
    renderAll: renderAll,
    renderOnboarding: renderOnboarding,
    finishOnboarding: finishOnboarding,
    renderLock: renderLock,
    unlock: unlock,
    renderPengaturan: renderPengaturan,
    renderBottomBar: renderBottomBar,
    openPaySheet: openPaySheet,
    openDiskonModal: openDiskonModal,
    applyDiscount: applyDiscount,
    voidSale: voidSale,
    stockIn: stockIn,
    adjustStock: adjustStock,
    movementsFor: movementsFor,
    deleteProduct: deleteProduct,
    preparePrint: preparePrint,
    cetakStruk: cetakStruk,
    bagikanStruk: bagikanStruk,
    reportRange: reportRange,
    toCsv: toCsv,
    eksporCsv: eksporCsv,
    unduhBackup: unduhBackup,
    restoreFromText: restoreFromText,
    resetData: resetData,
    backupPerlu: backupPerlu,
    pengaturanData: pengaturanData,
  };

  boot().catch((e) => {
    document.body.dataset.siap = 'gagal';
    console.error(e);
    toast('Gagal memuat data — muat ulang halaman', true);
  });
})();
