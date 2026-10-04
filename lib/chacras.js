// Chacras y cuadros: establecimientos, cuadros, catálogo regional, importación SENASA, datos de
// ejemplo y contorno del catastro de Río Negro (IDERN) como referencia para dibujar.
const turf = require('@turf/turf');
const db = require('./db');
const C = require('../chacras-core');
const ZoneGeo = require('../zone-geo');

const EXAMPLE = 'EJEMPLO';
const n = (v) => v == null ? null : Number(v);
const TZ = 'America/Argentina/Buenos_Aires';

// ---------- formato JSON ----------
function geomOk(g) {
  return g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates) && g.coordinates.length > 0;
}
const CUADRO_SELECT = `
  SELECT c.*, e.nombre AS est_nombre, e.example AS est_example, cu.nombre AS cultivo_nombre, cu.color AS cultivo_color,
         v.nombre AS variedad_nombre, v.cosecha_desde_mes, v.cosecha_hasta_mes, pi.nombre AS pi_nombre
    FROM cuadros c
    JOIN establecimientos e ON e.id = c.establecimiento_id
    LEFT JOIN cultivos cu ON cu.id = c.cultivo_id
    LEFT JOIN variedades v ON v.id = c.variedad_id
    LEFT JOIN portainjertos pi ON pi.id = c.portainjerto_id`;

function cuadroJson(r, opts = {}) {
  const base = {
    id: Number(r.id), establecimientoId: Number(r.establecimiento_id), establecimiento: r.est_nombre || null,
    nombre: r.nombre, codigo: r.codigo || null,
    haCalc: n(r.ha_calc), haManual: n(r.ha_manual),
    cultivoId: n(r.cultivo_id), cultivo: r.cultivo_nombre || null, cultivoColor: r.cultivo_color || null,
    variedadId: n(r.variedad_id), variedad: r.variedad_nombre || r.variedad_texto || null, variedadTexto: r.variedad_texto || null,
    cosechaDesdeMes: n(r.cosecha_desde_mes), cosechaHastaMes: n(r.cosecha_hasta_mes),
    clon: r.clon || null, portainjertoId: n(r.portainjerto_id), portainjerto: r.pi_nombre || r.portainjerto_texto || null,
    portainjertoTexto: r.portainjerto_texto || null, anioPlantacion: n(r.anio_plantacion),
    distFilasM: n(r.dist_filas_m), distPlantasM: n(r.dist_plantas_m), plantasManual: n(r.plantas_manual),
    sistemaConduccion: r.sistema_conduccion || null, alturaCopaM: n(r.altura_copa_m), anchoCopaM: n(r.ancho_copa_m),
    factorDensidad: n(r.factor_densidad), riego: r.riego || null, mallaAntigranizo: r.malla_antigranizo == null ? null : !!r.malla_antigranizo,
    codigoUp: r.codigo_up || null, orientacionFilas: r.orientacion_filas || null, organico: !!r.organico, notas: r.notas || null,
    active: !!r.active, example: !!r.example, deleted: !!r.deleted_at, createdAt: r.created_at, updatedAt: r.updated_at
  };
  const calc = C.calc({ ...base, geometry: null });
  Object.assign(base, { ha: calc.ha, haSource: calc.haSource, plantasHa: calc.plantasHa, plantas: calc.plantas, plantasSource: calc.plantasSource, trv: calc.trv, caldo: calc.caldo, edad: calc.edad });
  const c = r.geometry ? C.centroidOf([r.geometry]) : null;
  base.centroid = c;
  if (opts.geometry !== false) base.geometry = r.geometry || null;
  return base;
}
function estJson(r) {
  return {
    id: Number(r.id), empresaId: n(r.empresa_id), empresa: r.empresa_nombre || null, nombre: r.nombre, productor: r.productor || null,
    renspa: r.renspa || null, localidad: r.localidad || null, provincia: r.provincia || null, nomenclatura: r.nomenclatura || null,
    lat: n(r.lat), lon: n(r.lon), geometry: r.geometry || null, notas: r.notas || null, active: !!r.active, example: !!r.example,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}
// Resumen por cultivo / variedad de una lista de cuadros
function summarize(cuadros) {
  const byC = new Map(), byV = new Map();
  let ha = 0, plantas = 0;
  for (const c of cuadros) {
    const h = c.ha || 0; ha += h; plantas += c.plantas || 0;
    const kc = c.cultivo || 'Sin cultivo';
    const a = byC.get(kc) || { cultivo: kc, color: c.cultivoColor || '#94a3b8', ha: 0, cuadros: 0 };
    a.ha += h; a.cuadros++; byC.set(kc, a);
    const kv = kc + ' · ' + (c.variedad || 'Sin variedad');
    const b = byV.get(kv) || { cultivo: kc, variedad: c.variedad || 'Sin variedad', color: C.colorFor(c.variedad || kc), ha: 0, cuadros: 0 };
    b.ha += h; b.cuadros++; byV.set(kv, b);
  }
  const r = (x) => Math.round(x * 100) / 100;
  return {
    cuadros: cuadros.length, ha: r(ha), plantas: Math.round(plantas),
    byCultivo: [...byC.values()].map(x => ({ ...x, ha: r(x.ha) })).sort((a, b) => b.ha - a.ha),
    byVariedad: [...byV.values()].map(x => ({ ...x, ha: r(x.ha) })).sort((a, b) => b.ha - a.ha)
  };
}

// ---------- catálogo ----------
async function catalog() {
  const [{ rows: cs }, { rows: vs }, { rows: ps }] = await Promise.all([
    db.query('SELECT * FROM cultivos WHERE active ORDER BY orden, nombre'),
    db.query('SELECT * FROM variedades WHERE active ORDER BY cultivo_id, share_pct DESC NULLS LAST, superficie_ha DESC NULLS LAST, nombre'),
    db.query('SELECT * FROM portainjertos WHERE active ORDER BY especie, id')
  ]);
  return {
    cultivos: cs.map(c => ({ id: Number(c.id), nombre: c.nombre, color: c.color })),
    variedades: vs.map(v => ({ id: Number(v.id), cultivoId: Number(v.cultivo_id), nombre: v.nombre, sinonimos: v.sinonimos || [],
      cosechaDesdeMes: n(v.cosecha_desde_mes), cosechaHastaMes: n(v.cosecha_hasta_mes), importancia: v.importancia, sharePct: n(v.share_pct),
      superficieHa: n(v.superficie_ha), notas: v.notas, fuentes: v.fuentes || [] })),
    portainjertos: ps.map(p => ({ id: Number(p.id), especie: p.especie, nombre: p.nombre, sinonimos: p.sinonimos || [], vigor: p.vigor,
      importancia: p.importancia, notas: p.notas, fuentes: p.fuentes || [] })),
    sistemas: C.SISTEMAS, riegos: C.RIEGOS, orientaciones: C.ORIENTACIONES
  };
}

// ---------- validación de entrada ----------
function text(v, max = 200) { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; }
function rangeNum(v, min, max, label, errors) {
  if (v == null || v === '') return null;
  const x = C.num(v);
  if (x == null || x < min || x > max) { errors.push(`${label}: tiene que estar entre ${String(min).replace('.', ',')} y ${String(max).replace('.', ',')}`); return undefined; }
  return x;
}
const boolOrNull = (v) => v == null || v === '' ? null : (v === true || v === 'true' || v === 1 || v === '1' || /^s[ií]$/i.test(String(v)));

async function parseCuadroInput(body, partial) {
  const b = body || {};
  const errors = [];
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('nombre')) { out.nombre = text(b.nombre, 120); if (!out.nombre) errors.push('Poné el nombre del cuadro'); }
  if (has('codigo')) out.codigo = text(b.codigo, 40);
  if (has('geometry')) {
    let g = b.geometry && b.geometry.type === 'Feature' ? b.geometry.geometry : b.geometry;
    if (g == null || g === '') { out.geometry = null; out.haCalc = null; }
    else if (!geomOk(g)) errors.push('El polígono del cuadro no es válido');
    else {
      const ha = C.areaHa(g);
      if (!ha) errors.push('El polígono del cuadro no tiene superficie');
      else if (ha > 2000) errors.push('El polígono del cuadro es demasiado grande (más de 2.000 ha)');
      else { out.geometry = { type: g.type, coordinates: g.coordinates }; out.haCalc = Math.round(ha * 10000) / 10000; }
    }
  }
  const nums = [['haManual', 0.001, 5000, 'Superficie (ha)'], ['distFilasM', 0.5, 15, 'Distancia entre filas (m)'], ['distPlantasM', 0.2, 15, 'Distancia entre plantas (m)'],
    ['alturaCopaM', 0.3, 12, 'Altura de copa (m)'], ['anchoCopaM', 0.2, 12, 'Ancho de copa (m)'], ['factorDensidad', 0.3, 1.5, 'Factor de densidad foliar'],
    ['plantasManual', 1, 10000000, 'Número de plantas'], ['anioPlantacion', 1900, new Date().getFullYear() + 1, 'Año de plantación']];
  for (const [k, min, max, label] of nums) if (has(k)) { const v = rangeNum(b[k], min, max, label, errors); if (v !== undefined) out[k] = v; }
  if (out.plantasManual != null) out.plantasManual = Math.round(out.plantasManual);
  if (out.anioPlantacion != null) out.anioPlantacion = Math.round(out.anioPlantacion);
  for (const [k, max] of [['clon', 120], ['variedadTexto', 120], ['portainjertoTexto', 120], ['sistemaConduccion', 80], ['riego', 80], ['codigoUp', 60], ['orientacionFilas', 20], ['notas', 1000]]) {
    if (has(k)) out[k] = text(b[k], max);
  }
  if (has('mallaAntigranizo')) out.mallaAntigranizo = boolOrNull(b.mallaAntigranizo);
  if (has('organico')) out.organico = !!boolOrNull(b.organico);
  if (has('active')) out.active = b.active !== false && b.active !== 'false';
  // Cultivo / variedad / portainjerto del catálogo
  const id = (v) => { if (v == null || v === '') return null; const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? x : NaN; };
  if (has('cultivoId')) { out.cultivoId = id(b.cultivoId); if (Number.isNaN(out.cultivoId)) errors.push('Cultivo inválido'); }
  if (has('variedadId')) { out.variedadId = id(b.variedadId); if (Number.isNaN(out.variedadId)) errors.push('Variedad inválida'); }
  if (has('portainjertoId')) { out.portainjertoId = id(b.portainjertoId); if (Number.isNaN(out.portainjertoId)) errors.push('Portainjerto inválido'); }
  if (out.variedadId) {
    const { rows } = await db.query('SELECT cultivo_id FROM variedades WHERE id = $1', [out.variedadId]);
    if (!rows[0]) errors.push('La variedad elegida no existe');
    else if (out.cultivoId && Number(rows[0].cultivo_id) !== out.cultivoId) errors.push('La variedad no corresponde al cultivo elegido');
    else out.cultivoId = Number(rows[0].cultivo_id);
  }
  if (out.cultivoId) { const { rows } = await db.query('SELECT 1 FROM cultivos WHERE id = $1', [out.cultivoId]); if (!rows[0]) errors.push('El cultivo elegido no existe'); }
  if (out.portainjertoId) { const { rows } = await db.query('SELECT 1 FROM portainjertos WHERE id = $1', [out.portainjertoId]); if (!rows[0]) errors.push('El portainjerto elegido no existe'); }
  return { value: out, errors };
}
const CUADRO_COLS = {
  nombre: 'nombre', codigo: 'codigo', geometry: 'geometry', haCalc: 'ha_calc', haManual: 'ha_manual', cultivoId: 'cultivo_id', variedadId: 'variedad_id',
  variedadTexto: 'variedad_texto', clon: 'clon', portainjertoId: 'portainjerto_id', portainjertoTexto: 'portainjerto_texto', anioPlantacion: 'anio_plantacion',
  distFilasM: 'dist_filas_m', distPlantasM: 'dist_plantas_m', plantasManual: 'plantas_manual', sistemaConduccion: 'sistema_conduccion',
  alturaCopaM: 'altura_copa_m', anchoCopaM: 'ancho_copa_m', factorDensidad: 'factor_densidad', riego: 'riego', mallaAntigranizo: 'malla_antigranizo',
  codigoUp: 'codigo_up', orientacionFilas: 'orientacion_filas', organico: 'organico', notas: 'notas', active: 'active'
};

function parseEstInput(body, partial) {
  const b = body || {};
  const errors = [];
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('nombre')) { out.nombre = text(b.nombre, 120); if (!out.nombre) errors.push('Poné el nombre del establecimiento'); }
  for (const [k, max] of [['productor', 120], ['renspa', 40], ['localidad', 80], ['provincia', 80], ['nomenclatura', 60], ['notas', 1000]]) if (has(k)) out[k] = text(b[k], max);
  if (has('lat')) { const v = rangeNum(b.lat, -90, 90, 'Latitud', errors); if (v !== undefined) out.lat = v; }
  if (has('lon')) { const v = rangeNum(b.lon, -180, 180, 'Longitud', errors); if (v !== undefined) out.lon = v; }
  if (has('geometry')) {
    const g = b.geometry && b.geometry.type === 'Feature' ? b.geometry.geometry : b.geometry;
    if (g == null || g === '') out.geometry = null;
    else if (!geomOk(g) || !C.areaHa(g) || C.areaHa(g) > 20000) errors.push('El contorno del establecimiento no es válido');
    else out.geometry = { type: g.type, coordinates: g.coordinates };
  }
  if (has('empresaId')) { const x = b.empresaId == null || b.empresaId === '' ? null : parseInt(b.empresaId, 10); if (x !== null && !(x > 0)) errors.push('Empresa inválida'); else out.empresaId = x; }
  if (has('empresa')) out.empresaNombre = text(b.empresa, 120);
  if (has('empresaNombre')) out.empresaNombre = text(b.empresaNombre, 120);
  if (has('active')) out.active = b.active !== false && b.active !== 'false';
  return { value: out, errors };
}
const EST_COLS = { nombre: 'nombre', productor: 'productor', renspa: 'renspa', localidad: 'localidad', provincia: 'provincia', nomenclatura: 'nomenclatura',
  lat: 'lat', lon: 'lon', geometry: 'geometry', notas: 'notas', empresaId: 'empresa_id', active: 'active' };
const jsonCols = new Set(['geometry']);
const sqlVal = (k, v) => jsonCols.has(k) ? (v == null ? null : JSON.stringify(v)) : v;

async function ensureEmpresa(client, nombre, example) {
  if (!nombre) return null;
  const { rows } = await client.query('SELECT id FROM empresas WHERE lower(nombre) = lower($1)', [nombre]);
  if (rows[0]) return Number(rows[0].id);
  const { rows: [r] } = await client.query('INSERT INTO empresas (nombre, example) VALUES ($1, $2) RETURNING id', [nombre, !!example]);
  return Number(r.id);
}

// ---------- consultas ----------
async function listCuadros(where = [], params = [], opts = {}) {
  const w = ['c.deleted_at IS NULL', ...where];
  const { rows } = await db.query(`${CUADRO_SELECT} WHERE ${w.join(' AND ')} ORDER BY e.nombre, c.nombre, c.id`, params);
  return rows.map(r => cuadroJson(r, opts));
}
async function getCuadro(id) {
  const { rows } = await db.query(`${CUADRO_SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ? cuadroJson(rows[0]) : null;
}
// Historial de aplicaciones del cuadro (trabajos no eliminados)
async function cuadroHistory(id, limit = 50) {
  const { rows } = await db.query(
    `SELECT j.id, j.lot_name, j.status, j.product, j.dose, j.dose_unit, j.liters_per_ha, j.started_at, j.finished_at, j.created_at, j.planned_start_at,
            j.scheduled_date, p.name AS p_name, p.phi_days, p.reentry_hours, u.name AS applicator_name,
            (SELECT max(ended_at) FROM job_stages s WHERE s.job_id = j.id) AS last_stage_end
       FROM job_cuadros jc JOIN jobs j ON j.id = jc.job_id
       LEFT JOIN products p ON p.id = j.product_id LEFT JOIN users u ON u.id = j.applicator_id
      WHERE jc.cuadro_id = $1 AND j.deleted_at IS NULL
      ORDER BY COALESCE(j.finished_at, j.started_at, j.planned_start_at, j.created_at) DESC LIMIT $2`, [id, limit]);
  return rows.map(r => {
    const last = r.finished_at || r.last_stage_end || null;
    const phi = n(r.phi_days);
    return {
      id: Number(r.id), lotName: r.lot_name, status: r.status, product: r.p_name || r.product, dose: n(r.dose), doseUnit: r.dose_unit,
      litersPerHa: n(r.liters_per_ha), startedAt: r.started_at, finishedAt: r.finished_at, plannedStartAt: r.planned_start_at,
      scheduledDate: r.scheduled_date, applicator: r.applicator_name || null, phiDays: phi, lastApplicationAt: last,
      harvestFrom: last && phi != null ? new Date(new Date(last).getTime() + phi * 86400e3).toISOString() : null
    };
  });
}
async function listEstablecimientos(q = {}) {
  const where = [], params = [];
  const p = (v) => { params.push(v); return '$' + params.length; };
  if (!q.includeInactive) where.push('e.active');
  if (q.q) { const k = p('%' + String(q.q).trim().toLowerCase() + '%'); where.push(`(lower(e.nombre) LIKE ${k} OR lower(COALESCE(e.renspa,'')) LIKE ${k} OR lower(COALESCE(e.localidad,'')) LIKE ${k} OR lower(COALESCE(e.productor,'')) LIKE ${k} OR lower(COALESCE(em.nombre,'')) LIKE ${k}
      OR EXISTS (SELECT 1 FROM cuadros cq LEFT JOIN variedades vq ON vq.id = cq.variedad_id WHERE cq.establecimiento_id = e.id AND cq.deleted_at IS NULL
                 AND (lower(cq.nombre) LIKE ${k} OR lower(COALESCE(cq.codigo_up,'')) LIKE ${k} OR lower(COALESCE(vq.nombre, cq.variedad_texto, '')) LIKE ${k})))`); }
  if (q.empresaId) where.push(`e.empresa_id = ${p(Number(q.empresaId))}`);
  if (q.cultivoId) where.push(`EXISTS (SELECT 1 FROM cuadros cq WHERE cq.establecimiento_id = e.id AND cq.deleted_at IS NULL AND cq.cultivo_id = ${p(Number(q.cultivoId))})`);
  if (q.variedadId) where.push(`EXISTS (SELECT 1 FROM cuadros cq WHERE cq.establecimiento_id = e.id AND cq.deleted_at IS NULL AND cq.variedad_id = ${p(Number(q.variedadId))})`);
  const { rows } = await db.query(
    `SELECT e.*, em.nombre AS empresa_nombre FROM establecimientos e LEFT JOIN empresas em ON em.id = e.empresa_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.active DESC, e.nombre, e.id`, params);
  const ids = rows.map(r => Number(r.id));
  const cuadros = ids.length ? await listCuadros(['c.establecimiento_id = ANY($1::bigint[])'], [ids], { geometry: !!q.geometry }) : [];
  const by = new Map();
  for (const c of cuadros) { if (!by.has(c.establecimientoId)) by.set(c.establecimientoId, []); by.get(c.establecimientoId).push(c); }
  const { rows: jc } = ids.length ? await db.query(
    `SELECT j.establecimiento_id, count(*)::int AS n, max(COALESCE(j.finished_at, j.started_at)) AS last
       FROM jobs j WHERE j.deleted_at IS NULL AND j.establecimiento_id = ANY($1::bigint[]) GROUP BY 1`, [ids]) : { rows: [] };
  const jobsBy = new Map(jc.map(r => [Number(r.establecimiento_id), r]));
  return rows.map(r => {
    const e = estJson(r);
    const cs = by.get(e.id) || [];
    e.resumen = summarize(cs);
    const j = jobsBy.get(e.id);
    e.trabajos = j ? j.n : 0; e.ultimaAplicacion = j ? j.last : null;
    e.center = e.lat != null && e.lon != null ? [e.lon, e.lat] : (C.centroidOf(cs.map(c => c.geometry).filter(Boolean)) || (e.geometry ? C.centroidOf([e.geometry]) : null));
    if (q.geometry) e.cuadros = cs;
    else e.geometry = undefined;
    return e;
  });
}
async function getEstablecimiento(id) {
  const { rows } = await db.query('SELECT e.*, em.nombre AS empresa_nombre FROM establecimientos e LEFT JOIN empresas em ON em.id = e.empresa_id WHERE e.id = $1', [id]);
  if (!rows[0]) return null;
  const e = estJson(rows[0]);
  e.cuadros = await listCuadros(['c.establecimiento_id = $1'], [id]);
  e.resumen = summarize(e.cuadros);
  e.center = e.lat != null && e.lon != null ? [e.lon, e.lat] : (C.centroidOf(e.cuadros.map(c => c.geometry).filter(Boolean)) || (e.geometry ? C.centroidOf([e.geometry]) : null));
  // Última aplicación por cuadro
  const ids = e.cuadros.map(c => c.id);
  if (ids.length) {
    const { rows: la } = await db.query(
      `SELECT DISTINCT ON (jc.cuadro_id) jc.cuadro_id, j.id, j.status, COALESCE(p.name, j.product) AS product,
              COALESCE(j.finished_at, (SELECT max(ended_at) FROM job_stages s WHERE s.job_id = j.id), j.started_at) AS at, p.phi_days
         FROM job_cuadros jc JOIN jobs j ON j.id = jc.job_id LEFT JOIN products p ON p.id = j.product_id
        WHERE jc.cuadro_id = ANY($1::bigint[]) AND j.deleted_at IS NULL AND j.status IN ('en_curso', 'finalizado')
        ORDER BY jc.cuadro_id, COALESCE(j.finished_at, j.started_at) DESC NULLS LAST`, [ids]);
    const by = new Map(la.map(r => [Number(r.cuadro_id), r]));
    for (const c of e.cuadros) {
      const r = by.get(c.id);
      c.ultimaAplicacion = r ? { jobId: Number(r.id), status: r.status, product: r.product, at: r.at,
        harvestFrom: r.at && r.phi_days != null ? new Date(new Date(r.at).getTime() + Number(r.phi_days) * 86400e3).toISOString() : null } : null;
    }
  }
  return e;
}

// ---------- cuadros de un trabajo ----------
// Valida los cuadros elegidos para un trabajo: existen, no están borrados y son del mismo establecimiento
async function resolveJobCuadros(ids) {
  if (ids == null) return { cuadros: null };
  if (!Array.isArray(ids)) return { error: 'Cuadros inválidos' };
  const clean = [...new Set(ids.map(x => parseInt(x, 10)).filter(x => Number.isFinite(x) && x > 0))];
  if (!clean.length) return { cuadros: [] };
  if (clean.length > 50) return { error: 'Demasiados cuadros en un trabajo (máximo 50)' };
  const cs = await listCuadros(['c.id = ANY($1::bigint[])'], [clean]);
  if (cs.length !== clean.length) return { error: 'Alguno de los cuadros elegidos no existe o fue borrado' };
  const ests = new Set(cs.map(c => c.establecimientoId));
  if (ests.size > 1) return { error: 'Los cuadros de un trabajo tienen que ser del mismo establecimiento' };
  return { cuadros: cs, establecimientoId: cs[0].establecimientoId };
}
async function setJobCuadros(client, jobId, cuadros) {
  await client.query('DELETE FROM job_cuadros WHERE job_id = $1', [jobId]);
  if (cuadros && cuadros.length) {
    await client.query('INSERT INTO job_cuadros (job_id, cuadro_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING', [jobId, cuadros.map(c => c.id)]);
  }
  await client.query('UPDATE jobs SET establecimiento_id = $2 WHERE id = $1', [jobId, cuadros && cuadros.length ? cuadros[0].establecimientoId : null]);
}

// ---------- datos de ejemplo ----------
// Chacra real vista en imagen satelital (parcela 03-2-D-004-03-0 del catastro de Río Negro, Gral. Fernández Oro):
// el contorno es el de la parcela y los cuadros siguen los dos bloques de frutales separados por el callejón interno.
const DEMO = {
  est: {
    nombre: `${EXAMPLE} – Chacra Demo`, productor: `${EXAMPLE} (datos de prueba)`, localidad: 'General Fernández Oro', provincia: 'Río Negro',
    nomenclatura: '03-2-D-004-03-0',
    notas: 'Datos de ejemplo para probar el módulo, dibujados sobre una chacra real en imagen satelital (contorno: parcela del catastro de Río Negro, IDERN). ' +
      'Variedades y marcos son inventados. Se borra con "Borrar datos de ejemplo" en el Tablero.',
    geometry: { type: 'Polygon', coordinates: [[[-67.929946, -38.970311], [-67.929529, -38.970375], [-67.930387, -38.974398], [-67.932002, -38.974186], [-67.931949, -38.973924], [-67.931191, -38.970172], [-67.931181, -38.970122], [-67.929946, -38.970311]]] }
  },
  cuadros: [
    { nombre: 'Cuadro 1 – Williams', codigo: 'C1', cultivo: 'Peral', variedad: 'Williams', portainjerto: 'Franco de peral', anioPlantacion: 2008,
      distFilasM: 4, distPlantasM: 2, sistemaConduccion: 'Eje central', alturaCopaM: 3.5, anchoCopaM: 2, factorDensidad: 0.9,
      riego: 'Gravitacional (surco / manto)', mallaAntigranizo: false, orientacionFilas: 'E-O', bearing: 99,
      geometry: { type: 'Polygon', coordinates: [[[-67.931546, -38.97216], [-67.929998, -38.972355], [-67.929582, -38.970403], [-67.931143, -38.970165], [-67.931546, -38.97216]]] } },
    { nombre: 'Cuadro 2 – Red Delicious', codigo: 'C2', cultivo: 'Manzano', variedad: 'Red Delicious', clon: 'Red Chief', portainjerto: 'MM111', anioPlantacion: 2012,
      distFilasM: 4, distPlantasM: 1.5, sistemaConduccion: 'Espaldera', alturaCopaM: 3.2, anchoCopaM: 1.8, factorDensidad: 1,
      riego: 'Aspersión', mallaAntigranizo: true, orientacionFilas: 'N-S',
      geometry: { type: 'Polygon', coordinates: [[[-67.931949, -38.974157], [-67.930425, -38.974356], [-67.930032, -38.972515], [-67.931578, -38.972319], [-67.931949, -38.974157]]] } }
  ],
  job: { lotName: `${EXAMPLE} – Recorrido demo`, productKeys: ['senasa-39377', 'inta-clorantraniliprole'], notes: 'Trabajo de ejemplo: ruta de pasadas en las entrefilas del Cuadro 1 (Williams). Probalo con el usuario aplicador. Se borra con "Borrar datos de ejemplo".' }
};
async function demoStatus(client = db) {
  const { rows: [r] } = await client.query(
    `SELECT (SELECT count(*) FROM establecimientos WHERE example)::int AS establecimientos,
            (SELECT count(*) FROM cuadros WHERE example)::int AS cuadros,
            (SELECT count(*) FROM jobs WHERE example)::int AS trabajos`);
  return { ...r, loaded: r.establecimientos + r.cuadros + r.trabajos > 0 };
}
async function createDemo(client, userId, opts = {}) {
  const st = await demoStatus(client);
  if (st.establecimientos) return { skipped: true, ...st };
  const g = DEMO.est.geometry;
  const c0 = C.centroidOf([g]);
  const { rows: [est] } = await client.query(
    `INSERT INTO establecimientos (nombre, productor, localidad, provincia, nomenclatura, lat, lon, geometry, notas, example, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10) RETURNING id`,
    [DEMO.est.nombre, DEMO.est.productor, DEMO.est.localidad, DEMO.est.provincia, DEMO.est.nomenclatura, c0[1], c0[0], JSON.stringify(g), DEMO.est.notas, userId]);
  const ids = [];
  for (const d of DEMO.cuadros) {
    const { rows: [cu] } = await client.query('SELECT id FROM cultivos WHERE nombre = $1', [d.cultivo]);
    const { rows: [va] } = cu ? await client.query('SELECT id FROM variedades WHERE cultivo_id = $1 AND nombre = $2', [cu.id, d.variedad]) : { rows: [] };
    const { rows: [pi] } = await client.query('SELECT id FROM portainjertos WHERE nombre = $1', [d.portainjerto]);
    const { rows: [c] } = await client.query(
      `INSERT INTO cuadros (establecimiento_id, nombre, codigo, geometry, ha_calc, cultivo_id, variedad_id, variedad_texto, clon, portainjerto_id, portainjerto_texto,
                            anio_plantacion, dist_filas_m, dist_plantas_m, sistema_conduccion, altura_copa_m, ancho_copa_m, factor_densidad, riego,
                            malla_antigranizo, orientacion_filas, notas, example, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,true,$23) RETURNING id`,
      [est.id, d.nombre, d.codigo, JSON.stringify(d.geometry), Math.round(C.areaHa(d.geometry) * 10000) / 10000, cu ? cu.id : null, va ? va.id : null,
        va ? null : d.variedad, d.clon || null, pi ? pi.id : null, pi ? null : d.portainjerto, d.anioPlantacion, d.distFilasM, d.distPlantasM,
        d.sistemaConduccion, d.alturaCopaM, d.anchoCopaM, d.factorDensidad, d.riego, d.mallaAntigranizo, d.orientacionFilas,
        'Dato de ejemplo (inventado).', userId]);
    ids.push(Number(c.id));
  }
  let jobId = null;
  if (opts.job !== false) {
    // Aplicador de prueba (usuario "aplicador"): nunca se asigna a otro usuario real
    const { rows: [app] } = await client.query("SELECT id FROM users WHERE username = 'aplicador' AND role = 'aplicador' AND active");
    let prod = null;
    for (const k of DEMO.job.productKeys) {
      // nunca un producto con stock negativo (no tocar stock real con el ejemplo)
      const { rows } = await client.query(
        `SELECT p.id, p.name, p.dose_value, p.dose_unit FROM products p
          WHERE p.seed_key = $1 AND p.active AND COALESCE((SELECT sum(m.quantity) FROM stock_movements m WHERE m.product_id = p.id), 0) >= 0`, [k]);
      if (rows[0]) { prod = rows[0]; break; }
    }
    const d = DEMO.cuadros[0];
    const passes = C.generatePasses(d.geometry, d.distFilasM, d.bearing);
    const route = { type: 'MultiLineString', coordinates: passes };
    const zone = ZoneGeo.deriveZone(route, d.distFilasM);
    const calc = C.calc(d);
    const { rows: [z] } = await client.query(
      `INSERT INTO zones (name, geometry, properties, assigned_to, created_by, origin) VALUES ($1, $2, '{}'::jsonb, $3, $4, 'trabajo') RETURNING id`,
      [DEMO.job.lotName, JSON.stringify(zone), app ? app.id : null, userId]);
    const { rows: [j] } = await client.query(
      `INSERT INTO jobs (zone_id, applicator_id, lot_name, product, product_id, dose, dose_unit, liters_per_ha, scheduled_date, notes, created_by,
                         route, route_tolerance_m, pass_width_m, zone_source, application_method, establecimiento_id, example)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (now() AT TIME ZONE '${TZ}')::date, $9, $10, $11, 5, $12, 'ruta', 'tractor', $13, true) RETURNING id`,
      [z.id, app ? app.id : null, DEMO.job.lotName, prod ? prod.name : 'Producto de ejemplo', prod ? prod.id : null,
        prod ? prod.dose_value : null, prod ? prod.dose_unit : null, calc.caldo ? Math.round(calc.caldo / 50) * 50 : null, DEMO.job.notes, userId,
        JSON.stringify(route), d.distFilasM, est.id]);
    await client.query('INSERT INTO job_cuadros (job_id, cuadro_id) VALUES ($1, $2)', [j.id, ids[0]]);
    jobId = Number(j.id);
  }
  return { ok: true, establecimientoId: Number(est.id), cuadroIds: ids, jobId, ...(await demoStatus(client)) };
}
// Borra los datos de ejemplo de chacras: trabajos de ejemplo (con su GPS, etapas, alertas, clima y consumo),
// cuadros y establecimientos de ejemplo. Los trabajos reales que usaron un cuadro de ejemplo quedan sin cuadro.
async function deleteDemo(client) {
  const { rows: js } = await client.query('SELECT id, zone_id FROM jobs WHERE example');
  const jobIds = js.map(j => Number(j.id)), zoneIds = js.map(j => Number(j.zone_id));
  if (jobIds.length) {
    for (const t of ['track_points', 'job_weather', 'alerts', 'job_pauses', 'stock_movements', 'job_cuadros', 'job_stages']) {
      await client.query(`DELETE FROM ${t} WHERE job_id = ANY($1::bigint[])`, [jobIds]);
    }
    await client.query('DELETE FROM jobs WHERE id = ANY($1::bigint[])', [jobIds]);
    await client.query('DELETE FROM zones z WHERE z.id = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.zone_id = z.id) AND NOT EXISTS (SELECT 1 FROM track_points t WHERE t.zone_id = z.id)', [zoneIds]);
  }
  const ex = `SELECT id FROM cuadros WHERE example OR establecimiento_id IN (SELECT id FROM establecimientos WHERE example)`;
  const { rowCount: unlinked } = await client.query(`DELETE FROM job_cuadros WHERE cuadro_id IN (${ex})`);
  await client.query('UPDATE jobs SET establecimiento_id = NULL WHERE establecimiento_id IN (SELECT id FROM establecimientos WHERE example)');
  const { rowCount: cuadros } = await client.query(`DELETE FROM cuadros WHERE id IN (${ex})`);
  const { rowCount: ests } = await client.query('DELETE FROM establecimientos WHERE example');
  await client.query('DELETE FROM empresas em WHERE em.example AND NOT EXISTS (SELECT 1 FROM establecimientos e WHERE e.empresa_id = em.id)');
  return { trabajos: jobIds.length, cuadros, establecimientos: ests, cuadrosDesvinculados: unlinked };
}

// ---------- catastro (IDERN Río Negro, parcelario) ----------
const IDERN_WFS = 'https://idern.rionegro.gov.ar/geoserver/wfs';
const catCache = new Map();
const CAT_TTL = 24 * 3600e3, CAT_MAX = 300;
async function catastroParcelas(bbox) {
  const b = (bbox || []).map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) return { error: 'bbox inválido', status: 400 };
  let [minX, minY, maxX, maxY] = b;
  if (maxX - minX > 0.06 || maxY - minY > 0.05) return { error: 'Acercá el mapa para traer las parcelas (zona demasiado grande)', status: 400 };
  // Río Negro (aprox.): fuera de ese recuadro no hay datos de este servicio
  if (maxX < -71.95 || minX > -62.7 || maxY < -42.05 || minY > -37.5) return { error: 'El catastro disponible es el de Río Negro (IDERN). Esta zona está fuera de la provincia.', status: 400 };
  const g = 0.005; // grilla para que el caché sirva al mover un poco el mapa
  minX = Math.floor(minX / g) * g; minY = Math.floor(minY / g) * g; maxX = Math.ceil(maxX / g) * g; maxY = Math.ceil(maxY / g) * g;
  const key = [minX, minY, maxX, maxY].map(x => x.toFixed(3)).join(',');
  const hit = catCache.get(key);
  if (hit && Date.now() - hit.at < CAT_TTL) return { ...hit.data, cached: true };
  const url = `${IDERN_WFS}?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:PARCELARIO1&outputFormat=application/json&maxFeatures=800&bbox=${key}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  let raw;
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'chaman-tracker (contorno de referencia)' } });
    if (!res.ok) return { error: `El catastro de Río Negro respondió ${res.status}`, status: 502 };
    raw = await res.json();
  } catch (e) {
    return { error: 'No se pudo consultar el catastro de Río Negro (IDERN): ' + (e.name === 'AbortError' ? 'tardó demasiado' : e.message), status: 502 };
  } finally { clearTimeout(t); }
  const features = (raw.features || []).filter(f => f.geometry && /Polygon$/.test(f.geometry.type)).map(f => {
    const p = f.properties || {};
    let geom = f.geometry;
    try { geom = turf.truncate(turf.feature(geom), { precision: 6 }).geometry; } catch (_) { /* tal cual */ }
    return { type: 'Feature', geometry: geom, properties: { cca: p.CCA || null, tipo: p.TPA || null, ha: p.ARA != null ? Number(p.ARA) : null, unidad: p.UND_ARA || null } };
  });
  const data = { type: 'FeatureCollection', features, bbox: [minX, minY, maxX, maxY], source: 'IDERN – Parcelario de la Gerencia de Catastro, Agencia de Recaudación Tributaria de Río Negro (geonode:PARCELARIO1)', truncated: features.length >= 800 };
  catCache.set(key, { at: Date.now(), data });
  if (catCache.size > CAT_MAX) catCache.delete(catCache.keys().next().value);
  return data;
}

module.exports = {
  EXAMPLE, CUADRO_SELECT, CUADRO_COLS, EST_COLS, cuadroJson, estJson, summarize, catalog, parseCuadroInput, parseEstInput, sqlVal, ensureEmpresa,
  listCuadros, getCuadro, cuadroHistory, listEstablecimientos, getEstablecimiento, resolveJobCuadros, setJobCuadros,
  DEMO, demoStatus, createDemo, deleteDemo, catastroParcelas
};
