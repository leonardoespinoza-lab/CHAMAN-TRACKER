// Política de sesiones: cierre por inactividad y vencimiento absoluto, configurable por el admin
// (settings.key = 'session'). La "actividad" la registra el servidor (sess.lastActivity) sólo con uso real:
// - acciones (POST/PUT/PATCH/DELETE) y lecturas marcadas por el navegador con "X-Chaman-Active: 1"
//   (auth.js la agrega sólo si la persona tocó/tecleó hace menos de 1 min o recién abrió la página),
// - POST /api/auth/activity (toques sin llamadas a la API) y /api/auth/keepalive ("Seguir conectado"),
// - para el aplicador, además, los puntos GPS (POST /api/track y /api/jobs/:id/track).
// No cuentan: los streams en vivo (SSE), los refrescos automáticos ni /api/auth/session.
// El aplicador con un trabajo en curso o una etapa abierta no vence nunca (no se corta el registro en el campo).
const db = require('./db');

const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
const DEFAULTS = { staffIdleMin: 30, staffMaxDays: 7, aplIdleMin: 30, aplMaxDays: 30, warnMin: 2 };
const LIMITS = { staffIdleMin: [1, 1440], staffMaxDays: [1, 90], aplIdleMin: [1, 4320], aplMaxDays: [1, 365], warnMin: [1, 30] };

function normalize(input, strict) {
  const out = { ...DEFAULTS }, errors = [];
  const src = input && typeof input === 'object' ? input : {};
  for (const k of Object.keys(DEFAULTS)) {
    if (src[k] === undefined || src[k] === null || src[k] === '') continue;
    const v = Number(String(src[k]).replace(',', '.'));
    const [lo, hi] = LIMITS[k];
    if (!Number.isFinite(v) || v < lo || v > hi) { if (strict) errors.push(`${k}: debe estar entre ${lo} y ${hi}`); continue; }
    out[k] = Math.round(v * 100) / 100;
  }
  if (out.warnMin >= out.staffIdleMin && out.staffIdleMin > 1) out.warnMin = Math.min(out.warnMin, out.staffIdleMin / 2);
  return { value: out, errors };
}

let cache = null, cacheAt = 0;
async function getSettings() {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'session'");
  cache = normalize(rows[0] && rows[0].value).value; cacheAt = Date.now();
  return cache;
}
async function saveSettings(input, userId) {
  const r = normalize(input, true);
  if (r.errors.length) return { errors: r.errors };
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('session', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(r.value), userId]);
  cache = r.value; cacheAt = Date.now();
  return { value: r.value };
}
async function settingsInfo() {
  const { rows } = await db.query(
    "SELECT s.updated_at, u.name FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = 'session'");
  return { settings: await getSettings(), defaults: DEFAULTS, limits: LIMITS,
    updatedAt: rows[0] ? rows[0].updated_at : null, updatedBy: rows[0] ? rows[0].name : null };
}

// Tiempos por rol en ms
function limitsFor(role, s) {
  const apl = role === 'aplicador';
  const idleMs = (apl ? s.aplIdleMin : s.staffIdleMin) * MIN;
  return { idleMs, maxMs: (apl ? s.aplMaxDays : s.staffMaxDays) * DAY, warnMs: Math.min(s.warnMin * MIN, idleMs / 2) };
}

// ¿El aplicador tiene un trabajo en curso o una etapa abierta? Sólo se guarda en caché (15 s) el "sí":
// así, apenas inicia un trabajo, la excepción vale enseguida.
const busyCache = new Map();
async function applicatorBusy(userId) {
  const c = busyCache.get(userId);
  if (c && Date.now() - c.at < 15000) return true;
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM jobs WHERE applicator_id = $1 AND status = 'en_curso' AND deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM job_stages WHERE applicator_id = $1 AND ended_at IS NULL) AS busy`, [userId]);
  const busy = !!rows[0].busy;
  if (busy) busyCache.set(userId, { at: Date.now() }); else busyCache.delete(userId);
  if (busyCache.size > 500) busyCache.clear();
  return busy;
}
function forgetBusy(userId) { busyCache.delete(userId); }

const GPS_PATHS = /^\/api\/(track|jobs\/\d+\/track)$/;
const BACKGROUND_PATHS = /^\/api\/(auth\/(session|me)|.*\/stream)$/;
function isActivity(req, role) {
  const p = req.originalUrl.split('?')[0];
  if (p === '/api/auth/activity' || p === '/api/auth/keepalive' || p === '/api/auth/login') return true;
  if (/\/stream$/.test(p) || p === '/api/auth/session') return false;
  if (GPS_PATHS.test(p) && req.method === 'POST') return role === 'aplicador'; // GPS sólo cuenta para el aplicador
  if (req.get('X-Chaman-Background') === '1') return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return true;
  return req.get('X-Chaman-Active') === '1';
}

// ¿La sesión guardada sigue viva? (sin contar la excepción del aplicador ocupado)
function aliveNow(sess, s, now = Date.now()) {
  const L = limitsFor(sess.role, s);
  const last = Number(sess.lastActivity || sess.seenAt) || 0, created = Number(sess.createdAt) || last;
  return { idle: now - last <= L.idleMs, absolute: now - created <= L.maxMs };
}

// Barrido periódico: borra de la tabla las sesiones vencidas por inactividad o por antigüedad
// (las de aplicadores con trabajo en curso se conservan).
async function sweep() {
  const s = await getSettings();
  const { rows } = await db.query("SELECT sid, sess FROM session WHERE sess->>'userId' IS NOT NULL");
  const dead = [];
  for (const { sid, sess } of rows) {
    const a = aliveNow(sess, s);
    if (a.idle && a.absolute) continue;
    if (!sess.role) continue; // sin rol guardado: se resuelve en el próximo pedido (no se borra a ciegas)
    if (sess.role === 'aplicador' && await applicatorBusy(Number(sess.userId))) continue;
    dead.push(sid);
  }
  if (dead.length) await db.query('DELETE FROM session WHERE sid = ANY($1::text[])', [dead]);
  return dead.length;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { if (db.isReady()) sweep().catch(e => console.error('[sesiones] barrido:', e.message)); }, 5 * MIN);
  sweepTimer.unref();
}

module.exports = { aliveNow, sweep, startSweep, DEFAULTS, LIMITS, MIN, DAY, normalize, getSettings, saveSettings, settingsInfo, limitsFor, applicatorBusy, forgetBusy, isActivity, BACKGROUND_PATHS };
