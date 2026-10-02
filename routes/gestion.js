// Gestión: catálogo de productos y maquinaria, máquinas, stock, exposición, tablero ejecutivo y datos de ejemplo.
const express = require('express');
const db = require('../lib/db');
const { ah, requireAuth, requireRole } = require('../lib/auth');
const G = require('../lib/gestion');

const router = express.Router();
router.use(['/catalog', '/machines', '/stock', '/exposure', '/gestion', '/dashboard', '/demo'], requireAuth);
const staff = requireRole('supervisor', 'admin');
const admin = requireRole('admin');

const EXAMPLE = 'EJEMPLO';
const text = (v, max = 500) => (v == null || v === '') ? null : (String(v).trim().slice(0, max) || null);
function numOrNull(v, { min = -Infinity, max = Infinity, name = 'valor' } = {}) {
  if (v === undefined) return { value: undefined };
  if (v === null || v === '') return { value: null };
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return { error: `${name}: tiene que ser un número entre ${min} y ${max}` };
  return { value: n };
}
const dateOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const idParam = (req, res) => { const id = parseInt(req.params.id, 10); if (!Number.isFinite(id)) { res.status(400).json({ error: 'Id inválido' }); return null; } return id; };

// ===== Catálogo de productos =====
function productToJson(p, full) {
  const o = {
    id: Number(p.id), name: p.name, activeIngredient: p.active_ingredient, commercialNames: p.commercial_names, company: p.company,
    category: p.category, aptitudes: p.aptitudes, formulation: p.formulation, toxClass: p.tox_class, toxColor: p.tox_class ? G.TOX_COLORS[p.tox_class] : null,
    toxNote: p.tox_note, targets: p.targets, crops: p.crops, doseText: p.dose_text,
    doseValue: p.dose_value != null ? Number(p.dose_value) : null, doseUnit: p.dose_unit,
    phiDays: p.phi_days != null ? Number(p.phi_days) : null, phiText: p.phi_text,
    reentryHours: p.reentry_hours != null ? Number(p.reentry_hours) : null, reentryText: p.reentry_text,
    unit: p.unit, source: p.source, sourceUrl: p.source_url, sourceRef: p.source_ref, senasaReg: p.senasa_reg, note: p.note,
    lowStockThreshold: p.low_stock_threshold != null ? Number(p.low_stock_threshold) : null, active: p.active,
    reference: !!p.seed_key, updatedAt: p.updated_at
  };
  if (full) o.uses = p.uses || null;
  return o;
}
const PRODUCT_FIELDS = {
  name: ['name', 200], activeIngredient: ['active_ingredient', 500], commercialNames: ['commercial_names', 500], company: ['company', 200],
  formulation: ['formulation', 40], toxNote: ['tox_note', 500], targets: ['targets', 2000], crops: ['crops', 200], doseText: ['dose_text', 1000],
  doseUnit: ['dose_unit', 20], phiText: ['phi_text', 500], reentryText: ['reentry_text', 500], note: ['note', 1000], sourceUrl: ['source_url', 500], sourceRef: ['source_ref', 500]
};
function parseProduct(body, creating) {
  const sets = {};
  for (const [k, [col, max]] of Object.entries(PRODUCT_FIELDS)) if (body[k] !== undefined) sets[col] = text(body[k], max);
  if (creating && !sets.name) return { error: 'Poné el nombre del producto' };
  if (body.name !== undefined && !sets.name) return { error: 'Poné el nombre del producto' };
  if (body.category !== undefined) { if (!G.CATEGORIES.includes(body.category)) return { error: 'Categoría inválida' }; sets.category = body.category; }
  if (body.toxClass !== undefined) {
    const t = body.toxClass === '' ? null : body.toxClass;
    if (t != null && !G.TOX_CLASSES.includes(t)) return { error: 'Clase toxicológica inválida' };
    sets.tox_class = t;
  }
  if (body.unit !== undefined) { if (!['L', 'kg'].includes(body.unit)) return { error: 'La unidad tiene que ser L o kg' }; sets.unit = body.unit; }
  if (body.doseUnit !== undefined && sets.dose_unit && !G.DOSE_UNITS[sets.dose_unit.toLowerCase()]) return { error: 'Unidad de dosis inválida' };
  for (const [k, col, lim] of [['doseValue', 'dose_value', { min: 0, max: 100000, name: 'Dosis' }], ['phiDays', 'phi_days', { min: 0, max: 365, name: 'Carencia' }],
    ['reentryHours', 'reentry_hours', { min: 0, max: 2000, name: 'Reingreso' }], ['lowStockThreshold', 'low_stock_threshold', { min: 0, max: 1e7, name: 'Stock mínimo' }]]) {
    const r = numOrNull(body[k], lim);
    if (r.error) return { error: r.error };
    if (r.value !== undefined) sets[col] = r.value;
  }
  if (body.active !== undefined) sets.active = body.active === true || body.active === 'true';
  return { sets };
}

router.get('/catalog/products', staff, ah(async (req, res) => {
  const where = [], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, '$' + params.length)); };
  if (req.query.active !== 'all') where.push('active');
  if (req.query.category) add('category = ?', String(req.query.category));
  if (req.query.source) add('source = ?', String(req.query.source));
  if (req.query.q) add("(name ILIKE ? OR active_ingredient ILIKE ? OR commercial_names ILIKE ? OR targets ILIKE ?)", '%' + String(req.query.q).slice(0, 80) + '%');
  const { rows } = await db.query(
    `SELECT id, name, active_ingredient, commercial_names, company, category, aptitudes, formulation, tox_class, tox_note, targets, crops,
            dose_text, dose_value, dose_unit, phi_days, phi_text, reentry_hours, reentry_text, unit, source, source_url, source_ref,
            senasa_reg, note, low_stock_threshold, active, seed_key, updated_at
       FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY active DESC, CASE source WHEN 'admin' THEN 0 WHEN 'INTA' THEN 1 ELSE 2 END, name LIMIT 1000`, params);
  res.json({ products: rows.map(p => productToJson(p)), categories: G.CATEGORIES, toxClasses: G.TOX_CLASSES, doseUnits: ['cc/hL', 'ml/hL', 'l/hL', 'g/hL', 'kg/hL', 'l/ha', 'cc/ha', 'ml/ha', 'kg/ha', 'g/ha'] });
}));
router.get('/catalog/products/:id', staff, ah(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ product: productToJson(rows[0], true) });
}));
router.post('/catalog/products', admin, ah(async (req, res) => {
  const p = parseProduct(req.body || {}, true);
  if (p.error) return res.status(400).json({ error: p.error });
  const cols = Object.keys(p.sets);
  const { rows } = await db.query(
    `INSERT INTO products (${cols.join(', ')}, source) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, 'admin') RETURNING *`,
    cols.map(c => p.sets[c]));
  res.status(201).json({ ok: true, product: productToJson(rows[0], true) });
}));
router.patch('/catalog/products/:id', admin, ah(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const p = parseProduct(req.body || {}, false);
  if (p.error) return res.status(400).json({ error: p.error });
  const cols = Object.keys(p.sets);
  if (!cols.length) return res.status(400).json({ error: 'No hay cambios' });
  const { rows } = await db.query(
    `UPDATE products SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...cols.map(c => p.sets[c])]);
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ ok: true, product: productToJson(rows[0], true) });
}));

// Borrar: sólo productos cargados por el admin sin compras/ajustes ni trabajos vigentes; si no, se desactiva
router.delete('/catalog/products/:id', admin, ah(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const { rows: [p] } = await db.query('SELECT id, seed_key, source FROM products WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  const { rows: [u] } = await db.query(
    `SELECT (SELECT count(*) FROM jobs WHERE product_id = $1 AND deleted_at IS NULL)::int AS jobs,
            (SELECT count(*) FROM stock_movements m LEFT JOIN jobs j ON j.id = m.job_id
              WHERE m.product_id = $1 AND (m.job_id IS NULL OR j.deleted_at IS NULL))::int AS moves`, [id]);
  if (p.seed_key || p.source !== 'admin' || u.jobs || u.moves) {
    await db.query('UPDATE products SET active = false, updated_at = now() WHERE id = $1', [id]);
    return res.json({ ok: true, deactivated: true, message: p.seed_key ? 'Es un producto de referencia: quedó desactivado' : 'Tiene trabajos o movimientos de stock: quedó desactivado' });
  }
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM stock_movements WHERE product_id = $1 AND job_id IN (SELECT id FROM jobs WHERE deleted_at IS NOT NULL)", [id]);
    await client.query('UPDATE jobs SET product_id = NULL WHERE product_id = $1 AND deleted_at IS NOT NULL', [id]);
    await client.query('DELETE FROM products WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  res.json({ ok: true, deleted: true });
}));

// ===== Tipos de maquinaria y EPP =====
const KINDS = ['tractor', 'pulverizadora', 'mochila', 'epp', 'otro'];
function typeToJson(t) {
  return { id: Number(t.id), kind: t.kind, name: t.name, description: t.description, specs: t.specs || {}, sources: t.sources || [], active: t.active, reference: !!t.seed_key };
}
router.get('/catalog/machine-types', staff, ah(async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM machine_types ${req.query.active === 'all' ? '' : 'WHERE active'}
    ORDER BY CASE kind WHEN 'tractor' THEN 0 WHEN 'pulverizadora' THEN 1 WHEN 'mochila' THEN 2 WHEN 'otro' THEN 3 ELSE 4 END, id`);
  res.json({ types: rows.map(typeToJson) });
}));
router.post('/catalog/machine-types', admin, ah(async (req, res) => {
  const b = req.body || {};
  if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'Tipo inválido' });
  const name = text(b.name, 200); if (!name) return res.status(400).json({ error: 'Poné el nombre' });
  const { rows } = await db.query('INSERT INTO machine_types (kind, name, description) VALUES ($1, $2, $3) RETURNING *', [b.kind, name, text(b.description, 2000)]);
  res.status(201).json({ ok: true, type: typeToJson(rows[0]) });
}));
router.patch('/catalog/machine-types/:id', admin, ah(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const b = req.body || {}, sets = [], params = [id];
  if (b.name !== undefined) { const n = text(b.name, 200); if (!n) return res.status(400).json({ error: 'Poné el nombre' }); params.push(n); sets.push(`name = $${params.length}`); }
  if (b.description !== undefined) { params.push(text(b.description, 2000)); sets.push(`description = $${params.length}`); }
  if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) return res.status(400).json({ error: 'Tipo inválido' }); params.push(b.kind); sets.push(`kind = $${params.length}`); }
  if (b.active !== undefined) { params.push(!!b.active); sets.push(`active = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'No hay cambios' });
  const { rows } = await db.query(`UPDATE machine_types SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'Tipo no encontrado' });
  res.json({ ok: true, type: typeToJson(rows[0]) });
}));

// ===== Máquinas =====
const MACHINE_KINDS = ['tractor', 'pulverizadora', 'mochila', 'otro'];
async function parseMachine(b, creating) {
  const sets = {};
  if (b.name !== undefined || creating) { const n = text(b.name, 200); if (!n) return { error: 'Poné un nombre para la máquina' }; sets.name = n; }
  if (b.kind !== undefined || creating) { if (!MACHINE_KINDS.includes(b.kind)) return { error: 'Elegí el tipo de máquina' }; sets.kind = b.kind; }
  if (b.typeId !== undefined) {
    if (b.typeId === null || b.typeId === '') sets.type_id = null;
    else {
      const { rows } = await db.query('SELECT id FROM machine_types WHERE id = $1', [parseInt(b.typeId, 10) || 0]);
      if (!rows[0]) return { error: 'Tipo de catálogo inválido' };
      sets.type_id = rows[0].id;
    }
  }
  for (const [k, col, max] of [['brand', 'brand', 100], ['model', 'model', 100], ['plate', 'plate', 30], ['notes', 'notes', 1000]]) if (b[k] !== undefined) sets[col] = text(b[k], max);
  for (const [k, col, lim] of [['year', 'year', { min: 1950, max: 2100, name: 'Año' }], ['tankL', 'tank_l', { min: 0, max: 100000, name: 'Tanque' }],
    ['baseKm', 'base_km', { min: 0, max: 1e7, name: 'Km iniciales' }], ['baseHours', 'base_hours', { min: 0, max: 1e6, name: 'Horas iniciales' }],
    ['serviceEveryH', 'service_every_h', { min: 1, max: 100000, name: 'Service cada (h)' }], ['lastServiceH', 'last_service_h', { min: 0, max: 1e6, name: 'Último service (h)' }]]) {
    const r = numOrNull(b[k], lim);
    if (r.error) return { error: r.error };
    if (r.value !== undefined) sets[col] = (col === 'base_km' || col === 'base_hours') ? (r.value ?? 0) : (col === 'year' && r.value != null ? Math.round(r.value) : r.value);
  }
  if (b.active !== undefined) sets.active = !!b.active;
  return { sets };
}
router.get('/machines', staff, ah(async (req, res) => {
  const range = req.query.from || req.query.to ? G.parseRange(req.query) : null;
  res.json({ machines: await G.machinesWithStats(range), range });
}));
router.post('/machines', staff, ah(async (req, res) => {
  const m = await parseMachine(req.body || {}, true);
  if (m.error) return res.status(400).json({ error: m.error });
  const cols = Object.keys(m.sets);
  const { rows } = await db.query(
    `INSERT INTO machines (${cols.join(', ')}, created_by) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, $${cols.length + 1}) RETURNING id`,
    [...cols.map(c => m.sets[c]), req.user.id]);
  const all = await G.machinesWithStats(null);
  res.status(201).json({ ok: true, machine: all.find(x => x.id === Number(rows[0].id)) });
}));
router.patch('/machines/:id', staff, ah(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const b = req.body || {};
  const m = await parseMachine(b, false);
  if (m.error) return res.status(400).json({ error: m.error });
  // "Service hecho": el último service queda en las horas actuales
  if (b.serviceDone) {
    const cur = (await G.machinesWithStats(null)).find(x => x.id === id);
    if (!cur) return res.status(404).json({ error: 'Máquina no encontrada' });
    m.sets.last_service_h = cur.totalHours;
  }
  const cols = Object.keys(m.sets);
  if (!cols.length) return res.status(400).json({ error: 'No hay cambios' });
  const { rowCount } = await db.query(`UPDATE machines SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...cols.map(c => m.sets[c])]);
  if (!rowCount) return res.status(404).json({ error: 'Máquina no encontrada' });
  res.json({ ok: true, machine: (await G.machinesWithStats(null)).find(x => x.id === id) });
}));
router.delete('/machines/:id', admin, ah(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const { rows: [u] } = await db.query('SELECT count(*)::int AS n FROM jobs WHERE (machine_id = $1 OR implement_id = $1) AND deleted_at IS NULL', [id]);
  if (u.n) {
    await db.query('UPDATE machines SET active = false, updated_at = now() WHERE id = $1', [id]);
    return res.json({ ok: true, deactivated: true, message: 'La máquina tiene trabajos: quedó desactivada (se conserva su historial)' });
  }
  // Sólo la usaban trabajos eliminados: se desvincula y se borra
  await db.query('UPDATE jobs SET machine_id = NULL WHERE machine_id = $1 AND deleted_at IS NOT NULL', [id]);
  await db.query('UPDATE jobs SET implement_id = NULL WHERE implement_id = $1 AND deleted_at IS NOT NULL', [id]);
  const { rowCount } = await db.query('DELETE FROM machines WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Máquina no encontrada' });
  res.json({ ok: true, deleted: true });
}));

// ===== Stock =====
function movementToJson(m) {
  return {
    id: Number(m.id), productId: Number(m.product_id), productName: m.product_name, kind: m.kind, quantity: Number(m.quantity), unit: m.unit,
    date: m.moved_on, supplier: m.supplier, lot: m.lot, costTotal: m.cost_total != null ? Number(m.cost_total) : null, reason: m.reason,
    jobId: m.job_id != null ? Number(m.job_id) : null, jobLot: m.job_lot || null, jobStatus: m.job_status || null, details: m.details || null,
    example: !!m.example, createdBy: m.created_by_name || null, createdAt: m.created_at, updatedAt: m.updated_at
  };
}
router.get('/stock', staff, ah(async (req, res) => {
  res.json({ stock: await G.stockSummary() });
}));
router.get('/stock/movements', staff, ah(async (req, res) => {
  const where = ['(m.job_id IS NULL OR j.deleted_at IS NULL)'], params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (req.query.productId) add('m.product_id = ?', parseInt(req.query.productId, 10) || 0);
  if (req.query.kind) add('m.kind = ?', String(req.query.kind));
  if (req.query.jobId) add('m.job_id = ?', parseInt(req.query.jobId, 10) || 0);
  if (req.query.from && dateOk(req.query.from)) add('m.moved_on >= ?::date', req.query.from);
  if (req.query.to && dateOk(req.query.to)) add('m.moved_on <= ?::date', req.query.to);
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 300);
  const { rows } = await db.query(
    `SELECT m.*, p.name AS product_name, j.lot_name AS job_lot, j.status AS job_status, u.name AS created_by_name
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       LEFT JOIN jobs j ON j.id = m.job_id LEFT JOIN users u ON u.id = m.created_by
      WHERE ${where.join(' AND ')} ORDER BY m.moved_on DESC, m.id DESC LIMIT ${limit}`, params);
  res.json({ movements: rows.map(movementToJson) });
}));
async function productForStock(id) {
  const { rows } = await db.query('SELECT id, unit, name FROM products WHERE id = $1', [parseInt(id, 10) || 0]);
  return rows[0] || null;
}
router.post('/stock/purchases', staff, ah(async (req, res) => {
  const b = req.body || {};
  const p = await productForStock(b.productId);
  if (!p) return res.status(400).json({ error: 'Elegí un producto del catálogo' });
  const q = numOrNull(b.quantity, { min: 0.001, max: 1e7, name: 'Cantidad' });
  if (q.error || q.value == null) return res.status(400).json({ error: q.error || 'Indicá la cantidad' });
  const cost = numOrNull(b.costTotal, { min: 0, max: 1e12, name: 'Costo' });
  if (cost.error) return res.status(400).json({ error: cost.error });
  if (b.unit && b.unit !== p.unit) return res.status(400).json({ error: `El producto se lleva en ${p.unit}` });
  const date = dateOk(b.date) ? b.date : null;
  const { rows } = await db.query(
    `INSERT INTO stock_movements (product_id, kind, quantity, unit, moved_on, supplier, lot, cost_total, reason, created_by)
     VALUES ($1, 'compra', $2, $3, COALESCE($4::date, (now() AT TIME ZONE '${G.TZ}')::date), $5, $6, $7, $8, $9) RETURNING *`,
    [p.id, q.value, p.unit, date, text(b.supplier, 200), text(b.lot, 100), cost.value ?? null, text(b.notes, 500), req.user.id]);
  res.status(201).json({ ok: true, movement: movementToJson({ ...rows[0], product_name: p.name }) });
}));
router.post('/stock/adjustments', staff, ah(async (req, res) => {
  const b = req.body || {};
  const p = await productForStock(b.productId);
  if (!p) return res.status(400).json({ error: 'Elegí un producto del catálogo' });
  const q = numOrNull(b.quantity, { min: -1e7, max: 1e7, name: 'Cantidad' });
  if (q.error || !q.value) return res.status(400).json({ error: q.error || 'Indicá la cantidad (positiva suma, negativa resta)' });
  const reason = text(b.reason, 500);
  if (!reason) return res.status(400).json({ error: 'Indicá el motivo del ajuste' });
  const date = dateOk(b.date) ? b.date : null;
  const { rows } = await db.query(
    `INSERT INTO stock_movements (product_id, kind, quantity, unit, moved_on, reason, created_by)
     VALUES ($1, 'ajuste', $2, $3, COALESCE($4::date, (now() AT TIME ZONE '${G.TZ}')::date), $5, $6) RETURNING *`,
    [p.id, q.value, p.unit, date, reason, req.user.id]);
  res.status(201).json({ ok: true, movement: movementToJson({ ...rows[0], product_name: p.name }) });
}));
router.delete('/stock/movements/:id', admin, ah(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const { rows } = await db.query("DELETE FROM stock_movements WHERE id = $1 AND kind IN ('compra', 'ajuste') RETURNING id", [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Movimiento no encontrado (los consumos se calculan solos desde los trabajos)' });
  res.json({ ok: true });
}));
router.put('/stock/threshold/:id', staff, ah(async (req, res) => {
  const id = idParam(req, res); if (id == null) return;
  const t = numOrNull((req.body || {}).threshold, { min: 0, max: 1e7, name: 'Stock mínimo' });
  if (t.error) return res.status(400).json({ error: t.error });
  const { rowCount } = await db.query('UPDATE products SET low_stock_threshold = $2, updated_at = now() WHERE id = $1', [id, t.value ?? null]);
  if (!rowCount) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json({ ok: true });
}));

// ===== Exposición y configuración =====
router.get('/exposure', staff, ah(async (req, res) => {
  res.json(await G.exposure(G.parseRange(req.query)));
}));
router.get('/gestion/settings', staff, ah(async (req, res) => {
  res.json({ settings: await G.getSettings(), defaults: G.SETTINGS_DEFAULTS });
}));
router.put('/gestion/settings', admin, ah(async (req, res) => {
  const { value, errors } = G.normalizeSettings((req.body || {}).settings, true);
  if (errors.length) return res.status(400).json({ error: 'Valores fuera de rango', errors });
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('gestion', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [JSON.stringify(value), req.user.id]);
  res.json({ ok: true, settings: value });
}));

// ===== Tablero ejecutivo =====
router.get('/dashboard', admin, ah(async (req, res) => {
  res.json(await G.dashboard(G.parseRange(req.query)));
}));
const csvCell = (v) => {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000).replace('.', ',') : '';
  const s = String(v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (head, rows) => '\ufeff' + [head, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
const fmtDate = (d) => d ? new Date(new Date(d).getTime() - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';
router.get('/dashboard/export', admin, ah(async (req, res) => {
  const range = G.parseRange(req.query);
  const kind = String(req.query.kind || 'trabajos');
  let csv;
  if (kind === 'trabajos') {
    const { rows } = await db.query(
      `${G.JOB_FORMULA_SELECT.replace('SELECT j.id,', `SELECT j.id, j.lot_name, j.product, j.created_at, j.started_at, j.route_pct, u.name AS applicator_name,
               mm.name AS machine_name, im.name AS implement_name, p.tox_class,
               (SELECT COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))), 0) FROM job_stages s WHERE s.job_id = j.id) AS stage_s,`)
        .replace('LEFT JOIN products p ON p.id = j.product_id', `LEFT JOIN products p ON p.id = j.product_id LEFT JOIN users u ON u.id = j.applicator_id
               LEFT JOIN machines mm ON mm.id = j.machine_id LEFT JOIN machines im ON im.id = j.implement_id`)}
       WHERE j.deleted_at IS NULL AND COALESCE(j.finished_at, j.started_at, j.created_at) >= $1 AND COALESCE(j.finished_at, j.started_at, j.created_at) < $2
       ORDER BY j.id`, [range.fromTs, range.toTs]);
    csv = toCsv(['Id', 'Lote', 'Estado', 'Aplicador', 'Producto', 'Producto del catálogo', 'Clase tox.', 'Dosis', 'Unidad', 'Caldo L/ha', 'Superficie lote (ha)',
      '% zona cubierta', 'Ha cubiertas', '% ruta', 'Etapas', 'Horas de etapas', 'Consumo estimado', 'Unidad consumo', 'Máquina', 'Implemento', 'Creado', 'Iniciado', 'Finalizado'],
      rows.map(r => { const c = G.jobConsumption(r); return [Number(r.id), r.lot_name, r.status, r.applicator_name, r.product, r.product_name, r.tox_class,
        r.dose != null ? Number(r.dose) : null, r.dose_unit, r.liters_per_ha != null ? Number(r.liters_per_ha) : null, c.areaHa, c.coveragePct, c.coveredHa,
        r.route_pct != null ? Number(r.route_pct) : null, r.stage_count, Number(r.stage_s) / 3600, c.quantity ?? null, c.quantity != null ? c.unit : (c.error || ''),
        r.machine_name, r.implement_name, fmtDate(r.created_at), fmtDate(r.started_at), fmtDate(r.finished_at)]; }));
  } else if (kind === 'stock') {
    const s = await G.stockSummary();
    csv = toCsv(['Producto', 'Principio activo', 'Categoría', 'Unidad', 'Comprado', 'Consumido', 'Ajustes', 'Stock estimado', 'Stock mínimo', 'Bajo', 'Costo unitario', 'Valor estimado', 'Último movimiento'],
      s.map(x => [x.name, x.activeIngredient, x.category, x.unit, x.purchased, x.consumed, x.adjusted, x.stock, x.threshold, x.low ? 'sí' : 'no', x.unitCost, x.value, x.lastMove]));
  } else if (kind === 'movimientos') {
    const { rows } = await db.query(
      `SELECT m.*, p.name AS product_name, j.lot_name AS job_lot FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN jobs j ON j.id = m.job_id
        WHERE (m.job_id IS NULL OR j.deleted_at IS NULL) AND m.moved_on >= $1::date AND m.moved_on <= $2::date ORDER BY m.moved_on, m.id`, [range.from, range.to]);
    csv = toCsv(['Fecha', 'Tipo', 'Producto', 'Cantidad', 'Unidad', 'Proveedor', 'Lote/partida', 'Costo total', 'Motivo', 'Trabajo', 'Ejemplo'],
      rows.map(m => [m.moved_on, m.kind, m.product_name, Number(m.quantity), m.unit, m.supplier, m.lot, m.cost_total != null ? Number(m.cost_total) : null, m.reason, m.job_lot ? `#${m.job_id} ${m.job_lot}` : '', m.example ? EXAMPLE : '']));
  } else if (kind === 'maquinaria') {
    const ms = await G.machinesWithStats(range);
    csv = toCsv(['Máquina', 'Tipo', 'Marca', 'Modelo', 'Dominio', 'Año', 'Tanque (L)', 'Km en el rango', 'Horas en el rango', 'Trabajos en el rango', 'Km totales', 'Horas totales', 'Próximo service (h)', 'Estado service', 'Ejemplo'],
      ms.map(m => [m.name, m.kind, m.brand, m.model, m.plate, m.year, m.tankL, m.rangeKm, m.rangeHours, m.rangeJobs, m.totalKm, m.totalHours, m.service ? m.service.nextH : null, m.service ? m.service.state : '', m.example ? EXAMPLE : '']));
  } else if (kind === 'exposicion') {
    const e = await G.exposure(range);
    const rows = [];
    for (const a of e.applicators) for (const p of a.byProduct) rows.push([a.name, a.username, p.name, p.toxClass, G.TOX_COLORS[p.toxClass] || '', p.hours, p.jobs, e.highToxClasses.includes(p.toxClass) ? 'sí' : 'no']);
    csv = toCsv(['Aplicador', 'Usuario', 'Producto', 'Clase tox.', 'Banda', 'Horas', 'Trabajos', 'Alta toxicidad'], rows);
  } else if (kind === 'aplicadores') {
    const d = await G.dashboard(range);
    csv = toCsv(['Aplicador', 'Usuario', 'Trabajos', 'Etapas', 'Horas', 'Ha cubiertas', 'Ha/hora', '% ruta promedio', 'Alertas', 'Alertas altas', 'Velocidad media (km/h)'],
      d.applicators.map(a => [a.name, a.username, a.jobs, a.stages, a.hours, a.ha, a.haPerHour, a.avgRoutePct, a.alerts, a.alertsHigh, a.avgSpeedKmh]));
  } else return res.status(400).json({ error: 'Tipo de exportación inválido' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="chaman-${kind}-${range.from}_a_${range.to}.csv"`);
  res.send(csv);
}));

// ===== Datos de ejemplo (sólo con el botón del admin; quedan marcados EJEMPLO) =====
async function demoStatus() {
  const { rows: [r] } = await db.query(
    `SELECT (SELECT count(*) FROM machines WHERE example)::int AS machines, (SELECT count(*) FROM stock_movements WHERE example)::int AS movements`);
  return { machines: r.machines, movements: r.movements, loaded: r.machines + r.movements > 0 };
}
router.get('/demo', admin, ah(async (req, res) => res.json(await demoStatus())));
router.post('/demo', admin, ah(async (req, res) => {
  const st = await demoStatus();
  if (st.loaded) return res.status(409).json({ error: 'Los datos de ejemplo ya están cargados. Borralos antes de volver a cargarlos.', ...st });
  const type = async (key) => { const { rows } = await db.query('SELECT id FROM machine_types WHERE seed_key = $1', [key]); return rows[0] ? rows[0].id : null; };
  const machines = [
    { kind: 'tractor', name: `${EXAMPLE} – Tractor frutero 1`, brand: 'Ejemplo', model: 'Frutero 80 HP', plate: 'EJ 000 AA', year: 2019, tank: null, km: 1200, h: 2350, every: 250, last: 2250, type: 'tractor-frutero' },
    { kind: 'pulverizadora', name: `${EXAMPLE} – Pulverizadora 2000 L`, brand: 'Ejemplo', model: 'Hidroneumática axial', plate: null, year: 2020, tank: 2000, km: 0, h: 1100, every: 100, last: 1000, type: 'pulverizadora-axial' },
    { kind: 'mochila', name: `${EXAMPLE} – Mochila 20 L`, brand: 'Ejemplo', model: 'Manual', plate: null, year: 2023, tank: 20, km: 0, h: 0, every: null, last: null, type: 'mochila-manual' }
  ];
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    for (const m of machines) {
      await client.query(
        `INSERT INTO machines (type_id, kind, name, brand, model, plate, year, tank_l, base_km, base_hours, service_every_h, last_service_h, notes, example, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, $14)`,
        [await type(m.type), m.kind, m.name, m.brand, m.model, m.plate, m.year, m.tank, m.km, m.h, m.every, m.last, 'Dato de ejemplo: se borra con "Borrar datos de ejemplo"', req.user.id]);
    }
    // Compras de ejemplo de productos de referencia (INTA): cantidades y costos inventados
    const buys = [
      ['inta-aceite-mineral-de-invierno', 400, 2800, 14], ['inta-polisulfuro-de-calcio', 200, 1500, 12], ['inta-captan', 50, 450, 10],
      ['inta-clorantraniliprole', 5, 900, 7], ['inta-metoxifenocide', 10, 1100, 5], ['inta-azufre', 75, 260, 3], ['inta-6-benciladenina-ba', 4, 640, 1]
    ];
    let n = 0;
    const thresholds = { 'inta-captan': 60, 'inta-clorantraniliprole': 2, 'inta-aceite-mineral-de-invierno': 150, 'inta-metoxifenocide': 4 };
    const touched = [];
    for (const [key, q, cost, daysAgo] of buys) {
      const { rows } = await client.query('SELECT id, unit, low_stock_threshold FROM products WHERE seed_key = $1', [key]);
      if (!rows[0]) continue;
      // Stock mínimo de ejemplo sólo si el producto no tenía uno (se vuelve a vaciar al borrar los ejemplos)
      if (thresholds[key] != null && rows[0].low_stock_threshold == null) {
        await client.query('UPDATE products SET low_stock_threshold = $2 WHERE id = $1', [rows[0].id, thresholds[key]]);
        touched.push([Number(rows[0].id), thresholds[key]]);
      }
      if (key === 'inta-aceite-mineral-de-invierno') {
        await client.query(
          `INSERT INTO stock_movements (product_id, kind, quantity, unit, moved_on, reason, example, created_by)
           VALUES ($1, 'ajuste', -20, $2, ((now() AT TIME ZONE '${G.TZ}')::date - 2), $3, true, $4)`,
          [rows[0].id, rows[0].unit, `${EXAMPLE} – Ajuste por inventario (bidón dañado)`, req.user.id]);
      }
      await client.query(
        `INSERT INTO stock_movements (product_id, kind, quantity, unit, moved_on, supplier, lot, cost_total, reason, example, created_by)
         VALUES ($1, 'compra', $2, $3, ((now() AT TIME ZONE '${G.TZ}')::date - $4::int), $5, $6, $7, $8, true, $9)`,
        [rows[0].id, q, rows[0].unit, daysAgo, `${EXAMPLE} – Agroquímica del Valle`, `EJ-${String(++n).padStart(3, '0')}`, cost, 'Compra de ejemplo (US$ de referencia, inventado)', req.user.id]);
    }
    await client.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('demo_thresholds', $1, now(), $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, [JSON.stringify({ products: touched }), req.user.id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  res.status(201).json({ ok: true, ...(await demoStatus()) });
}));
router.delete('/demo', admin, ah(async (req, res) => {
  const client = await db.getPool().connect();
  let r;
  try {
    await client.query('BEGIN');
    const mv = await client.query('DELETE FROM stock_movements WHERE example');
    await client.query('UPDATE jobs SET machine_id = NULL WHERE machine_id IN (SELECT id FROM machines WHERE example)');
    await client.query('UPDATE jobs SET implement_id = NULL WHERE implement_id IN (SELECT id FROM machines WHERE example)');
    const ma = await client.query('DELETE FROM machines WHERE example');
    const { rows: th } = await client.query("SELECT value FROM settings WHERE key = 'demo_thresholds'");
    const pairs = th[0] && th[0].value && Array.isArray(th[0].value.products) ? th[0].value.products : [];
    // Sólo si el stock mínimo sigue siendo el del ejemplo (si el admin lo cambió, se respeta)
    for (const [pid, v] of pairs) await client.query('UPDATE products SET low_stock_threshold = NULL WHERE id = $1 AND low_stock_threshold = $2', [Number(pid), Number(v)]);
    await client.query("DELETE FROM settings WHERE key = 'demo_thresholds'");
    await client.query('COMMIT');
    r = { movements: mv.rowCount, machines: ma.rowCount };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  res.json({ ok: true, deleted: r, ...(await demoStatus()) });
}));

module.exports = router;
