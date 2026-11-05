/* ===================== NexarPay — casca do app, navegação por perfil e boot ===================== */

// Páginas e quem as vê. Administrador: tudo. Diretor(a)/Financeiro: dashboard gerencial + solicitações (+ consulta a lançamentos/orçamento).
// Gestor(a): dashboard do(s) seu(s) departamento(s), solicitações, lançamentos e orçamento (consulta). Colaborador(a): só solicitações.
const PAGES = [
  { id: 'gerencial', label: 'Dashboard Gerencial', ico: 'pie', roles: ['admin', 'diretor', 'financeiro'], render: () => renderGerencial() },
  { id: 'dashboard', label: 'Dashboard', ico: 'dashboard', roles: ['admin', 'gestor', 'rh'], render: () => renderDashboard() },
  { id: 'dashboard_tv', label: 'Dashboard (TV)', ico: 'tv', roles: ['admin', 'tv'], render: () => renderDashboardTV() },
  { id: 'solicitacoes', label: 'Solicitações', ico: 'send', roles: ['admin', 'diretor', 'financeiro', 'gestor', 'rh', 'colaborador'], render: () => renderSolicitacoes() },
  { id: 'lancamentos', label: 'Lançamentos', ico: 'list', roles: ['admin', 'diretor', 'financeiro', 'gestor', 'rh'], render: () => renderLancamentos() },
  { id: 'orcamento', label: 'Orçamento', ico: 'budget', roles: ['admin', 'diretor', 'financeiro', 'gestor', 'rh'], render: () => renderOrcamento() },
  { id: 'relatorios', label: 'Relatórios', ico: 'fileText', roles: ['admin', 'diretor', 'financeiro', 'gestor', 'rh'], render: () => renderRelatorios() },
  { id: 'propriedades', label: 'Propriedades', ico: 'props', roles: ['admin'], render: () => renderPropriedades() },
  { id: 'configuracoes', label: 'Configurações', ico: 'sliders', roles: ['admin'], render: () => renderConfiguracoes() },
  { id: 'preferencias', label: 'Preferências', ico: 'user', oculto: true, roles: ['admin', 'diretor', 'financeiro', 'gestor', 'rh', 'colaborador', 'tv'], render: () => renderPreferencias() },
];
let currentPage = 'solicitacoes';
const DASHBOARD_GROUP_IDS = ['gerencial', 'dashboard', 'dashboard_tv'];
let dashboardGroupOpen = true;

// perfil "tv": acesso somente ao Dashboard (TV) — nenhuma outra página aparece no menu nem é acessível.
function defaultPageFor(p) { return ({ admin: 'gerencial', diretor: 'gerencial', financeiro: 'gerencial', gestor: 'dashboard', rh: 'dashboard', colaborador: 'solicitacoes', tv: 'dashboard_tv' })[p] || 'solicitacoes'; }
function pagesForCurrentUser() { const p = perfil(); return PAGES.filter(pg => pg.roles.includes(p)); }

function navigateTo(pageId) {
  const allowed = pagesForCurrentUser();
  if (!allowed.find(p => p.id === pageId)) pageId = (allowed[0] && allowed[0].id) || 'solicitacoes';
  currentPage = pageId;
  if (pageId === 'relatorios') relState.rid = null; // clicar em Relatórios sempre volta ao menu de relatórios
  if (DASHBOARD_GROUP_IDS.includes(pageId)) dashboardGroupOpen = true;
  buildSidebar();
  const prefLink = document.getElementById('userPrefLink'); if (prefLink) prefLink.classList.toggle('active', pageId === 'preferencias');
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('page-hidden', p.id !== `page-${pageId}`));
  const def = PAGES.find(p => p.id === pageId);
  document.getElementById('pageTitle').textContent = def.label;
  document.getElementById('pageSubtitle').textContent = pageSubtitleFor(pageId);
  document.getElementById('topbarRight').innerHTML = '';
  try { def.render(); }
  catch (err) {
    console.error(`Falha ao renderizar a página "${pageId}":`, err);
    document.getElementById(`page-${pageId}`).innerHTML = `<div class="empty-state">${ICONS.alert}<h4>Não foi possível carregar esta página</h4><p>${escapeHtml(err.message || '')}</p></div>`;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function pageSubtitleFor(id) {
  const period = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return {
    gerencial: `Visão consolidada da diretoria — orçamento anual × gastos por departamento — ${period}`,
    dashboard: `Orçamento × gastos do departamento — ${period}`,
    dashboard_tv: `Painel de monitoramento personalizável, com atualização automática — ${period}`,
    solicitacoes: 'Solicitações de pagamento, aprovações e acompanhamento',
    lancamentos: 'Histórico de compras, licenças, assinaturas e pagamentos aprovados',
    orcamento: 'Cenários, prioridades e rateio do orçamento anual por departamento',
    relatorios: 'Solicitações, orçado × realizado, rateio, aprovações, agenda de pagamentos e documentos fiscais — em tela, Excel e PDF',
    propriedades: 'Departamentos, categorias, fornecedores, clientes, empresas e setores',
    configuracoes: 'Usuários, perfis de acesso, aprovadores, backup e e-mail',
    preferencias: 'Seus dados e a segurança da sua conta',
  }[id] || '';
}
window.__rerenderCurrentPage = () => { const def = PAGES.find(p => p.id === currentPage); if (def) def.render(); };

function navItemHtml(p) { return `<div class="nav-item ${p.id === currentPage ? 'active' : ''}" data-page="${p.id}">${icon(p.ico)}<span>${p.label}</span></div>`; }
function buildSidebar() {
  const nav = document.getElementById('navList');
  const pages = pagesForCurrentUser().filter(p => !p.oculto);  // "oculto": só aparece pelo cartão do usuário
  const dashPages = pages.filter(p => DASHBOARD_GROUP_IDS.includes(p.id));
  const otherPages = pages.filter(p => !DASHBOARD_GROUP_IDS.includes(p.id));
  let html = '';
  if (dashPages.length > 1) {
    const activeInGroup = dashPages.some(p => p.id === currentPage);
    html += `<div class="nav-item nav-group-toggle ${activeInGroup ? 'active-parent' : ''}" data-group-toggle="dashboards">
        ${icon('layers')}<span class="nav-group-label-text">Dashboards</span><span class="nav-caret ${dashboardGroupOpen ? 'open' : ''}">${ICONS.chevDown}</span>
      </div>
      <div class="nav-submenu ${dashboardGroupOpen ? 'open' : ''}" data-group-panel="dashboards">
        ${dashPages.map(p => `<div class="nav-item nav-sub-item ${p.id === currentPage ? 'active' : ''}" data-page="${p.id}">${icon(p.ico)}<span>${p.label}</span></div>`).join('')}
      </div>`;
  } else {
    html += dashPages.map(navItemHtml).join('');
  }
  html += otherPages.map(navItemHtml).join('');
  nav.innerHTML = html;
  nav.querySelectorAll('.nav-item[data-page]').forEach(n => n.addEventListener('click', () => navigateTo(n.dataset.page)));
  const groupToggle = nav.querySelector('[data-group-toggle="dashboards"]');
  if (groupToggle) groupToggle.addEventListener('click', (e) => { e.stopPropagation(); dashboardGroupOpen = !dashboardGroupOpen; buildSidebar(); });
}
function refreshShellForUser() {
  const u = DB.user;
  document.body.className = document.body.className.replace(/\bperfil-\w+/g, '').trim();
  if (u) document.body.classList.add('perfil-' + u.perfil);
  renderUserCard();
  buildSidebar();
  if (!pagesForCurrentUser().find(p => p.id === currentPage)) currentPage = defaultPageFor(u ? u.perfil : null);
}
function renderUserCard() {
  const card = document.getElementById('userCard');
  const u = DB.user;
  if (!u) { card.innerHTML = ''; return; }
  const initials = (u.nome || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
  const deps = (u.departamentos || []).map(depNome).join(', ');
  card.innerHTML = `<div class="user-avatar">${escapeHtml(initials)}</div>
    <div class="user-meta"><div class="name" title="${escapeHtml(u.email)}">${escapeHtml(u.nome)}</div>
    <span class="role-badge ${u.perfil}">${escapeHtml(perfilLabel(u.perfil))}</span>
    <div class="user-pref ${currentPage === 'preferencias' ? 'active' : ''}" id="userPrefLink" role="button" tabindex="0">${ICONS.user}<span>Preferências</span></div>
</div>`;
  const go = document.getElementById('userPrefLink');
  go.addEventListener('click', () => navigateTo('preferencias'));
  go.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo('preferencias'); } });
}

async function boot() {
  let bootFailed = false;
  try {
    initTheme();
    document.getElementById('icoMoon').innerHTML = ICONS.moon;
    document.getElementById('icoSun').innerHTML = ICONS.sun;
    document.getElementById('icoLogout').innerHTML = ICONS.logout;
    document.getElementById('themeBtnDark').addEventListener('click', () => setTheme('dark'));
    document.getElementById('themeBtnLight').addEventListener('click', () => setTheme('light'));
    wireAuthUI();
    const rm = /^#redefinir=([A-Za-z0-9_-]{20,})$/.exec(location.hash);
    if (rm) {  // veio do link do e-mail: o token sai da barra de endereço na hora
      window.__resetToken = rm[1];
      history.replaceState(null, '', location.pathname + location.search);
      showLoginScreen(); showLoginStep('reset');
    } else {
      const me = await api('GET', '/auth/me');
      if (me.user) {
        if (me.user.senhaProvisoria) { showLoginScreen(); toast('Entre com sua senha provisória para definir uma nova senha.', 'info'); }
        else await enterApp();
      } else showLoginScreen();
    }
  } catch (err) {
    console.error('Falha ao iniciar:', err);
    const b = document.getElementById('bootScreen');
    if (b) b.innerHTML = `<div style="color:#f5f5f8;font-family:'Inter',sans-serif;text-align:center;max-width:380px;padding:0 20px;"><div style="font-weight:800;font-size:15px;margin-bottom:8px;">Não foi possível iniciar o NexarPay</div><div style="font-size:12.5px;color:#a6a6b5;line-height:1.5;">${escapeHtml(err.message || '')}<br/>Verifique se o servidor (server.py) está em execução e recarregue a página.</div></div>`;
    bootFailed = true;
  } finally {
    const bootEl = document.getElementById('bootScreen');
    if (bootEl && !bootFailed) { bootEl.style.opacity = '0'; setTimeout(() => bootEl.remove(), 350); }
  }
}
boot();
