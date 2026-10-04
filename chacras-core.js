// Chacras y cuadros: cálculos compartidos por el navegador y el servidor (UMD, sin dependencias salvo turf).
// - Plantas/ha = 10.000 / (distancia entre filas × distancia entre plantas)
// - TRV (Tree Row Volume, m³/ha) = altura de copa × ancho de copa × 10.000 / distancia entre filas
// - Caldo sugerido (L/ha) = TRV × 0,09 L/m³ × factor de densidad foliar (Byers; Sutton & Unrath; INTA EEA Alto Valle)
// - Carencia vs. cosecha: fecha de aplicación + días de carencia contra el inicio estimado de cosecha de la variedad
// - Ruta vs. cuadros: cuánto de la ruta queda fuera de los cuadros elegidos, recorte y pasadas automáticas
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('@turf/turf'));
  else root.Chacras = factory(root.turf);
})(typeof self !== 'undefined' ? self : this, function (turf) {
  const TRV_COEF_L_M3 = 0.09;
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const SISTEMAS = ['Espaldera', 'Eje central', 'Vaso / forma libre', 'Doble eje / bi-eje', 'Tres ejes', 'Palmeta', 'Peatonal / KGB', 'Parral', 'Otro'];
  const RIEGOS = ['Gravitacional (surco / manto)', 'Aspersión', 'Goteo', 'Microaspersión', 'Otro'];
  const ORIENTACIONES = ['N-S', 'E-O', 'NE-SO', 'NO-SE'];

  const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const round = (v, d = 0) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

  function plantsPerHa(filas, plantas) {
    const f = num(filas), p = num(plantas);
    return f > 0 && p > 0 ? 10000 / (f * p) : null;
  }
  function trv(altura, ancho, filas) {
    const h = num(altura), w = num(ancho), f = num(filas);
    return h > 0 && w > 0 && f > 0 ? h * w * 10000 / f : null;
  }
  function caldo(trvM3, factor) {
    const t = num(trvM3); if (!(t > 0)) return null;
    const k = num(factor); return t * TRV_COEF_L_M3 * (k > 0 ? k : 1);
  }
  function areaHa(geometry) {
    try { if (!geometry || !geometry.type) return null; const a = turf.area(geometry.type === 'Feature' ? geometry : turf.feature(geometry)) / 10000; return a > 0 ? a : null; } catch (_) { return null; }
  }
  // Cálculos del cuadro (acepta los campos del API: haCalc, haManual, distFilasM, ...)
  function calc(c) {
    c = c || {};
    const haCalc = c.geometry ? areaHa(c.geometry) : num(c.haCalc);
    const haManual = num(c.haManual);
    const ha = haManual > 0 ? haManual : haCalc;
    const pha = plantsPerHa(c.distFilasM, c.distPlantasM);
    const plantasManual = num(c.plantasManual);
    const plantas = plantasManual > 0 ? plantasManual : (pha && ha ? pha * ha : null);
    const t = trv(c.alturaCopaM, c.anchoCopaM, c.distFilasM);
    const cal = caldo(t, c.factorDensidad);
    const edad = num(c.anioPlantacion) ? new Date().getFullYear() - num(c.anioPlantacion) : null;
    return {
      haCalc: round(haCalc, 4), ha: round(ha, 4), haSource: haManual > 0 ? 'manual' : (haCalc ? 'mapa' : null),
      plantasHa: round(pha, 0), plantas: round(plantas, 0), plantasSource: plantasManual > 0 ? 'manual' : (plantas ? 'calculado' : null),
      trv: round(t, 0), caldo: round(cal, 0), edad
    };
  }

  // ---------- carencia vs. cosecha ----------
  const DAY = 86400e3;
  function harvestWindow(desde, hasta, ref) {
    // Ventana de cosecha (UTC, días completos) que termina después de "ref" (la de este año o la del próximo)
    const d = num(desde), h = num(hasta) || num(desde);
    if (!(d >= 1 && d <= 12)) return null;
    const r = new Date(ref);
    for (const y of [r.getUTCFullYear() - 1, r.getUTCFullYear(), r.getUTCFullYear() + 1]) {
      const start = Date.UTC(y, d - 1, 1);
      const endY = h >= d ? y : y + 1;
      const end = Date.UTC(endY, h, 1) - 1; // último instante del mes "hasta"
      if (end >= r.getTime()) return { start, end };
    }
    return null;
  }
  // { appDate, phiDays, desde, hasta, variedad } → { level: 'ok'|'warn'|'alert'|'info', text, safeDate, harvestStart }
  function harvestCheck(o) {
    const app = o.appDate ? new Date(o.appDate).getTime() : Date.now();
    const phi = num(o.phiDays);
    const name = o.variedad || 'la variedad';
    const w = harvestWindow(o.desde, o.hasta, app);
    if (!w) return { level: 'info', text: `Sin fecha de cosecha cargada para ${name}: verificá la carencia con el calendario de cosecha.` };
    const mes = MESES[new Date(w.start).getUTCMonth()];
    const fmt = (t) => { const x = new Date(t); return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0') + '/' + x.getUTCFullYear(); };
    if (phi == null) return { level: 'info', harvestStart: new Date(w.start).toISOString(), text: `Cosecha estimada de ${name} desde ${mes}. El producto no tiene carencia cargada: verificala en el marbete.` };
    const safe = app + phi * DAY;
    const out = { safeDate: new Date(safe).toISOString(), harvestStart: new Date(w.start).toISOString() };
    if (app >= w.start && app <= w.end) {
      return { ...out, level: 'alert', text: `La aplicación cae dentro de la cosecha estimada de ${name} (${mes} en adelante): con ${phi} días de carencia no se puede cosechar hasta el ${fmt(safe)}.` };
    }
    if (safe > w.start) {
      const late = Math.ceil((safe - w.start) / DAY);
      return { ...out, level: 'warn', text: `La carencia (${phi} días) termina el ${fmt(safe)}, ${late} día${late === 1 ? '' : 's'} después del inicio estimado de cosecha de ${name} (1/${String(new Date(w.start).getUTCMonth() + 1).padStart(2, '0')}).` };
    }
    const margin = Math.floor((w.start - safe) / DAY);
    return { ...out, level: 'ok', text: `Carencia OK: termina el ${fmt(safe)}, ${margin} días antes de la cosecha estimada de ${name} (${mes}).` };
  }

  // ---------- geometría: ruta vs. cuadros ----------
  function polysOf(geoms, bufferM) {
    const out = [];
    for (const g0 of geoms || []) {
      if (!g0) continue;
      let f = g0.type === 'Feature' ? g0 : turf.feature(g0);
      if (!f.geometry || !/Polygon$/.test(f.geometry.type)) continue;
      if (bufferM) { try { f = turf.buffer(f, bufferM / 1000, { units: 'kilometers' }) || f; } catch (_) { /* sin buffer */ } }
      out.push(f);
    }
    return out;
  }
  function inside(pt, polys) { return polys.some(p => turf.booleanPointInPolygon(pt, p)); }
  // Cuánto de la ruta queda fuera de los cuadros (muestreo cada ~2 m, tolerancia = medio ancho de pasada)
  function routeCheck(route, geoms, toleranceM) {
    const lines = route && route.coordinates ? (route.type === 'LineString' ? [route.coordinates] : route.coordinates) : [];
    const polys = polysOf(geoms, toleranceM == null ? 3 : toleranceM);
    let total = 0, out = 0; const outsidePasses = new Set();
    if (!polys.length || !lines.length) return { totalM: 0, outsideM: 0, pctOutside: 0, passesOutside: [] };
    lines.forEach((ln, i) => {
      for (let k = 1; k < ln.length; k++) {
        const a = ln[k - 1], b = ln[k];
        const d = turf.distance(a, b, { units: 'meters' });
        const n = Math.max(1, Math.ceil(d / 2));
        for (let s = 0; s < n; s++) {
          const t = (s + 0.5) / n;
          const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          total += d / n;
          if (!inside(p, polys)) { out += d / n; outsidePasses.add(i + 1); }
        }
      }
    });
    return { totalM: total, outsideM: out, pctOutside: total ? out / total * 100 : 0, passesOutside: [...outsidePasses] };
  }
  // Recorta cada pasada a los cuadros (con tolerancia): quedan sólo los tramos adentro de al menos 3 m
  function clipRoute(route, geoms, toleranceM) {
    const lines = route && route.coordinates ? (route.type === 'LineString' ? [route.coordinates] : route.coordinates) : [];
    const polys = polysOf(geoms, toleranceM == null ? 1 : toleranceM);
    const out = [];
    for (const ln of lines) {
      let cur = [], last = null;
      const flush = () => {
        if (last && cur.length && (cur[cur.length - 1][0] !== last[0] || cur[cur.length - 1][1] !== last[1])) cur.push(last);
        if (cur.length >= 2 && turf.length(turf.lineString(cur), { units: 'meters' }) >= 3) out.push(cur);
        cur = []; last = null;
      };
      for (let k = 1; k < ln.length; k++) {
        const a = ln[k - 1], b = ln[k];
        const n = Math.max(1, Math.ceil(turf.distance(a, b, { units: 'meters' })));
        for (let s = (k > 1 ? 1 : 0); s <= n; s++) {
          const t = s / n;
          const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          if (inside(p, polys)) {
            if (!cur.length || s === n) cur.push(p); // entrada y vértices originales
            last = p;
          } else if (cur.length) flush();
          else last = null;
        }
      }
      flush();
    }
    return out.length ? { type: 'MultiLineString', coordinates: out.map(l => l.map(c => [round(c[0], 7), round(c[1], 7)])) } : null;
  }
  // Pasadas paralelas en zigzag dentro del polígono, separadas "spacingM". bearing = rumbo de las filas
  // (grados; si falta, el lado más largo). Las pasadas van por el medio de cada entrefila.
  function generatePasses(geometry, spacingM, bearing) {
    const zone = geometry.type === 'Feature' ? geometry : turf.feature(geometry);
    const ring = zone.geometry.type === 'Polygon' ? zone.geometry.coordinates[0] : zone.geometry.coordinates[0][0];
    let brg = num(bearing);
    if (brg == null) {
      let best = 0; brg = 90;
      for (let i = 1; i < ring.length; i++) {
        const d = turf.distance(ring[i - 1], ring[i], { units: 'meters' });
        if (d > best) { best = d; brg = turf.bearing(ring[i - 1], ring[i]); }
      }
    }
    const angle = 90 - brg;
    const pivot = turf.centroid(zone).geometry.coordinates;
    const rotated = turf.transformRotate(zone, angle, { pivot });
    const [minX, minY, maxX, maxY] = turf.bbox(rotated);
    const stepLat = spacingM / 110540;
    const margin = (maxX - minX) * 0.05 + 0.0001;
    const lines = [];
    let row = 0;
    for (let y = minY + stepLat / 2; y < maxY; y += stepLat, row++) {
      const scan = turf.lineString([[minX - margin, y], [maxX + margin, y]]);
      const xs = turf.lineIntersect(scan, rotated).features.map(f => f.geometry.coordinates[0]).sort((a, b) => a - b);
      const segs = [];
      for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-7) segs.push([[xs[i], y], [xs[i + 1], y]]);
      if (row % 2) { segs.reverse(); segs.forEach(sg => sg.reverse()); }
      lines.push(...segs);
      if (lines.length > 500) break;
    }
    return lines.slice(0, 500).map(c => turf.transformRotate(turf.lineString(c), -angle, { pivot }).geometry.coordinates.map(p => [round(p[0], 7), round(p[1], 7)]));
  }
  const ORIENT_BEARING = { 'N-S': 0, 'E-O': 90, 'NE-SO': 45, 'NO-SE': 135 };

  // Centroide de varios polígonos → [lng, lat]
  function centroidOf(geoms) {
    const fs = polysOf(geoms, 0);
    if (!fs.length) return null;
    try { const c = turf.centroid(turf.featureCollection(fs)).geometry.coordinates; return Number.isFinite(c[0]) ? c : null; } catch (_) { return null; }
  }

  // Colores: por cultivo (catálogo) o por variedad (paleta estable por nombre)
  const PALETTE = ['#34d399', '#f87171', '#60a5fa', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#a3e635', '#e879f9', '#2dd4bf', '#facc15', '#93c5fd', '#fca5a5', '#c4b5fd', '#86efac'];
  function hash(s) { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
  const colorFor = (name) => PALETTE[hash(name) % PALETTE.length];

  // Normalización para buscar especies / variedades escritas a mano (importación)
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ESPECIES = {
    'pera': 'Peral', 'peral': 'Peral', 'peras': 'Peral', 'manzana': 'Manzano', 'manzano': 'Manzano', 'manzanas': 'Manzano',
    'cereza': 'Cerezo', 'cerezo': 'Cerezo', 'cerezas': 'Cerezo', 'durazno': 'Duraznero', 'duraznero': 'Duraznero', 'duraznos': 'Duraznero',
    'pelon': 'Pelón (nectarina)', 'nectarina': 'Pelón (nectarina)', 'nectarin': 'Pelón (nectarina)', 'pelon nectarina': 'Pelón (nectarina)',
    'ciruela': 'Ciruelo', 'ciruelo': 'Ciruelo', 'damasco': 'Damasco', 'membrillo': 'Membrillero', 'membrillero': 'Membrillero',
    'nogal': 'Nogal', 'nuez': 'Nogal', 'nogales': 'Nogal', 'almendro': 'Almendro', 'almendra': 'Almendro', 'vid': 'Vid', 'uva': 'Vid', 'vina': 'Vid', 'vinedo': 'Vid'
  };
  const especieToCultivo = (s) => ESPECIES[norm(s)] || null;

  return { TRV_COEF_L_M3, MESES, SISTEMAS, RIEGOS, ORIENTACIONES, ORIENT_BEARING, num, round, plantsPerHa, trv, caldo, areaHa, calc,
    harvestWindow, harvestCheck, routeCheck, clipRoute, generatePasses, centroidOf, colorFor, norm, especieToCultivo, PALETTE };
});
