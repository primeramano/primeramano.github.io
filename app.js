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
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, setPersistence, browserLocalPersistence, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, collection, addDoc, doc, updateDoc, setDoc, getDocs, increment, query, orderBy, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAILS } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// En iPhone (Safari y también Chrome, que ahí adentro usa el mismo motor de
// Safari), el login con Google fallaba en silencio: volvía al catálogo pero
// nunca quedabas logueado. La causa es que Safari, por sus protecciones de
// privacidad, a veces no conserva bien el estado pendiente del login que
// Firebase guarda antes de mandarte a Google — pasando a este tipo de
// guardado (localStorage, más resistente en Safari) en vez del que usa por
// defecto, se soluciona.
setPersistence(auth, browserLocalPersistence).catch((e) => console.error("setPersistence", e));
// experimentalAutoDetectLongPolling: en redes con proxy/firewall estrictos
// (bastante común en 4G corporativo, algunos routers, extensiones de
// seguridad) el canal en tiempo real "WebChannel" que usa Firestore por
// defecto falla y reintenta en loop sin parar — eso es lo que colgaba la
// página con "ocurrió un problema" repetido. Con esto, Firestore detecta
// solo si esa conexión no funciona bien y usa long-polling en su lugar,
// sin loops de reconexión.
const db = initializeFirestore(fbApp, { experimentalAutoDetectLongPolling: true, useFetchStreams: false });
const googleProvider = new GoogleAuthProvider();
let fbUser = null;

// Pedidos (orders): lo único que sí vive en Firestore además del login. Cada
// vez que un cliente confirma su pedido en el carrito se crea un documento
// acá — así el pedido queda registrado en el momento, aunque después no
// llegue a mandar el mensaje de WhatsApp. Cualquiera puede CREAR un pedido
// (regla "allow create: if true" en firestore.rules), pero solo el admin
// puede leerlos o cambiarles el estado.
let orders = [];
let ordersFilterEstado = "";
let unsubscribeOrders = null;

const GH_OWNER = "primeramano";
const GH_REPO = "primeramano.github.io";
const GH_BRANCH = "main";

function b64EncodeUnicode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (m, p1) => String.fromCharCode(parseInt(p1, 16))));
}
function b64DecodeUnicode(str) {
  return decodeURIComponent(atob(str).split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""));
}

// Guardar productos/fotos/config = un commit a este repo con la API de
// GitHub. Ya NO se pide ningún token en el navegador: se hace a través de
// una función serverless propia (mismo proyecto de Vercel de Mercado Pago)
// que verifica tu sesión de Google — si tu email está en ADMIN_EMAILS, el
// commit se hace con un token que vive únicamente ahí en el servidor, nunca
// en el celular ni la compu. Con loguearte con Google alcanza, en cualquier
// dispositivo, para siempre.
async function ghRequest(path, opts = {}) {
  if (!fbUser) throw new Error("No hay sesión de Google activa — volvé a iniciar sesión.");
  const idToken = await fbUser.getIdToken();
  const res = await fetch(`${MP_FUNCTION_ENDPOINT}/api/github-proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idToken,
      path,
      method: opts.method || "GET",
      body: opts.body ? JSON.parse(opts.body) : undefined,
    }),
  });
  return res;
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

// ---------- Planilla de resultados (Google Sheets) ----------
// Cuando en el panel "Pedidos" se marca un pedido como "Entregado", se vuelca
// automáticamente a la hoja "Pedidos" de la planilla Primera_Mano_Control vía
// un Google Apps Script publicado como Web App (doPost). No hay backend
// propio en este sitio (todo corre en el navegador), así que la URL del Web
// App queda visible en este archivo — igual que ya pasaba con el endpoint de
// Meta CAPI. El "secret" es solo un freno liviano contra spam casual, no una
// autenticación real; si algún día se detectan filas falsas en la planilla,
// avisar para regenerar el secret y el deploy del Apps Script.
const SHEET_SYNC_ENDPOINT = "https://script.google.com/macros/s/AKfycbxLgrmZ_7YhE2DpR6SEZc_qUpFd7fnk2C6uo3qefB83CSlHMYPSRFv3M8cJfFXlF5_6Bg/exec";
const SHEET_SYNC_SECRET = "715fcbc73369411944260f4c3b57a315";

// ---------- Mercado Pago (Checkout Pro) ----------
// GitHub Pages no tiene backend propio, así que la preferencia de pago se
// crea en una función serverless aparte (Vercel). Reemplazar esta URL por
// la real una vez deployada — ver README de la integración. Mientras diga
// "PENDIENTE_CONFIGURAR", el botón de Mercado Pago avisa que todavía no
// está listo en vez de fallar en silencio.
const MP_FUNCTION_ENDPOINT = "https://mp-checkout-puce.vercel.app";

async function pushOrderToSheet(order) {
  try {
    const res = await fetch(SHEET_SYNC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita el preflight CORS con Apps Script
      body: JSON.stringify({
        secret: SHEET_SYNC_SECRET,
        orderId: order.id,
        cliente: order.nombre || "",
        contacto: order.telefono || "",
        metodoPago: pagoLabel(order.pago),
        entrega: order.entrega === "retiro" ? "Retiro en el lugar (Banfield Centro)" : "Envío a domicilio",
        notas: order.notas || "",
        items: (order.items && order.items.length ? order.items : [{ title: "", qty: "", price: "" }])
          .map(it => ({ producto: it.title, cantidad: it.qty, precioUnit: it.price })),
      }),
    });
    const j = await res.json().catch(() => ({}));
    return !!(j && j.ok);
  } catch (e) {
    console.error("No se pudo volcar el pedido a la planilla de resultados", e);
    return false;
  }
}

function githubErrorMessage(e) {
  const s = ((e && e.message) || "").toLowerCase();
  if (s.includes("401") || s.includes("bad credentials") || s.includes("sesión de google")) {
    return "No se guardó: tu sesión de Google venció. Cerrá sesión y volvé a entrar.";
  }
  if (s.includes("403") || s.includes("rate limit") || s.includes("no autorizado")) {
    return "No se guardó: no autorizado para editar (revisá que este email esté en la lista de administradores), o límite momentáneo de GitHub. Probá de nuevo en un minuto.";
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
let sortMode = "relevancia"; // "relevancia" | "vendidos" | "precio_asc" | "precio_desc"
let topSellerIds = new Set(); // top 3 productos con más ventas confirmadas (badge "Más vendido")
// Acceso admin oculto: el header público no muestra nada de esto. Se activa
// UNA sola vez visitando la página con ?admin=1 (te lo dejamos guardado en
// este navegador para las próximas veces) y desde ahí aparece el botón de
// siempre ("Ingresar" / "Editar catálogo").
const ADMIN_MODE_KEY = "pm_admin_mode_v1";
let showAdminUI = localStorage.getItem(ADMIN_MODE_KEY) === "1";
if (new URLSearchParams(location.search).get("admin") === "1") {
  localStorage.setItem(ADMIN_MODE_KEY, "1");
  showAdminUI = true;
}
let editingProductId = null; // null = new product
const MAX_PRODUCT_PHOTOS = 12;
let pendingImages = [];       // base64 data-URLs, being edited for the current product (up to MAX_PRODUCT_PHOTOS)
let uploadTargetId = null;    // product id used when creating a brand-new product
let pendingLogoImage = null;
let pendingCoverImage = null;

try { cart = JSON.parse(localStorage.getItem("pm_cart_v1") || "{}"); } catch (e) { cart = {}; }

// Identidad anónima persistida en este navegador — así el panel de admin
// puede agrupar "este visitante agregó estos productos" sin pedir ningún
// dato personal. No se manda a ningún lado hasta que el carrito tiene algo.
let cartVisitorId = localStorage.getItem("pm_cart_visitor_v1");
if (!cartVisitorId) {
  cartVisitorId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  try { localStorage.setItem("pm_cart_visitor_v1", cartVisitorId); } catch (e) {}
}

let cartStep = "items"; // "items" | "form" | "summary"
let checkoutData = { nombre: "", pago: "", entrega: "", entreCalles: "", localidad: "", provincia: "", cp: "", telefono: "", dni: "", notas: "" };

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function fmtARS(n) { return "$" + Math.round(n).toLocaleString("es-AR"); }
function pagoLabel(pago) {
  return pago === "efectivo" ? "EFECTIVO/CONTRA-ENTREGA" : pago === "mercadopago" ? "Mercado Pago" : "Transferencia";
}
// Costo de envío fijo por zona (reparto propio CABA+GBA). Con Mercado Pago
// el costo se cobra siempre, sin importar el método de entrega (incluso
// retiro en el lugar). Para efectivo y transferencia, retiro en el lugar
// no tiene costo. Varía según forma de pago porque cada uno tiene distinto
// costo operativo para el negocio.
function shippingCost(pago, entrega) {
  if (pago === "mercadopago") return 8500;
  if (entrega !== "domicilio") return 0;
  if (pago === "efectivo") return 5000;
  if (pago === "transferencia") return 8000;
  return 0;
}
// Etiqueta del cargo de envío/entrega mostrado en el resumen y en WhatsApp.
function envioLabel(pago, entrega) {
  return entrega === "domicilio" ? "Envío a domicilio" : "Cargo Mercado Pago";
}
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
  scheduleCartSync();
}

// Manda el carrito a Firestore (colección "carts") para que el admin pueda
// ver, desde el celular, qué productos quedaron agregados aunque el
// visitante no haya llegado a confirmar el pedido. Debounced para no
// escribir en cada click de +/-, solo cuando el visitante deja de tocar el
// carrito un rato.
let _cartSyncTimer = null;
function scheduleCartSync() {
  clearTimeout(_cartSyncTimer);
  _cartSyncTimer = setTimeout(syncCartToFirestore, 1500);
}
async function syncCartToFirestore() {
  try {
    const ids = Object.keys(cart).filter(id => cart[id] > 0);
    const items = ids.map(id => {
      const p = products[id];
      return { id, title: p ? p.title : "(producto eliminado)", price: p ? p.price : 0, qty: cart[id] };
    });
    const total = items.reduce((s, it) => s + it.price * it.qty, 0);
    if (items.length === 0) {
      // Carrito vaciado (compró o borró todo): no hace falta seguir
      // mostrándolo como "activo" en el panel.
      await setDoc(doc(db, "carts", cartVisitorId), { items: [], total: 0, estado: "vacio", updatedAt: serverTimestamp() }, { merge: true });
      return;
    }
    await setDoc(doc(db, "carts", cartVisitorId), {
      items, total, estado: "activo", updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (e) { console.error("No se pudo sincronizar el carrito", e); }
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
// Versión "prolija" del nombre de categoría para usar en el link: minúsculas,
// sin tildes ni ñ especial, espacios y símbolos como guion. Ej: "Hogar y
// Decoración" -> "hogar-y-decoracion". Así el link queda legible y sin el
// %20 / %C3%B3 feo que deja un nombre con espacios y tildes tal cual.
function slugify(s) {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
// Cada categoría tiene su propio link (?cat=nombre-de-categoria) — se puede
// copiar, compartir por WhatsApp/Instagram/un anuncio, o abrir directo y cae
// justo en esa categoría. Al navegar entre categorías la URL se actualiza
// sola, así lo que ves arriba siempre es el link a donde estás parado.
function categoryUrl(cat) {
  if (!cat || cat === "__home__") return location.pathname;
  return `${location.pathname}?cat=${slugify(cat)}`;
}
function goToCategory(cat, opts = {}) {
  activeCategory = cat;
  renderCats();
  renderGrid();
  if (!opts.skipUrl) history.replaceState(null, "", categoryUrl(cat));
  if (!opts.skipScroll) window.scrollTo({ top: 0, behavior: "smooth" });
}
// ?cat=nombre-de-categoria en la URL abre directo esa categoría — mismo
// mecanismo que ?p=ID para productos puntuales (openProductFromUrl, más abajo).
function openCategoryFromUrl() {
  try {
    const wanted = new URLSearchParams(location.search).get("cat");
    if (!wanted) return;
    const match = categoriesFromProducts().find(c => slugify(c) === wanted.toLowerCase());
    if (match) goToCategory(match, { skipUrl: true, skipScroll: true });
  } catch (e) {}
}
// Crea un <a> real (con href copiable/compartible) para navegar a una
// categoría, en vez de un <button> sin URL — así cada categoría tiene su
// propio link dentro de la página.
function catLink(cat, label) {
  const a = document.createElement("a");
  a.className = "cat-chip" + (activeCategory === cat ? " active" : "");
  a.textContent = label;
  a.href = categoryUrl(cat);
  a.onclick = (e) => { e.preventDefault(); goToCategory(cat); };
  return a;
}
function renderCats() {
  const cats = categoriesFromProducts();
  const wrap = $("#cats");
  wrap.innerHTML = "";
  wrap.appendChild(catLink("__home__", "Inicio"));
  wrap.appendChild(catLink("__all__", "Todos"));
  cats.forEach(c => wrap.appendChild(catLink(c, c)));
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
  const list = Object.values(products).filter(p => {
    if (activeCategory !== "__all__" && activeCategory !== "__home__" && p.category !== activeCategory) return false;
    if (term && !(p.title || "").toLowerCase().includes(term)) return false;
    return true;
  });
  if (sortMode === "vendidos") list.sort((a, b) => (b.ventas || 0) - (a.ventas || 0));
  else if (sortMode === "precio_asc") list.sort((a, b) => (a.price || 0) - (b.price || 0));
  else if (sortMode === "precio_desc") list.sort((a, b) => (b.price || 0) - (a.price || 0));
  return list;
}
// Recalcula qué productos son "Más vendido" (top 3, con al menos 1 venta
// confirmada) para mostrarles el badge en la tarjeta — prueba social simple.
function recomputeTopSellers() {
  const ranked = Object.values(products)
    .filter(p => (p.ventas || 0) > 0)
    .sort((a, b) => (b.ventas || 0) - (a.ventas || 0))
    .slice(0, 3);
  topSellerIds = new Set(ranked.map(p => p.id));
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
        ${topSellerIds.has(p.id) ? `<span class="bestseller-badge">🔥 Más vendido</span>` : ""}
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
    const addBtn = card.querySelector("[data-add]");
    const original = addBtn.textContent;
    addBtn.textContent = "✓ Agregado";
    addBtn.classList.add("just-added");
    setTimeout(() => { addBtn.textContent = original; addBtn.classList.remove("just-added"); }, 900);
    const fc = $("#floating-cart");
    fc.classList.remove("fc-pulse");
    void fc.offsetWidth; // reinicia la animación aunque se clickee seguido
    fc.classList.add("fc-pulse");
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
    $("#grid-toolbar").hidden = true;
    backBtn.hidden = true;
    homeEl.hidden = false;
    renderHomeSections();
    return;
  }

  homeEl.hidden = true;
  grid.hidden = false;
  $("#grid-toolbar").hidden = false;
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
        <h2><a class="cat-title-link" href="${escapeAttr(categoryUrl(s.cat))}" data-cat="${escapeAttr(s.cat)}">${escapeHtml(s.cat)}</a></h2>
        <div class="home-section-actions">
          <span class="count">${s.items.length} ${s.items.length === 1 ? "producto" : "productos"}</span>
          ${s.items.length > s.preview.length ? `<a class="ver-todos-btn" href="${escapeAttr(categoryUrl(s.cat))}" data-cat="${escapeAttr(s.cat)}">Ver todos →</a>` : ""}
        </div>
      </div>
      <div class="home-row">${s.preview.map((p, idx) => cardHTML(p, sIdx === 0 && idx < 6)).join("")}</div>
    </section>`).join("");
  homeEl.querySelectorAll(".card").forEach(wireCard);
  homeEl.querySelectorAll(".ver-todos-btn, .cat-title-link").forEach(link => {
    link.onclick = (e) => { e.preventDefault(); goToCategory(link.dataset.cat); };
  });
}

// ---------- Cart ----------
// Pedido mínimo: por debajo de este monto no se puede avanzar a confirmar
// el pedido — el carrito avisa cuánto falta para llegarlo.
const MIN_ORDER = 40000;
function minOrderMissing() { return Math.max(0, MIN_ORDER - cartTotal()); }
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
  const fcMinNote = $("#fc-min-note");
  if (fcMinNote) {
    const missing = minOrderMissing();
    if (count > 0 && missing > 0) {
      fcMinNote.hidden = false;
      fcMinNote.textContent = `Faltan ${fmtARS(missing)} para el pedido mínimo`;
    } else {
      fcMinNote.hidden = true;
    }
  }

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
    const missing = minOrderMissing();
    const belowMin = lines.length > 0 && missing > 0;
    foot.innerHTML = `
      ${belowMin ? `<div class="min-order-note">Te faltan <strong>${fmtARS(missing)}</strong> para llegar al pedido mínimo de ${fmtARS(MIN_ORDER)}</div>` : ""}
      <div class="total-row"><span>Total</span><span>${fmtARS(cartTotal())}</span></div>
      <button class="wa-btn" id="cart-continue-btn" ${(lines.length === 0 || belowMin) ? "disabled" : ""}>Continuar</button>`;
    $("#cart-continue-btn").onclick = () => {
      if (cartLines().length === 0 || minOrderMissing() > 0) return;
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
          <label class="radio-opt"><input type="radio" name="co-pago" value="efectivo" ${d.pago === "efectivo" ? "checked" : ""}> EFECTIVO/CONTRA-ENTREGA<span class="hint">Según zona: CABA y GBA (zona Banfield y alrededores). Se coordina por WhatsApp</span></label>
          <label class="radio-opt"><input type="radio" name="co-pago" value="transferencia" ${d.pago === "transferencia" ? "checked" : ""}> Transferencia<span class="hint">Te compartimos los datos al confirmar el pedido</span></label>
          <label class="radio-opt"><input type="radio" name="co-pago" value="mercadopago" ${d.pago === "mercadopago" ? "checked" : ""}> Mercado Pago<span class="hint">Pagás online con tarjeta, débito o efectivo (Rapipago/Pago Fácil)</span></label>
        </div>
      </div>
      <div class="field">
        <label>Método de entrega *</label>
        <div class="radio-group">
          <label class="radio-opt"><input type="radio" name="co-entrega" value="retiro" ${d.entrega === "retiro" ? "checked" : ""}> Retiro en el lugar (Banfield Centro)<span class="hint">Sin costo</span></label>
          <label class="radio-opt"><input type="radio" name="co-entrega" value="domicilio" ${d.entrega === "domicilio" ? "checked" : ""}> Envío a domicilio<span class="hint">Costo fijo según forma de pago, se suma al total</span></label>
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
    const envio = shippingCost(checkoutData.pago, checkoutData.entrega);
    const grandTotal = cartTotal() + envio;
    body.innerHTML = `
      <div class="summary-status"><span>Estado del pago</span><span class="pill warn">Pendiente</span></div>
      ${lines.map(l => `
        <div class="summary-line">
          <span class="qty">${l.qty}</span>
          <div class="info"><div class="t">${escapeHtml(l.item.title)}</div><div class="c">${escapeHtml(l.item.category || "")}</div></div>
          <div class="amt">${fmtARS(l.item.price * l.qty)}</div>
        </div>`).join("")}
      ${envio > 0 ? `
        <div class="summary-line">
          <span class="qty">1</span>
          <div class="info"><div class="t">${envioLabel(checkoutData.pago, checkoutData.entrega)}</div></div>
          <div class="amt">${fmtARS(envio)}</div>
        </div>` : ""}
      <div class="summary-buyer">
        <div><b>${escapeHtml(checkoutData.nombre)}</b> · ${checkoutData.telefono}</div>
        <div>${pagoLabel(checkoutData.pago)} · ${checkoutData.entrega === "retiro" ? `Retiro en el lugar (Banfield Centro)${envio > 0 ? "" : " · Sin costo"}` : "Envío a domicilio"}</div>
        ${checkoutData.entrega === "domicilio" ? `<div>${escapeHtml(checkoutData.entreCalles)}, ${escapeHtml(checkoutData.localidad)}, ${escapeHtml(checkoutData.provincia)} (${escapeHtml(checkoutData.cp)})</div>` : ""}
      </div>
      ${checkoutData.pago === "transferencia" && settings.transferMessage ? `
      <div class="transfer-box">
        <div class="transfer-box-title">Datos para transferir</div>
        <div class="transfer-box-text">${escapeHtml(settings.transferMessage).replace(/\n/g, "<br>")}</div>
        <button type="button" class="transfer-copy-btn" id="transfer-copy-btn">Copiar datos</button>
      </div>` : ""}`;
    const isMP = checkoutData.pago === "mercadopago";
    foot.innerHTML = `
      <div class="total-row"><span>Total estimado</span><span>${fmtARS(grandTotal)}</span></div>
      ${isMP
        ? `<button type="button" id="mp-btn" class="wa-btn">Pagar con Mercado Pago 💳</button>`
        : `<a id="wa-btn" class="wa-btn" href="${waOrderLink()}" target="_blank" rel="noopener">${checkoutData.pago === "transferencia" ? "PAGO SEGURO 🔒" : "Completar pedido en WhatsApp"}</a>`}`;
    if ($("#transfer-copy-btn")) {
      $("#transfer-copy-btn").onclick = () => {
        navigator.clipboard.writeText(settings.transferMessage)
          .then(() => toast("Datos copiados"))
          .catch(() => toast("No se pudo copiar", "error"));
      };
    }

    // trackMeta("Purchase", ...) se dispara acá (al confirmar el pedido) y no
    // recién cuando se marca "Entregado" en el panel, porque ese paso lo hace
    // el admin desde su propio navegador — atribuírselo ahí ensuciaría el
    // matching del pixel con los datos del cliente real.
    function trackPurchase() {
      trackMeta("Purchase", {
        content_ids: lines.map(l => l.item.id), content_type: "product",
        num_items: cartCount(), value: grandTotal, currency: "ARS"
      });
    }
    function resetCartAndClose(msg) {
      setTimeout(() => {
        cart = {};
        saveCart();
        cartStep = "items";
        checkoutData = { nombre: "", pago: "", entrega: "", entreCalles: "", localidad: "", provincia: "", cp: "", telefono: "", dni: "", notas: "" };
        renderCart();
        closeCartDrawer();
        toast(msg);
      }, 300);
    }

    if (isMP) {
      $("#mp-btn").onclick = async () => {
        if (MP_FUNCTION_ENDPOINT === "PENDIENTE_CONFIGURAR") {
          toast("El pago con Mercado Pago todavía no está activado en el sitio", "error");
          return;
        }
        const btn = $("#mp-btn");
        btn.disabled = true;
        btn.textContent = "Generando pago...";
        // El pedido queda registrado ANTES de ir a Mercado Pago (estado
        // "pendiente de pago") — así, aunque el cliente abandone el pago,
        // el panel ya tiene el registro del intento.
        const orderId = await submitOrder(lines, { ...checkoutData }, grandTotal, envio);
        try {
          const mpItems = lines.map(l => ({ id: l.item.id, title: l.item.title, price: l.item.price, qty: l.qty }));
          if (envio > 0) mpItems.push({ id: "envio", title: "Envío a domicilio", price: envio, qty: 1 });
          const res = await fetch(`${MP_FUNCTION_ENDPOINT}/api/create-preference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId,
              items: mpItems,
              buyer: { nombre: checkoutData.nombre, telefono: checkoutData.telefono },
            }),
          });
          const j = await res.json();
          if (!res.ok || !j.init_point) throw new Error(j.error || "sin init_point");
          trackPurchase();
          location.href = j.init_point; // redirige al Checkout Pro de Mercado Pago
        } catch (e) {
          console.error("mercado pago create-preference", e);
          toast("No se pudo iniciar el pago con Mercado Pago. Probá de nuevo.", "error");
          btn.disabled = false;
          btn.textContent = "Pagar con Mercado Pago 💳";
        }
      };
    } else {
      $("#wa-btn").onclick = () => {
        // El pedido queda registrado en el panel apenas el cliente confirma acá,
        // independientemente de que después llegue o no a mandar el WhatsApp.
        submitOrder(lines, { ...checkoutData }, grandTotal, envio);
        trackMeta("Contact", {
          content_ids: lines.map(l => l.item.id), content_type: "product",
          num_items: cartCount(), value: grandTotal, currency: "ARS"
        });
        trackPurchase();
        resetCartAndClose("¡Pedido enviado!");
      };
    }
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
  const envio = shippingCost(d.pago, d.entrega);
  let msg = `Hola! Quiero hacer este pedido de ${settings.brand || "Primera Mano"}:\n\n`;
  lines.forEach(l => { msg += `• ${l.item.title} x${l.qty} — ${fmtARS(l.item.price * l.qty)}\n`; });
  if (envio > 0) msg += `• Envío a domicilio — ${fmtARS(envio)}\n`;
  msg += `\nTotal: ${fmtARS(cartTotal() + envio)}\n\n`;
  msg += `Nombre: ${d.nombre}\n`;
  msg += `Forma de pago: ${pagoLabel(d.pago)}\n`;
  msg += `Entrega: ${d.entrega === "retiro" ? "Retiro en el lugar (Banfield Centro)" : "Envío a domicilio"}\n`;
  if (d.entrega === "domicilio") {
    msg += `Dirección: ${d.entreCalles}, ${d.localidad}, ${d.provincia} (CP ${d.cp})\n`;
  }
  msg += `Teléfono: ${d.telefono}\n`;
  if (d.dni) msg += `DNI: ${d.dni}\n`;
  if (d.notas) msg += `Nota: ${d.notas}\n`;
  if (d.pago === "transferencia" && settings.transferMessage) {
    msg += `\nDatos para transferir:\n${settings.transferMessage}\n`;
  }
  msg += `\n¿Está todo disponible?`;
  return `https://wa.me/${number}?text=${encodeURIComponent(msg)}`;
}

// ---------- Pedidos (orders) ----------
// Se llama al confirmar el pedido en el carrito (botón final). Guarda el
// pedido en Firestore ANTES/EN PARALELO a abrir WhatsApp, para que quede
// registrado aunque el cliente no llegue a apretar "enviar" en WhatsApp.
// Si por lo que sea falla (sin internet, etc.) no bloquea ni rompe el envío
// del pedido por WhatsApp — solo se pierde el registro interno de ese pedido.
async function submitOrder(lines, d, total, envio) {
  try {
    const ref = await addDoc(collection(db, "orders"), {
      items: lines.map(l => ({ id: l.item.id, title: l.item.title, price: l.item.price, qty: l.qty })),
      total,
      envio: envio || 0,
      nombre: d.nombre,
      telefono: d.telefono,
      dni: d.dni || "",
      pago: d.pago,
      entrega: d.entrega,
      entreCalles: d.entreCalles || "",
      localidad: d.localidad || "",
      provincia: d.provincia || "",
      cp: d.cp || "",
      notas: d.notas || "",
      estado: "nuevo",
      // Con Mercado Pago el pedido arranca "pendiente de pago" — el webhook
      // de la función serverless confirma cuando el pago queda aprobado.
      ...(d.pago === "mercadopago" ? { pagoEstado: "pendiente" } : {}),
      createdAt: serverTimestamp(),
    });
    // Marca el carrito de este visitante como convertido — así en el panel
    // de "Carritos" no aparece como abandonado un carrito que sí terminó en
    // pedido.
    setDoc(doc(db, "carts", cartVisitorId), { estado: "convertido", orderId: ref.id, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
    return ref.id;
  } catch (e) {
    console.error("No se pudo registrar el pedido en el panel", e);
    return null;
  }
}

function startOrdersListener() {
  if (unsubscribeOrders) return; // ya está escuchando
  try {
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    unsubscribeOrders = onSnapshot(q, (snap) => {
      orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAdminOrders();
    }, (err) => console.error("orders listener", err));
  } catch (e) { console.error(e); }
}
function stopOrdersListener() {
  if (unsubscribeOrders) { unsubscribeOrders(); unsubscribeOrders = null; }
  orders = [];
}

// ---------- Carritos (admin) ----------
let carts = [];
let cartsFilterEstado = "";
let unsubscribeCarts = null;
function startCartsListener() {
  if (unsubscribeCarts) return;
  try {
    const q = query(collection(db, "carts"), orderBy("updatedAt", "desc"));
    unsubscribeCarts = onSnapshot(q, (snap) => {
      carts = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => (c.items || []).length > 0);
      renderAdminCarts();
    }, (err) => console.error("carts listener", err));
  } catch (e) { console.error(e); }
}
function stopCartsListener() {
  if (unsubscribeCarts) { unsubscribeCarts(); unsubscribeCarts = null; }
  carts = [];
}
function fmtCartDate(ts) {
  try {
    if (!ts || !ts.toDate) return "";
    return ts.toDate().toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (e) { return ""; }
}
function renderAdminCarts() {
  const wrap = $("#admin-carts-list");
  const empty = $("#carts-empty");
  if (!wrap) return;
  const list = cartsFilterEstado ? carts.filter(c => (c.estado || "activo") === cartsFilterEstado) : carts.filter(c => c.estado !== "vacio");
  empty.hidden = list.length > 0;
  wrap.innerHTML = list.map(c => {
    const items = (c.items || []).map(it => `${it.qty} x ${escapeHtml(it.title)}`).join("<br>");
    const estadoLabel = c.estado === "convertido" ? "✔ Convertido en pedido" : "🛒 Activo (sin comprar)";
    const estadoClass = c.estado === "convertido" ? "aor-total" : "aor-date";
    return `
      <div class="admin-order-row" data-id="${c.id}">
        <div class="aor-head">
          <b>Visitante ${escapeHtml(c.id.slice(0, 8))}</b>
          <span class="${estadoClass}">${fmtCartDate(c.updatedAt)}</span>
        </div>
        <div class="aor-items">${items}</div>
        <div class="aor-foot">
          <span class="aor-total">${fmtARS(c.total || 0)}</span>
          <span style="font-size:.8rem;color:var(--muted);">${estadoLabel}</span>
        </div>
      </div>`;
  }).join("");
}

const ESTADO_LABELS = { nuevo: "Nuevo", en_proceso: "En proceso", entregado: "Entregado", cancelado: "Cancelado" };
function fmtOrderDate(ts) {
  try {
    if (!ts || !ts.toDate) return "";
    return ts.toDate().toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (e) { return ""; }
}
function renderAdminOrders() {
  const wrap = $("#admin-orders-list");
  const empty = $("#orders-empty");
  if (!wrap) return;
  const list = ordersFilterEstado ? orders.filter(o => (o.estado || "nuevo") === ordersFilterEstado) : orders;
  empty.hidden = list.length > 0;
  wrap.innerHTML = list.map(o => {
    const items = (o.items || []).map(it => `${it.qty} x ${escapeHtml(it.title)}`).join("<br>");
    const dirLinea = o.entrega === "domicilio"
      ? `${escapeHtml(o.entreCalles || "")}, ${escapeHtml(o.localidad || "")}, ${escapeHtml(o.provincia || "")} (${escapeHtml(o.cp || "")})`
      : "Retiro en el lugar (Banfield Centro)";
    const waNum = (o.telefono || "").replace(/\D/g, "");
    return `
      <div class="admin-order-row" data-id="${o.id}">
        <div class="aor-head">
          <b>${escapeHtml(o.nombre || "Sin nombre")}</b>
          <span class="aor-date">${fmtOrderDate(o.createdAt)}</span>
        </div>
        <div class="aor-items">${items}</div>
        <div class="aor-meta">
          ${pagoLabel(o.pago)} · ${dirLinea}${o.envio ? ` · Envío: ${fmtARS(o.envio)}` : ""}
          ${waNum ? ` · <a href="https://wa.me/${waNum}" target="_blank" rel="noopener">${escapeHtml(o.telefono)}</a>` : ""}
        </div>
        <div class="aor-foot">
          <span class="aor-total">${fmtARS(o.total || 0)}</span>
          <select class="order-status-select" data-id="${o.id}">
            ${Object.entries(ESTADO_LABELS).map(([v, label]) => `<option value="${v}" ${(o.estado || "nuevo") === v ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>
      </div>`;
  }).join("");
  wrap.querySelectorAll(".order-status-select").forEach(sel => {
    sel.onchange = async () => {
      const newEstado = sel.value;
      const order = orders.find(o => o.id === sel.dataset.id);
      try {
        await updateDoc(doc(db, "orders", sel.dataset.id), { estado: newEstado });
        toast("Estado actualizado");
      } catch (e) { console.error(e); toast("No se pudo actualizar el estado", "error"); return; }
      // Al marcar "Entregado" se vuelca a la planilla de resultados — una sola
      // vez por pedido (sheetSynced evita duplicar la fila si después se
      // cambia el estado y se vuelve a poner "Entregado").
      if (newEstado === "entregado" && order && !order.sheetSynced) {
        const ok = await pushOrderToSheet(order);
        if (ok) {
          updateDoc(doc(db, "orders", sel.dataset.id), { sheetSynced: true }).catch(() => {});
          toast("Pedido volcado a la planilla de resultados");
        } else {
          toast("El pedido se marcó Entregado pero no se pudo volcar a la planilla — reintentá cambiando el estado", "error");
        }
      }
      // Suma las unidades del pedido al contador de "más vendidos" — una sola
      // vez por pedido (mismo patrón que sheetSynced, con ventasSynced).
      if (newEstado === "entregado" && order && !order.ventasSynced) {
        await registrarVentasDePedido(order);
        updateDoc(doc(db, "orders", sel.dataset.id), { ventasSynced: true }).catch(() => {});
      }
    };
  });
  renderBestsellers();
}
function renderBestsellers() {
  const box = $("#bestsellers-summary");
  if (!box) return;
  const ranked = Object.values(products)
    .filter(p => (p.ventas || 0) > 0)
    .sort((a, b) => (b.ventas || 0) - (a.ventas || 0))
    .slice(0, 5);
  if (ranked.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="bestsellers-title">🏆 Más vendidos (unidades entregadas)</div>
    <div class="bestsellers-list">
      ${ranked.map((p, i) => `
        <div class="bestsellers-row">
          <span class="bs-rank">${i + 1}</span>
          <span class="bs-title">${escapeHtml(p.title || "")}</span>
          <span class="bs-count">${p.ventas} un.</span>
        </div>`).join("")}
    </div>`;
}
if ($("#orders-filter-estado")) {
  $("#orders-filter-estado").onchange = (e) => { ordersFilterEstado = e.target.value; renderAdminOrders(); };
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
  if (!showAdminUI) {
    // Header público: nadie ve login ni candado. Se activa con ?admin=1.
    slot.innerHTML = "";
    return;
  }
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

// En celulares, signInWithPopup casi siempre falla (el navegador móvil
// bloquea o no soporta bien el popup) — por eso en mobile se usa
// signInWithRedirect, que manda a la página de Google y vuelve acá
// solo. El resultado de esa vuelta se procesa en getRedirectResult()
// más abajo. En compu se sigue usando el popup, que es más cómodo.
const isMobileBrowser = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

async function signInAdmin() {
  if (isMobileBrowser) {
    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch (e) { console.error("setPersistence", e); }
    signInWithRedirect(auth, googleProvider).catch((e) => {
      console.error(e);
      toast("No se pudo iniciar sesión con Google", "error");
    });
    return;
  }
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
// Al volver de Google (flujo signInWithRedirect en mobile), Firebase procesa
// la sesión automáticamente vía onAuthStateChanged de abajo — esto solo
// atrapa el error, si lo hay, para poder avisar en vez de fallar en silencio.
getRedirectResult(auth).catch((e) => {
  console.error("getRedirectResult", e);
  toast("No se pudo iniciar sesión con Google", "error");
});
onAuthStateChanged(auth, async (user) => {
  fbUser = user;
  if (!showAdminUI) {
    // Header público: ni siquiera se chequea si sos admin, así nunca aparece
    // un prompt de token de golpe navegando como cliente normal. Solo se
    // evalúa esto cuando entraste una vez por ?admin=1.
    isAdmin = false;
    renderAuthSlot();
    return;
  }
  const email = (user && user.email || "").toLowerCase();
  isAdmin = !!(user && ADMIN_EMAILS.map(e => e.toLowerCase()).includes(email));
  if (isAdmin) startOrdersListener(); else stopOrdersListener();
  if (!isAdmin) stopCartsListener();
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
    const pRes = await fetch("data/products.json?v=" + Date.now(), { cache: "no-store" });
    if (!pRes.ok) throw new Error("bad status " + pRes.status);
    const list = await pRes.json();
    const next = {};
    list.forEach(p => { next[p.id] = p; });
    products = next;
    dataLoaded = true;
    openCategoryFromUrl(); // ?cat=Nombre en la URL: abre directo esa categoría
    renderCats();
    renderGrid();
    renderCart();
    updateTrustCount();
    openProductFromUrl();
    loadSalesStats();
  } catch (err) {
    console.error("static products load", err);
    if (attempt < 4) {
      setTimeout(() => loadStaticProducts(attempt + 1), attempt * 1200);
    }
  }
}
loadStaticProducts();

// Deep-link a un producto puntual: ?p=ID en la URL abre directo su modal.
// Necesario para que el feed de productos de Meta Commerce Manager pueda
// linkear a cada producto puntual (Meta exige un "link" funcional por item
// para catálogo dinámico / retargeting de productos vistos).
function openProductFromUrl() {
  try {
    const id = new URLSearchParams(location.search).get("p");
    if (id && products[id]) openProductModal(id);
  } catch (e) {}
}

// ================================================================
// ESTADÍSTICAS DE VENTAS (más vendidos)
// ================================================================
// Cada producto "vendido" (pedido marcado Entregado por el admin) suma sus
// unidades acá — un doc por producto en Firestore, colección "products"
// (lectura pública, escritura solo admin, ya habilitado en firestore.rules).
// Es independiente de data/products.json: no toca GitHub, no genera commits,
// se actualiza al instante. Sirve para el filtro "Más vendidos" y el badge
// 🔥 en la tarjeta.
async function loadSalesStats() {
  try {
    const snap = await getDocs(collection(db, "products"));
    snap.forEach(d => {
      const v = d.data();
      if (products[d.id]) products[d.id].ventas = v.ventas || 0;
    });
    recomputeTopSellers();
    renderGrid();
    renderHomeSections();
  } catch (e) {
    console.error("No se pudieron cargar las estadísticas de ventas", e);
  }
}

// Se llama una vez por pedido, al marcarlo Entregado (ver renderAdminOrders).
// Suma las unidades de cada item al contador de ventas de ese producto.
async function registrarVentasDePedido(order) {
  const items = order.items || [];
  for (const it of items) {
    if (!it.id || !it.qty) continue;
    try {
      await setDoc(doc(db, "products", it.id), { ventas: increment(it.qty) }, { merge: true });
      if (products[it.id]) products[it.id].ventas = (products[it.id].ventas || 0) + it.qty;
    } catch (e) {
      console.error("No se pudo sumar la venta de " + it.id, e);
    }
  }
  recomputeTopSellers();
  renderGrid();
  renderHomeSections();
  renderBestsellers();
}

// La config del catálogo (logo, portada, nombre, whatsapp, colores) vive en
// data/settings.json, adentro del repo — un archivo estático normal, sin
// ninguna cuota diaria ni base de datos externa de por medio.
async function loadSettings() {
  try {
    const res = await fetch("data/settings.json?v=" + Date.now(), { cache: "no-store" });
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
    $("#tab-pedidos").hidden = tab.dataset.tab !== "pedidos";
    $("#tab-carritos").hidden = tab.dataset.tab !== "carritos";
    $("#tab-diseno").hidden = tab.dataset.tab !== "diseno";
    if (tab.dataset.tab === "pedidos") renderAdminOrders();
    if (tab.dataset.tab === "carritos") { startCartsListener(); renderAdminCarts(); }
  };
});

$("#carts-filter-estado") && ($("#carts-filter-estado").onchange = (e) => {
  cartsFilterEstado = e.target.value;
  renderAdminCarts();
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
  $("#cfg-transfer-msg").value = settings.transferMessage || "";
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
    transferMessage: $("#cfg-transfer-msg").value.trim(),
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

$("#sort-select").onchange = (e) => { sortMode = e.target.value; renderGrid(); };

// La fila de categorías queda pegada justo debajo del header — se mide su
// alto real (cambia entre mobile/desktop) y se lo pasa como variable CSS.
function syncTopbarHeight() {
  const h = document.querySelector(".topbar");
  if (h) document.documentElement.style.setProperty("--topbar-h", h.getBoundingClientRect().height + "px");
}
syncTopbarHeight();
window.addEventListener("resize", syncTopbarHeight);
window.addEventListener("load", syncTopbarHeight);

// Botón "volver arriba" — aparece después de scrollear, útil con +500
// productos en la grilla.
const backToTopBtn = $("#back-to-top");
if (backToTopBtn) {
  let __btVisible = false;
  window.addEventListener("scroll", () => {
    const show = window.scrollY > 700;
    if (show !== __btVisible) { __btVisible = show; backToTopBtn.hidden = !show; }
  }, { passive: true });
  backToTopBtn.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
}

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
