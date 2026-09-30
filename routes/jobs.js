// Trabajos de aplicación: lote (polígono) + fórmula + aplicador, y su recorrido GPS.
const express = require('express');
const db = require('../lib/db');
const { ah, requireAuth, requireRole } = require('../lib/auth');
const { parsePoints } = require('../lib/track');
const { jobToJson, parseJobInput, parseRoute, parseTolerance, JOB_STATUSES } = require('../lib/jobs');
const { bus, emitJob } = require('../lib/events');

const router = express.Router();
const MAX_DETAIL_POINTS = 20000;
const SSE_PING_MS = 20000;
const SSE_DB_CHECK_MS = 10000;
const SSE_MAX_MS = 10 * 60 * 1000;

const JOB_SELECT = `
  SELECT j.*, z.geometry, u.username AS applicator_username, u.name AS applicator_name,
         tp.point_count, tp.last_point_at
    FROM jobs j
    JOIN zones z ON z.id = j.zone_id
    LEFT JOIN users u ON u.id = j.applicator_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS point_count, max(recorded_at) AS last_point_at
        FROM track_points WHERE job_id = j.id AND cleared_at IS NULL
    ) tp ON true`;

function isValidPolygon(geometry) {
  return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') &&
    Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0;
}

function pointJson(r) {
  return { id: Number(r.id), lat: r.lat, lng: r.lng, accuracy: r.accuracy, speed: r.speed, ts: r.recorded_at.getTime() };
}

// ¿Puede este usuario ver el trabajo?
function canSee(user, job) {
  if (user.role === 'admin' || user.role === 'supervisor') return true;
  return Number(job.applicator_id) === user.id || (job.applicator_id == null && job.status === 'pendiente');
}

async function loadJob(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Id inválido' });
    return null;
  }
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  const job = rows[0];
  if (!job || !canSee(req.user, job)) {
    res.status(404).json({ error: 'Trabajo no encontrado' });
    return null;
  }
  return job;
}

router.use(['/jobs', '/applicators'], requireAuth);

// Aplicadores activos (para elegir a quién asignar el trabajo)
router.get('/applicators', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const { rows } = await db.query(
    "SELECT id, username, name FROM users WHERE role = 'aplicador' AND active ORDER BY name, username");
  res.json({ applicators: rows.map(r => ({ id: Number(r.id), username: r.username, name: r.name })) });
}));

// Lista de trabajos. Filtros: status, applicatorId. scope=mine → los del aplicador logueado
router.get('/jobs', ah(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', '$' + params.length)); };

  if (req.user.role === 'aplicador') {
    add("(j.applicator_id = ? OR (j.applicator_id IS NULL AND j.status = 'pendiente'))", req.user.id);
  } else if (req.query.scope === 'mine') {
    // admin usando el tracker: trabajos abiertos
    where.push("j.status IN ('pendiente', 'en_curso')");
  }
  if (req.query.status) {
    const statuses = String(req.query.status).split(',').filter(s => JOB_STATUSES.includes(s));
    if (!statuses.length) return res.status(400).json({ error: 'Estado inválido' });
    add('j.status = ANY(?)', statuses);
  }
  if (req.query.applicatorId) {
    const aid = parseInt(req.query.applicatorId, 10);
    if (!Number.isFinite(aid)) return res.status(400).json({ error: 'Aplicador inválido' });
    add('j.applicator_id = ?', aid);
  }
  const { rows } = await db.query(
    `${JOB_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE j.status WHEN 'en_curso' THEN 0 WHEN 'pendiente' THEN 1 ELSE 2 END, j.created_at DESC
     LIMIT 200`, params);
  res.json({ jobs: rows.map(jobToJson) });
}));

// Crear trabajo: lote + fórmula + aplicador
router.post('/jobs', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const body = req.body || {};
  const geometry = body.geometry && body.geometry.type === 'Feature' ? body.geometry.geometry : body.geometry;
  if (!isValidPolygon(geometry)) return res.status(400).json({ error: 'Dibujá el polígono del lote' });
  const j = parseJobInput(body);
  if (!j.lotName) return res.status(400).json({ error: 'Poné el nombre del lote' });
  if (!j.product) return res.status(400).json({ error: 'Indicá el producto' });
  const route = parseRoute(body.route);
  if (route.error) return res.status(400).json({ error: route.error });
  const tol = parseTolerance(body.routeToleranceM);
  if (tol.error) return res.status(400).json({ error: tol.error });

  const applicatorId = parseInt(body.applicatorId, 10);
  if (!Number.isFinite(applicatorId)) return res.status(400).json({ error: 'Elegí el aplicador' });
  const { rows: apps } = await db.query(
    "SELECT id FROM users WHERE id = $1 AND role = 'aplicador' AND active", [applicatorId]);
  if (!apps[0]) return res.status(400).json({ error: 'El aplicador elegido no existe o está inactivo' });

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: [zone] } = await client.query(
      `INSERT INTO zones (name, geometry, properties, assigned_to, created_by, origin)
       VALUES ($1, $2, '{}'::jsonb, $3, $4, 'trabajo') RETURNING id`,
      [j.lotName, JSON.stringify(geometry), applicatorId, req.user.id]);
    const { rows: [job] } = await client.query(
      `INSERT INTO jobs (zone_id, applicator_id, machine, device_id, lot_name, product, dose,
                         dose_unit, liters_per_ha, scheduled_date, notes, created_by, route, route_tolerance_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [zone.id, applicatorId, j.machine, j.deviceId, j.lotName, j.product, j.dose,
       j.doseUnit, j.litersPerHa, j.scheduledDate, j.notes, req.user.id,
       route.route ? JSON.stringify(route.route) : null, tol.value ?? null]);
    await client.query('COMMIT');
    const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
    res.status(201).json({ ok: true, job: jobToJson(rows[0]) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// Detalle: trabajo + polígono + recorrido
router.get('/jobs/:id', ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT id, lat, lng, accuracy, speed, recorded_at FROM track_points
        WHERE job_id = $1 AND cleared_at IS NULL
        ORDER BY recorded_at DESC, id DESC LIMIT ${MAX_DETAIL_POINTS}
     ) t ORDER BY recorded_at, id`, [job.id]);
  res.json({ job: jobToJson(job), points: rows.map(pointJson) });
}));

// Puntos nuevos desde un id (para refresco incremental)
router.get('/jobs/:id/track', ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  const since = parseInt(req.query.since, 10) || 0;
  const { rows } = await db.query(
    `SELECT id, lat, lng, accuracy, speed, recorded_at FROM track_points
      WHERE job_id = $1 AND cleared_at IS NULL AND id > $2 ORDER BY id LIMIT 5000`, [job.id, since]);
  res.json({ status: job.status, points: rows.map(pointJson) });
}));

// Seguimiento en vivo por Server-Sent Events (autenticado con la cookie de sesión).
// Eventos: "points" (puntos nuevos, id = último id) y "status" (cambio de estado).
router.get('/jobs/:id/stream', ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  let lastId = parseInt(req.get('Last-Event-ID') || req.query.since, 10) || 0;
  let status = job.status;

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  let closed = false;
  const send = (event, data, id) => {
    if (closed) return;
    res.write(`event: ${event}\n${id ? 'id: ' + id + '\n' : ''}data: ${JSON.stringify(data)}\n\n`);
  };
  const sendPoints = (points) => {
    const fresh = points.filter(p => p.id > lastId);
    if (!fresh.length) return;
    lastId = Math.max(lastId, ...fresh.map(p => p.id));
    send('points', { points: fresh }, lastId);
  };

  // Puesta al día desde la base (al conectar y cada tanto, por si hubo puntos de otra vía)
  let checking = false;
  const catchUp = async () => {
    if (checking || closed) return;
    checking = true;
    try {
      const { rows } = await db.query(
        `SELECT id, lat, lng, accuracy, speed, recorded_at FROM track_points
          WHERE job_id = $1 AND cleared_at IS NULL AND id > $2 ORDER BY id LIMIT 5000`, [job.id, lastId]);
      if (rows.length) sendPoints(rows.map(pointJson));
      const { rows: st } = await db.query('SELECT status FROM jobs WHERE id = $1', [job.id]);
      if (st[0] && st[0].status !== status) {
        status = st[0].status;
        send('status', { status });
      }
    } catch (e) {
      console.error('[sse] Error consultando la base:', e.message);
    } finally {
      checking = false;
    }
  };

  const onEvent = ({ type, data }) => {
    if (type === 'points') sendPoints(data);
    if (type === 'status') { status = data.status; send('status', data); }
  };
  bus.on('job:' + job.id, onEvent);
  send('status', { status });
  await catchUp();

  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, SSE_PING_MS);
  const check = setInterval(catchUp, SSE_DB_CHECK_MS);
  // Se corta cada 10 min; el navegador se reconecta solo con Last-Event-ID
  const maxAge = setTimeout(() => res.end(), SSE_MAX_MS);
  req.on('close', () => {
    closed = true;
    clearInterval(ping);
    clearInterval(check);
    clearTimeout(maxAge);
    bus.off('job:' + job.id, onEvent);
  });
}));

// Editar datos del trabajo (mientras no esté terminado)
router.patch('/jobs/:id', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  if (!['pendiente', 'en_curso'].includes(job.status)) {
    return res.status(400).json({ error: 'Sólo se pueden editar trabajos pendientes o en curso' });
  }
  const body = req.body || {};
  const j = parseJobInput(body);
  const fields = { lotName: 'lot_name', product: 'product', dose: 'dose', doseUnit: 'dose_unit',
    litersPerHa: 'liters_per_ha', scheduledDate: 'scheduled_date', notes: 'notes', machine: 'machine', deviceId: 'device_id' };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(fields)) {
    if (body[key] === undefined) continue;
    params.push(j[key]);
    sets.push(`${col} = $${params.length}`);
  }
  if (body.lotName !== undefined && !j.lotName) return res.status(400).json({ error: 'Poné el nombre del lote' });
  if (body.product !== undefined && !j.product) return res.status(400).json({ error: 'Indicá el producto' });
  if (body.applicatorId !== undefined) {
    if (job.status !== 'pendiente') return res.status(400).json({ error: 'Sólo se cambia el aplicador antes de iniciar el trabajo' });
    const aid = parseInt(body.applicatorId, 10);
    const { rows } = await db.query("SELECT id FROM users WHERE id = $1 AND role = 'aplicador' AND active", [aid]);
    if (!rows[0]) return res.status(400).json({ error: 'El aplicador elegido no existe o está inactivo' });
    params.push(aid);
    sets.push(`applicator_id = $${params.length}`);
  }
  if (body.route !== undefined) {
    if (job.status !== 'pendiente') {
      return res.status(400).json({ error: 'El recorrido planificado sólo se puede cambiar antes de iniciar el trabajo' });
    }
    const route = parseRoute(body.route);
    if (route.error) return res.status(400).json({ error: route.error });
    params.push(route.route ? JSON.stringify(route.route) : null);
    sets.push(`route = $${params.length}`);
  }
  const tol = parseTolerance(body.routeToleranceM);
  if (tol.error) return res.status(400).json({ error: tol.error });
  if (tol.value !== undefined) {
    params.push(tol.value);
    sets.push(`route_tolerance_m = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'No hay cambios' });
  params.push(job.id);
  await db.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  if (j.lotName) await db.query('UPDATE zones SET name = $1 WHERE id = $2', [j.lotName, job.zone_id]);
  if (body.applicatorId !== undefined) await db.query('UPDATE zones SET assigned_to = $1 WHERE id = $2', [parseInt(body.applicatorId, 10), job.zone_id]);
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
  emitJob(job.id, 'status', { status: rows[0].status, job: jobToJson(rows[0]) });
  res.json({ ok: true, job: jobToJson(rows[0]) });
}));

// Iniciar (o reanudar) un trabajo
router.post('/jobs/:id/start', requireRole('aplicador', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  if (job.status === 'en_curso') return res.json({ ok: true, job: jobToJson(job) });
  if (job.status !== 'pendiente') return res.status(400).json({ error: 'El trabajo ya está ' + job.status.replace('_', ' ') });
  if (req.user.role === 'aplicador') {
    const { rows } = await db.query(
      "SELECT id, lot_name FROM jobs WHERE applicator_id = $1 AND status = 'en_curso' AND id <> $2 LIMIT 1",
      [req.user.id, job.id]);
    if (rows[0]) {
      return res.status(409).json({ error: `Ya tenés un trabajo en curso (${rows[0].lot_name || '#' + rows[0].id}). Finalizalo antes de iniciar otro.` });
    }
  }
  await db.query(
    `UPDATE jobs SET status = 'en_curso', started_at = COALESCE(started_at, now()),
                     applicator_id = COALESCE(applicator_id, $2)
      WHERE id = $1 AND status = 'pendiente'`,
    [job.id, req.user.role === 'aplicador' ? req.user.id : null]);
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
  emitJob(job.id, 'status', { status: rows[0].status, job: jobToJson(rows[0]) });
  res.json({ ok: true, job: jobToJson(rows[0]) });
}));

async function closeJob(job, status) {
  await db.query(`UPDATE jobs SET status = $2, finished_at = now() WHERE id = $1`, [job.id, status]);
  await db.query(`UPDATE zones SET status = 'cerrada', closed_at = now() WHERE id = $1 AND status = 'activa'`, [job.zone_id]);
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
  emitJob(job.id, 'status', { status: rows[0].status, job: jobToJson(rows[0]) });
  return rows[0];
}

router.post('/jobs/:id/finish', ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  if (req.user.role === 'aplicador' && Number(job.applicator_id) !== req.user.id) {
    return res.status(403).json({ error: 'No tenés permisos para esta acción' });
  }
  if (job.status !== 'en_curso') {
    return res.status(400).json({ error: job.status === 'pendiente' ? 'El trabajo todavía no se inició' : 'El trabajo ya está ' + job.status });
  }
  res.json({ ok: true, job: jobToJson(await closeJob(job, 'finalizado')) });
}));

router.post('/jobs/:id/cancel', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  if (!['pendiente', 'en_curso'].includes(job.status)) {
    return res.status(400).json({ error: 'El trabajo ya está ' + job.status });
  }
  res.json({ ok: true, job: jobToJson(await closeJob(job, 'cancelado')) });
}));

// Puntos GPS de un trabajo (desde el tracker del aplicador)
router.post('/jobs/:id/track', requireRole('aplicador', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  if (req.user.role === 'aplicador' && Number(job.applicator_id) !== req.user.id) {
    return res.status(403).json({ error: 'Este trabajo no está asignado a vos' });
  }
  const { points } = req.body || {};
  if (!points) return res.status(400).json({ error: 'Faltan puntos' });
  if (job.status !== 'en_curso' && job.status !== 'finalizado') {
    return res.status(409).json({ error: job.status === 'pendiente' ? 'Iniciá el trabajo antes de enviar puntos' : 'El trabajo está cancelado' });
  }
  const p = parsePoints(points);
  let inserted = 0;
  if (p.count) {
    // Si el trabajo ya se finalizó, sólo se aceptan puntos grabados antes del cierre (envíos atrasados)
    // client_id: id generado en el celular; si la cola offline reenvía un punto, no se duplica
    const { rows } = await db.query(
      `INSERT INTO track_points (job_id, zone_id, user_id, lat, lng, accuracy, speed, recorded_at, client_id)
       SELECT $1, $2, $3, t.lat, t.lng, t.acc, t.speed, t.ts, t.cid
         FROM unnest($4::float8[], $5::float8[], $6::real[], $7::real[], $8::timestamptz[], $10::text[])
           AS t(lat, lng, acc, speed, ts, cid)
        WHERE $9::timestamptz IS NULL OR t.ts <= $9::timestamptz
       ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING id, lat, lng, accuracy, speed, recorded_at`,
      [job.id, job.zone_id, req.user.id, p.lats, p.lngs, p.accs, p.speeds, p.times,
       job.status === 'finalizado' ? job.finished_at : null, p.clientIds]);
    inserted = rows.length;
    if (rows.length) emitJob(job.id, 'points', rows.map(pointJson));
  }
  res.json({ ok: true, inserted, received: p.count });
}));

module.exports = router;
