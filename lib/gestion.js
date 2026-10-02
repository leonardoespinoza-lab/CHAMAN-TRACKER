// Gestión: consumo de productos por trabajo, stock estimado, km/horas de máquinas, exposición de
// aplicadores y datos del tablero ejecutivo. Todo se calcula a partir de las etapas GPS de los trabajos.
const db = require('./db');
const ZoneGeo = require('../zone-geo');

const TZ = 'America/Argentina/Buenos_Aires';
const HIGH_TOX = ['Ia', 'Ib', 'II'];
const TOX_CLASSES = ['Ia', 'Ib', 'II', 'III', 'IV', 'S/D'];
const TOX_COLORS = { Ia: 'Rojo', Ib: 'Rojo', II: 'Amarillo', III: 'Azul', IV: 'Verde', 'S/D': 'Sin dato' };
const CATEGORIES = ['insecticida', 'acaricida', 'insecticida-acaricida', 'fungicida', 'bactericida', 'raleador',
  'fitorregulador', 'aceite', 'coadyuvante', 'herbicida', 'otro'];

// ---------- configuración de gestión ----------
const SETTINGS_DEFAULTS = { exposure: { highToxMonthH: 40, highToxYearH: 300 } };
const SETTINGS_LIMITS = { 'exposure.highToxMonthH': [1, 744], 'exposure.highToxYearH': [1, 8784] };
function normalizeSettings(input, strict) {
  const out = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  for (const g of Object.keys(SETTINGS_DEFAULTS)) {
    const gi = src[g] && typeof src[g] === 'object' ? src[g] : {};
    for (const k of Object.keys(SETTINGS_DEFAULTS[g])) {
      if (gi[k] === undefined || gi[k] === null || gi[k] === '') continue;
      const n = Number(gi[k]);
      const [min, max] = SETTINGS_LIMITS[g + '.' + k];
      if (!Number.isFinite(n) || n < min || n > max) { if (strict) errors.push({ field: g + '.' + k, min, max }); continue; }
      out[g][k] = n;
    }
  }
  return { value: out, errors };
}
async function getSettings() {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'gestion'");
  return normalizeSettings(rows[0] ? rows[0].value : {}).value;
}

// ---------- consumo ----------
// Unidades de dosis: por 100 litros de caldo (hL) o por hectárea. Devuelve factor a L o kg.
const DOSE_UNITS = {
  'cc/hl': { per: 'hl', f: 0.001, u: 'L' }, 'ml/hl': { per: 'hl', f: 0.001, u: 'L' }, 'l/hl': { per: 'hl', f: 1, u: 'L' },
  'g/hl': { per: 'hl', f: 0.001, u: 'kg' }, 'kg/hl': { per: 'hl', f: 1, u: 'kg' },
  'l/ha': { per: 'ha', f: 1, u: 'L' }, 'cc/ha': { per: 'ha', f: 0.001, u: 'L' }, 'ml/ha': { per: 'ha', f: 0.001, u: 'L' },
  'kg/ha': { per: 'ha', f: 1, u: 'kg' }, 'g/ha': { per: 'ha', f: 0.001, u: 'kg' }
};
function zoneHa(geometry) {
  try { return geometry ? ZoneGeo.areaM2(geometry) / 10000 : 0; } catch (_) { return 0; }
}
// Cantidad de producto para "ha" hectáreas cubiertas con la fórmula del trabajo
function consumptionFor({ dose, doseUnit, litersPerHa, ha, productUnit }) {
  const d = dose != null ? Number(dose) : NaN;
  if (!Number.isFinite(d) || d <= 0) return { error: 'El trabajo no tiene dosis' };
  const du = DOSE_UNITS[String(doseUnit || '').toLowerCase().replace(/\s/g, '')];
  if (!du) return { error: `Unidad de dosis "${doseUnit || '–'}" sin conversión automática` };
  let qty, formula;
  const haTxt = round(ha, 3);
  if (du.per === 'hl') {
    const lpha = litersPerHa != null ? Number(litersPerHa) : NaN;
    if (!Number.isFinite(lpha) || lpha <= 0) return { error: 'Dosis por 100 L: falta el caldo (litros/ha)' };
    const caldo = lpha * ha;
    qty = d * du.f * caldo / 100;
    formula = `${d} ${doseUnit} × ${round(caldo, 1)} L de caldo (${lpha} L/ha × ${haTxt} ha) ÷ 100`;
  } else {
    qty = d * du.f * ha;
    formula = `${d} ${doseUnit} × ${haTxt} ha`;
  }
  let unit = du.u, unitMismatch = false;
  if (productUnit && productUnit !== unit) { unitMismatch = true; unit = productUnit; } // se toma densidad 1
  return { quantity: qty, unit, formula, unitMismatch, ha };
}

const JOB_FORMULA_SELECT = `
  SELECT j.id, j.status, j.deleted_at, j.product_id, j.dose, j.dose_unit, j.liters_per_ha, j.coverage_pct, j.finished_at,
         z.geometry, p.unit AS product_unit, p.name AS product_name,
         (SELECT count(*) FROM job_stages s WHERE s.job_id = j.id AND s.ended_at IS NULL)::int AS open_stages,
         (SELECT count(*) FROM job_stages s WHERE s.job_id = j.id)::int AS stage_count,
         (SELECT max(ended_at) FROM job_stages s WHERE s.job_id = j.id) AS last_end
    FROM jobs j JOIN zones z ON z.id = j.zone_id LEFT JOIN products p ON p.id = j.product_id`;

// Consumo estimado de un trabajo (sin guardar): ha cubiertas = superficie del lote × % de zona cubierta
function jobConsumption(row) {
  const areaHa = zoneHa(row.geometry);
  const covPct = row.coverage_pct != null ? Number(row.coverage_pct) : null;
  const ha = covPct != null ? areaHa * covPct / 100 : 0;
  const base = { areaHa, coveredHa: ha, coveragePct: covPct };
  if (!row.product_id) return { ...base, error: 'Producto en texto libre (sin vincular al catálogo): no descuenta stock' };
  if (covPct == null || ha <= 0) return { ...base, error: 'Todavía no hay superficie cubierta' };
  return { ...base, ...consumptionFor({ dose: row.dose, doseUnit: row.dose_unit, litersPerHa: row.liters_per_ha, ha, productUnit: row.product_unit }) };
}

// Guarda (o borra) el movimiento de consumo del trabajo. Se llama al cerrar una etapa o finalizar.
async function updateJobConsumption(jobId) {
  const { rows: [row] } = await db.query(`${JOB_FORMULA_SELECT} WHERE j.id = $1`, [jobId]);
  if (!row) return null;
  const c = jobConsumption(row);
  if (!row.stage_count || c.error || !(c.quantity > 0)) {
    await db.query("DELETE FROM stock_movements WHERE job_id = $1 AND kind = 'consumo'", [jobId]);
    return c;
  }
  const day = row.finished_at || row.last_end || new Date();
  await db.query(
    `INSERT INTO stock_movements (product_id, kind, quantity, unit, moved_on, job_id, details, reason)
     VALUES ($1, 'consumo', $2, $3, ($4::timestamptz AT TIME ZONE '${TZ}')::date, $5, $6, 'Consumo del trabajo')
     ON CONFLICT (job_id) WHERE kind = 'consumo' DO UPDATE
       SET product_id = EXCLUDED.product_id, quantity = EXCLUDED.quantity, unit = EXCLUDED.unit,
           moved_on = EXCLUDED.moved_on, details = EXCLUDED.details, updated_at = now()`,
    [row.product_id, -c.quantity, c.unit, day, jobId,
     JSON.stringify({ coveredHa: c.coveredHa, areaHa: c.areaHa, coveragePct: c.coveragePct, formula: c.formula, unitMismatch: c.unitMismatch || undefined, partial: row.status !== 'finalizado' || undefined })]);
  return c;
}
// Después de recalcular la zona cubierta: sólo con todas las etapas cerradas (o finalizado)
async function afterCoverage(jobId) {
  const { rows: [r] } = await db.query(
    `SELECT j.status, (SELECT count(*) FROM job_stages s WHERE s.job_id = j.id AND s.ended_at IS NULL)::int AS open FROM jobs j WHERE j.id = $1`, [jobId]);
  if (!r) return;
  if (r.status === 'finalizado' || r.status === 'cancelado' || (r.status === 'en_curso' && !r.open)) await updateJobConsumption(jobId);
}

// ---------- utilidades ----------
function round(v, d = 2) { if (v == null || !Number.isFinite(Number(v))) return null; const k = 10 ** d; return Math.round(Number(v) * k) / k; }
// Rango de fechas (AAAA-MM-DD, hora Argentina). Por defecto: últimos 90 días
function parseRange(q) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  let to = re.test(q.to || '') ? q.to : today;
  let from = re.test(q.from || '') ? q.from : new Date(Date.parse(to) - 89 * 86400e3).toISOString().slice(0, 10);
  if (from > to) [from, to] = [to, from];
  return { from, to, fromTs: `${from}T00:00:00-03:00`, toTs: new Date(Date.parse(`${to}T00:00:00-03:00`) + 86400e3).toISOString() };
}

// Etapas con su duración efectiva (sin pausas) y datos del trabajo; trabajos eliminados afuera
const STAGES_CTE = `
  stg AS (
    SELECT st.id, st.job_id, st.seq, st.started_at, st.ended_at, COALESCE(st.applicator_id, j.applicator_id) AS applicator_id,
           COALESCE(st.distance_m, 0) AS distance_m, j.machine_id, j.implement_id, j.product_id, j.product, j.status,
           GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(st.ended_at, now()) - st.started_at)) - COALESCE(pz.s, 0)) AS eff_s
      FROM job_stages st JOIN jobs j ON j.id = st.job_id
      LEFT JOIN LATERAL (
        SELECT sum(EXTRACT(EPOCH FROM (LEAST(COALESCE(p.resumed_at, now()), COALESCE(st.ended_at, now())) - GREATEST(p.paused_at, st.started_at)))) AS s
          FROM job_pauses p
         WHERE p.job_id = st.job_id AND p.paused_at < COALESCE(st.ended_at, now()) AND COALESCE(p.resumed_at, now()) > st.started_at
      ) pz ON true
     WHERE j.deleted_at IS NULL
  )`;

// ---------- máquinas ----------
async function machinesWithStats(range) {
  const params = [];
  let rangeSql = '';
  if (range) { params.push(range.fromTs, range.toTs); rangeSql = 'AND stg.started_at >= $1 AND stg.started_at < $2'; }
  const { rows } = await db.query(
    `WITH ${STAGES_CTE}
     SELECT m.*, mt.name AS type_name, mt.kind AS type_kind,
            COALESCE(s.km, 0) AS gps_km, COALESCE(s.hours, 0) AS gps_hours, COALESCE(s.jobs, 0) AS jobs,
            COALESCE(t.km, 0) AS total_gps_km, COALESCE(t.hours, 0) AS total_gps_hours, t.last_used
       FROM machines m LEFT JOIN machine_types mt ON mt.id = m.type_id
       LEFT JOIN LATERAL (
         SELECT sum(stg.distance_m) / 1000 AS km, sum(stg.eff_s) / 3600 AS hours, count(DISTINCT stg.job_id)::int AS jobs
           FROM stg WHERE (stg.machine_id = m.id OR stg.implement_id = m.id) ${rangeSql}) s ON true
       LEFT JOIN LATERAL (
         SELECT sum(stg.distance_m) / 1000 AS km, sum(stg.eff_s) / 3600 AS hours, max(COALESCE(stg.ended_at, now())) AS last_used
           FROM stg WHERE stg.machine_id = m.id OR stg.implement_id = m.id) t ON true
      ORDER BY m.active DESC, m.kind, m.name`, params);
  return rows.map(machineToJson);
}
function machineToJson(m) {
  const totalKm = Number(m.base_km || 0) + Number(m.total_gps_km || 0);
  const totalH = Number(m.base_hours || 0) + Number(m.total_gps_hours || 0);
  let service = null;
  if (m.service_every_h) {
    const next = Number(m.last_service_h || 0) + Number(m.service_every_h);
    const left = next - totalH;
    service = { everyH: Number(m.service_every_h), lastH: m.last_service_h != null ? Number(m.last_service_h) : null, nextH: round(next, 1),
      leftH: round(left, 1), state: left <= 0 ? 'vencido' : (left <= Number(m.service_every_h) * 0.1 ? 'proximo' : 'ok') };
  }
  return {
    id: Number(m.id), typeId: m.type_id != null ? Number(m.type_id) : null, typeName: m.type_name || null, kind: m.kind,
    name: m.name, brand: m.brand, model: m.model, plate: m.plate, year: m.year, tankL: m.tank_l != null ? Number(m.tank_l) : null,
    baseKm: Number(m.base_km || 0), baseHours: Number(m.base_hours || 0),
    gpsKm: round(m.total_gps_km, 2) || 0, gpsHours: round(m.total_gps_hours, 2) || 0,
    rangeKm: round(m.gps_km, 2) || 0, rangeHours: round(m.gps_hours, 2) || 0, rangeJobs: m.jobs || 0,
    totalKm: round(totalKm, 1), totalHours: round(totalH, 1), lastUsed: m.last_used || null,
    service, notes: m.notes, example: !!m.example, active: !!m.active, createdAt: m.created_at
  };
}

// ---------- stock ----------
async function stockSummary() {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.active_ingredient, p.category, p.unit, p.tox_class, p.low_stock_threshold, p.active, p.source,
            COALESCE(sum(m.quantity) FILTER (WHERE m.kind = 'compra'), 0) AS purchased,
            COALESCE(-sum(m.quantity) FILTER (WHERE m.kind = 'consumo'), 0) AS consumed,
            COALESCE(sum(m.quantity) FILTER (WHERE m.kind = 'ajuste'), 0) AS adjusted,
            COALESCE(sum(m.quantity), 0) AS stock,
            sum(m.cost_total) FILTER (WHERE m.kind = 'compra' AND m.cost_total IS NOT NULL) AS cost_sum,
            sum(m.quantity) FILTER (WHERE m.kind = 'compra' AND m.cost_total IS NOT NULL) AS cost_qty,
            max(m.moved_on) AS last_move, count(m.id)::int AS moves,
            bool_or(m.example) AS has_example
       FROM products p
       JOIN stock_movements m ON m.product_id = p.id
       LEFT JOIN jobs j ON j.id = m.job_id
      WHERE m.job_id IS NULL OR j.deleted_at IS NULL
      GROUP BY p.id
      UNION ALL
     SELECT p.id, p.name, p.active_ingredient, p.category, p.unit, p.tox_class, p.low_stock_threshold, p.active, p.source,
            0, 0, 0, 0, NULL, NULL, NULL, 0, false
       FROM products p
      WHERE p.low_stock_threshold IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM stock_movements m LEFT JOIN jobs j ON j.id = m.job_id
                         WHERE m.product_id = p.id AND (m.job_id IS NULL OR j.deleted_at IS NULL))
      ORDER BY name`);
  return rows.map(r => {
    const unitCost = r.cost_qty > 0 ? Number(r.cost_sum) / Number(r.cost_qty) : null;
    const stock = Number(r.stock);
    const thr = r.low_stock_threshold != null ? Number(r.low_stock_threshold) : null;
    return {
      productId: Number(r.id), name: r.name, activeIngredient: r.active_ingredient, category: r.category, unit: r.unit,
      toxClass: r.tox_class, source: r.source, active: r.active,
      purchased: round(r.purchased, 3), consumed: round(r.consumed, 3), adjusted: round(r.adjusted, 3), stock: round(stock, 3),
      threshold: thr, low: thr != null ? stock <= thr : stock < 0, negative: stock < 0,
      unitCost: round(unitCost, 2), value: unitCost != null ? round(Math.max(0, stock) * unitCost, 2) : null,
      lastMove: r.last_move, moves: r.moves, hasExample: !!r.has_example
    };
  });
}

// ---------- exposición ----------
async function exposure(range) {
  const settings = await getSettings();
  const { rows } = await db.query(
    `WITH ${STAGES_CTE}
     SELECT stg.applicator_id, u.name AS applicator_name, u.username, u.active AS user_active,
            stg.product_id, COALESCE(p.name, stg.product, 'Sin producto') AS product_name,
            COALESCE(p.tox_class, 'S/D') AS tox_class,
            to_char(stg.started_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS month,
            sum(stg.eff_s) / 3600 AS hours, count(DISTINCT stg.job_id)::int AS jobs
       FROM stg LEFT JOIN users u ON u.id = stg.applicator_id LEFT JOIN products p ON p.id = stg.product_id
      WHERE stg.applicator_id IS NOT NULL AND stg.started_at >= $1 AND stg.started_at < $2
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
      ORDER BY 2, 8, 6`, [range.fromTs, range.toTs]);
  // Horas de alta toxicidad por mes y por año (todo el historial del año, no sólo el rango)
  const { rows: yr } = await db.query(
    `WITH ${STAGES_CTE}
     SELECT stg.applicator_id, to_char(stg.started_at AT TIME ZONE '${TZ}', 'YYYY') AS year,
            to_char(stg.started_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS month, sum(stg.eff_s) / 3600 AS hours
       FROM stg LEFT JOIN products p ON p.id = stg.product_id
      WHERE stg.applicator_id IS NOT NULL AND COALESCE(p.tox_class, 'S/D') = ANY($1)
        AND stg.started_at >= date_trunc('year', $2::timestamptz AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'
        AND stg.started_at < $3
      GROUP BY 1, 2, 3`, [HIGH_TOX, range.fromTs, range.toTs]);
  const byApp = new Map();
  for (const r of rows) {
    const id = Number(r.applicator_id);
    let a = byApp.get(id);
    if (!a) { a = { applicatorId: id, name: r.applicator_name, username: r.username, active: r.user_active, totalHours: 0, highToxHours: 0, byClass: {}, byProduct: [], byMonth: {}, warnings: [] }; byApp.set(id, a); }
    const h = Number(r.hours);
    a.totalHours += h;
    if (HIGH_TOX.includes(r.tox_class)) a.highToxHours += h;
    a.byClass[r.tox_class] = (a.byClass[r.tox_class] || 0) + h;
    const m = a.byMonth[r.month] || (a.byMonth[r.month] = { total: 0, highTox: 0 });
    m.total += h; if (HIGH_TOX.includes(r.tox_class)) m.highTox += h;
    let bp = a.byProduct.find(x => x.productId === (r.product_id != null ? Number(r.product_id) : null) && x.name === r.product_name);
    if (!bp) { bp = { productId: r.product_id != null ? Number(r.product_id) : null, name: r.product_name, toxClass: r.tox_class, hours: 0, jobs: 0 }; a.byProduct.push(bp); }
    bp.hours += h; bp.jobs += r.jobs;
  }
  const monthLimit = settings.exposure.highToxMonthH, yearLimit = settings.exposure.highToxYearH;
  const yearly = new Map();
  for (const r of yr) {
    const id = Number(r.applicator_id);
    const y = yearly.get(id) || { years: {}, months: {} };
    y.years[r.year] = (y.years[r.year] || 0) + Number(r.hours);
    y.months[r.month] = Number(r.hours);
    yearly.set(id, y);
  }
  for (const a of byApp.values()) {
    const y = yearly.get(a.applicatorId) || { years: {}, months: {} };
    a.highToxByYear = Object.fromEntries(Object.entries(y.years).map(([k, v]) => [k, round(v, 2)]));
    for (const [month, h] of Object.entries(y.months)) {
      if (h > monthLimit) a.warnings.push({ type: 'mes', period: month, hours: round(h, 1), limit: monthLimit });
    }
    for (const [year, h] of Object.entries(y.years)) {
      if (h > yearLimit) a.warnings.push({ type: 'anio', period: year, hours: round(h, 1), limit: yearLimit });
    }
    a.totalHours = round(a.totalHours, 2); a.highToxHours = round(a.highToxHours, 2);
    for (const k of Object.keys(a.byClass)) a.byClass[k] = round(a.byClass[k], 2);
    for (const k of Object.keys(a.byMonth)) { a.byMonth[k].total = round(a.byMonth[k].total, 2); a.byMonth[k].highTox = round(a.byMonth[k].highTox, 2); }
    for (const p of a.byProduct) p.hours = round(p.hours, 2);
    a.byProduct.sort((x, z) => z.hours - x.hours);
  }
  return { range, settings, highToxClasses: HIGH_TOX, applicators: [...byApp.values()].sort((x, z) => z.totalHours - x.totalHours) };
}

// ---------- tablero ----------
async function dashboard(range) {
  const [{ rows: users }, { rows: jobs }, { rows: alertsOpen }, { rows: openStages }] = await Promise.all([
    db.query('SELECT role, active, count(*)::int AS n FROM users GROUP BY 1, 2'),
    db.query(
      `SELECT j.id, j.status, j.lot_name, j.product, j.product_id, j.dose, j.dose_unit, j.liters_per_ha, j.coverage_pct, j.route_pct,
              j.applicator_id, j.machine_id, j.implement_id, j.created_at, j.started_at, j.finished_at, z.geometry,
              p.name AS product_name, p.unit AS product_unit, p.tox_class, u.name AS applicator_name,
              (SELECT max(COALESCE(ended_at, now())) FROM job_stages s WHERE s.job_id = j.id) AS last_activity
         FROM jobs j JOIN zones z ON z.id = j.zone_id LEFT JOIN products p ON p.id = j.product_id
         LEFT JOIN users u ON u.id = j.applicator_id
        WHERE j.deleted_at IS NULL`),
    db.query(`SELECT a.severity, count(*)::int AS n FROM alerts a JOIN jobs j ON j.id = a.job_id
               WHERE a.resolved_at IS NULL AND j.deleted_at IS NULL GROUP BY 1`),
    db.query(`SELECT count(DISTINCT COALESCE(s.applicator_id, j.applicator_id))::int AS n FROM job_stages s JOIN jobs j ON j.id = s.job_id
               WHERE s.ended_at IS NULL AND j.deleted_at IS NULL AND j.status = 'en_curso'`)
  ]);
  const fromMs = Date.parse(range.fromTs), toMs = Date.parse(range.toTs);
  const inRange = (d) => { const t = d ? new Date(d).getTime() : NaN; return t >= fromMs && t < toMs; };
  const monthStart = Date.parse(new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 7) + '-01T00:00:00-03:00');
  const statusCount = { pendiente: 0, en_curso: 0, finalizado: 0, cancelado: 0 };
  const statusInRange = { pendiente: 0, en_curso: 0, finalizado: 0, cancelado: 0 };
  let haMonth = 0, haRange = 0;
  const weeks = new Map();
  const jobRows = [];
  for (const j of jobs) {
    statusCount[j.status]++;
    const activity = j.finished_at || j.last_activity || null;
    if (inRange(j.created_at) || inRange(activity)) statusInRange[j.status]++;
    const areaHa = zoneHa(j.geometry);
    const covHa = j.coverage_pct != null ? areaHa * Number(j.coverage_pct) / 100 : 0;
    if (activity && new Date(activity).getTime() >= monthStart && (j.status === 'finalizado' || j.status === 'en_curso')) haMonth += covHa;
    if (activity && inRange(activity) && (j.status === 'finalizado' || j.status === 'en_curso' || j.status === 'cancelado')) {
      haRange += covHa;
      const wk = weekStart(new Date(activity));
      weeks.set(wk, (weeks.get(wk) || 0) + covHa);
    }
    jobRows.push({ ...j, areaHa, covHa, activity });
  }
  // Semanas del rango (con ceros)
  const haWeek = [];
  for (let t = Date.parse(weekStart(new Date(fromMs)) + 'T12:00:00-03:00'); t < toMs; t += 7 * 86400e3) {
    const k = new Date(t - 3 * 3600e3).toISOString().slice(0, 10);
    haWeek.push({ week: k, ha: round(weeks.get(k) || 0, 3) });
  }
  // Consumo y compras del rango por producto
  const { rows: mv } = await db.query(
    `SELECT m.product_id, p.name, p.unit, m.kind, sum(m.quantity) AS q, sum(m.cost_total) AS cost
       FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN jobs j ON j.id = m.job_id
      WHERE (m.job_id IS NULL OR j.deleted_at IS NULL) AND m.moved_on >= $1::date AND m.moved_on <= $2::date
      GROUP BY 1, 2, 3, 4`, [range.from, range.to]);
  const used = { L: 0, kg: 0 }, bought = { L: 0, kg: 0 };
  let spent = 0;
  const consByProduct = new Map();
  for (const r of mv) {
    const q = Number(r.q);
    if (r.kind === 'consumo') {
      used[r.unit] += -q;
      const c = consByProduct.get(Number(r.product_id)) || { productId: Number(r.product_id), name: r.name, unit: r.unit, used: 0, bought: 0 };
      c.used += -q; consByProduct.set(c.productId, c);
    } else if (r.kind === 'compra') {
      bought[r.unit] += q; spent += Number(r.cost || 0);
      const c = consByProduct.get(Number(r.product_id)) || { productId: Number(r.product_id), name: r.name, unit: r.unit, used: 0, bought: 0 };
      c.bought += q; consByProduct.set(c.productId, c);
    }
  }
  const stock = await stockSummary();
  const stockValue = stock.reduce((s, x) => s + (x.value || 0), 0);
  const machines = await machinesWithStats(range);
  const exp = await exposure(range);
  const perf = await applicatorPerformance(range, jobRows);
  const roleCount = (role, active = true) => users.filter(u => u.role === role && u.active === active).reduce((s, u) => s + u.n, 0);
  return {
    range,
    kpis: {
      users: users.filter(u => u.active).reduce((s, u) => s + u.n, 0),
      usersByRole: { admin: roleCount('admin'), supervisor: roleCount('supervisor'), aplicador: roleCount('aplicador') },
      applicatorsActive: roleCount('aplicador'), applicatorsWorkingNow: openStages[0] ? openStages[0].n : 0,
      machines: machines.filter(m => m.active).length, machinesExample: machines.filter(m => m.example).length,
      machinesServiceDue: machines.filter(m => m.active && m.service && m.service.state !== 'ok').length,
      jobsByStatus: statusCount, jobsByStatusInRange: statusInRange,
      haMonth: round(haMonth, 3), haRange: round(haRange, 3),
      used: { L: round(used.L, 2), kg: round(used.kg, 2) }, bought: { L: round(bought.L, 2), kg: round(bought.kg, 2) }, spent: round(spent, 2),
      stockProducts: stock.length, stockLow: stock.filter(s => s.low).length, stockValue: round(stockValue, 2),
      stockValueMissing: stock.filter(s => s.stock > 0 && s.value == null).length,
      alertsOpen: alertsOpen.reduce((s, a) => s + a.n, 0), alertsOpenHigh: alertsOpen.filter(a => a.severity === 'alta').reduce((s, a) => s + a.n, 0),
      exposureWarnings: exp.applicators.reduce((s, a) => s + a.warnings.length, 0)
    },
    haWeek,
    consumption: [...consByProduct.values()].map(c => ({ ...c, used: round(c.used, 3), bought: round(c.bought, 3) })).sort((a, b) => b.used - a.used),
    stock: stock.filter(s => s.active !== false).sort((a, b) => (b.low - a.low) || a.name.localeCompare(b.name)),
    machines: machines.filter(m => m.active),
    applicators: perf,
    exposure: exp.applicators.map(a => ({ applicatorId: a.applicatorId, name: a.name, totalHours: a.totalHours, highToxHours: a.highToxHours, byClass: a.byClass, warnings: a.warnings })),
    exposureSettings: exp.settings
  };
}
function weekStart(d) {
  const local = new Date(d.getTime() - 3 * 3600e3);
  const dow = (local.getUTCDay() + 6) % 7; // lunes = 0
  return new Date(local.getTime() - dow * 86400e3).toISOString().slice(0, 10);
}

// Rendimiento por aplicador en el rango: ha/hora, % de ruta, alertas, velocidad media
async function applicatorPerformance(range, jobRows) {
  const { rows } = await db.query(
    `WITH ${STAGES_CTE}
     SELECT stg.applicator_id, sum(stg.eff_s) AS s, sum(stg.distance_m) AS d, count(DISTINCT stg.job_id)::int AS jobs, count(*)::int AS stages
       FROM stg WHERE stg.applicator_id IS NOT NULL AND stg.started_at >= $1 AND stg.started_at < $2 GROUP BY 1`, [range.fromTs, range.toTs]);
  const { rows: al } = await db.query(
    `SELECT j.applicator_id, count(*)::int AS n, count(*) FILTER (WHERE a.severity = 'alta')::int AS high
       FROM alerts a JOIN jobs j ON j.id = a.job_id
      WHERE j.deleted_at IS NULL AND a.started_at >= $1 AND a.started_at < $2 GROUP BY 1`, [range.fromTs, range.toTs]);
  const { rows: us } = await db.query("SELECT id, name, username, active FROM users WHERE role = 'aplicador'");
  const fromMs = Date.parse(range.fromTs), toMs = Date.parse(range.toTs);
  const out = [];
  for (const u of us) {
    const id = Number(u.id);
    const st = rows.find(r => Number(r.applicator_id) === id);
    const mine = jobRows.filter(j => Number(j.applicator_id) === id && j.activity && new Date(j.activity).getTime() >= fromMs && new Date(j.activity).getTime() < toMs);
    const ha = mine.reduce((s, j) => s + j.covHa, 0);
    const fin = mine.filter(j => j.status === 'finalizado' && j.route_pct != null);
    const hours = st ? Number(st.s) / 3600 : 0;
    const a = al.find(r => Number(r.applicator_id) === id);
    if (!st && !mine.length && !u.active) continue;
    out.push({
      applicatorId: id, name: u.name, username: u.username, active: u.active,
      jobs: st ? st.jobs : 0, stages: st ? st.stages : 0, hours: round(hours, 2), ha: round(ha, 3),
      haPerHour: hours > 0.01 ? round(ha / hours, 3) : null,
      avgRoutePct: fin.length ? round(fin.reduce((s, j) => s + Number(j.route_pct), 0) / fin.length, 1) : null,
      alerts: a ? a.n : 0, alertsHigh: a ? a.high : 0,
      avgSpeedKmh: st && Number(st.s) > 60 ? round(Number(st.d) / Number(st.s) * 3.6, 2) : null
    });
  }
  return out.sort((x, z) => (z.ha - x.ha) || (z.hours - x.hours));
}

module.exports = {
  TZ, HIGH_TOX, TOX_CLASSES, TOX_COLORS, CATEGORIES, DOSE_UNITS, SETTINGS_DEFAULTS, normalizeSettings, getSettings,
  zoneHa, consumptionFor, jobConsumption, JOB_FORMULA_SELECT, updateJobConsumption, afterCoverage, parseRange, round,
  machinesWithStats, machineToJson, stockSummary, exposure, dashboard, applicatorPerformance, STAGES_CTE
};
