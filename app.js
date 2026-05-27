'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const API      = '/.netlify/functions/github-proxy';
const OFF_API  = 'https://world.openfoodfacts.org/api/v2/product/';
const STORES   = ['Leclerc', 'Carrefour', 'Lidl', 'Aldi', 'Intermarché', 'Autre'];
const CATS     = ['Épicerie', 'Produits laitiers', 'Viandes & Poissons', 'Fruits & Légumes',
                  'Boissons', 'Surgelés', 'Hygiène', 'Autre'];
const MAX_DAYS = 90;

// ============================================================
// STATE
// ============================================================
const state = {
  data:    { products: [], price_records: [], purchase_history: [] },
  sha:     null,
  saving:  false,
  ticket:  { store: STORES[0], date: todayISO(), items: [] },
  list:    [],         // array of product_id strings
  scanner: null        // ZXing codeReader instance
};

// ============================================================
// UTILITIES
// ============================================================
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('fr-FR');
}

function formatEur(n) {
  return typeof n === 'number' ? n.toFixed(2) + ' €' : '—';
}

function calcP100g(priceEur, weightG) {
  if (!weightG || weightG <= 0) return null;
  return Math.round((priceEur / weightG) * 100 * 1000) / 1000;
}

function daysDiff(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate)) / 86400000);
}

function getProduct(id) {
  return state.data.products.find(p => p.id === id) || null;
}

// ============================================================
// BEST PRICE LOGIC
// ============================================================
function getBestPrice(productId) {
  const records = state.data.price_records
    .filter(r => r.product_id === productId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (!records.length) return null;

  const recent = records.filter(r => daysDiff(r.date) <= MAX_DAYS);
  const pool   = recent.length ? recent : records;
  const outdated = recent.length === 0;

  const best = pool.reduce((a, b) => {
    const va = a.price_per_100g ?? a.price_eur;
    const vb = b.price_per_100g ?? b.price_eur;
    return vb < va ? b : a;
  });

  return { ...best, outdated, product: getProduct(productId) };
}

// ============================================================
// SHOPPING LIST OPTIMISATION
// ============================================================
function groupByBestStore(ids) {
  const groups = {};
  for (const id of ids) {
    const best    = getBestPrice(id);
    const product = getProduct(id);
    if (!product) continue;
    const store = best ? best.store : '— Prix inconnu';
    if (!groups[store]) groups[store] = [];
    groups[store].push({ product, record: best });
  }
  return groups;
}

function bestSingleStore(ids) {
  const counts = {}, totals = {};
  for (const id of ids) {
    const best = getBestPrice(id);
    if (!best) continue;
    counts[best.store] = (counts[best.store] || 0) + 1;
    totals[best.store] = (totals[best.store] || 0) + best.price_eur;
  }
  if (!Object.keys(counts).length) return null;
  return Object.keys(counts).reduce((a, b) => {
    if (counts[b] !== counts[a]) return counts[b] > counts[a] ? b : a;
    return totals[b] < totals[a] ? b : a;
  });
}

// ============================================================
// GITHUB API (via Netlify Function)
// ============================================================
async function loadData() {
  showLoader(true);
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);

    state.data = {
      products:         json.data.products         || [],
      price_records:    json.data.price_records    || [],
      purchase_history: json.data.purchase_history || []
    };
    state.sha = json.sha;

    if (state.data.products.length === 0) {
      seedDemoData();
      await saveData();
    }
    document.getElementById('config-banner').style.display = 'none';
  } catch (e) {
    console.error('Erreur chargement:', e);
    document.getElementById('config-banner').style.display = 'block';
    showToast('Connexion GitHub impossible — vérifiez la config.', 'error');
  } finally {
    showLoader(false);
  }
}

async function saveData() {
  if (state.saving) return;
  state.saving = true;
  try {
    const res = await fetch(API, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ data: state.data, sha: state.sha })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    state.sha = json.sha;
  } catch (e) {
    console.error('Erreur sauvegarde:', e);
    showToast('Erreur de sauvegarde.', 'error');
  } finally {
    state.saving = false;
  }
}

// ============================================================
// OPEN FOOD FACTS
// ============================================================
async function fetchOFF(barcode) {
  try {
    const res = await fetch(`${OFF_API}${barcode}.json`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.status !== 1 || !json.product) return null;
    const p = json.product;
    return {
      name:      p.product_name_fr || p.product_name || '',
      brand:     p.brands          || '',
      weight_g:  parseWeight(p.quantity || p.product_quantity || ''),
      category:  mapCategory(p.categories_tags || []),
      image_url: p.image_front_small_url || p.image_url || ''
    };
  } catch { return null; }
}

function parseWeight(qty) {
  const m = String(qty).match(/([\d.,]+)\s*(kg|g|ml|l|cl)/i);
  if (!m) return null;
  let val = parseFloat(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  if (u === 'kg' || u === 'l')  val *= 1000;
  if (u === 'cl')               val *= 10;
  return Math.round(val) || null;
}

function mapCategory(tags) {
  const s = tags.join(' ').toLowerCase();
  if (/lait|dairy|fromage|yaourt|cream/.test(s))     return 'Produits laitiers';
  if (/viande|meat|poisson|fish/.test(s))             return 'Viandes & Poissons';
  if (/beverage|boisson|drink|soda|juice/.test(s))    return 'Boissons';
  if (/frozen|surgel/.test(s))                        return 'Surgelés';
  if (/fruit|legume|vegetable|produce/.test(s))       return 'Fruits & Légumes';
  if (/hygiene|cosmet|beauty/.test(s))                return 'Hygiène';
  return 'Épicerie';
}

// ============================================================
// BARCODE SCANNER
// ============================================================
async function startScanner(callback) {
  document.getElementById('scanner-modal').classList.add('active');
  const video = document.getElementById('scanner-video');

  try {
    if (typeof ZXing === 'undefined') throw new Error('ZXing non disponible');
    state.scanner = new ZXing.BrowserMultiFormatReader();
    await state.scanner.decodeFromVideoDevice(null, video, (result, err) => {
      if (result) {
        const code = result.getText();
        stopScanner();
        callback(code);
      }
    });
  } catch (e) {
    stopScanner();
    // Fallback saisie manuelle
    const code = prompt('Caméra indisponible.\nEntrez le code-barre manuellement :');
    if (code && code.trim()) callback(code.trim());
  }
}

function stopScanner() {
  if (state.scanner) {
    try { state.scanner.reset(); } catch (_) {}
    state.scanner = null;
  }
  document.getElementById('scanner-modal').classList.remove('active');
}

// ============================================================
// TOAST & LOADER
// ============================================================
function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast ${type} show`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function showLoader(show) {
  document.getElementById('loader').style.display = show ? 'flex' : 'none';
}

// ============================================================
// TAB NAVIGATION
// ============================================================
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
}

// ============================================================
// TAB 1 — RELEVÉ DE PRIX
// ============================================================
function initReleve() {
  // Peupler les selects
  const storeSelect = document.getElementById('releve-store');
  const catSelect   = document.getElementById('releve-category');
  storeSelect.innerHTML = STORES.map(s => `<option>${s}</option>`).join('');
  catSelect.innerHTML   = CATS.map(c => `<option>${c}</option>`).join('');

  document.getElementById('releve-date').value = todayISO();

  // Scan bouton
  document.getElementById('releve-scan-btn').addEventListener('click', () => {
    startScanner(async code => {
      document.getElementById('releve-barcode').value = code;
      await autoFillReleve(code);
    });
  });

  // Lookup au blur du champ code-barre
  document.getElementById('releve-barcode').addEventListener('blur', async () => {
    const code = document.getElementById('releve-barcode').value.trim();
    if (code) await autoFillReleve(code);
  });

  // Soumission du formulaire
  document.getElementById('releve-form').addEventListener('submit', async e => {
    e.preventDefault();
    await submitReleve();
  });

  renderRecentRecords();
}

async function autoFillReleve(barcode) {
  // Chercher d'abord dans les produits connus
  const known = state.data.products.find(p => p.barcode === barcode);
  if (known) {
    fillReleveForm(known.name, known.brand, known.weight_g, known.category, known.image_url);
    return;
  }
  // Sinon Open Food Facts
  showLoader(true);
  const info = await fetchOFF(barcode);
  showLoader(false);
  if (info) {
    fillReleveForm(info.name, info.brand, info.weight_g, info.category, info.image_url);
  } else {
    showToast('Produit inconnu — remplissez manuellement.', 'info');
  }
}

function fillReleveForm(name, brand, weight, category, imgUrl) {
  if (name)     document.getElementById('releve-name').value     = name;
  if (brand)    document.getElementById('releve-brand').value    = brand;
  if (weight)   document.getElementById('releve-weight').value   = weight;
  if (category) document.getElementById('releve-category').value = category;
  const img = document.getElementById('releve-img');
  if (imgUrl) { img.src = imgUrl; img.style.display = 'block'; }
  else          img.style.display = 'none';
}

async function submitReleve() {
  const barcode  = document.getElementById('releve-barcode').value.trim();
  const name     = document.getElementById('releve-name').value.trim();
  const brand    = document.getElementById('releve-brand').value.trim();
  const weight   = parseFloat(document.getElementById('releve-weight').value) || null;
  const category = document.getElementById('releve-category').value;
  const store    = document.getElementById('releve-store').value;
  const price    = parseFloat(document.getElementById('releve-price').value);
  const date     = document.getElementById('releve-date').value || todayISO();

  if (!name)  { showToast('Le nom du produit est requis.', 'error');  return; }
  if (!price) { showToast('Entrez un prix valide.', 'error'); return; }

  // Trouver ou créer le produit
  let product = barcode ? state.data.products.find(p => p.barcode === barcode) : null;
  if (!product) {
    product = {
      id:        uuid(),
      barcode:   barcode || '',
      name, brand,
      weight_g:  weight,
      category,
      image_url: document.getElementById('releve-img').src || ''
    };
    state.data.products.push(product);
  } else {
    // Mettre à jour les champs vides
    if (!product.brand    && brand)    product.brand    = brand;
    if (!product.weight_g && weight)   product.weight_g = weight;
  }

  // Créer le relevé de prix
  state.data.price_records.push({
    id:            uuid(),
    product_id:    product.id,
    store, price_eur: price, date,
    price_per_100g: weight ? calcP100g(price, weight) : null
  });

  showLoader(true);
  await saveData();
  showLoader(false);

  showToast(`Relevé enregistré — ${name} @ ${formatEur(price)}`);
  document.getElementById('releve-form').reset();
  document.getElementById('releve-date').value     = todayISO();
  document.getElementById('releve-img').style.display = 'none';
  renderRecentRecords();
}

function renderRecentRecords() {
  const container = document.getElementById('recent-records');
  const records   = [...state.data.price_records]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10);

  if (!records.length) {
    container.innerHTML = '<p class="empty">Aucun relevé pour l\'instant.</p>';
    return;
  }

  container.innerHTML = records.map(r => {
    const p = getProduct(r.product_id);
    return `
      <div class="record-card">
        <div class="record-main">
          <span class="record-name">${p ? escHtml(p.name) : 'Produit inconnu'}</span>
          <span class="record-price">${formatEur(r.price_eur)}</span>
        </div>
        <div class="record-meta">
          <span>${escHtml(r.store)}</span>
          ${r.price_per_100g ? `<span>${r.price_per_100g.toFixed(3)} €/100g</span>` : ''}
          <span>${formatDate(r.date)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// TAB 2 — TICKET DE CAISSE
// ============================================================
function initTicket() {
  const storeSelect = document.getElementById('ticket-store');
  storeSelect.innerHTML = STORES.map(s => `<option>${s}</option>`).join('');
  document.getElementById('ticket-date').value = todayISO();

  document.getElementById('ticket-scan-btn').addEventListener('click', () => {
    startScanner(async code => await addTicketItem(code));
  });

  document.getElementById('ticket-add-manual-btn').addEventListener('click', () => {
    openManualProductSearch();
  });

  document.getElementById('ticket-save-btn').addEventListener('click', async () => {
    await saveTicket();
  });

  document.getElementById('ticket-clear-btn').addEventListener('click', () => {
    if (confirm('Effacer le ticket en cours ?')) {
      state.ticket = { store: STORES[0], date: todayISO(), items: [] };
      renderTicket();
    }
  });

  // Ticket item modal buttons
  document.getElementById('tim-confirm').addEventListener('click', confirmTicketItem);
  document.getElementById('tim-cancel').addEventListener('click', () => {
    document.getElementById('ticket-item-modal').classList.remove('active');
  });

  renderTicket();
}

async function addTicketItem(barcode) {
  showLoader(true);
  const info = await fetchOFF(barcode);
  showLoader(false);

  let product = state.data.products.find(p => p.barcode === barcode);

  if (!product) {
    const name = info ? info.name : prompt(`Code: ${barcode}\nNom du produit :`);
    if (!name) return;
    product = {
      id:        uuid(),
      barcode,
      name:      name || barcode,
      brand:     info?.brand     || '',
      weight_g:  info?.weight_g  || null,
      category:  info?.category  || 'Autre',
      image_url: info?.image_url || ''
    };
    state.data.products.push(product);
  }

  openTicketItemModal(product);
}

function openTicketItemModal(product) {
  const modal = document.getElementById('ticket-item-modal');
  document.getElementById('tim-product-name').textContent = escHtml(product.name);
  document.getElementById('tim-brand').textContent        = product.brand ? escHtml(product.brand) : '';
  document.getElementById('tim-price').value              = '';
  document.getElementById('tim-qty').value                = '1';
  modal.dataset.productId = product.id;

  // Pré-remplir avec le meilleur prix connu
  const best = getBestPrice(product.id);
  if (best) document.getElementById('tim-price').value = best.price_eur;

  modal.classList.add('active');
  setTimeout(() => document.getElementById('tim-price').focus(), 100);
}

function confirmTicketItem() {
  const modal = document.getElementById('ticket-item-modal');
  const pid   = modal.dataset.productId;
  const price = parseFloat(document.getElementById('tim-price').value);
  const qty   = parseInt(document.getElementById('tim-qty').value) || 1;

  if (!price || price <= 0) { showToast('Entrez un prix valide.', 'error'); return; }

  state.ticket.items.push({ product_id: pid, quantity: qty, price_eur: price });
  modal.classList.remove('active');
  renderTicket();

  const p = getProduct(pid);
  showToast(`${p ? p.name : 'Produit'} ajouté`);
}

function openManualProductSearch() {
  const query = prompt('Nom du produit à rechercher :');
  if (!query) return;

  const q       = query.toLowerCase();
  const matches = state.data.products.filter(p =>
    p.name.toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q)
  );

  if (!matches.length) { showToast('Aucun produit trouvé.', 'info'); return; }
  if (matches.length === 1) { openTicketItemModal(matches[0]); return; }

  const list    = matches.map((p, i) => `${i + 1}. ${p.name}${p.brand ? ' — ' + p.brand : ''}`).join('\n');
  const choice  = prompt(`Plusieurs résultats :\n\n${list}\n\nNuméro :`);
  const idx     = parseInt(choice) - 1;
  if (idx >= 0 && idx < matches.length) openTicketItemModal(matches[idx]);
}

window.removeTicketItem = function(idx) {
  state.ticket.items.splice(idx, 1);
  renderTicket();
};

function renderTicket() {
  const items     = state.ticket.items;
  const container = document.getElementById('ticket-items');
  let total       = 0;

  if (!items.length) {
    container.innerHTML = '<p class="empty">Aucun article — commencez à scanner.</p>';
    document.getElementById('ticket-total').textContent = '0,00 €';
    return;
  }

  container.innerHTML = items.map((item, idx) => {
    const p        = getProduct(item.product_id);
    const subtotal = item.price_eur * item.quantity;
    total += subtotal;
    return `
      <div class="ticket-item">
        <div class="ti-main">
          <span class="ti-name">${p ? escHtml(p.name) : 'Inconnu'}</span>
          <button class="btn-icon" onclick="removeTicketItem(${idx})">✕</button>
        </div>
        <div class="ti-meta">
          <span>Qté : ${item.quantity}</span>
          <span>${formatEur(item.price_eur)} / unité</span>
          <span class="ti-subtotal">${formatEur(subtotal)}</span>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('ticket-total').textContent = total.toFixed(2) + ' €';
}

async function saveTicket() {
  const items = state.ticket.items;
  if (!items.length) { showToast('Ticket vide.', 'error'); return; }

  const store = document.getElementById('ticket-store').value;
  const date  = document.getElementById('ticket-date').value || todayISO();
  const total = items.reduce((s, i) => s + i.price_eur * i.quantity, 0);

  state.data.purchase_history.push({
    id:        uuid(),
    date, store,
    items:     items.map(i => ({ ...i })),
    total_eur: Math.round(total * 100) / 100
  });

  // Créer aussi les price_records
  for (const item of items) {
    const p = getProduct(item.product_id);
    state.data.price_records.push({
      id:             uuid(),
      product_id:     item.product_id,
      store, price_eur: item.price_eur, date,
      price_per_100g: p?.weight_g ? calcP100g(item.price_eur, p.weight_g) : null
    });
  }

  showLoader(true);
  await saveData();
  showLoader(false);

  showToast(`Ticket enregistré — Total : ${formatEur(total)}`);
  state.ticket = { store: STORES[0], date: todayISO(), items: [] };
  renderTicket();
  renderRecentRecords();
}

// ============================================================
// TAB 3 — LISTE DE COURSES
// ============================================================
function initListe() {
  const search = document.getElementById('liste-search');
  search.addEventListener('input', () => renderSearchSuggestions(search.value));
  search.addEventListener('blur', () => {
    setTimeout(() => { document.getElementById('liste-search-results').innerHTML = ''; }, 200);
  });

  document.getElementById('liste-generate-btn').addEventListener('click', () => {
    renderGeneratedList(false);
  });
  document.getElementById('liste-single-store-btn').addEventListener('click', () => {
    renderGeneratedList(true);
  });
  document.getElementById('liste-copy-btn').addEventListener('click', copyListToClipboard);
  document.getElementById('liste-print-btn').addEventListener('click', () => window.print());

  renderSelectedProducts();
  renderGeneratedList(false);
}

function renderSearchSuggestions(query) {
  const container = document.getElementById('liste-search-results');
  if (!query || query.length < 2) { container.innerHTML = ''; return; }

  const q       = query.toLowerCase();
  const matches = state.data.products.filter(p =>
    !state.list.includes(p.id) &&
    (p.name.toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q))
  ).slice(0, 8);

  if (!matches.length) {
    container.innerHTML = '<div class="search-no-result">Aucun produit trouvé</div>';
    return;
  }

  container.innerHTML = matches.map(p => {
    const best  = getBestPrice(p.id);
    const price = best ? `${formatEur(best.price_eur)} @ ${escHtml(best.store)}` : 'Prix inconnu';
    return `
      <div class="search-result" data-id="${p.id}">
        <span class="sr-name">${escHtml(p.name)}</span>
        <span class="sr-brand">${escHtml(p.brand || '')}</span>
        <span class="sr-price">${price}</span>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('click', () => {
      addToList(el.dataset.id);
      document.getElementById('liste-search').value = '';
      container.innerHTML = '';
    });
  });
}

function addToList(productId) {
  if (!state.list.includes(productId)) {
    state.list.push(productId);
    renderSelectedProducts();
    renderGeneratedList(false);
  }
}

window.removeFromList = function(productId) {
  state.list = state.list.filter(id => id !== productId);
  renderSelectedProducts();
  renderGeneratedList(false);
};

function renderSelectedProducts() {
  const container = document.getElementById('liste-selected');
  if (!state.list.length) {
    container.innerHTML = '<p class="empty">Aucun produit sélectionné.</p>';
    return;
  }

  container.innerHTML = state.list.map(pid => {
    const p = getProduct(pid);
    if (!p) return '';
    return `
      <div class="selected-product">
        <span>${escHtml(p.name)}${p.brand ? ' — ' + escHtml(p.brand) : ''}</span>
        <button class="btn-icon" onclick="removeFromList('${pid}')">✕</button>
      </div>
    `;
  }).join('');
}

function renderGeneratedList(singleStore) {
  const container = document.getElementById('liste-output');
  const copyBtn   = document.getElementById('liste-copy-btn');
  const printBtn  = document.getElementById('liste-print-btn');

  if (!state.list.length) {
    container.innerHTML = '<p class="empty">Ajoutez des produits à votre liste pour générer.</p>';
    copyBtn.style.display = printBtn.style.display = 'none';
    return;
  }

  let html = '', grandTotal = 0;

  if (singleStore) {
    const store = bestSingleStore(state.list) || 'Magasin recommandé';
    let total = 0;
    html += `<div class="list-store-header">🏪 ${escHtml(store)}</div>`;
    for (const pid of state.list) {
      const p    = getProduct(pid);
      if (!p) continue;
      const best = getBestPrice(pid);
      if (best) total += best.price_eur;
      html += renderListItem(p, best);
    }
    html += `<div class="list-store-total">Total estimé ${escHtml(store)} : ${formatEur(total)}</div>`;
    grandTotal = total;
  } else {
    const groups = groupByBestStore(state.list);
    for (const [store, entries] of Object.entries(groups)) {
      let storeTotal = 0;
      html += `<div class="list-store-header">🏪 ${escHtml(store)}</div>`;
      for (const { product, record } of entries) {
        if (record) storeTotal += record.price_eur;
        html += renderListItem(product, record);
      }
      html += `<div class="list-store-total">Total ${escHtml(store)} : ${formatEur(storeTotal)}</div>`;
      grandTotal += storeTotal;
    }
  }

  html += `<div class="list-total">Total global estimé : ${formatEur(grandTotal)}</div>`;
  container.innerHTML = html;
  copyBtn.style.display = printBtn.style.display = 'block';
}

function renderListItem(product, record) {
  let priceText = 'Prix inconnu';
  if (record) {
    priceText = formatEur(record.price_eur);
    if (record.price_per_100g) priceText += ` (${record.price_per_100g.toFixed(3)} €/100g)`;
    if (record.outdated)       priceText += ' ⚠️ prix ancien';
    priceText += ` — ${formatDate(record.date)}`;
  }
  return `
    <div class="list-item">
      <div class="li-check">☐</div>
      <div class="li-info">
        <div class="li-name">${escHtml(product.name)}${product.brand ? ` <span class="li-brand">${escHtml(product.brand)}</span>` : ''}</div>
        <div class="li-price">${priceText}</div>
      </div>
    </div>
  `;
}

async function copyListToClipboard() {
  const lines = ['LISTE DE COURSES', new Date().toLocaleDateString('fr-FR'), ''];
  const groups = groupByBestStore(state.list);

  for (const [store, entries] of Object.entries(groups)) {
    lines.push(`== ${store} ==`);
    let total = 0;
    for (const { product, record } of entries) {
      const price = record ? `${record.price_eur.toFixed(2)} €` : '?';
      lines.push(`☐ ${product.name} — ${price}`);
      if (record) total += record.price_eur;
    }
    lines.push(`→ Total : ${total.toFixed(2)} €`, '');
  }

  try {
    await navigator.clipboard.writeText(lines.join('\n').trim());
    showToast('Liste copiée !');
  } catch {
    showToast('Impossible de copier automatiquement.', 'error');
  }
}

// ============================================================
// XSS PROTECTION
// ============================================================
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// DEMO DATA
// ============================================================
function seedDemoData() {
  const d   = (offset) => {
    const dt = new Date();
    dt.setDate(dt.getDate() - offset);
    return dt.toISOString().split('T')[0];
  };

  const prods = [
    { id: uuid(), barcode: '3017620422003', name: 'Nutella',          brand: 'Ferrero',   weight_g: 400,  category: 'Épicerie',          image_url: '' },
    { id: uuid(), barcode: '3228020316972', name: 'Beurre doux',      brand: 'Président', weight_g: 250,  category: 'Produits laitiers', image_url: '' },
    { id: uuid(), barcode: '5449000000996', name: 'Coca-Cola 1,5L',   brand: 'Coca-Cola', weight_g: 1500, category: 'Boissons',          image_url: '' },
    { id: uuid(), barcode: '8076808001180', name: 'Spaghetti n°5',    brand: 'Barilla',   weight_g: 500,  category: 'Épicerie',          image_url: '' },
    { id: uuid(), barcode: '3033490004295', name: 'Yaourts nature x4', brand: 'Danone',   weight_g: 500,  category: 'Produits laitiers', image_url: '' }
  ];

  const rawPrices = [
    { i: 0, store: 'Lidl',         price: 3.79, date: d(5)  },
    { i: 0, store: 'Leclerc',      price: 3.99, date: d(30) },
    { i: 0, store: 'Carrefour',    price: 4.29, date: d(60) },
    { i: 1, store: 'Aldi',         price: 1.79, date: d(3)  },
    { i: 1, store: 'Leclerc',      price: 1.89, date: d(25) },
    { i: 1, store: 'Intermarché',  price: 2.05, date: d(60) },
    { i: 2, store: 'Leclerc',      price: 1.89, date: d(7)  },
    { i: 2, store: 'Carrefour',    price: 1.99, date: d(30) },
    { i: 3, store: 'Lidl',         price: 0.99, date: d(10) },
    { i: 3, store: 'Carrefour',    price: 1.49, date: d(55) },
    { i: 4, store: 'Aldi',         price: 1.29, date: d(4)  },
    { i: 4, store: 'Leclerc',      price: 1.39, date: d(28) },
    { i: 4, store: 'Carrefour',    price: 1.55, date: d(58) }
  ];

  const price_records = rawPrices.map(r => {
    const p = prods[r.i];
    return {
      id:            uuid(),
      product_id:    p.id,
      store:         r.store,
      price_eur:     r.price,
      date:          r.date,
      price_per_100g: p.weight_g ? calcP100g(r.price, p.weight_g) : null
    };
  });

  const purchItems = [
    { product_id: prods[0].id, quantity: 1, price_eur: 3.79 },
    { product_id: prods[2].id, quantity: 2, price_eur: 1.89 },
    { product_id: prods[4].id, quantity: 1, price_eur: 1.29 }
  ];

  state.data = {
    products:         prods,
    price_records,
    purchase_history: [{
      id:        uuid(),
      date:      d(30),
      store:     'Lidl',
      items:     purchItems,
      total_eur: Math.round(purchItems.reduce((s, i) => s + i.price_eur * i.quantity, 0) * 100) / 100
    }]
  };

  showToast('Données de démonstration chargées.', 'info');
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Navigation par onglets
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Fermer le scanner
  document.getElementById('scanner-cancel-btn').addEventListener('click', stopScanner);

  // Charger les données
  await loadData();

  // Initialiser les 3 onglets
  initReleve();
  initTicket();
  initListe();

  showTab('releve');
});
