// Editor de la ruta (pasadas) sobre el mapa: tocar/clic para agregar puntos, deshacer,
// terminar sin doble toque, otra pasada, borrar, arrastrar puntos, insertar puntos desde el
// medio de un tramo, enderezar y duplicar una pasada en paralela al ancho de pasada.
// También el modo "contorno" (avanzado): se marcan las esquinas y se generan pasadas en zigzag.
(function (root) {
  const EMPTY = { type: 'FeatureCollection', features: [] };
  const TOUCH = root.matchMedia && root.matchMedia('(pointer: coarse)').matches;
  const P = 'redit-';
  const fmtLen = (m) => m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';

  // Pasadas paralelas al lado más largo del contorno, en zigzag, separadas "spacingM" metros
  function generatePasses(zone, spacingM) {
    const ring = zone.geometry.type === 'Polygon' ? zone.geometry.coordinates[0] : zone.geometry.coordinates[0][0];
    let best = 0, bearing = 90;
    for (let i = 1; i < ring.length; i++) {
      const d = turf.distance(ring[i - 1], ring[i], { units: 'meters' });
      if (d > best) { best = d; bearing = turf.bearing(ring[i - 1], ring[i]); }
    }
    const angle = 90 - bearing;
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
      for (let i = 0; i + 1 < xs.length; i += 2) {
        if (xs[i + 1] - xs[i] > 1e-7) segs.push([[xs[i], y], [xs[i + 1], y]]);
      }
      if (row % 2) { segs.reverse(); segs.forEach(sg => sg.reverse()); }
      lines.push(...segs);
      if (lines.length > 500) break;
    }
    return lines.slice(0, 500).map(c => turf.transformRotate(turf.lineString(c), -angle, { pivot }).geometry.coordinates);
  }

  class RouteEditor {
    // opts: { getWidth(): metros, onChange(info) }
    constructor(map, opts) {
      this.map = map;
      this.opts = opts || {};
      this.passes = [];          // [[lng, lat], ...] por pasada
      this.mode = 'idle';        // 'idle' | 'draw' | 'outline'
      this.active = -1;          // pasada que se está dibujando
      this.selected = -1;        // pasada seleccionada
      this.outline = [];
      this.history = [];
      this.readOnly = false;
      this.visible = false;
      this.cursor = null;        // posición del mouse (línea guía en la compu)
      this.ready = false;
    }

    // ---------- inicialización ----------
    init() {
      const map = this.map;
      ['zone', 'lines', 'guide', 'points', 'outline'].forEach(s => map.addSource(P + s, { type: 'geojson', data: EMPTY }));
      map.addLayer({ id: P + 'zone-fill', type: 'fill', source: P + 'zone', paint: { 'fill-color': '#f8fafc', 'fill-opacity': 0.09 } });
      map.addLayer({ id: P + 'zone-line', type: 'line', source: P + 'zone', paint: { 'line-color': '#f8fafc', 'line-width': 1.5, 'line-opacity': 0.7, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: P + 'outline-fill', type: 'fill', source: P + 'outline', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.15 } });
      map.addLayer({ id: P + 'outline-line', type: 'line', source: P + 'outline', paint: { 'line-color': '#38bdf8', 'line-width': 2.5, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: P + 'line-hit', type: 'line', source: P + 'lines', paint: { 'line-color': '#000', 'line-width': TOUCH ? 30 : 16, 'line-opacity': 0.01 } });
      // Ancho según el zoom: las entrefilas están a ~3,5 m y de lejos las líneas no se tienen que pisar
      const byZoom = (a, b) => ['interpolate', ['linear'], ['zoom'], 14, a * 0.35, 16, a * 0.5, 17, a * 0.65, 18, a * 0.85, 19, a, 21, b];
      map.addLayer({
        id: P + 'casing', type: 'line', source: P + 'lines', layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#0b1220', 'line-width': byZoom(9, 13), 'line-opacity': 0.6 }
      });
      map.addLayer({
        id: P + 'lines', type: 'line', source: P + 'lines', layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['case', ['get', 'sel'], '#22d3ee', ['get', 'act'], '#fde047', '#facc15'],
          'line-width': byZoom(5.5, 8)
        }
      });
      map.addLayer({
        id: P + 'guide', type: 'line', source: P + 'guide',
        paint: { 'line-color': '#fde047', 'line-width': 3, 'line-dasharray': [1, 1], 'line-opacity': 0.9 }
      });
      map.addLayer({
        id: P + 'mids', type: 'circle', source: P + 'points', filter: ['==', ['get', 'kind'], 'mid'],
        paint: { 'circle-radius': TOUCH ? 7 : 5, 'circle-color': '#22d3ee', 'circle-opacity': 0.75, 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.5 }
      });
      map.addLayer({
        id: P + 'vertices', type: 'circle', source: P + 'points', filter: ['!=', ['get', 'kind'], 'mid'],
        paint: {
          'circle-radius': ['match', ['get', 'kind'], 'last', TOUCH ? 11 : 9, 'start', TOUCH ? 9 : 7, TOUCH ? 7 : 5.5],
          'circle-color': ['match', ['get', 'kind'], 'last', '#22c55e', 'start', '#facc15', '#ffffff'],
          'circle-stroke-color': '#0b1220', 'circle-stroke-width': 2
        }
      });
      map.addLayer({ id: P + 'vertex-hit', type: 'circle', source: P + 'points', paint: { 'circle-radius': TOUCH ? 22 : 11, 'circle-color': '#000', 'circle-opacity': 0.01 } });
      if (map.getStyle().glyphs) {
        map.addLayer({
          id: P + 'labels', type: 'symbol', source: P + 'lines', filter: ['>', ['get', 'n'], 0],
          layout: { 'symbol-placement': 'line-center', 'text-field': ['to-string', ['get', 'n']], 'text-size': 13, 'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': false },
          paint: { 'text-color': '#0b1220', 'text-halo-color': '#facc15', 'text-halo-width': 2.5 }
        });
      }
      this.layerIds = ['zone-fill', 'zone-line', 'outline-fill', 'outline-line', 'line-hit', 'casing', 'lines', 'guide', 'mids', 'vertices', 'vertex-hit', 'labels'].map(i => P + i).filter(i => map.getLayer(i));

      // Barra de instrucciones (arriba) y de botones (abajo) dentro del mapa
      const box = map.getContainer();
      this.banner = document.createElement('div');
      this.banner.className = 'redit-banner';
      this.banner.id = 'reditBanner';
      this.bar = document.createElement('div');
      this.bar.className = 'redit-bar';
      this.bar.id = 'reditBar';
      box.appendChild(this.banner);
      box.appendChild(this.bar);
      this.bar.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (b && !b.disabled) this.action(b.dataset.act);
      });

      map.on('click', (e) => this.onClick(e));
      map.on('mousemove', (e) => {
        if (!this.visible) return;
        if (this.mode === 'draw' || this.mode === 'outline') { this.cursor = [e.lngLat.lng, e.lngLat.lat]; this.renderGuide(); }
        const hit = !this.readOnly && map.queryRenderedFeatures(e.point, { layers: [P + 'vertex-hit'] }).length;
        map.getCanvas().style.cursor = hit ? 'grab' : (this.mode !== 'idle' ? 'crosshair' : '');
      });
      map.on('mouseout', () => { this.cursor = null; this.renderGuide(); });
      const down = (e) => this.onDown(e);
      map.on('mousedown', P + 'vertex-hit', down);
      map.on('touchstart', P + 'vertex-hit', down);
      map.on('rotate', () => this.renderUi());
      document.addEventListener('keydown', (e) => {
        if (!this.visible || this.readOnly || /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.action('undo'); }
        else if (e.key === 'Enter' || e.key === 'Escape') { if (this.mode === 'draw') this.action('finish'); else if (this.mode === 'outline') this.action(e.key === 'Enter' ? 'generate' : 'cancelOutline'); else if (this.selected >= 0) this.action('deselect'); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected >= 0 && this.mode === 'idle') { e.preventDefault(); this.action('delete'); }
      });
      this.ready = true;
      this.setVisible(this.visible);
    }

    // ---------- API ----------
    setVisible(v) {
      this.visible = v;
      if (!this.ready) return;
      this.layerIds.forEach(id => this.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none'));
      if (!v) { this.mode = 'idle'; this.active = -1; this.selected = -1; this.map.doubleClickZoom.enable(); }
      this.render();
    }
    setReadOnly(ro) { this.readOnly = ro; if (ro) { this.mode = 'idle'; this.selected = -1; } this.render(); }
    setPasses(lines) {
      this.passes = (lines || []).filter(l => l && l.length >= 2).map(l => l.map(c => [c[0], c[1]]));
      this.history = []; this.mode = 'idle'; this.active = -1; this.selected = -1; this.outline = [];
      this.render();
    }
    getRoute() {
      const lines = this.passes.filter(l => l.length >= 2);
      return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
    }
    width() { return (this.opts.getWidth && this.opts.getWidth()) || 14; }
    info() {
      const lens = this.passes.map(l => ZoneGeo.lengthM(l));
      return { count: this.passes.filter(l => l.length >= 2).length, lengths: lens, totalM: lens.reduce((a, b) => a + b, 0), zone: this.zone };
    }

    snapshot() { this.history.push(JSON.stringify(this.passes)); if (this.history.length > 100) this.history.shift(); }

    action(act) {
      if (this.readOnly) return;
      const w = this.width();
      switch (act) {
        case 'draw':
          this.finishActive();
          this.snapshot();
          this.passes.push([]);
          this.active = this.passes.length - 1;
          this.selected = -1;
          this.mode = 'draw';
          this.map.doubleClickZoom.disable();
          break;
        case 'finish':
          this.finishActive();
          break;
        case 'next':
          this.finishActive();
          this.action('draw');
          return;
        case 'undo': {
          if (this.mode === 'outline') { this.outline.pop(); break; }
          if (this.mode === 'draw' && this.active >= 0 && this.passes[this.active].length) {
            this.passes[this.active].pop();
            break;
          }
          const prev = this.history.pop();
          if (prev != null) {
            this.passes = JSON.parse(prev);
            if (this.mode === 'draw') {
              // Si se deshizo la creación de la pasada, salir del modo dibujo
              if (this.active >= this.passes.length) { this.mode = 'idle'; this.active = -1; this.map.doubleClickZoom.enable(); }
            }
            if (this.selected >= this.passes.length) this.selected = -1;
          }
          break;
        }
        case 'delete':
          if (this.selected < 0) break;
          this.snapshot();
          this.passes.splice(this.selected, 1);
          this.selected = -1;
          break;
        case 'deselect':
          this.selected = -1;
          break;
        case 'straight':
          if (this.selected < 0) break;
          this.snapshot();
          { const l = this.passes[this.selected]; this.passes[this.selected] = [l[0], l[l.length - 1]]; }
          break;
        case 'parA':
        case 'parB':
          // En sentido contrario (ida y vuelta), al final de la ruta, y queda seleccionada para seguir duplicando
          this.parallel(act === 'parA' ? 'A' : 'B', 1);
          return;
        case 'outline':
          this.finishActive();
          this.selected = -1;
          this.outline = [];
          this.mode = 'outline';
          this.map.doubleClickZoom.disable();
          break;
        case 'cancelOutline':
          this.outline = []; this.mode = 'idle'; this.map.doubleClickZoom.enable();
          break;
        case 'generate': {
          if (this.outline.length < 3) { alert('Marcá al menos 3 esquinas del contorno.'); return; }
          const ring = this.outline.concat([this.outline[0]]);
          let lines = [];
          try { lines = generatePasses(turf.polygon([ring]), w); } catch (_) { lines = []; }
          if (!lines.length) { alert('No se pudieron generar pasadas: probá con un ancho de pasada menor.'); return; }
          if (this.passes.length && !confirm(`¿Reemplazar las ${this.passes.length} pasadas actuales por ${lines.length} pasadas generadas?`)) return;
          this.snapshot();
          this.passes = lines;
          // El contorno se descarta: lo que se guarda es la ruta
          this.outline = []; this.mode = 'idle'; this.map.doubleClickZoom.enable();
          break;
        }
        case 'clear':
          if (!this.passes.length) break;
          if (!confirm('¿Borrar toda la ruta (' + this.passes.length + ' pasadas)?')) return;
          this.snapshot();
          this.passes = []; this.selected = -1; this.active = -1; this.mode = 'idle';
          break;
      }
      this.render();
    }

    select(i) {
      if (this.readOnly || this.mode !== 'idle') return;
      this.selected = i;
      this.render();
    }

    finishActive() {
      if (this.mode === 'draw') {
        if (this.active >= 0 && this.passes[this.active] && this.passes[this.active].length < 2) {
          this.passes.splice(this.active, 1);
          this.history.pop(); // la pasada vacía no cuenta como cambio
        }
        this.mode = 'idle';
        this.active = -1;
        this.map.doubleClickZoom.enable();
      }
    }

    // Hacia qué lado de la pantalla queda cada paralela de la pasada seleccionada
    sides() {
      const l = this.passes[this.selected];
      const off = l && ZoneGeo.offsetLine([l[0], l[l.length - 1]], 10);
      if (!off) return { a: 1, b: -1, arrowA: '→', arrowB: '←' };
      const p0 = this.map.project(l[0]), p1 = this.map.project(off[0]);
      const dx = p1.x - p0.x, dy = p1.y - p0.y; // dirección en pantalla de la paralela "a la derecha"
      let arrowRight;
      if (Math.abs(dx) > Math.abs(dy)) arrowRight = dx > 0 ? '→' : '←';
      else arrowRight = dy > 0 ? '↓' : '↑';
      const opp = { '→': '←', '←': '→', '↑': '↓', '↓': '↑' };
      // Botón A = arriba o izquierda, B = abajo o derecha (orden estable en pantalla)
      const firstIsRight = arrowRight === '↑' || arrowRight === '←';
      return firstIsRight ? { a: 1, b: -1, arrowA: arrowRight, arrowB: opp[arrowRight] } : { a: -1, b: 1, arrowA: opp[arrowRight], arrowB: arrowRight };
    }

    // ---------- interacción con el mapa ----------
    hit(point) {
      return this.map.queryRenderedFeatures(point, { layers: [P + 'vertex-hit', P + 'line-hit'] });
    }

    onClick(e) {
      if (!this.visible || this.readOnly) return;
      if (this.dragEndedAt && Date.now() - this.dragEndedAt < 350) return;
      const pt = [e.lngLat.lng, e.lngLat.lat];
      if (this.mode === 'draw') {
        const line = this.passes[this.active];
        const hits = this.map.queryRenderedFeatures(e.point, { layers: [P + 'vertex-hit'] });
        const last = hits.find(f => f.properties.pass === this.active && f.properties.kind === 'last');
        // Tocar de nuevo el último punto termina la pasada
        if (last && line.length >= 2) { this.action('finish'); return; }
        line.push(pt);
        this.render();
        return;
      }
      if (this.mode === 'outline') {
        this.outline.push(pt);
        this.render();
        return;
      }
      this.selected = this.nearestPass(e.point);
      this.render();
    }

    // Pasada más cercana al punto tocado (en píxeles), entre las que caen bajo el dedo
    nearestPass(point) {
      const cands = new Set(this.hit(point).map(h => h.properties.pass).filter(v => v != null).map(Number));
      let best = -1, bestD = Infinity;
      for (const i of cands) {
        const l = this.passes[i];
        if (!l) continue;
        const pts = l.map(c => this.map.project(c));
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1], b = pts[k];
          const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
          let t = len2 ? ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(a.x + t * dx - point.x, a.y + t * dy - point.y);
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      return best;
    }

    // Copias paralelas de la pasada seleccionada, cada una a un ancho de pasada de la anterior
    parallel(which, n) {
      if (this.readOnly || this.selected < 0) return;
      const side = this.sides();
      const sign = which === 'A' ? side.a : side.b;
      const w = this.width();
      n = Math.max(1, Math.min(200, Math.round(n || 1)));
      this.snapshot();
      let src = this.passes[this.selected];
      let flip = false;
      for (let k = 0; k < n && this.passes.length < 500; k++) {
        // la copia va en sentido contrario (ida y vuelta); se desplaza respecto del sentido original
        const base = flip ? src.slice().reverse() : src;
        const copy = ZoneGeo.offsetLine(base, sign * w);
        if (!copy) break;
        flip = !flip;
        const next = flip ? copy.slice().reverse() : copy;
        this.passes.push(next);
        src = next;
      }
      this.selected = this.passes.length - 1;
      this.render();
    }

    onDown(e) {
      if (!this.visible || this.readOnly || this.mode === 'outline') return;
      if (e.originalEvent && e.originalEvent.touches && e.originalEvent.touches.length > 1) return;
      const f = e.features && e.features[0];
      if (!f) return;
      const pass = Number(f.properties.pass);
      let idx = Number(f.properties.idx);
      const kind = f.properties.kind;
      if (this.mode === 'draw' && pass !== this.active) return;
      e.preventDefault(); // que el mapa no se desplace mientras se arrastra el punto
      const map = this.map;
      const touch = e.type === 'touchstart';
      const moveEvt = touch ? 'touchmove' : 'mousemove', upEvt = touch ? 'touchend' : 'mouseup';
      let moved = false;
      const startPt = e.point;
      const onMove = (ev) => {
        if (ev.originalEvent && ev.originalEvent.touches && ev.originalEvent.touches.length > 1) return;
        if (!moved) {
          if (Math.hypot(ev.point.x - startPt.x, ev.point.y - startPt.y) < 4) return;
          moved = true;
          this.snapshot();
          if (kind === 'mid') { this.passes[pass].splice(idx + 1, 0, null); idx = idx + 1; }
          if (this.mode === 'idle') this.selected = pass;
        }
        if (ev.preventDefault) ev.preventDefault();
        this.passes[pass][idx] = [ev.lngLat.lng, ev.lngLat.lat];
        this.scheduleRender();
      };
      const onUp = () => {
        map.off(moveEvt, onMove);
        map.getCanvas().style.cursor = '';
        if (moved) { this.dragEndedAt = Date.now(); this.render(); }
      };
      map.on(moveEvt, onMove);
      map.once(upEvt, onUp);
    }

    scheduleRender() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = null; this.render(); });
    }

    // ---------- dibujo ----------
    render() {
      if (!this.ready) return;
      const map = this.map;
      const lines = [], points = [];
      const showAll = false; // puntos sólo en la pasada que se edita (las entrefilas están muy juntas)
      this.passes.forEach((l, i) => {
        if (l.length >= 2) {
          lines.push({ type: 'Feature', properties: { pass: i, n: i + 1, sel: i === this.selected, act: i === this.active }, geometry: { type: 'LineString', coordinates: l } });
        }
        if (this.readOnly) return;
        const editable = i === this.selected || i === this.active;
        if (!showAll && !editable) return;
        l.forEach((c, k) => {
          let kind = 'v';
          if (i === this.active && k === l.length - 1) kind = 'last';
          else if (k === 0) kind = 'start';
          points.push({ type: 'Feature', properties: { pass: i, idx: k, kind }, geometry: { type: 'Point', coordinates: c } });
          if (i === this.selected && k < l.length - 1) {
            const n = l[k + 1];
            points.push({ type: 'Feature', properties: { pass: i, idx: k, kind: 'mid' }, geometry: { type: 'Point', coordinates: [(c[0] + n[0]) / 2, (c[1] + n[1]) / 2] } });
          }
        });
      });
      if (this.mode === 'outline') {
        this.outline.forEach((c, k) => points.push({ type: 'Feature', properties: { idx: k, kind: k === this.outline.length - 1 ? 'last' : 'v' }, geometry: { type: 'Point', coordinates: c } }));
      }
      map.getSource(P + 'lines').setData({ type: 'FeatureCollection', features: lines });
      map.getSource(P + 'points').setData({ type: 'FeatureCollection', features: points });
      const ol = this.outline;
      map.getSource(P + 'outline').setData(this.mode !== 'outline' || ol.length < 2 ? EMPTY : {
        type: 'Feature', properties: {},
        geometry: ol.length >= 3 ? { type: 'Polygon', coordinates: [ol.concat([ol[0]])] } : { type: 'LineString', coordinates: ol }
      });
      this.renderGuide();
      this.updateZone();
      this.renderUi();
      if (this.opts.onChange) this.opts.onChange(this.info());
    }

    updateZone() {
      if (this.zoneTimer) clearTimeout(this.zoneTimer);
      const compute = () => {
        this.zone = this.passes.some(l => l.length >= 2) ? ZoneGeo.deriveZone(this.getRoute(), this.width()) : null;
        if (this.ready) this.map.getSource(P + 'zone').setData(this.zone ? { type: 'Feature', properties: {}, geometry: this.zone } : EMPTY);
        if (this.opts.onZone) this.opts.onZone(this.zone);
      };
      // Mientras se arrastra se recalcula con un poco de demora (el buffer cuesta)
      this.zoneTimer = setTimeout(compute, this.raf ? 200 : 60);
    }

    renderGuide() {
      if (!this.ready) return;
      let data = EMPTY;
      const line = this.mode === 'draw' ? this.passes[this.active] : this.mode === 'outline' ? this.outline : null;
      if (line && line.length && this.cursor && !TOUCH) {
        data = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [line[line.length - 1], this.cursor] } };
      }
      this.map.getSource(P + 'guide').setData(data);
    }

    renderUi() {
      if (!this.ready) return;
      const show = this.visible;
      this.banner.style.display = show ? '' : 'none';
      this.bar.style.display = show && !this.readOnly ? '' : 'none';
      if (!show) return;
      const tap = TOUCH ? 'Tocá' : 'Hacé clic en';
      const inf = this.info();
      const btn = (act, label, cls = '') => `<button type="button" class="${cls}" data-act="${act}" id="redit-${act}">${label}</button>`;
      const undo = this.history.length || (this.mode === 'draw' && this.passes[this.active] && this.passes[this.active].length) || (this.mode === 'outline' && this.outline.length)
        ? btn('undo', '↶ Deshacer') : '';
      let text, bar = '';
      if (this.readOnly) {
        text = `🔒 Ruta bloqueada: el trabajo ya está en curso (${inf.count} pasada${inf.count === 1 ? '' : 's'} · ${fmtLen(inf.totalM)}).`;
      } else if (this.mode === 'draw') {
        const l = this.passes[this.active] || [];
        const len = ZoneGeo.lengthM(l);
        text = l.length === 0
          ? `<b>Pasada ${this.active + 1}:</b> ${tap} el mapa donde empieza la pasada.`
          : l.length === 1
            ? `<b>Pasada ${this.active + 1}:</b> ${tap} el mapa donde termina (o en cada giro).`
            : `<b>Pasada ${this.active + 1}:</b> ${l.length} puntos · ${fmtLen(len)}. Seguí agregando puntos o tocá <b>✔ Terminar</b>.`;
        bar = undo + btn('finish', '✔ Terminar', 'ok') + (l.length >= 2 ? btn('next', '＋ Otra pasada') : '');
      } else if (this.mode === 'outline') {
        text = `<b>Contorno del lote:</b> ${tap} cada esquina (${this.outline.length}). Con 3 o más, <b>⚡ Generar pasadas</b> cada ${String(this.width()).replace(".", ",")} m. El contorno no se guarda: queda la ruta.`;
        bar = undo + btn('generate', '⚡ Generar pasadas', 'ok') + btn('cancelOutline', '✕ Cancelar');
      } else if (this.selected >= 0) {
        const s = this.sides();
        const len = inf.lengths[this.selected] || 0;
        text = `<b>Pasada ${this.selected + 1}</b> · ${fmtLen(len)}. Arrastrá los puntos para ajustarla (los celestes agregan un punto) o duplicala en paralela a ${String(this.width()).replace(".", ",")} m.`;
        bar = btn('parA', `Paralela ${s.arrowA}`) + btn('parB', `Paralela ${s.arrowB}`) + btn('straight', '📏 Enderezar') +
          btn('delete', '🗑️ Borrar', 'danger') + undo + btn('deselect', '✕');
      } else if (!inf.count) {
        text = `Dibujá la <b>ruta</b> que va a recorrer la pulverizadora: ${TOUCH ? 'tocá' : 'hacé clic en'} <b>〰️ Dibujar pasada</b> y marcá el inicio y el final de cada pasada. La zona se calcula sola.`;
        bar = btn('draw', '〰️ Dibujar pasada', 'ok') + undo;
      } else {
        text = `<b>${inf.count} pasada${inf.count === 1 ? '' : 's'} · ${fmtLen(inf.totalM)}</b>. ${tap} una pasada para ajustarla o duplicarla en paralela.`;
        bar = btn('draw', '〰️ Otra pasada', 'ok') + undo;
      }
      this.banner.innerHTML = text;
      if (this.bar.dataset.html !== bar) { this.bar.innerHTML = bar; this.bar.dataset.html = bar; }
    }
  }

  root.RouteEditor = RouteEditor;
  root.generatePasses = generatePasses;
})(window);
