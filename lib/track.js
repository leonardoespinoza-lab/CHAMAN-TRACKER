// Validación de puntos GPS recibidos desde el celular (o, más adelante, equipos GPS).
const MAX_POINTS_PER_REQUEST = 1000;

function num(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// Devuelve arrays paralelos listos para INSERT ... SELECT FROM unnest(...)
function parsePoints(points) {
  const arr = (Array.isArray(points) ? points : [points]).slice(0, MAX_POINTS_PER_REQUEST);
  const out = { lats: [], lngs: [], accs: [], speeds: [], times: [], clientIds: [] };
  const now = Date.now();
  for (const p of arr) {
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
    if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180)) continue;
    let ts = typeof p.ts === 'number' ? p.ts : Date.parse(p.ts);
    if (!Number.isFinite(ts) || ts > now + 24 * 3600 * 1000 || ts < 946684800000) ts = now;
    out.lats.push(p.lat);
    out.lngs.push(p.lng);
    out.accs.push(num(p.accuracy));
    out.speeds.push(num(p.speed));
    out.times.push(new Date(ts).toISOString());
    out.clientIds.push(typeof p.id === 'string' && p.id.length <= 64 ? p.id : null);
  }
  out.count = out.lats.length;
  return out;
}

module.exports = { parsePoints, MAX_POINTS_PER_REQUEST };
