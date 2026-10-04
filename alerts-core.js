// Alertas operativas: análisis del recorrido GPS (compartido por el servidor y el tracker).
// Todo se expresa como "episodios" con inicio y fin (fin = null mientras sigue pasando):
//   velocidad  – exceso de velocidad sostenido
//   parada     – sin moverse más de X m durante más de N min
//   sin_senal  – sin puntos GPS grabados más de N min (con el trabajo en curso y sin pausa)
//   no_inicio  – trabajo con inicio programado que no arrancó a tiempo
//   clima      – pronóstico "No apta" para el inicio programado de un trabajo pendiente (lib/weather-alerts.js)
// y un control al finalizar: ruta_incompleta (tramos de la ruta salteados).
(function (root) {
  const DEFAULTS = {
    speed: { enabled: true, maxKmh: 4.5, sustainSec: 30, minPoints: 3 },
    stop: { enabled: true, minutes: 10, radiusM: 10 },
    noSignal: { enabled: true, minutes: 5 },
    route: { enabled: true, minPct: 90, maxSkipM: 20 },
    lateStart: { enabled: true, minutes: 30 },
    weather: { enabled: true, hoursAhead: 36 },
    // Calidad del GPS al grabar (no es una alerta): puntos con peor precisión se descartan y
    // para empezar a grabar se espera una primera posición buena
    gps: { maxAccuracyM: 15, firstFixM: 10 }
  };
  // Rangos válidos [mín, máx] de cada umbral
  const LIMITS = {
    'speed.maxKmh': [1, 30], 'speed.sustainSec': [5, 600], 'speed.minPoints': [2, 50],
    'stop.minutes': [1, 240], 'stop.radiusM': [3, 100],
    'noSignal.minutes': [1, 120],
    'route.minPct': [0, 100], 'route.maxSkipM': [2, 1000],
    'lateStart.minutes': [0, 1440],
    'weather.hoursAhead': [1, 120],
    'gps.maxAccuracyM': [5, 100], 'gps.firstFixM': [3, 50]
  };
  // Método de aplicación del trabajo → velocidad máxima sugerida (km/h). null = la general (umbral de alertas)
  const METHODS = {
    tractor: { label: 'Tractor / turbo', kmh: null },
    mochila: { label: 'Mochila / a pie', kmh: 6 },
    otro: { label: 'Otro', kmh: null }
  };
  // Velocidad máxima que vale para un trabajo: la propia si la tiene, si no la general
  function jobSpeedLimit(job, settings) {
    const v = job && (job.speedLimitKmh != null ? job.speedLimitKmh : job.speed_limit_kmh);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : (settings && settings.speed ? settings.speed.maxKmh : DEFAULTS.speed.maxKmh);
  }
  const TYPES = ['velocidad', 'parada', 'sin_senal', 'ruta_incompleta', 'no_inicio', 'clima'];
  const TYPE_INFO = {
    velocidad: { icon: '⏩', title: 'Exceso de velocidad', key: 'speed' },
    parada: { icon: '🛑', title: 'Parada larga', key: 'stop' },
    sin_senal: { icon: '📡', title: 'Sin señal GPS', key: 'noSignal' },
    ruta_incompleta: { icon: '〰️', title: 'Tramos de ruta salteados', key: 'route' },
    no_inicio: { icon: '⏰', title: 'No arrancó a tiempo', key: 'lateStart' },
    clima: { icon: '🌦️', title: 'Pronóstico no apto', key: 'weather' }
  };
  const SEVERITY_LABELS = { alta: 'Alta', media: 'Media', info: 'Info' };

  const MAX_PLAUSIBLE_KMH = 40;   // velocidades mayores son saltos del GPS
  const MAX_SPEED_ACC_M = 30;     // puntos con peor precisión no se usan para la velocidad
  const DERIVED_WINDOW_S = 15;    // velocidad calculada con el desplazamiento en ~15 s (filtra el ruido)
  const SPEED_BREAK_GAP_S = 60;   // un hueco mayor corta un episodio de velocidad
  const MERGE_GAP_S = 60;         // episodios de velocidad separados por menos se juntan
  const STOP_OUTLIER_LOOKAHEAD = 2;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Une la configuración guardada con los valores por defecto y valida rangos.
  // strict = true: devuelve errores en vez de corregir (para el formulario del admin)
  function normalizeSettings(input, strict) {
    const out = clone(DEFAULTS);
    const errors = [];
    const src = input && typeof input === 'object' ? input : {};
    for (const group of Object.keys(DEFAULTS)) {
      const g = src[group] && typeof src[group] === 'object' ? src[group] : {};
      for (const k of Object.keys(DEFAULTS[group])) {
        if (g[k] === undefined || g[k] === null || g[k] === '') continue;
        if (k === 'enabled') { out[group][k] = g[k] === true || g[k] === 'true'; continue; }
        const n = Number(g[k]);
        const [min, max] = LIMITS[group + '.' + k];
        if (!Number.isFinite(n) || n < min || n > max) {
          if (strict) errors.push({ field: group + '.' + k, min, max });
          continue;
        }
        out[group][k] = k === 'minPoints' ? Math.round(n) : n;
      }
    }
    return { value: out, errors };
  }

  // ---------- utilidades ----------
  function projector(pts) {
    const p0 = pts[0] || { lat: 0, lng: 0 };
    const kx = 111320 * Math.cos(p0.lat * Math.PI / 180), ky = 110540;
    return (p) => [(p.lng - p0.lng) * kx, (p.lat - p0.lat) * ky];
  }
  const median3 = (a, b, c) => {
    const v = [a, b, c].filter(x => x != null).sort((x, y) => x - y);
    return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
  };
  // Normaliza puntos: { t (ms), lat, lng, speed (m/s|null), acc } ordenados por tiempo
  function normPoints(points) {
    return (points || []).map(p => ({
      t: typeof p.t === 'number' ? p.t : (p.ts != null ? Number(p.ts) : new Date(p.recorded_at || p.recordedAt).getTime()),
      lat: Number(p.lat), lng: Number(p.lng),
      speed: p.speed != null && Number.isFinite(Number(p.speed)) ? Number(p.speed) : null,
      acc: p.acc != null ? Number(p.acc) : (p.accuracy != null ? Number(p.accuracy) : null)
    })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .sort((a, b) => a.t - b.t);
  }

  // Velocidad (km/h) de cada punto: la que informa el GPS (doppler) si la hay; si no, el
  // desplazamiento en una ventana de ~15 s. Se descartan valores imposibles y puntos imprecisos,
  // y se suaviza con la mediana de 3 (un pico aislado no cuenta).
  function speedsKmh(pts) {
    const proj = projector(pts);
    const xy = pts.map(proj);
    const raw = pts.map((p, i) => {
      if (p.acc != null && p.acc > MAX_SPEED_ACC_M) return null;
      let v = null;
      if (p.speed != null && p.speed >= 0) v = p.speed * 3.6;
      else {
        let j = i - 1;
        while (j > 0 && (p.t - pts[j].t) / 1000 < DERIVED_WINDOW_S) j--;
        if (j >= 0 && j < i) {
          const dt = (p.t - pts[j].t) / 1000;
          if (dt >= 3 && dt <= 3 * DERIVED_WINDOW_S) v = Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]) / dt * 3.6;
        }
      }
      return v != null && v <= MAX_PLAUSIBLE_KMH ? v : null;
    });
    return raw.map((v, i) => v == null ? null : median3(raw[i - 1], v, raw[i + 1]));
  }

  // Corta el recorrido en tramos activos: un tramo termina en una pausa o en un hueco largo
  function segments(pts, pauses, gapMs) {
    const segs = [];
    let cur = [];
    const pausedBetween = (a, b) => pauses.some(pp => pp.start < b && (pp.end == null || pp.end > a));
    const inPause = (t) => pauses.some(pp => t >= pp.start && (pp.end == null || t <= pp.end));
    for (let i = 0; i < pts.length; i++) {
      if (inPause(pts[i].t)) continue;
      const prev = cur[cur.length - 1];
      if (prev != null) {
        const a = pts[prev].t, b = pts[i].t;
        const cut = pausedBetween(a, b) ? 'pausa' : (b - a > gapMs ? 'sin_senal' : null);
        if (cut) { segs.push({ idx: cur, endedBy: cut, endAt: cut === 'pausa' ? pauses.find(pp => pp.start < b && (pp.end == null || pp.end > a)).start : a }); cur = []; }
      }
      cur.push(i);
    }
    if (cur.length) segs.push({ idx: cur, endedBy: null });
    return segs;
  }

  // ---------- velocidad ----------
  function speedEpisodes(pts, speeds, segs, cfg, ongoingAllowed) {
    const c = cfg.speed;
    const eps = [];
    segs.forEach((seg, si) => {
      const isLastSeg = si === segs.length - 1 && seg.endedBy == null;
      let run = null;
      // breakIdx: punto que cortó el episodio (bajó del límite); atEnd: se terminaron los puntos del tramo
      const close = (breakIdx, atEnd) => {
        if (!run) return;
        const first = run.idx[0], last = run.idx[run.idx.length - 1];
        const dur = (pts[last].t - pts[first].t) / 1000;
        if (run.idx.length >= c.minPoints && dur >= c.sustainSec) {
          const ongoing = breakIdx == null && atEnd && isLastSeg && ongoingAllowed;
          const end = ongoing ? null : (breakIdx != null ? pts[breakIdx].t : pts[last].t);
          const vs = run.idx.map(i => speeds[i]);
          eps.push({
            start: pts[first].t, end, ongoing,
            details: {
              maxKmh: round1(Math.max(...vs)), avgKmh: round1(vs.reduce((s, v) => s + v, 0) / vs.length),
              durationS: Math.round(((end || pts[last].t) - pts[first].t) / 1000), points: run.idx.length,
              limitKmh: c.maxKmh, lat: pts[first].lat, lng: pts[first].lng
            }
          });
        }
        run = null;
      };
      for (const i of seg.idx) {
        const v = speeds[i];
        if (v == null) continue;                     // sin dato: ni corta ni suma
        if (run && (pts[i].t - pts[run.idx[run.idx.length - 1]].t) / 1000 > SPEED_BREAK_GAP_S) close(null, false);
        if (v > c.maxKmh) { if (!run) run = { idx: [] }; run.idx.push(i); }
        else close(i, false);
      }
      close(null, true);
    });
    // Juntar episodios muy cercanos (el tractor que oscila alrededor del límite)
    const merged = [];
    for (const e of eps) {
      const prev = merged[merged.length - 1];
      if (prev && prev.end != null && e.start - prev.end <= MERGE_GAP_S * 1000) {
        const d = prev.details, n = e.details;
        prev.end = e.end; prev.ongoing = e.ongoing;
        d.avgKmh = round1((d.avgKmh * d.points + n.avgKmh * n.points) / (d.points + n.points));
        d.maxKmh = Math.max(d.maxKmh, n.maxKmh); d.points += n.points;
        d.durationS = Math.round(((e.end || e.start + n.durationS * 1000) - prev.start) / 1000);
      } else merged.push(e);
    }
    return merged;
  }

  // ---------- paradas ----------
  function stopEpisodes(pts, segs, cfg, ongoingAllowed) {
    const c = cfg.stop;
    const minMs = c.minutes * 60000, R = c.radiusM;
    const proj = projector(pts);
    const eps = [];
    segs.forEach((seg, si) => {
      const isLastSeg = si === segs.length - 1 && seg.endedBy == null;
      const idx = seg.idx;
      let k0 = 0, cx = 0, cy = 0, n = 0;
      const add = (i) => { const [x, y] = proj(pts[i]); cx = (cx * n + x) / (n + 1); cy = (cy * n + y) / (n + 1); n++; };
      const far = (i) => { const [x, y] = proj(pts[i]); return Math.hypot(x - cx, y - cy) > R; };
      const close = (kLast, kBreak) => {
        const first = idx[k0], last = idx[kLast];
        if (pts[last].t - pts[first].t >= minMs) {
          const ongoing = kBreak == null && isLastSeg && ongoingAllowed;
          let end = null, endedBy = null;
          if (!ongoing) {
            if (kBreak != null) { end = pts[idx[kBreak]].t; endedBy = 'movimiento'; }
            else { endedBy = seg.endedBy || 'fin'; end = seg.endedBy === 'pausa' ? Math.max(pts[last].t, seg.endAt) : pts[last].t; }
          }
          const p0 = pts[0], kx = 111320 * Math.cos(p0.lat * Math.PI / 180);
          eps.push({
            start: pts[first].t, end, ongoing,
            details: {
              minutes: round1(((end || pts[last].t) - pts[first].t) / 60000), radiusM: R, limitMin: c.minutes,
              lat: p0.lat + cy / 110540, lng: p0.lng + cx / kx, endedBy
            }
          });
        }
      };
      if (!idx.length) return;
      add(idx[0]);
      for (let k = 1; k < idx.length; k++) {
        const i = idx[k];
        if (!far(i)) { add(i); continue; }
        // ¿Salto aislado del GPS? Si uno de los próximos puntos vuelve al círculo, se ignora
        let back = false;
        for (let a = 1; a <= STOP_OUTLIER_LOOKAHEAD && k + a < idx.length; a++) {
          if ((pts[idx[k + a]].t - pts[i].t) > 20000) break;
          if (!far(idx[k + a])) { back = true; break; }
        }
        if (back) continue;
        close(k - 1, k);
        k0 = k; cx = 0; cy = 0; n = 0; add(i);
      }
      close(idx.length - 1, null);
    });
    return eps;
  }

  // ---------- sin señal (huecos en los puntos grabados) ----------
  // Tiempo activo = desde el inicio hasta el fin (o ahora) menos las pausas.
  function gapEpisodes(pts, pauses, job, cfg, now) {
    const gapMs = cfg.noSignal.minutes * 60000;
    if (!job.startedAt) return [];
    const open = job.status === 'en_curso';
    const endT = open ? now : (job.finishedAt || (pts.length ? pts[pts.length - 1].t : job.startedAt));
    // Intervalos activos
    const ivs = [];
    let a = job.startedAt;
    for (const p of pauses.slice().sort((x, y) => x.start - y.start)) {
      if (p.start > a) ivs.push([a, Math.min(p.start, endT), 'pausa']);
      a = Math.max(a, p.end == null ? Infinity : p.end);
    }
    if (a < endT) ivs.push([a, endT, open ? 'ahora' : 'fin']);
    const eps = [];
    let pi = 0;
    for (const [s, e, until] of ivs) {
      while (pi < pts.length && pts[pi].t < s) pi++;
      let prev = s, prevPt = pi > 0 ? pts[pi - 1] : null;
      const check = (t, nextPt, isEnd) => {
        if (t - prev > gapMs) {
          const ongoing = isEnd && until === 'ahora';
          eps.push({
            start: prev, end: ongoing ? null : t, ongoing,
            details: {
              minutes: round1((t - prev) / 60000), limitMin: cfg.noSignal.minutes,
              lastPointAt: prevPt ? prevPt.t : null, nextPointAt: nextPt ? nextPt.t : null,
              lat: prevPt ? prevPt.lat : null, lng: prevPt ? prevPt.lng : null,
              kind: ongoing ? 'sin_datos' : (isEnd ? (until === 'pausa' ? 'antes_pausa' : 'antes_fin') : 'gps')
            }
          });
        }
      };
      while (pi < pts.length && pts[pi].t <= e) {
        check(pts[pi].t, pts[pi], false);
        prev = pts[pi].t; prevPt = pts[pi]; pi++;
      }
      check(e, null, true);
    }
    return eps;
  }

  // ---------- no arrancó a tiempo ----------
  function lateStartEpisodes(job, cfg, now) {
    if (!job.plannedStartAt) return [];
    const due = job.plannedStartAt + cfg.lateStart.minutes * 60000;
    const details = { plannedStartAt: job.plannedStartAt, limitMin: cfg.lateStart.minutes };
    if (job.status === 'pendiente') {
      if (now < due) return [];
      return [{ start: due, end: null, ongoing: true, details: { ...details, lateMin: Math.round((now - job.plannedStartAt) / 60000) } }];
    }
    if (job.startedAt && job.startedAt > due) {
      return [{ start: due, end: job.startedAt, ongoing: false, details: { ...details, startedAt: job.startedAt, lateMin: Math.round((job.startedAt - job.plannedStartAt) / 60000) } }];
    }
    return [];
  }

  // Analiza un trabajo y devuelve los episodios por tipo.
  // job: { status, startedAt, finishedAt, plannedStartAt, pausedNow } (fechas en ms)
  // pauses: [{ start, end|null }] (ms)
  function analyze(job, points, pauses, settings, now) {
    const cfg = normalizeSettings(settings).value;
    now = now || Date.now();
    const pts = normPoints(points);
    const ps = (pauses || []).map(p => ({ start: Number(p.start), end: p.end == null ? null : Number(p.end) }));
    const out = { velocidad: [], parada: [], sin_senal: [], no_inicio: [] };
    if (cfg.lateStart.enabled) out.no_inicio = lateStartEpisodes(job, cfg, now);
    if (!job.startedAt || job.status === 'pendiente') return out;
    const ongoingAllowed = job.status === 'en_curso' && !job.pausedNow;
    const segs = segments(pts, ps, cfg.noSignal.minutes * 60000);
    // Último tramo: si después del último punto hubo una pausa, el tramo terminó por la pausa
    const lastSeg = segs[segs.length - 1];
    if (lastSeg && lastSeg.endedBy == null) {
      const tLast = pts[lastSeg.idx[lastSeg.idx.length - 1]].t;
      const pz = ps.filter(x => x.start >= tLast).sort((x, y) => x.start - y.start)[0];
      if (pz && (job.pausedNow || job.status !== 'en_curso')) { lastSeg.endedBy = 'pausa'; lastSeg.endAt = pz.start; }
    }
    if (cfg.speed.enabled) out.velocidad = speedEpisodes(pts, speedsKmh(pts), segs, cfg, ongoingAllowed);
    if (cfg.stop.enabled) out.parada = stopEpisodes(pts, segs, cfg, ongoingAllowed);
    if (cfg.noSignal.enabled) out.sin_senal = gapEpisodes(pts, ps, job, cfg, now);
    return out;
  }

  // Control al finalizar: tramos de la ruta no recorridos (fuera de la tolerancia)
  function routeCheck(rp, settings) {
    const cfg = normalizeSettings(settings).value.route;
    if (!cfg.enabled || !rp || rp.empty) return null;
    const sm = rp.summary();
    const sections = rp.remaining(3).map(r => ({
      pass: r.pass, fromM: Math.round(r.fromM), lengthM: round1(r.lengthM),
      start: r.coords[0], end: r.coords[r.coords.length - 1], mid: r.middle
    }));
    const longest = sections.reduce((m, s) => Math.max(m, s.lengthM), 0);
    const trigger = sm.pct < cfg.minPct || longest >= cfg.maxSkipM;
    return {
      trigger,
      details: {
        routePct: round1(sm.pct), totalM: Math.round(sm.totalM), doneM: Math.round(sm.doneM),
        skippedM: Math.round(sections.reduce((s, x) => s + x.lengthM, 0)), longestM: longest,
        count: sections.length, minPct: cfg.minPct, maxSkipM: cfg.maxSkipM,
        sections: sections.sort((a, b) => b.lengthM - a.lengthM).slice(0, 60)
      }
    };
  }

  // ---------- avisos en vivo para el aplicador (tracker) ----------
  // Velocidad actual (suavizada) y hace cuánto viene pasado del límite
  function currentOverspeed(points, settings) {
    const cfg = normalizeSettings(settings).value.speed;
    if (!cfg.enabled) return null;
    const pts = normPoints(points).slice(-120);
    if (pts.length < 2) return null;
    const sp = speedsKmh(pts);
    let i = pts.length - 1;
    while (i >= 0 && sp[i] == null) i--;
    if (i < 0 || sp[i] <= cfg.maxKmh) return null;
    let j = i, n = 0;
    for (let k = i; k >= 0; k--) {
      if (sp[k] == null) continue;
      if (sp[k] <= cfg.maxKmh || (pts[j].t - pts[k].t) / 1000 > SPEED_BREAK_GAP_S) break;
      j = k; n++;
    }
    return { kmh: sp[i], limitKmh: cfg.maxKmh, sinceS: (pts[i].t - pts[j].t) / 1000, points: n };
  }
  // Hace cuántos minutos está quieto (dentro del radio)
  function currentStop(points, settings) {
    const cfg = normalizeSettings(settings).value;
    if (!cfg.stop.enabled) return null;
    const pts = normPoints(points);
    if (pts.length < 2) return null;
    const eps = stopEpisodes(pts, [{ idx: pts.map((_, i) => i), endedBy: null }], { stop: { ...cfg.stop, minutes: 0 } }, true);
    const last = eps[eps.length - 1];
    if (!last || !last.ongoing) return null;
    const minutes = (pts[pts.length - 1].t - last.start) / 60000;
    return { minutes, limitMin: cfg.stop.minutes };
  }

  // ---------- textos (español) ----------
  const nf = (n, d = 1) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: d });
  const hm = (t) => new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  function dur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min' + (m < 10 && s % 60 ? ' ' + (s % 60) + ' s' : '');
    return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
  }
  function describe(a, now) {
    now = now || Date.now();
    const d = a.details || {};
    const info = TYPE_INFO[a.type] || { icon: '⚠️', title: a.type };
    const open = !a.resolvedAt;
    let text = '';
    switch (a.type) {
      case 'velocidad':
        text = `Máx. ${nf(d.maxKmh)} km/h (prom. ${nf(d.avgKmh)}) durante ${dur(d.durationS)} · límite ${nf(d.limitKmh)} km/h`;
        if (open) text += ' · sigue rápido';
        break;
      case 'parada': {
        const m = open ? Math.max(d.minutes || 0, (now - new Date(a.startedAt).getTime()) / 60000) : d.minutes;
        text = `Detenido ${dur(m * 60)} (radio ${nf(d.radiusM, 0)} m)`;
        if (open) text += ' · sigue quieto';
        else if (d.endedBy === 'etapa' || d.resolution === 'etapa') text += ' · después terminó la etapa del día';
        else if (d.endedBy === 'pausa' || d.resolution === 'pausa') text += ' · después pausó el GPS';
        else if (d.endedBy === 'movimiento' || d.resolution === 'movimiento') text += ' · retomó la marcha';
        break;
      }
      case 'sin_senal':
        if (open) {
          const since = d.lastPointAt || new Date(a.startedAt).getTime();
          text = `Sin datos del celular desde las ${hm(since)} (${dur((now - since) / 1000)}). Puede estar sin conexión y mandar los puntos después, o apagado.`;
        } else if (d.resolution === 'sin_conexion') {
          text = `El celular estuvo sin conexión pero siguió grabando: ${d.backfilled || 0} puntos llegaron después.`;
        } else if (d.resolution === 'pausa') {
          text = 'Era una pausa del aplicador (llegó después).';
        } else {
          text = `Hueco de ${dur((d.minutes || 0) * 60)} sin puntos GPS` + (d.lastPointAt ? ` (${hm(d.lastPointAt)}–${hm(d.nextPointAt || new Date(a.resolvedAt).getTime())})` : '') +
            (d.kind === 'antes_pausa' ? ', antes de pausar' : d.kind === 'antes_fin' ? ', antes de finalizar' : '') + '.';
        }
        break;
      case 'ruta_incompleta':
        text = `Ruta ${nf(d.routePct)}% (mínimo ${nf(d.minPct, 0)}%) · ${d.count} tramo${d.count === 1 ? '' : 's'} salteado${d.count === 1 ? '' : 's'} (${nf(d.skippedM, 0)} m)` +
          (d.longestM ? `, el mayor ${nf(d.longestM, 0)} m` + (d.sections && d.sections[0] ? ` en la pasada ${d.sections[0].pass}` : '') : '');
        if (d.resolution === 'completada') text += ' · resuelta con puntos que llegaron después';
        if (d.resolution === 'reabierto') text += ' · el supervisor reabrió el trabajo';
        break;
      case 'no_inicio':
        if (open) text = `Inicio programado ${hm(d.plannedStartAt)}: sigue pendiente (+${dur((now - d.plannedStartAt) / 1000)})`;
        else if (d.startedAt) text = `Inicio programado ${hm(d.plannedStartAt)}, arrancó ${hm(d.startedAt)} (+${dur(d.lateMin * 60)})`;
        else text = `Inicio programado ${hm(d.plannedStartAt)}` + (d.resolution === 'reprogramado' ? ' · se reprogramó' : d.resolution === 'cancelado' ? ' · trabajo cancelado' : '');
        break;
      case 'clima': {
        const rs = (d.reasons || []).slice(0, 3).join(' · ');
        if (open) text = `Inicio programado ${hm(d.at)}: ventana NO APTA` + (rs ? ` (${rs})` : '') +
          (d.nextWindow ? ` · próxima ventana apta ${hm(d.nextWindow.start)}` : '');
        else text = `Inicio programado ${hm(d.at)}` + (d.resolution === 'mejoro' ? ' · el pronóstico mejoró' : d.resolution === 'inicio' ? ' · el trabajo ya arrancó' :
          d.resolution === 'reprogramado' ? ' · se reprogramó' : d.resolution === 'desactivada' ? ' · alerta desactivada' : '') + (rs ? ` (${rs})` : '');
        break;
      }
    }
    if (!open && ['cancelado', 'eliminado'].includes(d.resolution) && a.type !== 'no_inicio') text += ` · trabajo ${d.resolution}`;
    return { icon: info.icon, title: info.title, text };
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  const api = { DEFAULTS, LIMITS, METHODS, jobSpeedLimit, TYPES, TYPE_INFO, SEVERITY_LABELS, normalizeSettings, normPoints, speedsKmh, analyze, routeCheck, currentOverspeed, currentStop, describe, fmtDuration: dur };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AlertsCore = api;
})(typeof window !== 'undefined' ? window : this);
