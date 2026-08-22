const STORAGE_KEYS = {
  JWT_TOKEN: "go_jwt_token_v2",
  SESSION: "go_session_v2",
  ULTIMO_ERROR: "go_ultimo_error_sync_v2",
};

const ULTIMOS_ERRORES_FETCH = []; // array de últimos errores para diagnóstico móvil (max 15)

const DEFAULT_ADMIN_PIN = "1234";
const HORAS_BASE_AL_DIA = 8;
(function(){
  const p = window.location.pathname.replace(/[^/]*$/, "");
  window.__BASE_PATH__ = (p === "/" || p === "") ? "" : p.replace(/\/$/, "");
})();
const API_BASE = window.location.origin.startsWith("http")
  ? window.__BASE_PATH__
  : "http://localhost:8082";

const CATEGORIAS_MOV = {
  facturacion: { label: "Facturación Cliente", tipo: "ingreso" },
  anticipo: { label: "Anticipo Cliente", tipo: "ingreso" },
  subvencion: { label: "Subvención / Ayuda", tipo: "ingreso" },
  otro_ingreso: { label: "Otro Ingreso", tipo: "ingreso" },
  materiales: { label: "Materiales", tipo: "gasto" },
  proveedores: { label: "Proveedores / Subcontratas", tipo: "gasto" },
  transporte: { label: "Transporte / Desplazamiento", tipo: "gasto" },
  alquiler: { label: "Alquiler Maquinaria", tipo: "gasto" },
  seguros: { label: "Seguros", tipo: "gasto" },
  impuestos: { label: "Impuestos / Tasas", tipo: "gasto" },
  oficina: { label: "Gastos de Oficina", tipo: "gasto" },
  nomina_general: { label: "Nómina / Sueldos", tipo: "gasto" },
  otro_gasto: { label: "Otro Gasto", tipo: "gasto" },
};

const ESTADOS_OBRA = {
  pendiente: { label: "📝 Pendiente", clase: "estado-pendiente" },
  curso: { label: "🔨 En Curso", clase: "estado-curso" },
  finalizada: { label: "✅ Finalizada", clase: "estado-finalizada" },
  cancelada: { label: "❌ Cancelada", clase: "estado-cancelada" },
};

const state = {
  trabajadores: [],
  obras: [],
  horas: [],
  movimientos: [],
  session: { role: null, trabajadorId: null },
  adminPin: DEFAULT_ADMIN_PIN,
  quickSelectedHours: null,
  filtros: {
    buscarTrabajador: "",
    buscarObra: "",
    filtroEstadoObra: "todos",
    trabajadoresDesde: null,
    trabajadoresHasta: null,
    horas: { desde: null, hasta: null, trabajador: "todos", obra: "todas" },
    mov: { desde: null, hasta: null, tipo: "todos", obra: "todas" },
    cajas: { desde: null, hasta: null, selectedTrabajadorId: null },
  },
  cajasData: null, // cache del último resultado GET /api/cajas
};

const els = {};

const IS_MOBILE = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop|Mobile|webOS|BlackBerry|Touch/i.test(navigator.userAgent || "") || (navigator.maxTouchPoints || 0) > 1 || (window.screen ? Math.min(window.screen.width||0, window.screen.height||0) < 820 : false);

/* ============ LOCKS / DEBOUNCE (evitar races y refrescos agresivos) ============ */
let _loadLock = null;       // Promise en curso de loadAllData (para no solapar)
let _lastLoadedAt = 0;      // timestamp último fetch exitoso
const _MIN_MS_BETWEEN_LOADS = IS_MOBILE ? 2200 : 4000;   // móvil 2.2s mínimo entre refrescos, PC 4s
const _TAB_REFRESH_COOLDOWN = IS_MOBILE ? 3000 : 6000;   // refresco pestaña más rápido en móvil
let _lastTabRefreshAt = 0;

/* ============ UTILIDADES ============ */
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getToken() { return localStorage.getItem(STORAGE_KEYS.JWT_TOKEN) || null; }
function setToken(t) { if (t) localStorage.setItem(STORAGE_KEYS.JWT_TOKEN, t); else localStorage.removeItem(STORAGE_KEYS.JWT_TOKEN); }

async function api(endpoint, options = {}) {
  const url = (endpoint.startsWith("http") ? "" : API_BASE) + endpoint;
  const headers = {
    "Accept": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const tok = getToken();
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const u = new URL(url, window.location.origin);
  // Anti caché móvil definitiva: parámetro aleatorio único por petición
  u.searchParams.set("_t", `${Date.now()}_${Math.random().toString(36).slice(2,9)}`);
  let res;
  try {
    res = await fetch(u.toString(), {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer-when-downgrade",
    });
  } catch (e) {
    throw new Error("Error de red: comprueba que tengas Internet/WiFi y que el servidor esté arrancado.");
  }
  const isJson = (res.headers.get("Content-Type") || "").includes("application/json");
  let data = null;
  try { data = isJson ? await res.json() : await res.text(); } catch {}
  if (res.status === 401) {
    logout(true);
    showLoginScreen();
    setStatus(document.getElementById("loginStatus") || els.loginStatus || { classList: {}, textContent: "" }, data?.error || "Sesión caducada, vuelve a entrar.", true);
    throw new Error(data?.error || "Sin autenticar");
  }
  if (!res.ok) {
    // [DIAGNÓSTICO] Guardar errores HTTP 400+ para verlos en móvil Debug:
    try {
      const errObj = {
        fecha: new Date().toISOString(),
        url: u.toString().replace(window.location.origin,""),
        status: res.status,
        statusText: res.statusText,
        body: (typeof data === "string") ? data.slice(0, 120) : (data?.error || JSON.stringify(data||"").slice(0,120)),
        tokenOK: !!tok,
        role: state.session?.role || "—",
      };
      ULTIMOS_ERRORES_FETCH.unshift(errObj);
      if (ULTIMOS_ERRORES_FETCH.length > 15) ULTIMOS_ERRORES_FETCH.pop();
      try { localStorage.setItem(STORAGE_KEYS.ULTIMO_ERROR, JSON.stringify(ULTIMOS_ERRORES_FETCH.slice(0,10))); } catch {}
    } catch {}
    throw new Error((typeof data === "object" && data?.error) || data || `Error ${res.status}: ${res.statusText}`);
  }
  return data;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatMoney(amount) {
  const n = Number(amount) || 0;
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
}

function formatMoneySigned(amount) {
  const n = Number(amount) || 0;
  return (n >= 0 ? "+" : "-") + formatMoney(Math.abs(n));
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function startOfMonthISO(d) {
  const x = d ? new Date(d) : new Date();
  x.setHours(12,0,0,0);
  x.setDate(1);
  return x.toISOString().slice(0, 10);
}
function endOfMonthISO(d) {
  const x = d ? new Date(d) : new Date();
  x.setHours(12,0,0,0);
  x.setDate(1);
  x.setMonth(x.getMonth()+1);
  x.setDate(0);
  return x.toISOString().slice(0, 10);
}
// ═══════════════════════════════════════════════════════════════
// ✅ STUBS SEGUROS (FUNCIONES QUE FALTABAN Y CAUSABAN EXCEPCIONES):
// Hacemos que NO EXISTEN → se crean y NO lanzan errors (hacen lo que pueden de forma segura)
// ═══════════════════════════════════════════════════════════════
if (typeof renderSelects !== "function") {
  function renderSelects() { try { if (typeof renderObrasSelects === "function") renderObrasSelects(); } catch {} }
}
if (typeof renderDashboard !== "function") {
  function renderDashboard() { try { if (typeof renderBalanceGeneral === "function") renderBalanceGeneral(); } catch {} }
}
if (typeof renderBalanceGeneral !== "function") {
  function renderBalanceGeneral() {}
}
if (typeof renderMovimientos !== "function") {
  function renderMovimientos() { try { if (typeof renderContabilidad === "function") renderContabilidad(); } catch {} }
}
if (typeof renderCierre !== "function") {
  function renderCierre() { try { if (typeof renderCierreMes === "function") renderCierreMes(); } catch {} }
}
if (typeof renderContabilidad !== "function") {
  function renderContabilidad() {}
}
if (typeof renderCierreMes !== "function") {
  function renderCierreMes() {}
}
if (typeof renderAjustes !== "function") {
  function renderAjustes() {}
}
if (typeof renderWorkerSummary !== "function") {
  function renderWorkerSummary() {}
}
if (typeof cargarPestanaActual !== "function") {
  function cargarPestanaActual() {
    try {
      const act = document.querySelector(".nav-btn.active");
      if (act && act.dataset && act.dataset.tab) {
        const tab = act.dataset.tab;
        const fns = {
          "trabajadores": renderTrabajadores,
          "obras": renderObras,
          "horas": renderHoras,
          "contabilidad": renderContabilidad,
          "cajas": renderCajas,
          "cierremes": renderCierreMes,
          "ajustes": renderAjustes,
          "dashboard": renderDashboard,
        };
        if (typeof fns[tab] === "function") fns[tab]();
      }
    } catch {}
  }
}
if (typeof actualizarUserBadge !== "function") {
  function actualizarUserBadge() {
    try {
      const u = state.session?.user || null;
      const badge = document.getElementById("userBadge");
      if (badge) {
        if (u?.role === "admin") {
          badge.className = "user-badge";
          badge.innerHTML = "👑 " + escapeHtml(u.nombre || "Admin");
        } else if (u?.role === "worker") {
          badge.className = "user-badge worker";
          badge.innerHTML = "👷 " + escapeHtml(u.nombre || "Trabajador");
        } else {
          badge.textContent = "";
          badge.className = "user-badge";
        }
      }
    } catch {}
  }
}

function currentMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseDate(iso) {
  if (!iso) return null;
  const parts = iso.split("-");
  if (parts.length < 3) return null;
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function isSameMonth(dateISO, mes, anio) {
  const d = parseDate(dateISO);
  if (!d) return false;
  return d.getFullYear() === Number(anio) && d.getMonth() === Number(mes) - 1;
}

function isSameWeek(dateISO) {
  const d = parseDate(dateISO);
  if (!d) return false;
  const hoy = new Date();
  const inicioSemana = new Date(hoy);
  const dow = (hoy.getDay() + 6) % 7; // lunes=0
  inicioSemana.setDate(hoy.getDate() - dow);
  inicioSemana.setHours(0,0,0,0);
  const finSemana = new Date(inicioSemana);
  finSemana.setDate(inicioSemana.getDate() + 6);
  finSemana.setHours(23,59,59,999);
  return d >= inicioSemana && d <= finSemana;
}

function getTrabajadorById(id) {
  return state.trabajadores.find((t) => t.id === id) || null;
}
function getObraById(id) {
  return state.obras.find((o) => o.id === id) || null;
}
function getTrabajadoresActivos() {
  try {
    return (Array.isArray(state.trabajadores) ? state.trabajadores : [])
      .filter((t) => t && t.activo !== false)
      .sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || ""), "es"));
  } catch { return []; }
}

function isAdmin() { return state.session?.role === "admin"; }
function isWorker() { return state.session?.role === "worker"; }
function currentWorker() {
  return isWorker() ? getTrabajadorById(state.session.trabajadorId) : null;
}

function setStatus(el, message, isError = false, isSuccess = false) {
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("error", !!isError);
  el.classList.toggle("success", !!isSuccess);
}

function confirmAction(title, message) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("confirmDialog");
    document.getElementById("confirmDialogTitle").textContent = title;
    document.getElementById("confirmDialogMessage").textContent = message;
    const handler = (ev) => {
      dlg.removeEventListener("close", handler);
      resolve(ev.target.returnValue === "default");
    };
    dlg.addEventListener("close", handler);
    if (typeof dlg.showModal === "function") dlg.showModal();
    else resolve(window.confirm(message));
  });
}

/* ============ NUEVA LÓGICA CÁLCULO HORAS (8h BASE + EXTRAS) ============ */
function desgloseHoras(cantidad) {
  const n = Number(cantidad) || 0;
  const base = Math.min(n, HORAS_BASE_AL_DIA);
  const extra = Math.max(0, n - HORAS_BASE_AL_DIA);
  return { base, extra, total: n };
}

function horasYaRegistradasEnDia(trabajadorId, fecha, excludeHoraId) {
  return state.horas
    .filter((h) => h.trabajadorId === trabajadorId && h.fecha === fecha && (!excludeHoraId || h.id !== excludeHoraId))
    .reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
}

function calcularCosteHoras(trabajadorId, cantidad) {
  const t = getTrabajadorById(trabajadorId);
  const tarifaBase = Number(t?.tarifa) || 0;
  const tarifaExtra = Number(t?.tarifaExtra) || tarifaBase;
  const { base, extra } = desgloseHoras(cantidad);
  const costeBase = base * tarifaBase;
  const costeExtra = extra * tarifaExtra;
  return {
    tarifaBase,
    tarifaExtra,
    horasBase: base,
    horasExtra: extra,
    costeBase,
    costeExtra,
    costeTotal: costeBase + costeExtra,
  };
}

function recalcularDesgloseParaTrabajadorDia(trabajadorId, fecha) {
  const registrosDia = state.horas.filter((h) => h.trabajadorId === trabajadorId && h.fecha === fecha);
  if (registrosDia.length === 0) return;
  const totalHoras = registrosDia.reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
  let horasBaseRestantes = Math.min(totalHoras, HORAS_BASE_AL_DIA);
  let acumuladoHoras = 0;
  registrosDia.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const t = getTrabajadorById(trabajadorId);
  const tarifaBase = Number(t?.tarifa) || 0;
  const tarifaExtra = Number(t?.tarifaExtra) || tarifaBase;
  registrosDia.forEach((h) => {
    const cantidad = Number(h.cantidad) || 0;
    let baseReg = 0;
    let extraReg = 0;
    if (horasBaseRestantes > 0) {
      baseReg = Math.min(cantidad, horasBaseRestantes);
      horasBaseRestantes -= baseReg;
    }
    extraReg = Math.max(0, cantidad - baseReg);
    h.horasBase = Number(baseReg.toFixed(4));
    h.horasExtra = Number(extraReg.toFixed(4));
    h.tarifaBase = tarifaBase;
    h.tarifaExtra = tarifaExtra;
    h.costeBase = Number((baseReg * tarifaBase).toFixed(2));
    h.costeExtra = Number((extraReg * tarifaExtra).toFixed(2));
    h.costeTotal = Number((h.costeBase + h.costeExtra).toFixed(2));
    acumuladoHoras += cantidad;
  });
  saveHoras();
}

function recalcularDesgloseTrabajadorFechasAfectadas(trabajadorId, fechasArray) {
  const fechasUnicas = [...new Set((fechasArray || []).filter(Boolean))];
  fechasUnicas.forEach((f) => recalcularDesgloseParaTrabajadorDia(trabajadorId, f));
}

/* ============ DIAGNÓSTICO COMPLETO (para pegar al chat y arreglar fallo datos 0) ============ */
async function generarInformeDiagnosticoCompleto() {
  forzarConsistenciaLogin();
  const L = [];
  const P = (s) => L.push(s);
  P("══════════════════════════════════════════════════════════════════");
  P("🧐 INFORME DIAGNÓSTICO COMPLETO - Gestión Obras");
  P("══════════════════════════════════════════════════════════════════");
  P("Generado: " + new Date().toLocaleString("es-ES"));
  P("URL actual: " + window.location.href);
  P("");
  P("── 1) ENTORNO CLIENTE (tu navegador / móvil) ──");
  P("Modo móvil detectado: " + (IS_MOBILE ? "✅ SÍ" : "❌ NO (PC)"));
  P("UserAgent (navegador/SO): " + (navigator.userAgent || "(sin UA)").slice(0, 120));
  P("Conexión: " + (navigator.onLine ? "✅ ONLINE" : "❌ SIN INTERNET") + (navigator.connection && navigator.connection.effectiveType ? ` (tipo: ${navigator.connection.effectiveType})` : ""));
  P("Idioma navegador: " + (navigator.language || "—"));
  P("Resolución pantalla: " + (window.screen ? window.screen.width + "x" + window.screen.height : "—") + " · Viewport: " + window.innerWidth + "x" + window.innerHeight);
  P("");
  P("── 2) ESTADO DE SESIÓN Y LOGIN ──");
  P("Token JWT guardado: " + (getToken() ? `✅ SÍ (${String(getToken()).length} chars)` : "❌ NO (NO ESTÁS LOGGEADO → causa principal datos 0!)"));
  P("Rol sesión (state): " + (state.session?.role === "admin" ? "👑 ADMIN" : state.session?.role === "worker" ? "👷 TRABAJADOR" : "❌ NINGÚN (sin login!)"));
  P("ID trabajador sesión: " + (state.session?.trabajadorId || "—"));
  P("Consistencia sesión (token + role): " + ((!!getToken() && !!state.session?.role) ? "✅ COINCIDE (OK)" : "❌ INCONSISTENTE (NO COINCIDEN token/sesion)"));
  P("Admin PIN guardado en state: " + (state.adminPin ? "✅ SÍ (oculto)" : "❌ NO"));
  P("");
  P("── 3) DATOS ACTUALES EN TU APP (state en memoria) ──");
  P("👷 Trabajadores: " + state.trabajadores.length);
  P("🏢 Obras: " + state.obras.length);
  P("⏰ Horas: " + state.horas.length);
  P("💵 Movimientos: " + state.movimientos.length);
  const totalState = state.trabajadores.length + state.obras.length + state.horas.length + state.movimientos.length;
  P("📊 TOTAL DATOS EN TU APP: " + totalState + "  " + (totalState === 0 ? "⚠️ VACÍO (causa del fallo!)" : "✅ OK"));
  P("Última sincro OK: " + (state.ultimaSync ? new Date(state.ultimaSync).toLocaleString("es-ES") : "NUNCA"));
  P("");
  // PRUEBA 1: BBDD REAL /api/health/diagnostico (sin auth)
  P("═══ PRUEBA 1: /api/health/diagnostico (BBDD REAL, SIN LOGIN NADA) ═══");
  let health = null, healthErr = null;
  try {
    const u = new URL(API_BASE + "/api/health/diagnostico", window.location.origin);
    u.searchParams.set("_t", Date.now() + "_" + Math.random().toString(36).slice(2, 10));
    const r = await fetch(u, { method: "GET", headers: { "Cache-Control": "no-store", "Pragma": "no-cache", "Accept": "application/json" }, cache: "no-store" });
    health = await r.json();
    if (!r.ok) throw new Error("HTTP " + r.status + " - " + JSON.stringify(health));
  } catch (e) { healthErr = e.message; }
  if (health && health.ok) {
    P("✅ Llamada OK");
    P("Motor de BBDD usado: " + health.motor);
    P("¿Usa Turso Cloud (persistente): " + (health.motorUsaTurso ? "✅ SÍ (bueno, no se borran datos)" : "❌ NO (SQLite local)"));
    P("¿Estás en Render: " + (health.isRender ? "✅ SÍ" : "NO"));
    P(health.warning || "");
    P("");
    P("📊 CONTADORES REALES EN LA BBDD (Turso/SQL):");
    const T = health.tables || {};
    P("👷 Trabajadores (REAL): " + (T.trabajadores ?? 0));
    P("🏢 Obras (REAL):        " + (T.obras ?? 0));
    P("⏰ Horas (REAL):        " + (T.horas ?? 0));
    P("💵 Movimientos (REAL):  " + (T.movimientos ?? 0));
    P("⚙️ Settings (REAL):     " + (T.settings ?? 0));
    const totalReal = (T.trabajadores || 0) + (T.obras || 0) + (T.horas || 0) + (T.movimientos || 0);
    P("📊 TOTAL REAL EN BBDD:  " + totalReal + "  " + (totalReal === 0 ? "⚠️ VACÍO TOTAL EN TURSO/SQL (los datos nunca se guardaron!)" : "✅ HAY DATOS REALES EN BBDD"));
    P("Admin PIN guardado en BBDD?: " + (health.adminPinExiste ? "✅ SÍ" : "❌ NO (está el PIN por defecto 1234)"));
    P("");
    P("🧪 MUESTRAS (últimas 3 filas de cada tabla en la BBDD REAL):");
    if (health.muestras) {
      // Helper para MOSTRAR TODAS LAS COLUMNAS (nunca más fallo por nombre de columna que no existe!):
      function mostrarFila(fila, maxLongClave = 20) {
        const partes = [];
        Object.entries(fila || {}).forEach(([k, v]) => {
          const clave = String(k).padEnd(maxLongClave, " ").slice(0, maxLongClave);
          let valor;
          if (v === null || v === undefined) valor = "null";
          else if (typeof v === "boolean") valor = v ? "1" : "0";
          else {
            valor = String(v);
            if (valor.length > 60) valor = valor.slice(0, 60) + "...";
          }
          partes.push(`${clave}=${valor}`);
        });
        return partes.join(" | ");
      }
      const MT = health.muestras.ultimos3Trabajadores || [];
      if (MT.length) {
        P("→ Trabajadores (muestra " + MT.length + "):");
        MT.forEach((t, i) => {
          if (t._error) P(`   ${i+1}) ❌ ERROR: ${t._error}`);
          else P(`   ${i+1}) ${mostrarFila(t)}`);
        });
      } else P("→ Trabajadores: NINGÚN DATO");
      const MO = health.muestras.ultimas3Obras || [];
      if (MO.length) {
        P("→ Obras (muestra " + MO.length + "):");
        MO.forEach((o, i) => {
          if (o._error) P(`   ${i+1}) ❌ ERROR: ${o._error}`);
          else P(`   ${i+1}) ${mostrarFila(o)}`);
        });
      } else P("→ Obras: NINGÚN DATO");
      const MH = health.muestras.ultimas3Horas || [];
      if (MH.length) {
        P("→ Horas (muestra " + MH.length + "):");
        MH.forEach((h, i) => {
          if (h._error) P(`   ${i+1}) ❌ ERROR: ${h._error}`);
          else P(`   ${i+1}) ${mostrarFila(h)}`);
        });
      } else P("→ Horas: NINGÚN DATO");
      const MM = health.muestras.ultimos3Mov || [];
      if (MM.length) {
        P("→ Movimientos (muestra " + MM.length + "):");
        MM.forEach((m, i) => {
          if (m._error) P(`   ${i+1}) ❌ ERROR: ${m._error}`);
          else P(`   ${i+1}) ${mostrarFila(m)}`);
        });
      } else P("→ Movimientos: NINGÚN DATO");
    }
    P("");
    // Comparativa BBDD real vs state en frontend
    P("═══ COMPARATIVA: BBDD REAL vs TU APP (state) ═══");
    const fallos = [];
    function cmptab(nom, vreal, vstate) {
      const ok = vreal === vstate;
      if (!ok) fallos.push(nom);
      P(`${nom}: BBDD=${vreal} · TuApp=${vstate} → ${ok ? "✅ COINCIDE (OK)" : "❌ NO COINCIDE (causa del fallo!)"}`);
    }
    cmptab("👷 Trabajadores", T.trabajadores || 0, state.trabajadores.length);
    cmptab("🏢 Obras",        T.obras || 0,        state.obras.length);
    cmptab("⏰ Horas",        T.horas || 0,        state.horas.length);
    cmptab("💵 Movimientos",  T.movimientos || 0,  state.movimientos.length);
    P("");
    P("📊 TOTAL: BBDD=" + totalReal + " · TuApp=" + totalState + " → " + (totalReal === totalState ? "✅ 100% COINCIDE" : "❌ NO COINCIDEN"));
    P("");
    // Diagnóstico automático
    P("═══ DIAGNÓSTICO AUTOMÁTICO ═══");
    if (totalReal === 0) {
      P("⚠️ CASO 1: LA BASE DE DATOS REAL ESTÁ COMPLETAMENTE VACÍA.");
      P("   CAUSAS POSIBLES:");
      P("   a) Tienes Render PERO NO CONFIGURASTE TURSO: Render usa SQLite efímero y se borra al redeployear.");
      P("   b) Los datos realmente NUNCA se guardaron (el trabajador pulsó guardar pero devolvió 500 error).");
      P("   c) Borraste la BBDD por error desde Turso.tech.");
    } else if (!getToken() || !state.session?.role) {
      P("⚠️ CASO 2: LA BBDD TIENE " + totalReal + " DATOS PERO TU NO ESTÁS LOGGEADO.");
      P("   SOLUCIÓN: Pulsa 🚪 SALIR arriba → introduce PIN correcto.");
    } else if (fallos.length) {
      P("⚠️ CASO 3: BBDD (" + totalReal + " datos) ≠ TuApp (" + totalState + " datos). Las tablas que fallan: " + fallos.join(", "));
      P("   CAUSAS POSIBLES:");
      P("   a) Rol equivocado: estás en 👷 Trabajador pero no eres tú (solo puede ver SUS horas).");
      P("   b) Caché del navegador: Pulsa 🔄 Sincronizar o [Aceptar] Hard Reset en Debug Móvil.");
      P("   c) Render con SQLite local sin Turso: redeployearon y el servidor nuevo no tiene datos.");
    } else {
      P("✅ TODO COINCIDE 100% (BBDD " + totalReal + " = TuApp " + totalState + ").");
      P("   Si creías que faltaban datos, posiblemente estás mirando otro periodo fecha o filtro activado (en Horas, Contabilidad, Cajas).");
    }
  } else {
    P("❌ FALLO al llamar al endpoint /api/health/diagnostico:");
    P("   Motivo: " + String(healthErr || "desconocido").slice(0, 500));
  }
  P("");
  P("═══ PRUEBA 2: /api/sync (con tu token si hay login) ═══");
  if (getToken()) {
    let sync = null, syncErr = null;
    try {
      const u = new URL(API_BASE + "/api/sync", window.location.origin);
      u.searchParams.set("_t", Date.now() + "_" + Math.random().toString(36).slice(2, 10));
      const r = await fetch(u, { method: "GET", headers: { "Cache-Control": "no-store", "Pragma": "no-cache", "Accept": "application/json", "Authorization": "Bearer " + getToken() }, cache: "no-store" });
      sync = await r.json();
      if (!r.ok) throw new Error("HTTP " + r.status + " - " + (sync?.error || JSON.stringify(sync)).slice(0, 200));
    } catch (e) { syncErr = e.message; }
    if (sync) {
      P("✅ /api/sync OK (HTTP 200)");
      // ✅ NUEVO: TESTIGO DIAGNÓSTICO PERMISOS (lo primero que ve el usuario para saber causa):
      if (sync.diagnosticoPermisos) {
        P("");
        P("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        P("🔍 DIAGNÓSTICO DEL SERVIDOR (testigo inquebrantable):");
        P(String(sync.diagnosticoPermisos));
        P("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        P("");
      }
      P("Rol según el servidor: " + (sync.currentUser?.role === "admin" ? "👑 ADMIN" : sync.currentUser?.role === "worker" ? "👷 TRABAJADOR (tid=" + (sync.currentUser?.trabajadorId || "-") + ")" : "—"));
      P("Fecha respuesta servidor: " + (sync.generadoEn ? new Date(sync.generadoEn).toLocaleString("es-ES") : "—"));
      P("Datos que EL SERVIDOR TE ENVÍA (tu usuario):");
      P("👷 Trabajadores (recibidos): " + (Array.isArray(sync.trabajadores) ? sync.trabajadores.length : "ERROR NO ARRAY"));
      P("🏢 Obras (recibidas):        " + (Array.isArray(sync.obras) ? sync.obras.length : "ERROR NO ARRAY"));
      P("⏰ Horas (recibidas):        " + (Array.isArray(sync.horas) ? sync.horas.length : "ERROR NO ARRAY"));
      P("💵 Movimientos (recibidos):  " + (Array.isArray(sync.movimientos) ? sync.movimientos.length : "ERROR NO ARRAY"));
      const totalRecv = (sync.trabajadores?.length||0) + (sync.obras?.length||0) + (sync.horas?.length||0) + (sync.movimientos?.length||0);
      P("📊 TOTAL RECIBIDOS: " + totalRecv);
      if (health && health.ok) {
        const rBBDD = sync._realTrabajadoresEnBBDD || health.tables.trabajadores || 0;
        const oBBDD = sync._realObrasEnBBDD || health.tables.obras || 0;
        const hBBDD = sync._realHorasEnBBDD || health.tables.horas || 0;
        const mBBDD = sync._realMovEnBBDD || health.tables.movimientos || 0;
        const totalBBDD2 = rBBDD + oBBDD + hBBDD + mBBDD;
        P("");
        P("🤝 COMPARATIVA FINAL (BBDD REAL vs LO QUE TÚ RECIBES vs TU APP):");
        P("            Tabla        | BBDD_REAL | TÚ_RECIBES | TU_APP (state)");
        P("            -------------|-----------|------------|----------------");
        P(`            👷 Trabajadores| ${String(rBBDD).padStart(9," ")} | ${String(sync.trabajadores?.length||0).padStart(10," ")} | ${String(state.trabajadores.length).padStart(14," ")}`);
        P(`            🏢 Obras       | ${String(oBBDD).padStart(9," ")} | ${String(sync.obras?.length||0).padStart(10," ")} | ${String(state.obras.length).padStart(14," ")}`);
        P(`            ⏰ Horas       | ${String(hBBDD).padStart(9," ")} | ${String(sync.horas?.length||0).padStart(10," ")} | ${String(state.horas.length).padStart(14," ")}`);
        P(`            💵 Movimientos | ${String(mBBDD).padStart(9," ")} | ${String(sync.movimientos?.length||0).padStart(10," ")} | ${String(state.movimientos.length).padStart(14," ")}`);
        P(`            TOTALES        | ${String(totalBBDD2).padStart(9," ")} | ${String(totalRecv).padStart(10," ")} | ${String(totalState).padStart(14," ")}`);
        P("");
        if (sync.currentUser?.role === "worker") {
          P("💡 Nota: Eres 👷 TRABAJador → EL SERVIDOR TE ENVÍA SOLO SUS COSAS (¡así está diseñado!).");
          P("   Si quieres ver TODO, entra con el PIN 👑 ADMIN (1234 o el que configuraste).");
        }
      }
    } else {
      P("❌ /api/sync FALLÓ:");
      P("   Motivo: " + String(syncErr || "desconocido").slice(0, 500));
    }
  } else P("⏭️ NO HAY TOKEN → no se ejecuta /api/sync (estás sin login).");
  P("");
  P("═══ ÚLTIMOS 10 ERRORES HTTP 400+ DETECTADOS ═══");
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.ULTIMO_ERROR) || "[]");
    stored.forEach(e => { if (!ULTIMOS_ERRORES_FETCH.find(x => x.fecha === e.fecha)) ULTIMOS_ERRORES_FETCH.push(e); });
    if (ULTIMOS_ERRORES_FETCH.length > 15) ULTIMOS_ERRORES_FETCH.length = 15;
  } catch {}
  if (ULTIMOS_ERRORES_FETCH.length) {
    ULTIMOS_ERRORES_FETCH.slice(0, 10).forEach((e, i) => {
      P(`${i+1}) [${new Date(e.fecha).toLocaleString("es-ES")}] ${String(e.url||"").slice(0,60)} → HTTP ${e.status}`);
      P(`     ${String(e.body||"").slice(0, 180)}`);
    });
  } else P("✅ No hay errores HTTP guardados.");
  P("");
  P("══════════════════════════════════════════════════════════════════");
  P("👋 FIN DEL INFORME. Pulsa 📋 COPIAR y pégame el texto completo en el chat.");
  return L.join("\n");
}

/* ============ SAFE RENDER WRAPPER (DEFCON 1: NUNCA MÁS FALLOS SILENCIOSOS) ============ */
// Este objeto registra el estado del último render de CADA FUNCIÓN individual (✅ OK o ❌ ERROR con stacktrace).
// Antes: una función de render fallaba SILENCIOSAMENTE en try/catch general → ahora se ve TODO.
const RENDER_STATUS = {
  ultimos: {},
  errores: [],
};
function safeRender(nombreFuncion, fn) {
  try {
    const _t0 = Date.now();
    const resultado = fn();
    RENDER_STATUS.ultimos[nombreFuncion] = { ok: true, ms: Date.now() - _t0, fecha: new Date().toISOString(), error: null };
    return resultado;
  } catch (e) {
      const err = {
        fecha: new Date().toISOString(),
        funcion: nombreFuncion,
        mensaje: e.message,
        stack: (e.stack || "").toString().slice(0, 500),
      };
      RENDER_STATUS.ultimos[nombreFuncion] = { ok: false, ms: 0, fecha: err.fecha, error: err };
      RENDER_STATUS.errores.unshift(err);
      if (RENDER_STATUS.errores.length > 20) RENDER_STATUS.errores.length = 20;
      console.error(`❌❌❌ [SAFE RENDER FALLO: ${nombreFuncion}: ${e.message}`, e.stack || "");
      // BANNER GIGANTE para que LO VEAS SI O SI (no más fallos silenciosos):
      try {
        const ban = document.getElementById("bannerRenderErrors");
        if (ban) {
          ban.classList.remove("hidden");
          const lista = RENDER_STATUS.errores.slice(0, 3).map(r => `
═══════════════════════════════════════
⚠️ FALLO AL PINTAR "${r.funcion}"
Fecha: ${new Date(r.fecha).toLocaleString("es-ES")}
Motivo: ${r.mensaje}
Stack (línea del error): 
${r.stack}
`).join("\n");
          const txt = `🚨 ${RENDER_STATUS.errores.length} FUNCION(ES) NO SE PINTARON (fallo render):\n\n${lista}\nPulsa 💥 FORZAR REPINTAR TODO (arriba, botón rojo en navbar) y si sigue fallando pégame esto en el chat para arreglarlo al instante.`;
          const sp = ban.querySelector("span");
          if (sp) sp.textContent = txt;
        }
      } catch {}
      return false;
  }
}
// Helper para llamar SOLO las funciones de render EXISTEN y SAFE:
// ✅ MÁS IMPORTANTE: CADA FUNCIÓN TIENE SU TRY/CATCH INDEPENDIENTE.
// NUNCA MÁS: falla 1 función y se abortan las otras 12 (como te está pasando ahora mismo).
// ✅ AHORA ASÍNC: espera a que acaben funciones ASYNC (como renderAll, renderCajas) y captura exceptions!
async function safeRenderAll(evitarBanner = false) {
  const resultados = [];
  // NUEVO sr() ASÍNCRONO para capturar excepciones en promesas:
  async function sr(nombre, fn) {
    if (typeof fn !== "function") {
      resultados.push({ nombre, ok: false, error: "Función no definida aún" });
      RENDER_STATUS.ultimos[nombre] = { ok: false, error: { mensaje: "Función no definida aún" } };
      return;
    }
    try {
      const _t0 = Date.now();
      const res = fn();
      // Esperamos si la función es async (devuelve Promise):
      const finalRes = (res && typeof res.then === "function") ? await res : res;
      resultados.push({ nombre, ok: true, ms: Date.now() - _t0 });
      RENDER_STATUS.ultimos[nombre] = { ok: true, ms: Date.now() - _t0, fecha: new Date().toISOString(), error: null };
    } catch (e) {
      const err = {
        fecha: new Date().toISOString(),
        funcion: nombre,
        mensaje: e.message,
        stack: (e.stack || "").toString().slice(0, 500),
      };
      RENDER_STATUS.ultimos[nombre] = { ok: false, ms: 0, fecha: err.fecha, error: err };
      RENDER_STATUS.errores.unshift(err);
      if (RENDER_STATUS.errores.length > 20) RENDER_STATUS.errores.length = 20;
      console.error(`❌ [safeRenderAll SR FALLO ${nombre}]: ${e.message}\n`, e.stack || "");
      resultados.push({ nombre, ok: false, ms: 0, error: err });
    }
  }
  if (isAdmin()) {
    await sr("renderAll", () => { if (typeof renderAll === "function") return renderAll(); });
    await sr("renderTrabajadores()", () => { if (typeof renderTrabajadores === "function") return renderTrabajadores(); });
    await sr("renderObras()", () => { if (typeof renderObras === "function") return renderObras(); });
    await sr("renderHoras()", () => { if (typeof renderHoras === "function") return renderHoras(); });
    await sr("renderContabilidad()", () => { if (typeof renderContabilidad === "function") return renderContabilidad(); });
    await sr("renderCajas()", () => { if (typeof renderCajas === "function") return renderCajas(); });
    await sr("renderCierreMes()", () => { if (typeof renderCierreMes === "function") return renderCierreMes(); });
    await sr("renderAjustes()", () => { if (typeof renderAjustes === "function") return renderAjustes(); });
    try { await sr("cargarPestanaActual()", () => { if (typeof cargarPestanaActual === "function") return cargarPestanaActual(); }); } catch {}
  } else if (isWorker()) {
    await sr("renderWorker()", () => { if (typeof renderWorker === "function") return renderWorker(); });
    await sr("renderHoras()", () => { if (typeof renderHoras === "function") return renderHoras(); });
  }
  try { await sr("actualizarUserBadge()", () => { if (typeof actualizarUserBadge === "function") return actualizarUserBadge(); }); } catch {}
  try { await sr("populateResponsablesSelect()", () => { if (typeof populateResponsablesSelect === "function") return populateResponsablesSelect(); }); } catch {}
  try { await sr("renderObrasSelects()", () => { if (typeof renderObrasSelects === "function") return renderObrasSelects(); }); } catch {}
  try { await sr("populateWorkerQuickForm()", () => { if (typeof populateWorkerQuickForm === "function") return populateWorkerQuickForm(); }); } catch {}
  // Banner de errores de render (actualizar, solo si hay algún fallo y no evitarBanner):
  if (!evitarBanner) {
    try {
      const ban = document.getElementById("bannerRenderErrors");
      if (ban) {
        const algunFallo = resultados.some(r => !r.ok) || Object.values(RENDER_STATUS.ultimos || {}).some(x => x && !x.ok);
        if (algunFallo) {
          const primeros3 = RENDER_STATUS.errores.slice(0, 3);
          const lista = primeros3.map(r => `
═══════════════════════════════════════
⚠️ FALLO AL PINTAR "${r.funcion}"
Fecha: ${new Date(r.fecha).toLocaleString("es-ES")}
Motivo: ${r.mensaje}
Stack (línea del error): 
${r.stack}`).join("\n");
          const txt = `🚨 ${RENDER_STATUS.errores.length} FUNCION(ES) NO SE PINTARON (fallo render):\n\n${lista}\n\nPulsa 💥 FORZAR REPINTAR TODO (arriba rojo) y luego pégame TODO el texto de este BANNER ROJO en el chat. ¡¡ARREGLO CADA ERROR UNO A UNO EN 10 SEGUNDOS!!`;
          const sp = ban.querySelector("span");
          if (sp) sp.textContent = txt;
          ban.classList.remove("hidden");
        } else ban.classList.add("hidden");
      }
    } catch {}
  }
  return resultados;
}

function getAdminPin() { return state.adminPin || DEFAULT_ADMIN_PIN; }
function saveSession() { localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(state.session)); }

// ✅ FORZAR CONSISTENCIA: si NO HAY TOKEN, entonces NUNCA puede haber sesión iniciada.
// (Este es el bug que te tenía "datos a 0": móvil tenía role guardado pero token se perdió al limpiar caché.)
function forzarConsistenciaLogin() {
  const tok = getToken();
  if (!tok) {
    clearSession();
    state.trabajadores = []; state.obras = []; state.horas = []; state.movimientos = [];
    return false;
  }
  if (!state.session || !state.session.role) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SESSION);
      if (raw) state.session = JSON.parse(raw);
    } catch { state.session = { role: null, trabajadorId: null }; }
    if (!state.session?.role) { clearSession(); return false; }
  }
  return true;
}
function loadSession() {
  forzarConsistenciaLogin();
  if (!state.session) state.session = { role: null, trabajadorId: null };
  const banner = document.getElementById("bannerSesionPerdida");
  if (banner) {
    if (!getToken() || !state.session?.role) {
      banner.classList.remove("hidden");
      // MOSTRAR LOGIN SIEMPRE cuando no hay sesión (nunca más paneles vacíos a 0!)
      try { showLoginScreen(); } catch {}
    } else banner.classList.add("hidden");
  }
  const btnAdmin = document.getElementById("btnPestTrabajadores");
  if (btnAdmin) btnAdmin.style.display = (state.session?.role !== "admin") ? "none" : "";
}
function clearSession() {
  state.session = { role: null, trabajadorId: null };
  localStorage.removeItem(STORAGE_KEYS.SESSION);
}
function logout(silent) {
  setToken(null); clearSession();
  ["trabajadores","obras","horas","movimientos"].forEach(k => state[k] = []);
  try { const b = document.getElementById("bannerSesionPerdida"); if (b) b.classList.remove("hidden"); } catch {}
  if (!silent) { showLoginScreen(); }
}

function renderLoginSelect() {
  const sel = document.getElementById("loginTrabajadorSelect");
  const activos = state.trabajadores.filter((t) => t.activo !== false).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
  sel.innerHTML = '<option value="">-- Elige tu nombre --</option>' +
    activos.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.nombre)}${t.categoria ? ` (${escapeHtml(t.categoria)})` : ""}</option>`).join("");
}

async function showLoginScreen() {
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("appMain").classList.add("hidden");
  document.body.classList.remove("role-admin", "role-worker");
  try {
    if (state.trabajadores.length === 0) {
      try {
        const res = await fetch(API_BASE + "/api/trabajadores/lista-publica");
        if (res.ok) {
          const lista = await res.json();
          if (Array.isArray(lista)) state.trabajadores = lista;
        }
      } catch {}
    }
  } catch {}
  renderLoginSelect();
  document.getElementById("loginError").textContent = "";
}

function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appMain").classList.remove("hidden");
}

function applyRoleUI() {
  document.body.classList.remove("role-admin", "role-worker");
  if (!state.session.role) { showLoginScreen(); return; }

  document.body.classList.add(`role-${state.session.role}`);
  showApp();

  const roleBadge = document.getElementById("roleBadge");
  const userBadge = document.getElementById("userBadge");
  const title = document.getElementById("appTitle");
  const subtitle = document.getElementById("appSubtitle");

  if (isAdmin()) {
    roleBadge.textContent = "👑 ADMIN";
    roleBadge.className = "role-badge admin";
    const nombreAdmin = state.session.trabajadorId ? getTrabajadorById(state.session.trabajadorId)?.nombre : null;
    if (nombreAdmin) {
      userBadge.textContent = `👑 ${nombreAdmin}`;
      title.textContent = "🏗️ Gestión de Obras";
      subtitle.textContent = `Sesión de administrador: ${nombreAdmin}. Control total`;
    } else {
      userBadge.textContent = "Administración";
      title.textContent = "🏗️ Gestión de Obras";
      subtitle.textContent = "Control de horas, contabilidad y rentabilidad por obra";
    }
  } else {
    const w = currentWorker();
    roleBadge.textContent = "👷 TRABAJADOR";
    roleBadge.className = "role-badge worker";
    userBadge.textContent = w ? `👋 ${w.nombre}` : "Trabajador";
    title.textContent = "👷 Mi Portal de Horas";
    subtitle.textContent = "Registra tus horas al final del día de forma rápida y sencilla";
  }

  // Ocultar tabs según rol
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const r = btn.dataset.role;
    const visible = r === "both" || (r === "admin" && isAdmin());
    btn.classList.toggle("hidden", !visible);
  });
  document.querySelectorAll(".tab-content").forEach((sec) => {
    const r = sec.dataset.role;
    const visible = r === "both" || (r === "admin" && isAdmin());
    if (!visible && sec.classList.contains("active")) sec.classList.remove("active");
  });

  // Pestaña activa inicial según rol
  if (isAdmin()) {
    activateTab("dashboard");
  } else {
    activateTab("horas");
    // Mostrar paneles de trabajador
    document.getElementById("workerQuickHours").classList.remove("hidden");
    document.getElementById("workerMyData").classList.remove("hidden");
    document.getElementById("adminHoursForm").classList.add("hidden");
    document.getElementById("historialHorasTitle").textContent = "📜 Mi historial de horas";
    populateWorkerQuickForm();
    renderWorkerSummary();
  }
  if (isAdmin()) {
    document.getElementById("workerQuickHours").classList.add("hidden");
    document.getElementById("workerMyData").classList.add("hidden");
    document.getElementById("adminHoursForm").classList.remove("hidden");
    document.getElementById("historialHorasTitle").textContent = "📜 Historial de Horas (todos)";
  }
}

async function activateTab(name) {
  let activated = false;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    if (btn.dataset.tab === name && !btn.classList.contains("hidden")) {
      btn.classList.add("active");
      activated = true;
    } else {
      btn.classList.remove("active");
    }
  });
  document.querySelectorAll(".tab-content").forEach((sec) => {
    if (sec.id === `tab-${name}` && !sec.classList.contains("hidden")) {
      sec.classList.add("active");
    } else {
      sec.classList.remove("active");
    }
  });
  if (!activated) {
    const firstVisible = document.querySelector(".tab-btn:not(.hidden)");
    if (firstVisible) return activateTab(firstVisible.dataset.tab);
  }
  if (state.session?.role) {
    const now = Date.now();
    if (now - _lastTabRefreshAt >= _TAB_REFRESH_COOLDOWN) {
      _lastTabRefreshAt = now;
      try {
        const ok = await loadAllData(true, false);
        if (ok) try { await renderAll(); } catch {}
      } catch (e) { /* ignore */ }
    }
  }
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.classList.contains("hidden")) return;
      await activateTab(btn.dataset.tab);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

async function loginAdmin(pin) {
  try {
    const res = await api("/api/auth/admin-pin", { method: "POST", body: JSON.stringify({ pin }) });
    setToken(res.token);
    state.session = res.session || { role: "admin", trabajadorId: null };
    saveSession();
    return true;
  } catch (e) {
    return false;
  }
}
async function loginWorker(trabajadorId, pin) {
  try {
    const res = await api("/api/auth/worker", { method: "POST", body: JSON.stringify({ trabajadorId, pin }) });
    setToken(res.token);
    state.session = res.session || { role: "worker", trabajadorId };
    saveSession();
    return true;
  } catch (e) {
    return false;
  }
}

async function loadAllData(silent = false, force = false) {
  loadSession();
  // ✅ COMPROBACIÓN OBLIGATORIA: si NO HAY TOKEN (sin login), NUNCA intentamos pedir datos.
  // Avisamos al usuario y mostramos el login (evitamos "datos a 0" sin explicación!)
  if (!forzarConsistenciaLogin() || !getToken() || !state.session?.role) {
    if (!silent) {
      logout(true);
      showLoginScreen();
      try {
        const loginErr = document.getElementById("loginError");
        if (loginErr) loginErr.textContent = "⚠️ Tu sesión se ha perdido (sin token). Vuelve a introducir el PIN para ver tus datos.";
      } catch {}
    }
    return false;
  }
  const now = Date.now();
  if (!force && !silent) {
    if (_loadLock) return _loadLock;
  }
  if (!force && silent && _loadLock) return _loadLock;
  if (!force && (now - _lastLoadedAt) < _MIN_MS_BETWEEN_LOADS) return true;
  try {
    _loadLock = (async () => {
      state.trabajadores = []; state.obras = []; state.horas = []; state.movimientos = []; state.cajasData = null;
      state._diagnosticoSync = null;
      const d = await api("/api/sync");
      state.trabajadores = Array.isArray(d.trabajadores) ? d.trabajadores : [];
      state.obras = Array.isArray(d.obras) ? d.obras : [];
      state.horas = Array.isArray(d.horas) ? d.horas : [];
      state.movimientos = Array.isArray(d.movimientos) ? d.movimientos : [];
      if (d.adminPin) state.adminPin = d.adminPin;
      state._diagnosticoSync = {
        generadoEn: d.generadoEn,
        realBBDD: {
          trabajadores: Number(d._realTrabajadoresEnBBDD || 0),
          obras: Number(d._realObrasEnBBDD || 0),
          horas: Number(d._realHorasEnBBDD || 0),
          movimientos: Number(d._realMovEnBBDD || 0),
        },
        recibidosFront: {
          trabajadores: state.trabajadores.length,
          obras: state.obras.length,
          horas: state.horas.length,
          movimientos: state.movimientos.length,
        },
        // NUEVO: Diagnóstico permisos DIRECTO del servidor (dice TODO)
        diagnosticoPermisos: d.diagnosticoPermisos || "",
      };
      const diag = state._diagnosticoSync;
      // ✅ BANNER GIGANTE ROJO NUEVO:
      // Si BBDD REAL tiene datos (>=1 en cualquiera) PERO EL FRONT LOS RECIBIÓ VACÍOS:
      // (este es EXACTAMENTE el caso que tienes tú ahora)
      const bbddConDatos = (diag.realBBDD.trabajadores + diag.realBBDD.obras + diag.realBBDD.horas + diag.realBBDD.movimientos) > 0;
      const frontVacio = (state.trabajadores.length + state.obras.length + state.horas.length + state.movimientos.length) === 0;
      try {
        const ban = document.getElementById("bannerDatosOcultos");
        if (ban) {
          if (bbddConDatos && frontVacio) {
            const texto = [
              "🚨 BBDD TIENE DATOS PERO TU APP NO LOS MUESTRA (FALLO RENDER FRONTEND):",
              d.diagnosticoPermisos || "",
              "",
              "✅ SOLUCIÓN 1 SEGUNDO:",
              "1) Pulsa CANCELAR / ACEPTAR de este mensaje.",
              "2) Pulsa 🧐 DIAGNÓSTICO COMPLETO (botón azul arriba).",
              "3) Selecciona todo el texto (mantener pulsar + Seleccionar todo) y cópialo → pégame lo aquí.",
              "O BIEN: vuelve a pulsar 🔄 SINCRONIZAR y si no se pintan, refresca F5 (la 1ª vez lo pinta todo).",
            ].join("\n");
            ban.classList.remove("hidden");
            ban.querySelector("span").textContent = texto;
          } else ban.classList.add("hidden");
        }
      } catch {}
      const incongruencias = [];
      ["trabajadores","obras","horas","movimientos"].forEach(k => {
        const bbdd = Number(diag.realBBDD[k] || 0); const front = Number(diag.recibidosFront[k] || 0);
        if (bbdd > 0 && front === 0) incongruencias.push(`Tabla ${k}: BBDD=${bbdd} PERO front=0 (DATO PERDIDO!)`);
      });
      if (incongruencias.length) {
        console.error("❌ [FALLO GRAVE] INCONGRUENCIA BBDD vs FRONT:", incongruencias, d);
        try {
          const errObj = {
            fecha: new Date().toISOString(),
            url: "/api/sync (INCONGRUENCIA!)",
            status: 999,
            statusText: "INCONGRUENCIA: BBDD tiene datos PERO front recibe array vacío.",
            body: incongruencias.join("\n"),
            tokenOK: !!getToken(),
            role: state.session?.role || "—",
          };
          ULTIMOS_ERRORES_FETCH.unshift(errObj);
          if (ULTIMOS_ERRORES_FETCH.length>15) ULTIMOS_ERRORES_FETCH.pop();
          try { localStorage.setItem(STORAGE_KEYS.ULTIMO_ERROR, JSON.stringify(ULTIMOS_ERRORES_FETCH.slice(0,10))); } catch {}
        } catch {}
      }
      _lastLoadedAt = Date.now();
      state.ultimaSync = new Date();
      try { actualizarBadgeUltimaSync(); } catch {}
      try { comprobarPerdidaDatosPotencial(); } catch {}
      // ✅✨ FORZADO ABSOLUTO DE RENDER (SAFE RENDER NIVEL 9999):
      // Ahora NO puede fallar SILENCIOSAMENTE: cada función se prueba individualmente y si falla -> BANNER GIGANTE ROJO.
      try {
        const res = await safeRenderAll(false);
        console.log("✅ Safe Render All terminó. Funciones OK/Total:", res.filter(x=>x.ok).length + "/" + res.length);
        res.forEach(r => console.log(`   ${r.ok?"✅":"❌"}  ${r.nombre}`));
        // Aseguramos que el main NO está oculto si NO es la pantalla login:
        try {
          const login = document.getElementById("loginScreen");
          const main = document.getElementById("appMain");
          if (login && main) {
            const loginOculto = login.classList?.contains("hidden") || getComputedStyle(login).display === "none";
            if (loginOculto) main.classList.remove("hidden");
          }
        } catch {}
      } catch (errRender) {
        console.error("❌ ERROR FATAL safeRenderAll (nunca debería pasar):", errRender);
      }
      return true;
    })();
    return await _loadLock;
  } catch (e) {
    if (!silent) {
      // Si falló /api/sync por 401: hacemos logout forzado y mostramos login.
      try { logout(true); showLoginScreen(); } catch {}
      try {
        const loginErr = document.getElementById("loginError");
        if (loginErr) loginErr.textContent = "⚠️ Error al cargar tus datos: " + e.message;
      } catch {}
    }
    return false;
  } finally {
    _loadLock = null;
  }
}

async function forceSyncUI() {
  try {
    setStatus(document.getElementById("syncStatus") || document.createElement("div"), "⏳ Forzando sincronización completa...", false);
    state.cajasData = null; _cajasLoadLock = null;
    await loadAllData(false, true);
    try { await renderAll(); } catch {}
    setStatus(document.getElementById("syncStatus") || document.createElement("div"), "✅ Sincronizado: " + new Date().toLocaleTimeString("es-ES"), false, true);
    return true;
  } catch (e) {
    setStatus(document.getElementById("syncStatus") || document.createElement("div"), "❌ Error sincronizando. Prueba de nuevo.", true);
    return false;
  }
}

function actualizarBadgeUltimaSync() {
  const el = document.getElementById("ultimaSyncInfo");
  if (!el) return;
  const t = state.ultimaSync ? new Date(state.ultimaSync) : null;
  const txt = t ? `🕒 Sincro: ${t.toLocaleTimeString("es-ES")}` : "⚠️ No sincronizado";
  el.textContent = txt;
  el.title = t ? `Última sincronización: ${t.toLocaleString("es-ES")}. Si no ves las últimas horas/obras pulsa 🔄 Sincronizar.` : "Pulsa 🔄 Sincronizar para traer los últimos datos de la nube.";
}

async function saveTrabajadoresCUD(op, data) {
  if (op === "POST") return await api("/api/trabajadores", { method: "POST", body: JSON.stringify(data) });
  if (op === "PUT") return await api(`/api/trabajadores/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
  if (op === "DELETE") return await api(`/api/trabajadores/${data.id}`, { method: "DELETE" });
}
async function saveObrasCUD(op, data) {
  if (op === "POST") return await api("/api/obras", { method: "POST", body: JSON.stringify(data) });
  if (op === "PUT") return await api(`/api/obras/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
  if (op === "DELETE") return await api(`/api/obras/${data.id}`, { method: "DELETE" });
}
async function saveHorasCUD(op, data) {
  if (op === "POST") return await api("/api/horas", { method: "POST", body: JSON.stringify(data) });
  if (op === "PUT") return await api(`/api/horas/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
  if (op === "DELETE") return await api(`/api/horas/${data.id}`, { method: "DELETE" });
}
async function saveMovCUD(op, data) {
  if (op === "POST") return await api("/api/movimientos", { method: "POST", body: JSON.stringify(data) });
  if (op === "PUT") return await api(`/api/movimientos/${data.id}`, { method: "PUT", body: JSON.stringify(data) });
  if (op === "DELETE") return await api(`/api/movimientos/${data.id}`, { method: "DELETE" });
}
// Alias por si alguien llama al nombre largo (igual que formulario entrega a cuenta):
const saveMovimientoCUD = saveMovCUD;

function bindLoginEvents() {
  document.querySelectorAll(".role-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".role-tab").forEach((t) => t.classList.toggle("active", t === tab));
      const role = tab.dataset.role;
      document.getElementById("loginTrabajadorForm").classList.toggle("hidden", role !== "trabajador");
      document.getElementById("loginAdminForm").classList.toggle("hidden", role !== "admin");
      document.getElementById("loginError").textContent = "";
    });
  });

  document.getElementById("btnLoginAdmin").addEventListener("click", async () => {
    const pin = document.getElementById("loginPinAdmin").value;
    const err = document.getElementById("loginError");
    err.textContent = "⏳ Conectando...";
    if (!(await loginAdmin(pin))) {
      err.textContent = "❌ PIN de administrador incorrecto.";
      return;
    }
    document.getElementById("loginPinAdmin").value = "";
    await afterLoginSuccess();
  });

  document.getElementById("btnLoginTrabajador").addEventListener("click", async () => {
    const tid = document.getElementById("loginTrabajadorSelect").value;
    const pin = document.getElementById("loginPinTrabajador").value;
    const err = document.getElementById("loginError");
    if (!tid) { err.textContent = "⚠️ Selecciona primero tu nombre."; return; }
    err.textContent = "⏳ Conectando...";
    if (!(await loginWorker(tid, pin))) {
      err.textContent = "❌ PIN incorrecto. Pregunta a tu administrador.";
      return;
    }
    document.getElementById("loginPinTrabajador").value = "";
    await afterLoginSuccess();
  });

  document.getElementById("btnLogout").addEventListener("click", () => {
    logout(false);
  });

  const btnFS = document.getElementById("btnForceSync");
  if (btnFS) btnFS.addEventListener("click", () => forceSyncUI());
  const btnFRA = document.getElementById("btnForceRenderAll");
  if (btnFRA) btnFRA.addEventListener("click", async () => {
    try {
      const res = await safeRenderAll(false);
      const okCount = res.filter(x => x.ok).length;
      const totCount = res.length;
      const msg = "💥 Forzado repintado completado: " + okCount + "/" + totCount + " funciones OK.\n\n" + res.map(r => ` ${r.ok?"✅":"❌"} ${r.nombre}${r.error ? " → " + String(r.error.mensaje || "").slice(0,80) : ""}`).join("\n");
      try { alert(msg); } catch {}
    } catch (e) { alert("Fallo al repintar: " + e.message); }
  });
  const btnDC = document.getElementById("btnDiagnosticoCompleto");
  if (btnDC) btnDC.addEventListener("click", async () => {
    const dlg = document.getElementById("informeDiagnosticoDialog");
    const txt = document.getElementById("diagnosticoTextarea");
    const btnCopiar = document.getElementById("btnCopiarDiagnostico");
    const btnOtra = document.getElementById("btnGenerarOtraVez");
    const copiado = document.getElementById("diagnosticoEstadoCopiado");
    if (copiado) copiado.classList.add("hidden");
    txt.value = "⏳ Generando informe completo... espera 3 segundos...";
    try { dlg.showModal(); } catch {}
    const informe = await generarInformeDiagnosticoCompleto();
    txt.value = informe;
    if (btnCopiar && !btnCopiar.dataset.bound) {
      btnCopiar.dataset.bound = "1";
      btnCopiar.addEventListener("click", async () => {
        try {
          txt.select();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(txt.value);
          } else {
            document.execCommand("copy");
          }
          if (copiado) {
            copiado.classList.remove("hidden");
            setTimeout(() => copiado.classList.add("hidden"), 8000);
          }
        } catch (e) { alert("No se pudo copiar al portapapeles: " + e.message + ". Hazlo manualmente."); }
      });
    }
    if (btnOtra && !btnOtra.dataset.bound) {
      btnOtra.dataset.bound = "1";
      btnOtra.addEventListener("click", async () => {
        txt.value = "⏳ Regenerando...";
        txt.value = await generarInformeDiagnosticoCompleto();
      });
    }
  });
  const btnDebugMovil = document.getElementById("btnDebugMovil");
  if (btnDebugMovil) btnDebugMovil.addEventListener("click", async () => {
    try {
      forzarConsistenciaLogin(); // comprobar antes de NADA si tenemos token
      if (!getToken() || !state.session?.role) {
        // ⚠️ CASO ESPECIAL GRAVE: SIN TOKEN = no estás loggeado (causa datos a 0).
        // Mostramos mensaje CLARO (no el críptico "motivo: sin token"):
        const linesIntro = [
          "═══════════════════════════════════════════",
          "⚠️  CAUSA DE QUE LOS DATOS ESTÉN A 0:",
          "═══════════════════════════════════════════",
          "❌ NO ESTÁS LOGGEADO (NO HAY TOKEN GUARDADO).",
          "",
          "Sin iniciar sesión el servidor NUNCA te envía datos.",
          "Tu móvil perdió el token al cerrar el navegador, limpiar caché o pasar mucho tiempo.",
          "",
          "✅ SOLUCIÓN 10 SEGUNDOS:",
          "1) Cierra este mensaje pulsando [Cancelar].",
          "2) Pulsa el botón ROJO GRANDE que aparece ARRIBA del todo en la app.",
          "   O pulsa 🚪 SALIR (arriba a la derecha).",
          "3) Aparecerá el login: introduce tu PIN:",
          "   · Si eres ADMIN: PIN admin 1234 (o el tuyo personalizado).",
          "   · Si eres TRABAJADOR: elige tu nombre + tu PIN de 4 dígitos.",
          "4) Entra y vuelve a pulsar 📱 Debug Móvil: todo OK.",
          "",
          "Pulsa [Aceptar] si quieres ir directamente al Login ahora.",
        ];
        const okIrLogin = confirm(linesIntro.join("\n"));
        if (okIrLogin) {
          logout(true); showLoginScreen();
        }
        return; // no seguir con pruebas, sería inútil
      }
      // Cargar últimos errores del storage (si hay):
      try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.ULTIMO_ERROR) || "[]");
        stored.forEach(e => { if (!ULTIMOS_ERRORES_FETCH.find(x => x.fecha === e.fecha)) ULTIMOS_ERRORES_FETCH.push(e); });
        if (ULTIMOS_ERRORES_FETCH.length > 15) ULTIMOS_ERRORES_FETCH.length = 15;
      } catch {}

      // 🧪 PRUEBA 1: LLAMADA BRUTA A /api/health/diagnostico (PÚBLICO, SIN AUTH, SIN CACHÉ) → CONTADORES REALES TURSO
      setStatus(document.getElementById("syncStatus"), "🔍 Consultando BBDD REAL...", false);
      let healthResp = null, healthError = null, syncResp = null, syncError = null;
      try {
        const u = new URL(API_BASE + "/api/health/diagnostico", window.location.origin);
        u.searchParams.set("_t", `${Date.now()}_${Math.random().toString(36).slice(2,9)}`);
        const r = await fetch(u.toString(), {
          method: "GET", headers: { "Cache-Control": "no-store", "Pragma": "no-cache", "Accept": "application/json" },
          cache: "no-store", redirect: "follow",
        });
        healthResp = await r.json();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(healthResp)}`);
      } catch (e) { healthError = e.message; }

      // 🧪 PRUEBA 2: LLAMADA BRUTA A /api/sync (CON AUTH, SIN CACHÉ) → LO QUE VE ESTE USUARIO ACTUALMENTE
      if (getToken()) {
        try {
          const u = new URL(API_BASE + "/api/sync", window.location.origin);
          u.searchParams.set("_t", `${Date.now()}_${Math.random().toString(36).slice(2,9)}`);
          const r = await fetch(u.toString(), {
            method: "GET",
            headers: {
              "Cache-Control": "no-store", "Pragma": "no-cache", "Accept": "application/json",
              "Authorization": "Bearer " + getToken(),
            },
            cache: "no-store", redirect: "follow",
          });
          syncResp = await r.json();
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${syncResp?.error || JSON.stringify(syncResp||"").slice(0,200)}`);
        } catch (e) { syncError = e.message; }
      }

      const t = state.ultimaSync ? new Date(state.ultimaSync).toLocaleString("es-ES") : "NUNCA";
      const totalDatos = (state.trabajadores.length) + (state.obras.length) + (state.horas.length) + (state.movimientos.length);
      const lines = [
        "══════════════════════════════════════════",
        "📱  INFORME DE DIAGNÓSTICO APP",
        "══════════════════════════════════════════",
        `Modo móvil detectado: ${IS_MOBILE ? "✅ SÍ (optimizado)" : "❌ NO (modo PC)"}`,
        `Navegador / SO: ${(navigator.userAgent||"").slice(0,60)}`,
        `Conexión: ${navigator.onLine ? "✅ ONLINE" : "❌ SIN INTERNET"} ${navigator.connection && navigator.connection.effectiveType ? " ("+navigator.connection.effectiveType+")" : ""}`,
        `Token JWT guardado: ${getToken() ? "✅ SÍ ("+String(getToken()).length+" chars)" : "❌ NO (tienes que iniciar sesión)"}`,
        `Rol sesión: ${state.session?.role === "admin" ? "👑 ADMIN" : state.session?.role === "worker" ? "👷 TRABAJADOR" : "❌ NINGÚN (NO LOGGEADO → datos 0)"}`,
        `ID trabajador sesión: ${state.session?.trabajadorId || "—"}`,
        `Última sincro EXITOSA: ${t}`,
        ``,
        "══════════════════════════════════════════",
        "🧪 PRUEBA 1: /api/health/diagnostico (BBDD REAL, SIN LOGIN)",
        "══════════════════════════════════════════",
      ];
      if (healthResp && healthResp.ok) {
        lines.push(`✅ Motor: ${healthResp.motor} ${healthResp.warning ? "\n   ⚠️ "+healthResp.warning : ""}`);
        lines.push(`   Hora servidor: ${new Date(healthResp.timestamp).toLocaleString("es-ES")}`);
        lines.push(`   Tablas REALES EN LA BBDD (Turso/SQL):`);
        lines.push(`   · 👷 Trabajadores: ${healthResp.tables.trabajadores}`);
        lines.push(`   · 🏢 Obras:        ${healthResp.tables.obras}`);
        lines.push(`   · ⏰ Horas:        ${healthResp.tables.horas}`);
        lines.push(`   · 💵 Movimientos:  ${healthResp.tables.movimientos} (Ingresos: ${healthResp.movimientosPorTipo.ingreso||0}, Gastos: ${healthResp.movimientosPorTipo.gasto||0})`);
        const totalReal = healthResp.tables.trabajadores + healthResp.tables.obras + healthResp.tables.horas + healthResp.tables.movimientos;
        lines.push(`   · TOTAL REAL: ${totalReal} ${totalReal === 0 ? "⚠️ (LA BASE DE DATOS REALMENTE ESTÁ VACÍA! Los datos NUNCA se guardaron en Turso!)" : "✅ (>0 hay datos)"}`);
        // NUEVO: ESTADO SAFE RENDER DE CADA FUNCIÓN:
        const keys = Object.keys(RENDER_STATUS.ultimos || {});
        if (keys.length) {
          lines.push("");
          lines.push("   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          lines.push("   🎨 ESTADO DE CADA FUNCIÓN DE RENDER (SAFE RENDER NIVEL 9999):");
          let cntOK = 0, cntErr = 0;
          keys.forEach(k => {
            const r = RENDER_STATUS.ultimos[k];
            if (!r) return;
            if (r.ok) { cntOK++; lines.push(`      ✅ ${String(k).padEnd(30," ")} · ${r.ms||0}ms OK`); }
            else { cntErr++; lines.push(`      ❌ ${String(k).padEnd(30," ")} · FALLÓ → ${String(r.error?.mensaje||"").slice(0,120)}`); }
          });
          lines.push(`      Resumen: ✅ ${cntOK} OK  · ❌ ${cntErr} FALLADOS`);
          lines.push("   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          if (cntErr>0) lines.push("   👉 SOLUCIÓN: pulsa 💥 FORZAR REPINTAR TODO (rojo, navbar) → si sigue ❌ pégame este informe para arreglarlo al instante!");
        }
        // Muestras sin hardcodear nombres de columnas!
        function mostrarF(fila, max=18) {
          return Object.entries(fila || {}).map(([k,v]) => {
            const c = String(k).padEnd(max, " ").slice(0, max);
            let val = (v === null || v === undefined) ? "null" : String(v);
            if (val.length > 50) val = val.slice(0, 50) + "...";
            return `${c}=${val}`;
          }).join(" | ");
        }
        function agregarMuestras(titulo, arr) {
          if (!arr || !arr.length) return;
          lines.push(`\n   🧪 Muestras - ${titulo}:`);
          arr.forEach((f, i) => {
            if (f._error) lines.push(`      ${i+1}) ❌ ERROR: ${String(f._error).slice(0,200)}`);
            else lines.push(`      ${i+1}) ${mostrarF(f)}`);
          });
        }
        if (healthResp.muestras) {
          agregarMuestras("Trabajadores (últimos 3)", healthResp.muestras.ultimos3Trabajadores);
          agregarMuestras("Obras (últimas 3)",        healthResp.muestras.ultimas3Obras);
          agregarMuestras("Horas (últimas 3)",        healthResp.muestras.ultimas3Horas);
          agregarMuestras("Movimientos (últimos 3)",  healthResp.muestras.ultimos3Mov);
        }
      } else {
        lines.push(`❌ NO SE PUDO CONSULTAR LA BBDD REAL:`);
        lines.push(`   Motivo: ${String(healthError || "desconocido").slice(0, 400)}`);
      }
      lines.push("");
      lines.push("══════════════════════════════════════════");
      lines.push("🧪 PRUEBA 2: /api/sync BRUTO (CON TU USUARIO ACTUAL)");
      lines.push("══════════════════════════════════════════");
      if (syncResp) {
        const rT = Number(syncResp._realTrabajadoresEnBBDD || 0), rO = Number(syncResp._realObrasEnBBDD || 0);
        const rH = Number(syncResp._realHorasEnBBDD || 0), rM = Number(syncResp._realMovEnBBDD || 0);
        const fT = Array.isArray(syncResp.trabajadores) ? syncResp.trabajadores.length : 0;
        const fO = Array.isArray(syncResp.obras) ? syncResp.obras.length : 0;
        const fH = Array.isArray(syncResp.horas) ? syncResp.horas.length : 0;
        const fM = Array.isArray(syncResp.movimientos) ? syncResp.movimientos.length : 0;
        // NUEVO: MOSTRAR EL TESTIGO DEL SERVIDOR DIAGNOSTICO PERMISOS (dice TODO):
        if (syncResp.diagnosticoPermisos) {
          lines.push("\n   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          lines.push("   🔍 DIAGNÓSTICO DEL SERVIDOR (TESTIGO INQUEBRANTABLE):");
          lines.push(String(syncResp.diagnosticoPermisos).split("\n").map(l => "   " + l).join("\n"));
          lines.push("   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        }
        function compara(nom, bbdd, front) {
          const ok = bbdd === front;
          return `   · ${nom}: BBDD=${bbdd}  Recibidos tú=${front}  ${ok ? "✅ COINCIDE" : "❌ NO COINCIDE (¡causa del fallo!)"}`;
        }
        lines.push(compara("👷 Trabajadores", rT, fT));
        lines.push(compara("🏢 Obras", rO, fO));
        lines.push(compara("⏰ Horas", rH, fH));
        lines.push(compara("💵 Movimientos", rM, fM));
        const user = syncResp.currentUser;
        lines.push(`\n   👤 Rol según el servidor: ${user?.role || "—"} (TrabajadorID: ${user?.trabajadorId || "—"})`);
        lines.push(`   📅 Hora resp servidor: ${new Date(syncResp.generadoEn).toLocaleString("es-ES")}`);
        if (rT + rO + rH + rM > 0 && fT + fO + fH + fM === 0) {
          lines.push("\n   ❌ FALLO GRAVE DETECTADO: La BBDD TIENE DATOS pero tú recibes array vacío.");
          lines.push("      → CAUSA TÍPICA: estás en modo trabajador pero solo hay un usuario PIN admin. Entra ADMIN si es tu cuenta.");
        }
      } else {
        lines.push(`❌ NO PUDIMOS HACER /api/sync (¿no tienes token o falló auth?):`);
        lines.push(`   Motivo: ${String(syncError || "sin token").slice(0,200)}`);
      }

      lines.push("", "══════════════════════════════════════════", "📊 DATOS ACTUALES EN LA MEMORIA DE ESTA APP (frontend)");
      lines.push("══════════════════════════════════════════");
      lines.push(`   · Trabajadores: ${state.trabajadores.length}`);
      lines.push(`   · Obras:        ${state.obras.length}`);
      lines.push(`   · Horas:        ${state.horas.length}`);
      lines.push(`   · Movimientos:  ${state.movimientos.length}`);
      lines.push(`   · TOTAL:        ${totalDatos} ${totalDatos===0 ? "⚠️ (0 = NO HAY DATOS CARGADOS)" : "✅ (>0 hay datos)"}`);

      if (ULTIMOS_ERRORES_FETCH.length) {
        lines.push("", "══════════════════════════════════════════", "❌ ÚLTIMOS " + ULTIMOS_ERRORES_FETCH.length + " ERRORES DETECTADOS:", "══════════════════════════════════════════");
        ULTIMOS_ERRORES_FETCH.slice(0,8).forEach((e, i) => {
          lines.push(`${i+1}) [${new Date(e.fecha).toLocaleString("es-ES")}] ${e.url} → HTTP ${e.status}`);
          lines.push(`      Motivo: ${String(e.body||"").slice(0,200)}`);
        });
      } else lines.push("", "✅ No hay errores HTTP registrados. Todo OK.");

      lines.push("", "══════════════════════════════════════════", "✅ PASOS PARA SOLUCIONARLO AHORA:", "══════════════════════════════════════════");
      if (healthResp?.ok && (healthResp.tables.trabajadores + healthResp.tables.obras + healthResp.tables.horas + healthResp.tables.movimientos) === 0) {
        lines.push("👉 DIAGNÓSTICO DEFINITIVO: ❌ LA BBDD EN TURSO ESTÁ VACÍA (no es el móvil!). Por tanto:");
        lines.push("1. Los datos NUNCA se guardaron en Turso.");
        lines.push("2. Tienes que revisar: ¿añadiste TURSO_DATABASE_URL y TURSO_AUTH_TOKEN en Render Environment?");
        lines.push("3. Si NO lo añadiste: Render usa SQLite LOCAL EFÍMERO, que se borra al redeployear.");
      } else {
        lines.push("👉 Si BBDD dice >0 pero tu app dice 0 (datos en servidor sí, tú no lo ves):");
        lines.push("1. 🚪 Pulsa SALIR (arriba a la derecha) y entra de NUEVO con PIN.");
        lines.push("2. Si sigues sin ver, pulsa [Aceptar] más abajo → Hard Reset Caché + Recargar.");
        lines.push("3. Si el rol es 'worker' (trabajador) pero deberías ver 'admin': entra con PIN ADMIN (1234 por defecto).");
      }

      const msg = lines.join("\n");
      setStatus(document.getElementById("syncStatus"), "✅ Diagnóstico finalizado", false);
      const elegido = confirm(msg + "\n\n══════════════════════════════════════════\n¿Quieres ejecutar HARD RESET CACHÉ ahora?\n[Aceptar] = Reset total (limpia todo)\n[Cancelar] = No hacer nada.");
      if (!elegido) return;
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try { if (caches && caches.keys) { (await caches.keys()).forEach(k => caches.delete(k)); } } catch {}
      setStatus(document.getElementById("syncStatus"), "🔄 Limpiando caché y recargando...", false);
      setTimeout(() => window.location.reload(), 900);
    } catch (e) { alert("Error depuración: " + e.message); }
  });
}

async function afterLoginSuccess() {
  document.getElementById("loginError").textContent = "📥 Cargando datos...";
  const ok = await loadAllData(false, true);
  document.getElementById("loginError").textContent = "";
  applyRoleUI();
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appMain").classList.remove("hidden");
  if (ok) {
    if (isAdmin()) try { comprobarPerdidaDatosPotencial(); } catch {}
    try { await renderAll(); } catch {}
  }
}

function comprobarPerdidaDatosPotencial() {
  const info = state.backupAutoInfo || null;
  if (!info || !info.resumen) return;
  const totalActual =
    (state.trabajadores||[]).length +
    (state.obras||[]).length +
    (state.horas||[]).length +
    (state.movimientos||[]).length;
  const totalBackup =
    Number(info.resumen.trabajadores||0) +
    Number(info.resumen.obras||0) +
    Number(info.resumen.horas||0) +
    Number(info.resumen.movimientos||0);
  const banner = document.getElementById("warningBackupBanner");
  if (!banner) return;
  if (totalActual <= 2 && totalBackup >= 3) {
    banner.classList.remove("hidden");
    const r = info.resumen;
    const fecha = new Date(info.generadoEn);
    const txt = `⚠️ <b>POSIBLE PÉRDIDA DE DATOS DETECTADA:</b> Backup anterior del <b>${fecha.toLocaleString("es-ES")}</b> → ${r.trabajadores||0} trabajadores, ${r.obras||0} obras, ${r.horas||0} horas, ${r.movimientos||0} movimientos. AHORA TIENES ${totalActual} registros (${totalActual===0?"BBDD VACÍA":"muy pocos datos"}). Pulsa el botón naranja para RECUPERAR LOS DATOS:`;
    const span = banner.querySelector("span");
    if (span) span.innerHTML = txt;
    console.warn("[WARN] Posible pérdida datos detectada:", { actual: totalActual, backup: totalBackup, info });
  } else {
    banner.classList.add("hidden");
  }
}

/* ============ CARGA / GUARDADO DATOS ============ */
/* (loadAllData se definió antes como async con llamada a /api/sync) */


/* ============ TRABAJADORES (ADMIN) ============ */
function clearTrabajadorForm() {
  ["trabajadorId","trabajadorNombre","trabajadorPin","trabajadorDni","trabajadorTelefono",
   "trabajadorTarifa","trabajadorTarifaExtra","trabajadorCategoria"].forEach((id) => els[id].value = "");
  els.trabajadorActivo.value = "true";
  els.trabajadorRol.value = "trabajador";
  els.btnGuardarTrabajador.textContent = "💾 Guardar Trabajador";
}
function fillTrabajadorForm(t) {
  els.trabajadorId.value = t.id;
  els.trabajadorNombre.value = t.nombre || "";
  els.trabajadorPin.value = t.pin || "";
  els.trabajadorRol.value = t.rol || "trabajador";
  els.trabajadorDni.value = t.dni || "";
  els.trabajadorTelefono.value = t.telefono || "";
  els.trabajadorTarifa.value = t.tarifa != null ? t.tarifa : "";
  els.trabajadorTarifaExtra.value = t.tarifaExtra != null ? t.tarifaExtra : "";
  els.trabajadorCategoria.value = t.categoria || "";
  els.trabajadorActivo.value = t.activo !== false ? "true" : "false";
  els.btnGuardarTrabajador.textContent = "✅ Actualizar Trabajador";
}

async function onSubmitTrabajador(e) {
  e.preventDefault();
  const id = els.trabajadorId.value || null;
  const pin = els.trabajadorPin.value.trim();
  const tarifa = Number(els.trabajadorTarifa.value) || 0;
  const tarifaExtraRaw = Number(els.trabajadorTarifaExtra.value);
  const tarifaExtra = isNaN(tarifaExtraRaw) || tarifaExtraRaw === 0 ? tarifa : tarifaExtraRaw;

  const data = {
    id: id || undefined,
    nombre: els.trabajadorNombre.value.trim(),
    pin,
    rol: els.trabajadorRol.value || "trabajador",
    dni: els.trabajadorDni.value.trim(),
    telefono: els.trabajadorTelefono.value.trim(),
    tarifa,
    tarifaExtra,
    categoria: els.trabajadorCategoria.value.trim(),
    activo: els.trabajadorActivo.value === "true",
  };

  if (!data.nombre) { setStatus(els.trabajadorStatus, "El nombre es obligatorio", true); return; }
  if (!pin || pin.length < 3) { setStatus(els.trabajadorStatus, "El PIN debe tener al menos 3 dígitos", true); return; }
  if (tarifa < 0) { setStatus(els.trabajadorStatus, "La tarifa base no puede ser negativa", true); return; }

  try {
    if (id) {
      await saveTrabajadoresCUD("PUT", { ...data, id });
      setStatus(els.trabajadorStatus, "✅ Trabajador actualizado", false, true);
    } else {
      await saveTrabajadoresCUD("POST", data);
      setStatus(els.trabajadorStatus, `✅ Guardado. PIN de ${data.nombre}: ${pin}`, false, true);
    }
    clearTrabajadorForm();
    state.cajasData = null;
    await loadAllData();
    renderLoginSelect();
    renderTrabajadores();
    renderSelects();
    populateResponsablesSelect();
    renderDashboard();
    if (isWorker()) renderWorkerSummary();
    if (isAdmin()) try { await renderCajas(); } catch {}
  } catch (err) {
    setStatus(els.trabajadorStatus, "❌ " + err.message, true);
  }
}

async function deleteTrabajador(id) {
  const t = getTrabajadorById(id);
  if (!t) return;
  const horasCount = state.horas.filter((h) => h.trabajadorId === id).length;
  let msg = `¿Eliminar a ${t.nombre}?`;
  if (horasCount > 0) msg += `\n⚠️ Tiene ${horasCount} registros de horas asociados. Se dará de baja (no se elimina).`;
  if (!(await confirmAction("Eliminar Trabajador", msg))) return;
  try {
    await saveTrabajadoresCUD("DELETE", { id });
    state.cajasData = null;
    await loadAllData();
    renderLoginSelect();
    renderTrabajadores();
    renderSelects();
    populateResponsablesSelect();
    renderDashboard();
    renderHoras();
    if (isAdmin()) try { await renderCajas(); } catch {}
  } catch (err) {
    alert("❌ " + err.message);
  }
}

function renderTrabajadores() {
  const q = state.filtros.buscarTrabajador.trim().toLowerCase();
  const desde = state.filtros.trabajadoresDesde || startOfMonthISO();
  const hasta = state.filtros.trabajadoresHasta || todayISO();

  const lista = state.trabajadores
    .filter((t) => {
      if (!q) return true;
      return (t.nombre || "").toLowerCase().includes(q) || (t.dni || "").toLowerCase().includes(q) || (t.categoria || "").toLowerCase().includes(q);
    })
    .sort((a, b) => { if (a.activo !== b.activo) return a.activo ? -1 : 1; return (a.nombre || "").localeCompare(b.nombre || "", "es"); });

  const ul = els.listaTrabajadores;
  ul.innerHTML = "";
  if (lista.length === 0) {
    ul.innerHTML = `<li class="empty-notice"><span class="emoji">👷</span>No hay trabajadores registrados. Crea el primero asignándole un PIN para que pueda entrar.</li>`;
    return;
  }

  lista.forEach((t) => {
    const horasPeriodo = state.horas
      .filter((h) => h.trabajadorId === t.id && (h.fecha||"") >= desde && (h.fecha||"") <= hasta)
      .reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
    const devengado = state.horas
      .filter((h) => h.trabajadorId === t.id && (h.fecha||"") >= desde && (h.fecha||"") <= hasta)
      .reduce((s, h) => s + (Number(h.costeTotal) || 0), 0);
    const entregasCuenta = state.movimientos
      .filter((m) =>
        m.responsableId === t.id &&
        m.tipo === "gasto" &&
        (m.fecha||"") >= desde && (m.fecha||"") <= hasta &&
        ["nomina","prestamo","adelanto","entrega_a_cuenta","reembolso"].includes(String(m.categoria||"general").toLowerCase())
      )
      .reduce((s,m)=> s + (Number(m.importe)||0), 0);
    const netoAPagar = Number(devengado - entregasCuenta).toFixed(2);
    const signoNeto = Number(netoAPagar);

    const li = document.createElement("li");
    li.className = "item";
    li.style.borderLeft = ".5rem solid " + (t.activo ? "#16a34a" : "#94a3b8");
    const esAdmin = t.rol === "admin";
    const badgeNetoColor = signoNeto < 0 ? "#be123c" : (signoNeto > 0 ? "#047857" : "#475569");
    li.innerHTML = `
      <div class="item-header" style="gap:.7rem;">
        <div style="flex:1;min-width:260px;">
          <h4>${escapeHtml(t.nombre)} ${esAdmin ? '<span style="font-size:.85rem;background:#fef3c7;color:#92400e;border-radius:.4rem;padding:.1rem .35rem;border:1px solid #fcd34d;">👑 Socio/Admin</span>' : ""}</h4>
          <div class="meta-tags">
            <span class="tag estado-${t.activo ? "activo" : "inactivo"}">${t.activo ? "✅ Activo" : "❌ Inactivo"}</span>
            ${esAdmin ? `<span class="tag tipo-ingreso">👑 ADMIN</span>` : `<span class="tag categoria">👷 Trabajador</span>`}
            ${t.categoria ? `<span class="tag categoria">${escapeHtml(t.categoria)}</span>` : ""}
            <span class="tag categoria">🔐 PIN: ${escapeHtml(t.pin || "-")}</span>
            <span class="tag categoria">💶 Base ${formatMoney(t.tarifa)}/h · Extra ${formatMoney(t.tarifaExtra || t.tarifa)}/h</span>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(120px,auto));gap:.35rem .7rem;text-align:right;min-width:360px;">
          <div style="font-size:.85rem;color:#334155;">⏱️ Horas periodo:</div>
          <div style="font-weight:700;">${horasPeriodo.toFixed(1)} h</div>
          <div style="font-size:.85rem;color:#334155;">💼 Horas Devengadas:</div>
          <div style="font-weight:700;color:#0f766e;">${formatMoney(devengado)}</div>
          <div style="font-size:.85rem;color:#334155;">💸 Entregas a Cuenta (adelantos):</div>
          <div style="font-weight:700;color:#be123c;">${formatMoney(entregasCuenta)}</div>
          <div style="font-size:.85rem;color:#334155;font-weight:600;">🧾 NETO A PAGAR:</div>
          <div style="font-weight:900;font-size:1.05rem;color:${badgeNetoColor};background:${signoNeto<0?"#fff1f2":"#ecfdf5"};padding:.15rem .5rem;border-radius:.4rem;border:1px solid ${badgeNetoColor};">${signoNeto>=0?"+ ":""}${formatMoney(netoAPagar)} ${signoNeto<0 ? " (ÉL TE DEBE)":(signoNeto>0?" (TE DEBES A ÉL)":"")}</div>
        </div>
      </div>
      <p style="margin:.35rem 0 .55rem;color:#475569;font-size:.9rem;">
        ${t.dni ? `📋 ${escapeHtml(t.dni)}` : ""}${t.telefono ? ` · 📞 ${escapeHtml(t.telefono)}` : ""}${t.email ? ` · ✉️ ${escapeHtml(t.email)}` : ""}${t.direccion ? ` · 🏠 ${escapeHtml(t.direccion)}` : ""}
      </p>
      <div class="item-actions" style="gap:.4rem;flex-wrap:wrap;">
        <button class="btn small danger" style="background:#be123c;border-color:#9f1239;" data-entrega-cuenta="${t.id}">💸 Entregar a Cuenta (Adelanto)</button>
        <button class="btn small primary" data-edit-trabajador="${t.id}">✏️ Editar</button>
        <button class="btn small ghost" data-ver-caja="${t.id}">🧾 Ver Movimientos Caja</button>
        <button class="btn small danger" data-del-trabajador="${t.id}">🗑️ Eliminar</button>
      </div>`;
    ul.appendChild(li);
  });

  ul.querySelectorAll("[data-edit-trabajador]").forEach((b) =>
    b.addEventListener("click", () => { const t = getTrabajadorById(b.dataset.editTrabajador); if (t) { fillTrabajadorForm(t); window.scrollTo({ top: 0, behavior: "smooth" }); } }));
  ul.querySelectorAll("[data-del-trabajador]").forEach((b) =>
    b.addEventListener("click", () => deleteTrabajador(b.dataset.delTrabajador)));
  ul.querySelectorAll("[data-entrega-cuenta]").forEach((b) =>
    b.addEventListener("click", () => abrirEntregaCuenta(b.dataset.entregaCuenta)));
  ul.querySelectorAll("[data-ver-caja]").forEach((b) =>
    b.addEventListener("click", () => {
      state.filtros.cajas.selectedTrabajadorId = b.dataset.verCaja;
      activateTab("cajas");
      try { refreshCajasFull(); } catch {}
    }));
}

function abrirEntregaCuenta(trabajadorId) {
  const t = getTrabajadorById(trabajadorId);
  if (!t) return;
  const dlg = document.getElementById("entregaCuentaDialog");
  if (!dlg) return;
  document.getElementById("ecTrabajadorId").value = t.id;
  const nom = document.getElementById("ecTrabajadorNombre");
  nom.textContent = `👷 Trabajador: ${t.nombre} · PIN: ${t.pin} · Puesto: ${t.categoria||"—"}`;
  document.getElementById("ecFecha").value = todayISO();
  document.getElementById("ecImporte").value = "";
  document.getElementById("ecConcepto").value = "Adelanto nómina mes en curso";
  document.getElementById("ecStatus").textContent = "";
  // ⬇️ NUEVO: Rellenar select "👑 Entregado Por (MI CAJA / Admin que paga)"
  //   · Opciones = TODOS los trabajadores que son ADMIN / SOCIO.
  //   · Por defecto: seleccionamos el USUARIO ADMIN ACTUAL que está loggeado.
  const ecR = document.getElementById("ecRealizadoPorId");
  if (ecR) {
    const u = state.session?.user || null;
    const admins = (state.trabajadores || []).filter(x => String(x.rol || "").toLowerCase() === "admin" || String(x.rol || "").toLowerCase() === "socio");
    // Si no hay admins, mostrar todos los trabajadores:
    const opciones = admins.length > 0 ? admins : (state.trabajadores || []);
    const yoId = (u?.userId) || (u?.trabajadorId) || null;
    let selHTML = `<option value="">(Yo, el admin actual)</option>` +
      opciones.map(a => `<option value="${a.id}" ${a.id === yoId ? "selected" : ""}>👑 ${escapeHtml(a.nombre)} (${escapeHtml(a.rol || "admin/socio")})</option>`).join("");
    if (yoId && !opciones.some(x => x.id === yoId)) {
      // Si el usuario actual NO está en la lista (puede ser admin generico) lo añadimos al PRINCIPIO seleccionado:
      selHTML = `<option value="">(Yo, el admin actual)</option>
        <option value="${yoId}" selected>👑 (Tú, Admin actual)</option>` +
        opciones.map(a => `<option value="${a.id}">👑 ${escapeHtml(a.nombre)} (${escapeHtml(a.rol || "admin/socio")})</option>`).join("");
    }
    ecR.innerHTML = selHTML;
  }
  const sel = document.getElementById("ecObraId");
  sel.innerHTML = `<option value="">Sin asignar (general / nómina)</option>` +
    state.obras.map(o => `<option value="${o.id}">🏢 ${escapeHtml(o.nombre)} · ${escapeHtml(o.cliente||"")}</option>`).join("");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else alert("Tu navegador no soporta diálogos nativos. Usa Contabilidad → Nuevo Gasto, categoría nómina, Responsable = trabajador.");
}

/* ============ OBRAS (ADMIN) ============ */
function clearObraForm() {
  ["obraId","obraNombre","obraCliente","obraDireccion","obraPresupuesto","obraFechaInicio","obraFechaFin","obraNotas"].forEach((id) => els[id].value = "");
  els.obraEstado.value = "curso";
  els.btnGuardarObra.textContent = "💾 Guardar Obra";
}
function fillObraForm(o) {
  els.obraId.value = o.id;
  els.obraNombre.value = o.nombre || "";
  els.obraCliente.value = o.cliente || "";
  els.obraDireccion.value = o.direccion || "";
  els.obraPresupuesto.value = o.presupuesto != null ? o.presupuesto : "";
  els.obraFechaInicio.value = o.fechaInicio || "";
  els.obraFechaFin.value = o.fechaFin || "";
  els.obraEstado.value = o.estado || "curso";
  els.obraNotas.value = o.notas || "";
  els.btnGuardarObra.textContent = "✅ Actualizar Obra";
}
function calcularCosteObra(obraId) {
  return state.horas.filter((h) => h.obraId === obraId).reduce((s, h) => s + (Number(h.costeTotal) || 0), 0);
}
function calcularIngresosObra(obraId) {
  return state.movimientos.filter((m) => m.obraId === obraId && m.tipo === "ingreso").reduce((s, m) => s + (Number(m.importe) || 0), 0);
}
function calcularGastosObra(obraId) {
  const gastosMov = state.movimientos.filter((m) => m.obraId === obraId && m.tipo === "gasto").reduce((s, m) => s + (Number(m.importe) || 0), 0);
  return gastosMov + calcularCosteObra(obraId);
}

async function onSubmitObra(e) {
  e.preventDefault();
  const id = els.obraId.value || null;
  const data = {
    id: id || undefined,
    nombre: els.obraNombre.value.trim(),
    cliente: els.obraCliente.value.trim(),
    direccion: els.obraDireccion.value.trim(),
    presupuesto: Number(els.obraPresupuesto.value) || 0,
    fechaInicio: els.obraFechaInicio.value || "",
    fechaFin: els.obraFechaFin.value || "",
    estado: els.obraEstado.value || "curso",
    notas: els.obraNotas.value.trim(),
  };
  if (!data.nombre || !data.cliente) { setStatus(els.obraStatus, "Nombre y cliente son obligatorios", true); return; }
  try {
    if (id) {
      await saveObrasCUD("PUT", { ...data, id });
      setStatus(els.obraStatus, "✅ Obra actualizada", false, true);
    } else {
      await saveObrasCUD("POST", data);
      setStatus(els.obraStatus, "✅ Obra guardada", false, true);
    }
    clearObraForm();
    state.cajasData = null;
    await loadAllData();
    renderObras();
    renderSelects();
    populateResponsablesSelect();
    renderDashboard();
    renderBalanceGeneral();
    if (isWorker()) populateWorkerQuickForm();
    if (isAdmin()) try { await renderCajas(); } catch {}
  } catch (err) {
    setStatus(els.obraStatus, "❌ " + err.message, true);
  }
}

async function deleteObra(id) {
  const o = getObraById(id); if (!o) return;
  const horasCount = state.horas.filter((h) => h.obraId === id).length;
  const movCount = state.movimientos.filter((m) => m.obraId === id).length;
  let msg = `¿Eliminar obra "${o.nombre}"?`;
  if (horasCount > 0) msg += `\n⚠️ ${horasCount} registros de horas.`;
  if (movCount > 0) msg += `\n⚠️ ${movCount} movimientos.`;
  if (!(await confirmAction("Eliminar Obra", msg))) return;
  try {
    await saveObrasCUD("DELETE", { id });
    state.cajasData = null;
    await loadAllData();
    renderObras();
    renderSelects();
    populateResponsablesSelect();
    renderDashboard();
    renderBalanceGeneral();
    if (isWorker()) populateWorkerQuickForm();
    if (isAdmin()) try { await renderCajas(); } catch {}
  } catch (err) { alert("❌ " + err.message); }
}

function renderObras() {
  const q = state.filtros.buscarObra.trim().toLowerCase();
  const ef = state.filtros.filtroEstadoObra;
  const lista = state.obras
    .filter((o) => {
      if (ef !== "todos" && o.estado !== ef) return false;
      if (!q) return true;
      return (o.nombre || "").toLowerCase().includes(q) || (o.cliente || "").toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const order = { pendiente: 0, curso: 1, finalizada: 2, cancelada: 3 };
      if ((order[a.estado] ?? 99) !== (order[b.estado] ?? 99)) return (order[a.estado] ?? 99) - (order[b.estado] ?? 99);
      return (a.nombre || "").localeCompare(b.nombre || "", "es");
    });

  const ul = els.listaObras; ul.innerHTML = "";
  if (lista.length === 0) {
    ul.innerHTML = `<li class="empty-notice"><span class="emoji">🏢</span>No hay obras. Crea la primera para que los trabajadores puedan seleccionarla.</li>`;
    return;
  }
  lista.forEach((o) => {
    const est = ESTADOS_OBRA[o.estado] || ESTADOS_OBRA.pendiente;
    const ingresos = calcularIngresosObra(o.id); const gastos = calcularGastosObra(o.id);
    const beneficio = ingresos - gastos;
    const horas = state.horas.filter((h) => h.obraId === o.id).reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
    const ppto = Number(o.presupuesto) || 0;
    const porcentajePpto = ppto > 0 ? Math.min(100, (gastos / ppto) * 100) : 0;
    const pptoClase = porcentajePpto > 100 ? "bad" : porcentajePpto > 80 ? "warn" : "good";
    const li = document.createElement("li");
    li.className = "item";
    li.style.borderLeftColor = o.estado === "curso" ? "#ea580c" : o.estado === "finalizada" ? "#16a34a" : "#94a3b8";
    li.innerHTML = `
      <div class="item-header">
        <div>
          <h4>${escapeHtml(o.nombre)}</h4>
          <div class="meta-tags">
            <span class="tag ${est.clase}">${est.label}</span>
            ${o.cliente ? `<span class="tag categoria">👤 ${escapeHtml(o.cliente)}</span>` : ""}
          </div>
        </div>
        <div style="text-align:right;">
          <div class="amount ${beneficio >= 0 ? "ingreso" : "gasto"}">${beneficio >= 0 ? "+" : ""}${formatMoney(beneficio)}</div>
          <p style="margin:0;font-size:.85rem;">Beneficio neto</p>
        </div>
      </div>
      ${o.direccion ? `<p>📍 ${escapeHtml(o.direccion)}</p>` : ""}
      ${o.fechaInicio || o.fechaFin ? `<p>📅 ${formatDate(o.fechaInicio)} → ${formatDate(o.fechaFin)}</p>` : ""}
      ${o.notas ? `<p>📝 ${escapeHtml(o.notas)}</p>` : ""}
      <div class="obra-resumen-grid">
        <div class="obra-resumen-item">Presupuesto<strong>${formatMoney(ppto)}</strong>
          <div class="progreso-bar"><div class="progreso-fill ${pptoClase}" style="width:${porcentajePpto}%"></div></div>
          <span style="font-size:.78rem;color:var(--muted);">Gastado: ${formatMoney(gastos)} (${porcentajePpto.toFixed(1)}%)</span>
        </div>
        <div class="obra-resumen-item">📥 Ingresos<strong style="color:var(--income);">${formatMoney(ingresos)}</strong></div>
        <div class="obra-resumen-item">📤 Gastos<strong style="color:var(--expense);">${formatMoney(gastos)}</strong>
          <span style="font-size:.78rem;color:var(--muted);display:block;">Horas: ${horas.toFixed(1)}h</span>
        </div>
        <div class="obra-resumen-item">💵 Rentabilidad
          <strong class="${beneficio >= 0 ? "porcentaje-positivo" : "porcentaje-negativo"}">${formatMoneySigned(beneficio)}</strong>
          ${ingresos > 0 ? `<span style="font-size:.78rem;color:var(--muted);display:block;">${((beneficio / ingresos) * 100).toFixed(1)}%</span>` : ""}
        </div>
      </div>
      <div class="item-actions">
        <button class="btn small" data-quick-mov="ingreso:${o.id}" style="background:var(--success-light);border-color:#86efac;color:var(--success);">
          🟢 + Ingreso
        </button>
        <button class="btn small" data-quick-mov="gasto:${o.id}" style="background:var(--danger-light);border-color:#fecaca;color:#9f1239;">
          🔴 + Gasto
        </button>
        <button class="btn small primary" data-edit-obra="${o.id}">✏️ Editar</button>
        <button class="btn small danger" data-del-obra="${o.id}">🗑️ Eliminar</button>
      </div>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll("[data-edit-obra]").forEach((b) =>
    b.addEventListener("click", () => { const o = getObraById(b.dataset.editObra); if (o) fillObraForm(o); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  ul.querySelectorAll("[data-del-obra]").forEach((b) =>
    b.addEventListener("click", () => deleteObra(b.dataset.delObra)));
  ul.querySelectorAll("[data-quick-mov]").forEach((b) =>
    b.addEventListener("click", () => {
      const [tipo, obraId] = b.dataset.quickMov.split(":");
      openQuickMovDialog(tipo, obraId);
    }));
}

/* ============ SELECTS COMUNES ============ */
function renderSelects() {
  const activos = state.trabajadores.filter((t) => t.activo !== false).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
  const todosTrab = [...state.trabajadores].sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
  const obrasActivas = state.obras.filter((o) => o.estado === "curso" || o.estado === "pendiente").sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
  const todasObras = [...state.obras].sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));

  const optsT = (lista) => lista.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.nombre)}${t.categoria ? ` - ${escapeHtml(t.categoria)}` : ""} (${formatMoney(t.tarifa)}/h)</option>`).join("");
  const optsO = (lista) => lista.map((o) => {
    const est = ESTADOS_OBRA[o.estado];
    return `<option value="${escapeHtml(o.id)}">${escapeHtml(o.nombre)}${est ? ` (${est.label.replace(/[📝🔨✅❌]/g, "").trim()})` : ""}</option>`;
  }).join("");

  if (els.horaTrabajador) {
    const p = els.horaTrabajador.value;
    els.horaTrabajador.innerHTML = `<option value="">Selecciona trabajador...</option>${optsT(activos)}`;
    if ([...els.horaTrabajador.options].some((opt) => opt.value === p)) els.horaTrabajador.value = p;
  }
  if (els.horaObra) {
    const p = els.horaObra.value;
    els.horaObra.innerHTML = `<option value="">Selecciona obra...</option>${optsO(obrasActivas)}`;
    if ([...els.horaObra.options].some((opt) => opt.value === p)) els.horaObra.value = p;
  }
  if (els.quickObra) {
    const p = els.quickObra.value;
    els.quickObra.innerHTML = `<option value="">-- Selecciona la obra --</option>${optsO(obrasActivas)}`;
    if ([...els.quickObra.options].some((opt) => opt.value === p)) els.quickObra.value = p;
  }
  if (els.movimientoObra) {
    const p = els.movimientoObra.value;
    els.movimientoObra.innerHTML = `<option value="">General (sin obra)</option>${optsO(todasObras)}`;
    if ([...els.movimientoObra.options].some((opt) => opt.value === p)) els.movimientoObra.value = p;
  }
  if (els.filtroHorasTrabajador) {
    const p = els.filtroHorasTrabajador.value;
    els.filtroHorasTrabajador.innerHTML = `<option value="todos">Todos los trabajadores</option>${optsT(todosTrab)}`;
    if ([...els.filtroHorasTrabajador.options].some((opt) => opt.value === p)) els.filtroHorasTrabajador.value = p;
  }
  if (els.filtroHorasObra) {
    const p = els.filtroHorasObra.value;
    els.filtroHorasObra.innerHTML = `<option value="todas">Todas las obras</option>${optsO(todasObras)}`;
    if ([...els.filtroHorasObra.options].some((opt) => opt.value === p)) els.filtroHorasObra.value = p;
  }
  if (els.filtroMovObra) {
    const p = els.filtroMovObra.value;
    els.filtroMovObra.innerHTML = `<option value="todas">Todas / General</option><option value="general">Sólo General</option>${optsO(todasObras)}`;
    if ([...els.filtroMovObra.options].some((opt) => opt.value === p)) els.filtroMovObra.value = p;
  }
}

/* ============ WORKER: QUICK HOURS FORM ============ */
function populateWorkerQuickForm() {
  const w = currentWorker(); if (!w) return;
  document.getElementById("quickFecha").value = todayISO();
  document.getElementById("quickTrabajadorId").value = w.id;
  document.getElementById("todayLabel").textContent = formatDate(todayISO());
  state.quickSelectedHours = null;
  document.getElementById("quickHoras").value = "";
  document.getElementById("quickNotas").value = "";
  document.getElementById("quickObra").value = "";
  document.querySelectorAll(".quick-h-btn").forEach((b) => b.classList.remove("active"));
  document.getElementById("quickPreview").classList.add("hidden");
  setStatus(document.getElementById("quickStatus"), "");
  renderSelects();
}

function updateQuickPreview() {
  const w = currentWorker();
  const horasRaw = state.quickSelectedHours != null ? state.quickSelectedHours : Number(document.getElementById("quickHoras").value);
  const horas = Number(horasRaw) || 0;
  const preview = document.getElementById("quickPreview");
  if (!w || horas <= 0) { preview.classList.add("hidden"); return; }

  const fecha = document.getElementById("quickFecha").value || todayISO();
  const yaHechas = horasYaRegistradasEnDia(w.id, fecha, null);
  const totalIncluyendoNuevo = yaHechas + horas;
  const { base, extra } = desgloseHoras(totalIncluyendoNuevo);
  const baseYa = Math.min(yaHechas, HORAS_BASE_AL_DIA);
  const baseNuevo = Math.max(0, base - baseYa);
  const extraNuevo = horas - baseNuevo;

  const tarifaBase = Number(w.tarifa) || 0;
  const tarifaExtra = Number(w.tarifaExtra) || tarifaBase;
  const costeBase = baseNuevo * tarifaBase;
  const costeExtra = extraNuevo * tarifaExtra;
  const costeTotal = costeBase + costeExtra;

  preview.classList.remove("hidden");
  const aRow = document.getElementById("qpAcumuladoRow");
  if (yaHechas > 0) {
    aRow.style.display = "flex";
    const restantesBase = Math.max(0, HORAS_BASE_AL_DIA - yaHechas);
    let msg = `${yaHechas.toFixed(2)}h de ${HORAS_BASE_AL_DIA}h base`;
    if (restantesBase > 0) {
      msg += ` · ${restantesBase.toFixed(1)}h restantes normales`;
    } else {
      msg += ` · ⚠️ TODO lo que añadas es EXTRA`;
    }
    document.getElementById("qpAcumulado").textContent = msg;
  } else {
    aRow.style.display = "none";
  }

  document.getElementById("qpBase").textContent = `${baseNuevo}h × ${formatMoney(tarifaBase)} = ${formatMoney(costeBase)}`;
  const extraEl = document.getElementById("qpExtra");
  if (extraNuevo > 0) {
    extraEl.closest(".qp-row").style.display = "flex";
    extraEl.textContent = `${extraNuevo}h × ${formatMoney(tarifaExtra)} = ${formatMoney(costeExtra)}`;
  } else {
    extraEl.closest(".qp-row").style.display = "none";
  }
  document.getElementById("qpTotal").textContent = formatMoney(costeTotal);
}

function bindWorkerQuickEvents() {
  document.querySelectorAll(".quick-h-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.h;
      document.querySelectorAll(".quick-h-btn").forEach((b) => b.classList.remove("active"));
      if (val === "custom") {
        state.quickSelectedHours = null;
        document.getElementById("quickHoras").focus();
      } else {
        btn.classList.add("active");
        state.quickSelectedHours = Number(val);
        document.getElementById("quickHoras").value = val;
      }
      updateQuickPreview();
    });
  });
  document.getElementById("quickHoras").addEventListener("input", () => {
    state.quickSelectedHours = null;
    document.querySelectorAll(".quick-h-btn").forEach((b) => b.classList.remove("active"));
    updateQuickPreview();
  });
  document.getElementById("quickFecha").addEventListener("change", updateQuickPreview);
  document.getElementById("quickHorasForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trabajadorId = document.getElementById("quickTrabajadorId").value;
    const obraId = document.getElementById("quickObra").value;
    const horas = state.quickSelectedHours != null ? state.quickSelectedHours : Number(document.getElementById("quickHoras").value);
    const fecha = document.getElementById("quickFecha").value || todayISO();
    const notas = document.getElementById("quickNotas").value.trim();
    const statusEl = document.getElementById("quickStatus");

    if (!obraId) { setStatus(statusEl, "⚠️ Selecciona la obra en la que has trabajado.", true); return; }
    if (!horas || horas <= 0) { setStatus(statusEl, "⚠️ Indica cuántas horas has hecho.", true); return; }

    const calc = calcularCosteHoras(trabajadorId, horas);
    const registro = {
      id: uuid(),
      fecha,
      trabajadorId,
      obraId,
      cantidad: Number(horas),
      horasBase: calc.horasBase,
      horasExtra: calc.horasExtra,
      tarifaBase: calc.tarifaBase,
      tarifaExtra: calc.tarifaExtra,
      costeBase: calc.costeBase,
      costeExtra: calc.costeExtra,
      costeTotal: calc.costeTotal,
      notas,
      createdAt: new Date().toISOString(),
    };
    try {
      const creado = await saveHorasCUD("POST", registro);
      const regId = creado?.id || registro.id;
      await loadAllData(false, true);
      const rec = state.horas.find((x) => x.id === regId) || creado || registro;

      populateWorkerQuickForm();
      updateQuickPreview();
      const totalHoy = horasYaRegistradasEnDia(trabajadorId, fecha, null);
      const desgloseHoy = desgloseHoras(totalHoy);
      const t = getTrabajadorById(trabajadorId);
      const totalCobradoHoy = desgloseHoy.base * (Number(t?.tarifa) || 0) + desgloseHoy.extra * (Number(t?.tarifaExtra || t?.tarifa) || 0);
      const detalle = `Hoy total: ${desgloseHoy.base}h base${desgloseHoy.extra > 0 ? ` + ${desgloseHoy.extra}h extra` : ""} → ${formatMoney(totalCobradoHoy)}. ¡Gracias!`;
      setStatus(statusEl, `✅ ¡Horas guardadas correctamente! (${rec.horasBase}h base${rec.horasExtra > 0 ? ` + ${rec.horasExtra}h extra` : ""} en esta obra). ${detalle}`, false, true);
      renderHoras();
      renderWorkerSummary();
      if (isAdmin()) { renderTrabajadores(); renderObras(); renderDashboard(); renderBalanceGeneral(); }
    } catch (err) {
      setStatus(statusEl, "❌ " + err.message, true);
    }
  });
}

function renderWorkerSummary() {
  const w = currentWorker(); if (!w) return;
  const hoy = todayISO();
  const hoyHoras = state.horas.filter((h) => h.trabajadorId === w.id && h.fecha === hoy).reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
  const semanaHoras = state.horas.filter((h) => h.trabajadorId === w.id && isSameWeek(h.fecha)).reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
  const d = new Date();
  const mesHoras = state.horas.filter((h) => h.trabajadorId === w.id && isSameMonth(h.fecha, d.getMonth() + 1, d.getFullYear()));
  const horasMes = mesHoras.reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
  const dineroMes = mesHoras.reduce((s, h) => s + (Number(h.costeTotal) || 0), 0);
  const extrasMes = mesHoras.reduce((s, h) => s + (Number(h.horasExtra) || 0), 0);

  document.getElementById("wsHoy").textContent = `${hoyHoras.toFixed(1)}h`;
  document.getElementById("wsSemana").textContent = `${semanaHoras.toFixed(1)}h`;
  document.getElementById("wsMes").textContent = `${horasMes.toFixed(1)}h`;
  document.getElementById("wsDinero").textContent = formatMoney(dineroMes);
  document.getElementById("wsTarifaBase").textContent = formatMoney(w.tarifa || 0);
  document.getElementById("wsTarifaExtra").textContent = formatMoney(w.tarifaExtra || w.tarifa || 0);
  document.getElementById("wsExtrasMes").textContent = `${extrasMes.toFixed(1)}h`;
}

/* ============ HORAS ============ */
function clearHoraForm() {
  els.horaId.value = "";
  els.horaFecha.value = todayISO();
  els.horaTrabajador.value = "";
  els.horaObra.value = "";
  els.horaCantidad.value = "8";
  els.horaNotas.value = "";
  els.btnGuardarHora.textContent = "💾 Guardar Registro";
}
function fillHoraForm(h) {
  els.horaId.value = h.id;
  els.horaFecha.value = h.fecha || "";
  els.horaTrabajador.value = h.trabajadorId || "";
  els.horaObra.value = h.obraId || "";
  els.horaCantidad.value = h.cantidad || "";
  els.horaNotas.value = h.notas || "";
  els.btnGuardarHora.textContent = "✅ Actualizar Registro";
}

async function onSubmitHora(e) {
  e.preventDefault();
  const id = els.horaId.value || null;
  const trabajadorId = els.horaTrabajador.value;
  const obraId = els.horaObra.value;
  const cantidad = Number(els.horaCantidad.value) || 0;
  if (!trabajadorId || !obraId || !els.horaFecha.value || cantidad <= 0) {
    setStatus(els.horaStatus, "Todos los campos son obligatorios", true); return;
  }
  const calc = calcularCosteHoras(trabajadorId, cantidad);
  const data = {
    id: id || undefined,
    fecha: els.horaFecha.value,
    trabajadorId, obraId,
    cantidad,
    horasBase: calc.horasBase,
    horasExtra: calc.horasExtra,
    tarifaBase: calc.tarifaBase,
    tarifaExtra: calc.tarifaExtra,
    costeBase: calc.costeBase,
    costeExtra: calc.costeExtra,
    costeTotal: calc.costeTotal,
    notas: els.horaNotas.value.trim(),
  };
  let fechasAfectadas = [data.fecha];
  try {
    let msg = "";
    if (id) {
      const idx = state.horas.findIndex((h) => h.id === id);
      if (idx >= 0) {
        const fechaAntigua = state.horas[idx].fecha;
        if (fechaAntigua && fechaAntigua !== data.fecha) fechasAfectadas.push(fechaAntigua);
      }
      await saveHorasCUD("PUT", { ...data, id });
      msg = "✅ Actualizado";
    } else {
      const creado = await saveHorasCUD("POST", { ...data, id: uuid() });
      msg = `✅ Guardado: ${creado?.horasBase ?? data.horasBase}h base${(creado?.horasExtra ?? data.horasExtra) > 0 ? ` + ${creado?.horasExtra ?? data.horasExtra}h extra` : ""} = ${formatMoney(creado?.costeTotal ?? data.costeTotal)}`;
    }
    clearHoraForm();
    await loadAllData(false, true);
    try { await renderAll(); } catch {}
    setStatus(els.horaStatus, msg, false, true);
  } catch (err) {
    setStatus(els.horaStatus, "❌ " + err.message, true);
  }
}

async function deleteHora(id) {
  const h = state.horas.find((x) => x.id === id);
  if (!h) return;
  if (isWorker() && h.trabajadorId !== state.session.trabajadorId) return;
  if (!(await confirmAction("Eliminar", "¿Eliminar este registro de horas?"))) return;
  try {
    await saveHorasCUD("DELETE", { id });
    await loadAllData(false, true);
    try { await renderAll(); } catch {}
  } catch (err) {
    alert("❌ " + err.message);
  }
}

function renderHoras() {
  const f = state.filtros.horas;
  const wid = isWorker() ? state.session.trabajadorId : null;
  let lista = state.horas.filter((h) => {
    if (wid && h.trabajadorId !== wid) return false;
    if (f.desde && h.fecha < f.desde) return false;
    if (f.hasta && h.fecha > f.hasta) return false;
    if (f.trabajador && f.trabajador !== "todos" && h.trabajadorId !== f.trabajador) return false;
    if (f.obra && f.obra !== "todas" && h.obraId !== f.obra) return false;
    return true;
  }).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  const totalHoras = lista.reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
  const totalCoste = lista.reduce((s, h) => s + (Number(h.costeTotal) || 0), 0);
  const totalExtra = lista.reduce((s, h) => s + (Number(h.horasExtra) || 0), 0);

  els.totalHorasFiltradas.textContent = `${totalHoras.toFixed(2)}h${totalExtra > 0 ? ` (${totalExtra.toFixed(1)} extra)` : ""}`;
  if (isAdmin()) els.totalCosteHoras.textContent = formatMoney(totalCoste);

  const workerTotal = document.getElementById("workerTotalCobrar");
  if (workerTotal && isWorker()) workerTotal.textContent = formatMoney(totalCoste);
  els.totalRegistrosHoras.textContent = lista.length;

  const ul = els.listaHoras; ul.innerHTML = "";
  if (lista.length === 0) {
    ul.innerHTML = `<li class="empty-notice"><span class="emoji">⏱️</span>${isWorker() ? "Todavía no has registrado ninguna hora. ¡Empieza arriba!" : "No hay registros de horas."}</li>`;
    return;
  }

  const hoyISO = todayISO(); // Fecha de HOY para determinar si el trabajador puede borrar (solo HOY)
  lista.forEach((h) => {
    const t = getTrabajadorById(h.trabajadorId);
    const o = getObraById(h.obraId);
    const li = document.createElement("li");
    li.className = "item";
    li.style.borderLeftColor = h.horasExtra > 0 ? "#ea580c" : "#2563eb";
    const delHoy = isWorker() && String(h.fecha || "").slice(0, 10) === hoyISO;
    // ✅ Si es TRABAJADOR: solo puede borrar horas de HOY (delHoy=true).
    //    Si es ADMIN: puede borrar y editar todas las horas.
    const accionesDelete = (isAdmin() || delHoy) ?
      `<button class="btn small danger" data-del-hora="${h.id}" title="${delHoy ? "Borrar esta hora de hoy (error apunte)" : "Eliminar registro"}">${isWorker() ? "🗑️ Deshacer (hoy)" : "🗑️ Eliminar"}</button>` :
      `<p style="margin:0;font-size:.8rem;color:#64748b;" class="hint">(Solo admin puede borrar horas de días anteriores)</p>`;
    li.innerHTML = `
      <div class="item-header">
        <div>
          <h4>📅 ${formatDate(h.fecha)}${isAdmin() ? ` - ${escapeHtml(t ? t.nombre : "⚠️ Eliminado")}` : ""}</h4>
          <div class="meta-tags">
            <span class="tag turno-normal">${h.horasBase}h base</span>
            ${h.horasExtra > 0 ? `<span class="tag turno-extra">${h.horasExtra}h extra</span>` : ""}
            ${isWorker() && delHoy ? `<span class="tag" style="background:#dcfce7;color:#166534;">✅ Se puede borrar (hoy)</span>` : ""}
          </div>
        </div>
        <div style="text-align:right;">
          ${isAdmin() ? `<div class="amount gasto">-${formatMoney(h.costeTotal)}</div>` : `<div class="amount ingreso">+${formatMoney(h.costeTotal)}</div>`}
          <p style="margin:0;font-size:.85rem;">
            ${h.horasBase}h×${formatMoney(h.tarifaBase)}${h.horasExtra > 0 ? ` + ${h.horasExtra}h×${formatMoney(h.tarifaExtra)}` : ""}
          </p>
        </div>
      </div>
      <p>🏢 Obra: <strong>${escapeHtml(o ? o.nombre : "⚠️ Obra eliminada")}</strong></p>
      ${h.notas ? `<p>📝 ${escapeHtml(h.notas)}</p>` : ""}
      <div class="item-actions">
        ${isAdmin() ? `<button class="btn small primary" data-edit-hora="${h.id}">✏️ Editar</button>` : ""}
        ${accionesDelete}
      </div>`;
    ul.appendChild(li);
  });

  ul.querySelectorAll("[data-edit-hora]").forEach((b) =>
    b.addEventListener("click", () => { const h = state.horas.find((x) => x.id === b.dataset.editHora); if (h) fillHoraForm(h); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  ul.querySelectorAll("[data-del-hora]").forEach((b) =>
    b.addEventListener("click", () => deleteHora(b.dataset.delHora)));
}

/* ============ MOVIMIENTOS / CONTABILIDAD (ADMIN) ============ */
function clearMovimientoForm() {
  els.movimientoId.value = "";
  els.movimientoFecha.value = todayISO();
  els.movimientoTipo.value = "ingreso";
  els.movimientoImporte.value = "";
  els.movimientoObra.value = "";
  els.movimientoResponsable.value = "";
  els.movimientoCategoria.value = "facturacion";
  els.movimientoFormaPago.value = "transferencia";
  els.movimientoConcepto.value = "";
  els.movimientoReferencia.value = "";
  els.btnGuardarMovimiento.textContent = "💾 Guardar Movimiento";
}
function fillMovimientoForm(m) {
  els.movimientoId.value = m.id;
  els.movimientoFecha.value = m.fecha || "";
  els.movimientoTipo.value = m.tipo || "ingreso";
  els.movimientoImporte.value = m.importe || "";
  els.movimientoObra.value = m.obraId || "";
  els.movimientoResponsable.value = m.responsableId || "";
  const elReal = document.getElementById("movimientoRealizadoPor");
  if (elReal && m.realizadoPorId) elReal.value = m.realizadoPorId;
  els.movimientoCategoria.value = m.categoria || "";
  els.movimientoFormaPago.value = m.formaPago || "otro";
  els.movimientoConcepto.value = m.concepto || "";
  els.movimientoReferencia.value = m.referencia || "";
  els.btnGuardarMovimiento.textContent = "✅ Actualizar Movimiento";
}

async function onSubmitMovimiento(e) {
  e.preventDefault();
  const id = els.movimientoId.value || null;
  const elReal = document.getElementById("movimientoRealizadoPor");
  const _u = state.session?.user || null;
  const yoId = (_u?.userId) || (_u?.trabajadorId) || null;
  const realizadoPorId = (elReal?.value ? elReal.value : yoId) || null;
  const data = {
    id: id || undefined,
    fecha: els.movimientoFecha.value,
    tipo: els.movimientoTipo.value,
    importe: Number(els.movimientoImporte.value) || 0,
    obraId: els.movimientoObra.value || null,
    responsableId: els.movimientoResponsable.value || null,
    realizadoPorId: realizadoPorId || null,
    categoria: els.movimientoCategoria.value,
    formaPago: els.movimientoFormaPago.value || "otro",
    concepto: els.movimientoConcepto.value.trim(),
    referencia: els.movimientoReferencia.value.trim(),
  };
  if (!data.fecha || !data.tipo || data.importe <= 0 || !data.concepto || !data.categoria) {
    setStatus(els.movimientoStatus, "Campos obligatorios incompletos", true); return;
  }
  if (data.obraId === "") data.obraId = null;
  if (data.responsableId === "") data.responsableId = null;
  try {
    if (id) {
      await saveMovCUD("PUT", { ...data, id });
      setStatus(els.movimientoStatus, "✅ Actualizado", false, true);
    } else {
      await saveMovCUD("POST", data);
      setStatus(els.movimientoStatus, "✅ Guardado", false, true);
    }
    clearMovimientoForm();
    state.cajasData = null;
    await loadAllData();
    renderMovimientos(); renderBalanceGeneral(); renderObras(); renderDashboard(); renderCierre();
    populateResponsablesSelect();
    if (isAdmin()) try { await renderCajas(); } catch {}
  } catch (err) {
    setStatus(els.movimientoStatus, "❌ " + err.message, true);
  }
}

async function deleteMovimiento(id) {
  if (!(await confirmAction("Eliminar", "¿Eliminar movimiento?"))) return;
  try {
    await saveMovCUD("DELETE", { id });
    state.cajasData = null;
    await loadAllData();
    renderMovimientos(); renderBalanceGeneral(); renderObras(); renderDashboard(); renderCierre();
    populateResponsablesSelect();
    if (isAdmin()) try { await renderCajas(); } catch {}
  } catch (err) { alert("❌ " + err.message); }
}

function calcularTotalesGlobales() {
  let ingresos = 0, gastos = 0;
  state.movimientos.forEach((m) => { if (m.tipo === "ingreso") ingresos += Number(m.importe) || 0; else gastos += Number(m.importe) || 0; });
  const costeHoras = state.horas.reduce((s, h) => s + (Number(h.costeTotal) || 0), 0);
  gastos += costeHoras;
  return { ingresos, gastos, neto: ingresos - gastos, costeHoras };
}

function renderBalanceGeneral() {
  const { ingresos, gastos, neto } = calcularTotalesGlobales();
  els.totalIngresos.textContent = formatMoney(ingresos);
  els.totalGastos.textContent = formatMoney(gastos);
  els.balanceNeto.textContent = (neto >= 0 ? "" : "-") + formatMoney(Math.abs(neto));
  const nc = els.balanceNeto.closest(".balance-card.net");
  if (nc) nc.classList.toggle("negative", neto < 0);
}

function renderMovimientos() {
  const f = state.filtros.mov;
  const lista = state.movimientos.filter((m) => {
    if (f.desde && m.fecha < f.desde) return false;
    if (f.hasta && m.fecha > f.hasta) return false;
    if (f.tipo && f.tipo !== "todos" && m.tipo !== f.tipo) return false;
    if (f.obra === "general") { if (m.obraId) return false; }
    else if (f.obra && f.obra !== "todas" && m.obraId !== f.obra) return false;
    return true;
  }).sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  const ul = els.listaMovimientos; ul.innerHTML = "";
  if (lista.length === 0) {
    ul.innerHTML = `<li class="empty-notice"><span class="emoji">💰</span>No hay movimientos.</li>`; return;
  }
  lista.forEach((m) => {
    const cat = CATEGORIAS_MOV[m.categoria];
    const o = m.obraId ? getObraById(m.obraId) : null;
    const li = document.createElement("li");
    li.className = "item";
    li.style.borderLeftColor = m.tipo === "ingreso" ? "#16a34a" : "#dc2626";
    li.innerHTML = `
      <div class="item-header">
        <div>
          <h4>${escapeHtml(m.concepto)}</h4>
          <div class="meta-tags">
            <span class="tag tipo-${m.tipo}">${m.tipo === "ingreso" ? "📥 Ingreso" : "📤 Gasto"}</span>
            <span class="tag categoria">${escapeHtml(cat ? cat.label : m.categoria)}</span>
            ${o ? `<span class="tag categoria">🏢 ${escapeHtml(o.nombre)}</span>` : `<span class="tag categoria">General</span>`}
          </div>
        </div>
        <div style="text-align:right;">
          <div class="amount ${m.tipo}">${m.tipo === "ingreso" ? "+" : "-"}${formatMoney(m.importe)}</div>
          <p style="margin:0;font-size:.85rem;">📅 ${formatDate(m.fecha)}</p>
        </div>
      </div>
      ${m.referencia ? `<p>🏷️ Ref: ${escapeHtml(m.referencia)}</p>` : ""}
      <p>💳 Pago: ${escapeHtml(m.formaPago || "")}</p>
      <div class="item-actions">
        <button class="btn small primary" data-edit-mov="${m.id}">✏️ Editar</button>
        <button class="btn small danger" data-del-mov="${m.id}">🗑️ Eliminar</button>
      </div>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll("[data-edit-mov]").forEach((b) =>
    b.addEventListener("click", () => { const m = state.movimientos.find((x) => x.id === b.dataset.editMov); if (m) fillMovimientoForm(m); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  ul.querySelectorAll("[data-del-mov]").forEach((b) =>
    b.addEventListener("click", () => deleteMovimiento(b.dataset.delMov)));
}

/* ============ DASHBOARD (ADMIN) ============ */
function renderDashboard() {
  if (!els.dashTrabajadores) return;
  const activos = state.trabajadores.filter((t) => t.activo !== false).length;
  const enCurso = state.obras.filter((o) => o.estado === "curso").length;
  const d = new Date(); const mes = d.getMonth() + 1; const anio = d.getFullYear();
  const horasMes = state.horas.filter((h) => isSameMonth(h.fecha, mes, anio)).reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
  const ingMes = state.movimientos.filter((m) => m.tipo === "ingreso" && isSameMonth(m.fecha, mes, anio)).reduce((s, m) => s + (Number(m.importe) || 0), 0);
  const gasMesMov = state.movimientos.filter((m) => m.tipo === "gasto" && isSameMonth(m.fecha, mes, anio)).reduce((s, m) => s + (Number(m.importe) || 0), 0);
  const costeHMes = state.horas.filter((h) => isSameMonth(h.fecha, mes, anio)).reduce((s, h) => s + (Number(h.costeTotal) || 0), 0);
  const benMes = ingMes - gasMesMov - costeHMes;
  els.dashTrabajadores.textContent = activos;
  els.dashObras.textContent = enCurso;
  els.dashHorasMes.textContent = `${horasMes.toFixed(1)}h`;
  els.dashBeneficio.textContent = (benMes >= 0 ? "" : "-") + formatMoney(Math.abs(benMes));

  const obrasList = els.dashboardObrasList;
  obrasList.innerHTML = "";
  const obrasRes = state.obras.filter((o) => o.estado === "curso" || o.estado === "pendiente").slice(0, 6);
  if (obrasRes.length === 0) {
    obrasList.innerHTML = `<div class="empty-notice"><span class="emoji">🏗️</span>No hay obras activas. Crea la primera en 🏢 Obras.</div>`;
  } else {
    obrasRes.forEach((o) => {
      const ingresos = calcularIngresosObra(o.id); const gastos = calcularGastosObra(o.id); const b = ingresos - gastos;
      const ppto = Number(o.presupuesto) || 0; const horas = state.horas.filter((h) => h.obraId === o.id).reduce((s, h) => s + (Number(h.cantidad) || 0), 0);
      const est = ESTADOS_OBRA[o.estado] || ESTADOS_OBRA.pendiente;
      const div = document.createElement("div"); div.className = "item";
      div.style.borderLeftColor = o.estado === "curso" ? "#ea580c" : "#6366f1";
      div.innerHTML = `
        <div class="item-header">
          <div>
            <h4>${escapeHtml(o.nombre)}</h4>
            <div class="meta-tags"><span class="tag ${est.clase}">${est.label}</span><span class="tag categoria">👤 ${escapeHtml(o.cliente)}</span></div>
          </div>
          <div style="text-align:right;">
            <div class="amount ${b >= 0 ? "ingreso" : "gasto"}">${b >= 0 ? "+" : ""}${formatMoney(b)}</div>
            <p style="margin:0;font-size:.85rem;">${horas.toFixed(0)}h</p>
          </div>
        </div>
        ${ppto > 0 ? `<p style="margin-top:.4rem;">Presupuesto: <strong>${formatMoney(ppto)}</strong> | Ejecutado: ${formatMoney(gastos)} (${ppto > 0 ? (gastos / ppto * 100).toFixed(0) : 0}%)</p>` : ""}
        <div class="item-actions">
          <button class="btn small" data-quick-mov="ingreso:${o.id}" style="background:var(--success-light);border-color:#86efac;color:var(--success);">🟢 + Ingreso</button>
          <button class="btn small" data-quick-mov="gasto:${o.id}" style="background:var(--danger-light);border-color:#fecaca;color:#9f1239;">🔴 + Gasto</button>
        </div>`;
      obrasList.appendChild(div);
    });
  }
  obrasList.querySelectorAll("[data-quick-mov]").forEach((b) =>
    b.addEventListener("click", () => {
      const [tipo, obraId] = b.dataset.quickMov.split(":");
      openQuickMovDialog(tipo, obraId);
    }));

  const ultMov = els.dashboardMovimientos;
  ultMov.innerHTML = "";
  const mlist = [...state.movimientos].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, 5);
  if (mlist.length === 0) {
    ultMov.innerHTML = `<li class="empty-notice"><span class="emoji">📊</span>No hay movimientos. Empieza en 💰 Contabilidad.</li>`;
  } else {
    mlist.forEach((m) => {
      const o = m.obraId ? getObraById(m.obraId) : null;
      const li = document.createElement("li"); li.className = "item";
      li.style.borderLeftColor = m.tipo === "ingreso" ? "#16a34a" : "#dc2626";
      li.innerHTML = `
        <div class="item-header">
          <div><h4>${escapeHtml(m.concepto)}</h4><p style="margin:0;">📅 ${formatDate(m.fecha)} ${o ? `| 🏢 ${escapeHtml(o.nombre)}` : ""}</p></div>
          <div class="amount ${m.tipo}">${m.tipo === "ingreso" ? "+" : "-"}${formatMoney(m.importe)}</div>
        </div>`;
      ultMov.appendChild(li);
    });
  }
}

/* ============ CIERRE DE MES (ADMIN) ============ */
function calcularCierreMes(mesISO) {
  if (!mesISO) return null;
  const [anio, mes] = mesISO.split("-").map(Number);
  const horasMes = state.horas.filter((h) => isSameMonth(h.fecha, mes, anio));
  const movMes = state.movimientos.filter((m) => isSameMonth(m.fecha, mes, anio));

  const trabajadoresData = new Map();
  state.trabajadores.forEach((t) => trabajadoresData.set(t.id, {
    trabajador: t,
    horasBase: 0, horasExtra: 0,
    costeBase: 0, costeExtra: 0,
    costeTotal: 0,
    horasPorObra: new Map(),
    registros: [],
  }));

  horasMes.forEach((h) => {
    const e = trabajadoresData.get(h.trabajadorId); if (!e) return;
    e.registros.push(h);
    e.horasBase += Number(h.horasBase) || 0;
    e.horasExtra += Number(h.horasExtra) || 0;
    e.costeBase += Number(h.costeBase) || 0;
    e.costeExtra += Number(h.costeExtra) || 0;
    e.costeTotal += Number(h.costeTotal) || 0;
    const ho = e.horasPorObra.get(h.obraId) || { horas: 0, coste: 0 };
    ho.horas += Number(h.cantidad) || 0; ho.coste += Number(h.costeTotal) || 0;
    e.horasPorObra.set(h.obraId, ho);
  });

  const obrasData = new Map();
  state.obras.forEach((o) => obrasData.set(o.id, { obra: o, ingresos: 0, gastos: 0, costeHoras: 0, horasTrabajadas: 0 }));
  horasMes.forEach((h) => {
    const e = obrasData.get(h.obraId); if (!e) return;
    e.costeHoras += Number(h.costeTotal) || 0; e.horasTrabajadas += Number(h.cantidad) || 0;
  });
  movMes.forEach((m) => {
    if (!m.obraId) return;
    const e = obrasData.get(m.obraId); if (!e) return;
    if (m.tipo === "ingreso") e.ingresos += Number(m.importe) || 0;
    else e.gastos += Number(m.importe) || 0;
  });

  let ingG = 0, gasG = 0;
  movMes.forEach((m) => {
    if (m.obraId) return;
    if (m.tipo === "ingreso") ingG += Number(m.importe) || 0;
    else gasG += Number(m.importe) || 0;
  });

  let totalI = ingG, totalG = gasG, totalCH = 0;
  obrasData.forEach((o) => { totalI += o.ingresos; totalG += o.gastos; totalCH += o.costeHoras; });
  totalG += totalCH;
  return { mes, anio, trabajadores: Array.from(trabajadoresData.values()), obras: Array.from(obrasData.values()),
    ingresosGenerales: ingG, gastosGenerales: gasG, totalIngresos: totalI, totalGastos: totalG,
    totalCosteHoras: totalCH, beneficioNeto: totalI - totalG };
}

function renderCierre() {
  const mesISO = els.cierreMes.value || currentMonthISO();
  const cierre = calcularCierreMes(mesISO); if (!cierre) return;

  const wrapT = els.cierreTrabajadores; wrapT.innerHTML = "";
  const conDatos = cierre.trabajadores.filter((t) => t.registros.length > 0)
    .sort((a, b) => (a.trabajador.nombre || "").localeCompare(b.trabajador.nombre || "", "es"));
  if (conDatos.length === 0) {
    wrapT.innerHTML = `<div class="empty-notice"><span class="emoji">👷</span>No hay horas registradas este mes.</div>`;
  } else {
    conDatos.forEach((e) => {
      const t = e.trabajador;
      const tHoras = e.horasBase + e.horasExtra;
      const dias = new Set(e.registros.map((r) => r.fecha)).size;
      const div = document.createElement("div"); div.className = "cierre-card";
      div.innerHTML = `
        <div class="cierre-card-header">
          <h4>👷 ${escapeHtml(t.nombre)}${t.categoria ? ` <span style="color:var(--muted);font-weight:400;font-size:.9rem;">(${escapeHtml(t.categoria)})</span>` : ""}</h4>
          <div class="amount gasto">${formatMoney(e.costeTotal)}</div>
        </div>
        <div class="cierre-detalle">
          <div class="cierre-detalle-item">Horas Base<strong>${e.horasBase.toFixed(2)}h</strong><span style="color:var(--muted);font-size:.78rem;">× ${formatMoney(t.tarifa)} = ${formatMoney(e.costeBase)}</span></div>
          <div class="cierre-detalle-item">Horas Extra<strong style="color:var(--warning);">${e.horasExtra.toFixed(2)}h</strong><span style="color:var(--muted);font-size:.78rem;">× ${formatMoney(t.tarifaExtra || t.tarifa)} = ${formatMoney(e.costeExtra)}</span></div>
          <div class="cierre-detalle-item">Total Horas<strong>${tHoras.toFixed(2)}h</strong></div>
          <div class="cierre-detalle-item">Días trabajados<strong>${dias}</strong></div>
          <div class="cierre-detalle-item">Precio Medio / h<strong>${formatMoney(tHoras > 0 ? e.costeTotal / tHoras : 0)}</strong></div>
          <div class="cierre-detalle-item">A LIQUIDAR<strong style="color:var(--primary-strong);font-size:1.1rem;">${formatMoney(e.costeTotal)}</strong></div>
        </div>
        ${e.horasPorObra.size > 0 ? `
          <p style="margin-top:.6rem;color:var(--muted);font-size:.88rem;margin-bottom:.2rem;"><strong>Detalle por obra:</strong></p>
          <div class="cierre-detalle">
            ${Array.from(e.horasPorObra.entries()).map(([oid, d]) => {
              const o = getObraById(oid);
              return `<div class="cierre-detalle-item">🏢 ${escapeHtml(o ? o.nombre : "Eliminada")}<strong>${d.horas.toFixed(2)}h | ${formatMoney(d.coste)}</strong></div>`;
            }).join("")}
          </div>` : ""}`;
      wrapT.appendChild(div);
    });
  }

  const wrapO = els.cierreObras; wrapO.innerHTML = "";
  const ocon = cierre.obras.filter((o) => o.horasTrabajadas > 0 || o.ingresos > 0 || o.gastos > 0)
    .sort((a, b) => (a.obra.nombre || "").localeCompare(b.obra.nombre || "", "es"));
  if (ocon.length === 0) {
    wrapO.innerHTML = `<div class="empty-notice"><span class="emoji">🏢</span>Sin actividad este mes.</div>`;
  } else {
    ocon.forEach((e) => {
      const o = e.obra;
      const est = ESTADOS_OBRA[o.estado] || ESTADOS_OBRA.pendiente;
      const b = e.ingresos - e.gastos - e.costeHoras;
      const margen = e.ingresos > 0 ? (b / e.ingresos) * 100 : 0;
      const div = document.createElement("div"); div.className = "cierre-card";
      div.innerHTML = `
        <div class="cierre-card-header">
          <div>
            <h4>🏢 ${escapeHtml(o.nombre)}</h4>
            <div class="meta-tags"><span class="tag ${est.clase}">${est.label}</span><span class="tag categoria">👤 ${escapeHtml(o.cliente)}</span></div>
          </div>
          <div class="amount ${b >= 0 ? "ingreso" : "gasto"}">${b >= 0 ? "+" : ""}${formatMoney(b)}</div>
        </div>
        <div class="cierre-detalle">
          <div class="cierre-detalle-item">📥 Ingresos<strong style="color:var(--income);">${formatMoney(e.ingresos)}</strong></div>
          <div class="cierre-detalle-item">📤 Gastos<strong style="color:var(--expense);">${formatMoney(e.gastos)}</strong></div>
          <div class="cierre-detalle-item">👷 Coste Horas<strong style="color:var(--expense);">${formatMoney(e.costeHoras)}</strong></div>
          <div class="cierre-detalle-item">⏱️ Horas<strong>${e.horasTrabajadas.toFixed(1)}h</strong></div>
          <div class="cierre-detalle-item">💵 Resultado<strong class="${b >= 0 ? "porcentaje-positivo" : "porcentaje-negativo"}">${formatMoneySigned(b)}</strong></div>
          <div class="cierre-detalle-item">📈 Margen<strong class="${margen >= 0 ? "porcentaje-positivo" : "porcentaje-negativo"}">${margen.toFixed(1)}%</strong></div>
        </div>`;
      wrapO.appendChild(div);
    });
  }

  const wrapR = els.resumenMes; wrapR.innerHTML = "";
  const res = document.createElement("div"); res.className = "resumen-economico";
  const ben = cierre.beneficioNeto;
  const items = [
    { label: "📥 Ingresos Totales", valor: cierre.totalIngresos, color: "ingreso" },
    { label: "📤 Gastos (Materiales/Proveedores...)", valor: cierre.totalGastos - cierre.totalCosteHoras, color: "gasto" },
    { label: "👷 Coste Total Nómina", valor: cierre.totalCosteHoras, color: "gasto" },
    { label: "➕ Gastos Totales", valor: cierre.totalGastos, color: "gasto" },
    { label: "💵 RESULTADO NETO MES", valor: ben, color: ben >= 0 ? "ingreso" : "gasto", destacado: true },
  ];
  items.forEach((it) => {
    const d = document.createElement("div"); d.className = "resumen-item";
    if (it.destacado) {
      d.style.background = it.color === "ingreso" ? "var(--success-light)" : "var(--danger-light)";
      d.style.borderColor = it.color === "ingreso" ? "#86efac" : "#fecaca";
    }
    d.innerHTML = `<h5>${it.label}</h5><div class="valor" style="color:var(--${it.color});">${it.valor >= 0 ? "" : "-"}${formatMoney(Math.abs(it.valor))}</div>`;
    res.appendChild(d);
  });
  wrapR.appendChild(res);
}

function exportarSueldosCSV() {
  const mesISO = els.cierreMes.value || currentMonthISO();
  const cierre = calcularCierreMes(mesISO); if (!cierre) return;
  const datos = cierre.trabajadores.filter((t) => t.registros.length > 0);
  if (datos.length === 0) { alert("Sin datos este mes."); return; }
  const rows = [["Trabajador","DNI","Categoría","Horas Base","Horas Extra","Total Horas","Días","Tarifa Base","Tarifa Extra","Coste Base","Coste Extra","Total Liquidar"]];
  datos.forEach((e) => {
    const t = e.trabajador;
    rows.push([t.nombre, t.dni || "", t.categoria || "", e.horasBase.toFixed(2), e.horasExtra.toFixed(2),
      (e.horasBase + e.horasExtra).toFixed(2), String(new Set(e.registros.map(r => r.fecha)).size),
      String(t.tarifa || 0), String(t.tarifaExtra || t.tarifa || 0),
      e.costeBase.toFixed(2), e.costeExtra.toFixed(2), e.costeTotal.toFixed(2)]);
  });
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `liquidacion_trabajadores_${mesISO}.csv`; a.click();
  URL.revokeObjectURL(url);
}

/* ============ AJUSTES (ADMIN) ============ */
function bindQuickNewObraEvents() {
  els.btnQuickNewObra.addEventListener("click", () => {
    els.qnoNombre.value = "";
    els.qnoCliente.value = "";
    els.qnoDireccion.value = "";
    setStatus(els.qnoStatus, "");
    if (typeof els.quickNewObraDialog.showModal === "function") {
      els.quickNewObraDialog.showModal();
    } else {
      els.qnoNombre.value = prompt("Nombre de la obra (obligatorio):");
      if (!els.qnoNombre.value) return;
      els.qnoCliente.value = prompt("Cliente (obligatorio):");
      if (!els.qnoCliente.value) return;
      submitQuickNewObra();
    }
  });

  els.quickNewObraForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!els.qnoNombre.value.trim() || !els.qnoCliente.value.trim()) {
      setStatus(els.qnoStatus, "Nombre y Cliente son obligatorios.", true);
      return;
    }
    setStatus(els.qnoStatus, "⏳ Guardando obra en la nube...", false);
    const ok = await submitQuickNewObra();
    if (!ok) setStatus(els.qnoStatus, "❌ No se pudo crear la obra. Inténtalo otra vez.", true);
  });
}

async function submitQuickNewObra() {
  const nombre = els.qnoNombre.value.trim();
  const cliente = els.qnoCliente.value.trim();
  const direccion = els.qnoDireccion.value.trim();
  if (!nombre || !cliente) return false;
  const obra = {
    nombre,
    cliente,
    direccion,
    presupuesto: 0,
    fechaInicio: todayISO(),
    fechaFin: "",
    estado: "curso",
    notas: "",
    createdAt: new Date().toISOString(),
  };
  try {
    const creada = await saveObrasCUD("POST", obra);
    if (!creada || !creada.id) throw new Error("Sin respuesta del servidor");
    const obraId = creada.id;
    state.cajasData = null;
    await loadAllData(false, true);
    renderSelects();
    populateResponsablesSelect();
    if (els.quickObra && obraId) els.quickObra.value = obraId;
    if (isWorker()) {
      populateWorkerQuickForm();
      renderWorkerSummary();
    }
    if (isAdmin()) {
      try { await renderAll(); } catch { renderObras(); renderDashboard(); renderBalanceGeneral(); try { await renderCajas(); } catch {} }
    } else {
      renderHoras();
    }
    setStatus(document.getElementById("quickStatus"), `✅ Obra "${nombre}" creada correctamente (${obraId}). Ya la tienes seleccionada arriba.`, false, true);
    if (typeof els.quickNewObraDialog.close === "function") els.quickNewObraDialog.close();
    return true;
  } catch (err) {
    setStatus(els.qnoStatus, "❌ " + err.message, true);
    return false;
  }
}

function populateQmCategorias(tipo) {
  const validas = Object.entries(CATEGORIAS_MOV).filter(([_, v]) => v.tipo === tipo);
  const cur = els.qmCategoria.value;
  els.qmCategoria.innerHTML = validas.map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v.label)}</option>`).join("");
  if (validas.some(([k]) => k === cur)) els.qmCategoria.value = cur;
}

function openQuickMovDialog(tipo, obraId) {
  const obra = getObraById(obraId); if (!obra) return;
  els.qmObraId.value = obraId;
  els.qmTipo.value = tipo;
  els.qmHint.textContent = `Obra: ${obra.nombre} · Cliente: ${obra.cliente}`;
  els.qmFecha.value = todayISO();
  els.qmImporte.value = "";
  els.qmConcepto.value = "";
  els.qmReferencia.value = "";
  els.qmFormaPago.value = "transferencia";
  setStatus(els.qmStatus, "");
  populateQmCategorias(tipo);
  if (tipo === "ingreso") {
    els.qmTitle.textContent = "📥 Registrar Ingreso en Obra";
    els.qmSubmit.textContent = "💾 Guardar Ingreso";
    els.qmSubmit.className = "btn primary";
  } else {
    els.qmTitle.textContent = "📤 Registrar Gasto en Obra";
    els.qmSubmit.textContent = "💾 Guardar Gasto";
    els.qmSubmit.className = "btn primary danger";
  }
  if (typeof els.quickMovDialog.showModal === "function") {
    els.quickMovDialog.showModal();
  } else {
    // fallback
    const imp = window.prompt(`Importe para ${tipo === "ingreso" ? "INGRESO" : "GASTO"} en "${obra.nombre}" (€):`);
    if (!imp) return;
    const con = window.prompt("Concepto / Descripción:");
    if (!con) return;
    els.qmImporte.value = imp;
    els.qmConcepto.value = con;
    submitQuickMov();
  }
}

async function submitQuickMov() {
  const tipo = els.qmTipo.value;
  const obraId = els.qmObraId.value;
  const importe = Number(els.qmImporte.value) || 0;
  const concepto = (els.qmConcepto.value || "").trim();
  if (!obraId || importe <= 0 || !concepto) return false;
  const _u = state.session?.user || null;
  const yoId = (_u?.userId) || (_u?.trabajadorId) || null;
  const _selReal = document.getElementById("qmRealizadoPor");
  const realizadoPorId = (_selReal?.value ? _selReal.value : yoId) || null;
  const data = {
    fecha: els.qmFecha.value || todayISO(),
    tipo,
    importe,
    obraId,
    responsableId: els.qmResponsable.value || null,
    realizadoPorId: realizadoPorId || null,
    categoria: els.qmCategoria.value,
    formaPago: els.qmFormaPago.value || "otro",
    concepto,
    referencia: (els.qmReferencia.value || "").trim(),
    createdAt: new Date().toISOString(),
  };
  try {
    await saveMovCUD("POST", data);
    state.cajasData = null;
    await loadAllData();
    const obra = getObraById(obraId);
    const msg = `✅ ${tipo === "ingreso" ? "Ingreso" : "Gasto"} de ${formatMoney(importe)} guardado en "${obra?.nombre || "obra"}".`;
    alert(msg);
    if (typeof els.quickMovDialog.close === "function") els.quickMovDialog.close();
    renderBalanceGeneral(); renderMovimientos(); renderObras(); renderDashboard(); renderCierre();
    populateResponsablesSelect();
    if (isAdmin()) try { await renderCajas(); } catch {}
    return true;
  } catch (err) {
    setStatus(els.qmStatus, "❌ " + err.message, true);
    return false;
  }
}

function bindQuickMovEvents() {
  els.qmSubmit.addEventListener("click", async (ev) => {
    if (!els.qmImporte.value || !els.qmConcepto.value.trim()) {
      ev.preventDefault();
      setStatus(els.qmStatus, "Importe y Concepto son obligatorios.", true);
      return;
    }
    if (!(await submitQuickMov())) ev.preventDefault();
  });
}

function bindAjustesEvents() {
  els.btnCambiarPinAdmin.addEventListener("click", async () => {
    const actual = els.ajustePinAdmin.value;
    const nuevo = els.ajustePinNuevo.value.trim();
    const conf = els.ajustePinConfirmar.value.trim();
    const st = els.ajustesStatus;
    if (!nuevo || nuevo.length < 3) { setStatus(st, "Nuevo PIN demasiado corto (mín. 3 dígitos).", true); return; }
    if (nuevo !== conf) { setStatus(st, "Los PIN nuevos no coinciden.", true); return; }
    try {
      await api("/api/auth/cambiar-pin-admin", { method: "POST", body: JSON.stringify({ actual, nuevo }) });
      state.adminPin = String(nuevo);
      els.ajustePinAdmin.value = ""; els.ajustePinNuevo.value = ""; els.ajustePinConfirmar.value = "";
      setStatus(st, "✅ PIN de administrador cambiado correctamente.", false, true);
    } catch (err) {
      setStatus(st, "❌ " + err.message, true);
    }
  });

  els.btnExportarTodo.addEventListener("click", async () => {
    try {
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0, 10);
      const url = (API_BASE || "") + "/api/backup/exportar";
      const tok = getToken();
      const res = await fetch(url, { headers: { "Authorization": tok ? "Bearer " + tok : "" } });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      a.href = href; a.download = `backup_gestion_obras_${ts}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(href), 5000);
    } catch (err) {
      alert("❌ Error al exportar backup: " + err.message);
    }
  });

  const btnRestAuto = document.getElementById("btnRestaurarBackupAuto");
  if (btnRestAuto) btnRestAuto.addEventListener("click", async () => {
    try {
      setStatus(els.ajustesStatus, "⏳ Recuperando último backup automático...", false);
      const res = await api("/api/backup/restaurar-ultimo-automatico", { method: "POST", body: "{}" });
      state.cajasData = null; await loadAllData(false, true);
      renderLoginSelect(); try { await renderAll(); } catch {}
      const r = res?.resumen || {};
      setStatus(els.ajustesStatus, `✅ Último backup restaurado correctamente: ${r.trabajadores||0} trabajadores, ${r.obras||0} obras, ${r.horas||0} horas, ${r.movimientos||0} movimientos.`, false, true);
      const wb = document.getElementById("warningBackupBanner");
      if (wb) wb.classList.add("hidden");
    } catch (err) {
      setStatus(els.ajustesStatus, "❌ No se pudo restaurar: " + err.message, true);
    }
  });

  document.getElementById("importarTodoFile").addEventListener("change", async (ev) => {
    const f = ev.target.files?.[0]; if (!f) return;
    if (!(await confirmAction("Importar backup", "Esto sobrescribirá TODOS los datos actuales (servidor). ¿Continuar?"))) { ev.target.value = ""; return; }
    try {
      const txt = await f.text();
      const b = JSON.parse(txt);
      if (!b || !Array.isArray(b.trabajadores)) throw new Error("Archivo no válido.");
      await api("/api/backup/restaurar", { method: "POST", body: JSON.stringify(b) });
      state.cajasData = null; await loadAllData(false, true);
      renderLoginSelect(); try { await renderAll(); } catch {}
      setStatus(els.ajustesStatus, "✅ Backup importado correctamente (datos en servidor).", false, true);
    } catch (err) {
      setStatus(els.ajustesStatus, "❌ Error al importar: " + err.message, true);
    }
    ev.target.value = "";
  });

  els.btnBorrarTodo.addEventListener("click", async () => {
    if (!(await confirmAction("⚠️ BORRAR TODO", "Esto eliminará trabajadores, obras, horas y movimientos del servidor. ¡Irreversible!"))) return;
    if (!(await confirmAction("Confirmación final", "¿Seguro que quieres borrar TODOS los datos del servidor?"))) return;
    try {
      await api("/api/backup/restaurar", { method: "POST", body: JSON.stringify({ trabajadores: [], obras: [], horas: [], movimientos: [], settings: [{ clave: "admin_pin", valor: DEFAULT_ADMIN_PIN }] }) });
      state.adminPin = DEFAULT_ADMIN_PIN;
      await loadAllData();
      renderLoginSelect(); try { await renderAll(); } catch {}
      setStatus(els.ajustesStatus, "✅ Datos del servidor borrados. PIN restaurado a 1234.", false, true);
    } catch (err) {
      setStatus(els.ajustesStatus, "❌ " + err.message, true);
    }
  });
}

/* ============ ELEMENTOS CACHE + BIND EVENTS GENERALES ============ */
function cacheEls() {
  const ids = [
    "trabajadorForm","trabajadorId","trabajadorNombre","trabajadorPin","trabajadorRol","trabajadorDni","trabajadorTelefono",
    "trabajadorTarifa","trabajadorTarifaExtra","trabajadorCategoria","trabajadorActivo",
    "btnGuardarTrabajador","btnLimpiarTrabajador","trabajadorStatus","listaTrabajadores","buscarTrabajador",
    "obraForm","obraId","obraNombre","obraCliente","obraDireccion","obraPresupuesto",
    "obraFechaInicio","obraFechaFin","obraEstado","obraNotas",
    "btnGuardarObra","btnLimpiarObra","obraStatus","listaObras","buscarObra","filtroEstadoObra",
    "horasForm","horaId","horaFecha","horaTrabajador","horaObra","horaCantidad",
    "horaNotas","btnGuardarHora","btnLimpiarHora","horaStatus",
    "listaHoras","filtroHorasDesde","filtroHorasHasta","filtroHorasTrabajador",
    "filtroHorasObra","btnAplicarFiltrosHoras","btnLimpiarFiltrosHoras",
    "totalHorasFiltradas","totalCosteHoras","totalRegistrosHoras",
    "movimientoForm","movimientoId","movimientoFecha","movimientoTipo","movimientoImporte",
    "movimientoObra","movimientoResponsable","movimientoCategoria","movimientoFormaPago","movimientoConcepto",
    "movimientoReferencia","btnGuardarMovimiento","btnLimpiarMovimiento","movimientoStatus",
    "listaMovimientos","totalIngresos","totalGastos","balanceNeto",
    "filtroMovDesde","filtroMovHasta","filtroMovTipo","filtroMovObra",
    "btnAplicarFiltrosMov","btnLimpiarFiltrosMov",
    "dashTrabajadores","dashObras","dashHorasMes","dashBeneficio",
    "dashboardObrasList","dashboardMovimientos",
    "cierreMes","btnCalcularCierre","cierreTrabajadores","cierreObras","resumenMes",
    "btnExportarSueldos",
    "ajustePinAdmin","ajustePinNuevo","ajustePinConfirmar","btnCambiarPinAdmin","ajustesStatus",
    "btnExportarTodo","btnBorrarTodo",
    "quickObra","btnQuickNewObra","quickNewObraDialog","quickNewObraForm",
    "qnoNombre","qnoCliente","qnoDireccion","qnoStatus","qnoSubmit",
    "quickMovDialog","quickMovForm","qmTitle","qmHint","qmObraId","qmTipo","qmFecha","qmImporte","qmResponsable","qmCategoria","qmFormaPago","qmConcepto","qmReferencia","qmStatus","qmSubmit",
    "cajasDesde","cajasHasta","btnCajasMesActual","btnCajasTodo","btnCajasRefresh",
    "cajasGlobalCards","cajasSaldosTable","cajasSelectedInfo","cajasMovimientosList","cajasMovTitle",
  ];
  ids.forEach((id) => { els[id] = document.getElementById(id); });
}

function bindGeneralEvents() {
  els.trabajadorForm.addEventListener("submit", onSubmitTrabajador);
  els.btnLimpiarTrabajador.addEventListener("click", clearTrabajadorForm);
  els.buscarTrabajador.addEventListener("input", (e) => { state.filtros.buscarTrabajador = e.target.value; renderTrabajadores(); });
  const td = document.getElementById("trabajadoresDesde");
  const th = document.getElementById("trabajadoresHasta");
  if (td) td.addEventListener("change", (e) => { state.filtros.trabajadoresDesde = e.target.value || null; renderTrabajadores(); });
  if (th) th.addEventListener("change", (e) => { state.filtros.trabajadoresHasta = e.target.value || null; renderTrabajadores(); });
  const btnTrabMes = document.getElementById("btnTrabMes");
  if (btnTrabMes) btnTrabMes.addEventListener("click", () => {
    state.filtros.trabajadoresDesde = startOfMonthISO();
    state.filtros.trabajadoresHasta = todayISO();
    if (td) td.value = state.filtros.trabajadoresDesde;
    if (th) th.value = state.filtros.trabajadoresHasta;
    renderTrabajadores();
  });
  const btnTrabAct = document.getElementById("btnTrabActualizar");
  if (btnTrabAct) btnTrabAct.addEventListener("click", async () => { await forceSyncUI(); renderTrabajadores(); });

  // Submit Entrega a Cuenta (modal nuevo)
  const formEC = document.getElementById("entregaCuentaForm");
  if (formEC) {
    formEC.addEventListener("submit", async (ev) => {
      if (ev.submitter && ev.submitter.value === "cancel") return;
      ev.preventDefault();
      const trabajadorId = document.getElementById("ecTrabajadorId").value;
      const t = getTrabajadorById(trabajadorId);
      const stEC = document.getElementById("ecStatus");
      const importe = Number(document.getElementById("ecImporte").value || 0);
      if (!t || !trabajadorId) { setStatus(stEC, "Trabajador no encontrado", true); return; }
      if (!(importe > 0)) { setStatus(stEC, "Importe incorrecto", true); return; }
      try {
        setStatus(stEC, "⏳ Guardando entrega a cuenta...", false);
        const _u = state.session?.user || null;
        const yoId = (_u?.userId) || (_u?.trabajadorId) || null;
        const _selRealizadoPor = document.getElementById("ecRealizadoPorId");
        const realizadoPorId = (_selRealizadoPor?.value ? _selRealizadoPor.value : yoId) || null;
        const payload = {
          fecha: document.getElementById("ecFecha").value || todayISO(),
          tipo: "gasto",
          importe: importe.toFixed(2),
          obraId: document.getElementById("ecObraId").value || "",
          responsableId: trabajadorId,
          realizadoPorId: realizadoPorId || null,
          categoria: "nomina",
          formaPago: document.getElementById("ecFormaPago").value || "efectivo",
          concepto: document.getElementById("ecConcepto").value.trim() || "Adelanto nómina / entrega a cuenta",
          notas: "",
          createdAt: new Date().toISOString(),
        };
        await saveMovimientoCUD("POST", payload);
        state.cajasData = null;
        await loadAllData(false, true);
        populateResponsablesSelect();
        try { await renderAll(); } catch {}
        setStatus(stEC, `✅ Entrega ${formatMoney(importe)} a "${t.nombre}" registrada correctamente. Neto a pagar actualizado.`, false, true);
        setTimeout(() => {
          const dlg = document.getElementById("entregaCuentaDialog");
          if (dlg && typeof dlg.close === "function") dlg.close();
          setStatus(stEC, "");
        }, 1200);
      } catch (err) {
        setStatus(stEC, "❌ " + err.message, true);
      }
    });
  }

  els.obraForm.addEventListener("submit", onSubmitObra);
  els.btnLimpiarObra.addEventListener("click", clearObraForm);
  els.buscarObra.addEventListener("input", (e) => { state.filtros.buscarObra = e.target.value; renderObras(); });
  els.filtroEstadoObra.addEventListener("change", (e) => { state.filtros.filtroEstadoObra = e.target.value; renderObras(); });

  els.horasForm.addEventListener("submit", onSubmitHora);
  els.btnLimpiarHora.addEventListener("click", clearHoraForm);
  els.btnAplicarFiltrosHoras.addEventListener("click", () => {
    state.filtros.horas = {
      desde: els.filtroHorasDesde.value || null,
      hasta: els.filtroHorasHasta.value || null,
      trabajador: els.filtroHorasTrabajador.value,
      obra: els.filtroHorasObra.value,
    };
    renderHoras();
  });
  els.btnLimpiarFiltrosHoras.addEventListener("click", () => {
    els.filtroHorasDesde.value = ""; els.filtroHorasHasta.value = "";
    els.filtroHorasTrabajador.value = "todos"; els.filtroHorasObra.value = "todas";
    state.filtros.horas = { desde: null, hasta: null, trabajador: "todos", obra: "todas" };
    renderHoras();
  });

  els.movimientoForm.addEventListener("submit", onSubmitMovimiento);
  els.btnLimpiarMovimiento.addEventListener("click", clearMovimientoForm);
  els.movimientoTipo.addEventListener("change", () => {
    const sel = els.movimientoCategoria; const cur = sel.value;
    const validas = Object.entries(CATEGORIAS_MOV).filter(([_, v]) => v.tipo === els.movimientoTipo.value);
    sel.innerHTML = validas.map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v.label)}</option>`).join("");
    if (validas.some(([k]) => k === cur)) sel.value = cur;
  });
  els.btnAplicarFiltrosMov.addEventListener("click", () => {
    state.filtros.mov = {
      desde: els.filtroMovDesde.value || null,
      hasta: els.filtroMovHasta.value || null,
      tipo: els.filtroMovTipo.value,
      obra: els.filtroMovObra.value,
    };
    renderMovimientos();
  });
  els.btnLimpiarFiltrosMov.addEventListener("click", () => {
    els.filtroMovDesde.value = ""; els.filtroMovHasta.value = "";
    els.filtroMovTipo.value = "todos"; els.filtroMovObra.value = "todas";
    state.filtros.mov = { desde: null, hasta: null, tipo: "todos", obra: "todas" };
    renderMovimientos();
  });

  els.btnCalcularCierre.addEventListener("click", renderCierre);
  els.btnExportarSueldos.addEventListener("click", exportarSueldosCSV);
}

function setDefaults() {
  if (els.horaFecha) els.horaFecha.value = todayISO();
  if (els.movimientoFecha) els.movimientoFecha.value = todayISO();
  if (els.cierreMes) els.cierreMes.value = currentMonthISO();
}

async function renderAll() {
  try {
    const trabajadoresIds = [...new Set((state.horas || []).map((h) => h.trabajadorId))];
    trabajadoresIds.forEach((tid) => {
      const fechas = [...new Set((state.horas || []).filter((h) => h.trabajadorId === tid).map((h) => h.fecha))];
      fechas.forEach((f) => { try { recalcularDesgloseParaTrabajadorDia(tid, f); } catch {} });
    });
  } catch {}
  try { if (typeof renderSelects === "function") renderSelects(); } catch {}
  try { if (typeof populateResponsablesSelect === "function") populateResponsablesSelect(); } catch {}
  if (isAdmin()) {
    try { if (typeof renderTrabajadores === "function") renderTrabajadores(); } catch {}
    try { if (typeof renderObras === "function") renderObras(); } catch {}
    try { if (typeof renderDashboard === "function") renderDashboard(); } catch {}
    try { if (typeof renderBalanceGeneral === "function") renderBalanceGeneral(); } catch {}
    try { if (typeof renderMovimientos === "function") renderMovimientos(); } catch {}
    try { if (typeof renderCierre === "function") renderCierre(); } catch {}
    try { if (typeof renderCajas === "function") await renderCajas(); } catch {}
  } else if (isWorker()) {
    try { if (typeof populateWorkerQuickForm === "function") populateWorkerQuickForm(); } catch {}
    try { if (typeof renderWorkerSummary === "function") renderWorkerSummary(); } catch {}
  }
  try { if (typeof renderHoras === "function") renderHoras(); } catch {}
}

/* ============ RESPONSABLES / CAJAS (SOCIOS) - VERSIÓN FIABLE (SIN RACES ASÍNCRONAS) ============ */
let _cajasLoadLock = null;

function populateResponsablesSelect() {
  try {
    const opts = ['<option value="">Sin asignar (general)</option>'];
    const optsSocios = ['<option value="">(Yo, el admin actual)</option>'];
    const _u = state.session?.user || null;
    const yoId = (_u?.userId) || (_u?.trabajadorId) || null;
    getTrabajadoresActivos().forEach(t => {
      if (!t || !t.id) return;
      const rolLabel = t.rol === "admin" ? "👑 Socio/Admin" : "👷 Trabajador";
      opts.push(`<option value="${escapeHtml(t.id)}">${rolLabel} · ${escapeHtml(t.nombre || "?")}</option>`);
      const esSocio = String(t.rol || "").toLowerCase() === "admin" || String(t.rol || "").toLowerCase() === "socio";
      if (esSocio) optsSocios.push(`<option value="${escapeHtml(t.id)}" ${t.id === yoId ? "selected" : ""}>👑 ${escapeHtml(t.nombre || "?")} (${escapeHtml(t.rol || "socio")})</option>`);
    });
    if (yoId && !optsSocios.some(o => o.includes(`value="${yoId}"`))) {
      // Si soy admin genérico y NO estoy en trabajadores (soy el admin PIN principal), me añado al PRINCIPIO:
      optsSocios.splice(1, 0, `<option value="${yoId}" selected>👑 (Tú, Admin actual - caja general)</option>`);
    }
    if (els.movimientoResponsable) {
      const prev = els.movimientoResponsable.value;
      els.movimientoResponsable.innerHTML = opts.join("");
      if (prev) els.movimientoResponsable.value = prev;
    }
    if (els.qmResponsable) {
      const prev2 = els.qmResponsable.value;
      els.qmResponsable.innerHTML = opts.join("");
      if (prev2) els.qmResponsable.value = prev2;
    }
    // ✅ NUEVOS selects: RealizadoPor (QUIEN COBRA/PAGA = caja personal)
    const qmReal = document.getElementById("qmRealizadoPor");
    if (qmReal) {
      const prev = qmReal.value;
      qmReal.innerHTML = optsSocios.join("");
      if (prev) qmReal.value = prev;
      // Si no hay nada seleccionado, elige el admin actual (yo):
      if (!qmReal.value && yoId) {
        if (qmReal.querySelector(`option[value="${yoId}"]`)) qmReal.value = yoId;
      }
    }
    const movReal = document.getElementById("movimientoRealizadoPor");
    if (movReal) {
      const prev3 = movReal.value;
      movReal.innerHTML = optsSocios.join("");
      if (prev3) movReal.value = prev3;
      if (!movReal.value && yoId) {
        if (movReal.querySelector(`option[value="${yoId}"]`)) movReal.value = yoId;
      }
    }
    const ecReal = document.getElementById("ecRealizadoPorId");
    // OJO: ecRealizadoPorId se rellena en abrirEntregaCuenta() individualmente cada vez que abre
    // pero si ya existía valor lo restauramos:
    // (no hace falta aquí, solo para el fill inicial de qmRealizadoPor)
  } catch (e) { console.warn("populateResponsablesSelect:", e); }
}

async function loadCajasData(force = false) {
  if (!isAdmin()) return null;
  if (_cajasLoadLock) return _cajasLoadLock;
  if (!force && state.cajasData) return state.cajasData;

  _cajasLoadLock = (async () => {
    const qs = new URLSearchParams();
    if (state.filtros.cajas.desde) qs.set("desde", state.filtros.cajas.desde);
    if (state.filtros.cajas.hasta) qs.set("hasta", state.filtros.cajas.hasta);
    const q = qs.toString();
    const data = await api(`/api/cajas${q ? "?" + q : ""}`);
    state.cajasData = data || null;
    return state.cajasData;
  })();
  try { return await _cajasLoadLock; } finally { _cajasLoadLock = null; }
}

function _setCajasLoadingUI(loadingMsg) {
  if (!els || !els.cajasSaldosTable) return;
  if (!loadingMsg) return;
  const tbody = els.cajasSaldosTable.querySelector("tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="empty"><span style="font-size:1.1em">⏳ ${escapeHtml(loadingMsg)}</span></td></tr>`;
  if (els.cajasGlobalCards) els.cajasGlobalCards.innerHTML = `<div class="stat-card stat-blue" style="grid-column:1/-1"><h3>💵 Cajas</h3><p class="stat-value" style="font-size:1.3em">⏳ ${escapeHtml(loadingMsg)}</p></div>`;
  if (els.cajasMovimientosList) els.cajasMovimientosList.innerHTML = `<li class="empty">⏳ ${escapeHtml(loadingMsg)}</li>`;
}

function renderCajasGlobalCards() {
  if (!isAdmin() || !els.cajasGlobalCards) return;
  const d = state.cajasData?.saldos || [];
  let totalIngresos = 0, totalGastos = 0, totalSocios = 0, totalSaldos = 0;
  d.forEach((r) => {
    if (r.rol === "admin") totalSocios++;
    totalIngresos += r.ingresos || 0;
    totalGastos += r.gastos || 0;
    totalSaldos += r.saldo || 0;
  });
  const cards = [
    { title: "👥 Socios / Responsables", value: `${totalSocios}`, cls: "stat-blue" },
    { title: "📥 Ingresos Totales Periodo", value: formatMoney(totalIngresos), cls: "stat-green" },
    { title: "📤 Gastos Totales Periodo", value: formatMoney(totalGastos), cls: "stat-red" },
    { title: "💰 Saldos Cajas (Ing - Gast)", value: formatMoney(totalSaldos), cls: totalSaldos >= 0 ? "stat-purple" : "stat-orange" },
  ];
  els.cajasGlobalCards.innerHTML = cards.map(c =>
    `<div class="stat-card ${c.cls}"><h3>${c.title}</h3><p class="stat-value">${c.value}</p></div>`
  ).join("");
}
function renderCajasSaldosTable() {
  if (!isAdmin() || !els.cajasSaldosTable) return;
  const d = state.cajasData?.saldos || [];
  const tbody = els.cajasSaldosTable.querySelector("tbody");
  if (!tbody) return;
  if (d.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No hay trabajadores dados de alta</td></tr>`;
    return;
  }
  const selId = state.filtros.cajas.selectedTrabajadorId;
  tbody.innerHTML = d.map((r) => {
    const isSel = selId === r.trabajadorId ? "selected" : "";
    const rolBadge = r.rol === "admin" ? `<span class="role-badge admin" style="margin:0">👑 Socio</span>` : `<span class="role-badge worker" style="margin:0">👷 Trab.</span>`;
    const saldoCls = (r.saldo || 0) >= 0 ? "text-green" : "text-red";
    return `<tr data-trabajador="${r.trabajadorId}" class="${isSel}" style="cursor:pointer">
      <td><strong>${escapeHtml(r.nombre)}</strong></td>
      <td>${rolBadge}</td>
      <td class="text-green">${formatMoney(r.ingresos || 0)}</td>
      <td class="text-red">${formatMoney(r.gastos || 0)}</td>
      <td class="${saldoCls}"><strong>${formatMoney(r.saldo || 0)}</strong></td>
      <td class="text-muted">${r.numMov || 0}</td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll("tr[data-trabajador]").forEach(tr => {
    tr.addEventListener("click", () => {
      const tid = tr.dataset.trabajador;
      state.filtros.cajas.selectedTrabajadorId = state.filtros.cajas.selectedTrabajadorId === tid ? null : tid;
      if (els.cajasSelectedInfo) {
        if (state.filtros.cajas.selectedTrabajadorId) {
          const t = getTrabajadorById(state.filtros.cajas.selectedTrabajadorId);
          els.cajasSelectedInfo.textContent = `🔍 Filtrando movimientos de: ${t?.nombre || "?"}. Pulsa otra vez para quitar filtro.`;
        } else {
          els.cajasSelectedInfo.textContent = "Pulsa una fila para ver los movimientos de esa caja";
        }
      }
      renderCajasMovimientos();
      renderCajasSaldosTable();
      renderCajasSociosTable();
    });
  });
}
// ✅ NUEVA: Saldos de CAJA PERSONAL por Socio/Admin (lo que realmente paga o cobra cada socio de su bolsillo)
function renderCajasSociosTable() {
  if (!isAdmin()) return;
  const tbl = document.getElementById("cajasSociosTable");
  if (!tbl) return;
  const tbody = tbl.querySelector("tbody");
  if (!tbody) return;
  // Agrupar por realizadoPorId:
  const { desde, hasta } = state.filtros.cajas || {};
  let movs = [...(state.movimientos || [])];
  if (desde) movs = movs.filter((m) => (m.fecha || "") >= desde);
  if (hasta) movs = movs.filter((m) => (m.fecha || "") <= hasta);
  // Solo movimientos que TIENEN socio asignado (realizadoPorId):
  const agrupado = {};
  movs.forEach((m) => {
    if (!m.realizadoPorId) return;
    if (!agrupado[m.realizadoPorId]) {
      agrupado[m.realizadoPorId] = { trabajadorId: m.realizadoPorId, ingresos: 0, gastos: 0, numMov: 0 };
    }
    agrupado[m.realizadoPorId].numMov++;
    if (String(m.tipo || "").toLowerCase() === "ingreso") agrupado[m.realizadoPorId].ingresos += Number(m.importe) || 0;
    else agrupado[m.realizadoPorId].gastos += Number(m.importe) || 0;
  });
  const filas = Object.values(agrupado).map((r) => {
    const t = getTrabajadorById(r.trabajadorId);
    return {
      ...r,
      nombre: t?.nombre || `(Socio ID: ${String(r.trabajadorId).slice(0,6)}...)`,
      rol: t?.rol || (t?.id ? "socio" : "desconocido"),
      saldo: (r.ingresos || 0) - (r.gastos || 0),
    };
  }).sort((a,b) => String(b.nombre || "").localeCompare(a.nombre || ""));
  // Añadimos los socios/admins que NO tengan movimientos aun (saldos 0):
  (state.trabajadores || []).forEach(t => {
    if (String(t.rol || "").toLowerCase() === "admin" || String(t.rol || "").toLowerCase() === "socio") {
      if (!filas.some(x => x.trabajadorId === t.id)) filas.push({
        trabajadorId: t.id,
        nombre: t.nombre,
        rol: t.rol || "socio",
        ingresos: 0, gastos: 0, saldo: 0, numMov: 0,
      });
    }
  });
  if (filas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Sin movimientos por socio. 💡 Pulsa 💸 Entrega a Cuenta en 👷 Trabajadores y se verá aquí la salida de TU caja (socio).</td></tr>`;
    return;
  }
  tbody.innerHTML = filas.map(r => {
    const rolBadge = r.rol === "admin" ? `<span class="role-badge admin" style="margin:0">👑 Socio</span>` : `<span class="role-badge worker" style="margin:0">👷 ${escapeHtml(r.rol || "—")}</span>`;
    const saldoCls = (r.saldo || 0) >= 0 ? "text-green" : "text-red";
    return `<tr style="background:#fff;">
      <td><strong style="color:#6b21a8;">${escapeHtml(r.nombre || "")}</strong></td>
      <td>${rolBadge}</td>
      <td class="text-green">${formatMoney(r.ingresos || 0)}</td>
      <td class="text-red">${formatMoney(r.gastos || 0)}</td>
      <td class="${saldoCls}"><strong>${formatMoney(r.saldo || 0)}</strong></td>
      <td class="text-muted">${r.numMov || 0}</td>
    </tr>`;
  }).join("");
}
function renderCajasMovimientos() {
  if (!isAdmin() || !els.cajasMovimientosList || !els.cajasMovTitle) return;
  let movs = [...state.movimientos];
  const { desde, hasta, selectedTrabajadorId } = state.filtros.cajas;
  if (desde) movs = movs.filter((m) => m.fecha >= desde);
  if (hasta) movs = movs.filter((m) => m.fecha <= hasta);
  if (selectedTrabajadorId) {
    movs = movs.filter((m) => m.responsableId === selectedTrabajadorId);
    const t = getTrabajadorById(selectedTrabajadorId);
    els.cajasMovTitle.textContent = `🧾 Movimientos de la caja de: ${t?.nombre || "?"} (${movs.length})`;
  } else {
    els.cajasMovTitle.textContent = `🧾 Últimos Movimientos (todas las cajas, ${movs.length})`;
  }
  movs = movs.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
  if (movs.length === 0) {
    els.cajasMovimientosList.innerHTML = `<li class="empty">No hay movimientos en este periodo</li>`;
    return;
  }
  els.cajasMovimientosList.innerHTML = movs.slice(0, 100).map((m) => {
    const ob = getObraById(m.obraId);
    const resp = m.responsableId ? getTrabajadorById(m.responsableId) : null;
    const real = m.realizadoPorId ? getTrabajadorById(m.realizadoPorId) : null;
    const isIng = m.tipo === "ingreso";
    const sign = isIng ? "+" : "-";
    const colorCls = isIng ? "text-green" : "text-red";
    const icon = isIng ? "📥" : "📤";
    return `<li class="list-item">
      <div>
        <strong class="${colorCls}">${icon} ${sign}${formatMoney(Number(m.importe) || 0)}</strong>
        <div class="text-muted small">${formatDate(m.fecha)} · ${CATEGORIAS_MOV[m.categoria] || m.categoria || "Sin categ."} ${resp ? ` · 💵 ${escapeHtml(resp.nombre)}` : ""} ${real ? ` · 👑 ${isIng ? "Cobrado por" : "Pagado por"}: ${escapeHtml(real.nombre)}` : ""}</div>
        <div>${escapeHtml(m.concepto || "")} ${ob ? `<span class="text-muted small"> · 🏗️ ${escapeHtml(ob.nombre)}</span>` : ""}</div>
      </div>
    </li>`;
  }).join("");
}
async function renderCajas(options = {}) {
  if (!isAdmin()) return;
  const force = Boolean(options.force);
  try {
    if (force) state.cajasData = null;
    _setCajasLoadingUI("Actualizando cajas y saldos...");
    await loadCajasData(force);
    renderCajasGlobalCards();
    renderCajasSaldosTable();
    renderCajasSociosTable(); // ✅ NUEVA tabla saldos por caja personal de socio
    renderCajasMovimientos();
  } catch (e) {
    console.warn("renderCajas error:", e);
    if (els && els.cajasSaldosTable) {
      const t = els.cajasSaldosTable.querySelector("tbody");
      if (t) t.innerHTML = `<tr><td colspan="6" class="empty" style="color:#b91c1c">❌ Error al cargar cajas. Pulsa Actualizar</td></tr>`;
    }
  }
}
async function refreshCajasFull() {
  try {
    state.cajasData = null;
    _cajasLoadLock = null;
    _setCajasLoadingUI("Descargando datos actualizados...");
    await loadAllData(true, true);
    await renderCajas({ force: true });
  } catch (e) { console.warn(e); }
}
function bindCajasEvents() {
  if (!els.cajasDesde) return;
  const setFiltrosUI = () => {
    state.filtros.cajas.desde = els.cajasDesde.value || null;
    state.filtros.cajas.hasta = els.cajasHasta.value || null;
  };
  els.cajasDesde.addEventListener("change", async () => { setFiltrosUI(); await refreshCajasFull(); });
  els.cajasHasta.addEventListener("change", async () => { setFiltrosUI(); await refreshCajasFull(); });
  els.btnCajasMesActual.addEventListener("click", async () => {
    const d = new Date(); const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0");
    els.cajasDesde.value = `${y}-${m}-01`; const ld = new Date(y, d.getMonth() + 1, 0);
    els.cajasHasta.value = `${y}-${m}-${String(ld.getDate()).padStart(2, "0")}`;
    setFiltrosUI(); await refreshCajasFull();
  });
  els.btnCajasTodo.addEventListener("click", async () => {
    els.cajasDesde.value = ""; els.cajasHasta.value = "";
    state.filtros.cajas.desde = null; state.filtros.cajas.hasta = null;
    state.filtros.cajas.selectedTrabajadorId = null;
    if (els.cajasSelectedInfo) els.cajasSelectedInfo.textContent = "Pulsa una fila para ver los movimientos de esa caja";
    await refreshCajasFull();
  });
  els.btnCajasRefresh.addEventListener("click", () => refreshCajasFull());
}

async function init() {
  cacheEls();
  setupTabs();
  bindLoginEvents();
  bindWorkerQuickEvents();
  bindGeneralEvents();
  bindAjustesEvents();
  bindQuickNewObraEvents();
  bindQuickMovEvents();
  bindCajasEvents();
  setDefaults();

  const ok = await loadAllData();
  if (ok && state.session.role) {
    applyRoleUI();
    try { await renderAll(); } catch {}
  } else {
    try {
      const dummyTok = getToken();
      if (dummyTok) {
        try { await loadAllData(); } catch {}
      }
    } catch {}
    showLoginScreen();
  }

  const POLLING_MS = IS_MOBILE ? 25000 : 45000; // móvil cada 25s (más propenso a caché), PC 45s
  function canAutoRefresh() {
    if (!state.session?.role) return false;
    if (document.hidden) return false;
    const dialogs = document.querySelectorAll("dialog");
    for (const d of dialogs) if (d.open) return false;
    const ae = document.activeElement;
    if (ae && ["INPUT","TEXTAREA","SELECT"].includes(ae.tagName) && ae.type !== "submit" && ae.type !== "button") return false;
    return true;
  }
  let _lastUserActivityAt = Date.now();
  ["mousedown","keydown","touchstart","visibilitychange","focus","scroll","click","touchend","touchmove"].forEach(ev => {
    window.addEventListener(ev, () => _lastUserActivityAt = Date.now(), { passive: true });
  });
  async function silentRefresh() {
    if (!canAutoRefresh()) return;
    if (Date.now() - _lastUserActivityAt > 90000) return;
    try {
      const ok2 = await loadAllData(true);
      if (ok2) try { await renderAll(); } catch {}
    } catch (e) { /* ignore */ }
  }

  // ✅ MÓVIL: al VOLVER de fondo (app suspendida) hacemos SÍ O SÍ forceSync (ignora cooldown)
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden) {
      if (IS_MOBILE) { try { await forceSyncUI(); } catch {} }
      else { await silentRefresh(); }
    }
  });
  window.addEventListener("focus", async () => {
    if (IS_MOBILE && Date.now() - _lastLoadedAt > 6000) { try { await forceSyncUI(); } catch {} }
    else { await silentRefresh(); }
  });
  window.addEventListener("online", async () => { try { await forceSyncUI(); } catch {} });
  setInterval(silentRefresh, POLLING_MS);
  // 👁️ VIGILANTE DE SESIÓN: cada 30s comprueba que TOKEN + SESIÓN existan.
  // Si el usuario limpió caché en segundo plano, lo mandamos a login de inmediato.
  setInterval(() => {
    const ok = forzarConsistenciaLogin();
    if (!ok) {
      try { loadSession(); } catch {}
      try { logout(true); showLoginScreen(); } catch {}
    }
  }, 30000);
  // Badge móvil visible en navbar para saber que estamos en modo móvil optimizado
  const syncBadge = document.getElementById("ultimaSyncInfo");
  if (syncBadge && IS_MOBILE) syncBadge.title = "📱 MODO MÓVIL ACTIVADO: sincroniza más rápido (25s). Si no ves datos nuevos pulsa 🔄 Sincronizar.";
}

document.addEventListener("DOMContentLoaded", init);
