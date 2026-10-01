const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const db = require('./lib/db');
const { ah, publicUser, requireAuth, requireRole } = require('./lib/auth');
const { parsePoints } = require('./lib/track');
const { jobToJson, parseJobInput } = require('./lib/jobs');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_POINTS_RESPONSE = 5000;

// Railway pone un proxy HTTPS delante: necesario para cookies "secure" e IP real
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

db.init();

// ===== SESIONES =====
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] ADVERTENCIA: no está definida SESSION_SECRET. Se generó un secreto aleatorio ' +
    'al arrancar: las sesiones se invalidan en cada reinicio/redeploy. Agregá SESSION_SECRET en Railway.');
}

const sessionMiddleware = db.isConfigured()
  ? session({
      store: new PgStore({
        pool: db.getPool(),
        tableName: 'session',
        createTableIfMissing: false, // la crea nuestra migración
        disableTouch: true            // evita una escritura por cada punto GPS
      }),
      name: 'chaman.sid',
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      proxy: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto', // secure cuando la petición llega por HTTPS (proxy de Railway)
        maxAge: 7 * 24 * 60 * 60 * 1000
      }
    })
  : (req, res, next) => next();

// ===== ARCHIVOS ESTÁTICOS =====
function sendHtml(res, file) {
  const token = process.env.MAPBOX_TOKEN || '';
  const html = fs.readFileSync(path.join(__dirname, file), 'utf8')
    .replaceAll('__MAPBOX_TOKEN__', token);
  res.type('html').send(html);
}

// No exponer código del servidor ni configuración como archivos estáticos
const BLOCKED_PATHS = /^\/(node_modules|lib|routes|\.git)(\/|$)|^\/(server\.js|package(-lock)?\.json|railway\.toml|Procfile|\.env.*)$/i;
app.use((req, res, next) => {
  if (BLOCKED_PATHS.test(req.path)) return res.status(404).send('Not found');
  next();
});

app.get('/', (req, res) => res.redirect('/login.html'));

// Todas las páginas HTML pasan por sendHtml (inyección del token de Mapbox)
app.get(/^\/[\w-]+\.html$/, (req, res, next) => {
  const file = req.path.slice(1);
  if (!fs.existsSync(path.join(__dirname, file))) return next();
  sendHtml(res, file);
});

app.use(express.static(__dirname, { index: false }));

// ===== API =====

// Salud pública (no requiere login): útil para verificar la conexión a la base
app.get('/api/health', (req, res) => {
  const configured = db.isConfigured();
  const ready = db.isReady();
  const err = db.lastError();
  res.status(ready ? 200 : 503).json({
    ok: ready,
    db: ready ? 'ok' : (configured ? 'error' : 'sin configurar'),
    error: ready ? undefined : (err ? err.message : 'inicializando')
  });
});

// Sin base de datos, la API responde 503 (pero las páginas siguen cargando)
app.use('/api', (req, res, next) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada: falta la variable DATABASE_URL en el servidor.' });
  }
  if (!db.isReady()) {
    return res.status(503).json({ error: 'La base de datos no está disponible todavía. Probá de nuevo en unos segundos.' });
  }
  next();
});
app.use('/api', sessionMiddleware);

// Límite simple de intentos fallidos de login por IP (en memoria)
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
function tooManyFailures(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) { loginFailures.delete(ip); return false; }
  return entry.count >= LOGIN_MAX_FAILURES;
}
function registerFailure(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.set(ip, { count: 1, first: Date.now() });
  } else {
    entry.count++;
  }
}
// Hash de referencia para que el tiempo de respuesta no revele si el usuario existe
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// ----- Auth -----
app.post('/api/auth/login', ah(async (req, res) => {
  const ip = req.ip;
  if (tooManyFailures(ip)) {
    return res.status(429).json({ ok: false, error: 'Demasiados intentos fallidos. Esperá unos minutos.' });
  }
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Ingresá usuario y contraseña' });
  }
  const { rows } = await db.query(
    'SELECT id, username, name, role, active, password_hash FROM users WHERE username = $1', [username]);
  const user = rows[0];
  const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid || !user.active) {
    registerFailure(ip);
    return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
  }
  loginFailures.delete(ip);

  // Nueva sesión (evita fijación de sesión)
  await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  req.session.userId = Number(user.id);
  req.session.role = user.role;
  await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));

  res.json({ ok: true, user: publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  const done = () => {
    res.clearCookie('chaman.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure });
    res.json({ ok: true });
  };
  if (req.session) req.session.destroy(() => done());
  else done();
});

app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/jobs'));

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

// ----- Zonas y recorrido -----
function zoneToFeature(row) {
  return {
    type: 'Feature',
    id: Number(row.id),
    properties: {
      ...(row.properties || {}),
      zoneId: Number(row.id),
      name: row.name,
      assignedTo: row.assigned_username || null
    },
    geometry: row.geometry
  };
}

// Zona "actual": la última zona activa (para el aplicador, la asignada a él o sin asignar)
async function currentZone(user) {
  const params = [];
  let where = "z.status = 'activa' AND z.origin = 'panel'";
  if (user.role === 'aplicador') {
    params.push(user.id);
    where += ' AND (z.assigned_to IS NULL OR z.assigned_to = $1)';
  }
  const { rows } = await db.query(
    `SELECT z.*, u.username AS assigned_username
       FROM zones z LEFT JOIN users u ON u.id = z.assigned_to
      WHERE ${where}
      ORDER BY z.created_at DESC, z.id DESC LIMIT 1`, params);
  return rows[0] || null;
}

// Trabajo abierto (pendiente o en curso) de una zona
async function currentJob(user, zoneId) {
  if (zoneId == null) return null;
  const params = [zoneId];
  let where = "zone_id = $1 AND status IN ('pendiente', 'en_curso') AND deleted_at IS NULL";
  if (user.role === 'aplicador') {
    params.push(user.id);
    where += ' AND (applicator_id IS NULL OR applicator_id = $2)';
  }
  const { rows } = await db.query(
    `SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 1`, params);
  return rows[0] || null;
}

// Al cerrar/reemplazar zonas: lo en curso queda finalizado y lo pendiente cancelado
const CLOSE_JOBS_SQL = `
  UPDATE jobs SET status = CASE WHEN status = 'en_curso' THEN 'finalizado' ELSE 'cancelado' END,
                  finished_at = now()
   WHERE status IN ('pendiente', 'en_curso') AND zone_id IN (SELECT id FROM closed)`;

// Condición SQL para los puntos "vigentes" del alcance (zona actual o sin zona)
function trackScope(zoneId, startIndex) {
  if (zoneId == null) {
    return { sql: 'zone_id IS NULL AND cleared_at IS NULL', params: [] };
  }
  return { sql: `zone_id = $${startIndex} AND cleared_at IS NULL`, params: [zoneId] };
}

async function countPoints(zoneId) {
  const scope = trackScope(zoneId, 1);
  const { rows } = await db.query(
    `SELECT count(*)::int AS count, max(received_at) AS last FROM track_points WHERE ${scope.sql}`, scope.params);
  return rows[0];
}

function isValidPolygon(geometry) {
  return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') &&
    Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0;
}

app.get('/api/zone', requireAuth, ah(async (req, res) => {
  const zone = await currentZone(req.user);
  const job = zone ? await currentJob(req.user, zone.id) : null;
  res.json({
    zone: zone ? zoneToFeature(zone) : null,
    job: jobToJson(job),
    updatedAt: zone ? zone.created_at.toISOString() : null
  });
}));

app.post('/api/zone', requireAuth, requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const { zone, name, assignedTo, job } = req.body || {};
  if (!zone || !isValidPolygon(zone.geometry)) {
    return res.status(400).json({ error: 'Zona inválida' });
  }

  let assignedId = null;
  if (assignedTo) {
    const { rows } = await db.query(
      "SELECT id FROM users WHERE username = $1 AND role = 'aplicador' AND active", [String(assignedTo).toLowerCase()]);
    if (!rows[0]) return res.status(400).json({ error: 'El aplicador indicado no existe o está inactivo' });
    assignedId = rows[0].id;
  }

  const props = (zone.properties && typeof zone.properties === 'object') ? zone.properties : {};
  const zoneName = String(name || props.name || 'Zona ' + new Date().toLocaleDateString('es-AR')).slice(0, 200);

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    // La zona nueva reemplaza a la activa anterior (del mismo aplicador o sin asignar)
    await client.query(
      `WITH closed AS (
         UPDATE zones SET status = 'reemplazada', closed_at = now()
          WHERE status = 'activa' AND origin = 'panel' AND assigned_to IS NOT DISTINCT FROM $1 RETURNING id)
       ${CLOSE_JOBS_SQL}`, [assignedId]);
    const { rows } = await client.query(
      `INSERT INTO zones (name, geometry, properties, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [zoneName, JSON.stringify(zone.geometry), JSON.stringify(props), assignedId, req.user.id]);
    // Cada asignación de zona genera un trabajo (la fórmula es opcional por ahora)
    const j = parseJobInput(job);
    const { rows: jobRows } = await client.query(
      `INSERT INTO jobs (zone_id, applicator_id, machine, device_id, lot_name, product, dose,
                         dose_unit, liters_per_ha, scheduled_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [rows[0].id, assignedId, j.machine, j.deviceId, j.lotName || zoneName, j.product, j.dose,
       j.doseUnit, j.litersPerHa, j.scheduledDate, j.notes, req.user.id]);
    await client.query('COMMIT');
    res.json({
      ok: true,
      zoneId: Number(rows[0].id),
      jobId: Number(jobRows[0].id),
      updatedAt: rows[0].created_at.toISOString()
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.delete('/api/zone', requireAuth, requireRole('supervisor', 'admin'), ah(async (req, res) => {
  // No se borra nada: las zonas quedan "cerradas" y el recorrido suelto se archiva
  await db.query(
    `WITH closed AS (
       UPDATE zones SET status = 'cerrada', closed_at = now()
        WHERE status = 'activa' AND origin = 'panel' RETURNING id)
     ${CLOSE_JOBS_SQL}`);
  await db.query('UPDATE track_points SET cleared_at = now() WHERE zone_id IS NULL AND cleared_at IS NULL');
  res.json({ ok: true });
}));

app.get('/api/track', requireAuth, requireRole('supervisor', 'admin'), ah(async (req, res) => {
  let zoneId;
  if (req.query.zoneId) {
    zoneId = parseInt(req.query.zoneId, 10);
    if (!Number.isFinite(zoneId)) return res.status(400).json({ error: 'zoneId inválido' });
  } else {
    const zone = await currentZone(req.user);
    zoneId = zone ? zone.id : null;
  }
  const scope = trackScope(zoneId, 1);
  const { rows } = await db.query(
    `SELECT lat, lng, accuracy, speed, recorded_at, received_at FROM track_points
      WHERE ${scope.sql}
      ORDER BY recorded_at DESC, id DESC LIMIT ${MAX_POINTS_RESPONSE}`, scope.params);
  rows.reverse();
  let last = null;
  const points = rows.map(r => {
    if (!last || r.received_at > last) last = r.received_at;
    return { lat: r.lat, lng: r.lng, accuracy: r.accuracy, speed: r.speed, ts: r.recorded_at.getTime() };
  });
  res.json({ points, count: points.length, updatedAt: last ? last.toISOString() : null });
}));

app.post('/api/track', requireAuth, requireRole('aplicador', 'admin'), ah(async (req, res) => {
  const { points } = req.body || {};
  if (!points) {
    return res.status(400).json({ error: 'Faltan puntos' });
  }
  const { lats, lngs, accs, speeds, times } = parsePoints(points);

  const zone = await currentZone(req.user);
  const zoneId = zone ? zone.id : null;
  if (lats.length) {
    const job = await currentJob(req.user, zoneId);
    if (job && job.status === 'pendiente') {
      // Primer punto GPS: el trabajo pasa a "en curso"
      await db.query(
        `UPDATE jobs SET status = 'en_curso', started_at = COALESCE(started_at, now()),
                         applicator_id = COALESCE(applicator_id, $2)
          WHERE id = $1 AND status = 'pendiente'`, [job.id, req.user.id]);
    }
    await db.query(
      `INSERT INTO track_points (job_id, zone_id, user_id, lat, lng, accuracy, speed, recorded_at)
       SELECT $1, $2, $3, t.lat, t.lng, t.acc, t.speed, t.ts
         FROM unnest($4::float8[], $5::float8[], $6::real[], $7::real[], $8::timestamptz[])
           AS t(lat, lng, acc, speed, ts)`,
      [job ? job.id : null, zoneId, req.user.id, lats, lngs, accs, speeds, times]);
  }
  const { count } = await countPoints(zoneId);
  res.json({ ok: true, count, inserted: lats.length });
}));

app.delete('/api/track', requireAuth, requireRole('aplicador', 'supervisor', 'admin'), ah(async (req, res) => {
  // "Limpiar" = archivar (cleared_at), no se borra el historial
  const zone = await currentZone(req.user);
  const scope = trackScope(zone ? zone.id : null, 1);
  const params = [...scope.params];
  let sql = `UPDATE track_points SET cleared_at = now() WHERE ${scope.sql}`;
  if (req.user.role === 'aplicador') {
    params.push(req.user.id);
    sql += ` AND user_id = $${params.length}`;
  }
  await db.query(sql, params);
  res.json({ ok: true });
}));

app.get('/api/status', requireAuth, ah(async (req, res) => {
  const zone = await currentZone(req.user);
  const job = zone ? await currentJob(req.user, zone.id) : null;
  const { count, last } = await countPoints(zone ? zone.id : null);
  const times = [zone && zone.created_at, last].filter(Boolean).map(d => d.getTime());
  res.json({
    hasZone: !!zone,
    zoneId: zone ? Number(zone.id) : null,
    jobId: job ? Number(job.id) : null,
    jobStatus: job ? job.status : null,
    trackCount: count,
    updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null
  });
}));

app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Errores: siempre JSON en la API
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'La petición es demasiado grande' });
  }
  console.error('[api] Error:', err);
  const dbDown = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P03'].includes(err.code) ||
    /timeout|terminated|Connection/i.test(err.message || '');
  if (dbDown) {
    return res.status(503).json({ error: 'No se pudo conectar con la base de datos. Probá de nuevo en unos segundos.' });
  }
  res.status(500).json({ error: 'Error interno del servidor' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Fumigacion demo en puerto ' + PORT);
});

function shutdown(signal) {
  console.log(`[server] ${signal} recibido, cerrando…`);
  server.close(() => {
    const pool = db.getPool();
    (pool ? pool.end() : Promise.resolve()).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
