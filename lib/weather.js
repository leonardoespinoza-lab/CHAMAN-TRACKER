// Clima y "ventana de aplicación": pronóstico horario (Open-Meteo; respaldo MET Norway), ΔT, reglas
// configurables por el admin, estado por hora (apta / precaución / no apta) con motivos y mejores ventanas.
// El pronóstico se guarda en memoria 45 min por punto redondeado (~1 km) para no castigar la API.
const db = require('./db');

const TZ = 'America/Argentina/Buenos_Aires';
const CACHE_TTL_MS = Number(process.env.WEATHER_CACHE_MS) || 45 * 60 * 1000;
const STALE_MAX_MS = 12 * 60 * 60 * 1000;           // si la API falla se usa el último dato hasta 12 h
const COOLDOWN_429_MS = 60 * 60 * 1000;             // tras un "límite excedido" no se insiste por 1 h
const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = 'chaman-tracker/1.0 (+https://github.com/leonardoespinoza-lab/CHAMAN-TRACKER)';

// Ubicaciones por defecto del Alto Valle de Río Negro / Neuquén
const DEFAULT_LOCATIONS = [
  { key: 'roca', name: 'General Roca', lat: -39.0333, lon: -67.5833 },
  { key: 'allen', name: 'Allen', lat: -38.9776, lon: -67.8268 },
  { key: 'cipolletti', name: 'Cipolletti', lat: -38.9339, lon: -67.9903 },
  { key: 'regina', name: 'Villa Regina', lat: -39.1000, lon: -67.0833 }
];

// Reglas por defecto (viento y ráfagas a 10 m del modelo, km/h). Fuentes en el README:
// GRDC / Bureau of Meteorology (Australia), INTA y Aapresid (Argentina), marbetes.
const RULE_DEFAULTS = {
  windMin: 3,          // < 3 km/h: calma, riesgo de inversión térmica y deriva de gotas finas → precaución
  windIdealMax: 15,    // 15–20 km/h → precaución
  windMax: 20,         // > 20 km/h → no apta
  gustCaution: 20,     // ráfagas > 20 → precaución
  gustMax: 25,         // ráfagas > 25 → no apta
  deltaTMin: 2,        // ΔT < 2 → no apta (aire saturado / inversión)
  deltaTCaution: 8,    // 8–10 → precaución
  deltaTMax: 10,       // > 10 → no apta (evaporación rápida de gotas)
  tempCaution: 28,     // ≥ 28 °C → precaución
  tempMax: 30,         // ≥ 30 °C → no apta
  rhCaution: 50,       // HR < 50 % → precaución
  rhMin: 30,           // HR < 30 % → no apta
  rainfastHours: 6,    // horas sin lluvia después de aplicar (si el producto no trae su valor)
  rainMmNo: 2,         // en esas horas: ≥ 2 mm …
  rainProbNo: 60,      // … con probabilidad ≥ 60 % → no apta
  rainMmCaution: 0.5,  // ≥ 0,5 mm o …
  rainProbCaution: 40, // … probabilidad ≥ 40 % → precaución
  rainNowMm: 0.2,      // lloviendo en la hora → no apta
  nightCaution: true,  // de noche → precaución (inversiones frecuentes)
  minWindowHours: 2    // ventana recomendada: al menos 2 h seguidas aptas
};
const RULE_LIMITS = {
  windMin: [0, 20], windIdealMax: [1, 60], windMax: [1, 80], gustCaution: [1, 100], gustMax: [1, 120],
  deltaTMin: [0, 10], deltaTCaution: [1, 20], deltaTMax: [1, 25], tempCaution: [0, 50], tempMax: [0, 55],
  rhCaution: [0, 100], rhMin: [0, 100], rainfastHours: [0, 72], rainMmNo: [0, 100], rainProbNo: [0, 100],
  rainMmCaution: [0, 100], rainProbCaution: [0, 100], rainNowMm: [0, 20], minWindowHours: [1, 12]
};
function normalizeRules(input, strict) {
  const out = { ...RULE_DEFAULTS }; const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  for (const [k, [min, max]] of Object.entries(RULE_LIMITS)) {
    if (src[k] === undefined || src[k] === null || src[k] === '') continue;
    const n = Number(String(src[k]).replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max) { if (strict) errors.push(`${k}: tiene que ser un número entre ${min} y ${max}`); continue; }
    out[k] = n;
  }
  if (src.nightCaution !== undefined) out.nightCaution = src.nightCaution === true || src.nightCaution === 'true';
  if (strict) {
    if (out.windIdealMax > out.windMax) errors.push('El viento ideal máximo no puede superar al viento máximo');
    if (out.gustCaution > out.gustMax) errors.push('Las ráfagas de precaución no pueden superar al máximo');
    if (out.deltaTCaution > out.deltaTMax) errors.push('ΔT de precaución no puede superar al máximo');
    if (out.tempCaution > out.tempMax) errors.push('La temperatura de precaución no puede superar a la máxima');
    if (out.rhMin > out.rhCaution) errors.push('La HR mínima no puede superar a la de precaución');
  }
  return { value: out, errors };
}
let rulesCache = null, rulesAt = 0;
async function getRules() {
  if (rulesCache && Date.now() - rulesAt < 30000) return rulesCache;
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'clima'");
  rulesCache = normalizeRules(rows[0] && rows[0].value).value; rulesAt = Date.now();
  return rulesCache;
}
async function saveRules(input, userId) {
  const r = normalizeRules(input, true);
  if (r.errors.length) return { errors: r.errors };
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('clima', $1, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(r.value), userId]);
  rulesCache = r.value; rulesAt = Date.now();
  return { value: r.value };
}

// ---------- cálculos ----------
const round = (v, d = 1) => v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** d) / 10 ** d;
// Bulbo húmedo por la fórmula de Stull (2011), válida para HR 5–99 % y −20…50 °C. ΔT = T − Tw
function wetBulb(t, rh) {
  if (t == null || rh == null) return null;
  const r = Math.min(99, Math.max(5, rh));
  return t * Math.atan(0.151977 * Math.sqrt(r + 8.313659)) + Math.atan(t + r) - Math.atan(r - 1.676331)
    + 0.00391838 * r ** 1.5 * Math.atan(0.023101 * r) - 4.686035;
}
function deltaT(t, rh) { const w = wetBulb(t, rh); return w == null ? null : Math.max(0, t - w); }
const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const cardinal = (deg) => deg == null ? '' : CARDINALS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const fmt = (v, d = 0) => v == null ? '–' : Number(v).toLocaleString('es-AR', { maximumFractionDigits: d });
function localParts(t) {
  const d = new Date(new Date(t).getTime() - 3 * 3600e3);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

// Estado de una hora. hours: lista horaria completa; i: índice; rainfastH: horas de la ventana de lluvia
function evaluateHour(hours, i, rules, rainfastH) {
  const h = hours[i];
  const reasons = [];
  let level = 0;
  const add = (l, text, key) => { reasons.push({ level: l, text, key }); if (l > level) level = l; };
  if (h.wind != null) {
    if (h.wind > rules.windMax) add(2, `Viento ${fmt(h.wind)} km/h (máximo ${rules.windMax})`, 'viento');
    else if (h.wind > rules.windIdealMax) add(1, `Viento ${fmt(h.wind)} km/h, por encima del ideal (${rules.windIdealMax})`, 'viento');
    else if (h.wind < rules.windMin) add(1, `Viento calmo (${fmt(h.wind)} km/h): riesgo de inversión térmica y deriva de gotas finas`, 'calma');
  }
  if (h.gust != null) {
    if (h.gust > rules.gustMax) add(2, `Ráfagas de ${fmt(h.gust)} km/h (máximo ${rules.gustMax})`, 'rafagas');
    else if (h.gust > rules.gustCaution) add(1, `Ráfagas de ${fmt(h.gust)} km/h`, 'rafagas');
  }
  if (h.deltaT != null) {
    if (h.deltaT > rules.deltaTMax) add(2, `ΔT ${fmt(h.deltaT, 1)}: evaporación muy rápida de las gotas (máx. ${rules.deltaTMax})`, 'deltat');
    else if (h.deltaT > rules.deltaTCaution) add(1, `ΔT ${fmt(h.deltaT, 1)}: evaporación alta (ideal 2–${rules.deltaTCaution})`, 'deltat');
    else if (h.deltaT < rules.deltaTMin) add(2, `ΔT ${fmt(h.deltaT, 1)}: aire casi saturado, las gotas finas quedan suspendidas (mín. ${rules.deltaTMin})`, 'deltat');
  }
  if (h.temp != null) {
    if (h.temp >= rules.tempMax) add(2, `Temperatura ${fmt(h.temp)} °C (máx. ${rules.tempMax})`, 'temp');
    else if (h.temp >= rules.tempCaution) add(1, `Temperatura ${fmt(h.temp)} °C`, 'temp');
  }
  if (h.rh != null) {
    if (h.rh < rules.rhMin) add(2, `Humedad relativa ${fmt(h.rh)} % (mín. ${rules.rhMin})`, 'hr');
    else if (h.rh < rules.rhCaution) add(1, `Humedad relativa baja (${fmt(h.rh)} %)`, 'hr');
  }
  if (h.precip != null && h.precip >= rules.rainNowMm) add(2, `Lluvia en la hora (${fmt(h.precip, 1)} mm)`, 'lluvia');
  // Lluvia dentro de la ventana de lavado (desde esta hora hasta rainfastH después)
  const win = hours.slice(i, i + Math.max(1, Math.ceil(rainfastH)));
  const sum = win.reduce((s, x) => s + (x.precip || 0), 0);
  const probs = win.map(x => x.prob).filter(x => x != null);
  const maxProb = probs.length ? Math.max(...probs) : null;
  if (!reasons.some(r => r.key === 'lluvia')) {
    if (sum >= rules.rainMmNo && (maxProb == null || maxProb >= rules.rainProbNo)) add(2, `Lluvia en las ${fmt(rainfastH)} h siguientes: ${fmt(sum, 1)} mm${maxProb != null ? `, ${fmt(maxProb)} % de probabilidad` : ''} (lavado del producto)`, 'lluvia');
    else if (sum >= rules.rainMmCaution || (maxProb != null && maxProb >= rules.rainProbCaution)) add(1, `Posible lluvia en las ${fmt(rainfastH)} h siguientes (${fmt(sum, 1)} mm${maxProb != null ? `, ${fmt(maxProb)} %` : ''})`, 'lluvia');
  }
  if (rules.nightCaution && h.isDay === 0) add(1, 'De noche: inversiones térmicas frecuentes', 'noche');
  return { status: ['apta', 'precaucion', 'no_apta'][level], level, reasons, rainNext: { hours: rainfastH, mm: round(sum, 1), prob: maxProb } };
}

// Ventanas: horas aptas seguidas (mínimo minWindowHours)
function findWindows(hours, rules) {
  const out = []; let cur = null;
  const close = () => { if (cur && cur.hours.length >= rules.minWindowHours) out.push(cur); cur = null; };
  hours.forEach((h) => {
    if (h.status === 'apta' && (!cur || new Date(h.t).getTime() - new Date(cur.hours[cur.hours.length - 1].t).getTime() <= 3600e3)) {
      if (!cur) cur = { hours: [] };
      cur.hours.push(h);
    } else { close(); if (h.status === 'apta') cur = { hours: [h] }; }
  });
  close();
  return out.map(w => {
    const hs = w.hours;
    return {
      start: hs[0].t, end: new Date(new Date(hs[hs.length - 1].t).getTime() + 3600e3).toISOString(), hours: hs.length,
      day: localParts(hs[0].t).day,
      avgWind: round(hs.reduce((s, x) => s + (x.wind || 0), 0) / hs.length, 1),
      maxGust: hs.some(x => x.gust != null) ? round(Math.max(...hs.map(x => x.gust || 0)), 0) : null,
      avgDeltaT: round(hs.reduce((s, x) => s + (x.deltaT || 0), 0) / hs.length, 1),
      maxTemp: round(Math.max(...hs.map(x => x.temp ?? -99)), 1)
    };
  });
}

function summarizeDays(hours, windows) {
  const days = new Map();
  for (const h of hours) {
    const { day } = localParts(h.t);
    let d = days.get(day);
    if (!d) { d = { day, apta: 0, precaucion: 0, no_apta: 0, rain: 0, maxProb: null, maxWind: null, maxGust: null, tmin: null, tmax: null }; days.set(day, d); }
    d[h.status]++;
    d.rain += h.precip || 0;
    if (h.prob != null) d.maxProb = Math.max(d.maxProb ?? 0, h.prob);
    if (h.wind != null) d.maxWind = Math.max(d.maxWind ?? 0, h.wind);
    if (h.gust != null) d.maxGust = Math.max(d.maxGust ?? 0, h.gust);
    if (h.temp != null) { d.tmin = d.tmin == null ? h.temp : Math.min(d.tmin, h.temp); d.tmax = d.tmax == null ? h.temp : Math.max(d.tmax, h.temp); }
  }
  return [...days.values()].map(d => {
    const ws = windows.filter(w => w.day === d.day);
    const best = ws.slice().sort((a, b) => b.hours - a.hours)[0] || null;
    return { ...d, rain: round(d.rain, 1), maxWind: round(d.maxWind, 0), maxGust: round(d.maxGust, 0), tmin: round(d.tmin, 1), tmax: round(d.tmax, 1),
      windows: ws.length, aptaHours: d.apta, best };
  });
}

// ---------- proveedores ----------
async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (_) { /* no JSON */ }
  if (!r.ok) { const e = new Error((data && (data.reason || data.error)) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return data;
}
const HOURLY = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'precipitation', 'precipitation_probability', 'wind_speed_10m',
  'wind_gusts_10m', 'wind_direction_10m', 'cloud_cover', 'weather_code', 'is_day'];
async function fromOpenMeteo(lat, lon) {
  const key = process.env.OPEN_METEO_API_KEY;
  const base = key ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast';
  const p = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: HOURLY.join(','),
    current: 'temperature_2m,relative_humidity_2m,dew_point_2m,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,weather_code,is_day',
    timezone: 'GMT', timeformat: 'unixtime', forecast_days: '7', wind_speed_unit: 'kmh', models: process.env.WEATHER_MODEL || 'best_match'
  });
  if (key) p.set('apikey', key);
  const d = await getJson(`${base}?${p}`);
  const H = d.hourly;
  const hours = H.time.map((t, i) => ({
    t: new Date(t * 1000).toISOString(), temp: H.temperature_2m[i], rh: H.relative_humidity_2m[i], dew: H.dew_point_2m[i],
    precip: H.precipitation[i], prob: H.precipitation_probability ? H.precipitation_probability[i] : null,
    wind: H.wind_speed_10m[i], gust: H.wind_gusts_10m ? H.wind_gusts_10m[i] : null, dir: H.wind_direction_10m[i],
    cloud: H.cloud_cover[i], code: H.weather_code[i], isDay: H.is_day ? H.is_day[i] : null
  }));
  const c = d.current || null;
  const current = c ? { t: new Date(c.time * 1000).toISOString(), temp: c.temperature_2m, rh: c.relative_humidity_2m, dew: c.dew_point_2m, precip: c.precipitation,
    wind: c.wind_speed_10m, gust: c.wind_gusts_10m, dir: c.wind_direction_10m, cloud: c.cloud_cover, code: c.weather_code, isDay: c.is_day } : null;
  return { provider: 'open-meteo', model: process.env.WEATHER_MODEL || 'best_match', elevation: d.elevation, hours, current,
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)', attributionUrl: 'https://open-meteo.com/' };
}
// Respaldo: MET Norway Locationforecast (gratis, uso comercial permitido, CC BY 4.0). Fuera de Escandinavia no trae
// ráfagas ni probabilidad de lluvia; es horario las primeras ~60 h y después cada 6 h.
const MET_CODES = { clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45, lightrain: 61, rain: 63, heavyrain: 65, lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82, sleet: 66, snow: 73, thunder: 95 };
async function fromMetNorway(lat, lon) {
  const d = await getJson(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
  const ts = d.properties.timeseries;
  const hours = [];
  ts.forEach((x, i) => {
    const det = x.data.instant.details;
    const n1 = x.data.next_1_hours, n6 = x.data.next_6_hours;
    const sym = ((n1 || n6 || {}).summary || {}).symbol_code || '';
    const base = sym.replace(/_(day|night|polartwilight)$/, '');
    const code = MET_CODES[base] ?? (base.includes('thunder') ? 95 : base.includes('rain') ? 63 : base.includes('snow') ? 73 : null);
    const t0 = new Date(x.time).getTime();
    const span = n1 ? 1 : (n6 ? Math.min(6, ts[i + 1] ? Math.round((new Date(ts[i + 1].time).getTime() - t0) / 3600e3) : 6) : 1);
    const pAmount = n1 ? n1.details.precipitation_amount : (n6 ? n6.details.precipitation_amount / 6 : null);
    for (let k = 0; k < span; k++) {
      const local = localParts(t0 + k * 3600e3);
      hours.push({ t: new Date(t0 + k * 3600e3).toISOString(), temp: det.air_temperature, rh: det.relative_humidity, dew: det.dew_point_temperature,
        precip: pAmount, prob: null, wind: det.wind_speed != null ? round(det.wind_speed * 3.6, 1) : null, gust: det.wind_speed_of_gust != null ? round(det.wind_speed_of_gust * 3.6, 1) : null,
        dir: det.wind_from_direction, cloud: det.cloud_area_fraction, code, isDay: sym.endsWith('_night') ? 0 : (sym.endsWith('_day') ? 1 : (local.hour >= 7 && local.hour < 20 ? 1 : 0)), coarse: k > 0 || !n1 });
    }
  });
  const cut = Date.now() + 7 * 86400e3;
  const list = hours.filter(h => new Date(h.t).getTime() < cut);
  const nowH = list.find(h => new Date(h.t).getTime() >= Date.now() - 3600e3) || list[0];
  return { provider: 'met-norway', model: 'MET Norway Locationforecast 2.0 (ECMWF)', elevation: d.geometry && d.geometry.coordinates[2], hours: list,
    current: nowH ? { ...nowH } : null, attribution: 'Datos de MET Norway (CC BY 4.0)', attributionUrl: 'https://api.met.no/' };
}
// Datos sintéticos para pruebas automáticas (WEATHER_PROVIDER=mock): día con viento fuerte y lluvia a la tarde
function fromMock(lat, lon) {
  const start = Math.floor(Date.now() / 3600e3) * 3600e3 - 3 * 3600e3;
  const hours = [];
  for (let i = 0; i < 7 * 24 + 3; i++) {
    const t = start + i * 3600e3;
    const { hour } = localParts(t);
    const day = Math.floor(i / 24);
    const temp = 12 + 10 * Math.sin((hour - 9) / 24 * 2 * Math.PI) + (day === 3 ? 8 : 0);
    const rh = 85 - 40 * Math.sin((hour - 9) / 24 * 2 * Math.PI);
    let wind = 4 + 9 * Math.max(0, Math.sin((hour - 8) / 14 * Math.PI)) + (day === 1 ? 14 : 0);
    let precip = 0, prob = 5;
    if (day === 0 && hour >= 15 && hour <= 18) { precip = 5; prob = 80; }
    if (day === 2 && hour >= 6 && hour <= 8) { precip = 0.4; prob = 45; }
    hours.push({ t: new Date(t).toISOString(), temp: round(temp, 1), rh: round(Math.min(98, rh), 0), dew: null, precip, prob, wind: round(wind, 1), gust: round(wind * 1.6, 1),
      dir: (200 + i * 7) % 360, cloud: precip ? 95 : 20, code: precip ? 63 : 1, isDay: hour >= 7 && hour < 20 ? 1 : 0 });
  }
  const now = hours.find(h => new Date(h.t).getTime() >= Date.now() - 3600e3);
  return Promise.resolve({ provider: 'mock', model: 'datos de prueba', elevation: 260, hours, current: { ...now }, attribution: 'Datos sintéticos de prueba', attributionUrl: '' });
}

// ---------- caché ----------
const cache = new Map();     // clave → { at, data }
const inflight = new Map();
const cooldown = new Map();  // proveedor → hasta cuándo no se usa (tras 429)
const keyFor = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
async function fetchForecast(lat, lon) {
  const mode = process.env.WEATHER_PROVIDER || 'auto';
  if (mode === 'mock') return fromMock(lat, lon);
  const chain = mode === 'met' ? [fromMetNorway] : mode === 'open-meteo' ? [fromOpenMeteo] : [fromOpenMeteo, fromMetNorway];
  const errors = [];
  for (const fn of chain) {
    const name = fn === fromOpenMeteo ? 'open-meteo' : 'met-norway';
    if ((cooldown.get(name) || 0) > Date.now()) { errors.push(`${name}: en pausa por límite de uso`); continue; }
    try {
      const r = await fn(lat, lon);
      if (errors.length) r.fallbackReason = errors.join(' · ');
      return r;
    } catch (e) {
      if (e.status === 429) cooldown.set(name, Date.now() + COOLDOWN_429_MS);
      errors.push(`${name}: ${e.message}`);
      console.warn('[clima]', name, e.message);
    }
  }
  const err = new Error('No se pudo obtener el pronóstico (' + errors.join(' · ') + ')');
  err.status = 503;
  throw err;
}
async function getForecast(lat, lon) {
  const k = keyFor(lat, lon);
  const c = cache.get(k);
  if (c && Date.now() - c.at < CACHE_TTL_MS) return { ...c.data, cached: true, fetchedAt: new Date(c.at).toISOString() };
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try {
      const data = await fetchForecast(Number(k.split(',')[0]), Number(k.split(',')[1]));
      cache.set(k, { at: Date.now(), data });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return { ...data, cached: false, fetchedAt: new Date().toISOString() };
    } catch (e) {
      if (c && Date.now() - c.at < STALE_MAX_MS) return { ...c.data, cached: true, stale: true, fetchedAt: new Date(c.at).toISOString(), staleReason: e.message };
      throw e;
    } finally { inflight.delete(k); }
  })();
  inflight.set(k, p);
  return p;
}

// ---------- análisis ----------
// Pronóstico evaluado: horas desde la hora actual (más 2 h previas), con ΔT, estado y motivos; ventanas y días.
async function analyze(lat, lon, { rainfastHours, at } = {}) {
  const [fc, rules] = await Promise.all([getForecast(lat, lon), getRules()]);
  const rf = rainfastHours != null && Number.isFinite(Number(rainfastHours)) ? Number(rainfastHours) : rules.rainfastHours;
  const all = fc.hours.map(h => ({ ...h, dew: h.dew ?? null, deltaT: round(deltaT(h.temp, h.rh), 1), cardinal: cardinal(h.dir) }));
  all.forEach((h, i) => { const e = evaluateHour(all, i, rules, rf); h.status = e.status; h.reasons = e.reasons; h.rainNext = e.rainNext; });
  const from = Math.floor(Date.now() / 3600e3) * 3600e3 - 2 * 3600e3;
  const hours = all.filter(h => new Date(h.t).getTime() >= from);
  const windows = findWindows(hours.filter(h => new Date(h.t).getTime() >= Math.floor(Date.now() / 3600e3) * 3600e3), rules);
  const days = summarizeDays(hours, windows);
  let current = null;
  if (fc.current) {
    const idx = all.findIndex(h => new Date(h.t).getTime() > Date.now()) - 1;
    const ref = all[Math.max(0, idx)];
    current = { ...fc.current, deltaT: round(deltaT(fc.current.temp, fc.current.rh), 1), cardinal: cardinal(fc.current.dir) };
    const tmp = all.slice(); tmp[Math.max(0, idx)] = { ...ref, ...current, precip: current.precip ?? ref.precip, prob: ref.prob };
    const e = evaluateHour(tmp, Math.max(0, idx), rules, rf);
    current.status = e.status; current.reasons = e.reasons; current.rainNext = e.rainNext;
  }
  const out = {
    location: { lat: round(lat, 4), lon: round(lon, 4), elevation: fc.elevation ?? null },
    source: { provider: fc.provider, model: fc.model, attribution: fc.attribution, attributionUrl: fc.attributionUrl, fetchedAt: fc.fetchedAt,
      cached: !!fc.cached, stale: !!fc.stale, staleReason: fc.staleReason || null, fallbackReason: fc.fallbackReason || null,
      hasGusts: hours.some(h => h.gust != null), hasProbability: hours.some(h => h.prob != null) },
    rules, rainfastHours: rf, current, hours, windows, days,
    now: windows.find(w => new Date(w.start).getTime() <= Date.now() && new Date(w.end).getTime() > Date.now()) || null,
    next: windows.find(w => new Date(w.start).getTime() > Date.now()) || null
  };
  if (at) out.at = evaluateAt(out, at);
  return out;
}
// Condición en una hora planificada (inicio de un trabajo)
function evaluateAt(an, at) {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return null;
  const h = an.hours.find(x => new Date(x.t).getTime() <= t && new Date(x.t).getTime() + 3600e3 > t);
  if (!h) return { at: new Date(t).toISOString(), outOfRange: true };
  const nextWin = an.windows.find(w => new Date(w.end).getTime() > t) || null;
  return { at: new Date(t).toISOString(), hour: h, status: h.status, reasons: h.reasons, rainNext: h.rainNext, nextWindow: nextWin };
}

// Registro para el historial del trabajo (no bloquea si falla)
function snapshotFrom(an) {
  const c = an.current;
  if (!c) return null;
  return { temp: c.temp, rh: c.rh, dew: c.dew ?? null, wind: c.wind, gust: c.gust ?? null, dir: c.dir, precip: c.precip ?? null,
    prob: c.rainNext ? c.rainNext.prob : null, deltaT: c.deltaT, status: c.status, reasons: (c.reasons || []).map(r => r.text), source: an.source.provider };
}

module.exports = { TZ, DEFAULT_LOCATIONS, RULE_DEFAULTS, RULE_LIMITS, normalizeRules, getRules, saveRules, wetBulb, deltaT, cardinal,
  evaluateHour, findWindows, analyze, evaluateAt, getForecast, snapshotFrom, keyFor };
