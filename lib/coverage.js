// Zona cubierta y avance de un trabajo: se calculan al finalizar, cada tanto mientras está en curso
// (para listas y API en vivo) y si llegan puntos atrasados de la cola offline. Quedan guardados
// para listas e informes. De paso se calculan las estadísticas de cada etapa.
const db = require('./db');
const ZoneGeo = require('../zone-geo');
const { RouteProgress } = require('../route-progress');

const LEGACY_TOLERANCE_M = 10;
const MAX_STEP_M = 60; // saltos mayores no suman distancia (señal perdida, otra etapa)

function stepM(a, b) {
  const kx = 111320 * Math.cos(a[1] * Math.PI / 180), ky = 110540;
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
}

// Estadísticas por etapa: puntos, distancia y avance de ruta acumulado antes/después de cada una
async function stageStats(job, pts) {
  const { rows: stages } = await db.query('SELECT id, seq FROM job_stages WHERE job_id = $1 ORDER BY seq', [job.id]);
  if (!stages.length) return [];
  const rp = job.route ? new RouteProgress(job.route, job.route_tolerance_m || LEGACY_TOLERANCE_M) : null;
  const order = new Map(stages.map((s, i) => [String(s.id), i]));
  // Puntos ordenados por etapa y hora (las etapas no se superponen en el tiempo)
  const sorted = pts.filter(p => p.stage_id != null && order.has(String(p.stage_id)))
    .sort((a, b) => order.get(String(a.stage_id)) - order.get(String(b.stage_id)) || a.t - b.t);
  const cum = [];
  let k = 0;
  const out = [];
  for (const s of stages) {
    const before = rp && !rp.empty ? rp.summary().pct : null;
    let dist = 0, n = 0, prev = null;
    while (k < sorted.length && String(sorted[k].stage_id) === String(s.id)) {
      const c = [sorted[k].lng, sorted[k].lat];
      if (prev) { const d = stepM(prev, c); if (d <= MAX_STEP_M) dist += d; }
      prev = c; cum.push(c); n++; k++;
    }
    if (rp && !rp.empty) rp.setTrack(cum);
    const after = rp && !rp.empty ? rp.summary().pct : null;
    out.push({ id: s.id, distance: dist, points: n, before, after });
  }
  for (const s of out) {
    await db.query(
      `UPDATE job_stages SET distance_m = $2, point_count = $3, route_pct_start = $4, route_pct_end = $5, stats_at = now() WHERE id = $1`,
      [s.id, s.distance, s.points, s.before, s.after]);
  }
  return out;
}

async function computeCoverage(jobId) {
  const { rows: [job] } = await db.query(
    `SELECT j.id, j.route, j.route_tolerance_m, j.pass_width_m, z.geometry
       FROM jobs j JOIN zones z ON z.id = j.zone_id WHERE j.id = $1`, [jobId]);
  if (!job) return null;
  const { rows: pts } = await db.query(
    `SELECT lat, lng, stage_id, recorded_at FROM track_points WHERE job_id = $1 AND cleared_at IS NULL
      ORDER BY recorded_at, id LIMIT 200000`, [jobId]);
  for (const p of pts) p.t = p.recorded_at.getTime();
  // Orden: etapa y hora (igual que las estadísticas por etapa: los totales coinciden con la suma)
  const { rows: stg } = await db.query('SELECT id, seq FROM job_stages WHERE job_id = $1', [jobId]);
  if (stg.length > 1) {
    const seq = new Map(stg.map(s => [String(s.id), s.seq]));
    const key = (p) => p.stage_id != null && seq.has(String(p.stage_id)) ? seq.get(String(p.stage_id)) : 0;
    pts.sort((a, b) => key(a) - key(b) || a.t - b.t);
  }
  const coords = pts.map(p => [p.lng, p.lat]);
  const width = ZoneGeo.clampWidth(job.pass_width_m);
  // Zona cubierta por etapa (sin unir el final de una etapa con el comienzo de la siguiente)
  const groups = [];
  let cur = null, prevStage;
  for (const p of pts) {
    if (!cur || (p.stage_id != null && prevStage != null && String(p.stage_id) !== String(prevStage))) { cur = []; groups.push(cur); }
    cur.push([p.lng, p.lat]);
    if (p.stage_id != null) prevStage = p.stage_id;
  }
  const cov = ZoneGeo.coveredZone(groups.length > 1 ? groups : coords, width, job.geometry);
  let routePct = null;
  if (job.route) {
    const rp = new RouteProgress(job.route, job.route_tolerance_m || LEGACY_TOLERANCE_M);
    if (!rp.empty) { rp.setTrack(coords); routePct = rp.summary().pct; }
  }
  await db.query(
    `UPDATE jobs SET covered_geometry = $2, coverage_pct = $3, route_pct = $4, covered_at = now() WHERE id = $1`,
    [jobId, cov.geometry ? JSON.stringify(cov.geometry) : null, coords.length >= 2 ? cov.pct : 0, routePct]);
  try { await stageStats(job, pts); } catch (e) { console.error('[etapas] Trabajo ' + jobId + ':', e.message); }
  // Consumo de producto (stock): con las etapas cerradas o el trabajo terminado
  try { await require('./gestion').afterCoverage(jobId); } catch (e) { console.error('[stock] Trabajo ' + jobId + ':', e.message); }
  return { coveragePct: cov.pct, routePct };
}

// Sólo las estadísticas de las etapas (sin tocar la zona cubierta guardada)
async function computeStageStats(jobId) {
  const { rows: [job] } = await db.query('SELECT id, route, route_tolerance_m FROM jobs WHERE id = $1', [jobId]);
  if (!job) return [];
  const { rows: pts } = await db.query(
    `SELECT lat, lng, stage_id, recorded_at FROM track_points WHERE job_id = $1 AND cleared_at IS NULL
      ORDER BY recorded_at, id LIMIT 200000`, [jobId]);
  for (const p of pts) p.t = p.recorded_at.getTime();
  return stageStats(job, pts);
}

// Recalcular más tarde (puntos atrasados): agrupa varios envíos seguidos
const pending = new Map();
function scheduleCoverage(jobId, onDone, delay = 3000) {
  if (pending.has(jobId)) return;
  pending.set(jobId, setTimeout(async () => {
    pending.delete(jobId);
    try {
      const r = await computeCoverage(jobId);
      if (r && onDone) onDone(r);
    } catch (e) {
      console.error('[cobertura] Error recalculando el trabajo ' + jobId + ':', e.message);
    }
  }, delay));
}

module.exports = { computeCoverage, scheduleCoverage, computeStageStats };
