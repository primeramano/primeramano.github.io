// ================================================================
// Este catálogo NO depende de Firebase para leer ni para guardar nada.
// Todo (productos, configuración, fotos) vive como archivos dentro de este
// mismo repositorio de GitHub. Guardar un cambio = hacer un commit directo
// al repo con la API de GitHub. Sin cuotas diarias, sin límites externos,
// sin "Guardando..." colgado: si el commit se hizo, ya quedó fijo para
// siempre, tal cual como lo dejaste, hasta que vos lo cambies.
//
// Lo ÚNICO que usa Firebase es el login con Google: es solo la llave que
// decide quién puede VER el modo edición (nada de datos pasa por ahí).
// ================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const googleProvider = new GoogleAuthProvider();
let fbUser = null;

const GH_OWNER = "primeramano";
const GH_REPO = "primeramano.github.io";
const GH_BRANCH = "main";
const GH_TOKEN_KEY = "pm_gh_token";

function getGhToken() { try { return localStorage.getItem(GH_TOKEN_KEY) || ""; } catch (e) { return ""; } }
function setGhToken(t) { try { localStorage.setItem(GH_TOKEN_KEY, t); } catch (e) {} }
function clearGhToken() { try { localStorage.removeItem(GH_TOKEN_KEY); } catch (e) {} }

function b64EncodeUnicode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16))));
}
function b64DecodeUnicode(str) {
  return decodeURIComponent(atob(str).split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
}

async function ghRequest(path, opts = {}) {
  const token = getGhToken();
  return fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {})
    }
  });
}

async function ghGetJsonFile(path) {
  const res = await ghRequest(`/contents/${path}?ref=${GH_BRANCH}&_=${Date.now()}`);
  if (res.status === 404) return { sha: null, data: null };
  if (!res.ok) throw new Error(`No se pudo leer ${path} de GitHub (código ${res.status})`);
  const j = await res.json();
  return { sha: j.sha, data: JSON.parse(b64DecodeUnicode(j.content.replace(/\n/g, ""))) };
}

async function ghPutJsonFile(path, obj, sha, message) {
  const content = b64EncodeUnicode(JSON.stringify(obj, null, 2));
  const res = await ghRequest(`/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content, branch: GH_BRANCH, ...(sha ? { sha } : {}) })
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message || `No se pudo guardar ${path} en GitHub (código ${res.status})`);
  }
  return res.json();
}

// Sube una foto (data-URL ya comprimida) como archivo binario directo al
// repositorio — reemplaza el archivo si ya existe. Devuelve la ruta relativa
// (con un ?v= para que el navegador no muestre la foto vieja en caché).
async function ghPutBinaryFile(path, dataUrl, message) {
  let sha = null;
  const head = await ghRequest(`/contents/${path}?ref=${GH_BRANCH}`);
  if (head.ok) { const j = await head.json(); sha = j.sha; }
  const base64 = dataUrl.split(",")[1];
  const res = await ghRequest(`/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: base64, branch: GH_BRANCH, ...(sha ? { sha } : {}) })
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message || `No se pudo subir la foto a GitHub (código ${res.status})`);
  }
  return `${path}?v=${Date.now()}`;
}

// ---------- Meta Pixel + Conversions API ----------
// Envoltorio seguro: si el pixel no cargó (bloqueador de ads, sin conexión),
// nunca rompe el resto del catálogo. Cada evento se manda por dos caminos
// (pixel en el navegador + CAPI del lado del servidor) con el mismo event_id
// para que Meta los deduplique y no cuente el mismo evento dos veces.
const META_CAPI_ENDPOINT = "https://primeramano-meta-capi.belfioresantiago.workers.dev";

function trackMeta(event, params) {
  const eventId = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    if (typeof fbq === "function") fbq("track", event, params || {}, { eventID: eventId });
  } catch (e) {}

  try {
    fetch(META_CAPI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_name: event,
        event_id: eventId,
        event_source_url: location.href,
        user_data: {},
        custom_data: params || {},
      }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
}

function githubErrorMessage(e) {
  const s = ((e && e.message) || "").toLowerCase();
  if (s.includes("401") || s.includes("bad credentials")) {
    return "No se guardó: tu token de administrador venció o es inválido. Volvé a activar el modo edición.";
  }
  if (s.includes("403") || s.includes("rate limit")) {
    return "No se guardó: GitHub rechazó el pedido (permisos del token o límite momentáneo). Probá de nuevo en un minuto.";
  }
  if (s.includes("409") || s.includes("sha")) {
    return "No se guardó: alguien más (u otra pestaña) guardó un cambio justo antes. Recargá la página y probá de nuevo.";
  }
  if (s.includes("failed to fetch") || s.includes("networkerror")) {
    return "No se guardó: no hay conexión a internet en este momento.";
  }
  return "No se guardó. Probá de nuevo en un momento. Detalle: " + (e && e.message ? e.message : "error desconocido");
}

// ---------- State ----------
let products = {};        // id -> product
let settings = {};        // settings/site doc
let cart = {};             // id -> qty
let isAdmin = false;
let activeCategory = "__home__"; // "__home__" = portada con secciones por categoría
let searchTerm = "";
let editingProductId = null; // null = new product
const MAX_PRODUCT_PHOTOS = 12;
let pendingImages = [];       // base64 data-URLs, being edited for the current product (up to MAX_PRODUCT_PHOTOS)
let uploadTargetId = null;    // product id used when creating a brand-new product
let pendingLogoImage = null;
let pendingCoverImage = null;

try { cart = JSON.parse(localStorage.getItem("pm_cart_v1") || "{}"); } catch (e) { cart = {}; }

let cartStep = "items"; // "items" | "form" | "summary"
let checkoutData = { nombre: "", pago: "", entrega: "", entreCalles: "", localidad: "", provincia: "", cp: "", telefono: "", dni: "", notas: "" };

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function fmtARS(n) { return "$" + Math.round(n).toLocaleString("es-AR"); }
function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = (kind === "error" ? "⚠ " : kind === "ok" ? "✔ " : "") + msg;
  t.classList.remove("toast-ok", "toast-error");
  t.classList.add("show", kind === "error" ? "toast-error" : "toast-ok");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), kind === "error" ? 4200 : 2600);
}
function saveCart() {
  try { localStorage.setItem("pm_cart_v1", JSON.stringify(cart)); } catch (e) {}
}

// Si por lo que sea un pedido a GitHub se cuelga (sin internet, etc.), esto
// evita que el botón quede trabado en "Guardando..." para siempre: a los
// `ms` milisegundos lo tratamos como error y se puede reintentar.
function withSaveTimeout(promise, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Tardó demasiado (timeout)")), ms))
  ]);
}

function fileToDataUrl(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) { height = Math.round(height * maxSize / width); width = maxSize; }
        else if (height > maxSize) { width = Math.round(width * maxSize / height); height = maxSize; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Convierte una foto de producto a un data-URL base64, nítida y liviana para
// que la subida a Storage sea rápida. Como las fotos ahora se guardan como
// archivos en Storage (no adentro del documento de Firestore), no hace falta
// acotarlas al límite de 1MB por documento — se prioriza nitidez.
async function processProductPhoto(file, targetBytes = 500000) {
  const steps = [
    [1600, 0.85], [1280, 0.85], [1280, 0.72], [1024, 0.72], [1024, 0.6],
    [800, 0.65], [800, 0.5], [640, 0.5], [480, 0.45]
  ];
  let last = null;
  for (const [size, q] of steps) {
    const dataUrl = await fileToDataUrl(file, size, q);
    last = dataUrl;
    if (dataUrl.length <= targetBytes) return dataUrl;
  }
  return last; // ya achicado al máximo, se usa igual aunque no llegue al target
}

// ---------- Theme ----------
function waLink(number, text) {
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : "#";
}
function applyTheme() {
  const theme = settings.theme || {};
  const root = document.documentElement.style;
  root.setProperty("--brand", theme.brand || "#1f8a4c");
  root.setProperty("--bg", theme.bg || "#f7f7f5");
  root.setProperty("--text", theme.text || "#17181a");
  root.setProperty("--wa", theme.wa || "#22c35e");
  root.setProperty("--hiw-num", theme.step || "#FFD700");
  $("#page-title").textContent = settings.brand || "Primera Mano";
  $("#brand-name").textContent = settings.brand || "Primera Mano";
  $("#hero-title").textContent = settings.brand || "Primera Mano";
  $("#hero-desc").textContent = settings.description || "Catálogo de productos. Armá tu pedido y enviálo por WhatsApp.";
  $("#meta-desc").setAttribute("content", settings.description || "");
  document.title = settings.brand || "Primera Mano";
  if (settings.logo) { $("#brand-logo").src = settings.logo; $("#brand-logo").hidden = false; }
  else { $("#brand-logo").hidden = true; }
  const coverBanner = $("#cover-banner");
  if (coverBanner) {
    if (settings.cover) { $("#cover-img").src = settings.cover; coverBanner.hidden = false; }
    else { coverBanner.hidden = true; }
  }
  const footerBrand = $("#footer-brand"), footerDesc = $("#footer-desc"), footerWa = $("#footer-wa-btn");
  if (footerBrand) footerBrand.textContent = settings.brand || "Primera Mano";
  if (footerDesc) footerDesc.textContent = settings.description || "Catálogo de productos. Armá tu pedido y enviálo por WhatsApp.";
  const number = (settings.whatsapp || "").replace(/\D/g, "");
  const waText = "Hola! Tengo una consulta sobre " + (settings.brand || "el catálogo");
  if (footerWa) footerWa.href = waLink(number, waText);
  const heroWa = $("#hero-wa-btn");
  if (heroWa) {
    if (number) { heroWa.href = waLink(number, waText); heroWa.hidden = false; }
    else { heroWa.hidden = true; }
  }
}

function updateTrustCount() {
  const el = $("#trust-count");
  if (!el) return;
  const n = Object.keys(products).length;
  if (n > 0) el.textContent = "+" + (Math.floor(n / 10) * 10);
}

// ---------- Categories ----------
function categoriesFromProducts() {
  const set = new Set(Object.values(products).map(p => p.category).filter(Boolean));
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}
function goToCategory(cat) {
  activeCategory = cat;
  renderCats();
  renderGrid();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function renderCats() {
  const cats = categoriesFromProducts();
  const wrap = $("#cats");
  wrap.innerHTML = "";
  const homeChip = document.createElement("button");
  homeChip.className = "cat-chip" + (activeCategory === "__home__" ? " active" : "");
  homeChip.textContent = "Inicio";
  homeChip.onclick = () => goToCategory("__home__");
  wrap.appendChild(homeChip);
  const allChip = document.createElement("button");
  allChip.className = "cat-chip" + (activeCategory === "__all__" ? " active" : "");
  allChip.textContent = "Todos";
  allChip.onclick = () => goToCategory("__all__");
  wrap.appendChild(allChip);
  cats.forEach(c => {
    const chip = document.createElement("button");
    chip.className = "cat-chip" + (activeCategory === c ? " active" : "");
    chip.textContent = c;
    chip.onclick = () => goToCategory(c);
    wrap.appendChild(chip);
  });
  // datalist for admin product category autocomplete
  const dl = $("#cat-list");
  dl.innerHTML = cats.map(c => `<option value="${c.replace(/"/g,'&quot;')}">`).join("");

  // dropdown alternativo para elegir categoría (más cómodo en mobile)
  const sel = $("#cat-select");
  if (sel) {
    const esc = (s) => s.replace(/"/g, "&quot;");
    sel.innerHTML =
      `<option value="__home__">Inicio</option>` +
      `<option value="__all__">Todos los productos</option>` +
      cats.map(c => `<option value="${esc(c)}">${escapeHtml(c)}</option>`).join("");
    sel.value = activeCategory;
    sel.onchange = () => goToCategory(sel.value);
  }
}

// ---------- Grid ----------
function filteredProducts() {
  const term = searchTerm.trim().toLowerCase();
  return Object.values(products).filter(p => {
    if (activeCategory !== "__all__" && activeCategory !== "__home__" && p.category !== activeCategory) return false;
    if (term && !(p.title || "").toLowerCase().includes(term)) return false;
    return true;
  });
}
// Productos agrupados por categoría para la portada, con una vista previa de N.
function categorySections(previewCount = 6) {
  const cats = categoriesFromProducts();
  return cats.map(cat => {
    const items = Object.values(products)
      .filter(p => p.category === cat)
      .sort((a, b) => (a.title || "").localeCompare(b.title || "", "es"));
    return { cat, items, preview: items.slice(0, previewCount) };
  }).filter(s => s.items.length > 0);
}
function cardHTML(p, priority) {
  const loadAttrs = priority ? `loading="eager" fetchpriority="high"` : `loading="lazy" fetchpriority="low"`;
  return `
    <div class="card" data-id="${p.id}">
      <div class="thumb-wrap" data-open="1">
        <img src="${p.img}" alt="${escapeAttr(p.title)}" ${loadAttrs} decoding="async">
        ${isAdmin ? `<button class="admin-edit-mini" data-edit="${p.id}">✎</button>` : ""}
      </div>
      <div class="body">
        <span class="cat">${escapeHtml(p.category || "")}</span>
        <h3 data-open="1">${escapeHtml(p.title || "")}</h3>
        <div class="price">${fmtARS(p.price || 0)}</div>
        <div class="add-row">
          <div class="qty-stepper" data-qty>
            <button data-d="-1">−</button><span>1</span><button data-d="1">+</button>
          </div>
          <button class="add-btn" data-add>Agregar</button>
        </div>
      </div>
    </div>`;
}
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

let __renderToken = 0;
function wireCard(card) {
  const id = card.dataset.id;
  const stepper = card.querySelector("[data-qty]");
  let localQty = 1;
  stepper.querySelectorAll("button").forEach(b => {
    b.onclick = () => {
      localQty = Math.max(1, localQty + parseInt(b.dataset.d, 10));
      stepper.querySelector("span").textContent = localQty;
    };
  });
  card.querySelector("[data-add]").onclick = () => {
    addToCart(id, localQty);
    localQty = 1;
    stepper.querySelector("span").textContent = 1;
  };
  card.querySelectorAll("[data-open]").forEach(el => {
    el.onclick = () => openProductModal(id);
  });
  const editBtn = card.querySelector("[data-edit]");
  if (editBtn) editBtn.onclick = (e) => { e.stopPropagation(); openEditProduct(id); };
}
function renderGrid() {
  const term = searchTerm.trim();
  const grid = $("#grid");
  const homeEl = $("#home-sections");
  const backBtn = $("#back-to-home");
  const showHome = activeCategory === "__home__" && !term;

  if (showHome) {
    grid.hidden = true;
    $("#empty-state").hidden = true;
    $("#result-count").hidden = true;
    backBtn.hidden = true;
    homeEl.hidden = false;
    renderHomeSections();
    return;
  }

  homeEl.hidden = true;
  grid.hidden = false;
  $("#result-count").hidden = false;
  backBtn.hidden = false;

  const list = filteredProducts();
  const noDataYet = !dataLoaded && Object.keys(products).length === 0;
  $("#result-count").textContent = noDataYet ? "Cargando productos…" : (list.length + (list.length === 1 ? " producto" : " productos"));
  $("#empty-state").hidden = list.length > 0 || noDataYet;

  const myToken = ++__renderToken;
  grid.innerHTML = "";
  const CHUNK = 24;
  let i = 0;
  function renderChunk() {
    if (myToken !== __renderToken) return; // a newer render superseded this one
    const frag = document.createDocumentFragment();
    const tmp = document.createElement("div");
    const slice = list.slice(i, i + CHUNK);
    tmp.innerHTML = slice.map((p, idx) => cardHTML(p, i === 0 && idx < 6)).join("");
    Array.from(tmp.children).forEach(card => { wireCard(card); frag.appendChild(card); });
    grid.appendChild(frag);
    i += CHUNK;
    if (i < list.length) requestAnimationFrame(renderChunk);
  }
  renderChunk();
}

function renderHomeSections() {
  const homeEl = $("#home-sections");
  const sections = categorySections(6);
  if (sections.length === 0) {
    homeEl.innerHTML = (!dataLoaded && Object.keys(products).length === 0)
      ? `<p style="color:var(--muted);padding:20px 0;">Cargando catálogo…</p>` : "";
    return;
  }
  homeEl.innerHTML = sections.map((s, sIdx) => `
    <section class="home-section">
      <div class="home-section-head">
        <h2>${escapeHtml(s.cat)}</h2>
        <div class="home-section-actions">
          <span class="count">${s.items.length} ${s.items.length === 1 ? "producto" : "productos"}</span>
          ${s.items.length > s.preview.length ? `<button class="ver-todos-btn" data-cat="${escapeAttr(s.cat)}">Ver todos →</button>` : ""}
        </div>
      </div>
      <div class="home-row">${s.preview.map((p, idx) => cardHTML(p, sIdx === 0 && idx < 6)).join("")}</div>
    </section>`).join("");
  homeEl.querySelectorAll(".card").forEach(wireCard);
  homeEl.querySelectorAll(".ver-todos-btn").forEach(btn => {
    btn.onclick = () => goToCategory(btn.dataset.cat);
  });
}

// ---------- Cart ----------
function cartLines() {
  return Object.entries(cart).map(([id, qty]) => ({ item: products[id], qty })).filter(l => l.item && l.qty > 0);
}
function cartCount() { return cartLines().reduce((s, l) => s + l.qty, 0); }
function cartTotal() { return cartLines().reduce((s, l) => s + l.qty * l.item.price, 0); }
function addToCart(id, qty) {
  cart[id] = (cart[id] || 0) + qty;
  saveCart();
  renderCart();
  const p = products[id];
  if (p) {
    trackMeta("AddToCart", {
      content_ids: [p.id], content_type: "product", content_name: p.title,
      content_category: p.category || "", value: p.price * qty, currency: "ARS"
    });
  }
}
function setQty(id, qty) { if (qty <= 0) delete cart[id]; else cart[id] = qty; saveCart(); renderCart(); }

function renderCart() {
  // floating bottom bar
  const count = cartCount();
  const fc = $("#floating-cart");
  fc.hidden = count === 0;
  $("#fc-count").textContent = count + (count === 1 ? " item" : " items");
  $("#fc-total").textContent = fmtARS(cartTotal());

  renderCartDrawer();
}

function openCartDrawer(step) {
  if (step) cartStep = step;
  $("#cart-overlay").classList.add("open");
  $("#cart-drawer").classList.add("open");
  renderCartDrawer();
}
function closeCartDrawer() {
  $("#cart-overlay").classList.remove("open");
  $("#cart-drawer").classList.remove("open");
}

function renderCartDrawer() {
  const backBtn = $("#cart-back-btn");
  const title = $("#cart-drawer-title");
  const body = $("#cart-drawer-body");
  const foot = $("#cart-drawer-foot");
  const lines = cartLines();

  if (cartStep === "items") {
    backBtn.hidden = true;
    title.textContent = "Tu pedido";
    if (lines.length === 0) {
      body.innerHTML = `<p style="color:var(--muted);font-size:.9rem;">Todavía no agregaste productos.</p>`;
    } else {
      body.innerHTML = lines.map(l => `
        <div class="cart-line" data-id="${l.item.id}">
          <img src="${l.item.img}" alt="">
          <div class="info">
            <h4>${escapeHtml(l.item.title)}</h4>
            <div class="p">${l.qty} x ${fmtARS(l.item.price)} = ${fmtARS(l.qty * l.item.price)}</div>
            <button class="remove" data-remove>Quitar</button>
          </div>
        </div>`).join("");
      body.querySelectorAll("[data-remove]").forEach(btn => {
        btn.onclick = () => setQty(btn.closest(".cart-line").dataset.id, 0);
      });
    }
    foot.innerHTML = `
      <div class="total-row"><span>Total</span><span>${fmtARS(cartTotal())}</span></div>
      <button class="wa-btn" id="cart-continue-btn" ${lines.length === 0 ? "disabled" : ""}>Continuar</button>`;
    $("#cart-continue-btn").onclick = () => {
      if (cartLines().length === 0) return;
      trackMeta("InitiateCheckout", {
        content_ids: lines.map(l => l.item.id), content_type: "product",
        num_items: cartCount(), value: cartTotal(), currency: "ARS"
      });
      cartStep = "form";
      renderCartDrawer();
    };

  } else if (cartStep === "form") {
    backBtn.hidden = false;
    title.textContent = "Completá tu pedido";
    const d = checkoutData;
    body.innerHTML = `
      <div class="field">
        <label>Nombre completo *</label>
        <input type="text" id="co-nombre" value="${escapeAttr(d.nombre)}" maxlength="70">
      </div>
      <div class="field">
        <label>Forma de pago *</label>
        <div class="radio-group">
          <label class="radio-opt"><input type="radio" name="co-pago" value="efectivo" ${d.pago === "efectivo" ? "checked" : ""}> Efectivo<span class="hint">El pago se coordina por WhatsApp</span></label>
          <label class="radio-opt"><input type="radio" name="co-pago" value="transferencia" ${d.pago === "transferencia" ? "checked" : ""}> Transferencia<span class="hint">El pago se coordina por WhatsApp</span></label>
        </div>
      </div>
      <div class="field">
        <label>Método de entrega *</label>
        <div class="radio-group">
          <label class="radio-opt"><input type="radio" name="co-entrega" value="retiro" ${d.entrega === "retiro" ? "checked" : ""}> Retiro en el local</label>
          <label class="radio-opt"><input type="radio" name="co-entrega" value="domicilio" ${d.entrega === "domicilio" ? "checked" : ""}> Envío a domicilio</label>
        </div>
      </div>
      <div id="co-address-fields" ${d.entrega === "domicilio" ? "" : "hidden"}>
        <div class="field">
          <label>Dirección / entre calles *</label>
          <input type="text" id="co-calles" value="${escapeAttr(d.entreCalles)}" maxlength="70">
        </div>
        <div class="field-row">
          <div class="field">
            <label>Localidad *</label>
            <input type="text" id="co-localidad" value="${escapeAttr(d.localidad)}" maxlength="70">
          </div>
          <div class="field">
            <label>Provincia *</label>
            <input type="text" id="co-provincia" value="${escapeAttr(d.provincia)}" maxlength="70">
          </div>
        </div>
        <div class="field">
          <label>Código postal *</label>
          <input type="text" id="co-cp" value="${escapeAttr(d.cp)}" maxlength="20">
        </div>
      </div>
      <div class="field">
        <label>Teléfono *</label>
        <input type="text" id="co-telefono" value="${escapeAttr(d.telefono)}" maxlength="30">
      </div>
      <div class="field">
        <label>DNI</label>
        <input type="text" id="co-dni" value="${escapeAttr(d.dni)}" maxlength="20">
      </div>
      <div class="field">
        <label>¿Algo más que quieras agregar?</label>
        <textarea id="co-notas" maxlength="200">${escapeHtml(d.notas)}</textarea>
      </div>`;
    $$('input[name="co-entrega"]').forEach(r => {
      r.onchange = () => { $("#co-address-fields").hidden = $('input[name="co-entrega"]:checked').value !== "domicilio"; };
    });
    foot.innerHTML = `<button class="wa-btn" id="checkout-continue-btn">Ver resumen</button>`;
    $("#checkout-continue-btn").onclick = () => {
      d.nombre = $("#co-nombre").value.trim();
      const pagoEl = $('input[name="co-pago"]:checked');
      const entregaEl = $('input[name="co-entrega"]:checked');
      d.pago = pagoEl ? pagoEl.value : "";
      d.entrega = entregaEl ? entregaEl.value : "";
      d.entreCalles = $("#co-calles").value.trim();
      d.localidad = $("#co-localidad").value.trim();
      d.provincia = $("#co-provincia").value.trim();
      d.cp = $("#co-cp").value.trim();
      d.telefono = $("#co-telefono").value.trim();
      d.dni = $("#co-dni").value.trim();
      d.notas = $("#co-notas").value.trim();

      if (!d.nombre) return toast("Falta tu nombre completo");
      if (!d.pago) return toast("Elegí una forma de pago");
      if (!d.entrega) return toast("Elegí un método de entrega");
      if (d.entrega === "domicilio" && (!d.entreCalles || !d.localidad || !d.provincia || !d.cp)) return toast("Completá los datos de envío");
      if (!d.telefono) return toast("Falta tu teléfono");

      cartStep = "summary";
      renderCartDrawer();
    };

  } else if (cartStep === "summary") {
    backBtn.hidden = false;
    title.textContent = "Detalle de tu compra";
    body.innerHTML = `
      <div class="summary-status"><span>Estado del pago</span><span class="pill warn">Pendiente</span></div>
      ${lines.map(l => `
        <div class="summary-line">
          <span class="qty">${l.qty}</span>
          <div class="info"><div class="t">${escapeHtml(l.item.title)}</div><div class="c">${escapeHtml(l.item.category || "")}</div></div>
          <div class="amt">${fmtARS(l.item.price * l.qty)}</div>
        </div>`).join("")}
      <div class="summary-buyer">
        <div><b>${escapeHtml(checkoutData.nombre)}</b> · ${checkoutData.telefono}</div>
        <div>${checkoutData.pago === "efectivo" ? "Efectivo" : "Transferencia"} · ${checkoutData.entrega === "retiro" ? "Retiro en el local" : "Envío a domicilio"}</div>
        ${checkoutData.entrega === "domicilio" ? `<div>${escapeHtml(checkoutData.entreCalles)}, ${escapeHtml(checkoutData.localidad)}, ${escapeHtml(checkoutData.provincia)} (${escapeHtml(checkoutData.cp)})</div>` : ""}
      </div>`;
    foot.innerHTML = `
      <div class="total-row"><span>Total estimado</span><span>${fmtARS(cartTotal())}</span></div>
      <a id="wa-btn" class="wa-btn" href="${waOrderLink()}" target="_blank" rel="noopener">Completar pedido en WhatsApp</a>`;
    $("#wa-btn").onclick = () => {
      trackMeta("Contact", {
        content_ids: lines.map(l => l.item.id), content_type: "product",
        num_items: cartCount(), value: cartTotal(), currency: "ARS"
      });
      setTimeout(() => {
        cart = {};
        saveCart();
        cartStep = "items";
        checkoutData = { nombre: "", pago: "", entrega: "", entreCalles: "", localidad: "", provincia: "", cp: "", telefono: "", dni: "", notas: "" };
        renderCart();
        closeCartDrawer();
        toast("¡Pedido enviado!");
      }, 300);
    };
  }
}

$("#cart-back-btn").onclick = () => {
  cartStep = cartStep === "summary" ? "form" : "items";
  renderCartDrawer();
};

function waOrderLink() {
  const number = (settings.whatsapp || "").replace(/\D/g, "");
  const lines = cartLines();
  if (!number) return "#";
  const d = checkoutData;
  let msg = `Hola! Quiero hacer este pedido de ${settings.brand || "Primera Mano"}:\n\n`;
  lines.forEach(l => { msg += `• ${l.item.title} x${l.qty} — ${fmtARS(l.item.price * l.qty)}\n`; });
  msg += `\nTotal: ${fmtARS(cartTotal())}\n\n`;
  msg += `Nombre: ${d.nombre}\n`;
  msg += `Forma de pago: ${d.pago === "efectivo" ? "Efectivo" : "Transferencia"}\n`;
  msg += `Entrega: ${d.entrega === "retiro" ? "Retiro en el local" : "Envío a domicilio"}\n`;
  if (d.entrega === "domicilio") {
    msg += `Dirección: ${d.entreCalles}, ${d.localidad}, ${d.provincia} (CP ${d.cp})\n`;
  }
  msg += `Teléfono: ${d.telefono}\n`;
  if (d.dni) msg += `DNI: ${d.dni}\n`;
  if (d.notas) msg += `Nota: ${d.notas}\n`;
  msg += `\n¿Está todo disponible?`;
  return `https://wa.me/${number}?text=${encodeURIComponent(msg)}`;
}

// ---------- Product modal (public detail view) ----------
let modalQty = 1;
function openProductModal(id) {
  const p = products[id];
  if (!p) return;
  modalQty = 1;
  trackMeta("ViewContent", {
    content_ids: [p.id], content_type: "product", content_name: p.title,
    content_category: p.category || "", value: p.price, currency: "ARS"
  });
  const imgs = (p.images && p.images.length ? p.images : [p.imgHi || p.img]).filter(Boolean);
  const slider = $("#pmodal-slider");
  slider.scrollLeft = 0;
  slider.innerHTML = imgs.map((u) => `<div class="slide"><img src="${u}" alt=""></div>`).join("");
  const dots = $("#pmodal-dots");
  if (imgs.length > 1) {
    dots.hidden = false;
    dots.innerHTML = imgs.map((_, i) => `<span class="${i === 0 ? "active" : ""}" data-i="${i}"></span>`).join("");
    const dotEls = Array.from(dots.querySelectorAll("span"));
    const slideEls = Array.from(slider.querySelectorAll(".slide"));
    dotEls.forEach((d, i) => {
      d.style.pointerEvents = "auto";
      d.style.cursor = "pointer";
      d.onclick = () => slideEls[i].scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    });
    let scrollTimer = null;
    slider.onscroll = () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const idx = Math.round(slider.scrollLeft / slider.clientWidth);
        dotEls.forEach((d, i) => d.classList.toggle("active", i === idx));
      }, 80);
    };
  } else {
    dots.hidden = true;
    dots.innerHTML = "";
    slider.onscroll = null;
  }
  $("#pmodal-cat").textContent = p.category || "";
  $("#pmodal-title").textContent = p.title || "";
  $("#pmodal-price").textContent = fmtARS(p.price || 0);
  $("#pmodal-desc").textContent = p.description || "";
  $("#pmodal-qty span").textContent = "1";
  $("#pmodal-overlay").classList.add("open");
  $("#pmodal-overlay").dataset.id = id;
}
function closeProductModal() { $("#pmodal-overlay").classList.remove("open"); }

// ================================================================
// AUTH
// ================================================================
function renderAuthSlot() {
  const slot = $("#auth-slot");
  if (!fbUser) {
    // Nadie logueado: única opción es iniciar sesión con Google.
    slot.innerHTML = `<button class="admin-toggle off" id="admin-login-btn" title="Iniciar sesión con Google">🔑 Ingresar</button>`;
    $("#admin-login-btn").onclick = signInAdmin;
    return;
  }
  if (!isAdmin) {
    // Logueado con Google, pero no es el usuario autorizado para editar.
    slot.innerHTML = `<button class="admin-toggle off" id="admin-logout-btn" title="Cerrar sesión">🔒 Salir</button>`;
    $("#admin-logout-btn").onclick = signOutAdmin;
    return;
  }
  slot.innerHTML = `
    <button class="admin-toggle off" id="admin-toggle-btn">✎ <span>Editar catálogo</span></button>
    <button class="admin-toggle off" id="admin-lock-btn" title="Cerrar sesión">🔒</button>`;
  $("#admin-toggle-btn").onclick = openAdminDrawer;
  $("#admin-lock-btn").onclick = signOutAdmin;
}

// Verifica que el token guardado realmente tenga permiso de escritura sobre
// este repositorio puntual (y no cualquier token robado o vencido).
async function verifyGhToken() {
  try {
    const res = await ghRequest("");
    if (!res.ok) return false;
    const j = await res.json();
    return !!(j.permissions && j.permissions.push);
  } catch (e) { return false; }
}

// Se llama solo después de confirmar que el usuario logueado con Google es
// el dueño del catálogo (ADMIN_EMAILS). Si ya hay un token de GitHub
// guardado de antes, lo reutiliza en silencio; si no, lo pide UNA sola vez.
async function ensureGhAccess() {
  if (getGhToken()) {
    const ok = await verifyGhToken();
    if (ok) { isAdmin = true; return; }
    clearGhToken();
  }
  const token = prompt(
    "Pegá tu token de administrador de GitHub (se pide una sola vez en este navegador).\n\n" +
    "Se crea en github.com → Settings → Developer settings → Fine-grained " +
    "tokens, dándole permiso \"Contents: Read and write\" solo sobre el " +
    "repositorio " + GH_OWNER + "/" + GH_REPO + "."
  );
  if (!token) { isAdmin = false; return; }
  setGhToken(token.trim());
  toast("Verificando token...");
  const ok = await verifyGhToken();
  if (ok) {
    isAdmin = true;
    toast("Modo edición activado");
  } else {
    clearGhToken();
    isAdmin = false;
    toast("Ese token no es válido o no tiene permiso de escritura sobre el repositorio", "error");
  }
}

function signInAdmin() {
  signInWithPopup(auth, googleProvider).catch((e) => {
    console.error(e);
    toast("No se pudo iniciar sesión con Google", "error");
  });
}
function signOutAdmin() {
  closeAdminDrawer();
  signOut(auth);
}

// Portón único de acceso: solo tu cuenta de Google (ADMIN_EMAILS) puede
// activar el modo edición. Cualquier otra persona que abra la página, o que
// se loguee con otra cuenta, ve el catálogo normal, sin botón de editar.
renderAuthSlot(); // estado inicial ("Ingresar") mientras Firebase resuelve la sesión
onAuthStateChanged(auth, async (user) => {
  fbUser = user;
  const email = (user && user.email || "").toLowerCase();
  if (user && ADMIN_EMAILS.map(e => e.toLowerCase()).includes(email)) {
    await ensureGhAccess();
  } else {
    isAdmin = false;
  }
  renderAuthSlot();
  renderGrid();
});

// ================================================================
// DATOS
// ================================================================
// Todo — productos y configuración — se lee de archivos estáticos del
// propio repositorio (data/products.json, data/settings.json). Sin base de
// datos externa, sin cuotas: lo único que puede pasar es que GitHub Pages
// tarde uno o dos minutos en reflejar el último commit, como cualquier sitio
// estático normal.
let dataLoaded = false;       // ya se cargaron los productos al menos una vez

async function loadStaticProducts(attempt = 1) {
  try {
    const pRes = await fetch("data/products.json", { cache: "no-store" });
    if (!pRes.ok) throw new Error("bad status " + pRes.status);
    const list = await pRes.json();
    const next = {};
    list.forEach(p => { next[p.id] = p; });
    products = next;
    dataLoaded = true;
    renderCats();
    renderGrid();
    renderCart();
    updateTrustCount();
  } catch (err) {
    console.error("static products load", err);
    if (attempt < 4) {
      setTimeout(() => loadStaticProducts(attempt + 1), attempt * 1200);
    }
  }
}
loadStaticProducts();

// La config del catálogo (logo, portada, nombre, whatsapp, colores) vive en
// data/settings.json, adentro del repo — un archivo estático normal, sin
// ninguna cuota diaria ni base de datos externa de por medio.
async function loadSettings() {
  try {
    const res = await fetch("data/settings.json", { cache: "no-store" });
    if (res.ok) {
      settings = await res.json();
      applyTheme();
      renderCart();
      fillConfigForm();
    }
  } catch (err) {
    console.error("static settings load", err);
  }
}
loadSettings();

// ================================================================
// ADMIN — drawer, tabs
// ================================================================
function openAdminDrawer() {
  $("#admin-overlay").classList.add("open");
  $("#admin-drawer").classList.add("open");
  refreshAdminProductList();
  maybeShowSeedBanner();
}
function closeAdminDrawer() {
  $("#admin-overlay").classList.remove("open");
  $("#admin-drawer").classList.remove("open");
}
$("#admin-close").onclick = closeAdminDrawer;
$("#admin-overlay").onclick = closeAdminDrawer;

$$(".admin-tab").forEach(tab => {
  tab.onclick = () => {
    $$(".admin-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    $("#tab-productos").hidden = tab.dataset.tab !== "productos";
    $("#tab-diseno").hidden = tab.dataset.tab !== "diseno";
  };
});

// ---------- Seed (first run only) ----------
async function maybeShowSeedBanner() {
  if (!isAdmin) return;
  const banner = $("#seed-banner");
  if (Object.keys(products).length > 0) { banner.hidden = true; return; }
  banner.hidden = false;
}
// El catálogo ya viene con productos cargados de entrada, así que este botón
// de importación inicial ya no hace falta (queda oculto — ver maybeShowSeedBanner).
if ($("#seed-btn")) $("#seed-btn").onclick = () => toast("El catálogo ya tiene productos cargados.");
// Ídem: la migración de fotos a Storage era cosa de Firebase, ya no aplica.
if ($("#migrate-images-btn")) { $("#migrate-images-btn").hidden = true; }

// ---------- Admin product list ----------
let adminSearchTerm = "";
$("#admin-search").oninput = (e) => { adminSearchTerm = e.target.value; refreshAdminProductList(); };
function refreshAdminProductList() {
  if (!$("#admin-drawer").classList.contains("open")) return;
  const term = adminSearchTerm.trim().toLowerCase();
  const list = Object.values(products)
    .filter(p => !term || (p.title || "").toLowerCase().includes(term))
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", "es"));
  const wrap = $("#admin-product-list");
  wrap.innerHTML = list.map(p => `
    <div class="admin-product-row" data-id="${p.id}">
      <img src="${p.img}" alt="">
      <div class="apr-info">
        <div class="t">${escapeHtml(p.title)}</div>
        <div class="p">${escapeHtml(p.category || "")} · ${fmtARS(p.price || 0)}</div>
      </div>
      <div class="apr-actions">
        <button data-edit title="Editar">✎</button>
        <button data-del title="Eliminar">🗑</button>
      </div>
    </div>`).join("") || `<p style="color:var(--muted);font-size:.85rem;">Sin productos.</p>`;
  wrap.querySelectorAll("[data-edit]").forEach(btn => {
    btn.onclick = () => openEditProduct(btn.closest(".admin-product-row").dataset.id);
  });
  wrap.querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = () => deleteProduct(btn.closest(".admin-product-row").dataset.id);
  });
}

async function deleteProduct(id) {
  if (!confirm("¿Eliminar este producto del catálogo?")) return;
  try {
    const { sha, data } = await withSaveTimeout(ghGetJsonFile("data/products.json"));
    const list = (data || []).filter(p => p.id !== id);
    await withSaveTimeout(ghPutJsonFile("data/products.json", list, sha, `Eliminar producto ${id}`));
    delete products[id];
    renderCats(); renderGrid(); renderCart(); updateTrustCount(); refreshAdminProductList();
    toast("Producto eliminado y publicado");
  } catch (e) { console.error(e); toast(githubErrorMessage(e), "error"); }
}

// ---------- New / edit product modal ----------
$("#new-product-btn").onclick = () => openEditProduct(null);
function openEditProduct(id) {
  editingProductId = id;
  const p = id ? products[id] : null;
  pendingImages = p ? (p.images && p.images.length ? [...p.images] : (p.img ? [p.img] : [])) : [];
  uploadTargetId = id || ("p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  $("#edit-title").textContent = id ? "Editar producto" : "Nuevo producto";
  $("#p-title").value = p ? p.title : "";
  $("#p-category").value = p ? p.category : "";
  $("#p-price").value = p ? p.price : "";
  $("#p-desc").value = p ? (p.description || "") : "";
  renderPhotoStrip();
  $("#p-delete").hidden = !id;
  $("#edit-overlay").classList.add("open");
}
$("#edit-close").onclick = () => $("#edit-overlay").classList.remove("open");
$("#edit-overlay").addEventListener("click", (e) => { if (e.target.id === "edit-overlay") $("#edit-overlay").classList.remove("open"); });

function renderPhotoStrip() {
  const wrap = $("#photo-strip");
  wrap.innerHTML = pendingImages.map((url, i) => `
    <div class="ph"><img src="${url}"><button type="button" data-rm="${i}">✕</button></div>`).join("");
  wrap.querySelectorAll("[data-rm]").forEach(btn => {
    btn.onclick = () => { pendingImages.splice(parseInt(btn.dataset.rm, 10), 1); renderPhotoStrip(); };
  });
  const drop = $("#drop-product");
  drop.textContent = pendingImages.length >= MAX_PRODUCT_PHOTOS
    ? `Máximo ${MAX_PRODUCT_PHOTOS} fotos`
    : `Click para subir fotos (hasta ${MAX_PRODUCT_PHOTOS}) — ${pendingImages.length}/${MAX_PRODUCT_PHOTOS}`;
}

$("#drop-product").onclick = () => { if (pendingImages.length < MAX_PRODUCT_PHOTOS) $("#file-product").click(); };
$("#file-product").onchange = async (e) => {
  const files = Array.from(e.target.files).slice(0, Math.max(0, MAX_PRODUCT_PHOTOS - pendingImages.length));
  e.target.value = "";
  if (!files.length) return;
  toast("Procesando fotos...");
  for (const file of files) {
    try {
      // Se comprime acá nomás (nada se sube todavía); la subida real al
      // repositorio pasa recién al tocar "Guardar", junto con el resto del producto.
      const dataUrl = await processProductPhoto(file);
      pendingImages.push(dataUrl);
      renderPhotoStrip();
    } catch (err) { console.error(err); toast("Error procesando una foto", "error"); }
  }
  toast("Fotos listas — no te olvides de Guardar");
};

$("#p-save").onclick = async () => {
  const title = $("#p-title").value.trim();
  const category = $("#p-category").value.trim();
  const price = parseFloat($("#p-price").value) || 0;
  const description = $("#p-desc").value.trim();
  if (!title) { toast("Ponele un nombre al producto", "error"); return; }
  if (pendingImages.length === 0) { toast("Subí al menos una foto", "error"); return; }
  const btn = $("#p-save");
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = "Guardando...";
  try {
    const id = editingProductId || uploadTargetId;
    // Sube al repo (como archivo fijo) solo las fotos nuevas — las que ya eran
    // una ruta/URL (producto existente sin cambios de foto) se dejan igual.
    const finalImages = [];
    for (let i = 0; i < pendingImages.length; i++) {
      const img = pendingImages[i];
      if (typeof img === "string" && img.startsWith("data:")) {
        btn.textContent = `Subiendo foto ${i + 1}/${pendingImages.length}...`;
        const path = await withSaveTimeout(
          ghPutBinaryFile(`assets/products/${id}-${i}.jpg`, img, `Foto de producto: ${title}`),
          20000
        );
        finalImages.push(path);
      } else {
        finalImages.push(img);
      }
    }
    btn.textContent = "Guardando...";
    const body = { id, title, category, price, description, images: finalImages, img: finalImages[0], imgHi: finalImages[0] };
    const { sha, data } = await withSaveTimeout(ghGetJsonFile("data/products.json"));
    const list = data || [];
    const idx = list.findIndex(p => p.id === id);
    if (idx >= 0) list[idx] = { ...list[idx], ...body }; else list.push(body);
    await withSaveTimeout(ghPutJsonFile("data/products.json", list, sha, editingProductId ? `Editar producto: ${title}` : `Agregar producto: ${title}`));
    products[id] = body;
    renderCats(); renderGrid(); renderCart(); updateTrustCount(); refreshAdminProductList();
    toast(editingProductId ? "Producto actualizado y publicado" : "Producto agregado y publicado");
    $("#edit-overlay").classList.remove("open");
  } catch (e) {
    console.error(e);
    toast(githubErrorMessage(e), "error");
  } finally {
    btn.disabled = false; btn.textContent = originalLabel;
  }
};
$("#p-delete").onclick = async () => {
  if (!editingProductId) return;
  await deleteProduct(editingProductId);
  $("#edit-overlay").classList.remove("open");
};

// ---------- Config (Diseño y datos) tab ----------
function fillConfigForm() {
  $("#cfg-brand").value = settings.brand || "";
  $("#cfg-desc").value = settings.description || "";
  $("#cfg-whatsapp").value = settings.whatsapp || "";
  const theme = settings.theme || {};
  $("#cfg-color-brand").value = theme.brand || "#1f8a4c";
  $("#cfg-color-brand-hex").textContent = theme.brand || "#1f8a4c";
  $("#cfg-color-bg").value = theme.bg || "#f7f7f5";
  $("#cfg-color-bg-hex").textContent = theme.bg || "#f7f7f5";
  $("#cfg-color-text").value = theme.text || "#17181a";
  $("#cfg-color-text-hex").textContent = theme.text || "#17181a";
  $("#cfg-color-wa").value = theme.wa || "#22c35e";
  $("#cfg-color-wa-hex").textContent = theme.wa || "#22c35e";
  $("#cfg-color-step").value = theme.step || "#FFD700";
  $("#cfg-color-step-hex").textContent = theme.step || "#FFD700";
  if (settings.logo) { $("#preview-logo").src = settings.logo; $("#preview-logo").hidden = false; }
  if (settings.cover) { $("#preview-cover").src = settings.cover; $("#preview-cover").hidden = false; }
}
$("#cfg-color-brand").oninput = (e) => { $("#cfg-color-brand-hex").textContent = e.target.value; };
$("#cfg-color-bg").oninput = (e) => { $("#cfg-color-bg-hex").textContent = e.target.value; };
$("#cfg-color-text").oninput = (e) => { $("#cfg-color-text-hex").textContent = e.target.value; };
$("#cfg-color-wa").oninput = (e) => { $("#cfg-color-wa-hex").textContent = e.target.value; };
$("#cfg-color-step").oninput = (e) => { $("#cfg-color-step-hex").textContent = e.target.value; };

$("#drop-logo").onclick = () => $("#file-logo").click();
$("#file-logo").onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const dataUrl = await fileToDataUrl(file, 300, 0.85);
  pendingLogoImage = dataUrl;
  $("#preview-logo").src = dataUrl; $("#preview-logo").hidden = false;
};
$("#drop-cover").onclick = () => $("#file-cover").click();
$("#file-cover").onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const dataUrl = await fileToDataUrl(file, 1200, 0.8);
  pendingCoverImage = dataUrl;
  $("#preview-cover").src = dataUrl; $("#preview-cover").hidden = false;
};

$("#save-config-btn").onclick = async () => {
  const body = {
    brand: $("#cfg-brand").value.trim() || "Primera Mano",
    description: $("#cfg-desc").value.trim(),
    whatsapp: $("#cfg-whatsapp").value.replace(/\D/g, ""),
    theme: {
      brand: $("#cfg-color-brand").value,
      bg: $("#cfg-color-bg").value,
      text: $("#cfg-color-text").value,
      wa: $("#cfg-color-wa").value,
      step: $("#cfg-color-step").value
    },
    updatedAt: Date.now()
  };
  const btn = $("#save-config-btn");
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = "Guardando...";
  try {
    if (pendingLogoImage) {
      btn.textContent = "Subiendo logo...";
      body.logo = await withSaveTimeout(ghPutBinaryFile("assets/logo.jpg", pendingLogoImage, "Actualizar logo"), 20000);
    }
    if (pendingCoverImage) {
      btn.textContent = "Subiendo portada...";
      body.cover = await withSaveTimeout(ghPutBinaryFile("assets/cover.jpg", pendingCoverImage, "Actualizar portada"), 20000);
    }
    btn.textContent = "Guardando...";
    const { sha, data } = await withSaveTimeout(ghGetJsonFile("data/settings.json"));
    const merged = { ...(data || {}), ...body };
    await withSaveTimeout(ghPutJsonFile("data/settings.json", merged, sha, "Actualizar configuración del catálogo"));
    settings = merged;
    pendingLogoImage = null; pendingCoverImage = null;
    applyTheme();
    renderCart();
    toast("Cambios guardados y publicados — quedan fijos");
  } catch (e) {
    console.error(e);
    toast(githubErrorMessage(e), "error");
  } finally {
    btn.disabled = false; btn.textContent = originalLabel;
  }
};

// ================================================================
// WIRING — search, cart drawer, product modal, cart badge
// ================================================================
let __searchDebounce = null;
let __searchTrackDebounce = null;
$("#search-input").oninput = (e) => {
  const val = e.target.value;
  clearTimeout(__searchDebounce);
  __searchDebounce = setTimeout(() => { searchTerm = val; renderGrid(); }, 180);
  clearTimeout(__searchTrackDebounce);
  __searchTrackDebounce = setTimeout(() => {
    if (val.trim().length >= 3) trackMeta("Search", { search_string: val.trim() });
  }, 900);
};

$("#back-to-home-inner").onclick = () => { searchTerm = ""; $("#search-input").value = ""; goToCategory("__home__"); };

$("#floating-cart-btn").onclick = () => openCartDrawer("items");
$("#cart-close").onclick = closeCartDrawer;
$("#cart-overlay").onclick = closeCartDrawer;

$("#pmodal-close").onclick = closeProductModal;
$("#pmodal-overlay").addEventListener("click", (e) => { if (e.target.id === "pmodal-overlay") closeProductModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeProductModal(); } });
$("#pmodal-qty").querySelectorAll("button").forEach(b => {
  b.onclick = () => {
    modalQty = Math.max(1, modalQty + parseInt(b.dataset.d, 10));
    $("#pmodal-qty span").textContent = modalQty;
  };
});
$("#pmodal-add").onclick = () => {
  const id = $("#pmodal-overlay").dataset.id;
  if (!id) return;
  addToCart(id, modalQty);
  closeProductModal();
  toast("Agregado al pedido");
};

// initial paint (before first snapshot arrives)
renderCart();
