// Estilo común en el mapa (panel del supervisor y tracker del aplicador).
// La ruta es la protagonista: planificada en amarillo intenso a trazos con borde oscuro,
// lo hecho pintado en verde con el ancho real de la pasada; la zona queda de fondo, suave.
(function (root) {
  const C = { plan: '#facc15', casing: '#0b1220', done: '#22c55e', zone: '#f8fafc', covered: '#22c55e', track: '#e0f2fe' };
  const EMPTY = { type: 'FeatureCollection', features: [] };

  // Ancho en píxeles proporcional a "widthM" metros en el terreno: factor × ancho, entre minPx y maxPx
  function swathWidth(widthM, lat, minPx, factor = 1, maxPx = 400) {
    const mpp0 = 156543.03 * Math.cos((lat || 0) * Math.PI / 180); // metros por píxel en zoom 0
    const stops = [];
    for (const z of [10, 13, 15, 16, 17, 18, 19, 20, 22]) stops.push(z, Math.min(maxPx, Math.max(minPx, factor * widthM / (mpp0 / Math.pow(2, z)))));
    return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
  }

  // Fuentes p+'zone', p+'covered', p+'route' (RouteProgress.toGeoJSON) y p+'track'
  function add(map, p, opts = {}) {
    for (const s of ['zone', 'covered', 'route', 'track']) map.addSource(p + s, { type: 'geojson', data: EMPTY });
    map.addLayer({ id: p + 'zone-fill', type: 'fill', source: p + 'zone', paint: { 'fill-color': C.zone, 'fill-opacity': 0.07 } });
    map.addLayer({ id: p + 'covered-fill', type: 'fill', source: p + 'covered', paint: { 'fill-color': C.covered, 'fill-opacity': 0.33 } });
    map.addLayer({ id: p + 'covered-line', type: 'line', source: p + 'covered', paint: { 'line-color': '#4ade80', 'line-width': 1.5, 'line-opacity': 0.9 } });
    map.addLayer({ id: p + 'zone-line', type: 'line', source: p + 'zone', paint: { 'line-color': C.zone, 'line-width': 1.5, 'line-opacity': 0.6, 'line-dasharray': [3, 2] } });
    map.addLayer({
      id: p + 'route-done', type: 'line', source: p + 'route', filter: ['==', ['get', 'done'], true],
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': C.done, 'line-width': 9, 'line-opacity': 0.88 }
    });
    map.addLayer({
      id: p + 'route-casing', type: 'line', source: p + 'route', filter: ['==', ['get', 'done'], false],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': C.casing, 'line-width': 9, 'line-opacity': 0.6 }
    });
    map.addLayer({
      id: p + 'route-plan', type: 'line', source: p + 'route', filter: ['==', ['get', 'done'], false],
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': C.plan, 'line-width': 5, 'line-dasharray': [2, 1.2] }
    });
    map.addLayer({
      id: p + 'track', type: 'line', source: p + 'track',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': C.track, 'line-width': 2, 'line-opacity': 0.85 }
    });
  }

  // Lo hecho se pinta con el ancho real de la pasada (las entrefilas hechas se juntan en una franja verde);
  // la ruta planificada se afina para que las pasadas vecinas (~3,5 m) no se pisen
  function setSwath(map, p, widthM, lat) {
    const w = widthM || 3.5;
    if (!map.getLayer(p + 'route-done')) return;
    map.setPaintProperty(p + 'route-done', 'line-width', swathWidth(w, lat, 3, 1));
    map.setPaintProperty(p + 'route-plan', 'line-width', swathWidth(w, lat, 1.5, 0.4, 6));
    map.setPaintProperty(p + 'route-casing', 'line-width', swathWidth(w, lat, 2.5, 0.7, 10));
  }

  function setVisible(map, p, visible) {
    for (const id of ['zone-fill', 'covered-fill', 'covered-line', 'zone-line', 'route-done', 'route-casing', 'route-plan', 'track']) {
      if (map.getLayer(p + id)) map.setLayoutProperty(p + id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  root.RouteLayers = { add, setSwath, setVisible, swathWidth, COLORS: C };
})(window);
