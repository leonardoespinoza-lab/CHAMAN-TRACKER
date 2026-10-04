// Clima en el navegador: formato, colores de la ventana de aplicación y la tarjeta compacta
// (detalle del trabajo, formulario de trabajo nuevo, tablero y tracker del aplicador).
(function (root) {
  const TZ = 'America/Argentina/Buenos_Aires';
  const STATUS = {
    apta: { label: 'Apta', cls: 'wx-ok', color: '#10b981' },
    precaucion: { label: 'Precaución', cls: 'wx-warn', color: '#f59e0b' },
    no_apta: { label: 'No apta', cls: 'wx-bad', color: '#ef4444' }
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (v, d = 0) => v == null || !Number.isFinite(Number(v)) ? '–' : Number(v).toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const parts = (t) => {
    const p = {};
    new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(t)).forEach(x => { p[x.type] = x.value; });
    p.hour = p.hour === '24' ? '00' : p.hour;
    return p;
  };
  const hm = (t) => { const p = parts(t); return `${p.hour}:${p.minute}`; };
  const hh = (t) => parts(t).hour;
  const dayKey = (t) => new Date(new Date(t).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  const todayKey = () => dayKey(Date.now());
  function dayName(key) {
    const d = new Date(key + 'T12:00:00-03:00');
    const diff = Math.round((new Date(key + 'T12:00:00Z') - new Date(todayKey() + 'T12:00:00Z')) / 86400e3);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Mañana';
    const s = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric' }).format(d);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const dayHm = (t) => `${dayName(dayKey(t))} ${hm(t)}`;
  function windowText(w) {
    if (!w) return '';
    const sameDay = dayKey(w.start) === dayKey(new Date(new Date(w.end).getTime() - 1));
    return `${dayName(dayKey(w.start))} ${hm(w.start)}–${sameDay ? hm(w.end) : dayHm(w.end)} (${w.hours} h)`;
  }
  // Flecha que apunta hacia donde va el viento (la dirección meteorológica es de dónde viene)
  const arrow = (deg, size = 14) => deg == null ? '' :
    `<svg class="wx-arrow" width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${(deg + 180) % 360}deg)" aria-hidden="true"><path d="M12 2l5 9h-3.5v11h-3V11H7z" fill="currentColor"/></svg>`;
  const pill = (st, extra) => st && STATUS[st] ? `<span class="wx-pill ${STATUS[st].cls}">${STATUS[st].label}${extra ? ' ' + extra : ''}</span>` : '';

  function injectCss() {
    if (document.getElementById('wx-core-css')) return;
    const s = document.createElement('style');
    s.id = 'wx-core-css';
    s.textContent = `
      .wx-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; font-size: .74rem; font-weight: 700; letter-spacing: .01em; border: 1px solid; white-space: nowrap; }
      .wx-ok { color: #34d399; background: rgba(16,185,129,.12); border-color: rgba(16,185,129,.4); }
      .wx-warn { color: #fbbf24; background: rgba(245,158,11,.12); border-color: rgba(245,158,11,.4); }
      .wx-bad { color: #f87171; background: rgba(239,68,68,.12); border-color: rgba(239,68,68,.45); }
      .wx-arrow { display: inline-block; vertical-align: -2px; color: var(--accent-text, #34d399); }
      .wx-card { background: var(--surface, #121214); border: 1px solid var(--border, #27272a); border-radius: 12px; padding: 12px 14px; }
      .wx-card .wx-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
      .wx-card .wx-t { font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2, #d4d4d8); display: flex; align-items: center; gap: 7px; }
      .wx-card .wx-t svg.i { width: 15px; height: 15px; color: var(--accent-text, #34d399); }
      .wx-card .wx-sub { color: var(--text-muted, #a1a1aa); font-size: .78rem; }
      .wx-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 6px; margin: 6px 0; }
      .wx-kv > div { background: var(--bg, #09090b); border: 1px solid var(--border, #27272a); border-radius: 8px; padding: 6px 8px; min-width: 0; }
      .wx-kv b { display: block; font-size: .98rem; color: var(--text-strong, #fafafa); font-weight: 650; white-space: nowrap; }
      .wx-kv small { display: block; font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-subtle, #71717a); }
      .wx-reasons { margin: 6px 0 0; padding: 0; list-style: none; font-size: .8rem; color: var(--text-2, #d4d4d8); }
      .wx-reasons li { padding-left: 14px; position: relative; margin: 2px 0; }
      .wx-reasons li::before { content: ''; position: absolute; left: 2px; top: .5em; width: 6px; height: 6px; border-radius: 50%; background: var(--warning, #f59e0b); }
      .wx-reasons li.l2::before { background: var(--danger, #ef4444); }
      .wx-alert { display: block; text-align: left; margin: 8px 0 4px; padding: 8px 10px; border-radius: 8px; font-size: .84rem; line-height: 1.4; border: 1px solid var(--danger-border, #5c1d1d); background: var(--danger-bg, #1f0f10); color: #fecaca; }
      .wx-alert b { display: inline; }
      .wx-alert.warn { border-color: var(--warning-border, #6b4410); background: var(--warning-bg, #1f1708); color: #fde68a; }
      .wx-alert.ok { border-color: var(--success-border, #1f5134); background: var(--success-bg, #0b1f14); color: #bbf7d0; }
      .wx-strip { display: flex; gap: 2px; margin-top: 8px; overflow-x: auto; padding: 2px 2px 15px; scrollbar-width: thin; }
      .wx-strip .c { flex: 1 0 14px; min-width: 14px; height: 22px; border-radius: 3px; position: relative; opacity: .9; }
      .wx-strip .c.mark { outline: 2px solid #fff; outline-offset: 1px; z-index: 1; }
      .wx-strip .c.now { box-shadow: inset 0 0 0 2px rgba(255,255,255,.55); }
      .wx-strip .c span { position: absolute; top: 24px; left: 0; font-size: .62rem; color: var(--text-subtle, #71717a); }
      .wx-strip-wrap { padding-bottom: 0; }
      .wx-next { font-size: .82rem; color: var(--text-2, #d4d4d8); margin-top: 4px; }
      .wx-next b { color: var(--accent-text, #34d399); }
      .wx-foot { margin-top: 8px; font-size: .7rem; color: var(--text-subtle, #71717a); }
      .wx-foot a { color: inherit; text-decoration: underline; }
      .wx-snaps { margin-top: 8px; display: grid; gap: 4px; font-size: .78rem; color: var(--text-2, #d4d4d8); }
      .wx-snaps div { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .wx-snaps .k { color: var(--text-muted, #a1a1aa); min-width: 128px; }
      .wx-loading { color: var(--text-muted, #a1a1aa); font-size: .84rem; font-style: italic; }
    `;
    document.head.appendChild(s);
  }

  // Tira de horas coloreadas por estado (hours = lista del análisis)
  function strip(hours, opts = {}) {
    const mark = opts.mark ? new Date(opts.mark).getTime() : null;
    const nowH = Math.floor(Date.now() / 3600e3) * 3600e3;
    return `<div class="wx-strip-wrap"><div class="wx-strip" role="img" aria-label="Ventana de aplicación por hora">${hours.map(h => {
      const t = new Date(h.t).getTime();
      const isMark = mark != null && t <= mark && mark < t + 3600e3;
      const H = Number(hh(h.t));
      const tip = `${dayHm(h.t)} · ${STATUS[h.status].label}\n${nf(h.temp, 1)} °C · HR ${nf(h.rh)} % · viento ${nf(h.wind)} km/h ${h.cardinal || ''}${h.gust != null ? ' (ráf. ' + nf(h.gust) + ')' : ''} · ΔT ${nf(h.deltaT, 1)}${h.precip ? ' · lluvia ' + nf(h.precip, 1) + ' mm' : ''}${h.prob != null ? ' · ' + nf(h.prob) + ' %' : ''}` +
        (h.reasons && h.reasons.length ? '\n' + h.reasons.map(r => '• ' + r.text).join('\n') : '');
      return `<div class="c${isMark ? ' mark' : ''}${t === nowH ? ' now' : ''}" style="background:${STATUS[h.status].color}" title="${esc(tip)}">${H % 6 === 0 ? `<span>${H}h</span>` : ''}</div>`;
    }).join('')}</div></div>`;
  }

  function kv(h) {
    if (!h) return '';
    return `<div class="wx-kv">
      <div><small>Temp.</small><b>${nf(h.temp, 1)} °C</b></div>
      <div><small>Humedad</small><b>${nf(h.rh)} %</b></div>
      <div><small>Viento</small><b>${arrow(h.dir)} ${nf(h.wind)} <span style="font-size:.72rem;font-weight:500">km/h ${esc(h.cardinal || '')}</span></b></div>
      <div><small>Ráfagas</small><b>${h.gust != null ? nf(h.gust) + ' <span style="font-size:.72rem;font-weight:500">km/h</span>' : '–'}</b></div>
      <div><small>Delta T</small><b>${nf(h.deltaT, 1)}</b></div>
      <div><small>Lluvia ${h.rainNext ? nf(h.rainNext.hours) + ' h' : ''}</small><b>${h.rainNext ? nf(h.rainNext.mm, 1) + ' mm' : nf(h.precip, 1) + ' mm'}${h.rainNext && h.rainNext.prob != null ? ' <span style="font-size:.72rem;font-weight:500">' + nf(h.rainNext.prob) + ' %</span>' : ''}</b></div>
    </div>`;
  }
  const reasonsList = (rs) => rs && rs.length ? `<ul class="wx-reasons">${rs.map(r => `<li class="l${r.level}">${esc(r.text)}</li>`).join('')}</ul>` : '';
  function foot(an) {
    const s = an.source || {};
    let t = `Pronóstico del modelo para ${esc(an.place ? an.place.name : '')} · <a href="${esc(s.attributionUrl || '#')}" target="_blank" rel="noopener">${esc(s.attribution || '')}</a>`;
    if (s.stale) t += ' · dato guardado (no se pudo actualizar)';
    if (s.provider === 'met-norway') t += ' · sin ráfagas ni probabilidad de lluvia';
    return `<div class="wx-foot">${t}</div>`;
  }

  // Advertencias para un horario planificado (formulario / detalle del trabajo)
  function planWarnings(an) {
    const at = an.at;
    if (!at) return '';
    if (at.outOfRange) {
      const past = new Date(at.at).getTime() < Date.now();
      return `<div class="wx-alert warn">${past ? 'El inicio planificado ya pasó.' : 'El inicio planificado está fuera del pronóstico disponible (7 días): revisalo más cerca de la fecha.'}</div>`;
    }
    const out = [];
    const rain = (at.reasons || []).find(r => r.key === 'lluvia');
    if (at.status === 'no_apta') out.push(`<div class="wx-alert"><b>⚠ El inicio planificado (${esc(dayHm(at.at))}) cae en un período NO APTO.</b> ${esc((at.reasons || []).filter(r => r.level === 2).map(r => r.text).join(' · '))}</div>`);
    else if (rain) out.push(`<div class="wx-alert warn"><b>Atención:</b> ${esc(rain.text)}.</div>`);
    else if (at.status === 'precaucion') out.push(`<div class="wx-alert warn"><b>Precaución en el inicio planificado (${esc(dayHm(at.at))}):</b> ${esc((at.reasons || []).map(r => r.text).join(' · '))}</div>`);
    else out.push(`<div class="wx-alert ok">El inicio planificado (${esc(dayHm(at.at))}) cae en una ventana <b>apta</b>.</div>`);
    const nx = an.now || an.next;
    if (at.status !== 'apta' && at.nextWindow && (!nx || nx.start !== at.nextWindow.start)) out.push(`<div class="wx-next">Primera ventana apta desde el inicio planificado: <b>${esc(windowText(at.nextWindow))}</b></div>`);
    return out.join('');
  }

  // Tarjeta compacta. an = respuesta de /api/weather. opts: { title, mark, hoursAhead, plan }
  function card(an, opts = {}) {
    injectCss();
    const ref = an.at && an.at.hour ? an.at.hour : an.current;
    const refStatus = an.at && an.at.status ? an.at.status : (an.current && an.current.status);
    const from = Date.now() - 3600e3, to = Date.now() + (opts.hoursAhead || 36) * 3600e3;
    const markT = opts.mark ? new Date(opts.mark).getTime() : null;
    const hs = an.hours.filter(h => { const t = new Date(h.t).getTime(); return (t >= from && t < to) || (markT && Math.abs(t - markT) < 12 * 3600e3); });
    const nextW = an.now || an.next;
    return `<div class="wx-card" data-status="${esc(refStatus || '')}">
      <div class="wx-h"><span class="wx-t"><svg class="i" aria-hidden="true"><use href="icons.svg#i-cloud-sun"/></svg>${esc(opts.title || 'Clima')}</span>${pill(refStatus, an.at && an.at.hour ? 'al inicio' : 'ahora')}</div>
      ${opts.plan !== false ? planWarnings(an) : ''}
      ${kv(ref)}
      ${reasonsList(ref && ref.reasons)}
      ${strip(hs, { mark: opts.mark })}
      <div class="wx-next">${an.now ? `Ventana apta <b>ahora</b> hasta las ${esc(hm(an.now.end))}` : nextW ? `Próxima ventana apta: <b>${esc(windowText(nextW))}</b>` : 'Sin ventanas aptas en el pronóstico de 7 días'}</div>
      ${opts.extra || ''}
      ${foot(an)}
    </div>`;
  }

  function snapshotsHtml(list) {
    if (!list || !list.length) return '';
    return `<div class="wx-snaps"><b style="font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)">Condiciones registradas</b>${list.map(s =>
      `<div><span class="k">${s.kind === 'inicio' ? 'Inicio' : 'Fin'} etapa · ${esc(dayHm(s.recordedAt))}</span>${pill(s.status)}
        <span>${nf(s.temp, 1)} °C · HR ${nf(s.rh)} % · ${arrow(s.dir, 12)} ${nf(s.wind)} km/h ${esc(s.cardinal || '')}${s.gust != null ? ' (ráf. ' + nf(s.gust) + ')' : ''} · ΔT ${nf(s.deltaT, 1)}${s.precip ? ' · ' + nf(s.precip, 1) + ' mm' : ''}</span></div>`).join('')}</div>`;
  }

  root.Clima = { TZ, STATUS, esc, nf, hm, hh, dayKey, dayName, dayHm, windowText, arrow, pill, strip, kv, reasonsList, foot, planWarnings, card, snapshotsHtml, injectCss };
})(typeof window !== 'undefined' ? window : this);
