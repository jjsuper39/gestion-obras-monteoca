const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const jwt = require("jsonwebtoken");

const PORT = process.env.PORT || 8082;
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "gestion-obras-secreto-super-seguro-2026-cambiar-en-produccion";
const JWT_EXPIRES = "365d";
const DEFAULT_ADMIN_PIN = "1234";
const BASE_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "gestion_obras.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

(async () => {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.run("PRAGMA journal_mode = WAL;");
  await db.run("PRAGMA foreign_keys = ON;");
  await initDatabase();
  await seedInitialData();
  app.listen(PORT, HOST, () => printStartupBanner());
})().catch((err) => {
  console.error("Fatal error al iniciar la BBDD:", err);
  process.exit(1);
});

/* =============== HELPERS DB =============== */
async function dbAll(sql, params = []) { return db.all(sql, params); }
async function dbGet(sql, params = []) { return db.get(sql, params); }
async function dbRun(sql, params = []) {
  const r = await db.run(sql, params);
  return { lastID: r.lastID, changes: r.changes };
}

/* =============== EXPRESS =============== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(BASE_DIR, { index: false, extensions: ["html"] }));

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
  await dbRun(`INSERT INTO settings (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`,
    ["admin_pin", String(nuevo)]);
  res.json({ ok: true });
});

/* =============== ENDPOINTS / DATOS GENERALES =============== */
app.get("/api/sync", authMiddleware, async (req, res) => {
  const trabajadores = (await dbAll("SELECT * FROM trabajadores ORDER BY nombre ASC")).map(normalizeTrabajador);
  const obras = (await dbAll("SELECT * FROM obras ORDER BY nombre ASC")).map(normalizeObra);
  const horas = (await dbAll("SELECT * FROM horas ORDER BY fecha DESC, createdAt DESC")).map(normalizeHora);
  const movimientos = (await dbAll("SELECT * FROM movimientos ORDER BY fecha DESC, createdAt DESC")).map(normalizeMov);
  const row = await dbGet("SELECT valor FROM settings WHERE clave = ?", ["admin_pin"]);
  res.json({
    trabajadores, obras, horas, movimientos,
    adminPin: req.user.role === "admin" ? (row?.valor || DEFAULT_ADMIN_PIN) : null,
    currentUser: req.user,
  });
});

app.get("/api/backup", authMiddleware, requireAdmin, async (req, res) => {
  const trabajadores = await dbAll("SELECT * FROM trabajadores");
  const obras = await dbAll("SELECT * FROM obras");
  const horas = await dbAll("SELECT * FROM horas");
  const movimientos = await dbAll("SELECT * FROM movimientos");
  const settings = await dbAll("SELECT * FROM settings");
  const backup = {
    exportadoEn: new Date().toISOString(), app: "GestionObras-v2", version: 2,
    trabajadores, obras, horas, movimientos, settings
  };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="gestion-obras-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.json(backup);
});

app.post("/api/backup/restaurar", authMiddleware, requireAdmin, async (req, res) => {
  const { trabajadores, obras, horas, movimientos, settings } = req.body || {};
  if (!Array.isArray(trabajadores) || !Array.isArray(obras)) return res.status(400).json({ error: "Backup inválido" });
  try {
    await dbRun("PRAGMA foreign_keys = OFF");
    for (const t of ["horas", "movimientos", "obras", "trabajadores"]) await dbRun(`DELETE FROM ${t}`);
    if (Array.isArray(settings)) {
      await dbRun("DELETE FROM settings");
      for (const s of settings) await dbRun("INSERT INTO settings (clave, valor) VALUES (?, ?)", [s.clave, s.valor]);
    }
    for (const t of trabajadores) await insertTrabajador(t);
    for (const o of obras) await insertObra(o);
    if (Array.isArray(horas)) for (const h of horas) await insertHora(h);
    if (Array.isArray(movimientos)) for (const m of movimientos) await insertMov(m);
    await dbRun("PRAGMA foreign_keys = ON");
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
  try {
    await insertHora({
      id, fecha: data.fecha, trabajadorId: data.trabajadorId, obraId: data.obraId,
      cantidad: Number(data.cantidad), horasBase: Number(data.horasBase) || 0, horasExtra: Number(data.horasExtra) || 0,
      tarifaBase: Number(data.tarifaBase) || 0, tarifaExtra: Number(data.tarifaExtra) || 0,
      costeBase: Number(data.costeBase) || 0, costeExtra: Number(data.costeExtra) || 0,
      costeTotal: Number(data.costeTotal) || 0, notas: data.notas || "",
      createdAt: data.createdAt || new Date().toISOString(), updatedAt: data.updatedAt || null,
    });
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
  const merged = { ...normalizeHora(h), ...data, id };
  await dbRun(
    `UPDATE horas SET fecha = ?, trabajadorId = ?, obraId = ?, cantidad = ?, horasBase = ?, horasExtra = ?, tarifaBase = ?, tarifaExtra = ?, costeBase = ?, costeExtra = ?, costeTotal = ?, notas = ?, updatedAt = ? WHERE id = ?`,
    [merged.fecha, merged.trabajadorId, merged.obraId, Number(merged.cantidad) || 0,
      Number(merged.horasBase) || 0, Number(merged.horasExtra) || 0, Number(merged.tarifaBase) || 0,
      Number(merged.tarifaExtra) || 0, Number(merged.costeBase) || 0, Number(merged.costeExtra) || 0,
      Number(merged.costeTotal) || 0, merged.notas || "", new Date().toISOString(), id]
  );
  res.json(normalizeHora(await dbGet("SELECT * FROM horas WHERE id = ?", [id])));
});
app.delete("/api/horas/:id", authMiddleware, async (req, res) => {
  const id = req.params.id;
  const h = await dbGet("SELECT * FROM horas WHERE id = ?", [id]);
  if (!h) return res.status(404).json({ error: "No existe" });
  if (req.user.role !== "admin" && h.trabajadorId !== req.user.trabajadorId)
    return res.status(403).json({ error: "No tuyo" });
  await dbRun("DELETE FROM horas WHERE id = ?", [id]);
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
  try {
    await insertMov({
      id, fecha: data.fecha, tipo: data.tipo, importe: Number(data.importe),
      obraId: data.obraId || null, categoria: data.categoria || "", formaPago: data.formaPago || "otro",
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
  await dbRun(
    `UPDATE movimientos SET fecha = ?, tipo = ?, importe = ?, obraId = ?, categoria = ?, formaPago = ?, concepto = ?, referencia = ? WHERE id = ?`,
    [merged.fecha, merged.tipo, Number(merged.importe) || 0, merged.obraId || null,
      merged.categoria || "", merged.formaPago || "otro", merged.concepto, merged.referencia || "", id]
  );
  res.json(normalizeMov(await dbGet("SELECT * FROM movimientos WHERE id = ?", [id])));
});
app.delete("/api/movimientos/:id", authMiddleware, requireAdmin, async (req, res) => {
  await dbRun("DELETE FROM movimientos WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

/* =============== FALLBACK SPA =============== */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  const idx = path.join(BASE_DIR, "index.html");
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(404).end("Not Found");
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Error interno" });
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
    `INSERT INTO movimientos (id, fecha, tipo, importe, obraId, categoria, formaPago, concepto, referencia, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.fecha, m.tipo, Number(m.importe) || 0, m.obraId || null, m.categoria || "",
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
      categoria TEXT DEFAULT '',
      formaPago TEXT DEFAULT 'otro',
      concepto TEXT NOT NULL,
      referencia TEXT DEFAULT '',
      createdAt TEXT NOT NULL,
      FOREIGN KEY (obraId) REFERENCES obras(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_horas_trabajador_fecha ON horas (trabajadorId, fecha);
    CREATE INDEX IF NOT EXISTS idx_horas_obra ON horas (obraId);
    CREATE INDEX IF NOT EXISTS idx_movimientos_fecha ON movimientos (fecha);
    CREATE INDEX IF NOT EXISTS idx_movimientos_obra ON movimientos (obraId);
  `;
  // sqlite3/driver no soporta multi-statement .exec de forma segura, así que dividimos
  const stmts = sql.split(";").map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    await dbRun(s + ";");
  }
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
