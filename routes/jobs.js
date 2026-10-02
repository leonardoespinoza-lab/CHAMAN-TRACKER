// Trabajos de aplicación: ruta (pasadas) + zona derivada + fórmula + aplicador, y su recorrido GPS.
const express = require('express');
const db = require('../lib/db');
const { ah, requireAuth, requireRole } = require('../lib/auth');
const { parsePoints } = require('../lib/track');
const { jobToJson, stageToJson, parseJobInput, parseRoute, parseTolerance, parsePassWidth, parsePlannedStart, parseMethod, parseSpeedLimit, JOB_STATUSES, DEFAULT_PASS_WIDTH_M, DEFAULT_GPS_TOLERANCE_M } = require('../lib/jobs');
const alerts = require('../lib/alerts');
const ZoneGeo = require('../zone-geo');
const { computeCoverage, scheduleCoverage, computeStageStats } = require('../lib/coverage');
const { bus, emitJob } = require('../lib/events');
const gestion = require('../lib/gestion');

// Producto del catálogo y máquinas asignadas: tienen que existir (y estar activos si cambian)
async function checkRefs(j, body, job) {
  const out = {};
  if (body.productId !== undefined) {
    if (body.productId !== null && body.productId !== '' && !j.productId) return { error: 'Producto del catálogo inválido' };
    if (j.productId) {
      const { rows } = await db.query('SELECT id, name, active FROM products WHERE id = $1', [j.productId]);
      if (!rows[0] || (!rows[0].active && !(job && Number(job.product_id) === j.productId))) return { error: 'El producto del catálogo no existe o está desactivado' };
      out.productName = rows[0].name;
    }
  }
  for (const [k, label] of [['machineId', 'La máquina'], ['implementId', 'El implemento']]) {
    if (body[k] === undefined) continue;
    if (body[k] !== null && body[k] !== '' && !j[k]) return { error: label + ' elegida no es válida' };
    if (!j[k]) continue;
    const { rows } = await db.query('SELECT id, active FROM machines WHERE id = $1', [j[k]]);
    const keep = job && Number(job[k === 'machineId' ? 'machine_id' : 'implement_id']) === j[k];
    if (!rows[0] || (!rows[0].active && !keep)) return { error: label + ' elegida no existe o está desactivada' };
  }
  return out;
}
// Datos de gestión del detalle: consumo estimado, reingreso y carencia
async function jobGestion(job) {
  const c = gestion.jobConsumption(job);
  const { rows: [mv] } = await db.query("SELECT quantity, unit, moved_on, updated_at, details FROM stock_movements WHERE job_id = $1 AND kind = 'consumo'", [job.id]);
  const last = job.finished_at || job.last_stage_ended_at || null;
  const rh = job.p_reentry_hours != null ? Number(job.p_reentry_hours) : null;
  const phi = job.p_phi_days != null ? Number(job.p_phi_days) : null;
  const lastMs = last ? new Date(last).getTime() : null;
  return {
    consumption: { areaHa: c.areaHa, coveredHa: c.coveredHa, coveragePct: c.coveragePct, quantity: c.quantity ?? null, unit: c.unit || null,
      formula: c.formula || null, error: c.error || null, unitMismatch: c.unitMismatch || false },
    stockMovement: mv ? { quantity: -Number(mv.quantity), unit: mv.unit, date: mv.moved_on, updatedAt: mv.updated_at, partial: !!(mv.details && mv.details.partial) } : null,
    lastApplicationAt: last,
    reentryUntil: lastMs != null && rh != null ? new Date(lastMs + rh * 3600e3).toISOString() : null,
    harvestFrom: lastMs != null && phi != null ? new Date(lastMs + phi * 86400e3).toISOString() : null
  };
}

const router = express.Router();
const MAX_DETAIL_POINTS = 20000;
const SSE_PING_MS = 20000;
const SSE_DB_CHECK_MS = 10000;
const SSE_MAX_MS = 10 * 60 * 1000;

const JOB_SELECT = `
  SELECT j.*, z.geometry, u.username AS applicator_username, u.name AS applicator_name,
         tp.point_count, tp.last_point_at,
         st.stage_count, st.open_stage_id, st.open_stage_seq, st.open_stage_started_at, st.stages_seconds,
         st.last_stage_ended_at, st.first_stage_started_at,
         pr.name AS p_name, pr.active_ingredient AS p_ai, pr.tox_class AS p_tox_class, pr.phi_days AS p_phi_days, pr.phi_text AS p_phi_text,
         pr.reentry_hours AS p_reentry_hours, pr.reentry_text AS p_reentry_text, pr.unit AS product_unit, pr.source AS p_source,
         pr.source_url AS p_source_url, mm.name AS machine_name, im.name AS implement_name
    FROM jobs j
    JOIN zones z ON z.id = j.zone_id
    LEFT JOIN users u ON u.id = j.applicator_id
    LEFT JOIN products pr ON pr.id = j.product_id
    LEFT JOIN machines mm ON mm.id = j.machine_id
    LEFT JOIN machines im ON im.id = j.implement_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS point_count, max(recorded_at) AS last_point_at
        FROM track_points WHERE job_id = j.id AND cleared_at IS NULL
    ) tp ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS stage_count,
             max(id) FILTER (WHERE ended_at IS NULL) AS open_stage_id,
             max(seq) FILTER (WHERE ended_at IS NULL) AS open_stage_seq,
             max(started_at) FILTER (WHERE ended_at IS NULL) AS open_stage_started_at,
             COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))), 0)::float8 AS stages_seconds,
             max(ended_at) AS last_stage_ended_at, min(started_at) AS first_stage_started_at
        FROM job_stages WHERE job_id = j.id
    ) st ON true`;
const STAGE_SELECT = `
  SELECT s.*, u.name AS applicator_name, u.username AS applicator_username
    FROM job_stages s LEFT JOIN users u ON u.id = s.applicator_id`;
const POINT_COLS = 'id, lat, lng, accuracy, speed, recorded_at, stage_id';
const ms = (d) => d == null ? null : new Date(d).getTime();

function isValidPolygon(geometry) {
  return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') &&
    Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0;
}

// Zona de aplicación calculada a partir de la ruta y el ancho de pasada
function zoneFromRoute(route, widthM) {
  const geometry = ZoneGeo.deriveZone(route, widthM);
  return isValidPolygon(geometry) ? geometry : null;
}

function pointJson(r) {
  return { id: Number(r.id), lat: r.lat, lng: r.lng, accuracy: r.accuracy, speed: r.speed, ts: r.recorded_at.getTime(),
    stage: r.stage_id != null ? Number(r.stage_id) : null };
}

// ¿Puede este usuario ver el trabajo?
function canSee(user, job) {
  if (user.role === 'admin' || user.role === 'supervisor') return true;
  return Number(job.applicator_id) === user.id || (job.applicator_id == null && job.status === 'pendiente');
}

async function loadJob(req, res, opts = {}) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Id inválido' });
    return null;
  }
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  const job = rows[0];
  if (job && job.deleted_at && !opts.includeDeleted && canSee(req.user, job)) {
    res.status(410).json({ error: 'Este trabajo fue eliminado por el supervisor', deleted: true });
    return null;
  }
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
  const where = ['j.deleted_at IS NULL'];
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
    `${JOB_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY CASE j.status WHEN 'en_curso' THEN 0 WHEN 'pendiente' THEN 1 ELSE 2 END, j.created_at DESC
     LIMIT 200`, params);
  const out = rows.map(jobToJson);
  if (req.user.role !== 'aplicador' && out.length) {
    // Resumen de alertas por trabajo (abiertas y no vistas) para las tarjetas
    const { rows: al } = await db.query(
      `SELECT job_id, type, severity, resolved_at IS NULL AS open, acknowledged_at IS NULL AND severity <> 'info' AS unseen
         FROM alerts WHERE job_id = ANY($1::bigint[]) AND (resolved_at IS NULL OR (acknowledged_at IS NULL AND severity <> 'info'))`,
      [out.map(j => j.id)]);
    const byJob = new Map();
    for (const a of al) {
      const id = Number(a.job_id);
      const s = byJob.get(id) || { open: 0, unseen: 0, types: [], high: false };
      if (a.open) s.open++;
      if (a.unseen) s.unseen++;
      if (!s.types.includes(a.type)) s.types.push(a.type);
      if (a.severity === 'alta' && (a.open || a.unseen)) s.high = true;
      byJob.set(id, s);
    }
    for (const j of out) j.alerts = byJob.get(j.id) || { open: 0, unseen: 0, types: [], high: false };
  }
  res.json({ jobs: out });
}));

// Crear trabajo: ruta (pasadas) + fórmula + aplicador. La zona se calcula sola a partir de la ruta.
// (Compatibilidad: sin ruta se acepta un polígono dibujado a mano en "geometry".)
router.post('/jobs', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const body = req.body || {};
  const j = parseJobInput(body);
  if (!j.lotName) return res.status(400).json({ error: 'Poné el nombre del lote' });
  const route = parseRoute(body.route);
  if (route.error) return res.status(400).json({ error: route.error });
  const width = parsePassWidth(body.passWidthM);
  if (width.error) return res.status(400).json({ error: width.error });
  const passWidth = width.value ?? DEFAULT_PASS_WIDTH_M;
  const tol = parseTolerance(body.routeToleranceM);
  if (tol.error) return res.status(400).json({ error: tol.error });
  const planned = parsePlannedStart(body.plannedStartAt);
  if (planned.error) return res.status(400).json({ error: planned.error });
  const method = parseMethod(body.applicationMethod);
  if (method.error) return res.status(400).json({ error: method.error });
  const speedLimit = parseSpeedLimit(body.speedLimitKmh);
  if (speedLimit.error) return res.status(400).json({ error: speedLimit.error });
  let geometry, zoneSource;
  if (route.route) {
    geometry = zoneFromRoute(route.route, passWidth);
    if (!geometry) return res.status(400).json({ error: 'No se pudo calcular la zona a partir de la ruta' });
    zoneSource = 'ruta';
    if (tol.value == null) tol.value = DEFAULT_GPS_TOLERANCE_M;
  } else {
    geometry = body.geometry && body.geometry.type === 'Feature' ? body.geometry.geometry : body.geometry;
    if (!isValidPolygon(geometry)) return res.status(400).json({ error: 'Dibujá la ruta: al menos una pasada' });
    zoneSource = 'dibujada';
  }
  const refs = await checkRefs(j, body, null);
  if (refs.error) return res.status(400).json({ error: refs.error });
  if (!j.product && refs.productName) j.product = refs.productName;
  if (!j.product) return res.status(400).json({ error: 'Indicá el producto' });

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
                         dose_unit, liters_per_ha, scheduled_date, notes, created_by, route, route_tolerance_m,
                         pass_width_m, zone_source, planned_start_at, application_method, speed_limit_kmh,
                         product_id, machine_id, implement_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
      [zone.id, applicatorId, j.machine, j.deviceId, j.lotName, j.product, j.dose,
       j.doseUnit, j.litersPerHa, j.scheduledDate, j.notes, req.user.id,
       route.route ? JSON.stringify(route.route) : null, tol.value ?? null, passWidth, zoneSource, planned.value ?? null,
       method.value ?? null, speedLimit.value ?? null, j.productId, j.machineId, j.implementId]);
    await client.query('COMMIT');
    const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
    if (planned.value) alerts.evaluateJob(Number(job.id)).catch(() => {});
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
  let job = await loadJob(req, res);
  if (!job) return;
  // Trabajos finalizados antes de esta versión (o por el panel simple): calcular la zona cubierta una vez
  if (job.status === 'finalizado' && !job.covered_at) {
    try {
      await computeCoverage(job.id);
      ({ rows: [job] } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]));
    } catch (e) {
      console.error('[cobertura] No se pudo calcular el trabajo ' + job.id + ':', e.message);
    }
  }
  // Etapas sin estadísticas (p. ej. creadas por la migración): calcularlas una vez
  if (job.stage_count) {
    const { rows: [m] } = await db.query('SELECT count(*)::int AS n FROM job_stages WHERE job_id = $1 AND stats_at IS NULL', [job.id]);
    if (m.n) await computeStageStats(job.id).catch(e => console.error('[etapas] Trabajo ' + job.id + ':', e.message));
  }
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT ${POINT_COLS} FROM track_points
        WHERE job_id = $1 AND cleared_at IS NULL
        ORDER BY recorded_at DESC, id DESC LIMIT ${MAX_DETAIL_POINTS}
     ) t ORDER BY recorded_at, id`, [job.id]);
  const { rows: pz } = await db.query('SELECT paused_at, resumed_at FROM job_pauses WHERE job_id = $1 ORDER BY paused_at', [job.id]);
  const out = { job: jobToJson(job, { detail: true }), points: rows.map(pointJson),
    pauses: pz.map(p => ({ start: p.paused_at, end: p.resumed_at })), stages: await loadStages(job.id) };
  try { out.gestion = await jobGestion(job); } catch (e) { console.error('[gestion] Trabajo ' + job.id + ':', e.message); }
  if (req.user.role !== 'aplicador') {
    const { rows: al } = await db.query(`${alerts.ALERT_SELECT} WHERE a.job_id = $1 ORDER BY a.started_at, a.id`, [job.id]);
    out.alerts = al.map(alerts.alertToJson);
  }
  res.json(out);
}));

// Puntos nuevos desde un id (para refresco incremental)
router.get('/jobs/:id/track', ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  const since = parseInt(req.query.since, 10) || 0;
  const { rows } = await db.query(
    `SELECT ${POINT_COLS} FROM track_points
      WHERE job_id = $1 AND cleared_at IS NULL AND id > $2 ORDER BY id LIMIT 5000`, [job.id, since]);
  const out = { status: job.status, points: rows.map(pointJson) };
  if (req.query.job === '1') out.job = jobToJson(job); // datos actuales (el tracker ve las ediciones)
  res.json(out);
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
  let cleanup = () => { closed = true; };
  const endStream = () => { if (!closed) { cleanup(); res.end(); } };
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
        `SELECT ${POINT_COLS} FROM track_points
          WHERE job_id = $1 AND cleared_at IS NULL AND id > $2 ORDER BY id LIMIT 5000`, [job.id, lastId]);
      if (rows.length) sendPoints(rows.map(pointJson));
      const { rows: st } = await db.query('SELECT status, deleted_at FROM jobs WHERE id = $1', [job.id]);
      if (st[0] && st[0].deleted_at) {
        send('deleted', { deleted: true });
        endStream();
        return;
      }
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
    if (type === 'coverage') send('coverage', data);
    if (type === 'alert') send('alert', data);
    if (type === 'pause') send('pause', data);
    if (type === 'stage') send('stage', data);
    if (type === 'deleted') { send('deleted', data); endStream(); }
  };
  bus.on('job:' + job.id, onEvent);
  send('status', { status });
  await catchUp();
  if (closed) { bus.off('job:' + job.id, onEvent); return; } // eliminado mientras tanto

  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, SSE_PING_MS);
  const check = setInterval(catchUp, SSE_DB_CHECK_MS);
  // Se corta cada 10 min; el navegador se reconecta solo con Last-Event-ID
  const maxAge = setTimeout(() => res.end(), SSE_MAX_MS);
  cleanup = () => {
    closed = true;
    clearInterval(ping);
    clearInterval(check);
    clearTimeout(maxAge);
    bus.off('job:' + job.id, onEvent);
  };
  req.on('close', cleanup);
}));

// Editar datos del trabajo (mientras no esté terminado)
router.patch('/jobs/:id', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  const body = req.body || {};
  // Terminado: sólo se puede corregir la máquina / implemento asignados (para sus km y horas)
  const onlyMachines = Object.keys(body).length > 0 && Object.keys(body).every(k => ['machineId', 'implementId'].includes(k));
  if (!['pendiente', 'en_curso'].includes(job.status) && !(job.status === 'finalizado' && onlyMachines)) {
    return res.status(400).json({ error: 'Sólo se pueden editar trabajos pendientes o en curso' });
  }
  const j = parseJobInput(body);
  const fields = { lotName: 'lot_name', product: 'product', dose: 'dose', doseUnit: 'dose_unit',
    litersPerHa: 'liters_per_ha', scheduledDate: 'scheduled_date', notes: 'notes', machine: 'machine', deviceId: 'device_id',
    productId: 'product_id', machineId: 'machine_id', implementId: 'implement_id' };
  const refs = await checkRefs(j, body, job);
  if (refs.error) return res.status(400).json({ error: refs.error });
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
  // Geometría (ruta, ancho de pasada, zona): sólo antes de iniciar
  let geometry;
  const width = parsePassWidth(body.passWidthM);
  if (width.error) return res.status(400).json({ error: width.error });
  if (body.route !== undefined || width.value !== undefined) {
    if (job.status !== 'pendiente') {
      return res.status(400).json({ error: 'La ruta y el ancho de pasada sólo se pueden cambiar antes de iniciar el trabajo' });
    }
    let route = job.route || null;
    if (body.route !== undefined) {
      const parsed = parseRoute(body.route);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      route = parsed.route;
    }
    const passWidth = width.value ?? (job.pass_width_m != null ? Number(job.pass_width_m) : DEFAULT_PASS_WIDTH_M);
    if (route) {
      geometry = zoneFromRoute(route, passWidth);
      if (!geometry) return res.status(400).json({ error: 'No se pudo calcular la zona a partir de la ruta' });
      params.push(JSON.stringify(route)); sets.push(`route = $${params.length}`);
      params.push(passWidth); sets.push(`pass_width_m = $${params.length}`);
      sets.push("zone_source = 'ruta'");
    } else if (job.zone_source === 'ruta') {
      return res.status(400).json({ error: 'Dibujá la ruta: al menos una pasada' });
    } else {
      // Trabajo anterior con lote dibujado a mano: se puede quedar sin ruta
      params.push(null); sets.push(`route = $${params.length}`);
      params.push(passWidth); sets.push(`pass_width_m = $${params.length}`);
    }
  }
  if (body.geometry !== undefined && !geometry) {
    // Compatibilidad: polígono dibujado a mano (sólo trabajos sin ruta)
    if (job.status !== 'pendiente') {
      return res.status(400).json({ error: 'El polígono del lote sólo se puede cambiar antes de iniciar el trabajo' });
    }
    geometry = body.geometry && body.geometry.type === 'Feature' ? body.geometry.geometry : body.geometry;
    if (!isValidPolygon(geometry)) return res.status(400).json({ error: 'Dibujá el polígono del lote' });
    sets.push("zone_source = 'dibujada'");
  }
  // Inicio programado: sólo tiene sentido antes de iniciar (si no cambió, no se valida)
  let plannedChanged = false;
  if (body.plannedStartAt !== undefined) {
    const planned = parsePlannedStart(body.plannedStartAt);
    if (planned.error) return res.status(400).json({ error: planned.error });
    const cur = job.planned_start_at ? new Date(job.planned_start_at).toISOString() : null;
    if (planned.value !== cur) {
      if (job.status !== 'pendiente') return res.status(400).json({ error: 'El inicio programado sólo se cambia antes de iniciar el trabajo' });
      params.push(planned.value); sets.push(`planned_start_at = $${params.length}`);
      plannedChanged = true;
    }
  }
  // Tolerancia GPS: no cambia la zona, se puede ajustar también en curso.
  // Si se reenvía el valor guardado (trabajos viejos, fuera del rango nuevo) no se valida.
  const same = body.routeToleranceM !== undefined && job.route_tolerance_m != null && Number(body.routeToleranceM) === Number(job.route_tolerance_m);
  const tol = same ? { value: undefined } : parseTolerance(body.routeToleranceM);
  if (tol.error) return res.status(400).json({ error: tol.error });
  if (tol.value !== undefined) {
    params.push(tol.value);
    sets.push(`route_tolerance_m = $${params.length}`);
  }
  // Método de aplicación y velocidad máxima: se pueden ajustar también en curso
  let speedChanged = false;
  if (body.applicationMethod !== undefined) {
    const m = parseMethod(body.applicationMethod);
    if (m.error) return res.status(400).json({ error: m.error });
    params.push(m.value); sets.push(`application_method = $${params.length}`);
  }
  if (body.speedLimitKmh !== undefined) {
    const sl = parseSpeedLimit(body.speedLimitKmh);
    if (sl.error) return res.status(400).json({ error: sl.error });
    if ((sl.value ?? null) !== (job.speed_limit_kmh != null ? Number(job.speed_limit_kmh) : null)) speedChanged = true;
    params.push(sl.value); sets.push(`speed_limit_kmh = $${params.length}`);
  }
  if (!sets.length && !geometry) return res.status(400).json({ error: 'No hay cambios' });
  if (sets.length) {
    params.push(job.id);
    await db.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }
  if (geometry) await db.query('UPDATE zones SET geometry = $1 WHERE id = $2', [JSON.stringify(geometry), job.zone_id]);
  // Si cambió la fórmula, recalcular el consumo ya registrado (etapas cerradas)
  if (['product', 'productId', 'dose', 'doseUnit', 'litersPerHa'].some(k => body[k] !== undefined)) {
    await gestion.afterCoverage(job.id).catch(e => console.error('[stock]', e.message));
  }
  if (j.lotName) await db.query('UPDATE zones SET name = $1 WHERE id = $2', [j.lotName, job.zone_id]);
  if (body.applicatorId !== undefined) await db.query('UPDATE zones SET assigned_to = $1 WHERE id = $2', [parseInt(body.applicatorId, 10), job.zone_id]);
  if (plannedChanged || speedChanged) await alerts.evaluateJob(Number(job.id)).catch(e => console.error('[alertas]', e.message));
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
  emitJob(job.id, 'status', { status: rows[0].status, job: jobToJson(rows[0]) });
  res.json({ ok: true, job: jobToJson(rows[0]) });
}));

// Pausa del GPS (aplicador): mientras está en pausa no hay alertas de parada ni de falta de señal.
// "at" = hora en que pausó en el celular (si el pedido llega tarde por falta de conexión).
function clampAt(at, min, max) {
  let t = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) t = max;
  return new Date(Math.min(max, Math.max(min, t)));
}
async function closePauses(jobId, when) {
  await db.query(
    `UPDATE job_pauses SET resumed_at = GREATEST(paused_at, $2::timestamptz) WHERE job_id = $1 AND resumed_at IS NULL`, [jobId, when]);
  await db.query('UPDATE jobs SET paused_at = NULL WHERE id = $1', [jobId]);
}
async function pauseAction(req, res, action) {
  const job = await loadJob(req, res, { includeDeleted: true });
  if (!job) return;
  if (req.user.role === 'aplicador' && Number(job.applicator_id) !== req.user.id) {
    return res.status(403).json({ error: 'Este trabajo no está asignado a vos' });
  }
  if (job.status !== 'en_curso' || job.deleted_at) return res.json({ ok: true, ignored: true, status: job.status });
  const now = Date.now();
  if (action === 'pause') {
    if (!job.paused_at) {
      const at = clampAt((req.body || {}).at, new Date(job.started_at).getTime(), now);
      await db.query('INSERT INTO job_pauses (job_id, user_id, paused_at) VALUES ($1, $2, $3)', [job.id, req.user.id, at]);
      await db.query('UPDATE jobs SET paused_at = $2 WHERE id = $1', [job.id, at]);
    }
  } else if (job.paused_at) {
    await closePauses(job.id, clampAt((req.body || {}).at, new Date(job.paused_at).getTime(), now));
  }
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
  emitJob(job.id, 'pause', { pausedAt: rows[0].paused_at });
  alerts.evaluateJob(Number(job.id)).catch(e => console.error('[alertas]', e.message));
  res.json({ ok: true, job: jobToJson(rows[0]) });
}
router.post('/jobs/:id/pause', requireRole('aplicador', 'admin'), ah((req, res) => pauseAction(req, res, 'pause')));
router.post('/jobs/:id/resume', requireRole('aplicador', 'admin'), ah((req, res) => pauseAction(req, res, 'resume')));

// ---------- etapas ----------
// Un trabajo se puede hacer en varias jornadas: cada etapa es una sesión de grabación.
// pendiente → en_curso (con etapas) → finalizado sólo cuando el aplicador o el supervisor lo finaliza.
const STAGE_GRACE_MS = 3000;          // diferencia de reloj tolerada entre el celular y el servidor
const RECORDING_RECENT_MS = 2 * 60000; // otra etapa con puntos recientes = está grabando

async function loadStages(jobId) {
  const { rows } = await db.query(`${STAGE_SELECT} WHERE s.job_id = $1 ORDER BY s.seq`, [jobId]);
  return rows.map(stageToJson);
}
async function openStageOf(jobId) {
  const { rows } = await db.query('SELECT * FROM job_stages WHERE job_id = $1 AND ended_at IS NULL', [jobId]);
  return rows[0] || null;
}
// Última actividad de una etapa abierta (último punto, pausa o inicio)
async function stageLastActivity(stage, pausedAt) {
  const { rows: [r] } = await db.query('SELECT max(recorded_at) AS t FROM track_points WHERE stage_id = $1 AND cleared_at IS NULL', [stage.id]);
  return Math.max(ms(r.t) || 0, ms(pausedAt) || 0, ms(stage.started_at));
}
// Cierra la etapa abierta (y las pausas) en "at"
async function endStage(jobId, at, endedBy) {
  const { rows } = await db.query(
    `UPDATE job_stages SET ended_at = LEAST(now(), GREATEST(started_at, $2::timestamptz)), ended_by = $3
      WHERE job_id = $1 AND ended_at IS NULL RETURNING *`, [jobId, at, endedBy]);
  if (!rows[0]) return null;
  await closePauses(jobId, rows[0].ended_at);
  return rows[0];
}
async function emitStages(jobId) {
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [jobId]);
  if (!rows[0]) return null;
  const job = jobToJson(rows[0]);
  emitJob(jobId, 'stage', { job, stages: await loadStages(jobId) });
  return rows[0];
}
// Estadísticas y avance al cerrar una etapa (sin frenar la respuesta si tarda)
async function refreshProgress(jobId) {
  try { await computeCoverage(jobId); } catch (e) { console.error('[cobertura] Trabajo ' + jobId + ':', e.message); }
}

// Iniciar el trabajo o una etapa nueva. Body: { at } (hora del celular, por si llega tarde desde la
// cola sin conexión) y { newStage: true } para cerrar una etapa vieja que quedó abierta y empezar otra.
router.post('/jobs/:id/start', requireRole('aplicador', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  if (req.user.role === 'aplicador' && job.applicator_id != null && Number(job.applicator_id) !== req.user.id) {
    return res.status(403).json({ error: 'Este trabajo no está asignado a vos' });
  }
  if (job.status !== 'pendiente' && job.status !== 'en_curso') {
    return res.status(400).json({ error: 'El trabajo ya está ' + job.status.replace('_', ' ') });
  }
  const body = req.body || {};
  const now = Date.now();
  let open = await openStageOf(job.id);
  if (open && !body.newStage) {
    return res.json({ ok: true, job: jobToJson(job), stage: stageToJson(open) });
  }
  // Una sola etapa abierta por aplicador: si dejó otra abierta (sin grabar), se cierra sola
  const appId = req.user.role === 'aplicador' ? req.user.id : (job.applicator_id != null ? Number(job.applicator_id) : null);
  const autoClosed = [];
  if (appId != null) {
    const { rows: others } = await db.query(
      `SELECT s.*, j.lot_name, j.paused_at FROM job_stages s JOIN jobs j ON j.id = s.job_id
        WHERE s.ended_at IS NULL AND s.job_id <> $1 AND j.deleted_at IS NULL AND j.status = 'en_curso'
          AND COALESCE(s.applicator_id, j.applicator_id) = $2`, [job.id, appId]);
    for (const o of others) {
      const last = await stageLastActivity(o, o.paused_at);
      if (!o.paused_at && now - last < RECORDING_RECENT_MS) {
        return res.status(409).json({ error: `Estás grabando otro trabajo (${o.lot_name || '#' + o.job_id}). Terminá esa etapa antes de empezar otra.` });
      }
      autoClosed.push({ jobId: Number(o.job_id), lotName: o.lot_name });
    }
    for (const o of others) {
      await endStage(o.job_id, new Date(await stageLastActivity(o, o.paused_at)), 'otro_trabajo');
      scheduleCoverage(Number(o.job_id), () => emitStages(o.job_id).catch(() => {}), 500);
      alerts.evaluateJob(Number(o.job_id)).catch(() => {});
    }
  }
  if (open) await endStage(job.id, new Date(await stageLastActivity(open, job.paused_at)), 'auto');
  const { rows: [prev] } = await db.query('SELECT max(ended_at) AS t FROM job_stages WHERE job_id = $1', [job.id]);
  const at = clampAt(body.at, Math.max(ms(prev.t) || 0, ms(job.created_at) || 0), now);
  const wasPending = job.status === 'pendiente';
  if (wasPending) {
    await db.query(
      `UPDATE jobs SET status = 'en_curso', started_at = COALESCE(started_at, $3),
                       applicator_id = COALESCE(applicator_id, $2)
        WHERE id = $1 AND status = 'pendiente'`,
      [job.id, req.user.role === 'aplicador' ? req.user.id : null, at]);
  }
  await db.query('UPDATE jobs SET paused_at = NULL WHERE id = $1', [job.id]);
  const { rows: ins } = await db.query(
    `INSERT INTO job_stages (job_id, seq, applicator_id, started_at)
     SELECT $1, COALESCE(max(seq), 0) + 1, $2, $3 FROM job_stages WHERE job_id = $1
     ON CONFLICT DO NOTHING RETURNING *`,
    [job.id, appId, at]);
  const stage = ins[0] || await openStageOf(job.id);
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
  if (wasPending) emitJob(job.id, 'status', { status: rows[0].status, job: jobToJson(rows[0]) });
  emitJob(job.id, 'stage', { job: jobToJson(rows[0]), stages: await loadStages(job.id) });
  alerts.evaluateJob(Number(job.id)).catch(e => console.error('[alertas]', e.message)); // ¿arrancó tarde?
  res.json({ ok: true, job: jobToJson(rows[0]), stage: stageToJson(stage), autoClosed });
}));

// Terminar la etapa de hoy sin finalizar el trabajo (queda en curso para seguir otro día)
router.post('/jobs/:id/stage-end', requireRole('aplicador', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res, { includeDeleted: true });
  if (!job) return;
  if (req.user.role === 'aplicador' && Number(job.applicator_id) !== req.user.id) {
    return res.status(403).json({ error: 'Este trabajo no está asignado a vos' });
  }
  if (job.status !== 'en_curso' || job.deleted_at) return res.json({ ok: true, ignored: true, status: job.status });
  const open = await openStageOf(job.id);
  if (!open) return res.json({ ok: true, ignored: true, job: jobToJson(job), stages: await loadStages(job.id) });
  const at = clampAt((req.body || {}).at, ms(open.started_at), Date.now());
  await endStage(job.id, at, 'aplicador');
  await refreshProgress(job.id);
  const row = await emitStages(job.id);
  alerts.evaluateJob(Number(job.id)).catch(e => console.error('[alertas]', e.message));
  const stages = await loadStages(job.id);
  res.json({ ok: true, job: jobToJson(row), stage: stages.find(x => x.id === Number(open.id)) || null, stages });
}));

// Reabrir un trabajo finalizado (supervisor): vuelve a en curso y se sigue en una etapa nueva
router.post('/jobs/:id/reopen', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  if (job.status !== 'finalizado') return res.status(400).json({ error: 'Sólo se pueden reabrir trabajos finalizados' });
  await db.query(
    `UPDATE jobs SET status = 'en_curso', finished_at = NULL, paused_at = NULL, reopened_at = now() WHERE id = $1 AND status = 'finalizado'`, [job.id]);
  await db.query(`UPDATE zones SET status = 'activa', closed_at = NULL WHERE id = $1`, [job.zone_id]);
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
  emitJob(job.id, 'status', { status: rows[0].status, job: jobToJson(rows[0]) });
  await alerts.evaluateJob(Number(job.id)).catch(e => console.error('[alertas]', e.message));
  res.json({ ok: true, job: jobToJson(rows[0]) });
}));

async function closeJob(job, status) {
  await db.query(`UPDATE jobs SET status = $2, finished_at = now() WHERE id = $1`, [job.id, status]);
  await closePauses(job.id, new Date());
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
  await endStage(job.id, new Date(), req.user.role === 'aplicador' ? 'finalizado' : 'finalizado_supervisor');
  await closeJob(job, 'finalizado');
  // Zona cubierta y avance final (quedan guardados para listas e informes)
  try { await computeCoverage(job.id); } catch (e) { console.error('[cobertura] Trabajo ' + job.id + ':', e.message); }
  const { rows } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
  emitJob(job.id, 'coverage', { job: jobToJson(rows[0], { detail: true }) });
  emitJob(job.id, 'stage', { job: jobToJson(rows[0]), stages: await loadStages(job.id) });
  // Alertas finales: tramos de ruta salteados y cierre de las abiertas
  try { await alerts.evaluateJob(Number(job.id)); } catch (e) { console.error('[alertas] Trabajo ' + job.id + ':', e.message); }
  res.json({ ok: true, job: jobToJson(rows[0], { detail: true }) });
}));

router.post('/jobs/:id/cancel', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  if (!['pendiente', 'en_curso'].includes(job.status)) {
    return res.status(400).json({ error: 'El trabajo ya está ' + job.status });
  }
  await endStage(job.id, new Date(), 'cancelado');
  const closed = await closeJob(job, 'cancelado');
  alerts.evaluateJob(Number(job.id)).catch(e => console.error('[alertas]', e.message));
  res.json({ ok: true, job: jobToJson(closed) });
}));

// Puntos GPS de un trabajo (desde el tracker del aplicador)
router.post('/jobs/:id/track', requireRole('aplicador', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res, { includeDeleted: true });
  if (!job) return;
  if (req.user.role === 'aplicador' && Number(job.applicator_id) !== req.user.id) {
    return res.status(403).json({ error: 'Este trabajo no está asignado a vos' });
  }
  const { points } = req.body || {};
  if (!points) return res.status(400).json({ error: 'Faltan puntos' });
  // Trabajo eliminado: se guardan sólo los puntos grabados antes de eliminarlo (cola offline), nada después
  const cutoff = job.deleted_at || (job.status === 'finalizado' ? job.finished_at : null);
  if (job.deleted_at && job.status === 'pendiente') return res.status(410).json({ error: 'Este trabajo fue eliminado por el supervisor', deleted: true });
  if (!job.deleted_at && job.status !== 'en_curso' && job.status !== 'finalizado') {
    return res.status(409).json({ error: job.status === 'pendiente' ? 'Iniciá el trabajo antes de enviar puntos' : 'El trabajo está cancelado' });
  }
  const p = parsePoints(points);
  let inserted = 0;
  // Puntos con mala precisión (configurable por el admin) no se guardan
  const maxAcc = (await alerts.getSettings()).gps.maxAccuracyM;
  const badAccuracy = p.accs.filter(a => a != null && a > maxAcc).length;
  if (p.count) {
    // Si el trabajo ya se finalizó, sólo se aceptan puntos grabados antes del cierre (envíos atrasados)
    // client_id: id generado en el celular; si la cola offline reenvía un punto, no se duplica
    const { rows } = await db.query(
      // Cada punto va a la etapa que lo contiene; los grabados fuera de una etapa (antes de empezarla
      // o entre etapas) se descartan. Trabajos sin etapas (muy viejos) aceptan todo como antes.
      `INSERT INTO track_points (job_id, zone_id, user_id, lat, lng, accuracy, speed, recorded_at, client_id, stage_id)
       SELECT $1, $2, $3, t.lat, t.lng, t.acc, t.speed, t.ts, t.cid, st.id
         FROM unnest($4::float8[], $5::float8[], $6::real[], $7::real[], $8::timestamptz[], $10::text[])
           AS t(lat, lng, acc, speed, ts, cid)
         LEFT JOIN LATERAL (
           SELECT s.id FROM job_stages s
            WHERE s.job_id = $1 AND s.started_at - ($12::float8 * interval '1 millisecond') <= t.ts
              AND (s.ended_at IS NULL OR t.ts <= s.ended_at)
            ORDER BY s.seq DESC LIMIT 1) st ON true
        WHERE ($9::timestamptz IS NULL OR t.ts <= $9::timestamptz)
          AND (st.id IS NOT NULL OR NOT $11::boolean)
          AND (t.acc IS NULL OR t.acc <= $13)
       ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING ${POINT_COLS}`,
      [job.id, job.zone_id, req.user.id, p.lats, p.lngs, p.accs, p.speeds, p.times,
       cutoff, p.clientIds, (job.stage_count || 0) > 0, STAGE_GRACE_MS, maxAcc]);
    inserted = rows.length;
    if (rows.length) emitJob(job.id, 'points', rows.map(pointJson));
    if (rows.length && !job.deleted_at) alerts.scheduleEvaluate(Number(job.id));
    // Puntos atrasados de un trabajo ya finalizado: recalcular la zona cubierta
    if (rows.length && job.status === 'finalizado' && !job.deleted_at) {
      scheduleCoverage(job.id, async () => {
        const { rows: r } = await db.query(`${JOB_SELECT} WHERE j.id = $1`, [job.id]);
        if (r[0]) emitJob(job.id, 'coverage', { job: jobToJson(r[0], { detail: true }) });
      });
    }
  }
  res.json({ ok: true, inserted, received: p.count, discardedAccuracy: badAccuracy || undefined, deleted: !!job.deleted_at || undefined });
}));

// Eliminar trabajo (borrado lógico): desaparece de las listas y del tracker, pero se conservan
// el trabajo, la zona y todos los puntos GPS en la base (deleted_at / deleted_by).
router.delete('/jobs/:id', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const job = await loadJob(req, res);
  if (!job) return;
  await db.query('UPDATE jobs SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL', [job.id, req.user.id]);
  await db.query(`UPDATE zones SET status = 'cerrada', closed_at = now() WHERE id = $1 AND status = 'activa'`, [job.zone_id]);
  await endStage(job.id, new Date(), 'eliminado');
  await closePauses(job.id, new Date());
  emitJob(job.id, 'deleted', { deleted: true, id: job.id });
  alerts.evaluateJob(Number(job.id)).catch(e => console.error('[alertas]', e.message));
  res.json({ ok: true, id: Number(job.id), wasStatus: job.status });
}));

module.exports = router;
