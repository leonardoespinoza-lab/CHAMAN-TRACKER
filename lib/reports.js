// Informes: arma un informe de seguimiento (KPIs + tablas por sección) con filtros, en un formato común
// [{ key, title, columns, rows }] que usan la vista previa, el Excel, los CSV y el PDF.
const turf = require('@turf/turf');
const db = require('./db');
const G = require('./gestion');

const { TZ, round, zoneHa, jobConsumption, STAGES_CTE, TOX_COLORS, HIGH_TOX } = G;

const SECTIONS = [
  { key: 'resumen', title: 'Resumen KPIs' },
  { key: 'trabajos', title: 'Trabajos' },
  { key: 'productos', title: 'Aplicaciones por producto y consumo' },
  { key: 'stock', title: 'Stock (movimientos y saldos)' },
  { key: 'maquinaria', title: 'Maquinaria' },
  { key: 'alertas', title: 'Alertas' },
  { key: 'exposicion', title: 'Exposición por aplicador' },
  { key: 'rendimiento', title: 'Rendimiento por aplicador' },
  { key: 'clima', title: 'Condiciones meteorológicas' }
];
const SECTION_KEYS = SECTIONS.map(s => s.key);
const WX_STATUS = { apta: 'Apta', precaucion: 'Precaución', no_apta: 'No apta' };
const WX_SOURCE = { 'open-meteo': 'Open-Meteo', 'met-norway': 'MET Norway', mock: 'Simulado' };
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const cardinalOf = (d) => d == null ? '' : CARD[Math.round(((Number(d) % 360) + 360) % 360 / 22.5) % 16];
function wxText(w) {
  if (!w) return '';
  const f = (v, d = 0) => v == null ? '–' : Number(v).toLocaleString('es-AR', { maximumFractionDigits: d });
  return `${WX_STATUS[w.status] || ''} · ${f(w.temp, 1)} °C · HR ${f(w.rh)} % · viento ${f(w.wind)} km/h ${cardinalOf(w.wind_dir)}` +
    (w.gust != null ? ` (ráf. ${f(w.gust)})` : '') + ` · ΔT ${f(w.delta_t, 1)}`;
}
const STATUS_LABELS = { pendiente: 'Pendiente', en_curso: 'En curso', finalizado: 'Finalizado', cancelado: 'Cancelado' };
const ALERT_TYPES = { velocidad: 'Exceso de velocidad', parada: 'Parada larga', sin_senal: 'Sin señal GPS', ruta_incompleta: 'Tramos de ruta salteados', no_inicio: 'No arrancó a tiempo', clima: 'Pronóstico no apto' };
const SEVERITY = { alta: 'Alta', media: 'Media', info: 'Info' };
const MAX_MAPS = 60;

// ---------- formato (hora Argentina, UTC-3 fijo) ----------
const pad = (n) => String(n).padStart(2, '0');
function localParts(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const l = new Date(d.getTime() - 3 * 3600e3);
  return { y: l.getUTCFullYear(), m: l.getUTCMonth() + 1, d: l.getUTCDate(), h: l.getUTCHours(), mi: l.getUTCMinutes() };
}
function fmtDate(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-'); return `${d}/${m}/${y}`; }
  const p = localParts(v); return p ? `${pad(p.d)}/${pad(p.m)}/${p.y}` : '';
}
function fmtDateTime(v) { const p = localParts(v); return p ? `${pad(p.d)}/${pad(p.m)}/${p.y} ${pad(p.h)}:${pad(p.mi)}` : ''; }
const nf = {};
function fmtNum(v, d) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '';
  const k = `${d}`;
  nf[k] = nf[k] || new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: d });
  return nf[k].format(Number(v));
}
// Texto para mostrar de una celda según el tipo de columna
function fmtCell(col, v) {
  if (v == null || v === '') return '';
  switch (col.t) {
    case 'int': return fmtNum(v, 0);
    case 'n1': return fmtNum(v, 1);
    case 'n2': return fmtNum(v, 2);
    case 'n3': return fmtNum(v, 3);
    case 'pct': return fmtNum(v, 1) + ' %';
    case 'money': return 'US$ ' + fmtNum(v, 2);
    case 'date': return fmtDate(v);
    case 'dt': return fmtDateTime(v);
    default: return String(v);
  }
}
// Fecha "sólo día" que viene de Postgres (DATE) => AAAA-MM-DD sin correr de huso
function dayStr(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- parámetros ----------
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
function parseParams(q) {
  const range = G.parseRange(q);
  let sections = String(q.sections || '').split(',').map(s => s.trim()).filter(s => SECTION_KEYS.includes(s));
  if (!sections.length) sections = SECTION_KEYS.slice();
  sections = SECTION_KEYS.filter(k => sections.includes(k)); // orden fijo
  const filters = {
    applicatorId: posInt(q.applicatorId), machineId: posInt(q.machineId), productId: posInt(q.productId),
    status: STATUS_LABELS[q.status] ? q.status : null, jobId: posInt(q.jobId)
  };
  return { range, sections, filters };
}

// Condiciones de trabajo según filtros (sin fecha). Agrega parámetros a "params".
function jobWhere(f, params, a = 'j') {
  const w = [`${a}.deleted_at IS NULL`];
  const p = (v) => { params.push(v); return '$' + params.length; };
  if (f.applicatorId) { const k = p(f.applicatorId); w.push(`(${a}.applicator_id = ${k} OR EXISTS (SELECT 1 FROM job_stages sx WHERE sx.job_id = ${a}.id AND sx.applicator_id = ${k}))`); }
  if (f.machineId) { const k = p(f.machineId); w.push(`(${a}.machine_id = ${k} OR ${a}.implement_id = ${k})`); }
  if (f.productId) w.push(`${a}.product_id = ${p(f.productId)}`);
  if (f.status) w.push(`${a}.status = ${p(f.status)}`);
  if (f.jobId) w.push(`${a}.id = ${p(f.jobId)}`);
  return w.join(' AND ');
}
// Trabajo con actividad en el rango: creado, programado, con etapa o finalizado dentro del período
function jobInRange(range, params, a = 'j') {
  params.push(range.fromTs, range.toTs, range.from, range.to);
  const n = params.length, f = '$' + (n - 3), t = '$' + (n - 2), fd = '$' + (n - 1), td = '$' + n;
  return `((${a}.created_at >= ${f} AND ${a}.created_at < ${t}) OR (${a}.finished_at >= ${f} AND ${a}.finished_at < ${t})
           OR (${a}.scheduled_date >= ${fd}::date AND ${a}.scheduled_date <= ${td}::date)
           OR EXISTS (SELECT 1 FROM job_stages sr WHERE sr.job_id = ${a}.id AND sr.started_at < ${t} AND COALESCE(sr.ended_at, now()) >= ${f}))`;
}

async function options() {
  const [{ rows: apps }, { rows: machines }, { rows: products }, { rows: jobs }] = await Promise.all([
    db.query("SELECT id, name, username, active FROM users WHERE role = 'aplicador' ORDER BY active DESC, name"),
    db.query('SELECT id, name, kind, active FROM machines ORDER BY active DESC, name'),
    db.query(`SELECT DISTINCT p.id, p.name, p.unit FROM products p
               WHERE p.active OR EXISTS (SELECT 1 FROM jobs j WHERE j.product_id = p.id AND j.deleted_at IS NULL)
                  OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.product_id = p.id) ORDER BY p.name`),
    db.query(`SELECT id, lot_name, status, COALESCE(finished_at, started_at, created_at) AS at FROM jobs
               WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 500`)
  ]);
  return {
    sections: SECTIONS,
    statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
    applicators: apps.map(u => ({ id: Number(u.id), name: u.name || u.username, username: u.username, active: u.active })),
    machines: machines.map(m => ({ id: Number(m.id), name: m.name, kind: m.kind, active: m.active })),
    products: products.map(p => ({ id: Number(p.id), name: p.name, unit: p.unit })),
    jobs: jobs.map(j => ({ id: Number(j.id), lot: j.lot_name, status: j.status, at: j.at }))
  };
}

// ---------- geometría para miniaturas ----------
function simplifyGeom(g, tol) {
  if (!g || !g.type) return null;
  try { return turf.simplify(g.type === 'Feature' ? g : turf.feature(g), { tolerance: tol, highQuality: false }).geometry; } catch (_) { return g.type === 'Feature' ? g.geometry : g; }
}
function geomBbox(gs) {
  let b = null;
  for (const g of gs) {
    if (!g) continue;
    try { const x = turf.bbox(g); if (!x.every(Number.isFinite)) continue; b = b ? [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] : x; } catch (_) { /* geometría inválida */ }
  }
  return b;
}
const r6 = (c) => Array.isArray(c[0]) ? c.map(r6) : [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];
const trimCoords = (g) => g ? { type: g.type, coordinates: r6(g.coordinates) } : null;

// ---------- informe ----------
async function build(q, user) {
  const { range, sections, filters } = parseParams(q);
  const want = new Set(sections);
  const params = [];
  const where = jobWhere(filters, params);
  const inRange = jobInRange(range, params);
  const { rows: jobs } = await db.query(
    `SELECT j.id, j.lot_name, j.status, j.product, j.product_id, j.dose, j.dose_unit, j.liters_per_ha, j.coverage_pct, j.route_pct,
            j.applicator_id, j.machine_id, j.implement_id, j.scheduled_date, j.created_at, j.started_at, j.finished_at,
            j.covered_geometry, z.geometry, p.name AS product_name, p.unit AS product_unit, p.tox_class, p.active_ingredient,
            p.phi_days, p.phi_text, p.reentry_hours, p.reentry_text,
            u.name AS applicator_name, mm.name AS machine_name, im.name AS implement_name, j.machine AS machine_text,
            (SELECT max(ended_at) FROM job_stages s WHERE s.job_id = j.id) AS last_stage_end
       FROM jobs j JOIN zones z ON z.id = j.zone_id
       LEFT JOIN products p ON p.id = j.product_id LEFT JOIN users u ON u.id = j.applicator_id
       LEFT JOIN machines mm ON mm.id = j.machine_id LEFT JOIN machines im ON im.id = j.implement_id
      WHERE ${where} AND ${inRange}
      ORDER BY COALESCE(j.finished_at, j.started_at, j.created_at) DESC, j.id DESC`, params);
  const jobIds = jobs.map(j => Number(j.id));

  // Etapas (totales del trabajo, horas efectivas sin pausas)
  const { rows: stages } = jobIds.length ? await db.query(
    `WITH ${STAGES_CTE}
     SELECT stg.job_id, stg.seq, stg.started_at, stg.ended_at, stg.eff_s, stg.distance_m, u.name AS applicator_name,
            s.route_pct_start, s.route_pct_end
       FROM stg JOIN job_stages s ON s.id = stg.id LEFT JOIN users u ON u.id = stg.applicator_id
      WHERE stg.job_id = ANY($1::bigint[]) ORDER BY stg.job_id DESC, stg.seq`, [jobIds]) : { rows: [] };
  // Condiciones registradas (pronóstico del modelo) al iniciar y cerrar etapas
  const { rows: wx } = jobIds.length && (want.has('trabajos') || want.has('clima')) ? await db.query(
    `SELECT w.*, s.seq FROM job_weather w LEFT JOIN job_stages s ON s.id = w.stage_id
      WHERE w.job_id = ANY($1::bigint[]) ORDER BY w.job_id DESC, w.recorded_at, w.id`, [jobIds]) : { rows: [] };
  const wxStartBy = new Map();
  for (const w of wx) if (w.kind === 'inicio' && !wxStartBy.has(Number(w.job_id))) wxStartBy.set(Number(w.job_id), w);
  const stagesBy = new Map();
  for (const s of stages) { const k = Number(s.job_id); if (!stagesBy.has(k)) stagesBy.set(k, []); stagesBy.get(k).push(s); }

  const jobData = jobs.map(j => {
    const c = jobConsumption(j);
    const st = stagesBy.get(Number(j.id)) || [];
    const hours = st.reduce((s, x) => s + Number(x.eff_s || 0), 0) / 3600;
    const km = st.reduce((s, x) => s + Number(x.distance_m || 0), 0) / 1000;
    const last = j.finished_at || j.last_stage_end || null;
    const lastMs = last ? new Date(last).getTime() : null;
    const phi = j.phi_days != null ? Number(j.phi_days) : null, rh = j.reentry_hours != null ? Number(j.reentry_hours) : null;
    return {
      j, c, st, hours, km, last,
      productName: j.product_name || j.product || null,
      harvestFrom: lastMs != null && phi != null ? new Date(lastMs + phi * 86400e3).toISOString() : null,
      reentryUntil: lastMs != null && rh != null ? new Date(lastMs + rh * 3600e3).toISOString() : null
    };
  });

  const tables = [];
  const kpis = [];
  const notes = [];

  // ---- KPIs (siempre se calculan; la sección decide si se muestran) ----
  const byStatus = { pendiente: 0, en_curso: 0, finalizado: 0, cancelado: 0 };
  let haCov = 0, haPlan = 0, hours = 0, km = 0; const used = { L: 0, kg: 0 };
  const finCov = [];
  for (const d of jobData) {
    byStatus[d.j.status]++;
    haPlan += d.c.areaHa || 0; haCov += d.c.coveredHa || 0; hours += d.hours; km += d.km;
    if (d.c.quantity > 0 && used[d.c.unit] != null) used[d.c.unit] += d.c.quantity;
    if (d.j.status === 'finalizado' && d.c.coveragePct != null) finCov.push(d.c.coveragePct);
  }
  const ap = [];
  const aWhere = jobWhere(filters, ap);
  ap.push(range.fromTs, range.toTs);
  const { rows: alerts } = await db.query(
    `SELECT a.id, a.job_id, a.type, a.severity, a.started_at, a.resolved_at, a.acknowledged_at, a.details,
            j.lot_name, u.name AS applicator_name, ack.name AS ack_name
       FROM alerts a JOIN jobs j ON j.id = a.job_id LEFT JOIN users u ON u.id = j.applicator_id
       LEFT JOIN users ack ON ack.id = a.acknowledged_by
      WHERE ${aWhere} AND a.started_at >= $${ap.length - 1} AND a.started_at < $${ap.length}
      ORDER BY a.started_at DESC`, ap);

  const mp = [range.from, range.to];
  let mvWhere = '';
  if (filters.productId) { mp.push(filters.productId); mvWhere += ` AND m.product_id = $${mp.length}`; }
  if (filters.jobId) { mp.push(filters.jobId); mvWhere += ` AND m.job_id = $${mp.length}`; }
  const { rows: moves } = await db.query(
    `SELECT m.*, p.name AS product_name, j.lot_name, u.name AS created_by_name
       FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN jobs j ON j.id = m.job_id
       LEFT JOIN users u ON u.id = m.created_by
      WHERE (m.job_id IS NULL OR j.deleted_at IS NULL) AND m.moved_on >= $1::date AND m.moved_on <= $2::date ${mvWhere}
      ORDER BY m.moved_on DESC, m.id DESC`, mp);
  const purchases = moves.filter(m => m.kind === 'compra');
  const spent = purchases.reduce((s, m) => s + Number(m.cost_total || 0), 0);

  let exp = null;
  if (want.has('exposicion') || want.has('resumen')) exp = await G.exposure(range);
  const expApps = exp ? exp.applicators.filter(a => !filters.applicatorId || a.applicatorId === filters.applicatorId) : [];
  let stock = null;
  if (want.has('stock') || want.has('productos') || want.has('resumen')) stock = await G.stockSummary();

  kpis.push(
    { key: 'jobs', label: 'Trabajos en el período', value: jobData.length, t: 'int', sub: `${byStatus.finalizado} finalizados · ${byStatus.en_curso} en curso · ${byStatus.pendiente} pendientes · ${byStatus.cancelado} cancelados` },
    { key: 'haCov', label: 'Hectáreas cubiertas', value: round(haCov, 2), t: 'n2', unit: 'ha', sub: `de ${fmtNum(haPlan, 2)} ha planificadas` },
    { key: 'covAvg', label: 'Cobertura promedio (finalizados)', value: finCov.length ? round(finCov.reduce((s, x) => s + x, 0) / finCov.length, 1) : null, t: 'pct' },
    { key: 'hours', label: 'Horas efectivas de aplicación', value: round(hours, 1), t: 'n1', unit: 'h', sub: `${fmtNum(km, 1)} km recorridos` },
    { key: 'used', label: 'Consumo estimado', value: round(used.L, 2), t: 'n2', unit: 'L', sub: used.kg ? `y ${fmtNum(used.kg, 2)} kg` : 'según dosis y superficie cubierta' },
    { key: 'spent', label: 'Compras del período', value: round(spent, 2), t: 'money', sub: `${purchases.length} compras registradas` },
    { key: 'alerts', label: 'Alertas', value: alerts.length, t: 'int', sub: `${alerts.filter(a => a.severity === 'alta').length} altas · ${alerts.filter(a => !a.resolved_at).length} abiertas` },
    { key: 'exposure', label: 'Avisos de exposición', value: expApps.reduce((s, a) => s + a.warnings.length, 0), t: 'int', sub: `${expApps.length} aplicadores con horas registradas` }
  );
  if (want.has('resumen')) {
    tables.push({
      key: 'resumen', title: 'Resumen KPIs',
      columns: [{ key: 'label', h: 'Indicador', w: 3 }, { key: 'value', h: 'Valor', t: 'text', w: 1.4 }, { key: 'sub', h: 'Detalle', w: 4 }],
      rows: kpis.map(k => ({ label: k.label, value: fmtCell({ t: k.t }, k.value) + (k.unit && k.value != null ? ' ' + k.unit : ''), sub: k.sub || '' }))
    });
  }

  // ---- Trabajos + etapas ----
  if (want.has('trabajos')) {
    tables.push({
      key: 'trabajos', title: 'Trabajos',
      columns: [
        { key: 'id', h: 'N°', t: 'int', w: 0.6 }, { key: 'lot', h: 'Lote', w: 1.6 }, { key: 'status', h: 'Estado', w: 1 },
        { key: 'scheduled', h: 'Programado', t: 'date', pdf: false }, { key: 'applicator', h: 'Aplicador', w: 1.4 },
        { key: 'machine', h: 'Máquina', w: 1.2, pdf: false }, { key: 'implement', h: 'Implemento', pdf: false },
        { key: 'product', h: 'Producto', w: 1.6 }, { key: 'tox', h: 'Clase tox.', pdf: false },
        { key: 'dose', h: 'Dosis', t: 'n3', pdf: false }, { key: 'doseUnit', h: 'Unidad dosis', pdf: false },
        { key: 'doseTxt', h: 'Dosis', w: 1, xls: false }, { key: 'lpha', h: 'Caldo L/ha', t: 'n1', pdf: false },
        { key: 'areaHa', h: 'Sup. lote (ha)', t: 'n2', w: 0.8 }, { key: 'covPct', h: '% zona', t: 'pct', w: 0.8 },
        { key: 'covHa', h: 'Ha cubiertas', t: 'n2', w: 0.8 }, { key: 'routePct', h: '% ruta', t: 'pct', w: 0.8 },
        { key: 'stages', h: 'Etapas', t: 'int', w: 0.75 }, { key: 'hours', h: 'Horas', t: 'n2', w: 0.7 }, { key: 'km', h: 'Km', t: 'n2', w: 0.7 },
        { key: 'qty', h: 'Consumo estimado', t: 'n3', pdf: false }, { key: 'unit', h: 'Unidad consumo', pdf: false },
        { key: 'qtyTxt', h: 'Consumo', w: 0.9, xls: false },
        { key: 'last', h: 'Última aplicación', t: 'dt', pdf: false },
        { key: 'phi', h: 'Carencia', pdf: false }, { key: 'harvest', h: 'Cosecha desde', t: 'date', w: 0.9 },
        { key: 'reentry', h: 'Reingreso', pdf: false }, { key: 'reentryUntil', h: 'Reingreso desde', t: 'dt', w: 1.1 },
        { key: 'start', h: 'Inicio', t: 'dt', w: 1.1 }, { key: 'end', h: 'Fin', t: 'dt', w: 1.1 },
        { key: 'wxStart', h: 'Clima al iniciar', pdf: false }
      ],
      rows: jobData.map(d => {
        const j = d.j;
        return {
          id: Number(j.id), lot: j.lot_name || `Trabajo ${j.id}`, status: STATUS_LABELS[j.status] || j.status,
          scheduled: dayStr(j.scheduled_date), applicator: j.applicator_name || '', machine: j.machine_name || j.machine_text || '',
          implement: j.implement_name || '', product: d.productName || '', tox: j.tox_class ? `${j.tox_class} (${TOX_COLORS[j.tox_class] || ''})` : '',
          dose: j.dose != null ? Number(j.dose) : null, doseUnit: j.dose_unit || '',
          doseTxt: j.dose != null ? `${fmtNum(j.dose, 3)} ${j.dose_unit || ''}`.trim() : '',
          lpha: j.liters_per_ha != null ? Number(j.liters_per_ha) : null,
          areaHa: round(d.c.areaHa, 3), covPct: round(d.c.coveragePct, 1), covHa: round(d.c.coveredHa, 3),
          routePct: j.route_pct != null ? round(j.route_pct, 1) : null, stages: d.st.length, hours: round(d.hours, 2), km: round(d.km, 2),
          qty: d.c.quantity > 0 ? round(d.c.quantity, 3) : null, unit: d.c.quantity > 0 ? d.c.unit : '',
          qtyTxt: d.c.quantity > 0 ? `${fmtNum(d.c.quantity, 2)} ${d.c.unit}` : '',
          last: d.last, phi: j.phi_days != null ? `${fmtNum(j.phi_days, 0)} días` : (j.phi_text || ''),
          harvest: d.harvestFrom, reentry: j.reentry_hours != null ? `${fmtNum(j.reentry_hours, 0)} h` : (j.reentry_text || ''),
          reentryUntil: d.reentryUntil, start: j.started_at, end: j.finished_at, wxStart: wxText(wxStartBy.get(Number(j.id)))
        };
      })
    });
    const stRows = [];
    for (const d of jobData) for (const s of d.st) {
      const a = s.route_pct_start != null ? Number(s.route_pct_start) : null, b = s.route_pct_end != null ? Number(s.route_pct_end) : null;
      stRows.push({
        job: Number(d.j.id), lot: d.j.lot_name || '', seq: s.seq, applicator: s.applicator_name || '',
        start: s.started_at, end: s.ended_at, hours: round(Number(s.eff_s || 0) / 3600, 2), km: round(Number(s.distance_m || 0) / 1000, 2),
        pctStart: round(a, 1), pctEnd: round(b, 1), gained: a != null && b != null ? round(Math.max(0, b - a), 1) : null
      });
    }
    tables.push({
      key: 'etapas', title: 'Trabajos: etapas', parent: 'trabajos',
      columns: [
        { key: 'job', h: 'Trabajo', t: 'int', w: 0.7 }, { key: 'lot', h: 'Lote', w: 1.6 }, { key: 'seq', h: 'Etapa', t: 'int', w: 0.6 },
        { key: 'applicator', h: 'Aplicador', w: 1.5 }, { key: 'start', h: 'Inicio', t: 'dt', w: 1.2 }, { key: 'end', h: 'Fin', t: 'dt', w: 1.2 },
        { key: 'hours', h: 'Horas efectivas', t: 'n2', w: 0.9 }, { key: 'km', h: 'Km', t: 'n2', w: 0.7 },
        { key: 'pctStart', h: '% ruta inicio', t: 'pct', w: 0.9 }, { key: 'pctEnd', h: '% ruta fin', t: 'pct', w: 0.9 }, { key: 'gained', h: '% ruta ganado', t: 'pct', w: 0.9 }
      ],
      rows: stRows
    });
  }

  // ---- Aplicaciones por producto ----
  if (want.has('productos')) {
    const by = new Map();
    for (const d of jobData) {
      const key = d.j.product_id ? 'p' + d.j.product_id : 't' + (d.productName || 'Sin producto');
      let r = by.get(key);
      if (!r) {
        r = { productId: d.j.product_id ? Number(d.j.product_id) : null, product: d.productName || 'Sin producto', ai: d.j.active_ingredient || '',
          tox: d.j.tox_class || '', jobs: 0, finished: 0, ha: 0, hours: 0, qty: 0, unit: d.j.product_unit || '', catalog: d.j.product_id ? 'Sí' : 'No (texto libre)' };
        by.set(key, r);
      }
      r.jobs++; if (d.j.status === 'finalizado') r.finished++;
      r.ha += d.c.coveredHa || 0; r.hours += d.hours;
      if (d.c.quantity > 0) { r.qty += d.c.quantity; r.unit = d.c.unit; }
    }
    for (const m of purchases) {
      const key = 'p' + m.product_id;
      let r = by.get(key);
      if (!r) { r = { productId: Number(m.product_id), product: m.product_name, ai: '', tox: '', jobs: 0, finished: 0, ha: 0, hours: 0, qty: 0, unit: m.unit, catalog: 'Sí' }; by.set(key, r); }
      r.bought = (r.bought || 0) + Number(m.quantity); r.cost = (r.cost || 0) + Number(m.cost_total || 0);
    }
    const stockBy = new Map((stock || []).map(s => [s.productId, s]));
    tables.push({
      key: 'productos', title: 'Aplicaciones por producto y consumo',
      columns: [
        { key: 'product', h: 'Producto', w: 2 }, { key: 'ai', h: 'Principio activo', w: 1.6 }, { key: 'tox', h: 'Clase tox.', w: 0.7 },
        { key: 'catalog', h: 'En catálogo', pdf: false }, { key: 'jobs', h: 'Trabajos', t: 'int', w: 0.7 }, { key: 'finished', h: 'Finalizados', t: 'int', w: 0.8 },
        { key: 'ha', h: 'Ha cubiertas', t: 'n2', w: 0.8 }, { key: 'hours', h: 'Horas', t: 'n2', w: 0.7 },
        { key: 'qty', h: 'Consumo estimado', t: 'n3', w: 1 }, { key: 'unit', h: 'Unidad', w: 0.6 },
        { key: 'bought', h: 'Comprado en el período', t: 'n3', w: 1 }, { key: 'cost', h: 'Costo compras', t: 'money', w: 1 },
        { key: 'stock', h: 'Stock actual', t: 'n3', w: 0.9 }
      ],
      rows: [...by.values()].sort((a, b) => b.ha - a.ha || a.product.localeCompare(b.product)).map(r => ({
        ...r, ha: round(r.ha, 3), hours: round(r.hours, 2), qty: r.qty > 0 ? round(r.qty, 3) : null,
        bought: r.bought != null ? round(r.bought, 3) : null, cost: r.cost ? round(r.cost, 2) : null,
        stock: r.productId && stockBy.has(r.productId) ? stockBy.get(r.productId).stock : null
      }))
    });
  }

  // ---- Stock ----
  if (want.has('stock')) {
    const saldos = (stock || []).filter(s => (!filters.productId || s.productId === filters.productId) && (s.active !== false || s.moves));
    tables.push({
      key: 'stock_saldos', title: 'Stock: saldos actuales', parent: 'stock',
      columns: [
        { key: 'name', h: 'Producto', w: 2 }, { key: 'ai', h: 'Principio activo', w: 1.6, pdf: false }, { key: 'unit', h: 'Unidad', w: 0.6 },
        { key: 'purchased', h: 'Comprado', t: 'n3', w: 0.9 }, { key: 'consumed', h: 'Consumido', t: 'n3', w: 0.9 }, { key: 'adjusted', h: 'Ajustes', t: 'n3', w: 0.8 },
        { key: 'stock', h: 'Stock estimado', t: 'n3', w: 1 }, { key: 'threshold', h: 'Stock mínimo', t: 'n3', w: 0.9 }, { key: 'low', h: 'Bajo', w: 0.6 },
        { key: 'unitCost', h: 'Costo unitario', t: 'money', w: 1 }, { key: 'value', h: 'Valor estimado', t: 'money', w: 1 }, { key: 'lastMove', h: 'Último movimiento', t: 'date', w: 1 }
      ],
      rows: saldos.map(s => ({ name: s.name, ai: s.activeIngredient || '', unit: s.unit, purchased: s.purchased, consumed: s.consumed, adjusted: s.adjusted,
        stock: s.stock, threshold: s.threshold, low: s.low ? 'Sí' : 'No', unitCost: s.unitCost, value: s.value, lastMove: dayStr(s.lastMove) }))
    });
    const KIND = { compra: 'Compra', consumo: 'Consumo', ajuste: 'Ajuste' };
    tables.push({
      key: 'stock_movimientos', title: 'Stock: movimientos del período', parent: 'stock',
      columns: [
        { key: 'date', h: 'Fecha', t: 'date', w: 0.8 }, { key: 'kind', h: 'Tipo', w: 0.7 }, { key: 'product', h: 'Producto', w: 1.8 },
        { key: 'qty', h: 'Cantidad', t: 'n3', w: 0.8 }, { key: 'unit', h: 'Unidad', w: 0.5 }, { key: 'supplier', h: 'Proveedor', w: 1.2 },
        { key: 'lot', h: 'Partida', w: 0.8, pdf: false }, { key: 'cost', h: 'Costo total', t: 'money', w: 0.9 },
        { key: 'job', h: 'Trabajo', w: 1.3 }, { key: 'reason', h: 'Motivo', w: 1.6 }
      ],
      rows: moves.map(m => ({ date: dayStr(m.moved_on), kind: KIND[m.kind] || m.kind, product: m.product_name, qty: round(m.quantity, 3), unit: m.unit,
        supplier: m.supplier || '', lot: m.lot || '', cost: m.cost_total != null ? round(m.cost_total, 2) : null,
        job: m.job_id ? `#${m.job_id} ${m.lot_name || ''}`.trim() : '', reason: m.reason || '' }))
    });
    if (filters.applicatorId || filters.machineId || filters.status) notes.push('Stock: los filtros de aplicador, máquina y estado no se aplican a los movimientos ni a los saldos.');
  }

  // ---- Maquinaria ----
  if (want.has('maquinaria')) {
    const machines = (await G.machinesWithStats(range)).filter(m => (!filters.machineId || m.id === filters.machineId) && (m.active || m.rangeJobs));
    const SV = { ok: 'Al día', proximo: 'Próximo', vencido: 'Vencido' };
    tables.push({
      key: 'maquinaria', title: 'Maquinaria',
      columns: [
        { key: 'name', h: 'Máquina', w: 1.8 }, { key: 'type', h: 'Tipo', w: 1 }, { key: 'brand', h: 'Marca / modelo', w: 1.4 }, { key: 'plate', h: 'Dominio', w: 0.8 },
        { key: 'rangeKm', h: 'Km en el período', t: 'n1', w: 0.9 }, { key: 'rangeHours', h: 'Horas en el período', t: 'n1', w: 0.9 }, { key: 'rangeJobs', h: 'Trabajos en el período', t: 'int', w: 0.9 },
        { key: 'totalKm', h: 'Km totales', t: 'n1', w: 0.8 }, { key: 'totalHours', h: 'Horas totales', t: 'n1', w: 0.8 },
        { key: 'nextService', h: 'Próximo service (h)', t: 'n1', w: 0.9 }, { key: 'serviceLeft', h: 'Faltan (h)', t: 'n1', w: 0.7 }, { key: 'service', h: 'Estado service', w: 0.8 },
        { key: 'lastUsed', h: 'Último uso', t: 'dt', w: 1.1 }
      ],
      rows: machines.map(m => ({ name: m.name + (m.example ? ' (ejemplo)' : '') + (m.active ? '' : ' (inactiva)'), type: m.typeName || m.kind,
        brand: [m.brand, m.model].filter(Boolean).join(' '), plate: m.plate || '', rangeKm: m.rangeKm, rangeHours: m.rangeHours, rangeJobs: m.rangeJobs,
        totalKm: m.totalKm, totalHours: m.totalHours, nextService: m.service ? m.service.nextH : null, serviceLeft: m.service ? m.service.leftH : null,
        service: m.service ? SV[m.service.state] : 'Sin plan', lastUsed: m.lastUsed }))
    });
    if (filters.applicatorId || filters.productId || filters.status || filters.jobId) notes.push('Maquinaria: km y horas son de todos los trabajos del período (sólo se aplica el filtro de máquina).');
  }

  // ---- Alertas ----
  if (want.has('alertas')) {
    tables.push({
      key: 'alertas', title: 'Alertas',
      columns: [
        { key: 'date', h: 'Fecha', t: 'dt', w: 1.1 }, { key: 'type', h: 'Tipo', w: 1.6 }, { key: 'severity', h: 'Severidad', w: 0.7 },
        { key: 'job', h: 'Trabajo', t: 'int', w: 0.6 }, { key: 'lot', h: 'Lote', w: 1.5 }, { key: 'applicator', h: 'Aplicador', w: 1.3 },
        { key: 'state', h: 'Estado', w: 0.8 }, { key: 'resolved', h: 'Resuelta', t: 'dt', w: 1.1 }, { key: 'ack', h: 'Revisada por', w: 1.2 }
      ],
      rows: alerts.map(a => ({ date: a.started_at, type: ALERT_TYPES[a.type] || a.type, severity: SEVERITY[a.severity] || a.severity,
        job: Number(a.job_id), lot: a.lot_name || '', applicator: a.applicator_name || '', state: a.resolved_at ? 'Resuelta' : 'Abierta',
        resolved: a.resolved_at, ack: a.acknowledged_at ? `${a.ack_name || ''} ${fmtDateTime(a.acknowledged_at)}`.trim() : '' }))
    });
  }

  // ---- Exposición ----
  if (want.has('exposicion')) {
    tables.push({
      key: 'exposicion', title: 'Exposición por aplicador',
      columns: [
        { key: 'name', h: 'Aplicador', w: 1.6 }, { key: 'total', h: 'Horas totales', t: 'n2', w: 0.9 }, { key: 'high', h: 'Horas alta toxicidad', t: 'n2', w: 1 },
        { key: 'yearHigh', h: 'Alta tox. en el año', t: 'n2', w: 1 }, { key: 'classes', h: 'Horas por clase', w: 2 }, { key: 'warnings', h: 'Avisos', w: 2.4 }
      ],
      rows: expApps.map(a => ({ name: a.name || a.username, total: a.totalHours, high: a.highToxHours,
        yearHigh: Object.values(a.highToxByYear || {}).reduce((s, x) => s + x, 0) || 0,
        classes: Object.entries(a.byClass).map(([k, v]) => `${k}: ${fmtNum(v, 1)} h`).join(' · '),
        warnings: a.warnings.map(w => `${w.type === 'mes' ? 'Mes' : 'Año'} ${w.period}: ${fmtNum(w.hours, 1)} h (límite ${w.limit} h)`).join(' · ') || 'Sin avisos' }))
    });
    const det = [];
    for (const a of expApps) for (const p of a.byProduct) det.push({ name: a.name || a.username, product: p.name, tox: p.toxClass, band: TOX_COLORS[p.toxClass] || '', hours: p.hours, jobs: p.jobs, high: HIGH_TOX.includes(p.toxClass) ? 'Sí' : 'No' });
    tables.push({
      key: 'exposicion_detalle', title: 'Exposición: detalle por producto', parent: 'exposicion',
      columns: [{ key: 'name', h: 'Aplicador', w: 1.6 }, { key: 'product', h: 'Producto', w: 2 }, { key: 'tox', h: 'Clase tox.', w: 0.7 }, { key: 'band', h: 'Banda', w: 0.8 },
        { key: 'hours', h: 'Horas', t: 'n2', w: 0.7 }, { key: 'jobs', h: 'Trabajos', t: 'int', w: 0.7 }, { key: 'high', h: 'Alta toxicidad', w: 0.8 }],
      rows: det
    });
    if (exp) notes.push(`Exposición: límites de alta toxicidad ${exp.settings.exposure.highToxMonthH} h/mes y ${exp.settings.exposure.highToxYearH} h/año (clases ${HIGH_TOX.join(', ')}).`);
    if (filters.productId || filters.machineId || filters.status || filters.jobId) notes.push('Exposición: se calcula con todas las etapas del período (sólo se aplica el filtro de aplicador).');
  }

  // ---- Rendimiento ----
  if (want.has('rendimiento')) {
    const { rows: all } = await db.query(
      `SELECT j.id, j.status, j.applicator_id, j.coverage_pct, j.route_pct, j.finished_at, z.geometry,
              (SELECT max(COALESCE(ended_at, now())) FROM job_stages s WHERE s.job_id = j.id) AS last_activity
         FROM jobs j JOIN zones z ON z.id = j.zone_id WHERE j.deleted_at IS NULL`);
    const jobRows = all.map(j => { const areaHa = zoneHa(j.geometry); return { ...j, covHa: j.coverage_pct != null ? areaHa * Number(j.coverage_pct) / 100 : 0, activity: j.finished_at || j.last_activity || null }; });
    const perf = (await G.applicatorPerformance(range, jobRows)).filter(p => !filters.applicatorId || p.applicatorId === filters.applicatorId);
    tables.push({
      key: 'rendimiento', title: 'Rendimiento por aplicador',
      columns: [
        { key: 'name', h: 'Aplicador', w: 1.6 }, { key: 'username', h: 'Usuario', w: 1, pdf: false }, { key: 'jobs', h: 'Trabajos', t: 'int', w: 0.7 },
        { key: 'stages', h: 'Etapas', t: 'int', w: 0.6 }, { key: 'hours', h: 'Horas', t: 'n2', w: 0.7 }, { key: 'ha', h: 'Ha cubiertas', t: 'n2', w: 0.8 },
        { key: 'haPerHour', h: 'Ha/hora', t: 'n3', w: 0.7 }, { key: 'avgRoutePct', h: '% ruta promedio', t: 'pct', w: 0.9 },
        { key: 'alerts', h: 'Alertas', t: 'int', w: 0.6 }, { key: 'alertsHigh', h: 'Alertas altas', t: 'int', w: 0.8 }, { key: 'avgSpeedKmh', h: 'Velocidad media (km/h)', t: 'n2', w: 1 }
      ],
      rows: perf.map(p => ({ ...p, name: p.name || p.username }))
    });
    if (filters.productId || filters.machineId || filters.status || filters.jobId) notes.push('Rendimiento: se calcula con todos los trabajos del período (sólo se aplica el filtro de aplicador).');
  }

  // ---- Clima (trazabilidad) ----
  if (want.has('clima')) {
    tables.push({
      key: 'clima', title: 'Condiciones meteorológicas',
      columns: [
        { key: 'job', h: 'Trabajo', t: 'int', w: 0.65 }, { key: 'lot', h: 'Lote', w: 1.4 }, { key: 'seq', h: 'Etapa', t: 'int', w: 0.55 },
        { key: 'kind', h: 'Momento', w: 0.9 }, { key: 'at', h: 'Fecha y hora', t: 'dt', w: 1.15 },
        { key: 'temp', h: 'Temp. (°C)', t: 'n1', w: 0.7 }, { key: 'rh', h: 'HR (%)', t: 'n1', w: 0.6 }, { key: 'deltaT', h: 'ΔT', t: 'n1', w: 0.5 },
        { key: 'wind', h: 'Viento (km/h)', t: 'n1', w: 0.75 }, { key: 'gust', h: 'Ráfagas (km/h)', t: 'n1', w: 0.8 }, { key: 'dir', h: 'Dirección', w: 0.6 },
        { key: 'precip', h: 'Lluvia (mm)', t: 'n1', w: 0.65 }, { key: 'prob', h: 'Prob. lluvia (%)', t: 'n1', w: 0.75, pdf: false },
        { key: 'status', h: 'Ventana', w: 0.8 }, { key: 'reasons', h: 'Motivos', w: 2.2 }, { key: 'source', h: 'Fuente', pdf: false }
      ],
      rows: wx.map(w => ({
        job: Number(w.job_id), lot: (jobData.find(d => Number(d.j.id) === Number(w.job_id)) || { j: {} }).j.lot_name || '',
        seq: w.seq != null ? Number(w.seq) : null, kind: w.kind === 'inicio' ? 'Inicio etapa' : 'Fin etapa', at: w.recorded_at,
        temp: w.temp, rh: w.rh, deltaT: w.delta_t, wind: w.wind, gust: w.gust, dir: cardinalOf(w.wind_dir), precip: w.precip, prob: w.precip_prob,
        status: WX_STATUS[w.status] || w.status || '', reasons: Array.isArray(w.reasons) ? w.reasons.join('; ') : '', source: WX_SOURCE[w.source] || w.source || ''
      }))
    });
    notes.push('Condiciones meteorológicas: valores del modelo de pronóstico para el centroide del lote (viento a 10 m), no de una estación en el lote.');
  }

  // ---- Miniaturas de cobertura ----
  let maps = [];
  if (want.has('trabajos')) {
    const withGeo = jobData.filter(d => d.j.geometry).slice(0, MAX_MAPS);
    const ids = withGeo.map(d => Number(d.j.id));
    const { rows: tp } = ids.length ? await db.query(
      `SELECT job_id, lng, lat FROM (
         SELECT job_id, lng, lat, recorded_at, row_number() OVER (PARTITION BY job_id ORDER BY recorded_at) AS rn,
                count(*) OVER (PARTITION BY job_id) AS n
           FROM track_points WHERE job_id = ANY($1::bigint[]) AND cleared_at IS NULL) t
        WHERE n <= 400 OR rn % CEIL(n / 400.0)::int = 0 ORDER BY job_id, recorded_at`, [ids]) : { rows: [] };
    const trackBy = new Map();
    for (const p of tp) { const k = Number(p.job_id); if (!trackBy.has(k)) trackBy.set(k, []); trackBy.get(k).push([Number(p.lng), Number(p.lat)]); }
    maps = withGeo.map(d => {
      const zone = d.j.geometry.type === 'Feature' ? d.j.geometry.geometry : d.j.geometry;
      const bbox = geomBbox([zone]);
      const tol = bbox ? Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 400 : 0.00001;
      const pts = trackBy.get(Number(d.j.id)) || [];
      const track = pts.length > 1 ? simplifyGeom({ type: 'LineString', coordinates: pts }, tol) : null;
      const covered = d.j.covered_geometry ? simplifyGeom(d.j.covered_geometry, tol) : null;
      return {
        id: Number(d.j.id), lot: d.j.lot_name || `Trabajo ${d.j.id}`, status: d.j.status,
        coveragePct: round(d.c.coveragePct, 1), coveredHa: round(d.c.coveredHa, 2), areaHa: round(d.c.areaHa, 2),
        bbox: geomBbox([zone, covered, track]),
        zone: trimCoords(simplifyGeom(zone, tol)), covered: trimCoords(covered), track: trimCoords(track)
      };
    });
    if (jobData.length > MAX_MAPS) notes.push(`Mapas: se muestran las miniaturas de los primeros ${MAX_MAPS} trabajos.`);
  }

  // ---- metadatos ----
  const names = await resolveFilterNames(filters);
  return {
    meta: {
      title: 'Sistema de Fumigación', subtitle: 'Informe de seguimiento',
      range: { from: range.from, to: range.to }, filters, filterLabels: names, sections,
      sectionTitles: sections.map(k => SECTIONS.find(s => s.key === k).title),
      generatedAt: new Date().toISOString(), generatedBy: user ? (user.name || user.username) : '', generatedByRole: user ? user.role : '',
      notes
    },
    kpis, tables, maps
  };
}

async function resolveFilterNames(f) {
  const out = [];
  const one = async (sql, id) => { const { rows } = await db.query(sql, [id]); return rows[0] || null; };
  if (f.applicatorId) { const r = await one('SELECT name, username FROM users WHERE id = $1', f.applicatorId); out.push({ label: 'Aplicador', value: r ? (r.name || r.username) : `#${f.applicatorId}` }); }
  if (f.machineId) { const r = await one('SELECT name FROM machines WHERE id = $1', f.machineId); out.push({ label: 'Máquina', value: r ? r.name : `#${f.machineId}` }); }
  if (f.productId) { const r = await one('SELECT name FROM products WHERE id = $1', f.productId); out.push({ label: 'Producto', value: r ? r.name : `#${f.productId}` }); }
  if (f.status) out.push({ label: 'Estado', value: STATUS_LABELS[f.status] });
  if (f.jobId) { const r = await one('SELECT lot_name FROM jobs WHERE id = $1', f.jobId); out.push({ label: 'Lote / trabajo', value: `#${f.jobId}${r && r.lot_name ? ' ' + r.lot_name : ''}` }); }
  return out;
}

// Columnas por destino: el PDF/vista previa usan las compactas; Excel/CSV las completas
const colsFor = (t, target) => t.columns.filter(c => target === 'pdf' ? c.pdf !== false : c.xls !== false);

module.exports = { SECTIONS, SECTION_KEYS, STATUS_LABELS, parseParams, options, build, fmtCell, fmtNum, fmtDate, fmtDateTime, colsFor, localParts };
