// Zona derivada de la ruta y zona cubierta por el GPS. Se usa en el servidor (Node, al guardar
// y al finalizar), en el panel del supervisor y en el tracker (navegador, con turf global).
//
// Zona de aplicación (derivada de la ruta):
//   1) cada pasada se ensancha medio ancho de pasada para cada lado (el ancho de la barra),
//   2) se hace un "cierre": se ensancha medio ancho más y se vuelve a achicar lo mismo. Así los
//      huecos entre pasadas vecinas más angostos que un ancho de pasada (pasadas un poco más
//      separadas que la barra, giros) se rellenan y la zona queda como un solo lote prolijo;
//      pasadas separadas más de dos anchos quedan como zonas aparte (ahí no se aplica).
// Zona cubierta (al finalizar): el recorrido GPS real ensanchado medio ancho de pasada para
// cada lado, recortado a la zona de aplicación. Cobertura % = área cubierta / área de la zona.
(function (root) {
  const T = (typeof module !== 'undefined' && module.exports) ? require('@turf/turf') : root.turf;
  // Chacras de pera y manzana del Alto Valle: la pulverizadora (turbina) pasa por cada entrefila,
  // así que el ancho de pasada es la distancia entre filas (INTA: 3,5 m en plantaciones nuevas)
  const DEFAULT_PASS_WIDTH_M = 3.5;
  const MIN_PASS_WIDTH_M = 2;
  const MAX_PASS_WIDTH_M = 10;
  // Tolerancia del GPS (aparte del ancho: el error del celular, ~5 m, es mayor que la entrefila)
  const DEFAULT_GPS_TOLERANCE_M = 5;
  const MIN_GPS_TOLERANCE_M = 3;
  const MAX_GPS_TOLERANCE_M = 10;
  const MAX_JUMP_M = 60;       // saltos más largos entre puntos GPS: señal perdida, no se pinta
  const MAX_VERTS = 800;       // vértices del recorrido simplificado (el buffer es costoso)
  const CHUNK_VERTS = 300;

  function routeLines(geom) {
    if (!geom) return [];
    if (geom.type === 'Feature') return routeLines(geom.geometry);
    if (geom.type === 'FeatureCollection') return geom.features.flatMap(routeLines);
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
  }

  function clampWidth(w) {
    const n = Number(w);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PASS_WIDTH_M;
    return Math.min(MAX_PASS_WIDTH_M, Math.max(MIN_PASS_WIDTH_M, n));
  }

  // Une polígonos (Feature) en uno solo; tolera listas de 0 o 1 elementos
  function unionAll(features) {
    const fs = features.filter(Boolean);
    if (!fs.length) return null;
    let cur = fs;
    while (cur.length > 1) {
      const next = [];
      for (let i = 0; i < cur.length; i += 8) {
        const group = cur.slice(i, i + 8);
        next.push(group.length > 1 ? (T.union(T.featureCollection(group)) || group[0]) : group[0]);
      }
      cur = next;
    }
    return cur[0];
  }

  function tidy(feature) {
    if (!feature || !feature.geometry) return null;
    const g = feature.geometry;
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return null;
    if (!g.coordinates.length) return null;
    try { return T.truncate(feature, { precision: 7, coordinates: 2, mutate: true }); } catch (_) { return feature; }
  }

  // Zona de aplicación a partir de las pasadas (geometría Polygon/MultiPolygon o null)
  function deriveZone(route, passWidthM) {
    const lines = routeLines(route).filter(l => Array.isArray(l) && l.length >= 2);
    if (!lines.length) return null;
    const w = clampWidth(passWidthM);
    const ml = T.multiLineString(lines);
    let zone = null;
    try {
      const wide = T.buffer(ml, w, { units: 'meters', steps: 8 });
      zone = wide && T.buffer(wide, -w / 2, { units: 'meters', steps: 8 });
    } catch (_) { zone = null; }
    if (!zone || !zone.geometry) zone = T.buffer(ml, w / 2, { units: 'meters', steps: 8 });
    try { zone = T.simplify(zone, { tolerance: 0.000002, highQuality: false }); } catch (_) {}
    const out = tidy(zone);
    return out ? out.geometry : null;
  }

  function areaM2(geom) {
    if (!geom) return 0;
    return T.area(geom.type === 'Feature' ? geom : T.feature(geom));
  }

  function lengthM(coords) {
    if (!coords || coords.length < 2) return 0;
    return T.length(T.lineString(coords), { units: 'kilometers' }) * 1000;
  }

  function toLngLat(p) { return Array.isArray(p) ? p : [p.lng, p.lat]; }

  // Recorrido GPS → tramos continuos (corta en saltos), suavizados y simplificados
  function trackSegments(points, passWidthM) {
    const pts = points.map(toLngLat).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 2) return [];
    const kx = 111320 * Math.cos(pts[0][1] * Math.PI / 180), ky = 110540;
    const dist = (a, b) => Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
    // Cada punto sigue al tramo abierto más cercano (a menos de MAX_JUMP_M); si no hay, abre uno nuevo.
    // Así un salto de señal no se pinta, y puntos de envíos atrasados intercalados en el tiempo
    // no se pierden ni se unen con líneas falsas.
    const all = [];
    let open = [];
    for (const p of pts) {
      let best = null, bestD = Infinity;
      for (const sg of open) {
        const d = dist(sg[sg.length - 1], p);
        if (d < bestD) { bestD = d; best = sg; }
      }
      if (best && bestD <= MAX_JUMP_M) {
        if (bestD >= 0.05) best.push(p);
        if (open[open.length - 1] !== best) { open = open.filter(x => x !== best); open.push(best); }
      } else {
        const sg = [p];
        all.push(sg);
        open.push(sg);
        if (open.length > 6) open.shift();
      }
    }
    const segs = all.filter(sg => sg.length >= 2);
    // Suavizado leve (promedio de 3 puntos): saca el "serrucho" del GPS sin mover las pasadas
    // (sólo entre puntos vecinos cercanos: si el GPS salta de una pasada a otra no se promedia)
    const near = Math.max(5, clampWidth(passWidthM));
    const smooth = segs.map(s => s.map((p, i) => {
      if (i === 0 || i === s.length - 1) return p;
      if (dist(s[i - 1], p) > near || dist(p, s[i + 1]) > near) return p;
      return [(s[i - 1][0] + p[0] + s[i + 1][0]) / 3, (s[i - 1][1] + p[1] + s[i + 1][1]) / 3];
    }));
    // Simplificación adaptativa: tolerancia de 0,5 m en adelante hasta que quede liviano
    const maxTolM = Math.max(1, clampWidth(passWidthM) / 4);
    let tolM = 0.5, out;
    for (;;) {
      out = smooth.map(s => {
        try { return T.simplify(T.lineString(s), { tolerance: tolM / 111000, highQuality: false }).geometry.coordinates; }
        catch (_) { return s; }
      });
      const verts = out.reduce((n, s) => n + s.length, 0);
      if (verts <= MAX_VERTS || tolM >= maxTolM) break;
      tolM = Math.min(maxTolM, tolM * 2);
    }
    return out.filter(s => s.length >= 2);
  }

  // Zona cubierta por el recorrido GPS: { geometry, pct, coveredM2, zoneM2 }
  function coveredZone(points, passWidthM, zoneGeom) {
    const w = clampWidth(passWidthM);
    const zoneM2 = areaM2(zoneGeom);
    const empty = { geometry: null, pct: 0, coveredM2: 0, zoneM2 };
    const segs = trackSegments(points || [], w);
    if (!segs.length) return empty;
    const pieces = [];
    for (const s of segs) {
      for (let i = 0; i < s.length - 1; i += CHUNK_VERTS) {
        const part = s.slice(i, i + CHUNK_VERTS + 1);
        if (part.length < 2) continue;
        try { pieces.push(T.buffer(T.lineString(part), w / 2, { units: 'meters', steps: 6 })); } catch (_) {}
      }
    }
    let covered = unionAll(pieces);
    if (!covered) return empty;
    if (zoneGeom) {
      try { covered = T.intersect(T.featureCollection([T.feature(zoneGeom), covered])); } catch (_) { covered = null; }
    }
    covered = tidy(covered);
    if (!covered) return empty;
    const coveredM2 = T.area(covered);
    const pct = zoneM2 ? Math.min(100, coveredM2 / zoneM2 * 100) : 0;
    return { geometry: covered.geometry, pct, coveredM2, zoneM2 };
  }

  // Copia de una pasada desplazada "distM" metros (positivo = a la derecha del sentido de avance)
  function offsetLine(coords, distM) {
    if (!coords || coords.length < 2) return null;
    try { return T.lineOffset(T.lineString(coords), distM, { units: 'meters' }).geometry.coordinates; }
    catch (_) { return null; }
  }

  const api = { deriveZone, coveredZone, offsetLine, lengthM, areaM2, routeLines, clampWidth, trackSegments,
    DEFAULT_PASS_WIDTH_M, MIN_PASS_WIDTH_M, MAX_PASS_WIDTH_M,
    DEFAULT_GPS_TOLERANCE_M, MIN_GPS_TOLERANCE_M, MAX_GPS_TOLERANCE_M };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZoneGeo = api;
})(typeof window !== 'undefined' ? window : this);
