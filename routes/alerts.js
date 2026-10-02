// Alertas operativas: lista, resumen, marcar como vistas, configuración y aviso en vivo (SSE).
const express = require('express');
const db = require('../lib/db');
const { ah, requireAuth, requireRole } = require('../lib/auth');
const { bus } = require('../lib/events');
const alerts = require('../lib/alerts');
const AC = require('../alerts-core');

const router = express.Router();
const SSE_PING_MS = 20000;
const SSE_MAX_MS = 10 * 60 * 1000;

router.use('/alerts', requireAuth);

// Umbrales: los lee cualquiera logueado (el tracker los usa para avisar al aplicador)
router.get('/alerts/settings', ah(async (req, res) => {
  res.json(await alerts.settingsInfo());
}));
router.put('/alerts/settings', requireRole('admin'), ah(async (req, res) => {
  const r = await alerts.saveSettings((req.body || {}).settings || req.body, req.user.id);
  if (r.errors) {
    const e = r.errors[0];
    return res.status(400).json({ error: `Valor fuera de rango (${e.field}): tiene que estar entre ${e.min} y ${e.max}`, errors: r.errors });
  }
  alerts.tick(); // reevaluar con los umbrales nuevos
  res.json({ ok: true, ...(await alerts.settingsInfo()) });
}));

router.use('/alerts', requireRole('supervisor', 'admin'));

router.get('/alerts/summary', ah(async (req, res) => {
  res.json(await alerts.summary());
}));

// Lista con filtros: status=open|resolved|all, unseen=1, type, severity, jobId, applicatorId
router.get('/alerts', ah(async (req, res) => {
  const where = ['j.deleted_at IS NULL'];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  const status = req.query.status || 'open';
  if (status === 'open') where.push('a.resolved_at IS NULL');
  else if (status === 'resolved') where.push('a.resolved_at IS NOT NULL');
  if (req.query.unseen === '1') where.push("a.acknowledged_at IS NULL AND a.severity <> 'info'");
  if (req.query.type) {
    const types = String(req.query.type).split(',').filter(t => AC.TYPES.includes(t));
    if (!types.length) return res.status(400).json({ error: 'Tipo de alerta inválido' });
    add('a.type = ANY(?)', types);
  }
  if (req.query.severity) add('a.severity = ?', String(req.query.severity));
  for (const [q, col] of [['jobId', 'a.job_id'], ['applicatorId', 'j.applicator_id']]) {
    if (req.query[q] == null || req.query[q] === '') continue;
    const n = parseInt(req.query[q], 10);
    if (!Number.isFinite(n)) return res.status(400).json({ error: 'Filtro inválido' });
    add(col + ' = ?', n);
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const { rows } = await db.query(
    `${alerts.ALERT_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY (a.resolved_at IS NULL) DESC, a.started_at DESC, a.id DESC LIMIT ${limit}`, params);
  res.json({ alerts: rows.map(alerts.alertToJson), summary: await alerts.summary() });
}));

// Marcar como vista una alerta, una lista (ids) o todas las no vistas (all, opcional jobId)
router.post('/alerts/:id/ack', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido' });
  const a = await alerts.loadAlert(id);
  if (!a) return res.status(404).json({ error: 'Alerta no encontrada' });
  await alerts.acknowledge([id], req.user.id);
  res.json({ ok: true, alert: await alerts.loadAlert(id), summary: await alerts.summary() });
}));
router.post('/alerts/ack', ah(async (req, res) => {
  const body = req.body || {};
  let ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  if (body.all) {
    const params = [];
    let extra = '';
    if (body.jobId != null) { params.push(Number(body.jobId)); extra = ' AND a.job_id = $1'; }
    const { rows } = await db.query(
      `SELECT a.id FROM alerts a JOIN jobs j ON j.id = a.job_id
        WHERE a.acknowledged_at IS NULL AND j.deleted_at IS NULL${extra}`, params);
    ids = rows.map(r => Number(r.id));
  }
  const done = await alerts.acknowledge(ids.slice(0, 5000), req.user.id);
  res.json({ ok: true, acknowledged: done.length, summary: await alerts.summary() });
}));

// Aviso en vivo para el encabezado de supervisores: eventos "summary" y "alert"
router.get('/alerts/stream', ah(async (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  let closed = false;
  const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  let sumTimer = null;
  const sendSummary = () => {
    if (sumTimer) return;
    sumTimer = setTimeout(async () => {
      sumTimer = null;
      try { send('summary', await alerts.summary()); } catch (_) {}
    }, 300);
  };
  const onAlert = (ev) => { send('alert', ev); sendSummary(); };
  bus.on('alerts', onAlert);
  send('summary', await alerts.summary());
  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, SSE_PING_MS);
  const maxAge = setTimeout(() => res.end(), SSE_MAX_MS);
  req.on('close', () => {
    closed = true;
    clearInterval(ping);
    clearTimeout(maxAge);
    if (sumTimer) clearTimeout(sumTimer);
    bus.off('alerts', onAlert);
  });
}));

module.exports = router;
