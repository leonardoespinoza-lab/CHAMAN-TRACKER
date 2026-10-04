// Alerta "clima": trabajo pendiente cuyo inicio programado cae en una hora "No apta" según el pronóstico.
// Corre cada 30 min (con lock para que haya una sola instancia) y usa el caché del pronóstico.
const db = require('./db');
const weather = require('./weather');
const jw = require('./job-weather');
const { emitJob, bus } = require('./events');

const LOOP_MS = Number(process.env.WEATHER_ALERTS_INTERVAL_MS) || 30 * 60 * 1000;
const LOCK_KEY = 727276;

async function emit(id, action) {
  const alerts = require('./alerts');
  const alert = await alerts.loadAlert(id);
  if (!alert) return;
  bus.emit('alerts', { action, alert });
  emitJob(alert.jobId, 'alert', { action, alert });
}

async function resolveOpen(jobId, resolution) {
  const { rows } = await db.query(
    `UPDATE alerts SET resolved_at = now(), updated_at = now(), details = details || $2::jsonb
      WHERE job_id = $1 AND type = 'clima' AND resolved_at IS NULL RETURNING id`, [jobId, JSON.stringify({ resolution })]);
  for (const r of rows) await emit(r.id, 'resolved').catch(() => {});
}

async function evaluate(job, cfg) {
  const place = await jw.jobPlace(job.id);
  if (!place || place.lat == null) return;
  const an = await weather.analyze(place.lat, place.lon, { rainfastHours: place.rainfastHours, at: job.planned_start_at });
  const ev = an.at;
  if (!ev || ev.outOfRange) return;
  const { rows: [open] } = await db.query("SELECT * FROM alerts WHERE job_id = $1 AND type = 'clima' AND resolved_at IS NULL", [job.id]);
  if (ev.status === 'no_apta') {
    const details = {
      at: new Date(job.planned_start_at).getTime(), status: ev.status, reasons: (ev.reasons || []).map(r => r.text),
      nextWindow: ev.nextWindow ? { start: ev.nextWindow.start, end: ev.nextWindow.end } : null, provider: an.source.provider
    };
    if (open) {
      if (JSON.stringify(open.details.reasons) !== JSON.stringify(details.reasons) || open.details.at !== details.at) {
        await db.query('UPDATE alerts SET details = $2, updated_at = now() WHERE id = $1', [open.id, JSON.stringify(details)]);
        await emit(open.id, 'updated').catch(() => {});
      }
    } else {
      const { rows } = await db.query(
        `INSERT INTO alerts (job_id, type, severity, started_at, details) VALUES ($1, 'clima', 'media', now(), $2)
         ON CONFLICT (job_id, type) WHERE resolved_at IS NULL DO NOTHING RETURNING id`, [job.id, JSON.stringify(details)]);
      if (rows[0]) await emit(rows[0].id, 'created').catch(() => {});
    }
  } else if (open) {
    await resolveOpen(job.id, open.details.at !== new Date(job.planned_start_at).getTime() ? 'reprogramado' : 'mejoro');
  }
}

let running = false;
async function tick() {
  if (running || !db.isReady() || process.env.WEATHER_DISABLED === '1') return;
  running = true;
  let client;
  try {
    client = await db.getPool().connect();
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!lock.ok) return;
    try {
      const alerts = require('./alerts');
      const cfg = (await alerts.getSettings()).weather;
      // Alertas abiertas de trabajos que ya arrancaron, se cancelaron o se reprogramaron lejos
      const { rows: stale } = await client.query(
        `SELECT a.job_id, j.status, j.deleted_at, j.planned_start_at FROM alerts a JOIN jobs j ON j.id = a.job_id
          WHERE a.type = 'clima' AND a.resolved_at IS NULL`);
      for (const s of stale) {
        if (!cfg.enabled) await resolveOpen(Number(s.job_id), 'desactivada');
        else if (s.deleted_at || s.status !== 'pendiente') await resolveOpen(Number(s.job_id), s.status === 'pendiente' ? 'eliminado' : (s.status === 'cancelado' ? 'cancelado' : 'inicio'));
        else if (!s.planned_start_at || new Date(s.planned_start_at).getTime() > Date.now() + cfg.hoursAhead * 3600e3) await resolveOpen(Number(s.job_id), 'reprogramado');
      }
      if (!cfg.enabled) return;
      const { rows } = await client.query(
        `SELECT id, planned_start_at FROM jobs
          WHERE deleted_at IS NULL AND status = 'pendiente' AND planned_start_at IS NOT NULL
            AND planned_start_at > now() - interval '1 hour' AND planned_start_at < now() + ($1::float8 * interval '1 hour')
          ORDER BY planned_start_at LIMIT 40`, [cfg.hoursAhead]);
      for (const j of rows) {
        await evaluate({ id: Number(j.id), planned_start_at: j.planned_start_at }, cfg).catch(e => console.error('[clima] Alerta trabajo ' + j.id + ':', e.message));
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    }
  } catch (e) {
    console.error('[clima] Error en el ciclo de alertas:', e.message);
  } finally {
    if (client) client.release();
    running = false;
  }
}

let loop = null;
function startLoop() {
  if (loop) return;
  loop = setInterval(tick, LOOP_MS);
  loop.unref();
  setTimeout(tick, 20000).unref();
}

module.exports = { tick, startLoop, evaluate, resolveOpen };
