// Utilidades compartidas de Gestión / Tablero: formato, API, diálogos y chips de toxicidad.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 1) => v == null || !Number.isFinite(Number(v)) ? '–' : Number(v).toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const money = (v) => v == null ? '–' : 'US$ ' + Number(v).toLocaleString('es-AR', { maximumFractionDigits: 0 });
  const date = (v) => { if (!v) return '–'; const s = String(v).slice(0, 10).split('-'); return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : '–'; };
  const dateTime = (v) => v ? new Date(v).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';
  const today = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  // Bandas toxicológicas (SENASA / OMS)
  const TOX = {
    Ia: { label: 'Ia – Sumamente peligroso', band: 'Banda roja', bg: '#dc2626', fg: '#fff' },
    Ib: { label: 'Ib – Muy peligroso', band: 'Banda roja', bg: '#dc2626', fg: '#fff' },
    II: { label: 'II – Moderadamente peligroso', band: 'Banda amarilla', bg: '#facc15', fg: '#1c1917' },
    III: { label: 'III – Poco peligroso', band: 'Banda azul', bg: '#2563eb', fg: '#fff' },
    IV: { label: 'IV – Normalmente no ofrece peligro', band: 'Banda verde', bg: '#16a34a', fg: '#fff' },
    'S/D': { label: 'Sin dato', band: 'Sin dato: ver marbete', bg: '#475569', fg: '#e2e8f0' }
  };
  const toxChip = (c, long) => {
    const t = TOX[c || 'S/D'] || TOX['S/D'];
    return `<span class="tox-chip" style="background:${t.bg};color:${t.fg}" title="${esc(t.label + ' · ' + t.band)}">${esc(long ? t.label : (c || 'S/D'))}</span>`;
  };
  const CAT = { insecticida: 'Insecticida', acaricida: 'Acaricida', 'insecticida-acaricida': 'Insecticida-acaricida', fungicida: 'Fungicida', bactericida: 'Bactericida',
    raleador: 'Raleador', fitorregulador: 'Fitorregulador', aceite: 'Aceite', coadyuvante: 'Coadyuvante', herbicida: 'Herbicida', otro: 'Otro' };
  const KIND = { tractor: '🚜 Tractor', pulverizadora: '💨 Pulverizadora', mochila: '🎒 Mochila', epp: '🦺 EPP', otro: '🔧 Otro' };
  const DISCLAIMER = 'Catálogo de referencia — verificar etiqueta y registro vigente';
  async function api(url, opts = {}) {
    const init = { ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } };
    if (opts.body && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
    const r = await fetch(url, init);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || ('Error ' + r.status)); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  // Diálogo simple: devuelve { el, close }. El contenido trae un <form>; onSubmit(form) puede devolver una promesa.
  function dialog(title, html, onSubmit, opts = {}) {
    const ov = document.createElement('div');
    ov.className = 'g-overlay';
    ov.innerHTML = `<form class="g-dialog ${opts.wide ? 'wide' : ''}" novalidate><div class="g-dhead"><h3>${title}</h3>
      <button type="button" class="g-x" aria-label="Cerrar">✕</button></div><div class="g-dbody">${html}</div>
      <div class="msg g-msg"></div>
      <div class="g-actions">${onSubmit ? `<button type="button" class="btn btn-outline g-cancel">Cancelar</button><button type="submit" class="btn btn-primary g-ok">${opts.okText || 'Guardar'}</button>`
        : `<button type="button" class="btn btn-outline g-cancel">Cerrar</button>`}${opts.extra || ''}</div></form>`;
    document.body.appendChild(ov);
    document.body.classList.add('g-noscroll');
    const close = () => { ov.remove(); if (!document.querySelector('.g-overlay')) document.body.classList.remove('g-noscroll'); };
    ov.querySelector('.g-x').onclick = close; ov.querySelector('.g-cancel').onclick = close;
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    const form = ov.querySelector('form');
    const msg = ov.querySelector('.g-msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close();
      const ok = ov.querySelector('.g-ok');
      ok.disabled = true; msg.className = 'msg g-msg';
      try { const r = await onSubmit(form); if (r !== false) close(); }
      catch (err) { msg.className = 'msg g-msg error'; msg.textContent = err.message; }
      finally { ok.disabled = false; }
    });
    const first = form.querySelector('input:not([type=hidden]), select, textarea');
    if (first && !opts.noFocus && window.matchMedia('(pointer: fine)').matches) first.focus();
    return { el: ov, form, close, msg };
  }
  // Selector de producto del catálogo con buscador (filtra un <select>)
  function productPicker(products, { id = 'pp', selected = null, required = true, allowEmpty = false } = {}) {
    const opts = (list) => (allowEmpty ? '<option value="">— Sin vincular (texto libre) —</option>' : '<option value="">Elegí un producto…</option>') +
      list.map(p => `<option value="${p.id}" ${Number(selected) === p.id ? 'selected' : ''}>${esc(p.name)}${p.activeIngredient && !p.name.toUpperCase().includes(p.activeIngredient.slice(0, 12).toUpperCase()) ? ' · ' + esc(p.activeIngredient) : ''} (${esc(p.unit)})</option>`).join('');
    const html = `<input type="search" id="${id}Q" placeholder="Buscar por nombre, principio activo o plaga…" autocomplete="off" />
      <select id="${id}" ${required ? 'required' : ''} style="margin-top:6px">${opts(products)}</select>`;
    const bind = (root) => {
      const q = root.querySelector('#' + id + 'Q'), sel = root.querySelector('#' + id);
      q.addEventListener('input', () => {
        const t = q.value.trim().toLowerCase();
        const cur = sel.value;
        const list = !t ? products : products.filter(p => [p.name, p.activeIngredient, p.commercialNames, p.targets].some(v => v && v.toLowerCase().includes(t)));
        sel.innerHTML = opts(list);
        if (list.some(p => String(p.id) === cur)) sel.value = cur;
        else if (list.length === 1) { sel.value = String(list[0].id); sel.dispatchEvent(new Event('change')); }
      });
      return sel;
    };
    return { html, bind };
  }
  function downloadCsv(url) { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
  window.G = { esc, num, money, date, dateTime, today, TOX, toxChip, CAT, KIND, DISCLAIMER, api, dialog, productPicker, downloadCsv };
})();
