// Informes de seguimiento (supervisor y admin): opciones de filtros, vista previa (JSON) y exportación PDF / Excel / CSV
const express = require('express');
const { ah, requireAuth, requireRole } = require('../lib/auth');
const R = require('../lib/reports');
const X = require('../lib/report-export');

const router = express.Router();
router.use('/reports', requireAuth, requireRole('supervisor', 'admin'));

router.get('/reports/options', ah(async (req, res) => { res.json(await R.options()); }));

// Vista previa: textos ya formateados, columnas compactas (las del PDF) y hasta 300 filas por tabla
const PREVIEW_ROWS = 300;
router.get('/reports', ah(async (req, res) => {
  const rep = await R.build(req.query, req.user);
  res.json({
    meta: rep.meta, maps: rep.maps,
    kpis: rep.kpis.map(k => ({ ...k, text: k.value == null ? '–' : R.fmtCell({ t: k.t }, k.value) + (k.unit ? ' ' + k.unit : '') })),
    tables: rep.tables.map(t => {
      const cols = R.colsFor(t, 'pdf');
      return {
        key: t.key, title: t.title, parent: t.parent || null, total: t.rows.length,
        columns: cols.map(c => ({ key: c.key, h: c.h, num: ['int', 'n1', 'n2', 'n3', 'pct', 'money'].includes(c.t) })),
        hiddenColumns: t.columns.length - cols.length,
        rows: t.rows.slice(0, PREVIEW_ROWS).map(r => cols.map(c => R.fmtCell(c, r[c.key])))
      };
    })
  });
}));

router.get('/reports/export', ah(async (req, res) => {
  const format = String(req.query.format || 'pdf');
  if (!['pdf', 'xlsx', 'csv'].includes(format)) return res.status(400).json({ error: 'Formato inválido (pdf, xlsx o csv)' });
  const rep = await R.build(req.query, req.user);
  const out = format === 'pdf' ? await X.toPdf(rep) : format === 'xlsx' ? await X.toXlsx(rep) : await X.toCsv(rep);
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.buffer);
}));

module.exports = router;
