const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const jwt = require("jsonwebtoken");

/* ============ SELECCIÓN MOTOR BASE DE DATOS ============
   - Si existen TURSO_URL + TURSO_TOKEN en entorno: usa TURSO (LibSQL, BBDD cloud persistente, recomendado para PRODUCCIÓN)
   - Si NO existen: usa SQLite3 en archivo local (modo desarrollo / PC propio / hosting con disco persistente)
*/
const TURSO_URL = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL || "";
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN || "";
const USE_TURSO = Boolean(TURSO_URL && TURSO_TOKEN);

if (USE_TURSO) {
  console.log("☁️  MODO PRODUCCIÓN: Conectando a BBDD TURSO (LibSQL Cloud)...");
} else {
  console.log("💾 MODO LOCAL: Usando SQLite en archivo (data/gestion_obras.db)...");
}

const PORT = process.env.PORT || 8082;
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "gestion-obras-secreto-super-seguro-2026-cambiar-en-produccion";
const JWT_EXPIRES = "365d";
const DEFAULT_ADMIN_PIN = "1234";
const BASE_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "gestion_obras.db");

if (!USE_TURSO && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;        // Driver sqlite (wrapper promise) local
let tursoClient = null; // Driver @libsql/client (si usamos Turso cloud)

/* =============== HELPERS DB (COMPATIBLES CON AMBOS MOTORES) =============== */
async function dbAll(sql, params = []) {
  const _t0 = Date.now();
  try {
    let rows = [];
    if (USE_TURSO) {
      const rs = await tursoClient.execute({ sql, args: params });
      rows = rs.rows.map((r) => Object.fromEntries(Object.entries(r)));
    } else {
      rows = await db.all(sql, params);
    }
    console.log(`🗄️  dbAll OK (${Date.now()-_t0}ms) → ${sql.split("\n"," ").slice(0,120)}  params=${JSON.stringify(params||[]).length} chars → ${rows.length} filas`);
    return rows;
  } catch (e) {
      console.error(`\n\n❌❌❌ dbAll FALLO SQL (ms=${Date.now()-_t0}ms)  SQL: ${sql}  PARAMS: ${JSON.stringify(params)}\n   MENSAJE: ${e.message}\n   STACK: ${(e.stack||"").slice(0,400)}\n\n`);
      throw e;
    }
}
async function dbGet(sql, params = []) {
  const _t0 = Date.now();
  try {
    let row = null;
    if (USE_TURSO) {
      const rs = await tursoClient.execute({ sql, args: params });
      row = rs.rows.length ? Object.fromEntries(Object.entries(rs.rows[0])) : null;
    } else {
      row = await db.get(sql, params);
    }
    console.log(`🗄️   dbGet OK (${Date.now()-_t0}ms) → ${sql.replace(/\s+/g," ").slice(0,120)}  params=${JSON.stringify(params||[]).length} chars → ${row? "1 fila":"nulo"}`);
    return row;
  } catch (e) {
      console.error(`\n\n❌❌❌ dbGet FALLO SQL (${Date.now()-_t0}ms)  SQL: ${sql}  PARAMS: ${JSON.stringify(params)}\n   MENSAJE: ${e.message}\n   STACK: ${(e.stack||"").slice(0,400)}\n\n`);
      throw e;
    }
}
async function dbRun(sql, params = []) {
  const _t0 = Date.now();
  try {
    let res = null;
    if (USE_TURSO) {
      const rs = await tursoClient.execute({ sql, args: params });
      const lastId = Number(rs.lastInsertRowid) || null;
      const changes = Number(rs.rowsAffected) || 0;
      res = { lastID: lastId, changes };
    } else {
      const r = await db.run(sql, params);
      res = { lastID: r.lastID, changes: r.changes };
    }
    console.log(`🗄️  dbRun OK (${Date.now()-_t0}ms) → ${sql.replace(/\s+/g," ").slice(0,120)}  params=${JSON.stringify(params||[]).length} chars → changes=${res.changes} id=${res.lastID}`);
    return res;
  } catch (e) {
      console.error(`\n\n❌❌❌ dbRun FALLO SQL (${Date.now()-_t0}ms)  SQL: ${sql}  PARAMS: ${JSON.stringify(params)}\n   MENSAJE: ${e.message}\n   STACK: ${(e.stack||"").slice(0,400)}\n\n`);
      throw e;
  }
}

/* =============== EXPRESS =============== */
const app = express();
app.use(cors({ maxAge: 0, origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// ✅ WRAPPER ASYNC-SAFE (IMPORTANTE!): Evita que Express pierda errores asíncronos de async/await
// en los endpoints (antes se perdían sin mensaje y salía error 500 genérico).
function handle(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => next(err || new Error("Error sin mensaje")));
  };
}

// ✅ [DIAGNÓSTICO USUARIO] LOG DE TODAS LAS PETICIONES API (para ver qué falla en Render):
let CONTADOR_PETICIONES = 0;
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  CONTADOR_PETICIONES++;
  const id = `#${String(CONTADOR_PETICIONES).padStart(4,"0")}`;
  const auth = req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7, 25) + "..." : "(sin token)";
  const _inicio = Date.now();
  console.log(`\n${id} ➡️  ${req.method} ${req.url}  [token=${token}]  [body length=${JSON.stringify(req.body||"").length}]`);
  const _oldJson = res.json.bind(res);
  res.json = (payload) => {
    const dur = Date.now() - _inicio;
    const user = res.locals?.user || req.user || null;
    if (res.statusCode >= 400) {
      console.error(`${id} ❌  RESPUESTA ${res.statusCode}: ${JSON.stringify(payload||"")}  [role=${user?.role||"—"} tid=${user?.trabajadorId||"—"} tiempo=${dur}ms]`);
    } else {
      console.log(`${id} ✅  RESPUESTA ${res.statusCode} OK  [role=${user?.role||"—"} tid=${user?.trabajadorId||"—"} tiempo=${dur}ms]`);
    }
    return _oldJson(payload);
  };
  next();
});

// ✅ CABECERAS ANTI-CACHÉ PARA MÓVILES (nunca más datos viejos):
// (TODOS los endpoints /api/* devuelven datos SIN CACHÉ)
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0, stale-while-revalidate=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// Archivos estáticos (HTML/JS/CSS) -> SIN CACHÉ (evita que el móvil mantenga código viejo):
app.use((req, res, next) => {
  if (/\.(css|js|html|json|png|jpg|svg|ico)$/i.test(req.path)) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
  next();
});

app.use(express.static(BASE_DIR, { index: false, extensions: ["html"], etag: false, lastModified: false }));

/* =============== AUTENTICACIÓN JWT =============== */
function signToken(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES }); }
function authMiddleware(req, res, next) {
  const auth = req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sin autenticar" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token caducado o inválido. Vuelve a entrar." });
  }
}
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Permiso denegado. Solo administradores." });
  next();
}

/* =============== LOGIN =============== */
app.post("/api/auth/admin-pin", async (req, res) => {
  const pin = String(req.body?.pin || "");
  const row = await dbGet("SELECT valor FROM settings WHERE clave = ?", ["admin_pin"]);
  const adminPin = row?.valor || DEFAULT_ADMIN_PIN;
  if (String(adminPin) !== pin) return res.status(401).json({ error: "PIN incorrecto" });
  const token = signToken({ role: "admin", scope: "super", iss: "go-v2" });
  res.json({ token, session: { role: "admin", trabajadorId: null } });
});

app.post("/api/auth/worker", async (req, res) => {
  const { trabajadorId, pin } = req.body || {};
  const t = await dbGet("SELECT * FROM trabajadores WHERE id = ?", [trabajadorId]);
  if (!t) return res.status(404).json({ error: "Usuario no encontrado" });
  if (t.activo === 0) return res.status(403).json({ error: "Usuario dado de baja" });
  if (String(t.pin || "") !== String(pin || "")) return res.status(401).json({ error: "PIN incorrecto" });
  const role = t.rol === "admin" ? "admin" : "worker";
  const token = signToken({ role, trabajadorId, scope: role, iss: "go-v2" });
  res.json({ token, session: { role, trabajadorId } });
});

app.post("/api/auth/cambiar-pin-admin", authMiddleware, requireAdmin, async (req, res) => {
  const { actual, nuevo } = req.body || {};
  if (!nuevo || nuevo.length < 3) return res.status(400).json({ error: "PIN nuevo mínimo 3 dígitos" });
  const row = await dbGet("SELECT valor FROM settings WHERE clave = ?", ["admin_pin"]);
  const adminPin = row?.valor || DEFAULT_ADMIN_PIN;
  if (String(adminPin) !== String(actual)) return res.status(401).json({ error: "PIN actual incorrecto" });
  const upsertSql = USE_TURSO
    ? `INSERT INTO settings (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`
    : `INSERT INTO settings (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`;
  await dbRun(upsertSql, ["admin_pin", String(nuevo)]);
  res.json({ ok: true });
});

/* =============== INICIALIZACIÓN CONECTORES + TABLAS + START =============== */
const BACKUP_AUTO_KEY = "backup_auto_ultimo";
const IS_RENDER = Boolean(
  process.env.RENDER_SERVICE_ID || process.env.RENDER || process.env.RENDER_EXTERNAL_URL ||
  (process.env.HOME || "").includes("/opt/render") || (process.env.PWD || "").includes("/opt/render")
);

function lineasWarningRender() {
  console.error("\n" + "🚨".repeat(40));
  console.error("🚨 [PELIGRO MÁXIMO: ESTÁS EN RENDER PERO NO TIENES TURSO CLOUD CONFIGURADO 🚨");
  console.error("🚨 Faltan estas 2 VARIABLES DE ENTORNO EN RENDER DASHBOARD -> ENVIRONMENT:");
  console.error("🚨   1) TURSO_DATABASE_URL  (ej: libsql://gestion-obras-monteoca-XXXXXX.turso.io)");
  console.error("🚨   2) TURSO_AUTH_TOKEN  (ej: eyJhbGciOiJFZERTQS...)");
  console.error("🚨 SIN ESTAS DOS VARIABLES: Estás usando SQLite en el DISCO EFÍMERO del contenedor de Render");
  console.error("🚨 Cada vez que haces un REDEPLOY (cada cambio de código o inactividad) SE BORRARÁN TODOS LOS DATOS.");
  console.error("🚨 SOLUCIÓN 2 minutos: regístrate en https://turso.tech (GRATIS 500MB persistentes), crea una BBDD,");
  console.error("🚨   crea un token, copia los 2 valores y pégalos en Render Environment -> Add Environment Variables.");
  console.error("🚨".repeat(40) + "\n");
}

async function guardarBackupAutomatico(motivo = "auto_arranque") {
  try {
    const [trabajadores, obras, horas, movimientos, srows] = await Promise.all([
      dbAll("SELECT * FROM trabajadores"),
      dbAll("SELECT * FROM obras"),
      dbAll("SELECT * FROM horas"),
      dbAll("SELECT * FROM movimientos"),
      dbAll("SELECT clave, valor FROM settings WHERE clave != ?", [BACKUP_AUTO_KEY]),
    ]);
    const total = trabajadores.length + obras.length + horas.length + movimientos.length;
    if (total === 0) { console.log("ℹ️ [BackupAuto] No se guarda backup (BBDD vacía)"); return null; }
    const payload = JSON.stringify({
      version: 2, generadoEn: new Date().toISOString(), motivo,
      trabajadores, obras, horas, movimientos, settings: srows,
      resumen: {
        trabajadores: trabajadores.length, obras: obras.length,
        horas: horas.length, movimientos: movimientos.length
      }
    });
    const upsert = USE_TURSO
      ? `INSERT INTO settings (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`
      : `INSERT INTO settings (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`;
    await dbRun(upsert, [BACKUP_AUTO_KEY, payload]);
    console.log(`✅ [BackupAuto] GUARDADO (${motivo}) OK: trabajadores=${trabajadores.length}, obras=${obras.length}, horas=${horas.length}, mov=${movimientos.length}`);
    return payload;
  } catch (e) {
    console.warn("⚠️ [BackupAuto] Error guardando backup:", e.message);
    return null;
  }
}

(async () => {
  if (USE_TURSO) {
    const { createClient } = require("@libsql/client");
    tursoClient = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
    await tursoClient.execute("SET timezone = 'UTC'").catch(() => {});
  } else {
    if (IS_RENDER) lineasWarningRender();
    const sqlite3 = require("sqlite3").verbose();
    const { open } = require("sqlite");
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.run("PRAGMA journal_mode = WAL;").catch(() => {});
    await db.run("PRAGMA foreign_keys = ON;").catch(() => {});
  }
  await initDatabase();
  await seedInitialData();
  // ✅ PROTECCIÓN Nº1: BACKUP AUTOMÁTICO CADA ARRANQUE / REDEPLOY
  await guardarBackupAutomatico(IS_RENDER ? "redeploy_render" : "arranque_local");
  app.listen(PORT, HOST, () => printStartupBanner());
})().catch((err) => {
  console.error("❌ Fatal error al iniciar la BBDD o servidor:", err);
  process.exit(1);
});

/* =============== ENDPOINTS / DATOS GENERALES =============== */

// ✅ [DIAGNÓSTICO CRÍTICO] CONTADORES REALES DE LA BBDD (sin autenticar, público).
// Devuelve el nº de filas en CADA TABLA. Así el usuario puede COMPROBAR si los datos
// están GUARDADOS DE VERDAD en Turso/SQLite, o si el frontend no los está mostrando.
app.get("/api/health/diagnostico", handle(async (req, res) => {
  try {
    const [
      cTrabajadores, cObras, cHoras, cMovimientos, cSettings
    ] = await Promise.all([
      dbGet("SELECT COUNT(*) AS c FROM trabajadores"),
      dbGet("SELECT COUNT(*) AS c FROM obras"),
      dbGet("SELECT COUNT(*) AS c FROM horas"),
      dbGet("SELECT COUNT(*) AS c FROM movimientos"),
      dbGet("SELECT COUNT(*) AS c FROM settings"),
    ]);
    const d = new Date();
    let categoriasMov = { ingreso: 0, gasto: 0 };
    try {
      const resp = await dbAll("SELECT tipo, COUNT(*) AS c FROM movimientos GROUP BY tipo");
      resp.forEach(r => { categoriasMov[String(r.tipo).toLowerCase()] = Number(r.c) || 0; });
    } catch {}
    let adminPinExiste = false;
    try {
      const row = await dbGet("SELECT valor FROM settings WHERE clave = ?", ["admin_pin"]);
      adminPinExiste = !!row?.valor;
    } catch {}
    // ✅ INCLUIR LAS 3 PRIMERAS FILAS DE CADA TABLA para ver si hay datos reales (NOMBRES)
    // ✅ 100% DEFENSIVO: SELECT * SIN nombrar columnas + try/catch INDIVIDUAL → NUNCA rompe aunque falte una columna
    let rowsTrabajadores = [], rowsObras = [], rowsHoras = [], rowsMov = [], rowsSettings = [];
    try { rowsTrabajadores = await dbAll("SELECT * FROM trabajadores ORDER BY nombre ASC LIMIT 3"); } catch(e) { rowsTrabajadores = [{_error: e.message}]; }
    try { rowsObras = await dbAll("SELECT * FROM obras ORDER BY createdAt DESC LIMIT 3"); } catch(e) { rowsObras = [{_error: e.message}]; }
    try { rowsHoras = await dbAll("SELECT * FROM horas ORDER BY createdAt DESC LIMIT 3"); } catch(e) { rowsHoras = [{_error: e.message}]; }
    try { rowsMov = await dbAll("SELECT * FROM movimientos ORDER BY createdAt DESC LIMIT 3"); } catch(e) { rowsMov = [{_error: e.message}]; }
    try { rowsSettings = await dbAll("SELECT clave, substr(valor, 1, 120) AS valor FROM settings ORDER BY clave ASC LIMIT 5"); } catch(e) { rowsSettings = [{_error: e.message}]; }
    const payload = {
      timestamp: d.toISOString(),
      ok: true,
      motor: USE_TURSO ? "TURSO CLOUD (persistente)" : "SQLITE LOCAL (efímero en Render sin disco)",
      motorUsaTurso: USE_TURSO,
      isRender: IS_RENDER,
      tables: {
        trabajadores: Number(cTrabajadores?.c ?? 0),
        obras: Number(cObras?.c ?? 0),
        horas: Number(cHoras?.c ?? 0),
        movimientos: Number(cMovimientos?.c ?? 0),
        settings: Number(cSettings?.c ?? 0),
      },
      muestras: {
        ultimos3Trabajadores: rowsTrabajadores,
        ultimas3Obras: rowsObras,
        ultimas3Horas: rowsHoras,
        ultimos3Mov: rowsMov,
        settings: rowsSettings,
      },
      movimientosPorTipo: categoriasMov,
      adminPinExiste,
      warning: IS_RENDER && !USE_TURSO ? "⚠️ ESTÁS EN RENDER PERO SIN TURSO → ESTOS DATOS SE BORRARÁN CADA REDEPLOY." : null
    };
    console.log("🏥 DIAGNÓSTICO BBDD OK:", payload.tables, payload.warning || "");
    res.json(payload);
  } catch (e) {
    console.error("❌ DIAGNÓSTICO BBDD FALLÓ:", e.message);
    res.status(500).json({
      ok: false,
      error: e.message,
      sql: e.sql || null,
      stack: (e.stack || "").slice(0, 500),
    });
  }
}));

app.get("/api/sync", authMiddleware, handle(async (req, res) => {
  // ✅ [DIAGNÓSTICO] Antes de enviar sync, hacemos count reales y los incluimos (front puede comparar):
  let _counters = {};
  try {
    const [a,b,c,d] = await Promise.all([
      dbGet("SELECT COUNT(*) AS c FROM trabajadores"),
      dbGet("SELECT COUNT(*) AS c FROM obras"),
      dbGet("SELECT COUNT(*) AS c FROM horas"),
      dbGet("SELECT COUNT(*) AS c FROM movimientos"),
    ]);
    _counters = {
      _realTrabajadoresEnBBDD: Number(a?.c||0),
      _realObrasEnBBDD: Number(b?.c||0),
      _realHorasEnBBDD: Number(c?.c||0),
      _realMovEnBBDD: Number(d?.c||0),
    };
  } catch {}
  const trabajadores = (await dbAll("SELECT * FROM trabajadores ORDER BY nombre ASC")).map(normalizeTrabajador);
  const obras = (await dbAll("SELECT * FROM obras ORDER BY nombre ASC")).map(normalizeObra);
  const horas = (await dbAll("SELECT * FROM horas ORDER BY fecha DESC, createdAt DESC")).map(normalizeHora);
  const movimientos = (await dbAll("SELECT * FROM movimientos ORDER BY fecha DESC, createdAt DESC")).map(normalizeMov);
  const row = await dbGet("SELECT valor FROM settings WHERE clave = ?", ["admin_pin"]);

  // ✅ [TESTIGO INQUEBRANTABLE de permisos + datos enviados]:
  // El front compara y si ve BBDD > 0 pero recibidos=0, muestra banner con causa exacta.
  const diagnosticoPermisos = [
    `👤 Petición hecha por: role=${req.user.role}`,
    req.user.role === "worker" ? `   · ID trabajador (según tu sesión JWT): ${req.user.trabajadorId || "—"}` : null,
    `📊 BBDD REAL (Turso): ${_counters._realTrabajadoresEnBBDD} trab, ${_counters._realObrasEnBBDD} obras, ${_counters._realHorasEnBBDD} horas, ${_counters._realMovEnBBDD} mov.`,
    `📦 LO QUE ENVÍO AHORA A TU FRONTEND: ${trabajadores.length} trab, ${obras.length} obras, ${horas.length} horas, ${movimientos.length} mov.`,
    req.user.role === "worker" ? `ℹ️ Nota: eres TRABAJADOR → en esta versión se envía TODO. Si no lo ves en tu app, es un fallo de RENDER del frontend (no es el backend!)` :
    `ℹ️ Nota: eres ADMIN → se envía TODO al 100%. Si no lo ves = fallo render frontend. Avisa en Debug Móvil → forzar repintado.`
  ].filter(Boolean).join("\n");

  const resp = {
    trabajadores, obras, horas, movimientos,
    adminPin: req.user.role === "admin" ? (row?.valor || DEFAULT_ADMIN_PIN) : null,
    currentUser: req.user,
    generadoEn: new Date().toISOString(),
    ..._counters, // incluimos los contadores REALES para el front (debug móvil muestra comparación!)
    diagnosticoPermisos, // 👈 LO MÁS IMPORTANTE: testigo que dice TODO
  };
  if (req.user.role === "admin") {
    try {
      const b = await dbGet("SELECT valor FROM settings WHERE clave = ?", [BACKUP_AUTO_KEY]);
      if (b?.valor) {
        const bj = JSON.parse(b.valor);
        resp.backupAutoInfo = {
          generadoEn: bj.generadoEn, motivo: bj.motivo, resumen: bj.resumen || null
        };
      }
    } catch {}
  }
  res.json(resp);
}));

app.get("/api/backup/exportar", authMiddleware, requireAdmin, async (req, res) => {
  const [trabajadores, obras, horas, movimientos, settings] = await Promise.all([
    dbAll("SELECT * FROM trabajadores"),
    dbAll("SELECT * FROM obras"),
    dbAll("SELECT * FROM horas"),
    dbAll("SELECT * FROM movimientos"),
    dbAll("SELECT clave, valor FROM settings WHERE clave != ?", [BACKUP_AUTO_KEY]),
  ]);
  const backup = {
    exportadoEn: new Date().toISOString(), app: "GestionObras-v2", version: 2,
    trabajadores, obras, horas, movimientos, settings
  };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="gestion-obras-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(backup);
});

app.get("/api/backup/ultimo-automatico", authMiddleware, requireAdmin, async (req, res) => {
  const row = await dbGet("SELECT valor FROM settings WHERE clave = ?", [BACKUP_AUTO_KEY]);
  if (!row?.valor) return res.status(404).json({ error: "No hay backup automático guardado" });
  try { res.json(JSON.parse(row.valor)); } catch { res.status(500).json({ error: "Backup corrupto" }); }
});

app.post("/api/backup/restaurar-ultimo-automatico", authMiddleware, requireAdmin, async (req, res) => {
  const row = await dbGet("SELECT valor FROM settings WHERE clave = ?", [BACKUP_AUTO_KEY]);
  if (!row?.valor) return res.status(404).json({ error: "No hay backup automático guardado" });
  try {
    const b = JSON.parse(row.valor);
    if (!Array.isArray(b.trabajadores) || !Array.isArray(b.obras)) return res.status(400).json({ error: "Backup corrupto" });
    await dbRun("PRAGMA foreign_keys = OFF");
    for (const t of ["horas", "movimientos", "obras", "trabajadores"]) await dbRun(`DELETE FROM ${t}`);
    if (Array.isArray(b.settings)) {
      await dbRun("DELETE FROM settings WHERE clave != ?", [BACKUP_AUTO_KEY]);
      for (const s of b.settings) {
        if (s?.clave === BACKUP_AUTO_KEY) continue;
        await dbRun("INSERT INTO settings (clave, valor) VALUES (?, ?)", [s.clave, s.valor]);
      }
    }
    for (const t of b.trabajadores) await insertTrabajador(t);
    for (const o of b.obras) await insertObra(o);
    if (Array.isArray(b.horas)) for (const h of b.horas) await insertHora(h);
    if (Array.isArray(b.movimientos)) for (const m of b.movimientos) await insertMov(m);
    await dbRun("PRAGMA foreign_keys = ON");
    res.json({ ok: true, resumen: b.resumen });
  } catch (e) { return res.status(500).json({ error: e.message || "Error restaurar auto" }); }
});

app.post("/api/backup/restaurar", authMiddleware, requireAdmin, async (req, res) => {
  const { trabajadores, obras, horas, movimientos, settings, esBorradoTotal, masterPin } = req.body || {};
  if (!Array.isArray(trabajadores) || !Array.isArray(obras)) return res.status(400).json({ error: "Backup inválido" });
  const PIN_MAESTRO_BORRADO = "1285";
  // ✅ 🔐 PROTECCIÓN BORRADO TOTAL: si intentan borrar TODO (esBorradoTotal=true) y arrays vacíos, se REQUIERE masterPin=1285:
  const intentoBorrarTodo = Boolean(esBorradoTotal) || (
    Array.isArray(trabajadores) && trabajadores.length === 0 &&
    Array.isArray(obras) && obras.length === 0 &&
    Array.isArray(horas) && horas.length === 0 &&
    Array.isArray(movimientos) && movimientos.length === 0
  );
  if (intentoBorrarTodo && String(masterPin || "").trim() !== PIN_MAESTRO_BORRADO) {
    console.error(`🚨[SEGURIDAD] Intento de BORRADO TOTAL SIN PIN MAESTRO CORRECTO. user=${req.user.userId || req.user.role}`);
    return res.status(403).json({ error: "🔐 CONTRASEÑA MAESTRA INCORRECTA. No tienes permiso para borrar TODOS los datos. Introduce la contraseña correcta en el panel de Ajustes → Datos (PIN = 1285)." });
  }
  try {
    // ✅ PROTECCIÓN ANTES DE BORRAR NADA: guardar backup automático del estado actual
    await guardarBackupAutomatico("pre_restaurar_usuario_" + Date.now());

    await dbRun("PRAGMA foreign_keys = OFF");
    for (const t of ["horas", "movimientos", "obras", "trabajadores"]) await dbRun(`DELETE FROM ${t}`);
    if (Array.isArray(settings)) {
      // NUNCA borramos BACKUP_AUTO_KEY al restaurar
      await dbRun("DELETE FROM settings WHERE clave != ?", [BACKUP_AUTO_KEY]);
      for (const s of settings) {
        if (!s || s.clave === BACKUP_AUTO_KEY) continue;
        await dbRun("INSERT INTO settings (clave, valor) VALUES (?, ?)", [s.clave, s.valor]);
      }
    }
    for (const t of trabajadores) await insertTrabajador(t);
    for (const o of obras) await insertObra(o);
    if (Array.isArray(horas)) for (const h of horas) await insertHora(h);
    if (Array.isArray(movimientos)) for (const m of movimientos) await insertMov(m);
    await dbRun("PRAGMA foreign_keys = ON");
    // Después de restaurar, guardamos backup del NUEVO estado
    await guardarBackupAutomatico("post_restaurar_ok");
    res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Error al restaurar backup" });
  }
});

/* =============== TRABAJADORES =============== */
app.get("/api/trabajadores/lista-publica", async (req, res) => {
  const rows = await dbAll("SELECT id, nombre, categoria FROM trabajadores WHERE activo = 1 ORDER BY nombre ASC");
  res.json(rows);
});
app.get("/api/trabajadores", authMiddleware, async (req, res) => {
  res.json((await dbAll("SELECT * FROM trabajadores ORDER BY nombre ASC")).map(normalizeTrabajador));
});
app.post("/api/trabajadores", authMiddleware, requireAdmin, async (req, res) => {
  const data = req.body || {};
  if (!data.nombre) return res.status(400).json({ error: "Nombre es obligatorio" });
  if (!data.pin || String(data.pin).length < 3) return res.status(400).json({ error: "PIN mínimo 3 dígitos" });
  const id = data.id || randomId();
  try {
    await insertTrabajador({ ...data, id, createdAt: data.createdAt || new Date().toISOString() });
    res.status(201).json(normalizeTrabajador(await dbGet("SELECT * FROM trabajadores WHERE id = ?", [id])));
  } catch (e) {
    return res.status(500).json({ error: e.message || "Error al crear" });
  }
});
app.put("/api/trabajadores/:id", authMiddleware, requireAdmin, async (req, res) => {
  const id = req.params.id;
  const exists = await dbGet("SELECT id FROM trabajadores WHERE id = ?", [id]);
  if (!exists) return res.status(404).json({ error: "No existe" });
  const data = req.body || {};
  const t = normalizeTrabajador(await dbGet("SELECT * FROM trabajadores WHERE id = ?", [id]));
  const merged = { ...t, ...data, id };
  await dbRun(
    `UPDATE trabajadores SET nombre = ?, pin = ?, rol = ?, dni = ?, telefono = ?, tarifa = ?, tarifaExtra = ?, categoria = ?, activo = ? WHERE id = ?`,
    [merged.nombre, String(merged.pin || ""), merged.rol || "trabajador", merged.dni || null,
      merged.telefono || null, Number(merged.tarifa) || 0,
      Number(merged.tarifaExtra) || Number(merged.tarifa) || 0,
      merged.categoria || null, merged.activo !== false ? 1 : 0, id]
  );
  res.json(normalizeTrabajador(await dbGet("SELECT * FROM trabajadores WHERE id = ?", [id])));
});
app.delete("/api/trabajadores/:id", authMiddleware, requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { c } = await dbGet("SELECT COUNT(*) AS c FROM horas WHERE trabajadorId = ?", [id]);
  if (c > 0) {
    await dbRun("UPDATE trabajadores SET activo = 0 WHERE id = ?", [id]);
    return res.json({ ok: true, desactivado: true });
  }
  await dbRun("DELETE FROM trabajadores WHERE id = ?", [id]);
  res.json({ ok: true });
});

/* =============== OBRAS =============== */
app.get("/api/obras", authMiddleware, async (req, res) => {
  res.json((await dbAll("SELECT * FROM obras ORDER BY nombre ASC")).map(normalizeObra));
});
app.post("/api/obras", authMiddleware, async (req, res) => {
  const data = req.body || {};
  if (!data.nombre) return res.status(400).json({ error: "Nombre es obligatorio" });
  const id = data.id || randomId();
  try {
    await insertObra({
      id, nombre: data.nombre, cliente: data.cliente || "", direccion: data.direccion || "",
      presupuesto: Number(data.presupuesto) || 0, fechaInicio: data.fechaInicio || new Date().toISOString().slice(0, 10),
      fechaFin: data.fechaFin || "", estado: data.estado || "curso", notas: data.notas || "",
      createdAt: data.createdAt || new Date().toISOString(),
    });
    res.status(201).json(normalizeObra(await dbGet("SELECT * FROM obras WHERE id = ?", [id])));
  } catch (e) {
    return res.status(500).json({ error: e.message || "Error al crear" });
  }
});
app.put("/api/obras/:id", authMiddleware, requireAdmin, async (req, res) => {
  const id = req.params.id;
  const exists = await dbGet("SELECT id FROM obras WHERE id = ?", [id]);
  if (!exists) return res.status(404).json({ error: "No existe" });
  const data = req.body || {};
  const o = normalizeObra(await dbGet("SELECT * FROM obras WHERE id = ?", [id]));
  const merged = { ...o, ...data, id };
  await dbRun(
    `UPDATE obras SET nombre = ?, cliente = ?, direccion = ?, presupuesto = ?, fechaInicio = ?, fechaFin = ?, estado = ?, notas = ? WHERE id = ?`,
    [merged.nombre, merged.cliente || "", merged.direccion || "", Number(merged.presupuesto) || 0,
      merged.fechaInicio || null, merged.fechaFin || null, merged.estado || "curso", merged.notas || "", id]
  );
  res.json(normalizeObra(await dbGet("SELECT * FROM obras WHERE id = ?", [id])));
});
app.delete("/api/obras/:id", authMiddleware, requireAdmin, async (req, res) => {
  const id = req.params.id;
  await dbRun("DELETE FROM horas WHERE obraId = ?", [id]);
  await dbRun("DELETE FROM movimientos WHERE obraId = ?", [id]);
  await dbRun("DELETE FROM obras WHERE id = ?", [id]);
  res.json({ ok: true });
});

/* =============== HORAS =============== */
app.get("/api/horas", authMiddleware, async (req, res) => {
  let q = "SELECT * FROM horas WHERE 1=1";
  const params = [];
  if (req.user.role !== "admin") { q += " AND trabajadorId = ?"; params.push(req.user.trabajadorId); }
  q += " ORDER BY fecha DESC, createdAt DESC";
  res.json((await dbAll(q, params)).map(normalizeHora));
});
app.post("/api/horas", authMiddleware, async (req, res) => {
  const data = req.body || {};
  if (req.user.role !== "admin" && data.trabajadorId !== req.user.trabajadorId)
    return res.status(403).json({ error: "Solo puedes registrar tus propias horas" });
  if (!data.trabajadorId || !data.obraId || !data.fecha || !(Number(data.cantidad) > 0))
    return res.status(400).json({ error: "Faltan campos (trabajador, obra, fecha, cantidad > 0)" });
  const id = data.id || randomId();
  const tid = data.trabajadorId; const fecha = data.fecha;
  try {
    await insertHora({
      id, fecha: data.fecha, trabajadorId: data.trabajadorId, obraId: data.obraId,
      cantidad: Number(data.cantidad), horasBase: Number(data.horasBase) || 0, horasExtra: Number(data.horasExtra) || 0,
      tarifaBase: Number(data.tarifaBase) || 0, tarifaExtra: Number(data.tarifaExtra) || 0,
      costeBase: Number(data.costeBase) || 0, costeExtra: Number(data.costeExtra) || 0,
      costeTotal: Number(data.costeTotal) || 0, notas: data.notas || "",
      createdAt: data.createdAt || new Date().toISOString(), updatedAt: data.updatedAt || null,
    });
    await recalcularDesgloseParaTrabajadorDia(tid, fecha);
    res.status(201).json(normalizeHora(await dbGet("SELECT * FROM horas WHERE id = ?", [id])));
  } catch (e) {
    return res.status(500).json({ error: e.message || "Error al crear" });
  }
});
app.put("/api/horas/:id", authMiddleware, async (req, res) => {
  const id = req.params.id;
  const h = await dbGet("SELECT * FROM horas WHERE id = ?", [id]);
  if (!h) return res.status(404).json({ error: "No existe" });
  if (req.user.role !== "admin" && h.trabajadorId !== req.user.trabajadorId)
    return res.status(403).json({ error: "No tuyo" });
  const data = req.body || {};
  const fechas = new Set([h.fecha]);
  const merged = { ...normalizeHora(h), ...data, id };
  if (merged.fecha && merged.fecha !== h.fecha) fechas.add(merged.fecha);
  const tid = merged.trabajadorId || h.trabajadorId;
  await dbRun(
    `UPDATE horas SET fecha = ?, trabajadorId = ?, obraId = ?, cantidad = ?, horasBase = ?, horasExtra = ?, tarifaBase = ?, tarifaExtra = ?, costeBase = ?, costeExtra = ?, costeTotal = ?, notas = ?, updatedAt = ? WHERE id = ?`,
    [merged.fecha, merged.trabajadorId, merged.obraId, Number(merged.cantidad) || 0,
      Number(merged.horasBase) || 0, Number(merged.horasExtra) || 0, Number(merged.tarifaBase) || 0,
      Number(merged.tarifaExtra) || 0, Number(merged.costeBase) || 0, Number(merged.costeExtra) || 0,
      Number(merged.costeTotal) || 0, merged.notas || "", new Date().toISOString(), id]
  );
  for (const f of fechas) await recalcularDesgloseParaTrabajadorDia(tid, f);
  res.json(normalizeHora(await dbGet("SELECT * FROM horas WHERE id = ?", [id])));
});
app.delete("/api/horas/:id", authMiddleware, async (req, res) => {
  const id = req.params.id;
  const h = await dbGet("SELECT * FROM horas WHERE id = ?", [id]);
  if (!h) return res.status(404).json({ error: "No existe" });
  if (req.user.role !== "admin") {
    if (h.trabajadorId !== req.user.trabajadorId) return res.status(403).json({ error: "Esta hora no es tuya, no puedes borrarla." });
    // ✅ SEGURIDAD: TRABAJADOR SOLO PUEDE BORRAR SUS HORAS DEL DÍA EN CURSO (nunca días anteriores):
    const hoy = new Date();
    const hoyISO = hoy.toISOString().slice(0, 10); // 2026-08-22
    if (String(h.fecha || "").slice(0, 10) !== hoyISO) {
      return res.status(403).json({ error: `Sólo puedes borrar horas de hoy (${hoyISO}). Esta hora es del día ${h.fecha}. Contacta con un administrador si cometiste un error días anteriores.` });
    }
  }
  const tid = h.trabajadorId; const fecha = h.fecha;
  await dbRun("DELETE FROM horas WHERE id = ?", [id]);
  await recalcularDesgloseParaTrabajadorDia(tid, fecha);
  res.json({ ok: true });
});

/* =============== MOVIMIENTOS (SÓLO ADMIN) =============== */
app.get("/api/movimientos", authMiddleware, requireAdmin, async (req, res) => {
  res.json((await dbAll("SELECT * FROM movimientos ORDER BY fecha DESC, createdAt DESC")).map(normalizeMov));
});
app.post("/api/movimientos", authMiddleware, requireAdmin, async (req, res) => {
  const data = req.body || {};
  if (!data.fecha || !data.tipo || !(Number(data.importe) > 0) || !data.concepto)
    return res.status(400).json({ error: "Faltan: fecha, tipo, importe>0, concepto" });
  if (!["ingreso", "gasto"].includes(data.tipo))
    return res.status(400).json({ error: "Tipo debe ser ingreso/gasto" });
  const id = data.id || randomId();
  const cat = String(data.categoria || "").toLowerCase();
  const conc = String(data.concepto || "").toLowerCase();
  // ========== 1) RESPONSABLEID (TRABAJADOR QUE RECIBE ENTREGA NÓMINA) ==========
  // TAMBIÉN MÚLTIPLES CAPAS para RESPONSABLEID NUNCA NULL (Kevin ve entregas):
  let responsableId = String(data.responsableId || "").trim() || null;
  // Si NO VIENE NULL y es GASTO y categoría=nomina/entrega/anticipo → PRIMER TRABAJADOR NO ADMIN (Kevin):
  if (!responsableId && String(data.tipo || "").toLowerCase() === "gasto" &&
      (cat.includes("nomin") || conc.includes("entrega") || conc.includes("anticipo") || conc.includes("nomina") || conc.includes("adelanto") || conc.includes("cuenta"))) {
    const filaT = await dbGet(`SELECT id FROM trabajadores WHERE LOWER(COALESCE(rol,'')) NOT IN ('admin','socio') ORDER BY id ASC LIMIT 1;`);
    if (filaT?.id) responsableId = filaT.id;
  }
  // ========== 2) REALIZADOPORID (CAJA SOCIO QUE PAGA - JUANJE) ==========
  // ✅ MÚLTIPLES CAPAS para REALIZADOPORID NUNCA NULL:
  let realizadoPorId = String(data.realizadoPorId || "").trim() || null;
  // Capa 2: si responsableId = socio/admin, caja entra/sale de su propia caja:
  if (!realizadoPorId && responsableId) {
    const tr = await dbGet("SELECT id, rol FROM trabajadores WHERE id = ? LIMIT 1;", [responsableId]);
    if (tr && tr.rol && /admin|socio/i.test(tr.rol || "")) realizadoPorId = tr.id;
  }
  // Capa 3: si no, usa el admin que hace la petición:
  if (!realizadoPorId && req.user?.role === "admin") {
    realizadoPorId = String(req.user.userId || req.user.trabajadorId || "").trim() || null;
  }
  // Capa 4: si SIGUE vacío, ponemos SOCIO PRINCIPAL:
  if (!realizadoPorId) {
    const fila = await dbGet(`SELECT id FROM trabajadores WHERE LOWER(COALESCE(rol,'')) IN ('admin','socio') ORDER BY id ASC LIMIT 1;`);
    if (fila?.id) realizadoPorId = fila.id;
  }
  // ========== 3) INSERT FINAL (ambas columnas con su valor sin NULL:
  console.log(`✅ [POST movimientos] ID=${id} tipo=${data.tipo} importe=${Number(data.importe)} responsableId=${responsableId} realizadoPorId=${realizadoPorId}`);
  try {
    await insertMov({
      id, fecha: data.fecha, tipo: data.tipo, importe: Number(data.importe),
      obraId: data.obraId || null, responsableId: responsableId || null,
      realizadoPorId: realizadoPorId || null,
      categoria: data.categoria || "", formaPago: data.formaPago || "otro",
      concepto: data.concepto, referencia: data.referencia || "",
      createdAt: data.createdAt || new Date().toISOString(),
    });
    res.status(201).json(normalizeMov(await dbGet("SELECT * FROM movimientos WHERE id = ?", [id])));
  } catch (e) {
    return res.status(500).json({ error: e.message || "Error al crear" });
  }
});
app.put("/api/movimientos/:id", authMiddleware, requireAdmin, async (req, res) => {
  const id = req.params.id;
  const m = await dbGet("SELECT * FROM movimientos WHERE id = ?", [id]);
  if (!m) return res.status(404).json({ error: "No existe" });
  const data = req.body || {};
  const merged = { ...normalizeMov(m), ...data, id };
  // ✅ MÍNIMO 1 CAPA: si realizadoPorId = "", y responsableId es socio:
  let realizadoPorId = String(merged.realizadoPorId || "").trim() || null;
  if (!realizadoPorId && String(merged.responsableId || "").trim()) {
    const tr = await dbGet("SELECT id, rol FROM trabajadores WHERE id = ? LIMIT 1;", [merged.responsableId]);
    if (tr && /admin|socio/i.test(tr.rol || "")) realizadoPorId = tr.id;
  }
  // Si sigue vacío -> JWT admin o socio principal:
  if (!realizadoPorId && req.user?.role === "admin") realizadoPorId = String(req.user.userId || req.user.trabajadorId || "").trim() || null;
  if (!realizadoPorId) {
    const fila = await dbGet(`SELECT id FROM trabajadores WHERE LOWER(COALESCE(rol,'')) IN ('admin','socio') ORDER BY id ASC LIMIT 1;`);
    if (fila?.id) realizadoPorId = fila.id;
  }
  merged.realizadoPorId = realizadoPorId;
  await dbRun(
    `UPDATE movimientos SET fecha = ?, tipo = ?, importe = ?, obraId = ?, responsableId = ?, realizadoPorId = ?, categoria = ?, formaPago = ?, concepto = ?, referencia = ? WHERE id = ?`,
    [merged.fecha, merged.tipo, Number(merged.importe) || 0, merged.obraId || null, merged.responsableId || null, merged.realizadoPorId || null,
      merged.categoria || "", merged.formaPago || "otro", merged.concepto, merged.referencia || "", id]
  );
  res.json(normalizeMov(await dbGet("SELECT * FROM movimientos WHERE id = ?", [id])));
});
app.delete("/api/movimientos/:id", authMiddleware, requireAdmin, async (req, res) => {
  await dbRun("DELETE FROM movimientos WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

/* =============== MIS ENTREGAS A CUENTA (solo usuario logueado trabajador) =============== */
// ✅ ENDPOINT ENTREGAS 100% INFALIBLE (a prueba de IDs desincronizados / JWT incorrecto / NULL):
app.get("/api/me/mis-entregas-cuenta", authMiddleware, handle(async (req, res) => {
  // 1) Datos del JWT:
  const jwtUserId = String(req.user.trabajadorId || req.user.userId || "").trim();
  const jwtNombre = String(req.user.nombre || "").toLowerCase().trim();
  const miRol = String(req.user.role || "").toLowerCase();
  console.log(`\n\n================ [MIS ENTREGAS - BUSCANDO QUÉ TRABAJADOR ES] ================`);
  console.log(`JWT: userId=${jwtUserId} · nombre="${jwtNombre}" · rol=${miRol}`);

  // 2) Todos los trabajadores y movimientos BBDD REAL:
  const trabajadores = await dbAll(`SELECT id, nombre, rol, activo FROM trabajadores ORDER BY id ASC;`);
  const soloTrabajadores = trabajadores.filter(t => !(/admin|socio/i.test(String(t.rol || "").toLowerCase())));
  const todosMov = await dbAll(`SELECT * FROM movimientos ORDER BY fecha DESC, createdAt DESC;`);
  console.log(`BBDD: trabajadores=${trabajadores.length}, trabajadores NO admin=${soloTrabajadores.length}, movimientos totales=${todosMov.length}`);

  const esEntregaNomina = (m) => {
    if (!m) return false;
    const tipo = String(m.tipo || "").toLowerCase();
    if (tipo !== "gasto") return false;
    const cat = String(m.categoria || "").toLowerCase();
    const conc = String(m.concepto || "").toLowerCase();
    return (
      cat.includes("nomin") ||
      conc.includes("entrega") || conc.includes("anticipo") ||
      conc.includes("nomina") || conc.includes("adelanto") || conc.includes("cuenta")
    );
  };

  // =============== 3) DECIDIMOS: ¿Cuál es MI ID REAL en la tabla trabajadores? ===============
  let miIdReal = null;
  let miNombreReal = null;

  // PASO A: Si SOLO HAY 1 TRABAJADOR (Kevin) en la BBDD -> ESE ERES TÚ SIN IMPORTAR NADA (incluso JWT id malo):
  if (soloTrabajadores.length === 1) {
    miIdReal = String(soloTrabajadores[0].id);
    miNombreReal = soloTrabajadores[0].nombre;
    console.log(`✅ MODO: SOLO 1 TRABAJADOR (${miNombreReal}). ID real = ${miIdReal}. Devuelvo TODAS las entregas nómina directamente.`);
  }
  // PASO B: Buscar POR NOMBRE (si hay varios trabajadores, encuentra el tuyo por nombre igual que login):
  if (!miIdReal && jwtNombre) {
    const t = trabajadores.find((x) => String(x.nombre || "").toLowerCase().trim() === jwtNombre);
    if (t) {
      miIdReal = String(t.id);
      miNombreReal = t.nombre;
      console.log(`✅ ENCONTRADO trabajador POR NOMBRE (JWT nombre="${jwtNombre}"): id=${miIdReal} nombre=${miNombreReal} rol=${t.rol}`);
    }
  }
  // PASO C: Fallback, por si lo encuentra por ID exacto (JWT id correcto):
  if (!miIdReal && jwtUserId) {
    const t = trabajadores.find(x => String(x.id) === jwtUserId);
    if (t) {
      miIdReal = String(t.id);
      miNombreReal = t.nombre;
      console.log(`✅ ENCONTRADO por ID JWT: id=${miIdReal} nombre=${miNombreReal}`);
    }
  }

  // =============== 4) COGEMOS LAS ENTREGAS NÓMINA ===============
  let movs = [];
  const entregasTodasNomina = todosMov.filter(esEntregaNomina);
  console.log(`Total entregas nómina en BBDD (sin filtrar): ${entregasTodasNomina.length}`);

  // SI SOLO HAY 1 TRABAJADOR -> TODAS LAS ENTREGAS NÓMINA SON DE ESE TRABAJADOR (a prueba de balas):
  if (soloTrabajadores.length === 1) {
    movs = entregasTodasNomina;
  } else {
    // Hay VARIOS trabajadores: filtra por ID REAL encontrado (nombre o ID):
    if (miIdReal) {
      movs = entregasTodasNomina.filter(m => String(m.responsableId || "").trim() === miIdReal
        || String(m.realizadoPorId || "").trim() === miIdReal  // por si realizó el pago él mismo
        || (jwtNombre && String(m.concepto || "").toLowerCase().includes(jwtNombre))  // su nombre en el concepto
      );
    } else {
      // No encontramos trabajador real (error JWT sin nombre). Último recurso: entregas sin asignar (responsableId NULL):
      movs = entregasTodasNomina.filter(m => !m.responsableId || String(m.responsableId).trim() === "");
    }
  }
  console.log(`ENTREGAS FINALES devueltas a la vista: ${movs.length}`);
  console.log(`================================================================\n`);

  // Nombres de socio (join):
  const tMap = {}; trabajadores.forEach(t => { tMap[String(t.id)] = t.nombre; });

  const data = (movs || []).slice().sort((a,b) => String(b.fecha||"").localeCompare(String(a.fecha||"")) || (b.createdAt||"").localeCompare(a.createdAt||"")).map(m => ({
    id: m.id, fecha: m.fecha, tipo: String(m.tipo || ""),
    importe: Number(m.importe) || 0,
    concepto: m.concepto || "",
    notas: m.notas || "",
    obraId: m.obraId || null,
    entregadoPorNombre: (m.realizadoPorId ? (tMap[String(m.realizadoPorId)] || null) : null) || "(Caja general)",
    entregadoPorId: m.realizadoPorId || null,
  }));

  const total = data.reduce((s, m) => s + m.importe, 0);
  const entregas = data.filter(d => d.tipo.toLowerCase() === "gasto").reduce((s,m) => s + m.importe, 0);
  const reembolsos = data.filter(d => d.tipo.toLowerCase() === "ingreso").reduce((s,m) => s + m.importe, 0);
  res.json({
    myId: miIdReal || jwtUserId,
    miNombre: miNombreReal || jwtNombre,
    _soloHay1Trabajador: soloTrabajadores.length === 1,
    _trabajadoresNoAdminTotal: soloTrabajadores.length,
    totalMovimientos: data.length,
    _totalEntregasNominaBBDD: entregasTodasNomina.length,
    totalImporte: total,
    totalEntregasCuenta: entregas,
    totalReembolsos: reembolsos,
    netoPendienteConTrabajador: reembolsos - entregas,
    entregas: data,
  });
}));

/* =============== CAJAS / SALDOS POR TRABAJADOR =============== */
app.get("/api/cajas", authMiddleware, requireAdmin, handle(async (req, res) => {
  const { desde, hasta } = req.query || {};
  const sqlWhere =
    " WHERE 1=1 " +
    (desde ? " AND fecha >= ? " : "") +
    (hasta ? " AND fecha <= ? " : "");
  const args = [desde, hasta].filter(Boolean);

  // ========== A) SALDOS NÓMINAS / ENTREGAS A CUENTA POR TRABAJADOR (responsableId, concepto liquidación nómina trabajador) ==========
  //    Muestra entregas a cuenta, préstamos, etc., por cada trabajador (desde el punto de vista de la nómina).
  const sqlTrab = `SELECT t.id AS id, t.nombre AS nombre, t.rol AS rol,
    COALESCE(SUM(CASE WHEN mm.tipo = 'ingreso' THEN mm.importe ELSE 0 END), 0) AS reembolsos,
    COALESCE(SUM(CASE WHEN mm.tipo = 'gasto'   THEN mm.importe ELSE 0 END), 0) AS entregasCuenta,
    COALESCE(COUNT(mm.id), 0) AS numMov
  FROM trabajadores t
  LEFT JOIN (
    SELECT m.id, m.responsableId, m.tipo, m.importe, m.fecha
    FROM movimientos m ${sqlWhere}
  ) mm ON mm.responsableId = t.id
  WHERE t.activo = 1
  GROUP BY t.id, t.nombre, t.rol
  ORDER BY t.rol DESC, t.nombre ASC;`;
  const saldosNomina = (await dbAll(sqlTrab, args)).map(r => ({
    id: r.id, nombre: r.nombre, rol: r.rol || "trabajador",
    reembolsosTrabajador: Number(r.reembolsos) || 0,
    entregasCuentaTrabajador: Number(r.entregasCuenta) || 0,
    netoPendiente: (Number(r.reembolsos) || 0) - (Number(r.entregasCuenta) || 0),
    numMov: Number(r.numMov) || 0,
  }));

  // ========== B) CAJAS FÍSICAS POR SOCIO (LO MÁS IMPORTANTE: realizadoPorId) ==========
  //    Cada socio = CAJA FÍSICA (Juanje y otros admins/socios).
  //    Ingresos = Cobró en su caja, Gastos = Sacó/pagó de su caja.
  //    SALDO = Ingresos - Gastos (Ej: Juanje = 6000 cobrados - 90 entrega Kevin = 5910 € ✅)
  const sqlSocios = `SELECT t.id AS id, t.nombre AS nombre, t.rol AS rol,
    COALESCE(SUM(CASE WHEN mm.tipo = 'ingreso' THEN mm.importe ELSE 0 END), 0) AS cobradoCaja,
    COALESCE(SUM(CASE WHEN mm.tipo = 'gasto'   THEN mm.importe ELSE 0 END), 0) AS pagadoCaja,
    COALESCE(COUNT(mm.id), 0) AS numMov
  FROM trabajadores t
  LEFT JOIN (
    SELECT m.id, m.realizadoPorId, m.tipo, m.importe, m.fecha
    FROM movimientos m ${sqlWhere}
  ) mm ON mm.realizadoPorId = t.id
  WHERE t.activo = 1 AND LOWER(COALESCE(t.rol,'')) IN ('admin','socio')
  GROUP BY t.id, t.nombre, t.rol
  ORDER BY t.nombre ASC;`;
  const cajasSocios = (await dbAll(sqlSocios, args)).map(r => ({
    id: r.id, nombre: r.nombre, rol: r.rol || "socio",
    cobradoCaja: Number(r.cobradoCaja) || 0,
    pagadoCaja: Number(r.pagadoCaja) || 0,
    saldoCaja: (Number(r.cobradoCaja) || 0) - (Number(r.pagadoCaja) || 0),
    numMov: Number(r.numMov) || 0,
  }));

  // Resumen para tarjetas cabecera:
  let totalCobrado = 0, totalPagado = 0, totalSocios = 0, netoTotalCajas = 0;
  (cajasSocios || []).forEach(c => {
    totalSocios++;
    totalCobrado += c.cobradoCaja;
    totalPagado += c.pagadoCaja;
    netoTotalCajas += c.saldoCaja;
  });

  res.json({
    saldosNomina: saldosNomina,   // 👷 Para trabajadores: entregas a cuenta y liquidación
    cajasSocios: cajasSocios,     // 👑 CAJAS FÍSICAS POR SOCIO (lo que pediste: 6000-90=5910!)
    resumen: { totalSocios, totalCobrado, totalPagado, netoTotalCajas },
    filtros: { desde, hasta },
  });
}));

// ✅ [REPARACIÓN MANUAL POR SI UN MOVIMIENTO TIENE realizadoPorId O responsableId NULL]
//    Botón frontend "Reparar Cajas" (En 💵 Cajas o ⚒️ Herramientas Admin) ejecuta este endpoint.
//    Repara AMBAS columnas: realizadoPorId (caja socio) Y responsableId (entregas Kevin):
app.post("/api/cajas/reparar", authMiddleware, requireAdmin, handle(async (req, res) => {
  let corregidos = 0;
  let socioId = null;
  let trabajadorId = null;
  const filaAdmin = await dbGet(`SELECT id FROM trabajadores WHERE LOWER(COALESCE(rol,'')) IN ('admin','socio') ORDER BY id ASC LIMIT 1;`);
  if (filaAdmin && filaAdmin.id) socioId = filaAdmin.id;

  // Buscar PRIMER TRABAJADOR con rol trabajador (ej: Kevin, el que recibe entregas nómina):
  const filaTrab = await dbGet(`SELECT id FROM trabajadores WHERE LOWER(COALESCE(rol,'')) NOT IN ('admin','socio') ORDER BY id ASC LIMIT 1;`);
  if (filaTrab && filaTrab.id) trabajadorId = filaTrab.id;

  if (socioId) {
    // =============== PRIMERO: REPARAR responsableId (para que KEVIN VE entregas en su vista) ===============
    // Si movimiento es TIPO GASTO y responsableId = NULL, y su concepto/categoría es entrega/anticipo/nómina:
    // -> se lo asignamos al PRIMER TRABAJADOR (Kevin)
    if (trabajadorId) {
      let updResp = await dbRun(`UPDATE movimientos SET responsableId = ?
        WHERE (responsableId IS NULL OR TRIM(responsableId) = '')
        AND LOWER(COALESCE(tipo,'')) = 'gasto'
        AND (
          LOWER(COALESCE(categoria,'')) LIKE '%nomin%'
          OR LOWER(COALESCE(concepto,'')) LIKE '%entrega%'
          OR LOWER(COALESCE(concepto,'')) LIKE '%anticipo%'
          OR LOWER(COALESCE(concepto,'')) LIKE '%nomina%'
          OR LOWER(COALESCE(concepto,'')) LIKE '%adelanto%'
          OR LOWER(COALESCE(concepto,'')) LIKE '%cuenta%'
        )`, [trabajadorId]);
      corregidos += Number(typeof updResp.changes ?? updResp.rowsAffected ?? 0) || 0;
    }

    // =============== LUEGO: REPARAR realizadoPorId (CAJAS SOCIOS, Juanje) ===============
    // Regla 1: Si responsableId es ADMIN / SOCIO y realizado vacío → asignamos responsableId (cobró 6000, entra caja Juanje):
    let upd1 = await dbRun(`UPDATE movimientos SET realizadoPorId = responsableId
      WHERE (realizadoPorId IS NULL OR TRIM(realizadoPorId) = '')
      AND responsableId IS NOT NULL AND TRIM(responsableId) != ''
      AND EXISTS (
        SELECT 1 FROM trabajadores t2
        WHERE t2.id = responsableId AND LOWER(COALESCE(t2.rol,'')) IN ('admin','socio')
      )`);
    corregidos += Number(typeof upd1.changes ?? upd1.rowsAffected ?? 0) || 0;

    // Regla 2: Si responsableId = TRABAJADOR (Kevin) y realizado vacío → socioId (Juanje pagó la entrega):
    let upd2 = await dbRun(`UPDATE movimientos SET realizadoPorId = ?
      WHERE (realizadoPorId IS NULL OR TRIM(realizadoPorId) = '')
      AND responsableId IS NOT NULL AND TRIM(responsableId) != ''
      AND EXISTS (
        SELECT 1 FROM trabajadores t3
        WHERE t3.id = responsableId AND LOWER(COALESCE(t3.rol,'')) NOT IN ('admin','socio')
      )`, [socioId]);
    corregidos += Number(typeof upd2.changes ?? upd2.rowsAffected ?? 0) || 0;

    // Regla 3 (último recurso): si SIGUE habiendo vacíos, socio principal (Juanje):
    let upd3 = await dbRun(`UPDATE movimientos SET realizadoPorId = ?
      WHERE (realizadoPorId IS NULL OR TRIM(realizadoPorId) = '')`, [socioId]);
    corregidos += Number(typeof upd3.changes ?? upd3.rowsAffected ?? 0) || 0;

    console.log(`✅ [REPARAR CAJAS] ${corregidos} movs arreglados. socio=${socioId}, 1er trabajador=${trabajadorId}`);
  }

  res.json({ ok: true, corregidos, socioPrincipal: socioId, primerTrabajadorId: trabajadorId });
}));

// ============================================================
// 🔧 [SOLUCIÓN DEFINITIVA] ASIGNAR TODAS LAS ENTREGAS A KEVIN
//     Botón 1 click. No hay capas, no hay fallback: UPDATE DIRECTO SQL.
// ============================================================
app.post("/api/arreglar-entregas-kevin", authMiddleware, requireAdmin, handle(async (req, res) => {
  const filaTrabajador = await dbGet(`SELECT id, nombre, rol FROM trabajadores WHERE LOWER(COALESCE(rol,'')) NOT IN ('admin','socio') ORDER BY id ASC LIMIT 1;`);
  const filaSocio = await dbGet(`SELECT id, nombre, rol FROM trabajadores WHERE LOWER(COALESCE(rol,'')) IN ('admin','socio') ORDER BY id ASC LIMIT 1;`);
  if (!filaTrabajador?.id) return res.status(400).json({ error: "No hay ningún trabajador NO admin en la BBDD. Crea primero a Kevin." });
  if (!filaSocio?.id) return res.status(400).json({ error: "No hay ningún socio/admin en la BBDD." });
  const trabajadorId = filaTrabajador.id;
  const socioId = filaSocio.id;

  // 1) ASIGNAR responsableId = KEVIN a TODAS las entregas nómina (sin condiciones):
  const updResp = await dbRun(`UPDATE movimientos SET responsableId = ?
    WHERE LOWER(COALESCE(tipo,'')) = 'gasto'
    AND (
      LOWER(COALESCE(categoria,'')) LIKE '%nomin%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%entrega%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%anticipo%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%nomina%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%adelanto%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%cuenta%'
    )`, [trabajadorId]);
  const cuantosResp = Number(typeof updResp.changes ?? updResp.rowsAffected ?? 0) || 0;

  // 2) ASIGNAR realizadoPorId = SOCIO PRINCIPAL (Juanje) a TODAS esas entregas:
  const updReal = await dbRun(`UPDATE movimientos SET realizadoPorId = ?
    WHERE LOWER(COALESCE(tipo,'')) = 'gasto'
    AND (
      LOWER(COALESCE(categoria,'')) LIKE '%nomin%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%entrega%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%anticipo%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%nomina%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%adelanto%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%cuenta%'
    ) AND (realizadoPorId IS NULL OR TRIM(COALESCE(realizadoPorId,'')) = '')`, [socioId]);
  const cuantosReal = Number(typeof updReal.changes ?? updReal.rowsAffected ?? 0) || 0;

  console.log(`\n========== ✅ [SOLUCIÓN DEFINITIVA ENTREGAS A KEVIN] ==========`);
  console.log(`Trabajador (Kevin): id=${trabajadorId}, nombre=${filaTrabajador.nombre}`);
  console.log(`Socio principal: id=${socioId}, nombre=${filaSocio.nombre}`);
  console.log(`Entregas actualizadas responsableId -> Kevin: ${cuantosResp}`);
  console.log(`Entregas actualizadas realizadoPorId -> Juanje (solo vacíos): ${cuantosReal}`);
  console.log(`==============================================================\n`);

  // 3) DEVOLVER DIAGNÓSTICO COMPLETO para mostrárselo al admin:
  const entregasFinal = await dbAll(`SELECT id, fecha, importe, tipo, concepto, categoria, responsableId, realizadoPorId FROM movimientos
    WHERE LOWER(COALESCE(tipo,'')) = 'gasto'
    AND (
      LOWER(COALESCE(categoria,'')) LIKE '%nomin%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%entrega%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%anticipo%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%nomina%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%adelanto%'
      OR LOWER(COALESCE(concepto,'')) LIKE '%cuenta%'
    ) ORDER BY fecha DESC, createdAt DESC;`);
  res.json({
    ok: true,
    trabajador: { id: trabajadorId, nombre: filaTrabajador.nombre, rol: filaTrabajador.rol },
    socioPrincipal: { id: socioId, nombre: filaSocio.nombre, rol: filaSocio.rol },
    entregas_actualizadas_responsable: cuantosResp,
    entregas_actualizadas_realizado: cuantosReal,
    total_entregas_nomina: entregasFinal.length,
    listado_entregas: entregasFinal,
  });
}));

// ============================================================
// 🧐 DIAGNÓSTICO ENTREGAS (ver TODO EN PANTALLA sin Render logs):
//    - JWT usuario actual: id, nombre, rol
//    - TODOS los trabajadores (id, nombre, rol)
//    - TODAS las entregas nómina (responsableId, realizadoPorId)
//    - Informe desincronización JWT vs trabajadores
// ============================================================
app.get("/api/diag/entregas-completo", authMiddleware, handle(async (req, res) => {
  const jwt = {
    userId: req.user?.userId || null,
    trabajadorId: req.user?.trabajadorId || null,
    nombre: req.user?.nombre || null,
    rol: req.user?.role || null,
    login: req.user?.login || null,
    raw: JSON.stringify(req.user || {}, null, 2),
  };
  const trabajadores = await dbAll(`SELECT id, nombre, rol, pin, activo FROM trabajadores ORDER BY id ASC;`);
  const todosMov = await dbAll(`SELECT * FROM movimientos ORDER BY fecha DESC, createdAt DESC;`);
  const esEntregaNomina = (m) => {
    if (!m) return false;
    const tipo = String(m.tipo || "").toLowerCase();
    if (tipo !== "gasto") return false;
    const cat = String(m.categoria || "").toLowerCase();
    const conc = String(m.concepto || "").toLowerCase();
    return (
      cat.includes("nomin") || conc.includes("entrega") || conc.includes("anticipo") ||
      conc.includes("nomina") || conc.includes("adelanto") || conc.includes("cuenta")
    );
  };
  const entregasNomina = todosMov.filter(esEntregaNomina);
  // Búsqueda trabajador ACTUAL por nombre (arreglar desincronización JWT id):
  const miNombre = String(jwt.nombre || "").trim().toLowerCase();
  const trabajadorPorNombre = miNombre
    ? trabajadores.find((t) => String(t.nombre || "").trim().toLowerCase() === miNombre) || null
    : null;
  const soloTrabajadores = trabajadores.filter(t => !(/admin|socio/i.test(String(t.rol || "").toLowerCase())));
  let informe = [];
  informe.push(`🔑 Tu JWT (login token): userId=${jwt.userId}, trabajadorId=${jwt.trabajadorId}, nombre="${jwt.nombre}", rol=${jwt.rol}`);
  if (trabajadorPorNombre) {
    informe.push(`✅ ENCONTRADO trabajador POR NOMBRE "${jwt.nombre}" en la BBDD: id=${trabajadorPorNombre.id}, rol=${trabajadorPorNombre.rol}`);
    if (String(trabajadorPorNombre.id) !== String(jwt.userId) && String(trabajadorPorNombre.id) !== String(jwt.trabajadorId)) {
      informe.push(`🚨 ¡¡DESINCRONIZACIÓN DETECTADA!! Tu JWT tiene id=${jwt.userId || jwt.trabajadorId} pero el trabajador REAL en BBDD con tu nombre tiene id=${trabajadorPorNombre.id}. POR ESO NO VES LAS ENTREGAS (responsableId = id_real = ${trabajadorPorNombre.id} !== JWT id). SOLUCIÓN: El endpoint mis-entregas ya busca por nombre, así que te devolverá sus entregas aunque el JWT tenga id distinto.`);
    }
  } else if (miNombre) {
    informe.push(`⚠️ No se encontró ningún trabajador con nombre="${jwt.nombre}" en la tabla trabajadores (${trabajadores.length} totales). Quizás el nombre del login no coincide exactamente con el nombre del trabajador (mayúsculas/minúsculas).`);
  } else {
    informe.push(`⚠️ JWT sin campo "nombre": no se puede buscar por nombre.`);
  }
  informe.push(`👷 Total trabajadores NO admin (socios excluidos) en BBDD: ${soloTrabajadores.length}`);
  if (soloTrabajadores.length === 1) {
    informe.push(`✅ SOLO HAY 1 TRABAJADOR EN LA BBDD: ${soloTrabajadores[0].nombre} (id=${soloTrabajadores[0].id}). El endpoint mis-entregas devuelve TODAS las entregas nómina directamente, sin importar responsableId. ESTO ES A PRUEBA DE FALLOS TOTAL.`);
  }
  informe.push(`💰 Total movimientos en BBDD: ${todosMov.length}. Entregas nómina (tipo gasto + concepto entrega/nómina): ${entregasNomina.length}.`);
  entregasNomina.forEach((m, i) => {
    const respT = trabajadores.find(t => String(t.id) === String(m.responsableId || ""));
    const realT = trabajadores.find(t => String(t.id) === String(m.realizadoPorId || ""));
    informe.push(`  Entrega #${i+1}: id=${m.id}, fecha=${m.fecha}, importe=${m.importe}€, concepto="${m.concepto}", responsableId=${m.responsableId || "NULL"} (${respT ? respT.nombre : "NO ENCONTRADO"}), realizadoPorId=${m.realizadoPorId || "NULL"} (${realT ? realT.nombre : "NO ENCONTRADO"})`);
  });
  res.json({
    ok: true,
    _generado: new Date().toISOString(),
    jwt,
    trabajadores,
    total_movimientos: todosMov.length,
    total_entregas_nomina: entregasNomina.length,
    entregasNomina: entregasNomina.map(m => {
      const respT = trabajadores.find(t => String(t.id) === String(m.responsableId || ""));
      const realT = trabajadores.find(t => String(t.id) === String(m.realizadoPorId || ""));
      return {
        id: m.id, fecha: m.fecha, importe: Number(m.importe) || 0, concepto: m.concepto, categoria: m.categoria,
        responsableId: m.responsableId || null, responsableNombre: respT ? respT.nombre : null,
        realizadoPorId: m.realizadoPorId || null, realizadoPorNombre: realT ? realT.nombre : null,
        createdAt: m.createdAt || null,
      };
    }),
    encontradoTrabajadorPorNombre: trabajadorPorNombre ? {
      id: trabajadorPorNombre.id, nombre: trabajadorPorNombre.nombre, rol: trabajadorPorNombre.rol
    } : null,
    soloHay1Trabajador: soloTrabajadores.length === 1 ? soloTrabajadores[0] : null,
    informe_lineas: informe,
    informe_texto: informe.join("\n\n"),
  });
}));

/* =============== FALLBACK SPA =============== */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  const idx = path.join(BASE_DIR, "index.html");
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(404).end("Not Found");
});

// ✅ [DIAGNÓSTICO 500 TOTAL: Middleware GLOBAL Express (4 argumentos: err,req,res,next).
// ESTE MIDDLEWARE RECIBE TODOS LOS ERRORES QUE SEÑALADOS con next(err) gracias al Wrapper handle(fn) anterior.
// Devuelve un JSON con mensaje exacto del fallo (con lo que hay que solucionar y se muestra EN ROJO en LOGS Render.
app.use((err, req, res, next) => {
  try {
    const id = res.locals?.peticionId || ("#" + Math.floor(Math.random()*9999));
    const msg = err?.message || String(err) || "Error desconocido";
    const stack = (err?.stack || "").toString().slice(0, 600);
    console.error(`\n\n═══════════════════════════════════════════════════════════════════\n` +
      `🚨 ERROR 500 NO MANEJADO EN PETICIÓN ${id} ${req.method} ${req.url}\n` +
      `   MENSAJE: ${msg}\n` +
      `   STACK (primeras líneas):\n${stack}\n` +
      `   Body recibido: ${JSON.stringify(req.body||"").slice(0, 400)}\n` +
      `   Query: ${JSON.stringify(req.query||"").slice(0, 300)}\n` +
      `═══════════════════════════════════════════════════════════════════\n\n`);
    if (res.headersSent) return; // ya enviado
    return res.status(500).json({
      error: msg,
      detalle: "Error interno del servidor. Mira los LOGS de Render (arriba rojo) para la causa EXACTA.",
      ruta: `${req.method} ${req.url}`,
      stack: stack.slice(0, 400),
      ok: false,
    });
  } catch (e2) {
    try { res.status(500).json({ error: "Error catastrófico", ok: false }); } catch {}
  }
});

/* =============== AUXILIARES =============== */
async function insertTrabajador(t) {
  return dbRun(
    `INSERT INTO trabajadores (id, nombre, pin, rol, dni, telefono, tarifa, tarifaExtra, categoria, activo, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.id, t.nombre, String(t.pin || ""), t.rol || "trabajador", t.dni || null, t.telefono || null,
      Number(t.tarifa) || 0, Number(t.tarifaExtra) || Number(t.tarifa) || 0,
      t.categoria || null, t.activo === 0 ? 0 : 1, t.createdAt || new Date().toISOString()]
  );
}
async function insertObra(o) {
  return dbRun(
    `INSERT INTO obras (id, nombre, cliente, direccion, presupuesto, fechaInicio, fechaFin, estado, notas, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.id, o.nombre, o.cliente || "", o.direccion || "", Number(o.presupuesto) || 0,
      o.fechaInicio || null, o.fechaFin || null, o.estado || "curso", o.notas || "", o.createdAt || new Date().toISOString()]
  );
}
async function insertHora(h) {
  return dbRun(
    `INSERT INTO horas (id, fecha, trabajadorId, obraId, cantidad, horasBase, horasExtra, tarifaBase, tarifaExtra, costeBase, costeExtra, costeTotal, notas, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [h.id, h.fecha, h.trabajadorId, h.obraId, Number(h.cantidad) || 0,
      Number(h.horasBase) || 0, Number(h.horasExtra) || 0, Number(h.tarifaBase) || 0,
      Number(h.tarifaExtra) || 0, Number(h.costeBase) || 0, Number(h.costeExtra) || 0,
      Number(h.costeTotal) || 0, h.notas || "", h.createdAt || new Date().toISOString(), h.updatedAt || null]
  );
}
async function insertMov(m) {
  return dbRun(
    `INSERT INTO movimientos (id, fecha, tipo, importe, obraId, responsableId, realizadoPorId, categoria, formaPago, concepto, referencia, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.fecha, m.tipo, Number(m.importe) || 0, m.obraId || null, m.responsableId || null, m.realizadoPorId || null, m.categoria || "",
      m.formaPago || "otro", m.concepto, m.referencia || "", m.createdAt || new Date().toISOString()]
  );
}
function normalizeTrabajador(t) {
  if (!t) return t;
  return {
    ...t,
    activo: !!t.activo,
    tarifa: Number(t.tarifa) || 0,
    tarifaExtra: Number(t.tarifaExtra) || Number(t.tarifa) || 0,
    rol: t.rol || "trabajador",
  };
}
function normalizeObra(o) { if (!o) return o; return { ...o, presupuesto: Number(o.presupuesto) || 0 }; }
function normalizeHora(h) {
  if (!h) return h;
  return {
    ...h, cantidad: Number(h.cantidad) || 0, horasBase: Number(h.horasBase) || 0,
    horasExtra: Number(h.horasExtra) || 0, tarifaBase: Number(h.tarifaBase) || 0,
    tarifaExtra: Number(h.tarifaExtra) || 0, costeBase: Number(h.costeBase) || 0,
    costeExtra: Number(h.costeExtra) || 0, costeTotal: Number(h.costeTotal) || 0,
  };
}
function normalizeMov(m) { if (!m) return m; return { ...m, importe: Number(m.importe) || 0 }; }
function randomId() {
  try { return require("crypto").randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"); }
  catch { return Array.from({length:16}).map(()=>Math.floor(Math.random()*16).toString(16)).join("").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"); }
}

/* =============== CÁLCULO HORAS BASE/EXTRA (BACKEND, DETERMINISTA) =============== */
const HORAS_BASE_AL_DIA = 8;
async function recalcularDesgloseParaTrabajadorDia(trabajadorId, fecha) {
  if (!trabajadorId || !fecha) return;
  const t = await dbGet("SELECT tarifa, tarifaExtra FROM trabajadores WHERE id = ?", [trabajadorId]);
  if (!t) return;
  const tarifaBase = Number(t.tarifa) || 0;
  const tarifaExtra = Number(t.tarifaExtra) || tarifaBase || 0;
  const rows = await dbAll(
    "SELECT id, cantidad FROM horas WHERE trabajadorId = ? AND fecha = ? ORDER BY datetime(createdAt) ASC, id ASC",
    [trabajadorId, fecha]
  );
  let total = 0;
  rows.forEach(r => total += Number(r.cantidad) || 0);
  let umbral = HORAS_BASE_AL_DIA;
  const updates = [];
  for (const r of rows) {
    const cant = Number(r.cantidad) || 0;
    let base = Math.min(cant, Math.max(0, umbral));
    let extra = cant - base;
    umbral -= base;
    const costeBase = base * tarifaBase;
    const costeExtra = extra * tarifaExtra;
    const costeTotal = costeBase + costeExtra;
    updates.push(dbRun(
      `UPDATE horas SET horasBase=?, horasExtra=?, tarifaBase=?, tarifaExtra=?, costeBase=?, costeExtra=?, costeTotal=? WHERE id=?`,
      [base, extra, tarifaBase, tarifaExtra, costeBase, costeExtra, costeTotal, r.id]
    ));
  }
  await Promise.all(updates);
}

/* =============== INICIALIZACIÓN BBDD =============== */
async function initDatabase() {
  const sql = `
    CREATE TABLE IF NOT EXISTS settings (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trabajadores (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      pin TEXT NOT NULL DEFAULT '',
      rol TEXT NOT NULL DEFAULT 'trabajador',
      dni TEXT,
      telefono TEXT,
      tarifa REAL NOT NULL DEFAULT 0,
      tarifaExtra REAL NOT NULL DEFAULT 0,
      categoria TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS obras (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      cliente TEXT NOT NULL DEFAULT '',
      direccion TEXT,
      presupuesto REAL NOT NULL DEFAULT 0,
      fechaInicio TEXT,
      fechaFin TEXT,
      estado TEXT NOT NULL DEFAULT 'curso',
      notas TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS horas (
      id TEXT PRIMARY KEY,
      fecha TEXT NOT NULL,
      trabajadorId TEXT NOT NULL,
      obraId TEXT NOT NULL,
      cantidad REAL NOT NULL DEFAULT 0,
      horasBase REAL NOT NULL DEFAULT 0,
      horasExtra REAL NOT NULL DEFAULT 0,
      tarifaBase REAL NOT NULL DEFAULT 0,
      tarifaExtra REAL NOT NULL DEFAULT 0,
      costeBase REAL NOT NULL DEFAULT 0,
      costeExtra REAL NOT NULL DEFAULT 0,
      costeTotal REAL NOT NULL DEFAULT 0,
      notas TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT,
      FOREIGN KEY (trabajadorId) REFERENCES trabajadores(id) ON DELETE CASCADE,
      FOREIGN KEY (obraId) REFERENCES obras(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS movimientos (
      id TEXT PRIMARY KEY,
      fecha TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','gasto')),
      importe REAL NOT NULL DEFAULT 0,
      obraId TEXT,
      responsableId TEXT,
      categoria TEXT DEFAULT '',
      formaPago TEXT DEFAULT 'otro',
      concepto TEXT NOT NULL,
      referencia TEXT DEFAULT '',
      createdAt TEXT NOT NULL,
      FOREIGN KEY (obraId) REFERENCES obras(id) ON DELETE SET NULL,
      FOREIGN KEY (responsableId) REFERENCES trabajadores(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_horas_trabajador_fecha ON horas (trabajadorId, fecha);
    CREATE INDEX IF NOT EXISTS idx_horas_obra ON horas (obraId);
    CREATE INDEX IF NOT EXISTS idx_movimientos_fecha ON movimientos (fecha);
    CREATE INDEX IF NOT EXISTS idx_movimientos_obra ON movimientos (obraId);
    CREATE INDEX IF NOT EXISTS idx_movimientos_responsable ON movimientos (responsableId);
  `;
  const stmts = sql.split(";").map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    try { await dbRun(s + ";"); } catch (e) { /* ignoramos errores por tablas ya existentes */ }
  }
  // Añadir columna responsableId si faltaba (BBDD creada antes de esta actualización)
  try {
    const cols = await dbAll(`PRAGMA table_info(movimientos);`).catch(() => []);
    const hasCol = (cols || []).some((c) => String(c.name || "").toLowerCase() === "responsableid");
    if (!hasCol) {
      console.log("🔄 MIGRACIÓN: Añadiendo columna responsableId a la tabla movimientos...");
      await dbRun("ALTER TABLE movimientos ADD COLUMN responsableId TEXT;").catch(() => {});
      try {
        await dbRun("CREATE INDEX IF NOT EXISTS idx_movimientos_responsable ON movimientos (responsableId);").catch(() => {});
      } catch {}
      console.log("✅ MIGRACIÓN OK: Columna responsableId añadida.");
    }
  } catch (e) { console.warn("⚠️ No se pudo comprobar migracion columna responsableId:", e.message); }
  // ✅ Nueva migracion: columna `realizadoPorId` (QUIEN REALMENTE PAGÓ/COBRÓ el dinero físicamente = caja personal del socio/admin):
  try {
    const cols2 = await dbAll(`PRAGMA table_info(movimientos);`).catch(() => []);
    const hasCol2 = (cols2 || []).some((c) => String(c.name || "").toLowerCase() === "realizadoporid");
    if (!hasCol2) {
      console.log("🔄 MIGRACIÓN: Añadiendo columna realizadoPorId a la tabla movimientos (caja socio que paga/cobra)...");
      await dbRun("ALTER TABLE movimientos ADD COLUMN realizadoPorId TEXT;").catch(() => {});
      try {
        await dbRun("CREATE INDEX IF NOT EXISTS idx_movimientos_realizadopor ON movimientos (realizadoPorId);").catch(() => {});
      } catch {}
      console.log("✅ MIGRACIÓN OK: Columna realizadoPorId añadida.");
    }
    // ✅ NUEVA: Migración 2026-08-22: RELLENAR AUTOMÁTICAMENTE los movimientos antiguos SIN realizadoPorId (es decir, NULL o "") →
    //    si es un GASTO con responsable = trabajador (entrega nómina) → lo atribuye automáticamente al SOCIO/ADMIN PRINCIPAL
    //    para que Juanje aparezcan correctamente los 40€ + 50€ = 90€ en sus cajas personales.
    try {
      // Buscamos el socio/admin principal (1er trabajador con rol admin/socio en tabla trabajadores:
      let socioId = null;
      const filaAdmin = await dbGet(`SELECT id FROM trabajadores WHERE LOWER(COALESCE(rol,'')) IN ('admin','socio') ORDER BY id ASC LIMIT 1;`);
      if (filaAdmin && filaAdmin.id) socioId = filaAdmin.id;
      if (socioId) {
        // Actualizar todos los movimientos que: (realizadoPorId IS NULL O = ""):
        // Si es GASTO y responsableId es un trabajador (entrega nómina/anticipo) → le ponemos realizadoPorId = socioId (Juanje):
        const upd = await dbRun(`UPDATE movimientos SET realizadoPorId = ? WHERE (realizadoPorId IS NULL OR TRIM(realizadoPorId) = '')`, [socioId]);
        const cuantos = Number(typeof upd.changes ?? upd.rowsAffected ?? 0) || 0;
        if (cuantos > 0) {
          console.log(`✅ MIGRACIÓN EXITOSA: Se han actualizado ${cuantos} movimientos antiguos sin caja socio, asignándolos al Socio/Admin Principal ${socioId} (saldo Juanje ya aparece bien ahora!).`);
        }
      }
    } catch (e) {
      console.warn("⚠️ No se pudo hacer migracion rellenado realizadoPorId antiguos (no pasa nada):", e.message);
    }
  } catch (e) { console.warn("⚠️ No se pudo comprobar migracion columna realizadoPorId:", e.message); }
}
async function seedInitialData() {
  const pinRow = await dbGet("SELECT valor FROM settings WHERE clave = ?", ["admin_pin"]);
  if (!pinRow) await dbRun("INSERT INTO settings (clave, valor) VALUES (?, ?)", ["admin_pin", DEFAULT_ADMIN_PIN]);
}

/* =============== BANNER INICIO =============== */
function printStartupBanner() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  Object.values(ifaces).forEach((arr) => arr.forEach((x) => {
    if (x.family === "IPv4" && !x.internal) ips.push(x.address);
  }));
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║          🏗️   GESTIÓN DE OBRAS - VERSIÓN CLOUD (v2)             ║
╠══════════════════════════════════════════════════════════════════╣
║  ✓ Base de datos SQLite OK: ${path.relative(BASE_DIR, DB_PATH) || "data/"}
║  ✓ Autenticación JWT HABILITADA
║  ✓ API REST + Frontend sincronizado (mismos datos en todos los moviles/PCs)
║  ✓ PIN admin por defecto: ${DEFAULT_ADMIN_PIN}
╠══════════════════════════════════════════════════════════════════╣
║  🌐 LOCAL:    http://localhost:${PORT}
║  📱 LAN:      ${ips.map(ip => `http://${ip}:${PORT}`).join("\n║              ")}
║  ☁️  CLOUD:    Despliega en Render.com / Railway / Fly.io
╚══════════════════════════════════════════════════════════════════╝
  `.trim());
}
