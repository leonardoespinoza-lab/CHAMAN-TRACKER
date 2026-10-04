// Clima de un trabajo: ubicación (centroide del lote), horas sin lluvia del producto y registro de
// condiciones al iniciar / cerrar etapas (trazabilidad para el historial y los informes).
const turf = require('@turf/turf');
const db = require('./db');
const weather = require('./weather');

// Centroide de la zona (GeoJSON en lng/lat) → { lat, lon }
function centroidOf(geometry) {
  try {
    if (!geometry || !geometry.type) return null;
    const c = turf.centroid(geometry).geometry.coordinates;
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
    return { lat: c[1], lon: c[0] };
  } catch (e) { return null; }
}

async function jobPlace(jobId) {
  const { rows: [r] } = await db.query(
    `SELECT j.id, j.lot_name, j.status, j.planned_start_at, j.started_at, j.applicator_id, j.deleted_at, j.product_id,
            z.geometry, p.name AS product_name, p.rainfast_hours,
            (SELECT json_agg(c.geometry) FROM job_cuadros jc JOIN cuadros c ON c.id = jc.cuadro_id
              WHERE jc.job_id = j.id AND c.geometry IS NOT NULL) AS cuadro_geoms
       FROM jobs j JOIN zones z ON z.id = j.zone_id LEFT JOIN products p ON p.id = j.product_id
      WHERE j.id = $1`, [jobId]);
  if (!r) return null;
  // Con cuadros cargados, el clima se toma en el centro de los cuadros; si no, en el centro de la zona
  let c = null;
  if (Array.isArray(r.cuadro_geoms) && r.cuadro_geoms.length) {
    c = centroidOf({ type: 'GeometryCollection', geometries: r.cuadro_geoms });
  }
  if (!c) c = centroidOf(r.geometry);
  return {
    id: Number(r.id), lotName: r.lot_name, status: r.status, plannedStartAt: r.planned_start_at, startedAt: r.started_at,
    applicatorId: r.applicator_id != null ? Number(r.applicator_id) : null, deleted: !!r.deleted_at,
    productName: r.product_name || null, rainfastHours: r.rainfast_hours != null ? Number(r.rainfast_hours) : null,
    lat: c ? c.lat : null, lon: c ? c.lon : null
  };
}

function snapshotJson(r) {
  return {
    id: Number(r.id), stageId: r.stage_id != null ? Number(r.stage_id) : null, kind: r.kind, recordedAt: r.recorded_at,
    lat: r.lat, lon: r.lon, temp: r.temp, rh: r.rh, dew: r.dew, wind: r.wind, gust: r.gust, dir: r.wind_dir,
    cardinal: weather.cardinal(r.wind_dir), precip: r.precip, prob: r.precip_prob, deltaT: r.delta_t, status: r.status,
    reasons: r.reasons || [], source: r.source
  };
}

async function listSnapshots(jobId) {
  const { rows } = await db.query('SELECT * FROM job_weather WHERE job_id = $1 ORDER BY recorded_at, id', [jobId]);
  return rows.map(snapshotJson);
}

// Guarda las condiciones del momento (no frena la respuesta; si el pronóstico falla, no se guarda nada)
async function recordSnapshot(jobId, stageId, kind, at) {
  try {
    if (process.env.WEATHER_DISABLED === '1') return null;
    // Si el evento llega tarde desde la cola sin conexión, el pronóstico "de ahora" ya no sirve
    if (at && Math.abs(Date.now() - new Date(at).getTime()) > 2 * 3600e3) return null;
    const place = await jobPlace(jobId);
    if (!place || place.lat == null) return null;
    const an = await weather.analyze(place.lat, place.lon, { rainfastHours: place.rainfastHours });
    const s = weather.snapshotFrom(an);
    if (!s) return null;
    const { rows: [r] } = await db.query(
      `INSERT INTO job_weather (job_id, stage_id, kind, lat, lon, temp, rh, dew, wind, gust, wind_dir, precip, precip_prob, delta_t, status, reasons, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [jobId, stageId || null, kind, place.lat, place.lon, s.temp, s.rh, s.dew, s.wind, s.gust, s.dir, s.precip, s.prob, s.deltaT,
        s.status, JSON.stringify(s.reasons || []), s.source]);
    return snapshotJson(r);
  } catch (e) {
    console.error('[clima] Registro del trabajo ' + jobId + ':', e.message);
    return null;
  }
}

module.exports = { centroidOf, jobPlace, listSnapshots, recordSnapshot, snapshotJson };
