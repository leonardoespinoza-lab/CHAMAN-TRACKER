// Helpers de trabajos de aplicación (formato JSON y validación de la fórmula).

function jobToJson(j) {
  if (!j) return null;
  const out = {
    id: Number(j.id),
    zoneId: Number(j.zone_id),
    applicatorId: j.applicator_id != null ? Number(j.applicator_id) : null,
    machine: j.machine, deviceId: j.device_id, lotName: j.lot_name,
    product: j.product, dose: j.dose != null ? Number(j.dose) : null, doseUnit: j.dose_unit,
    litersPerHa: j.liters_per_ha != null ? Number(j.liters_per_ha) : null,
    scheduledDate: j.scheduled_date, notes: j.notes,
    status: j.status,
    createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at
  };
  // Campos opcionales que vienen de JOINs
  if (j.applicator_username !== undefined) {
    out.applicator = j.applicator_id != null
      ? { id: Number(j.applicator_id), username: j.applicator_username, name: j.applicator_name }
      : null;
  }
  if (j.route !== undefined) {
    out.route = j.route || null;
    out.routeToleranceM = j.route_tolerance_m != null ? Number(j.route_tolerance_m) : null;
  }
  if (j.geometry !== undefined) out.geometry = j.geometry;
  if (j.point_count !== undefined) out.pointCount = j.point_count;
  if (j.last_point_at !== undefined) out.lastPointAt = j.last_point_at;
  return out;
}

// Datos del trabajo (fórmula, máquina, etc.). Los campos vacíos quedan en null.
function parseJobInput(input) {
  const j = (input && typeof input === 'object') ? input : {};
  const text = (v) => (v == null || v === '') ? null : String(v).trim().slice(0, 500) || null;
  const number = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
  return {
    machine: text(j.machine), deviceId: text(j.deviceId), lotName: text(j.lotName),
    product: text(j.product), dose: number(j.dose), doseUnit: text(j.doseUnit),
    litersPerHa: number(j.litersPerHa), scheduledDate: date(j.scheduledDate), notes: text(j.notes)
  };
}

const JOB_STATUSES = ['pendiente', 'en_curso', 'finalizado', 'cancelado'];
const DEFAULT_ROUTE_TOLERANCE_M = 10;
const MAX_ROUTE_LINES = 500;
const MAX_ROUTE_VERTICES = 20000;

// Normaliza el recorrido planificado a un MultiLineString GeoJSON.
// Acepta LineString, MultiLineString, Feature o FeatureCollection de líneas. null/'' = sin recorrido.
function parseRoute(input) {
  if (input == null || input === '') return { route: null };
  const lines = [];
  const collect = (g) => {
    if (!g || typeof g !== 'object') return false;
    if (g.type === 'Feature') return collect(g.geometry);
    if (g.type === 'FeatureCollection') return Array.isArray(g.features) && g.features.every(collect);
    if (g.type === 'LineString') { lines.push(g.coordinates); return true; }
    if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) { lines.push(...g.coordinates); return true; }
    return false;
  };
  if (!collect(input)) return { error: 'Recorrido inválido: tiene que ser una o varias líneas' };
  const valid = (c) => Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number' && typeof c[1] === 'number' &&
    Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;
  const clean = [];
  let vertices = 0;
  for (const line of lines) {
    if (!Array.isArray(line) || !line.every(valid)) return { error: 'Recorrido inválido: coordenadas fuera de rango' };
    const coords = line.map(c => [c[0], c[1]]);
    if (coords.length < 2) continue;
    clean.push(coords);
    vertices += coords.length;
  }
  if (!clean.length) return { route: null };
  if (clean.length > MAX_ROUTE_LINES) return { error: `El recorrido tiene demasiadas pasadas (máximo ${MAX_ROUTE_LINES})` };
  if (vertices > MAX_ROUTE_VERTICES) return { error: 'El recorrido tiene demasiados vértices' };
  return { route: { type: 'MultiLineString', coordinates: clean } };
}

// Tolerancia en metros (1 a 100). undefined = no se envió; null = usar el valor por defecto
function parseTolerance(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || v === '') return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 100) return { error: 'La tolerancia del recorrido tiene que estar entre 1 y 100 m' };
  return { value: n };
}

module.exports = { jobToJson, parseJobInput, parseRoute, parseTolerance, JOB_STATUSES, DEFAULT_ROUTE_TOLERANCE_M };
