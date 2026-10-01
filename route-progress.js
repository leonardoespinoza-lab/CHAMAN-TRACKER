// Avance del recorrido planificado: qué partes de las pasadas ya se recorrieron.
// Se usa en el panel del supervisor, en el tracker del aplicador y en las pruebas (Node).
//
// Cómo funciona: cada pasada se corta en tramos de ~2 m. Un tramo queda "hecho" cuando algún
// segmento del recorrido GPS pasa a menos de la tolerancia (por defecto 10 m) de su punto medio.
// Los tramos se indexan en una grilla, así cada punto GPS nuevo se procesa en tiempo constante.
(function (root) {
  const DEFAULT_TOLERANCE_M = 10;
  const CHUNK_M = 2;
  const MAX_CHUNKS = 60000;
  const MAX_JUMP_M = 60; // saltos más largos entre dos puntos no cuentan como recorrido (GPS perdido)

  function routeLines(geom) {
    if (!geom) return [];
    if (geom.type === 'Feature') return routeLines(geom.geometry);
    if (geom.type === 'FeatureCollection') return geom.features.flatMap(routeLines);
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
  }

  function toLngLat(p) {
    return Array.isArray(p) ? p : [p.lng, p.lat];
  }

  // Distancia al cuadrado de (px,py) al segmento (ax,ay)-(bx,by), en metros planos
  function distSqToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx - px, cy = ay + t * dy - py;
    return cx * cx + cy * cy;
  }

  class RouteProgress {
    constructor(route, toleranceM) {
      this.tol = toleranceM > 0 ? Number(toleranceM) : DEFAULT_TOLERANCE_M;
      const lines = routeLines(route).filter(l => Array.isArray(l) && l.length >= 2);
      this.empty = !lines.length;
      this.chunks = [];
      this.passes = [];
      this.totalM = 0;
      this.doneM = 0;
      if (this.empty) return;

      // Proyección equirrectangular local (suficiente para un lote)
      const [lng0, lat0] = lines[0][0];
      this.lng0 = lng0; this.lat0 = lat0;
      this.kx = 111320 * Math.cos(lat0 * Math.PI / 180);
      this.ky = 110540;

      // Largo total para elegir el tamaño de tramo
      let total = 0;
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const [ax, ay] = this.project(line[i - 1]), [bx, by] = this.project(line[i]);
          total += Math.hypot(bx - ax, by - ay);
        }
      }
      const chunkM = Math.max(CHUNK_M, total / MAX_CHUNKS);

      lines.forEach((line, pass) => {
        let along = 0;
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1], b = line[i];
          const [ax, ay] = this.project(a), [bx, by] = this.project(b);
          const len = Math.hypot(bx - ax, by - ay);
          if (!len) continue;
          const n = Math.max(1, Math.ceil(len / chunkM));
          for (let k = 0; k < n; k++) {
            const t0 = k / n, t1 = (k + 1) / n, tm = (k + 0.5) / n;
            this.chunks.push({
              pass,
              from: along + len * t0,
              len: len / n,
              a: [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
              b: [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1],
              x: ax + (bx - ax) * tm,
              y: ay + (by - ay) * tm,
              done: false
            });
          }
          along += len;
        }
        this.passes.push({ index: pass, lengthM: along });
      });
      this.totalM = this.passes.reduce((s, p) => s + p.lengthM, 0);

      // Grilla de tramos (celda = tolerancia)
      this.cell = Math.max(this.tol, 5);
      this.grid = new Map();
      this.chunks.forEach((c, i) => {
        const key = Math.floor(c.x / this.cell) + ',' + Math.floor(c.y / this.cell);
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, list = []);
        list.push(i);
      });
      this.processed = 0;
      this.lastPoint = null;
    }

    project(p) {
      const [lng, lat] = toLngLat(p);
      return [(lng - this.lng0) * this.kx, (lat - this.lat0) * this.ky];
    }

    reset() {
      for (const c of this.chunks) c.done = false;
      this.doneM = 0;
      this.processed = 0;
      this.lastPoint = null;
    }

    // Marca tramos cercanos al segmento a-b (en metros proyectados).
    // Sólo cuenta para la pasada MÁS CERCANA: en las chacras las entrefilas están a ~3,5 m y la
    // tolerancia del GPS (~5 m) es mayor, así que recorrer una entrefila no tiene que dar por
    // hechas también las vecinas.
    markSegment(ax, ay, bx, by) {
      const tol = this.tol, tol2 = tol * tol, cell = this.cell;
      const x0 = Math.floor((Math.min(ax, bx) - tol) / cell), x1 = Math.floor((Math.max(ax, bx) + tol) / cell);
      const y0 = Math.floor((Math.min(ay, by) - tol) / cell), y1 = Math.floor((Math.max(ay, by) + tol) / cell);
      const near = [];
      const best = new Map(); // pasada → distancia² mínima
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const list = this.grid.get(gx + ',' + gy);
          if (!list) continue;
          for (const i of list) {
            const c = this.chunks[i];
            const d2 = distSqToSegment(c.x, c.y, ax, ay, bx, by);
            if (d2 > tol2) continue;
            near.push(i);
            const b = best.get(c.pass);
            if (b === undefined || d2 < b) best.set(c.pass, d2);
          }
        }
      }
      if (!near.length) return false;
      let pass = -1, min = Infinity;
      for (const [k, d2] of best) if (d2 < min) { min = d2; pass = k; }
      let changed = false;
      for (const i of near) {
        const c = this.chunks[i];
        if (c.done || c.pass !== pass) continue;
        c.done = true;
        this.doneM += c.len;
        changed = true;
      }
      return changed;
    }

    // Recibe el recorrido completo ordenado por tiempo ([lng,lat] o {lng,lat}).
    // Si sólo se agregaron puntos al final, procesa lo nuevo; si no, recalcula todo.
    setTrack(points) {
      if (this.empty) return false;
      const n = points.length;
      const same = (p, q) => p && q && toLngLat(p)[0] === q[0] && toLngLat(p)[1] === q[1];
      if (n < this.processed || (this.processed && !same(points[this.processed - 1], this.lastPoint))) {
        this.reset();
      }
      let changed = false;
      for (let i = this.processed; i < n; i++) {
        const [x, y] = this.project(points[i]);
        const prev = i > 0 ? this.project(points[i - 1]) : null;
        if (prev && Math.hypot(x - prev[0], y - prev[1]) <= MAX_JUMP_M) {
          changed = this.markSegment(prev[0], prev[1], x, y) || changed;
        } else {
          changed = this.markSegment(x, y, x, y) || changed;
        }
      }
      this.processed = n;
      this.lastPoint = n ? toLngLat(points[n - 1]).slice() : null;
      return changed;
    }

    summary() {
      const pct = this.totalM ? Math.min(100, (this.doneM / this.totalM) * 100) : 0;
      return { totalM: this.totalM, doneM: this.doneM, remainingM: Math.max(0, this.totalM - this.doneM), pct };
    }

    // Tramos contiguos con el mismo estado: [{ pass, done, from, lengthM, coords }]
    runs() {
      const runs = [];
      let cur = null;
      for (const c of this.chunks) {
        if (cur && cur.pass === c.pass && cur.done === c.done && Math.abs(cur.from + cur.lengthM - c.from) < 0.01) {
          cur.coords.push(c.b);
          cur.lengthM += c.len;
        } else {
          cur = { pass: c.pass, done: c.done, from: c.from, lengthM: c.len, coords: [c.a, c.b] };
          runs.push(cur);
        }
      }
      return runs;
    }

    // GeoJSON para el mapa: cada tramo con la propiedad done (true = recorrido)
    toGeoJSON() {
      return {
        type: 'FeatureCollection',
        features: this.runs().map(r => ({
          type: 'Feature',
          properties: { done: r.done, pass: r.pass + 1 },
          geometry: { type: 'LineString', coordinates: r.coords }
        }))
      };
    }

    // Tramos pendientes (ignora restos menores a minM, ruido en los bordes de la tolerancia)
    remaining(minM = 3) {
      return this.runs().filter(r => !r.done && r.lengthM >= minM).map(r => ({
        pass: r.pass + 1,
        fromM: r.from,
        lengthM: r.lengthM,
        start: r.coords[0],
        middle: r.coords[Math.floor(r.coords.length / 2)],
        coords: r.coords
      }));
    }
  }

  const api = { RouteProgress, routeLines, DEFAULT_TOLERANCE_M };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : this);
