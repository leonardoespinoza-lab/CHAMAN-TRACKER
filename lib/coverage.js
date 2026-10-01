// Zona cubierta y avance final de un trabajo: se calculan al finalizar (y si llegan puntos
// atrasados de la cola offline) y quedan guardados para listas e informes.
const db = require('./db');
const ZoneGeo = require('../zone-geo');
const { RouteProgress } = require('../route-progress');

const LEGACY_TOLERANCE_M = 10;

async function computeCoverage(jobId) {
  const { rows: [job] } = await db.query(
    `SELECT j.id, j.route, j.route_tolerance_m, j.pass_width_m, z.geometry
       FROM jobs j JOIN zones z ON z.id = j.zone_id WHERE j.id = $1`, [jobId]);
  if (!job) return null;
  const { rows: pts } = await db.query(
    `SELECT lat, lng FROM track_points WHERE job_id = $1 AND cleared_at IS NULL
      ORDER BY recorded_at, id LIMIT 200000`, [jobId]);
  const coords = pts.map(p => [p.lng, p.lat]);
  const width = ZoneGeo.clampWidth(job.pass_width_m);
  const cov = ZoneGeo.coveredZone(coords, width, job.geometry);
  let routePct = null;
  if (job.route) {
    const rp = new RouteProgress(job.route, job.route_tolerance_m || LEGACY_TOLERANCE_M);
    if (!rp.empty) { rp.setTrack(coords); routePct = rp.summary().pct; }
  }
  await db.query(
    `UPDATE jobs SET covered_geometry = $2, coverage_pct = $3, route_pct = $4, covered_at = now() WHERE id = $1`,
    [jobId, cov.geometry ? JSON.stringify(cov.geometry) : null, coords.length >= 2 ? cov.pct : 0, routePct]);
  return { coveragePct: cov.pct, routePct };
}

// Recalcular más tarde (puntos atrasados): agrupa varios envíos seguidos
const pending = new Map();
function scheduleCoverage(jobId, onDone) {
  if (pending.has(jobId)) return;
  pending.set(jobId, setTimeout(async () => {
    pending.delete(jobId);
    try {
      const r = await computeCoverage(jobId);
      if (r && onDone) onDone(r);
    } catch (e) {
      console.error('[cobertura] Error recalculando el trabajo ' + jobId + ':', e.message);
    }
  }, 3000));
}

module.exports = { computeCoverage, scheduleCoverage };
