const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

function sendHtml(res, file) {
  const token = process.env.MAPBOX_TOKEN || '';
  const html = fs.readFileSync(path.join(__dirname, file), 'utf8')
    .replaceAll('__MAPBOX_TOKEN__', token);
  res.type('html').send(html);
}

app.get(['/index.html', '/tracker.html'], (req, res) => {
  sendHtml(res, req.path.slice(1));
});



let assignedZone = null;
let trackPoints = [];
let lastUpdate = null;

app.get('/api/zone', (req, res) => {
  res.json({ zone: assignedZone, updatedAt: lastUpdate });
});

app.post('/api/zone', (req, res) => {
  const { zone } = req.body;
  if (!zone || !zone.geometry) {
    return res.status(400).json({ error: 'Zona inválida' });
  }
  assignedZone = zone;
  trackPoints = [];
  lastUpdate = new Date().toISOString();
  res.json({ ok: true, updatedAt: lastUpdate });
});

app.delete('/api/zone', (req, res) => {
  assignedZone = null;
  trackPoints = [];
  lastUpdate = new Date().toISOString();
  res.json({ ok: true });
});

app.get('/api/track', (req, res) => {
  res.json({
    points: trackPoints,
    count: trackPoints.length,
    updatedAt: lastUpdate
  });
});

app.post('/api/track', (req, res) => {
  const { points } = req.body;
  if (!points) {
    return res.status(400).json({ error: 'Faltan puntos' });
  }
  const arr = Array.isArray(points) ? points : [points];
  for (const p of arr) {
    if (typeof p.lat === 'number' && typeof p.lng === 'number') {
      trackPoints.push({
        lat: p.lat,
        lng: p.lng,
        accuracy: p.accuracy ?? null,
        speed: p.speed ?? null,
        ts: p.ts || Date.now()
      });
    }
  }
  if (trackPoints.length > 5000) {
    trackPoints = trackPoints.slice(-3000);
  }
  lastUpdate = new Date().toISOString();
  res.json({ ok: true, count: trackPoints.length });
});

app.delete('/api/track', (req, res) => {
  trackPoints = [];
  lastUpdate = new Date().toISOString();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({
    hasZone: !!assignedZone,
    trackCount: trackPoints.length,
    updatedAt: lastUpdate
  });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Fumigacion demo en puerto ' + PORT);
});
