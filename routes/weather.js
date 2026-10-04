// Clima y ventana de aplicación: pronóstico por ubicación / trabajo, ubicaciones guardadas y reglas.
const express = require('express');
const db = require('../lib/db');
const { ah, requireAuth, requireRole } = require('../lib/auth');
const weather = require('../lib/weather');
const jw = require('../lib/job-weather');

const router = express.Router();
router.use('/weather', requireAuth);

const num = (v) => v === undefined || v === null || v === '' ? null : Number(v);
const staff = (u) => u.role === 'admin' || u.role === 'supervisor';

function locJson(r) {
  return { id: Number(r.id), name: r.name, lat: r.lat, lon: r.lon, notes: r.notes || null, saved: true };
}

// Saca lo que no hace falta para tarjetas chicas (tablero, formulario)
function compact(an, keepHours) {
  const out = { ...an };
  if (!keepHours) {
    const now = Date.now();
    out.hours = an.hours.filter(h => new Date(h.t).getTime() >= now - 3600e3 && new Date(h.t).getTime() < now + 36 * 3600e3);
  }
  return out;
}

// GET /api/weather?lat=&lon= | ?jobId= | ?locationId= | ?loc=general-roca  (&at=ISO &rainfastHours= &compact=1)
router.get('/weather', ah(async (req, res) => {
  const q = req.query;
  let lat = num(q.lat), lon = num(q.lon), place = null, job = null, rainfast = num(q.rainfastHours);
  if (q.jobId) {
    const id = parseInt(q.jobId, 10);
    job = Number.isFinite(id) ? await jw.jobPlace(id) : null;
    const visible = job && !job.deleted && (staff(req.user) || job.applicatorId === req.user.id || (job.applicatorId == null && job.status === 'pendiente'));
    if (!visible) return res.status(404).json({ error: 'Trabajo no encontrado' });
    if (job.lat == null) return res.status(400).json({ error: 'El trabajo no tiene una zona con ubicación' });
    lat = job.lat; lon = job.lon;
    place = { name: job.lotName || ('Trabajo #' + job.id), kind: 'job', jobId: job.id };
    if (rainfast == null && job.rainfastHours != null) rainfast = job.rainfastHours;
  } else if (!staff(req.user)) {
    return res.status(403).json({ error: 'No tenés permisos para esta acción' });
  } else if (q.locationId) {
    const { rows: [r] } = await db.query('SELECT * FROM weather_locations WHERE id = $1', [parseInt(q.locationId, 10) || 0]);
    if (!r) return res.status(404).json({ error: 'Ubicación no encontrada' });
    lat = r.lat; lon = r.lon; place = { name: r.name, kind: 'saved', id: Number(r.id) };
  } else if (q.loc) {
    const d = weather.DEFAULT_LOCATIONS.find(x => x.key === q.loc);
    if (!d) return res.status(404).json({ error: 'Ubicación no encontrada' });
    lat = d.lat; lon = d.lon; place = { name: d.name, kind: 'default', key: d.key };
  }
  if (lat == null || lon == null) {
    const d = weather.DEFAULT_LOCATIONS[0];
    lat = d.lat; lon = d.lon; place = { name: d.name, kind: 'default', key: d.key };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'Coordenadas inválidas' });
  }
  if (rainfast != null && (!Number.isFinite(rainfast) || rainfast < 0 || rainfast > 72)) rainfast = null;
  let at = q.at || null;
  if (!at && job && job.status === 'pendiente' && job.plannedStartAt && new Date(job.plannedStartAt).getTime() > Date.now() - 3600e3) at = job.plannedStartAt;
  let an;
  try {
    an = await weather.analyze(lat, lon, { rainfastHours: rainfast, at });
  } catch (e) {
    console.error('[clima]', e.message);
    return res.status(503).json({ error: 'No se pudo obtener el pronóstico en este momento. Probá de nuevo en unos minutos.' });
  }
  const out = q.compact ? compact(an) : an;
  out.place = place || { name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, kind: 'coords' };
  if (job) {
    out.job = { id: job.id, lotName: job.lotName, status: job.status, plannedStartAt: job.plannedStartAt, productName: job.productName,
      rainfastHours: job.rainfastHours };
    out.snapshots = await jw.listSnapshots(job.id);
  }
  res.set('Cache-Control', 'no-store');
  res.json(out);
}));

// Condiciones registradas al iniciar / cerrar etapas (historial del trabajo)
router.get('/weather/job/:id/snapshots', ah(async (req, res) => {
  const job = await jw.jobPlace(parseInt(req.params.id, 10) || 0);
  const visible = job && (staff(req.user) || job.applicatorId === req.user.id);
  if (!visible) return res.status(404).json({ error: 'Trabajo no encontrado' });
  res.json({ snapshots: await jw.listSnapshots(job.id) });
}));

// Ubicaciones: predeterminadas del Alto Valle, guardadas y lotes de trabajos pendientes / en curso
router.get('/weather/locations', ah(async (req, res) => {
  const defaults = weather.DEFAULT_LOCATIONS.map(d => ({ key: d.key, name: d.name, lat: d.lat, lon: d.lon }));
  if (!staff(req.user)) return res.json({ defaults: [], saved: [], jobs: [] });
  const { rows } = await db.query('SELECT * FROM weather_locations ORDER BY name, id');
  const { rows: jobs } = await db.query(
    `SELECT j.id, j.lot_name, j.status, j.planned_start_at, z.geometry
       FROM jobs j JOIN zones z ON z.id = j.zone_id
      WHERE j.deleted_at IS NULL AND j.status IN ('pendiente', 'en_curso')
      ORDER BY (j.status = 'en_curso') DESC, j.planned_start_at NULLS LAST, j.id DESC LIMIT 60`);
  res.json({
    defaults,
    saved: rows.map(locJson),
    jobs: jobs.map(j => ({ id: Number(j.id), lotName: j.lot_name, status: j.status, plannedStartAt: j.planned_start_at, ...(jw.centroidOf(j.geometry) || {}) }))
      .filter(j => j.lat != null)
  });
}));

router.post('/weather/locations', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const lat = num(b.lat), lon = num(b.lon);
  if (!name) return res.status(400).json({ error: 'Poné un nombre para la ubicación' });
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'Coordenadas inválidas' });
  }
  const { rows: [r] } = await db.query(
    'INSERT INTO weather_locations (name, lat, lon, notes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, lat, lon, b.notes ? String(b.notes).slice(0, 300) : null, req.user.id]);
  res.json({ ok: true, location: locJson(r) });
}));

router.delete('/weather/locations/:id', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM weather_locations WHERE id = $1', [parseInt(req.params.id, 10) || 0]);
  if (!rowCount) return res.status(404).json({ error: 'Ubicación no encontrada' });
  res.json({ ok: true });
}));

// Reglas de la ventana de aplicación (todos los que ven el clima las leen; sólo el admin las cambia)
router.get('/weather/settings', requireRole('supervisor', 'admin'), ah(async (req, res) => {
  res.json({ rules: await weather.getRules(), defaults: weather.RULE_DEFAULTS, limits: weather.RULE_LIMITS });
}));
router.put('/weather/settings', requireRole('admin'), ah(async (req, res) => {
  const r = await weather.saveRules((req.body || {}).rules || req.body || {}, req.user.id);
  if (r.errors) return res.status(400).json({ error: r.errors.join('. ') });
  res.json({ ok: true, rules: r.value });
}));

module.exports = router;
