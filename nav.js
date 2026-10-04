// Navegación lateral compartida (todas las pantallas con sesión salvo el tracker del aplicador).
// Se incluye con <script src="nav.js"></script> justo después de <body>: dibuja la barra lateral
// en ese lugar (antes de que corran los scripts de la página, que usan #userName, #roleBadge y #navUsers).
// Escritorio: barra fija de 232 px que se contrae a un riel de 64 px (se recuerda en localStorage).
// Celular / tablet (< 900 px): barra superior con menú hamburguesa que abre la barra como cajón.
(function () {
  const ITEMS = [
    { id: 'navTablero', href: 'tablero.html', icon: 'layout-dashboard', label: 'Tablero', roles: ['admin'] },
    { id: 'navTrabajos', href: 'trabajos.html', icon: 'clipboard-list', label: 'Trabajos', roles: ['admin', 'supervisor'] },
    { id: 'navChacras', href: 'chacras.html', icon: 'trees', label: 'Chacras', roles: ['admin', 'supervisor'] },
    { id: 'navClima', href: 'clima.html', icon: 'cloud-sun', label: 'Clima', roles: ['admin', 'supervisor'] },
    { id: 'navAlerts', href: 'alertas.html', icon: 'bell', label: 'Alertas', roles: ['admin', 'supervisor'], badge: true },
    { id: 'navGestion', href: 'gestion.html', icon: 'package', label: 'Gestión', roles: ['admin', 'supervisor'] },
    { id: 'navPanel', href: 'index.html', icon: 'map', label: 'Panel simple', roles: ['admin', 'supervisor'] },
    { id: 'navUsers', href: 'usuarios.html', icon: 'users', label: 'Usuarios', roles: ['admin'], keepHidden: true },
    { id: 'navInformes', href: 'informes.html', icon: 'file-chart-column', label: 'Informes', roles: ['admin', 'supervisor'] }
  ];
  const KEY = 'chaman.sidebar.collapsed';
  const ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', aplicador: 'Aplicador' };
  const icon = (n) => `<svg class="i" aria-hidden="true"><use href="icons.svg#i-${n}"/></svg>`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const session = (typeof getSession === 'function' && getSession()) || {};
  const role = session.role || '';
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  let collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch (_) {}

  const links = ITEMS.filter(it => it.roles.includes(role) || it.keepHidden).map(it => {
    const on = page === it.href;
    const hidden = !it.roles.includes(role);
    return `<a class="sb-item nav-link${on ? ' active' : ''}" id="${it.id}" href="${it.href}" data-tip="${esc(it.label)}"${on ? ' aria-current="page"' : ''}${hidden ? ' hidden' : ''}>` +
      `${icon(it.icon)}<span class="sb-label">${esc(it.label)}</span>${it.badge ? '<span class="al-count" hidden></span>' : ''}</a>`;
  }).join('');
  const initial = (session.name || session.username || '?').trim().charAt(0).toUpperCase();

  const html = `
  <div class="sb-top" role="banner">
    <button type="button" class="sb-burger" id="sbBurger" aria-label="Abrir menú" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
    <a class="sb-brand sb-brand-top" href="${role === 'admin' ? 'tablero.html' : 'trabajos.html'}"><span class="brand-mark" aria-hidden="true">${icon('sprout')}</span><span class="sb-brand-txt">Sistema de Fumigación</span></a>
  </div>
  <div class="sb-overlay" id="sbOverlay" hidden></div>
  <aside class="sb" id="sidebar" aria-label="Navegación principal">
    <div class="sb-head">
      <a class="sb-brand" href="${role === 'admin' ? 'tablero.html' : 'trabajos.html'}" data-tip="Sistema de Fumigación">
        <span class="brand-mark" aria-hidden="true">${icon('sprout')}</span>
        <span class="sb-brand-txt"><b>Sistema de</b><b>Fumigación</b></span>
      </a>
      <button type="button" class="sb-close" id="sbClose" aria-label="Cerrar menú">${icon('x')}</button>
    </div>
    <nav class="sb-nav">${links}</nav>
    <div class="sb-foot">
      <div class="sb-user" data-tip="${esc(session.name || '')}">
        <span class="sb-avatar" aria-hidden="true">${esc(initial)}</span>
        <span class="sb-user-txt">
          <span class="sb-user-name">${esc(session.name || '')}</span>
          <span class="role-badge role-${esc(role)}" id="roleBadge">${esc(ROLE_LABEL[role] || '')}</span>
        </span>
        <span id="userName" hidden></span>
      </div>
      <button type="button" class="sb-item sb-btn" data-tip="Cambiar contraseña" onclick="openPasswordDialog()" aria-label="Cambiar mi contraseña" title="Cambiar mi contraseña">${icon('key-round')}<span class="sb-label">Contraseña</span></button>
      <button type="button" class="sb-item sb-btn sb-logout" data-tip="Salir" onclick="logout()" aria-label="Salir">${icon('log-out')}<span class="sb-label">Salir</span></button>
      <button type="button" class="sb-item sb-btn sb-toggle" id="sbToggle" data-tip="Expandir menú" aria-label="${collapsed ? 'Expandir menú' : 'Contraer menú'}" aria-pressed="${collapsed}">
        ${icon('panel-left-close')}${icon('panel-left-open')}<span class="sb-label">Contraer menú</span></button>
    </div>
  </aside>`;

  const me = document.currentScript;
  document.body.classList.add('has-sb');
  if (collapsed) document.body.classList.add('sb-collapsed');
  if (me) me.insertAdjacentHTML('beforebegin', html); else document.body.insertAdjacentHTML('afterbegin', html);

  const $ = (id) => document.getElementById(id);
  const sb = $('sidebar'), overlay = $('sbOverlay'), burger = $('sbBurger');
  const mq = window.matchMedia('(max-width: 899.98px)');

  // Mapas (Mapbox) y gráficos: que tomen el nuevo ancho cuando cambia la barra
  function resizeMaps() {
    try { if (typeof map !== 'undefined' && map && typeof map.resize === 'function') map.resize(); } catch (_) {}
    (window.__chamanMaps || []).forEach(m => { try { m.resize(); } catch (_) {} });
    window.dispatchEvent(new Event('resize'));
  }
  function afterTransition() { clearTimeout(afterTransition.t); afterTransition.t = setTimeout(resizeMaps, 230); }

  function setCollapsed(v) {
    collapsed = v;
    document.body.classList.toggle('sb-collapsed', v);
    const t = $('sbToggle');
    t.setAttribute('aria-pressed', String(v));
    t.setAttribute('aria-label', v ? 'Expandir menú' : 'Contraer menú');
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (_) {}
    resizeMaps(); afterTransition();
  }
  $('sbToggle').addEventListener('click', () => setCollapsed(!collapsed));

  // Cajón (celular/tablet)
  let lastFocus = null;
  function openDrawer() {
    lastFocus = document.activeElement;
    overlay.hidden = false;
    requestAnimationFrame(() => document.body.classList.add('sb-open'));
    burger.setAttribute('aria-expanded', 'true');
    const first = sb.querySelector('.sb-nav .sb-item:not([hidden])');
    setTimeout(() => first && first.focus({ preventScroll: true }), 50);
  }
  function closeDrawer() {
    if (!document.body.classList.contains('sb-open')) return;
    document.body.classList.remove('sb-open');
    burger.setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (!document.body.classList.contains('sb-open')) overlay.hidden = true; }, 220);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  burger.addEventListener('click', openDrawer);
  $('sbClose').addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  sb.addEventListener('click', (e) => { if (e.target.closest('.sb-nav a') && mq.matches) closeDrawer(); });
  const onMq = () => { if (!mq.matches) closeDrawer(); resizeMaps(); };
  if (mq.addEventListener) mq.addEventListener('change', onMq); else mq.addListener(onMq);

  window.ChamanNav = { setCollapsed, isCollapsed: () => collapsed, open: openDrawer, close: closeDrawer, resizeMaps };
})();
