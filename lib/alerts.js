// Alertas operativas del lado del servidor: evalúa los trabajos (cada 30 s, al recibir puntos,
// al iniciar/pausar/finalizar) y mantiene la tabla alerts. Es idempotente: cada evaluación
// recalcula los episodios a partir de los datos y los concilia con las alertas guardadas
// (una sola alerta abierta por tipo y trabajo; se cierran solas cuando termina la condición).
const db = require('./db');
const AC = require('../alerts-core');
const { RouteProgress } = require('../route-progress');
const { bus, emitJob } = require('./events');

const LEGACY_TOLERANCE_M = 10;
const LOOP_MS = Number(process.env.ALERTS_INTERVAL_MS) || 30000;
const INGEST_DELAY_MS = Number(process.env.ALERTS_INGEST_DELAY_MS) || 4000;
const MAX_EPISODES_PER_TYPE = 100;
const VOLATILE_UPDATE_MS = 30000;   // alertas abiertas: los números que cambian solos se guardan cada 30 s
const LOOP_LOCK_KEY = 727275;
const ms = (d) => d == null ? null : new Date(d).getTime();
const COVERAGE_EVERY_MS = Number(process.env.COVERAGE_INTERVAL_MS) || 60000; // avance en vivo (trabajos en curso)
// JSON con las claves ordenadas: jsonb no conserva el orden, así se comparan bien los detalles
function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// ---------- configuración ----------
let cache = null, cacheAt = 0;
async function getSettings() {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'alerts'");
  cache = AC.normalizeSettings(rows[0] && rows[0].value).value;
  cacheAt = Date.now();
  return cache;
}
async function saveSettings(input, userId) {
  const r = AC.normalizeSettings(input, true);
  if (r.errors.length) return { errors: r.errors };
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('alerts', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(r.value), userId]);
  cache = r.value; cacheAt = Date.now();
  return { value: r.value };
}
async function settingsInfo() {
  const { rows } = await db.query(
    "SELECT s.updated_at, u.name FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = 'alerts'");
  return { settings: await getSettings(), defaults: AC.DEFAULTS, limits: AC.LIMITS,
    updatedAt: rows[0] ? rows[0].updated_at : null, updatedBy: rows[0] ? rows[0].name : null };
}

// ---------- formato ----------
const ALERT_SELECT = `
  SELECT a.*, j.lot_name, j.status AS job_status, j.applicator_id,
         u.name AS applicator_name, u.username AS applicator_username, k.name AS ack_name
    FROM alerts a
    JOIN jobs j ON j.id = a.job_id
    LEFT JOIN users u ON u.id = j.applicator_id
    LEFT JOIN users k ON k.id = a.acknowledged_by`;
function alertToJson(r) {
  return {
    id: Number(r.id), jobId: Number(r.job_id), type: r.type, severity: r.severity,
    startedAt: r.started_at, resolvedAt: r.resolved_at, details: r.details || {},
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by != null ? { id: Number(r.acknowledged_by), name: r.ack_name } : null,
    job: r.lot_name !== undefined ? { id: Number(r.job_id), lotName: r.lot_name, status: r.job_status } : undefined,
    applicator: r.applicator_id != null ? { id: Number(r.applicator_id), name: r.applicator_name, username: r.applicator_username } : null,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}
async function loadAlert(id) {
  const { rows } = await db.query(`${ALERT_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? alertToJson(rows[0]) : null;
}
async function emitAlert(id, action) {
  const alert = await loadAlert(id);
  if (!alert) return;
  bus.emit('alerts', { action, alert });
  emitJob(alert.jobId, 'alert', { action, alert });
}
async function summary() {
  const { rows: [r] } = await db.query(`
    SELECT count(*) FILTER (WHERE a.resolved_at IS NULL)::int AS open,
           count(*) FILTER (WHERE a.resolved_at IS NULL AND a.severity = 'alta')::int AS open_high,
           count(*) FILTER (WHERE a.acknowledged_at IS NULL AND a.severity <> 'info')::int AS unseen
      FROM alerts a JOIN jobs j ON j.id = a.job_id
     WHERE j.deleted_at IS NULL`);
  return { open: r.open, openHigh: r.open_high, unseen: r.unseen };
}

function severityFor(type, ep, d) {
  if (type === 'velocidad') return d.maxKmh >= d.limitKmh * 1.5 ? 'alta' : 'media';
  if (type === 'sin_senal') return ep.ongoing ? 'alta' : (d.resolution === 'sin_conexion' ? 'info' : 'media');
  if (type === 'ruta_incompleta') return d.routePct < 70 ? 'alta' : 'media';
  return 'media';
}

// ---------- evaluación ----------
// Una evaluación por trabajo a la vez (el ciclo y la recepción de puntos no se pisan)
const chains = new Map();
function evaluateJob(jobId) {
  const prev = chains.get(jobId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => doEvaluate(jobId));
  chains.set(jobId, next);
  next.catch(() => {}).finally(() => { if (chains.get(jobId) === next) chains.delete(jobId); });
  return next;
}
const pendingEval = new Map();
function scheduleEvaluate(jobId, delay = INGEST_DELAY_MS) {
  if (pendingEval.has(jobId)) return;
  pendingEval.set(jobId, setTimeout(() => {
    pendingEval.delete(jobId);
    evaluateJob(jobId).catch(e => console.error('[alertas] Trabajo ' + jobId + ':', e.message));
  }, delay));
}

async function insertAlert(jobId, type, severity, start, end, details, changes) {
  const { rows } = await db.query(
    `INSERT INTO alerts (job_id, type, severity, started_at, resolved_at, details)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id, type) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
    [jobId, type, severity, new Date(start), end == null ? null : new Date(end), JSON.stringify(details)]);
  if (rows[0]) changes.push([rows[0].id, 'created']);
}
async function updateAlert(a, next, changes, force) {
  const same = ms(a.started_at) === next.start && ms(a.resolved_at) === next.end && a.severity === next.severity;
  const sameDetails = stableJson(a.details || {}) === stableJson(JSON.parse(JSON.stringify(next.details || {})));
  if (same && sameDetails) return;
  // Alerta abierta en la que sólo cambian los números (minutos, duración): guardar cada tanto
  if (!force && same && next.end == null && Date.now() - ms(a.updated_at) < VOLATILE_UPDATE_MS) return;
  try {
    await db.query(
      `UPDATE alerts SET started_at = $2, resolved_at = $3, severity = $4, details = $5, updated_at = now() WHERE id = $1`,
      [a.id, new Date(next.start), next.end == null ? null : new Date(next.end), next.severity, JSON.stringify(next.details)]);
    changes.push([a.id, a.resolved_at == null && next.end != null ? 'resolved' : 'updated']);
  } catch (e) {
    if (e.code !== '23505') throw e; // ya hay otra abierta del mismo tipo: se deja como está
  }
}

// Concilia los episodios calculados con las alertas guardadas de un tipo
async function reconcile(job, type, episodes, alerts, ctx, changes) {
  const used = new Set();
  for (const e of episodes.slice(-MAX_EPISODES_PER_TYPE)) {
    const eEnd = e.end == null ? Infinity : e.end;
    const match = alerts.find(a => !used.has(a.id) && ms(a.started_at) <= eEnd + 1000 &&
      (a.resolved_at == null ? Infinity : ms(a.resolved_at)) >= e.start - 1000);
    const details = { ...e.details };
    if (e.end != null && type === 'sin_senal') details.resolution = 'gps';
    if (e.end != null && type === 'parada') {
      // La parada terminó porque cerró la etapa del día (no porque pausó el GPS)
      if (e.details.endedBy === 'pausa' && ctx.stageGaps.some(g => Math.abs(g.start - e.end) < 2000 || (e.end >= g.start && (g.end == null || e.end <= g.end)))) details.endedBy = 'etapa';
      details.resolution = details.endedBy;
    }
    const severity = severityFor(type, e, details);
    if (match) {
      used.add(match.id);
      await updateAlert(match, { start: e.start, end: e.end, severity, details }, changes);
    } else {
      await insertAlert(job.id, type, severity, e.start, e.end, details, changes);
    }
  }
  // Abiertas que ya no corresponden a ningún episodio: la condición terminó
  for (const a of alerts) {
    if (used.has(a.id) || a.resolved_at != null) continue;
    const details = { ...a.details };
    if (type === 'sin_senal') {
      const t0 = ms(a.started_at);
      const pausedAfter = ctx.pauses.some(p => p.start >= t0 - 1000) || job.paused_at;
      // Llegaron los puntos atrasados de la cola sin conexión (grabados con su hora): no fue falta de GPS
      const backfilled = ctx.points.filter(p => p.t >= t0 && p.rt - p.t > 60000).length;
      details.resolution = backfilled ? 'sin_conexion' : (pausedAfter || ctx.pausedNow ? 'pausa' : 'normal');
      details.backfilled = backfilled;
    } else if (type === 'parada') details.resolution = ctx.betweenStages ? 'etapa' : (job.paused_at ? 'pausa' : 'movimiento');
    else if (type === 'no_inicio') details.resolution = job.status === 'pendiente' ? 'reprogramado' : 'a_tiempo';
    else details.resolution = 'normal';
    const sev = type === 'sin_senal' && details.resolution !== 'gps' ? 'info' : a.severity;
    await updateAlert(a, { start: ms(a.started_at), end: ctx.now, severity: sev, details }, changes, true);
  }
}

async function doEvaluate(jobId) {
  const { rows: [job] } = await db.query(
    `SELECT id, status, started_at, finished_at, planned_start_at, paused_at, deleted_at, route, route_tolerance_m, speed_limit_kmh
       FROM jobs WHERE id = $1`, [jobId]);
  if (!job) return [];
  const { rows: existing } = await db.query('SELECT * FROM alerts WHERE job_id = $1 ORDER BY started_at, id', [jobId]);
  const changes = [];
  const now = Date.now();

  if (job.deleted_at || job.status === 'cancelado') {
    // Trabajo eliminado o cancelado: se cierran las alertas abiertas
    const reason = job.deleted_at ? 'eliminado' : 'cancelado';
    const when = ms(job.deleted_at) || ms(job.finished_at) || now;
    for (const a of existing.filter(x => x.resolved_at == null)) {
      await updateAlert(a, { start: ms(a.started_at), end: Math.max(when, ms(a.started_at)), severity: a.severity, details: { ...a.details, resolution: reason } }, changes, true);
    }
  } else {
    // Velocidad máxima propia del trabajo (método de aplicación) si la tiene
    const cfg = JSON.parse(JSON.stringify(await getSettings()));
    cfg.speed.maxKmh = AC.jobSpeedLimit(job, cfg);
    const { rows: pz } = await db.query('SELECT paused_at, resumed_at FROM job_pauses WHERE job_id = $1 ORDER BY paused_at', [jobId]);
    const pauses = pz.map(p => ({ start: ms(p.paused_at), end: ms(p.resumed_at) }));
    // Entre etapas (cerró la etapa del día y todavía no empezó otra) es como una pausa larga:
    // no hay alertas de parada ni de falta de señal
    const { rows: stg } = await db.query('SELECT started_at, ended_at FROM job_stages WHERE job_id = $1 ORDER BY seq', [jobId]);
    const stageGaps = [];
    stg.forEach((st, i) => {
      if (st.ended_at == null) return;
      const next = stg[i + 1];
      if (next) stageGaps.push({ start: ms(st.ended_at), end: Math.max(ms(st.ended_at), ms(next.started_at)) });
      else if (job.status === 'en_curso') stageGaps.push({ start: ms(st.ended_at), end: null });
    });
    pauses.push(...stageGaps);
    pauses.sort((a, b) => a.start - b.start);
    const betweenStages = job.status === 'en_curso' && stg.length > 0 && !stg.some(st => st.ended_at == null);
    let points = [];
    if (job.started_at) {
      const { rows } = await db.query(
        `SELECT recorded_at, received_at, lat, lng, speed, accuracy FROM track_points
          WHERE job_id = $1 AND cleared_at IS NULL ORDER BY recorded_at, id LIMIT 200000`, [jobId]);
      points = rows.map(r => ({ t: ms(r.recorded_at), rt: ms(r.received_at), lat: r.lat, lng: r.lng, speed: r.speed, acc: r.accuracy }));
    }
    const info = { status: job.status, startedAt: ms(job.started_at), finishedAt: ms(job.finished_at),
      plannedStartAt: ms(job.planned_start_at), pausedNow: !!job.paused_at || betweenStages };
    const eps = AC.analyze(info, points, pauses, cfg, now);
    const ctx = { points, pauses, now, stageGaps, betweenStages, pausedNow: info.pausedNow };
    for (const type of ['velocidad', 'parada', 'sin_senal', 'no_inicio']) {
      await reconcile(job, type, eps[type], existing.filter(a => a.type === type), ctx, changes);
    }
    // Al finalizar: tramos de la ruta salteados
    if (job.status === 'finalizado' && job.route) {
      const rp = new RouteProgress(job.route, job.route_tolerance_m || LEGACY_TOLERANCE_M);
      if (!rp.empty) rp.setTrack(points.map(p => [p.lng, p.lat]));
      const rc = AC.routeCheck(rp, cfg);
      const cur = existing.filter(a => a.type === 'ruta_incompleta');
      const open = cur.find(a => a.resolved_at == null);
      if (rc && rc.trigger) {
        const severity = severityFor('ruta_incompleta', {}, rc.details);
        if (open) await updateAlert(open, { start: ms(open.started_at), end: null, severity, details: rc.details }, changes, true);
        // Una por cierre: si se reabrió y se volvió a finalizar, va una nueva
        else if (!cur.some(a => ms(a.started_at) >= (ms(job.finished_at) || now) - 1000)) {
          await insertAlert(job.id, 'ruta_incompleta', severity, ms(job.finished_at) || now, null, rc.details, changes);
        }
      } else if (open) {
        await updateAlert(open, { start: ms(open.started_at), end: now, severity: open.severity,
          details: { ...(rc ? rc.details : open.details), resolution: rc ? 'completada' : 'desactivada' } }, changes, true);
      }
    } else if (job.status === 'en_curso') {
      // Trabajo reabierto: el control de ruta se vuelve a hacer al finalizar de nuevo
      for (const a of existing.filter(x => x.type === 'ruta_incompleta' && x.resolved_at == null)) {
        await updateAlert(a, { start: ms(a.started_at), end: now, severity: a.severity, details: { ...a.details, resolution: 'reabierto' } }, changes, true);
      }
    }
  }
  for (const [id, action] of changes) await emitAlert(id, action).catch(() => {});
  return changes;
}

// ---------- visto ----------
// Las alertas que no se cierran solas (tramos salteados al finalizar) se cierran al marcarlas como vistas
async function acknowledge(ids, userId) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `UPDATE alerts SET acknowledged_by = $2, acknowledged_at = now(), updated_at = now(),
            resolved_at = CASE WHEN type = 'ruta_incompleta' AND resolved_at IS NULL THEN now() ELSE resolved_at END,
            details = CASE WHEN type = 'ruta_incompleta' AND resolved_at IS NULL THEN details || '{"resolution":"visto"}'::jsonb ELSE details END
      WHERE id = ANY($1::bigint[]) AND acknowledged_at IS NULL RETURNING id`, [ids, userId]);
  for (const r of rows) await emitAlert(r.id, 'ack').catch(() => {});
  return rows.map(r => Number(r.id));
}

// ---------- ciclo periódico ----------
let ticking = false;
async function tick() {
  if (ticking || !db.isReady()) return;
  ticking = true;
  let client;
  try {
    client = await db.getPool().connect();
    // Si hubiera dos instancias (p. ej. durante un redeploy), evalúa una sola
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOOP_LOCK_KEY]);
    if (!lock.ok) return;
    try {
      const cfg = await getSettings();
      const { rows } = await client.query(
        `SELECT id FROM jobs
          WHERE deleted_at IS NULL AND (status = 'en_curso'
             OR (status = 'pendiente' AND planned_start_at IS NOT NULL AND planned_start_at < now() - ($1::float8 * interval '1 minute')))
         UNION
         SELECT DISTINCT job_id FROM alerts WHERE resolved_at IS NULL AND type <> 'ruta_incompleta'`, [cfg.lateStart.minutes]);
      for (const r of rows) {
        await evaluateJob(Number(r.id)).catch(e => console.error('[alertas] Trabajo ' + r.id + ':', e.message));
      }
      await liveProgress(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOOP_LOCK_KEY]).catch(() => {});
    }
  } catch (e) {
    console.error('[alertas] Error en el ciclo:', e.message);
  } finally {
    if (client) client.release();
    ticking = false;
  }
}
// Avance de ruta y zona cubierta en vivo: cada ~1 min para los trabajos en curso con puntos nuevos,
// así la API y las listas muestran los % mientras se trabaja
let lastLive = 0;
async function liveProgress(client) {
  if (Date.now() - lastLive < COVERAGE_EVERY_MS - 1000) return;
  lastLive = Date.now();
  const { computeCoverage } = require('./coverage');
  const { rows } = await client.query(
    `SELECT j.id FROM jobs j
      WHERE j.deleted_at IS NULL AND j.status = 'en_curso'
        AND (j.covered_at IS NULL OR EXISTS (SELECT 1 FROM track_points t WHERE t.job_id = j.id AND t.received_at > j.covered_at))
      LIMIT 50`);
  for (const r of rows) {
    try {
      await computeCoverage(Number(r.id));
      const { rows: st } = await client.query(
        `SELECT s.*, u.name AS applicator_name, u.username AS applicator_username FROM job_stages s
           LEFT JOIN users u ON u.id = s.applicator_id WHERE s.job_id = $1 ORDER BY s.seq`, [r.id]);
      const { rows: [j] } = await client.query('SELECT route_pct, coverage_pct FROM jobs WHERE id = $1', [r.id]);
      const { stageToJson } = require('./jobs');
      emitJob(Number(r.id), 'stage', { progress: { routePct: j.route_pct != null ? Number(j.route_pct) : null,
        coveragePct: j.coverage_pct != null ? Number(j.coverage_pct) : null }, stages: st.map(stageToJson) });
    } catch (e) { console.error('[cobertura] Trabajo ' + r.id + ':', e.message); }
  }
}

let loop = null;
function startLoop() {
  if (loop) return;
  loop = setInterval(tick, LOOP_MS);
  loop.unref();
  setTimeout(tick, 5000).unref();
}

module.exports = { getSettings, saveSettings, settingsInfo, evaluateJob, scheduleEvaluate, acknowledge, summary,
  alertToJson, loadAlert, ALERT_SELECT, tick, startLoop };
