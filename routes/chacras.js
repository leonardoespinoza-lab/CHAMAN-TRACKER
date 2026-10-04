// Chacras y cuadros: establecimientos, cuadros, catálogo regional, importación, plantilla, datos de ejemplo
// y parcelas del catastro de Río Negro como referencia para dibujar.
const express = require('express');
const db = require('../lib/db');
const { ah, requireAuth, requireRole } = require('../lib/auth');
const Ch = require('../lib/chacras');
const Imp = require('../lib/chacras-import');

const router = express.Router();
const staff = requireRole('supervisor', 'admin');
const admin = requireRole('admin');
router.use(['/chacras', '/establecimientos', '/cuadros', '/empresas', '/catastro'], requireAuth);

const intParam = (v) => { const x = parseInt(v, 10); return Number.isFinite(x) && x > 0 ? x : null; };

// Catálogo de cultivos, variedades (con meses de cosecha) y portainjertos
router.get('/chacras/catalogo', ah(async (req, res) => res.json(await Ch.catalog())));

// Empresas / clientes
router.get('/empresas', ah(async (req, res) => {
  const { rows } = await db.query(
    `SELECT em.*, (SELECT count(*) FROM establecimientos e WHERE e.empresa_id = em.id AND e.active)::int AS n
       FROM empresas em WHERE em.active ORDER BY em.nombre`);
  res.json({ empresas: rows.map(r => ({ id: Number(r.id), nombre: r.nombre, cuit: r.cuit, establecimientos: r.n, example: r.example })) });
}));
router.post('/empresas', staff, ah(async (req, res) => {
  const nombre = String((req.body || {}).nombre || '').trim().slice(0, 120);
  if (!nombre) return res.status(400).json({ error: 'Poné el nombre de la empresa' });
  const id = await Ch.ensureEmpresa(db, nombre, /^ejemplo\b/i.test(nombre));
  res.status(201).json({ ok: true, id });
}));

// ---------- establecimientos ----------
router.get('/establecimientos', ah(async (req, res) => {
  const q = { q: req.query.q, empresaId: intParam(req.query.empresaId), cultivoId: intParam(req.query.cultivoId), variedadId: intParam(req.query.variedadId),
    includeInactive: req.query.includeInactive === '1', geometry: req.query.geometry === '1' };
  const list = await Ch.listEstablecimientos(q);
  // Superficie por cultivo de todos los establecimientos listados
  const byC = new Map();
  for (const e of list) for (const c of e.resumen.byCultivo) {
    const a = byC.get(c.cultivo) || { cultivo: c.cultivo, color: c.color, ha: 0, cuadros: 0 };
    a.ha += c.ha; a.cuadros += c.cuadros; byC.set(c.cultivo, a);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  res.json({ establecimientos: list, total: { establecimientos: list.length, cuadros: list.reduce((s, e) => s + e.resumen.cuadros, 0),
    ha: r2(list.reduce((s, e) => s + e.resumen.ha, 0)), byCultivo: [...byC.values()].map(x => ({ ...x, ha: r2(x.ha) })).sort((a, b) => b.ha - a.ha) } });
}));
router.get('/establecimientos/:id', ah(async (req, res) => {
  const id = intParam(req.params.id);
  const e = id && await Ch.getEstablecimiento(id);
  if (!e) return res.status(404).json({ error: 'Establecimiento no encontrado' });
  res.json({ establecimiento: e });
}));
async function saveEst(req, res, id) {
  const p = Ch.parseEstInput(req.body, !!id);
  if (p.errors.length) return res.status(400).json({ error: p.errors.join(' · '), errors: p.errors });
  const v = p.value;
  if (v.empresaNombre !== undefined) v.empresaId = v.empresaNombre ? await Ch.ensureEmpresa(db, v.empresaNombre, /^ejemplo\b/i.test(v.empresaNombre)) : null;
  if (v.empresaId) { const { rows } = await db.query('SELECT 1 FROM empresas WHERE id = $1', [v.empresaId]); if (!rows[0]) return res.status(400).json({ error: 'La empresa elegida no existe' }); }
  const cols = Object.keys(Ch.EST_COLS).filter(k => v[k] !== undefined);
  if (id) {
    const { rows: ex } = await db.query('SELECT id FROM establecimientos WHERE id = $1', [id]);
    if (!ex[0]) return res.status(404).json({ error: 'Establecimiento no encontrado' });
    if (!cols.length) return res.status(400).json({ error: 'No hay cambios' });
    const params = cols.map(k => Ch.sqlVal(k, v[k]));
    params.push(id);
    await db.query(`UPDATE establecimientos SET ${cols.map((k, i) => `${Ch.EST_COLS[k]} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  } else {
    const example = /^ejemplo\b/i.test(v.nombre || '');
    const params = cols.map(k => Ch.sqlVal(k, v[k]));
    const { rows: [r] } = await db.query(
      `INSERT INTO establecimientos (${cols.map(k => Ch.EST_COLS[k]).join(', ')}, example, created_by) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}, $${cols.length + 1}, $${cols.length + 2}) RETURNING id`,
      [...params, example, req.user.id]);
    id = Number(r.id);
  }
  res.status(req.method === 'POST' ? 201 : 200).json({ ok: true, establecimiento: await Ch.getEstablecimiento(id) });
}
router.post('/establecimientos', staff, ah((req, res) => saveEst(req, res, null)));
router.patch('/establecimientos/:id', staff, ah((req, res) => { const id = intParam(req.params.id); if (!id) return res.status(400).json({ error: 'Id inválido' }); return saveEst(req, res, id); }));
// Archivar (no se borra: los trabajos lo siguen mostrando). ?restore=1 lo vuelve a activar.
router.delete('/establecimientos/:id', staff, ah(async (req, res) => {
  const id = intParam(req.params.id);
  const { rowCount } = await db.query('UPDATE establecimientos SET active = $2, updated_at = now() WHERE id = $1', [id, req.query.restore === '1']);
  if (!rowCount) return res.status(404).json({ error: 'Establecimiento no encontrado' });
  res.json({ ok: true, active: req.query.restore === '1' });
}));

// ---------- cuadros ----------
router.get('/cuadros', ah(async (req, res) => {
  const where = [], params = [];
  const p = (v) => { params.push(v); return '$' + params.length; };
  if (req.query.establecimientoId) where.push(`c.establecimiento_id = ${p(intParam(req.query.establecimientoId) || 0)}`);
  if (req.query.cultivoId) where.push(`c.cultivo_id = ${p(intParam(req.query.cultivoId) || 0)}`);
  if (req.query.variedadId) where.push(`c.variedad_id = ${p(intParam(req.query.variedadId) || 0)}`);
  if (req.query.ids) where.push(`c.id = ANY(${p(String(req.query.ids).split(',').map(Number).filter(x => x > 0))}::bigint[])`);
  if (req.query.all !== '1') where.push('c.active AND e.active');
  const cuadros = await Ch.listCuadros(where, params, { geometry: req.query.geometry !== '0' });
  res.json({ cuadros });
}));
router.get('/cuadros/:id', ah(async (req, res) => {
  const id = intParam(req.params.id);
  const c = id && await Ch.getCuadro(id);
  if (!c || (c.deleted && req.query.includeDeleted !== '1')) return res.status(404).json({ error: 'Cuadro no encontrado' });
  res.json({ cuadro: c, aplicaciones: await Ch.cuadroHistory(id) });
}));
async function saveCuadro(req, res, id) {
  const p = await Ch.parseCuadroInput(req.body, !!id);
  if (p.errors.length) return res.status(400).json({ error: p.errors.join(' · '), errors: p.errors });
  const v = p.value;
  // Al cambiar el cultivo sin mandar variedad, la variedad vieja (de otro cultivo) se limpia
  if (id && v.cultivoId !== undefined && v.variedadId === undefined) {
    const { rows } = await db.query('SELECT v.cultivo_id FROM cuadros c JOIN variedades v ON v.id = c.variedad_id WHERE c.id = $1', [id]);
    if (rows[0] && Number(rows[0].cultivo_id) !== v.cultivoId) v.variedadId = null;
  }
  const cols = Object.keys(Ch.CUADRO_COLS).filter(k => v[k] !== undefined);
  if (id) {
    const { rows: ex } = await db.query('SELECT id FROM cuadros WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!ex[0]) return res.status(404).json({ error: 'Cuadro no encontrado' });
    if (!cols.length) return res.status(400).json({ error: 'No hay cambios' });
    const params = cols.map(k => Ch.sqlVal(k, v[k]));
    params.push(id);
    await db.query(`UPDATE cuadros SET ${cols.map((k, i) => `${Ch.CUADRO_COLS[k]} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
  } else {
    const estId = intParam((req.body || {}).establecimientoId);
    const { rows: est } = estId ? await db.query('SELECT id, example FROM establecimientos WHERE id = $1', [estId]) : { rows: [] };
    if (!est[0]) return res.status(400).json({ error: 'Elegí el establecimiento del cuadro' });
    const params = cols.map(k => Ch.sqlVal(k, v[k]));
    const { rows: [r] } = await db.query(
      `INSERT INTO cuadros (establecimiento_id, ${cols.map(k => Ch.CUADRO_COLS[k]).join(', ')}, example, created_by)
       VALUES ($1, ${cols.map((_, i) => '$' + (i + 2)).join(', ')}, $${cols.length + 2}, $${cols.length + 3}) RETURNING id`,
      [estId, ...params, !!est[0].example, req.user.id]);
    id = Number(r.id);
  }
  res.status(req.method === 'POST' ? 201 : 200).json({ ok: true, cuadro: await Ch.getCuadro(id) });
}
router.post('/cuadros', staff, ah((req, res) => saveCuadro(req, res, null)));
router.patch('/cuadros/:id', staff, ah((req, res) => { const id = intParam(req.params.id); if (!id) return res.status(400).json({ error: 'Id inválido' }); return saveCuadro(req, res, id); }));
// Borrado lógico: los trabajos que lo usaron lo siguen mostrando
router.delete('/cuadros/:id', staff, ah(async (req, res) => {
  const id = intParam(req.params.id);
  const { rowCount } = await db.query('UPDATE cuadros SET deleted_at = now(), active = false WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Cuadro no encontrado' });
  res.json({ ok: true });
}));

// ---------- importación ----------
router.get('/chacras/plantilla.xlsx', staff, ah(async (req, res) => {
  const buf = await Imp.templateXlsx();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-chacras-cuadros.xlsx"');
  res.send(Buffer.from(buf));
}));
router.get('/chacras/plantilla.csv', staff, ah(async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-chacras-cuadros.csv"');
  res.send(Imp.templateCsv());
}));
// Body: { filename, base64 | text, apply }. Sin apply = vista previa (no escribe nada)
router.post('/chacras/importar', staff, ah(async (req, res) => {
  let rows;
  try { rows = await Imp.parseUpload(req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.status ? e.message : 'No se pudo leer el archivo: ' + e.message }); }
  if (!rows.length) return res.status(400).json({ error: 'El archivo está vacío' });
  if (rows.length > 5001) return res.status(400).json({ error: 'Demasiadas filas (máximo 5.000)' });
  const r = await Imp.importRows(rows, { apply: !!(req.body || {}).apply, userId: req.user.id });
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

// ---------- datos de ejemplo (sólo el admin) ----------
router.get('/chacras/demo', admin, ah(async (req, res) => res.json(await Ch.demoStatus())));
router.post('/chacras/demo', admin, ah(async (req, res) => {
  const client = await db.getPool().connect();
  let r;
  try {
    await client.query('BEGIN');
    r = await Ch.createDemo(client, req.user.id, { job: (req.body || {}).job !== false });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  if (r.skipped) return res.status(409).json({ error: 'La chacra de ejemplo ya está cargada. Borrá los datos de ejemplo antes de volver a cargarla.', ...r });
  res.status(201).json(r);
}));

// ---------- catastro (referencia para dibujar) ----------
router.get('/catastro/parcelas', staff, ah(async (req, res) => {
  const r = await Ch.catastroParcelas(String(req.query.bbox || '').split(','));
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  res.json(r);
}));

module.exports = router;
