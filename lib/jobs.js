// Helpers de trabajos de aplicación (formato JSON y validación de la fórmula).
const TOX_COLORS = { Ia: 'rojo', Ib: 'rojo', II: 'amarillo', III: 'azul', IV: 'verde' };
const Chacras = require('../chacras-core');

// Cuadros del trabajo (JOIN lateral) con superficie, plantas/ha, TRV y caldo sugerido calculados
function jobCuadros(list) {
  return (list || []).map(c => {
    const k = Chacras.calc({ ...c, geometry: null });
    return { id: Number(c.id), nombre: c.nombre, codigo: c.codigo || null, cultivoId: c.cultivoId != null ? Number(c.cultivoId) : null, cultivo: c.cultivo || null,
      cultivoColor: c.cultivoColor || null, variedadId: c.variedadId != null ? Number(c.variedadId) : null, variedad: c.variedad || null,
      portainjerto: c.portainjerto || null, anioPlantacion: c.anioPlantacion != null ? Number(c.anioPlantacion) : null,
      cosechaDesdeMes: c.cosechaDesdeMes != null ? Number(c.cosechaDesdeMes) : null, cosechaHastaMes: c.cosechaHastaMes != null ? Number(c.cosechaHastaMes) : null,
      distFilasM: c.distFilasM != null ? Number(c.distFilasM) : null, distPlantasM: c.distPlantasM != null ? Number(c.distPlantasM) : null,
      orientacionFilas: c.orientacionFilas || null, codigoUp: c.codigoUp || null,
      ha: k.ha, plantasHa: k.plantasHa, trv: k.trv, caldo: k.caldo, deleted: !!c.deleted, geometry: c.geometry || null };
  });
}

function jobToJson(j, opts = {}) {
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
    createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at,
    productId: j.product_id != null ? Number(j.product_id) : null,
    machineId: j.machine_id != null ? Number(j.machine_id) : null,
    implementId: j.implement_id != null ? Number(j.implement_id) : null
  };
  // Producto del catálogo y máquinas (JOIN)
  if (j.p_name !== undefined) {
    out.productInfo = j.product_id != null && j.p_name != null ? {
      id: Number(j.product_id), name: j.p_name, activeIngredient: j.p_ai, toxClass: j.p_tox_class, toxColor: TOX_COLORS[j.p_tox_class] || null,
      phiDays: j.p_phi_days != null ? Number(j.p_phi_days) : null, phiText: j.p_phi_text,
      reentryHours: j.p_reentry_hours != null ? Number(j.p_reentry_hours) : null, reentryText: j.p_reentry_text,
      unit: j.product_unit, source: j.p_source, sourceUrl: j.p_source_url
    } : null;
    out.machineName = j.machine_name || null;
    out.implementName = j.implement_name || null;
  }
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
  if (j.pass_width_m !== undefined) {
    out.passWidthM = j.pass_width_m != null ? Number(j.pass_width_m) : null;
    out.zoneSource = j.zone_source || 'dibujada';
    out.coveragePct = j.coverage_pct != null ? Number(j.coverage_pct) : null;
    out.routePct = j.route_pct != null ? Number(j.route_pct) : null;
    out.coveredAt = j.covered_at || null;
    // La zona cubierta puede ser pesada: sólo va en el detalle
    if (opts.detail) out.coveredGeometry = j.covered_geometry || null;
  }
  if (j.est_nombre !== undefined) {
    out.establecimientoId = j.establecimiento_id != null ? Number(j.establecimiento_id) : null;
    out.establecimiento = j.establecimiento_id != null ? { id: Number(j.establecimiento_id), nombre: j.est_nombre, localidad: j.est_localidad || null, renspa: j.est_renspa || null } : null;
    out.cuadros = jobCuadros(j.cuadros_json);
    out.cuadrosHa = out.cuadros.length ? Math.round(out.cuadros.reduce((s, c) => s + (c.ha || 0), 0) * 100) / 100 : null;
    const vs = [...new Set(out.cuadros.map(c => [c.cultivo, c.variedad].filter(Boolean).join(' ')).filter(Boolean))];
    out.cultivoVariedad = vs.join(', ') || null;
  }
  if (j.example !== undefined) out.example = !!j.example;
  if (j.planned_start_at !== undefined) out.plannedStartAt = j.planned_start_at || null;
  if (j.paused_at !== undefined) out.pausedAt = j.paused_at || null;
  if (j.geometry !== undefined) out.geometry = j.geometry;
  if (j.point_count !== undefined) out.pointCount = j.point_count;
  if (j.last_point_at !== undefined) out.lastPointAt = j.last_point_at;
  if (j.application_method !== undefined) {
    out.applicationMethod = j.application_method || null;
    out.speedLimitKmh = j.speed_limit_kmh != null ? Number(j.speed_limit_kmh) : null;
    out.reopenedAt = j.reopened_at || null;
  }
  if (j.stage_count !== undefined) {
    out.stageCount = j.stage_count || 0;
    out.openStage = j.open_stage_id != null
      ? { id: Number(j.open_stage_id), seq: j.open_stage_seq, startedAt: j.open_stage_started_at } : null;
    out.stagesSeconds = j.stages_seconds != null ? Math.round(Number(j.stages_seconds)) : 0;
    out.lastStageEndedAt = j.last_stage_ended_at || null;
    out.firstStageStartedAt = j.first_stage_started_at || null;
  }
  return out;
}

function stageToJson(s) {
  if (!s) return null;
  const n = (v) => v != null ? Number(v) : null;
  const start = n(s.route_pct_start), end = n(s.route_pct_end);
  return {
    id: Number(s.id), jobId: Number(s.job_id), seq: s.seq,
    applicator: s.applicator_id != null
      ? { id: Number(s.applicator_id), name: s.applicator_name || null, username: s.applicator_username || null } : null,
    startedAt: s.started_at, endedAt: s.ended_at || null, endedBy: s.ended_by || null,
    durationS: Math.max(0, Math.round(((s.ended_at ? new Date(s.ended_at).getTime() : Date.now()) - new Date(s.started_at).getTime()) / 1000)),
    distanceM: n(s.distance_m), points: s.point_count != null ? Number(s.point_count) : null,
    routePctStart: start, routePctEnd: end,
    routePctGained: start != null && end != null ? Math.max(0, end - start) : null,
    statsAt: s.stats_at || null
  };
}

// Método de aplicación: tractor | mochila | otro. undefined = no se envió; null/'' = sin indicar
const APPLICATION_METHODS = ['tractor', 'mochila', 'otro'];
function parseMethod(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || v === '') return { value: null };
  if (!APPLICATION_METHODS.includes(v)) return { error: 'Método de aplicación inválido' };
  return { value: v };
}
// Velocidad máxima del trabajo (km/h). null/'' = la general de las alertas
function parseSpeedLimit(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || v === '') return { value: null };
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 1 || n > 30) return { error: 'La velocidad máxima tiene que estar entre 1 y 30 km/h' };
  return { value: Math.round(n * 10) / 10 };
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
  const id = (v) => { if (v == null || v === '') return null; const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
  return {
    productId: id(j.productId), machineId: id(j.machineId), implementId: id(j.implementId),
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

// Ancho de pasada = distancia entre filas de la chacra (2 a 10 m; INTA: 3,5 m en plantaciones nuevas).
// undefined = no se envió; null/'' = valor por defecto
const DEFAULT_PASS_WIDTH_M = 3.5;
function parsePassWidth(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || v === '') return { value: DEFAULT_PASS_WIDTH_M };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 2 || n > 10) return { error: 'El ancho de pasada (distancia entre filas) tiene que estar entre 2 y 10 m' };
  return { value: n };
}
// Tolerancia del GPS para dar una pasada por hecha: aparte del ancho (error del celular ~5 m)
const DEFAULT_GPS_TOLERANCE_M = 5;

// Tolerancia GPS en metros (3 a 10). undefined = no se envió; null/'' = usar el valor por defecto
function parseTolerance(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || v === '') return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 3 || n > 10) return { error: 'La tolerancia GPS tiene que estar entre 3 y 10 m' };
  return { value: n };
}

// Inicio programado (fecha y hora, opcional). undefined = no se envió; null/'' = sin inicio programado
function parsePlannedStart(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || v === '') return { value: null };
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(t) || t < Date.parse('2000-01-01') || t > Date.parse('2100-01-01')) {
    return { error: 'El inicio programado no es una fecha y hora válida' };
  }
  return { value: new Date(t).toISOString() };
}

module.exports = {
  jobCuadros, parsePlannedStart, jobToJson, stageToJson, parseMethod, parseSpeedLimit, APPLICATION_METHODS, parseJobInput, parseRoute, parseTolerance, parsePassWidth, JOB_STATUSES, DEFAULT_ROUTE_TOLERANCE_M, DEFAULT_PASS_WIDTH_M, DEFAULT_GPS_TOLERANCE_M };
