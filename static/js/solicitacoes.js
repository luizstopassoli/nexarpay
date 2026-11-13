/* ===================== NexarPay — Solicitações de Pagamento (visão por perfil, formulários, aprovação, linha do tempo) ===================== */

// Páginas de módulo (Solicitações > Cliente/Fornecedor, Reembolso, Freelancer, Rescisões, Interno): mesmo modelo da página Solicitações, filtrado por tipo
const SOL_MODULOS = [
  { id: 'sol_fornecedor', tipo: 'fornecedor', label: 'Cliente/Fornecedor', ico: 'truck' },
  { id: 'sol_reembolso', tipo: 'reembolso', label: 'Reembolso', ico: 'repeat' },
  { id: 'sol_freelancer', tipo: 'freelancer', label: 'Freelancer', ico: 'users' },
  { id: 'sol_rescisao', tipo: 'rescisao', label: 'Rescisões', ico: 'userX' },
  { id: 'sol_grupo', tipo: 'grupo', label: 'Interno', ico: 'building' },
];
const solModuloDaPagina = (id) => SOL_MODULOS.find(m => m.id === id) || null;
const ehPaginaSolicitacoes = (id) => id === 'solicitacoes' || !!solModuloDaPagina(id);
const solStates = {};  // filtros/paginação independentes por página
function solStateDe(pageId) { return solStates[pageId] || (solStates[pageId] = { search: '', status: '', dep: '', tipo: '', page: 1, pageSize: 12 }); }
const ABERTAS = ['fiscal', 'aprovacao1', 'aprovacao2', 'rh', 'rh2', 'financeiro'];
function podeSolicitarRescisao() { const me = DB.user; return !!me && (me.perfil === 'admin' || me.perfil === 'financeiro' || !!me.rh1 || !!me.rh2); }

function aguardaMinhaAcao(s) {
  const me = DB.user;
  if (!me) return false;
  if (me.perfil === 'admin') return ABERTAS.includes(s.status);  // Administrador age em qualquer etapa, inclusive nas próprias solicitações
  if (s.solicitanteId === me.id) return false;
  if (me.perfil === 'financeiro') return s.status === 'financeiro' || s.status === 'fiscal';  // Financeiro: Aprovação Fiscal (Reembolso) e etapa final
  if (me.perfil === 'rh') return (s.status === 'rh' && !!me.rh1) || (s.status === 'rh2' && !!me.rh2);
  if (me.perfil === 'diretor' || me.perfil === 'admin') return (s.status === 'aprovacao1' && s.aprovador1Id === me.id) || (s.status === 'aprovacao2' && s.aprovador2Id === me.id);
  return false;
}
function souSolicitante(s) { return DB.user && s.solicitanteId === DB.user.id; }

async function renderSolPagina(pageId) {
  const el = document.getElementById('page-' + pageId);
  el.innerHTML = `<div class="empty-state">${ICONS.clock}<h4>Carregando solicitações…</h4></div>`;
  try { await reloadSolicitacoes(); } catch (e) { el.innerHTML = emptyState('alert', 'Não foi possível carregar', e.message); return; }
  if (currentPage !== pageId) return;
  paintSolicitacoes(pageId);
}
function renderSolicitacoes() { return renderSolPagina('solicitacoes'); }
function renderSolModulo(pageId) { return renderSolPagina(pageId); }
function renderSolAtual() { return renderSolPagina(ehPaginaSolicitacoes(currentPage) ? currentPage : 'solicitacoes'); }

// Abre o formulário já no módulo certo (botão "+ NOVA SOLICITAÇÃO" das páginas de módulo)
function novaSolicitacaoDoModulo(tipo) {
  if (tipo === 'freelancer') { if ((DB.travaFreelancer || {}).bloqueado) { toast(DB.travaFreelancer.mensagem, 'error'); return; } }
  else if ((DB.trava || {}).bloqueado) { toast(DB.trava.mensagem, 'error'); return; }
  openSolicitacaoForm(tipo);
}
function moduloPodeCriar(tipo) { const p = DB.user && DB.user.perfil; return tipo === 'rescisao' ? podeSolicitarRescisao() : tipo === 'fornecedor' ? p !== 'rh' : true; }

// Acesso rápido: um cartão por módulo (abre a página do módulo; o "+" abre direto o formulário). Só os módulos a que o perfil tem acesso.
function acessoRapidoHtml() {
  const liberadas = new Set(pagesForCurrentUser().map(x => x.id));
  const tiles = SOL_MODULOS.filter(m => liberadas.has(m.id)).map(m => {
    const abertas = DB.solicitacoes.filter(x => x.tipo === m.tipo && ABERTAS.includes(x.status)).length;
    return `<div class="qa-tile" role="link" tabindex="0" data-qa="${m.id}" title="Abrir ${escapeHtml(m.label)}">
      ${moduloPodeCriar(m.tipo) ? `<button type="button" class="qa-plus" data-qa-new="${m.tipo}" aria-label="Nova solicitação de ${escapeHtml(m.label)}" title="Nova solicitação de ${escapeHtml(m.label)}">${ICONS.plus}</button>` : ''}
      ${icon(m.ico)}<div class="qa-name">${escapeHtml(m.label)}</div><div class="qa-count">${abertas ? abertas + ' em aberto' : 'nenhuma em aberto'}</div></div>`;
  }).join('');
  return tiles ? `<div class="quick-access anim-in"><div class="section-title-row"><h2>${icon('zap')} Acesso Rápido</h2></div><div class="qa-grid">${tiles}</div></div>` : '';
}

function paintSolicitacoes(pageId) {
  pageId = pageId || (ehPaginaSolicitacoes(currentPage) ? currentPage : 'solicitacoes');
  const modulo = solModuloDaPagina(pageId), tipo = modulo ? modulo.tipo : null;
  const el = document.getElementById('page-' + pageId);
  const me = DB.user, p = me.perfil;
  const all = tipo ? DB.solicitacoes.filter(s => s.tipo === tipo) : DB.solicitacoes;
  const minhas = all.filter(souSolicitante);
  const paraAprovar = all.filter(aguardaMinhaAcao);
  const pendentes = all.filter(s => s.status === 'alteracao');
  const reprovadas = all.filter(s => s.status === 'reprovada' && (p === 'admin' || (modulo && (p === 'diretor' || p === 'financeiro')) ? true : (souSolicitante(s) || p === 'gestor' || p === 'rh')));
  const doDep = (p === 'gestor' || p === 'rh') ? all.filter(s => !souSolicitante(s) && meusDeps().includes(s.departamentoId)) : [];
  // escopo dos indicadores: tudo que o perfil enxerga (no módulo, só o tipo do módulo)
  const escopo = all;
  const aprovadas = escopo.filter(s => s.status === 'encerrada');
  const reprovadasTot = escopo.filter(s => s.status === 'reprovada');
  const atrasadas = escopo.filter(s => s.atrasada);
  const aAprovar = escopo.filter(s => ABERTAS.includes(s.status));
  const soma = (arr) => arr.reduce((t, s) => t + (Number(s.valor) || 0), 0);
  const trava = DB.trava || {};
  const tf = DB.travaFreelancer || {};
  const pendDoc = (trava.pendentes || []).filter(x => !(trava.vencidas || []).find(v => v.id === x.id));
  const mostraTrava = !tipo || (tipo !== 'freelancer' && tipo !== 'rescisao'), mostraFrl = !tipo || tipo === 'freelancer';

  const kpis = [
    kpiCard({ label: 'Aprovações realizadas', value: aprovadas.length, icoBg: '--good', ico: 'checkCircle', sub: `${fmtBRL(soma(aprovadas))} encerrados`, compact: true }),
    kpiCard({ label: 'Reprovadas', value: reprovadasTot.length, icoBg: '--critical', ico: 'xCircle', sub: `${fmtBRL(soma(reprovadasTot))} não autorizados`, compact: true }),
    kpiCard({ label: 'Solicitações atrasadas', value: atrasadas.length, icoBg: '--serious', ico: 'clock', sub: 'abertas com data de pagamento vencida', compact: true }),
  ];
  if (p !== 'colaborador') kpis.push(kpiCard({ label: 'Valores para aprovar', value: fmtBRL(soma(aAprovar)), icoBg: '--c1', ico: 'dollar', sub: `${aAprovar.length} solicitação(ões) em aprovação`, compact: true }));

  const blocos = [];
  const aprovador = (p === 'admin' || p === 'diretor' || p === 'financeiro' || p === 'rh');
  if (aprovador) blocos.push(bloco('Solicitações para Aprovação', 'userCheck', paraAprovar, 'Nenhuma solicitação aguardando sua aprovação.'));
  if (p === 'admin' || (modulo && aprovador)) blocos.push(bloco('Solicitações Pendentes', 'repeat', pendentes, 'Nenhuma solicitação devolvida para alteração.', 'Devolvidas ao solicitante com pedido de alteração'));
  if (modulo || p === 'admin' || p === 'gestor' || p === 'rh' || p === 'colaborador' || minhas.length) blocos.push(bloco('Minhas Solicitações', 'send', minhas, modulo && !moduloPodeCriar(tipo) ? 'Você não tem solicitações neste módulo.' : 'Você ainda não fez nenhuma solicitação. Clique em NOVA SOLICITAÇÃO para começar.'));
  if (!modulo && p === 'rh') blocos.push(bloco('Freelancers — todos os departamentos', 'users', all.filter(s => s.tipo === 'freelancer'), 'Nenhum pedido de Freelancer.', 'RH 1 aprova; RH 2 acompanha os recorrentes'));
  if (!modulo && (p === 'gestor' || p === 'rh')) blocos.push(bloco('Solicitações do(s) meu(s) departamento(s)', 'users', doDep, 'Nenhuma solicitação de outros colaboradores do departamento.'));
  if (modulo || p === 'admin' || p === 'gestor' || p === 'rh' || p === 'colaborador') blocos.push(bloco('Solicitações Reprovadas', 'xCircle', reprovadas, 'Nenhuma solicitação reprovada.'));
  const st = solStateDe(pageId);
  const resumo = (modulo || p === 'admin' || p === 'diretor' || p === 'financeiro') ? resumoGeral(all, st, !!modulo) : '';
  const podeNova = !modulo || moduloPodeCriar(tipo);
  const view = solView(), scrollKb = (el.querySelector('.kb-board') || {}).scrollLeft || 0;  // preserva a rolagem do quadro nas atualizações automáticas
  const repaint = () => paintSolicitacoes(pageId);

  el.innerHTML = `
    <div class="sol-hero anim-in">
      <div><h2>${modulo ? escapeHtml(modulo.label) : 'Olá, ' + escapeHtml(me.nome)}</h2><div class="hint">${modulo ? 'Solicitações de pagamento deste módulo: acompanhe e crie novas' : 'Acompanhe e Realize novas Solicitações de Pagamento'}</div></div>
      ${podeNova ? `<button class="btn btn-cta" id="btnNovaSolicitacao">${ICONS.plus}NOVA SOLICITAÇÃO</button>` : ''}
    </div>
    ${mostraTrava && trava.bloqueado ? `<div class="alert-box">${icon('alert')}<div><strong>${escapeHtml(trava.mensagem || '')}</strong><div style="margin-top:4px;">${(trava.vencidas || []).map(v => `<a href="#" data-open-sol="${v.id}" style="color:inherit;font-weight:700;">${escapeHtml(v.numero)}</a> (prazo ${fmtDate(v.prazo)})`).join(' · ')}</div></div></div>` : ''}
    ${mostraTrava && pendDoc.length ? `<div class="alert-box warn">${icon('fileText')}<div><strong>Documento fiscal pendente</strong> em ${pendDoc.map(v => `<a href="#" data-open-sol="${v.id}" style="color:inherit;font-weight:700;">${escapeHtml(v.numero)}</a> (até ${fmtDate(v.prazo)})`).join(', ')}. Anexe dentro do prazo para não bloquear novas solicitações.</div></div>` : ''}
    ${mostraFrl && (me.rh1 || me.rh2) && all.some(x => x.alertaTermino !== null && x.alertaTermino !== undefined) ? `<div class="alert-box warn">${icon('clock')}<div><strong>Freelancer recorrente: contrato perto do fim</strong><div style="margin-top:4px;">${all.filter(x => x.alertaTermino !== null && x.alertaTermino !== undefined).map(x => `<a href="#" data-open-sol="${x.id}" style="color:inherit;font-weight:700;">${escapeHtml(x.numero)}</a> — ${escapeHtml(x.dados.nomeFreelancer || '')} (${x.alertaTermino > 0 ? 'termina em ' + x.alertaTermino + ' dia(s)' : x.alertaTermino === 0 ? 'termina hoje' : 'terminou há ' + (-x.alertaTermino) + ' dia(s)'})`).join(' · ')}. Ajuste o valor/término ou encerre. O sistema também envia e-mail todos os dias.</div></div></div>` : ''}
    ${mostraFrl && tf.bloqueado ? `<div class="alert-box">${icon('alert')}<div><strong>${escapeHtml(tf.mensagem || '')}</strong><div style="margin-top:4px;">${(tf.vencidas || []).map(v => `<a href="#" data-open-sol="${v.id}" style="color:inherit;font-weight:700;">${escapeHtml(v.numero)}</a> (${escapeHtml(v.nome || '')}, término ${fmtDate(v.dataFim)})`).join(' · ')}</div></div></div>` : mostraFrl && (tf.pendentes || []).length ? `<div class="alert-box warn">${icon('fileText')}<div><strong>Freelancer: Nota Fiscal pendente</strong> em ${(tf.pendentes || []).map(v => `<a href="#" data-open-sol="${v.id}" style="color:inherit;font-weight:700;">${escapeHtml(v.numero)}</a> (até ${fmtDate(v.dataFim)})`).join(', ')}. Anexe a NF até o fim da contratação para não ficar bloqueado(a) de novas solicitações de Freelancer.</div></div>` : ''}
    <div class="grid ${kpis.length === 4 ? 'grid-4' : 'grid-3'} anim-in">${kpis.join('')}</div>
    ${modulo ? '' : acessoRapidoHtml()}
    ${view === 'kanban' ? kanbanHtml(all, st, modulo) : `<div class="vw-bar">${vwToggleHtml('lista')}</div>${blocos.join('')}${resumo}`}
  `;
  const kbBoard = el.querySelector('.kb-board'); if (kbBoard) kbBoard.scrollLeft = scrollKb;

  el.querySelectorAll('[data-qa]').forEach(t => {
    const abrir = () => navigateTo(t.dataset.qa);
    t.addEventListener('click', abrir);
    t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
  });
  el.querySelectorAll('[data-qa-new]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); novaSolicitacaoDoModulo(b.dataset.qaNew); }));
  const nova = el.querySelector('#btnNovaSolicitacao');
  if (nova) nova.addEventListener('click', () => {
    if (modulo) { novaSolicitacaoDoModulo(tipo); return; }
    if (trava.bloqueado) { toast(trava.mensagem, 'error'); return; }
    openTipoSolicitacao();
  });
  el.querySelectorAll('[data-open-sol]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); openSolicitacao(Number(a.dataset.openSol)); }));
  wireVista(el, repaint);
  if (view === 'kanban') wireKanban(el, all, st, modulo, repaint); else wireResumo(el, all, st, !!modulo);
}

/* ---------- visualização Kanban (somente leitura: os cartões abrem o detalhe; aprovar/alterar/reprovar continuam lá) ---------- */
function solView() { try { return localStorage.getItem('nexarpay.solView') === 'kanban' ? 'kanban' : 'lista'; } catch (e) { return 'lista'; } }
function setSolView(v) { try { localStorage.setItem('nexarpay.solView', v); } catch (e) { /* sem armazenamento: vale só nesta sessão */ } }
const KB_ROTULO = { fiscal: 'Aprovação Fiscal', aprovacao1: 'Aprovação 1', aprovacao2: 'Aprovação 2', rh: 'RH 1', rh2: 'RH 2', financeiro: 'Financeiro', alteracao: 'Alteração solicitada', encerrada: 'Encerrada', reprovada: 'Reprovada' };
const KB_MAX_CARTOES = 25;
function vwToggleHtml(view) {
  return `<div class="period-filter" data-vw role="group" aria-label="Visualização"><button type="button" data-vw="lista" class="${view === 'lista' ? 'active' : ''}">${ICONS.list}Lista</button><button type="button" data-vw="kanban" class="${view === 'kanban' ? 'active' : ''}">${ICONS.layers}Kanban</button></div>`;
}
// colunas: na página geral por situação; em cada módulo pelas etapas do fluxo daquele módulo
function kbColunas(tipo, itens) {
  const lim = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const enc = itens.filter(x => x.status === 'encerrada');
  const enc30 = enc.filter(x => String(x.encerradoEm || x.atualizadoEm || '').slice(0, 10) >= lim);
  const col = (t, cor, lista, extra) => Object.assign({ t, cor, lista }, extra || {});
  const por = (...sts) => itens.filter(x => sts.includes(x.status));
  const encerradas = col('Encerradas', 'var(--good)', enc30, { sub: 'últimos 30 dias', total: enc.length, ver: 'encerrada' });
  if (!tipo) return [
    col('Aguardando minha ação', 'var(--c1)', itens.filter(aguardaMinhaAcao)),
    col('Em andamento', 'var(--warning)', itens.filter(x => ABERTAS.includes(x.status) && !aguardaMinhaAcao(x))),
    col('Devolvidas p/ alteração', 'var(--serious)', por('alteracao')),
    encerradas,
    col('Reprovadas', 'var(--critical)', por('reprovada'), { ver: 'reprovada', total: por('reprovada').length }),
  ];
  const a1 = col('Aprovação 1', '#14c26b', por('aprovacao1')), a2 = col('Aprovação 2', '#DB2777', por('aprovacao2')), fin = col('Financeiro', 'var(--c7)', por('financeiro'));
  const fluxo = tipo === 'reembolso' ? [col('Aprovação Fiscal', '#F97316', por('fiscal')), a1, a2, fin]
    : tipo === 'freelancer' ? [a1, a2, col('RH 1', '#0EA5A4', por('rh')), col('Financeiro / RH 2', 'var(--c7)', por('financeiro', 'rh2'), { sub: 'RH 2 acompanha os recorrentes' })]
    : tipo === 'rescisao' ? [col('RH 1', '#0EA5A4', por('rh')), a1, a2, fin]
    : [a1, a2, fin];
  return fluxo.concat([Object.assign(encerradas, { t: 'Encerrado' })]);
}
function kbCartao(x, modulo) {
  const mine = aguardaMinhaAcao(x);
  return `<div class="kb-card ${mine ? 'mine' : ''}" role="button" tabindex="0" data-kb-open="${x.id}" title="Abrir ${escapeHtml(x.numero)}">
    <div class="kb-top"><span>${escapeHtml(x.numero)}</span><span class="badge">${escapeHtml(x.tipoLabel)}</span></div>
    <div class="kb-title">${escapeHtml(x.titulo)}</div>
    <div class="kb-meta"><span class="dept-chip">${escapeHtml(depNome(x.departamentoId))}</span><span>${escapeHtml(x.solicitanteNome || '')}</span></div>
    <div class="kb-foot"><span class="kb-val">${fmtBRL(x.valor)}</span><span class="kb-date">pgto ${fmtDate(x.dataPagamento)}</span></div>
    <div class="kb-flags">${modulo ? '' : `<span class="st st-${x.status}">${escapeHtml(KB_ROTULO[x.status] || x.status)}</span>`}${x.atrasada ? '<span class="st st-atrasada">Atrasada</span>' : ''}${x.docFiscalVencido ? '<span class="st st-atrasada" title="Documento fiscal em atraso">Doc. fiscal</span>' : ''}${mine ? '<span class="kb-mine-tag">sua ação</span>' : ''}</div>
  </div>`;
}
function kbAreaHtml(all, st, modulo) {
  const lista = filtrarSolic(all, st, !!modulo, true);
  const cols = kbColunas(modulo ? modulo.tipo : null, lista);
  const soma = (arr) => arr.reduce((t, x) => t + (Number(x.valor) || 0), 0);
  const board = cols.map(c => {
    const vis = c.lista.slice(0, KB_MAX_CARTOES), resto = (c.total !== undefined ? c.total : c.lista.length) - vis.length;
    return `<div class="kb-col"><div class="kb-head"><h3><span class="kb-dot" style="background:${c.cor}"></span>${escapeHtml(c.t)}</h3><span class="kb-count">${c.lista.length}</span></div>
      <div class="kb-sum">${c.sub ? escapeHtml(c.sub) + ' · ' : ''}${fmtBRL(soma(c.lista))}</div>
      ${vis.length ? vis.map(x => kbCartao(x, modulo)).join('') : '<div class="kb-empty">Nenhuma solicitação</div>'}
      ${resto > 0 ? `<div class="kb-more" ${c.ver ? `data-kb-ver="${c.ver}" role="button" tabindex="0"` : ''}>${c.ver ? `Ver todas as ${c.total} na lista` : `+ ${resto} na lista`}</div>` : (c.ver && c.total > c.lista.length ? `<div class="kb-more" data-kb-ver="${c.ver}" role="button" tabindex="0">Ver todas as ${c.total} na lista</div>` : '')}
    </div>`;
  }).join('');
  let lane = '';
  if (modulo) {  // devolvidas e reprovadas ficam numa faixa abaixo do quadro, para não poluir as etapas
    const dev = lista.filter(x => x.status === 'alteracao'), rep = lista.filter(x => x.status === 'reprovada');
    lane = `<div class="kb-lane"><button type="button" class="kb-chip ${st.lane === 'alteracao' ? 'on' : ''}" data-kb-lane="alteracao">Alteração solicitada · ${dev.length}</button><button type="button" class="kb-chip ${st.lane === 'reprovada' ? 'on' : ''}" data-kb-lane="reprovada">Reprovadas · ${rep.length}</button></div>
      ${st.lane ? `<div class="kb-lane-cards">${(st.lane === 'alteracao' ? dev : rep).map(x => kbCartao(x, modulo)).join('') || '<div class="kb-empty">Nenhuma solicitação</div>'}</div>` : ''}`;
  }
  return `<div class="kb-board" style="--kb-cols:${cols.length}">${board}</div>${lane}`;
}
function kanbanHtml(all, st, modulo) {
  return `<div class="kb-wrap" data-kb>
    <div class="vw-bar">${vwToggleHtml('kanban')}
      <div class="search-box">${ICONS.search}<input data-kf="search" placeholder="Buscar por nº, título, solicitante, fornecedor…" value="${escapeHtml(st.search)}"/></div>
      <select data-kf="dep"><option value="">Departamento (todos)</option>${selectOptions(DB.departamentos, st.dep)}</select>
      ${modulo ? '' : `<select data-kf="tipo"><option value="">Tipo (todos)</option>${Object.entries(DB.tiposSolicitacao).map(([k, v]) => `<option value="${k}" ${st.tipo === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>`}
    </div>
    <div data-kb-area>${kbAreaHtml(all, st, modulo)}</div></div>`;
}
function wireVista(el, repaint) {
  el.querySelectorAll('[data-vw] button').forEach(b => b.addEventListener('click', () => { if (b.dataset.vw !== solView()) { setSolView(b.dataset.vw); repaint(); } }));
}
function wireKanban(el, all, st, modulo, repaint) {
  const kb = el.querySelector('[data-kb]');
  if (!kb) return;
  const area = kb.querySelector('[data-kb-area]');
  const ativa = (e, fn) => e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fn(); } });
  const ligar = () => {
    area.querySelectorAll('[data-kb-open]').forEach(c => { const abrir = () => openSolicitacao(Number(c.dataset.kbOpen)); c.addEventListener('click', abrir); ativa(c, abrir); });
    area.querySelectorAll('[data-kb-ver]').forEach(c => { const ir = () => { st.status = c.dataset.kbVer; st.page = 1; setSolView('lista'); repaint(); }; c.addEventListener('click', ir); ativa(c, ir); });
    area.querySelectorAll('[data-kb-lane]').forEach(b => b.addEventListener('click', () => { st.lane = st.lane === b.dataset.kbLane ? null : b.dataset.kbLane; rer(); }));
  };
  const rer = () => { const sl = (area.querySelector('.kb-board') || {}).scrollLeft || 0; area.innerHTML = kbAreaHtml(all, st, modulo); const b = area.querySelector('.kb-board'); if (b) b.scrollLeft = sl; ligar(); };
  kb.querySelector('[data-kf="search"]').addEventListener('input', debounce(e => { st.search = e.target.value; rer(); }, 200));
  kb.querySelector('[data-kf="dep"]').addEventListener('change', e => { st.dep = e.target.value; rer(); });
  const ft = kb.querySelector('[data-kf="tipo"]'); if (ft) ft.addEventListener('change', e => { st.tipo = e.target.value; rer(); });
  ligar();
}

function bloco(titulo, ico, lista, vazio, sub) {
  return `<div class="sol-block anim-in">
    <div class="section-title-row"><h2>${icon(ico)} ${escapeHtml(titulo)}</h2><div class="hint">${escapeHtml(sub || '')} ${lista.length} registro(s)</div></div>
    <div class="card table-card"><div class="table-scroll">${lista.length ? tabelaSolicitacoes(lista) : `<div class="empty-state" style="padding:26px;">${ICONS.inbox}<p>${escapeHtml(vazio)}</p></div>`}</div></div>
  </div>`;
}
function tabelaSolicitacoes(lista, resumo = false) {
  return `<table class="data-table">
    <thead><tr><th>Nº</th><th>Título</th><th>Tipo</th><th>Solicitante</th><th>Departamento</th><th>Data da Solicitação</th><th>Valor Total</th><th>Data do Pagamento</th><th>Status</th><th></th></tr></thead>
    <tbody>${lista.map(s => `<tr data-open-sol="${s.id}" style="cursor:pointer;">
      <td class="cell-dim" style="white-space:nowrap;">${escapeHtml(s.numero)}</td>
      <td class="cell-strong" style="white-space:normal;min-width:200px;">${escapeHtml(s.titulo)}</td>
      <td><span class="badge">${escapeHtml(s.tipoLabel)}</span></td>
      <td>${escapeHtml(s.solicitanteNome)}</td>
      <td><span class="dept-chip">${escapeHtml(depNome(s.departamentoId))}</span></td>
      <td class="cell-dim">${fmtDateTime(s.criadoEm)}</td>
      <td class="cell-num">${fmtBRL(s.valor)}</td>
      <td class="cell-dim">${fmtDate(s.dataPagamento)}</td>
      <td>${statusPill(s)}${s.docFiscalVencido ? ' <span class="st st-atrasada" title="Documento fiscal em atraso">Doc. fiscal</span>' : ''}</td>
      <td><div class="row-actions" style="justify-content:flex-end;"><button class="icon-btn" title="Abrir">${ICONS.eye}</button></div></td>
    </tr>`).join('')}</tbody></table>`;
}
function filtrarSolic(all, st, semFiltroTipo, ignorarStatus) {
  let lista = all.slice();
  const q = st.search.trim().toLowerCase();
  if (q) lista = lista.filter(s => [s.numero, s.titulo, s.solicitanteNome, depNome(s.departamentoId), s.dados.fornecedor, s.dados.cliente].filter(Boolean).join(' ').toLowerCase().includes(q));
  if (st.status && !ignorarStatus) lista = lista.filter(s => st.status === 'abertas' ? ABERTAS.includes(s.status) : s.status === st.status);
  if (st.dep) lista = lista.filter(s => s.departamentoId === st.dep);
  if (st.tipo && !semFiltroTipo) lista = lista.filter(s => s.tipo === st.tipo);
  return lista;
}
function resumoGeral(all, st, semFiltroTipo) {
  const lista = filtrarSolic(all, st, semFiltroTipo);
  const totalPages = Math.max(1, Math.ceil(lista.length / st.pageSize));
  st.page = clamp(st.page, 1, totalPages);
  const pg = lista.slice((st.page - 1) * st.pageSize, st.page * st.pageSize);
  return `<div class="sol-block anim-in" data-resumo>
    <div class="section-title-row"><h2>${icon('list')} Resumo geral das solicitações</h2><div class="hint">${lista.length} de ${all.length} · ${fmtBRL(lista.reduce((t, s) => t + s.valor, 0))}</div></div>
    <div class="card table-card">
      <div class="table-toolbar">
        <div class="search-box">${ICONS.search}<input data-f="search" placeholder="Buscar por nº, título, solicitante, fornecedor…" value="${escapeHtml(st.search)}"/></div>
        <select data-f="status"><option value="">Status (todos)</option><option value="abertas" ${st.status === 'abertas' ? 'selected' : ''}>Em aprovação</option>${Object.entries(DB.statusLabel).map(([k, v]) => `<option value="${k}" ${st.status === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>
        <select data-f="dep"><option value="">Departamento (todos)</option>${selectOptions(DB.departamentos, st.dep)}</select>
        ${semFiltroTipo ? '' : `<select data-f="tipo"><option value="">Tipo (todos)</option>${Object.entries(DB.tiposSolicitacao).map(([k, v]) => `<option value="${k}" ${st.tipo === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>`}
      </div>
      <div class="table-scroll">${pg.length ? tabelaSolicitacoes(pg, true) : emptyState('inbox', 'Nenhuma solicitação encontrada', 'Ajuste os filtros.')}</div>
      <div class="table-pagination"><span>Mostrando ${pg.length ? (st.page - 1) * st.pageSize + 1 : 0}–${(st.page - 1) * st.pageSize + pg.length} de ${lista.length}</span>
        <div class="pg-btns"><button class="btn btn-sm" data-pg="prev" ${st.page <= 1 ? 'disabled' : ''}>Anterior</button><button class="btn btn-sm" data-pg="next" ${st.page >= totalPages ? 'disabled' : ''}>Próxima</button></div></div>
    </div></div>`;
}
function wireResumo(el, all, st, semFiltroTipo) {
  el.querySelectorAll('tr[data-open-sol]').forEach(tr => tr.addEventListener('click', () => openSolicitacao(Number(tr.dataset.openSol))));
  const rg = el.querySelector('[data-resumo]');
  if (!rg) return;
  const rer = () => { rg.outerHTML = resumoGeral(all, st, semFiltroTipo); wireResumo(el, all, st, semFiltroTipo); };
  const f = (k) => rg.querySelector(`[data-f="${k}"]`);
  f('search').addEventListener('input', debounce(e => { st.search = e.target.value; st.page = 1; rer(); }, 200));
  f('status').addEventListener('change', e => { st.status = e.target.value; st.page = 1; rer(); });
  f('dep').addEventListener('change', e => { st.dep = e.target.value; st.page = 1; rer(); });
  if (f('tipo')) f('tipo').addEventListener('change', e => { st.tipo = e.target.value; st.page = 1; rer(); });
  rg.querySelector('[data-pg="prev"]').addEventListener('click', () => { st.page--; rer(); });
  rg.querySelector('[data-pg="next"]').addEventListener('click', () => { st.page++; rer(); });
}

/* ---------- NOVA SOLICITAÇÃO: escolha do tipo ---------- */
function openTipoSolicitacao() {
  openModal(`
    <div class="modal-head"><h3>${modalIcon('send')} Nova Solicitação de Pagamento</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body">
      <p style="font-size:13px; color:var(--text-dim); margin-bottom:14px;">A solicitação é para pagamento de:</p>
      <div class="type-grid">
        ${DB.user && DB.user.perfil === 'rh' ? '' : `<div class="type-card" data-tipo="fornecedor">${icon('truck')}<strong>CLIENTE/FORNECEDOR</strong><span>Pagamento a um fornecedor ou reembolso a um cliente, vinculado a uma OC/PI/PC/PO/OP.</span></div>`}
        <div class="type-card" data-tipo="reembolso">${icon('repeat')}<strong>REEMBOLSO</strong><span>Despesa paga por você (alimentação, transporte, hospedagem…) com recibo ou nota fiscal.</span></div>
        <div class="type-card" data-tipo="freelancer">${icon('users')}<strong>FREELANCER</strong><span>Contratação de profissional autônomo por períodos pré-determinados.</span></div>
        ${podeSolicitarRescisao() ? `<div class="type-card" data-tipo="rescisao">${icon('userX')}<strong>RESCISÕES</strong><span>Custos de desligamento de colaboradores (aviso prévio, férias, FGTS…).</span></div>` : ''}
        <div class="type-card" data-tipo="grupo">${icon('building')}<strong>INTERNO</strong><span>Despesa interna da empresa ou Grupo, dentro do orçamento do departamento.</span></div>
      </div>
    </div>`, { size: 'lg' });
  modalBackdrop().querySelectorAll('.type-card').forEach(c => c.addEventListener('click', () => { if (c.dataset.tipo === 'freelancer' && (DB.travaFreelancer || {}).bloqueado) { toast(DB.travaFreelancer.mensagem, 'error'); return; } closeModal(); setTimeout(() => openSolicitacaoForm(c.dataset.tipo), 200); }));
}

/* ---------- formulário (criação e alteração) ---------- */
function openSolicitacaoForm(tipo, existente) {
  const me = DB.user;
  const editing = !!existente;
  const d = editing ? deepClone(existente.dados) : {};
  const P = DB.properties;
  const deps = tipo === 'rescisao' ? DB.departamentos.filter(x => x.ativo) : depsVisiveis();
  const depSel = editing ? existente.departamentoId : (deps[0] ? deps[0].id : '');
  const solicNome = editing ? d.solicitante : me.nome;
  const solicOutro = editing && d.solicitante && d.solicitante !== me.nome;
  const dom = DB.config.dominio || 'grupogpac.com.br';
  let anexos = editing ? deepClone(existente.anexos || []) : [];

  const fSolicitante = `<div class="form-field"><label>Solicitante <span class="req">*</span></label>
      <select name="solicitanteSel" id="solicitanteSel"><option value="eu" ${!solicOutro ? 'selected' : ''}>${escapeHtml(me.nome)}</option><option value="outro" ${solicOutro ? 'selected' : ''}>Outro</option></select>
      <input class="input ${solicOutro ? '' : 'hidden'}" id="solicitanteOutro" name="solicitanteOutro" placeholder="Nome de quem solicita" value="${escapeHtml(solicOutro ? solicNome : '')}" style="margin-top:6px;"/></div>`;
  const fEmail = `<div class="form-field"><label>E-mail <span class="req">*</span></label><input class="input" type="email" name="email" value="${escapeHtml(d.email || me.email)}" required/><span class="form-hint">Somente e-mail corporativo @${escapeHtml(dom)}</span></div>`;
  const fDep = `<div class="form-field"><label>Departamento <span class="req">*</span></label>${deps.length > 1 ? `<select name="departamentoId">${selectOptions(deps, depSel)}</select>` : `<input class="input" value="${escapeHtml(depNome(depSel))}" disabled/><input type="hidden" name="departamentoId" value="${escapeHtml(depSel)}"/>`}</div>`;
  const fDesc = `<div class="form-field full"><label>Descrição da despesa <span class="req">*</span></label><textarea name="descricao" rows="4" required placeholder="Descreva de forma clara e objetiva o motivo do pagamento">${escapeHtml(d.descricao || '')}</textarea></div>`;
  const fValor = `<div class="form-field"><label>Valor Total <span class="req">*</span></label><div class="money-wrap"><input class="input" name="valor" id="valorInput" placeholder="0,00" inputmode="decimal" value="${d.valor ? maskBRL(d.valor) : ''}" required/></div></div>`;
  const fData = (lab) => `<div class="form-field"><label>${lab} <span class="req">*</span></label><input class="input" type="date" name="dataPagamento" value="${escapeHtml(d.dataPagamento || '')}" required/></div>`;
  const fErro = `<div class="form-field full"><label>Esta solicitação surgiu devido a um erro interno? <span class="req">*</span></label><div class="radio-row">
      <label class="radio-chip"><input type="radio" name="erroInterno" value="sim" ${d.erroInterno === 'sim' ? 'checked' : ''} required/> Sim</label>
      <label class="radio-chip"><input type="radio" name="erroInterno" value="nao" ${d.erroInterno === 'nao' ? 'checked' : ''} required/> Não</label></div></div>`;
  const fEmpresa = `<div class="form-field"><label>Empresa <span class="req">*</span></label><select name="empresaId" required><option value="">Selecione…</option>${selectOptions(empresaOptions(d.empresaId), d.empresaId)}</select>
      <span class="form-hint">Despesa do ${escapeHtml(DB.grupoNome || 'grupo')} é dividida entre as empresas pelo rateio do orçamento; ao escolher uma empresa, o valor é abatido 100% dela.</span></div>`;
  const fCliente = `<div class="form-field"><label>Cliente <span class="req">*</span></label><select name="cliente" required><option value="">Selecione…</option>${selectOptions(P.clientes || [], d.cliente)}</select></div>`;
  const fAnexos = (lab, req) => `<div class="form-field full"><label>${lab} ${req ? '<span class="req">*</span>' : ''}</label>
      <div class="upload-slot" id="anexoSlot"><div class="upload-ico">${ICONS.upload}</div><div class="upload-text"><strong>Anexar arquivo</strong><span>PDF, DOCX, XLSX, PNG ou JPEG · até ${DB.config.maxUploadMB || 20} MB · pode anexar mais de um</span></div></div>
      <input type="file" id="anexoInput" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" multiple style="display:none;"/>
      <div class="attach-list" id="anexoList"></div></div>`;

  let campos = '';
  let titulo = '';
  if (tipo === 'fornecedor') {
    titulo = 'Pagamento — Cliente/Fornecedor';
    campos = `<div class="form-field full"><label>Título <span class="req">*</span></label><input class="input" name="titulo" required placeholder="Ex.: Pagamento ao Fornecedor XYZ ou Reembolso ao cliente XYZ" value="${escapeHtml(d.titulo || '')}"/></div>
      ${fSolicitante}${fEmail}${fDep}
      <div class="form-field"><label>Fornecedor <span class="req">*</span></label><input class="input" name="fornecedor" required placeholder="Quem irá receber o pagamento" value="${escapeHtml(d.fornecedor || '')}"/></div>
      ${fCliente}${fEmpresa}
      <div class="form-field"><label>Nº de Referência <span class="req">*</span></label>
        <div class="ref-add"><input class="input" id="refInput" maxlength="60" placeholder="Ex.: OC-2026-001, PI-4587, OS-1234" autocomplete="off"/><button type="button" class="btn" id="refAddBtn">Adicionar</button></div>
        <div class="ref-list" id="refList"></div></div>
      ${fDesc}${fValor}${fData('Data do Pagamento')}${fErro}${fAnexos('Documento', false)}`;
  } else if (tipo === 'reembolso') {
    titulo = 'Reembolso';
    campos = `<div class="form-field full"><label>Nome <span class="req">*</span></label><input class="input" name="nome" required placeholder="Nome completo do solicitante" value="${escapeHtml(d.nome || me.nome)}"/></div>
      ${fEmail}${fCliente}
      <div class="form-field"><label>Reembolsado pelo Cliente? <span class="req">*</span></label><div class="radio-row">
        <label class="radio-chip"><input type="radio" name="reembolsadoCliente" value="sim" ${d.reembolsadoCliente === 'sim' ? 'checked' : ''} required/> Sim</label>
        <label class="radio-chip"><input type="radio" name="reembolsadoCliente" value="nao" ${d.reembolsadoCliente === 'nao' ? 'checked' : ''} required/> Não</label></div></div>
      ${fDep}
      <div class="form-field"><label>Categoria da Despesa <span class="req">*</span></label><select name="categoriaDespesa" required><option value="">Selecione…</option>${selectOptions(P.categoriasReembolso || [], d.categoriaDespesa)}</select></div>
      ${fEmpresa}${fDesc}${fValor}${fData('Data')}
      ${fAnexos('Recibo / Nota Fiscal', true)}
      <div class="form-section">Dados bancários</div>
      <div class="form-field"><label>Banco</label><input class="input" name="banco" value="${escapeHtml(d.banco || '')}"/></div>
      <div class="form-field"><label>Agência</label><input class="input" name="agencia" value="${escapeHtml(d.agencia || '')}"/></div>
      <div class="form-field"><label>Conta</label><input class="input" name="conta" value="${escapeHtml(d.conta || '')}"/></div>
      <div class="form-field"><label>CPF ou CNPJ</label><input class="input" name="cpfCnpj" value="${escapeHtml(d.cpfCnpj || '')}"/></div>`;
  } else if (tipo === 'rescisao') {
    titulo = 'Rescisões';
    campos = `${fSolicitante}${fEmail}${fDep}${fEmpresa}
      <div class="form-field"><label>Tipo <span class="req">*</span></label><select name="tipoRescisao" required><option value="">Selecione…</option>${selectOptions([{ id: 'pedido_dispensa', nome: 'Pedido de Dispensa' }, { id: 'dispensado', nome: 'Dispensado' }], d.tipoRescisao)}</select></div>
      ${fData('Data de Pagamento')}
      <div class="form-field full"><label>Motivo do Desligamento <span class="req">*</span></label><textarea name="descricao" rows="3" required placeholder="Descreva o motivo do desligamento e o que compõe o valor (aviso prévio, férias, FGTS…)">${escapeHtml(d.descricao || '')}</textarea></div>
      ${fValor}
      ${fAnexos('Anexos', false)}`;
  } else if (tipo === 'freelancer') {
    titulo = 'Freelancer';
    campos = `${fSolicitante}${fEmail}${fEmpresa}${fDep}
      <div class="form-field full"><label>Motivo da contratação <span class="req">*</span></label><textarea name="descricao" rows="3" required placeholder="Descreva o motivo e o escopo da contratação">${escapeHtml(d.descricao || '')}</textarea></div>
      <div class="form-field"><label>Recorrente? <span class="req">*</span></label><div class="radio-row">
        <label class="radio-chip"><input type="radio" name="recorrente" value="sim" ${d.recorrente === 'sim' ? 'checked' : ''} required/> Sim</label>
        <label class="radio-chip"><input type="radio" name="recorrente" value="nao" ${d.recorrente === 'nao' ? 'checked' : ''} required/> Não</label></div></div>
      <div class="form-field"><label>Modalidade <span class="req">*</span></label><select name="modalidade" required><option value="">Selecione…</option>${selectOptions([{ id: 'presencial', nome: 'Presencial' }, { id: 'home_office', nome: 'Home office' }, { id: 'hibrido', nome: 'Híbrido' }], d.modalidade)}</select></div>
      <div class="form-field"><label>Data de início <span class="req">*</span></label><input class="input" type="date" name="dataInicio" required value="${escapeHtml(d.dataInicio || '')}"/></div>
      <div class="form-field"><label>Data de término <span class="req">*</span></label><input class="input" type="date" name="dataFim" required value="${escapeHtml(d.dataFim || '')}"/><span class="form-hint">No máximo 31 dias a partir do início. Término anterior a hoje: somente a Diretoria faz o pedido.</span></div>
      ${fValor}
      <div class="form-field"><label>Nome completo do freelancer <span class="req">*</span></label><input class="input" name="nomeFreelancer" required value="${escapeHtml(d.nomeFreelancer || '')}"/></div>
      <div class="form-section">Dados bancários</div>
      <div class="form-field"><label>Banco <span class="req">*</span></label><input class="input" name="banco" required value="${escapeHtml(d.banco || '')}"/></div>
      <div class="form-field"><label>Agência <span class="req">*</span></label><input class="input" name="agencia" required value="${escapeHtml(d.agencia || '')}"/></div>
      <div class="form-field"><label>C/C <span class="req">*</span></label><input class="input" name="conta" required value="${escapeHtml(d.conta || '')}"/></div>
      <div class="form-field"><label>CNPJ <span class="req">*</span></label><input class="input" name="cpfCnpj" required placeholder="00.000.000/0000-00" value="${escapeHtml(d.cpfCnpj || '')}"/></div>
      ${editing ? '' : fAnexos('Anexar NF (pode ser anexada depois, até o fim da contratação)', false)}`;
  } else {
    titulo = 'Pagamento — Interno';
    campos = `<div class="form-field full"><label>Título <span class="req">*</span></label><input class="input" name="titulo" required placeholder="Ex.: Pagamento ao Fornecedor XYZ" value="${escapeHtml(d.titulo || '')}"/></div>
      ${fSolicitante}${fEmail}${fDep}
      <div class="form-field"><label>Fornecedor <span class="req">*</span></label><input class="input" name="fornecedor" required placeholder="Quem irá receber o pagamento" value="${escapeHtml(d.fornecedor || '')}"/></div>
      ${fEmpresa}
      <div class="form-field"><label>Categoria <span class="req">*</span></label><select name="categoria" required><option value="">Selecione…</option>${selectOptions(P.categorias || [], d.categoria)}</select></div>
      ${fDesc}${fValor}${fData('Data do Pagamento')}${fErro}${fAnexos('Documento', false)}`;
  }

  openModal(`
    <div class="modal-head"><h3>${modalIcon(editing ? 'edit' : 'send')} ${editing ? 'Alterar solicitação ' + escapeHtml(existente.numero) : 'Nova Solicitação — ' + escapeHtml(titulo)}</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body">
      ${editing ? `<div class="alert-box warn">${icon('alert')}<div><strong>Alteração solicitada por ${escapeHtml(userNome(ultimaAlteracao(existente).userId))}:</strong> ${escapeHtml(existente.motivoUltimo || '')}<br/><span style="color:var(--text-dim);">Toda alteração fica registrada no histórico da solicitação.</span></div></div>` : ''}
      <form id="solForm"><div class="form-grid">${campos}
      ${editing ? `<div class="form-field full"><label>O que foi alterado (opcional)</label><input class="input" name="comentario" placeholder="Ex.: anexada a proposta e corrigido o valor"/></div>` : ''}
      </div></form>
    </div>
    <div class="modal-foot"><button class="btn" data-close-modal>CANCELAR</button><button class="btn btn-primary" id="solSubmit">${ICONS.send}${editing ? 'REENVIAR SOLICITAÇÃO' : 'ENVIAR SOLICITAÇÃO'}</button></div>`, { size: 'lg', locked: true });

  const form = document.getElementById('solForm');
  attachMoneyMask(document.getElementById('valorInput'));
  // Nº de Referência (Cliente/Fornecedor): vários números, cada um com X para remover
  let refs = tipo === 'fornecedor' ? (Array.isArray(d.referencias) ? d.referencias.slice() : String(d.numeroOcPi || '').split(',').map(x => x.trim()).filter(Boolean)) : [];
  const refInput = document.getElementById('refInput'), refList = document.getElementById('refList');
  const paintRefs = () => {
    if (!refList) return;
    refList.innerHTML = refs.map((r, i) => `<span class="ref-chip">${escapeHtml(r)}<button type="button" data-rm-ref="${i}" aria-label="Remover ${escapeHtml(r)}" title="Remover">${ICONS.x}</button></span>`).join('');
    refList.querySelectorAll('[data-rm-ref]').forEach(b => b.addEventListener('click', () => { refs.splice(Number(b.dataset.rmRef), 1); paintRefs(); }));
  };
  const addRef = () => {
    const v = refInput.value.replace(/\s+/g, ' ').trim();
    if (!v) { refInput.focus(); return false; }
    if (!refs.some(x => x.toLowerCase() === v.toLowerCase())) refs.push(v); else toast('Esse número de referência já foi adicionado.', 'info');
    refInput.value = ''; paintRefs(); refInput.focus(); return true;
  };
  if (refInput) {
    document.getElementById('refAddBtn').addEventListener('click', addRef);
    refInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRef(); } });
    paintRefs();
  }
  const sel = document.getElementById('solicitanteSel');
  if (sel) sel.addEventListener('change', () => { document.getElementById('solicitanteOutro').classList.toggle('hidden', sel.value !== 'outro'); });

  const slot = document.getElementById('anexoSlot'), input = document.getElementById('anexoInput'), list = document.getElementById('anexoList');
  const paintAnexos = () => {
    list.innerHTML = anexos.map((a, i) => `<div class="attach-item">${ICONS.file}<span class="nm">${escapeHtml(a.nome)}</span><span class="sz">${humanFileSize(a.tamanho)}</span><button type="button" class="icon-btn danger" data-rm="${i}" title="Remover">${ICONS.x}</button></div>`).join('');
    list.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { anexos.splice(Number(b.dataset.rm), 1); paintAnexos(); }));
  };
  paintAnexos();
  slot.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    for (const f of Array.from(input.files || [])) {
      try { slot.querySelector('strong').textContent = 'Enviando ' + f.name + '…'; const a = await uploadFile(f); anexos.push(a); paintAnexos(); toast('Arquivo anexado.', 'success'); }
      catch (e) { toast(e.message, 'error'); }
      finally { slot.querySelector('strong').textContent = 'Anexar arquivo'; }
    }
    input.value = '';
  });

  document.getElementById('solSubmit').addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const fd = Object.fromEntries(new FormData(form).entries());
    const dados = { ...fd };
    delete dados.comentario; delete dados.solicitanteSel; delete dados.solicitanteOutro; delete dados.departamentoId;
    if (sel) dados.solicitante = sel.value === 'outro' ? (fd.solicitanteOutro || '').trim() : me.nome;
    if (sel && !dados.solicitante) { toast('Informe o nome do solicitante.', 'error'); return; }
    dados.valor = parseBRL(fd.valor);
    if (!(dados.valor > 0)) { toast('Informe um valor total maior que zero.', 'error'); return; }
    if (!String(fd.email).toLowerCase().endsWith('@' + dom)) { toast('Use somente o e-mail corporativo @' + dom + '.', 'error'); return; }
    if (tipo === 'fornecedor') {
      if (refInput && refInput.value.trim()) addRef();  // digitou e esqueceu de clicar em Adicionar
      if (!refs.length) { toast('Adicione ao menos um Nº de Referência (digite e clique em Adicionar).', 'error'); if (refInput) refInput.focus(); return; }
      dados.referencias = refs.slice();
    }
    if (tipo === 'reembolso' && !anexos.length) { toast('Anexe o recibo ou a nota fiscal do reembolso.', 'error'); return; }
    if (tipo === 'freelancer') {
      const di = new Date(dados.dataInicio + 'T00:00:00'), df = new Date(dados.dataFim + 'T00:00:00');
      if (!(df >= di)) { toast('A data de término não pode ser anterior à data de início.', 'error'); return; }
      if (Math.round((df - di) / 86400000) > 31) { toast('O período do freelancer não pode passar de 31 dias (da data de início à data de término).', 'error'); return; }
      if (dados.dataFim < todayISO() && me.perfil !== 'diretor') { toast('Pedido com data de término anterior a hoje só pode ser feito pela Diretoria.', 'error'); return; }
    }
    const payload = { tipo, departamentoId: fd.departamentoId, dados, anexos, comentario: fd.comentario || '' };
    if (tipo === 'freelancer') { payload.anexos = []; if (!editing && anexos[0]) payload.nf = { id: anexos[0].id }; }  // "Anexar NF": vira o documento fiscal do pedido
    const btn = document.getElementById('solSubmit'); btn.disabled = true;
    try {
      let r;
      try { r = editing ? await api('PUT', `/solicitacoes/${existente.id}`, payload) : await api('POST', '/solicitacoes', payload); }
      catch (e) {
        if (e.status === 409 && e.data && e.data.requerConfirmacao) {  // possível duplicidade: pede confirmação explícita
          const lista = (e.data.duplicidades || []).map(x => x.mensagem).join(' • ');
          if (!await confirmDialog({ title: 'Possível pagamento duplicado', message: lista + ' — Deseja enviar mesmo assim? A confirmação ficará registrada.', okLabel: 'Enviar mesmo assim', danger: true })) { btn.disabled = false; return; }
          payload.confirmarDuplicidade = true;
          r = editing ? await api('PUT', `/solicitacoes/${existente.id}`, payload) : await api('POST', '/solicitacoes', payload);
        } else throw e;
      }
      closeModal();
      toast(editing ? 'Solicitação reenviada para aprovação.' : `Solicitação ${r.solicitacao.numero} enviada para aprovação.`, 'success');
      await renderSolAtual();
      setTimeout(() => openSolicitacao(r.solicitacao.id), 250);
    } catch (e) {
      btn.disabled = false;
      if (e.status === 423) { closeModal(); DB.trava = e.data.trava || DB.trava; DB.travaFreelancer = e.data.travaFreelancer || DB.travaFreelancer; if (ehPaginaSolicitacoes(currentPage)) paintSolicitacoes(); }
      toast(e.message, 'error');
    }
  });
}
function ultimaAlteracao(s) { return (s.historico || []).slice().reverse().find(h => h.acao === 'alteracao_solicitada') || {}; }

/* ---------- detalhe: linha do tempo + histórico + ações ---------- */
async function openSolicitacao(id) {
  let s;
  try { s = (await api('GET', `/solicitacoes/${id}`)).solicitacao; } catch (e) { toast(e.message, 'error'); return; }
  const me = DB.user, d = s.dados, h = s.historico || [];
  const ultimo = (acao, etapa) => h.slice().reverse().find(x => x.acao === acao && (etapa === undefined || x.etapa === etapa));
  const criada = h.find(x => x.acao === 'criada'), reenv = ultimo('reenviada');
  const ap1 = ultimo('aprovada', 1), ap2 = ultimo('aprovada', 2), enc = ultimo('encerrada'), rep = ultimo('reprovada'), alt = ultimo('alteracao_solicitada');

  // linha do tempo por módulo: Freelancer = A1 > A2 > RH 1 > (Financeiro | RH 2 se recorrente); Rescisão = RH 1 > A1 > A2 > Financeiro
  const frl = s.tipo === 'freelancer', resc = s.tipo === 'rescisao';
  const apRh = ultimo('aprovada', 4);
  const fluxo = resc ? ['sol', 'rh1', 'a1', 'a2', 'fin', 'enc'] : frl ? ['sol', 'a1', 'a2', 'rh1', (d.recorrente === 'sim' && s.status !== 'financeiro' && !(enc && enc.etapa === 3)) ? 'rh2' : 'fin', 'enc'] : s.tipo === 'reembolso' ? ['sol', 'fis', 'a1', 'a2', 'fin', 'enc'] : ['sol', 'a1', 'a2', 'fin', 'enc'];
  const DEF = {
    sol: { t: 'Solicitação', ico: 'fileText', who: s.solicitanteNome },
    fis: { t: 'Aprovação Fiscal', ico: 'fileText', who: 'Financeiro' },
    a1: { t: 'Aprovação 1', ico: 'userCheck', who: userNome(s.aprovador1Id) },
    a2: { t: 'Aprovação 2', ico: 'users', who: userNome(s.aprovador2Id) },
    rh1: { t: 'RH 1', ico: 'users', who: 'Recursos Humanos' },
    rh2: { t: 'RH 2', ico: 'users', who: 'Acompanhamento do contrato' },
    fin: { t: 'Financeiro', ico: 'bank', who: 'Contas a pagar' },
    enc: { t: 'Encerrado', ico: 'flag', who: '' },
  };
  const steps = fluxo.map((k, i) => ({ k, n: i + 1, t: DEF[k].t, ico: DEF[k].ico, who: DEF[k].who, sub: '', cls: '' }));
  const pos = (k) => steps.findIndex(x => x.k === k);
  const stEtapa = (e) => steps[Math.max(0, pos({ 1: 'a1', 2: 'a2', 3: 'fin', 4: 'rh1', 5: 'rh2', 6: 'fis' }[e]))];
  const marcaAprov = (st, hh) => { st.cls = 'done'; st.sub = 'Aprovado por ' + hh.userNome + ' em ' + fmtDateTime(hh.data); };
  steps[0].cls = 'done'; steps[0].sub = reenv ? 'Reenviada em ' + fmtDateTime(reenv.data) : 'Enviada em ' + fmtDateTime(criada ? criada.data : s.criadoEm);
  if (ap1) marcaAprov(steps[pos('a1')], ap1);
  if (ap2) marcaAprov(steps[pos('a2')], ap2);
  if (apRh && pos('rh1') >= 0) marcaAprov(steps[pos('rh1')], apRh);
  const apFis = ultimo('aprovada', 6);
  if (apFis && pos('fis') >= 0) marcaAprov(steps[pos('fis')], apFis);
  const atual = { fiscal: 'fis', aprovacao1: 'a1', aprovacao2: 'a2', rh: 'rh1', rh2: 'rh2', financeiro: 'fin' }[s.status];
  const subAtual = { fis: 'Aguardando análise fiscal', a1: 'Aguardando análise', a2: 'Aguardando análise', rh1: 'Aguardando análise do RH 1', rh2: 'Em acompanhamento até o fim do contrato', fin: 'Em verificação / processamento' };
  if (atual && pos(atual) >= 0) { steps[pos(atual)].cls = 'current'; steps[pos(atual)].sub = subAtual[atual]; }
  const iEnc = pos('enc');
  if (s.status === 'alteracao' && alt) { const st = stEtapa(alt.etapa); st.cls = 'warn'; st.sub = 'Alteração solicitada por ' + alt.userNome + ' em ' + fmtDateTime(alt.data); }
  if (s.status === 'reprovada' && rep) { const st = stEtapa(rep.etapa); st.cls = 'bad'; st.sub = 'Reprovada por ' + rep.userNome + ' em ' + fmtDateTime(rep.data); steps[iEnc].cls = 'bad'; steps[iEnc].who = 'Processo encerrado'; steps[iEnc].sub = 'Solicitação reprovada'; }
  if (s.status === 'encerrada' && enc) { const st = stEtapa(enc.etapa === 5 ? 5 : 3); st.cls = 'done'; st.sub = 'Autorizado por ' + enc.userNome + ' em ' + fmtDateTime(enc.data); steps[iEnc].cls = 'done'; steps[iEnc].who = 'Processo concluído'; steps[iEnc].sub = 'Pagamento autorizado'; }

  const campo = (lab, val, full) => `<div class="${full ? 'full' : ''}"><label>${lab}</label><div class="v">${escapeHtml(val === undefined || val === null || val === '' ? '—' : val)}</div></div>`;
  const simNao = (v) => v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : '—';
  let campos = '';
  if (s.tipo === 'fornecedor') campos = campo('Título', d.titulo, true) + campo('Solicitante', d.solicitante) + campo('E-mail', s.email) + campo('Departamento', depNome(s.departamentoId)) + campo('Fornecedor', d.fornecedor) + campo('Cliente', d.cliente) + campo('Empresa', d.empresa) + campo('Nº de Referência', d.numeroOcPi) + campo('Erro interno?', simNao(d.erroInterno));
  else if (s.tipo === 'freelancer') campos = campo('Freelancer', d.nomeFreelancer, true) + campo('Solicitante', d.solicitante) + campo('E-mail', s.email) + campo('Departamento', depNome(s.departamentoId)) + campo('Empresa', d.empresa) + campo('Modalidade', ({ presencial: 'Presencial', home_office: 'Home office', hibrido: 'Híbrido' })[d.modalidade]) + campo('Recorrente?', simNao(d.recorrente)) + campo('Período', fmtDate(d.dataInicio) + ' a ' + fmtDate(d.dataFim)) + campo('Banco', d.banco) + campo('Agência', d.agencia) + campo('C/C', d.conta) + campo('CNPJ', d.cpfCnpj) + (d.rh ? campo('RH — profissional contratado?', simNao(d.rh.contratado)) + campo('Data de contratação', fmtDate(d.rh.dataContratacao)) + campo('Onboarding previsto', fmtDate(d.rh.dataOnboarding)) : '');
  else if (s.tipo === 'rescisao') campos = campo('Tipo', ({ pedido_dispensa: 'Pedido de Dispensa', dispensado: 'Dispensado' })[d.tipoRescisao], true) + campo('Solicitante', d.solicitante) + campo('E-mail', s.email) + campo('Departamento', depNome(s.departamentoId)) + campo('Empresa', d.empresa);
  else if (s.tipo === 'reembolso') campos = campo('Nome', d.nome) + campo('E-mail', s.email) + campo('Cliente', d.cliente) + campo('Reembolsado pelo cliente?', simNao(d.reembolsadoCliente)) + campo('Departamento', depNome(s.departamentoId)) + campo('Categoria da despesa', d.categoriaDespesa) + campo('Empresa', d.empresa) + campo('Dados bancários', [d.banco && 'Banco ' + d.banco, d.agencia && 'Ag. ' + d.agencia, d.conta && 'C/C ' + d.conta, d.cpfCnpj && 'CPF/CNPJ ' + d.cpfCnpj].filter(Boolean).join(' · '), true);
  else campos = campo('Título', d.titulo, true) + campo('Solicitante', d.solicitante) + campo('E-mail', s.email) + campo('Departamento', depNome(s.departamentoId)) + campo('Fornecedor', d.fornecedor) + campo('Empresa', d.empresa) + campo('Categoria', d.categoria) + campo('Erro interno?', simNao(d.erroInterno));
  campos += campo('Valor Total', fmtBRL(s.valor)) + campo(s.tipo === 'reembolso' ? 'Data' : 'Data do Pagamento', fmtDate(s.dataPagamento)) + campo(({ freelancer: 'Motivo da contratação', rescisao: 'Motivo do desligamento' })[s.tipo] || 'Descrição da despesa', d.descricao, true);

  const anexosHtml = (s.anexos || []).length ? `<div class="attach-list">${s.anexos.map(a => `<div class="attach-item">${ICONS.file}<span class="nm">${escapeHtml(a.nome)}</span><span class="sz">${humanFileSize(a.tamanho)}</span><a href="${fileUrl(a.id)}" target="_blank">Abrir</a></div>`).join('')}</div>` : '<div class="cell-dim" style="font-size:12px;">Nenhum documento anexado.</div>';

  // documento fiscal (após encerramento)
  const docLabel = { grupo: 'Nota Fiscal ou Invoice', fornecedor: 'Nota Fiscal ou Recibo Fiscal', reembolso: 'Nota Fiscal, Cupom Fiscal ou Recibo', freelancer: 'Nota Fiscal do serviço' }[s.tipo];
  let docFiscalHtml = '';
  if (s.status === 'encerrada' && s.tipo !== 'rescisao') {
    if (s.docFiscal) docFiscalHtml = `<div class="attach-item">${ICONS.checkCircle}<span class="nm">${escapeHtml(s.docFiscal.nome)}</span><span class="sz">anexado em ${fmtDateTime(s.docFiscal.anexadoEm)} por ${escapeHtml(s.docFiscal.por || '')}</span><a href="${fileUrl(s.docFiscal.id)}" target="_blank">Abrir</a></div>`;
    else {
      const venc = s.docFiscalVencido;
      const podeAnexar = souSolicitante(s) || ['admin', 'gestor', 'financeiro'].includes(me.perfil);
      docFiscalHtml = `<div class="alert-box ${venc ? '' : 'warn'}" style="margin-bottom:8px;">${icon('alert')}<div><strong>${venc ? 'Prazo vencido' : 'Pendente'}:</strong> anexe ${docLabel} até <strong>${fmtDate(s.prazoDocFiscal)}</strong>${venc ? ' — novas solicitações do solicitante estão bloqueadas até o envio.' : '.'}</div></div>
        ${podeAnexar ? `<div class="upload-slot" id="docFiscalSlot"><div class="upload-ico">${ICONS.upload}</div><div class="upload-text"><strong>Anexar ${escapeHtml(docLabel)}</strong><span>PDF, DOCX, XLSX, PNG ou JPEG · até ${DB.config.maxUploadMB || 20} MB</span></div></div><input type="file" id="docFiscalInput" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" style="display:none;"/>` : ''}`;
    }
  }

  if (s.tipo === 'freelancer' && s.docFiscal && me.perfil === 'financeiro') docFiscalHtml += `<div style="margin-top:8px;"><button class="btn btn-sm btn-danger" id="docRemover">${ICONS.trash}Remover NF anexada</button><span class="form-hint" style="margin-left:8px;">Se a contratação já terminou, o bloqueio do solicitante volta a valer.</span></div>`;

  // ações disponíveis
  const acoes = [];
  const jaAprovada = h.some(x => x.acao === 'aprovada' || x.acao === 'encerrada');
  if (souSolicitante(s)) {
    if (s.status === 'alteracao') acoes.push(`<button class="btn btn-warn" id="actEditar">${ICONS.edit}Alterar e reenviar</button>`);
  }
  if (souSolicitante(s) || me.perfil === 'admin') {
    if (ABERTAS.includes(s.status) || s.status === 'alteracao') { if (!jaAprovada) acoes.push(`<button class="btn btn-danger" id="actExcluir">${ICONS.trash}Excluir</button>`); }
  }
  if (aguardaMinhaAcao(s)) {
    if (s.status === 'rh2') acoes.push(`<button class="btn btn-warn" id="actAjustar">${ICONS.edit}AJUSTAR VALOR / TÉRMINO</button>`, `<button class="btn btn-approve" id="actEncerrarRh">${ICONS.checkCircle}ENCERRAR CONTRATO</button>`);
    else if (s.status === 'financeiro') acoes.push(`<button class="btn btn-danger" id="actReprovar">${ICONS.xCircle}REPROVAR</button>`, `<button class="btn btn-approve" id="actEncerrar">${ICONS.checkCircle}ENCERRAR (aprovar pagamento)</button>`);
    else acoes.push(`<button class="btn btn-danger" id="actReprovar">${ICONS.xCircle}REPROVAR</button>`, `<button class="btn btn-warn" id="actAlterar">${ICONS.edit}ALTERAR</button>`, `<button class="btn btn-approve" id="actAprovar">${ICONS.check}APROVAR</button>`);
  }

  const histIco = { doc_fiscal_removido: 'trash', criada: 'send', reenviada: 'send', aprovada: 'check', alteracao_solicitada: 'edit', editada: 'repeat', reprovada: 'xCircle', encerrada: 'flag', doc_fiscal_anexado: 'fileText', ajustada: 'edit' };
  const histLabel = { criada: 'Solicitação enviada', reenviada: 'Solicitação reenviada para aprovação', aprovada: 'Aprovada', alteracao_solicitada: 'Alteração solicitada', editada: 'Solicitação alterada pelo solicitante', reprovada: 'Reprovada', encerrada: 'Encerrada — pagamento autorizado', ajustada: 'Valor/término ajustado pelo RH 2', doc_fiscal_anexado: 'Documento fiscal anexado', doc_fiscal_removido: 'Documento fiscal removido pelo Financeiro' };
  const LABELS = { titulo: 'Título', solicitante: 'Solicitante', email: 'E-mail', fornecedor: 'Fornecedor', cliente: 'Cliente', numeroOcPi: 'Nº de Referência', referencias: 'Nº de Referência', descricao: 'Descrição', valor: 'Valor', dataPagamento: 'Data', erroInterno: 'Erro interno', nome: 'Nome', reembolsadoCliente: 'Reembolsado pelo cliente', categoriaDespesa: 'Categoria da despesa', empresa: 'Empresa', categoria: 'Categoria', banco: 'Banco', agencia: 'Agência', conta: 'Conta', cpfCnpj: 'CPF/CNPJ', anexos: 'Anexos' };
  const fmtV = (k, v) => k === 'valor' ? fmtBRL(v) : k === 'dataPagamento' ? fmtDate(v) : Array.isArray(v) ? v.join(', ') : (v === undefined || v === null || v === '' ? '—' : String(v));
  const histHtml = h.slice().reverse().map(x => `<div class="hist-item">${icon(histIco[x.acao] || 'info')}<div>
      <div><strong>${escapeHtml(histLabel[x.acao] || x.acao)}${x.etapa && x.acao !== 'criada' && x.acao !== 'reenviada' ? ' · ' + ({ 3: 'Financeiro', 4: 'RH 1', 5: 'RH 2', 6: 'Aprovação Fiscal' }[x.etapa] || 'etapa ' + x.etapa) : ''}</strong> — ${escapeHtml(x.userNome || '')}</div>
      <div class="when">${fmtDateTime(x.data)}</div>
      ${x.justificativa ? `<div class="just">${escapeHtml(x.justificativa)}</div>` : ''}
      ${x.acao === 'aprovada' && x.detalhes && x.detalhes.contratado ? `<div class="diff">Contratado: <b>${x.detalhes.contratado === 'sim' ? 'Sim' : 'Não'}</b>${x.detalhes.dataContratacao ? ' · contratação ' + escapeHtml(fmtDate(x.detalhes.dataContratacao)) : ''}${x.detalhes.dataOnboarding ? ' · onboarding previsto ' + escapeHtml(fmtDate(x.detalhes.dataOnboarding)) : ''}</div>` : ''}
      ${x.acao === 'aprovada' && x.detalhes && x.detalhes.recorrente ? `<div class="diff">Recorrente alterado: <b>${x.detalhes.recorrente.de === 'sim' ? 'Sim' : 'Não'}</b> → <b>${x.detalhes.recorrente.para === 'sim' ? 'Sim' : 'Não'}</b></div>` : ''}
      ${x.acao === 'ajustada' && x.detalhes ? `<div class="diff">${x.detalhes.valor ? `Valor: <b>${fmtBRL(x.detalhes.valor.de)}</b> → <b>${fmtBRL(x.detalhes.valor.para)}</b>` : ''}${x.detalhes.valor && x.detalhes.dataFim ? '<br/>' : ''}${x.detalhes.dataFim ? `Término: <b>${fmtDate(x.detalhes.dataFim.de)}</b> → <b>${fmtDate(x.detalhes.dataFim.para)}</b>` : ''}${(x.detalhes.anexos || []).length ? '<br/>Anexos: ' + escapeHtml(x.detalhes.anexos.join(', ')) : ''}</div>` : ''}
      ${x.acao === 'editada' && x.detalhes ? `<div class="diff">${Object.entries(x.detalhes).map(([k, v]) => `<b>${escapeHtml(LABELS[k] || k)}</b>: ${escapeHtml(fmtV(k, v.de))} → ${escapeHtml(fmtV(k, v.para))}`).join('<br/>') || 'Reenviada sem alterações de campos.'}</div>` : ''}
    </div></div>`).join('');

  openModal(`
    <div class="modal-head"><h3>${modalIcon('send')} ${escapeHtml(s.numero)} · ${escapeHtml(s.tipoLabel)}</h3><div style="display:flex;gap:8px;align-items:center;">${statusPill(s)}<button class="modal-close" data-close-modal>${ICONS.x}</button></div></div>
    <div class="modal-body">
      <div class="section-title-row" style="margin-top:0;"><h2 style="font-size:13px;">Status do processo de solicitação de pagamento</h2><div class="hint">Valor: <strong style="color:var(--text);">${fmtBRL(s.valor)}</strong> · Solicitada em ${fmtDateTime(s.criadoEm)}</div></div>
      <div class="timeline" style="--cols:${steps.length};">${steps.map(st => `<div class="tl-step ${st.cls}"><div class="tl-dot">${ICONS[st.ico]}</div><div class="tl-num">${st.n}.</div><div class="tl-title">${escapeHtml(st.t)}</div><div class="tl-who">${escapeHtml(st.who || '')}</div><div class="tl-sub">${escapeHtml(st.sub || '')}</div></div>`).join('')}</div>
      ${s.status === 'alteracao' && alt ? `<div class="alert-box warn" style="margin-top:14px;">${icon('alert')}<div><strong>Alteração solicitada por ${escapeHtml(alt.userNome)} (Aprovação ${alt.etapa}):</strong> ${escapeHtml(alt.justificativa || '')}${souSolicitante(s) ? '<br/><span style="color:var(--text-dim);">Use "Alterar e reenviar" para ajustar a solicitação.</span>' : ''}</div></div>` : ''}
      ${s.alertaTermino !== null && s.alertaTermino !== undefined ? `<div class="alert-box warn" style="margin-top:14px;">${icon('clock')}<div><strong>Contrato perto do fim:</strong> ${s.alertaTermino > 0 ? 'termina em ' + s.alertaTermino + ' dia(s)' : s.alertaTermino === 0 ? 'termina hoje' : 'terminou há ' + (-s.alertaTermino) + ' dia(s)'} (${fmtDate(d.dataFim)}). Ajuste o valor/término ou encerre a solicitação.</div></div>` : ''}
      ${s.status === 'reprovada' && rep ? `<div class="alert-box" style="margin-top:14px;">${icon('xCircle')}<div><strong>Reprovada por ${escapeHtml(rep.userNome)} (${rep.etapa === 3 ? 'Financeiro' : 'Aprovação ' + rep.etapa}) em ${fmtDateTime(rep.data)}:</strong> ${escapeHtml(rep.justificativa || '')}</div></div>` : ''}
      ${(s.alertas || []).length ? `<div class="alert-box warn" style="margin-top:14px;">${icon('alert')}<div><strong>Pontos de atenção para a análise</strong><ul style="margin:6px 0 0 16px;padding:0;">${s.alertas.map(a => `<li>${escapeHtml(a.mensagem)}${a.confirmadaPor ? ' <em>(envio confirmado por ' + escapeHtml(a.confirmadaPor) + ')</em>' : ''}</li>`).join('')}</ul></div></div>` : ''}
      <div class="section-title-row"><h2 style="font-size:13px;">Dados da solicitação</h2>${s.reciboArquivo ? `<a class="btn btn-sm" href="/api/solicitacoes/${s.id}/recibo" target="_blank">${ICONS.download}Recibo de Aprovação (PDF)</a>` : ''}</div>
      <div class="card" style="padding:16px 18px;"><div class="detail-grid">${campos}</div></div>
      <div class="section-title-row"><h2 style="font-size:13px;">${s.tipo === 'reembolso' ? 'Recibo / Nota Fiscal' : 'Documentos'}</h2></div>${anexosHtml}
      ${docFiscalHtml ? `<div class="section-title-row"><h2 style="font-size:13px;">Documento fiscal (após encerramento)</h2><div class="hint">${s.tipo === 'freelancer' ? 'Prazo: até o fim da contratação (' + fmtDate(s.prazoDocFiscal) + ')' : 'Prazo: ' + (DB.config.prazosDocFiscal ? DB.config.prazosDocFiscal[s.tipo] : '') + ' dia(s) corrido(s)'}</div></div>${docFiscalHtml}` : ''}
      <div class="section-title-row"><h2 style="font-size:13px;">Histórico de movimentações</h2><div class="hint">${h.length} registro(s)</div></div>
      <div class="hist-list">${histHtml}</div>
    </div>
    <div class="modal-foot"><button class="btn" data-close-modal>Fechar</button><div class="approval-bar">${acoes.join('')}</div></div>`, { size: 'lg' });

  const refresh = async () => { if (ehPaginaSolicitacoes(currentPage)) await renderSolAtual(); };
  const doAcao = async (acao, just, extra) => {
    try { await api('POST', `/solicitacoes/${s.id}/acao`, { acao, justificativa: just || '', ...(extra || {}) }); closeModal(); toast({ aprovar: 'Solicitação aprovada.', alterar: 'Solicitação devolvida ao solicitante.', ajustar: 'Valor/término ajustado e registrado no histórico.', reprovar: 'Solicitação reprovada.', encerrar: 'Solicitação encerrada — pagamento autorizado e lançado no orçamento.' }[acao], 'success'); await refresh(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const b = (id) => document.getElementById(id);
  if (b('actAprovar')) b('actAprovar').addEventListener('click', async () => { if (s.status === 'rh' && frl) { const rhd = await rhDialog(s); if (rhd) doAcao('aprovar', '', { rh: rhd }); return; } if (await confirmDialog({ title: 'Aprovar solicitação', message: `Aprovar ${s.numero} (${fmtBRL(s.valor)}) e enviar para a próxima etapa?`, okLabel: 'Aprovar', danger: false })) doAcao('aprovar'); });
  if (b('actEncerrar')) b('actEncerrar').addEventListener('click', async () => { if (await confirmDialog({ title: 'Encerrar solicitação', message: `Autorizar o pagamento de ${fmtBRL(s.valor)}? O recibo será gerado, enviado ao solicitante e o valor lançado no orçamento de ${depNome(s.departamentoId)}.`, okLabel: 'Encerrar e autorizar', danger: false })) doAcao('encerrar'); });
  if (b('actEncerrarRh')) b('actEncerrarRh').addEventListener('click', async () => { if (await confirmDialog({ title: 'Encerrar contrato', message: `Encerrar o contrato recorrente de ${d.nomeFreelancer || ''}? O valor de ${fmtBRL(s.valor)} será lançado como gasto realizado no orçamento de ${depNome(s.departamentoId)} (sem passar pelo Financeiro).`, okLabel: 'Encerrar contrato', danger: false })) doAcao('encerrar'); });
  if (b('actAjustar')) b('actAjustar').addEventListener('click', async () => { const aj = await ajusteDialog(s); if (aj) doAcao('ajustar', aj.justificativa, { valor: aj.valor, dataFim: aj.dataFim, anexos: aj.anexos }); });
  if (b('actAlterar')) b('actAlterar').addEventListener('click', async () => { const j = await justificativaDialog({ title: 'Solicitar alteração', message: 'A solicitação voltará ao solicitante para ajustes. Explique o que precisa ser alterado.', okLabel: 'Devolver para alteração' }); if (j) doAcao('alterar', j); });
  if (b('actReprovar')) b('actReprovar').addEventListener('click', async () => { const j = await justificativaDialog({ title: 'Reprovar solicitação', message: 'A reprovação encerra o processo definitivamente. Informe o motivo.', okLabel: 'Reprovar', danger: true }); if (j) doAcao('reprovar', j); });
  if (b('actEditar')) b('actEditar').addEventListener('click', () => { closeModal(); setTimeout(() => openSolicitacaoForm(s.tipo, s), 200); });
  if (b('actExcluir')) b('actExcluir').addEventListener('click', async () => { if (await confirmDialog({ title: 'Excluir solicitação', message: `Excluir ${s.numero}? Esta ação não pode ser desfeita.` })) { try { await api('DELETE', `/solicitacoes/${s.id}`); closeModal(); toast('Solicitação excluída.', 'success'); await refresh(); } catch (e) { toast(e.message, 'error'); } } });
  if (b('docRemover')) b('docRemover').addEventListener('click', async () => {
    const j = await justificativaDialog({ title: 'Remover Nota Fiscal', message: 'A NF anexada será removida (fica registrada no histórico) e o solicitante precisará anexar de novo. Informe o motivo.', okLabel: 'Remover NF', danger: true });
    if (!j) return;
    try { await api('POST', `/solicitacoes/${s.id}/doc-fiscal/remover`, { justificativa: j }); closeModal(); toast('Nota Fiscal removida.', 'success'); await refresh(); setTimeout(() => openSolicitacao(s.id), 250); } catch (e) { toast(e.message, 'error'); }
  });
  const dfSlot = b('docFiscalSlot'), dfInput = b('docFiscalInput');
  if (dfSlot) {
    dfSlot.addEventListener('click', () => dfInput.click());
    dfInput.addEventListener('change', async () => {
      const f = dfInput.files[0]; if (!f) return;
      try { dfSlot.querySelector('strong').textContent = 'Enviando…'; const a = await uploadFile(f); const r = await api('POST', `/solicitacoes/${s.id}/doc-fiscal`, { arquivo: a }); DB.trava = r.trava || DB.trava; toast('Documento fiscal anexado.', 'success'); closeModal(); await refresh(); setTimeout(() => openSolicitacao(s.id), 200); }
      catch (e) { toast(e.message, 'error'); dfSlot.querySelector('strong').textContent = 'Anexar ' + docLabel; }
    });
  }
}

/* ---------- atualização automática (sem precisar de F5) ----------
   Verifica periodicamente se alguma solicitação mudou de etapa (aprovada, reprovada,
   devolvida para alteração etc.) e, se mudou, repinta a lista silenciosamente —
   sem o "Carregando…" e sem mexer num modal que esteja aberto na hora. */
let solPollTimer = null;
let solPollInFlight = false;
function solicitacoesSnapshot() { return JSON.stringify((DB.solicitacoes || []).map(s => [s.id, s.status, s.atualizadoEm])); }
async function pollSolicitacoesIfNeeded() {
  if (!ehPaginaSolicitacoes(currentPage) || document.hidden || solPollInFlight) return;
  if (modalBackdrop().classList.contains('open')) return; // não mexe na lista enquanto um modal está aberto
  solPollInFlight = true;
  try {
    const antes = solicitacoesSnapshot(), pagina = currentPage;
    await reloadSolicitacoes();
    if (currentPage !== pagina || modalBackdrop().classList.contains('open')) return; // o usuário navegou/abriu algo nesse meio tempo
    if (solicitacoesSnapshot() !== antes) paintSolicitacoes(pagina);
  } catch (e) { /* silencioso — a próxima tentativa resolve */ }
  finally { solPollInFlight = false; }
}
function startSolicitacoesAutoRefresh() {
  if (solPollTimer) return;
  solPollTimer = setInterval(pollSolicitacoesIfNeeded, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSolicitacoesIfNeeded(); });
  window.addEventListener('focus', pollSolicitacoesIfNeeded);
}


/* ---------- etapa do RH: dados da contratação (aparece SEMPRE que o RH aprova) ---------- */
function rhDialog(s) {
  return new Promise((resolve) => {
    openModal(`<div class="modal-head"><h3>${modalIcon('users')} Aprovação do RH — ${escapeHtml(s.numero)}</h3></div>
      <div class="modal-body"><p class="form-hint" style="margin-bottom:12px;">Informe os dados da contratação de <strong>${escapeHtml(s.dados.nomeFreelancer || '')}</strong> para dar continuidade.</p>
        <form id="rhForm"><div class="form-grid">
          <div class="form-field full"><label>Recorrente? <span class="req">*</span></label><div class="radio-row">
            <label class="radio-chip"><input type="radio" name="recorrente" value="sim" ${s.dados.recorrente === 'sim' ? 'checked' : ''}/> Sim</label>
            <label class="radio-chip"><input type="radio" name="recorrente" value="nao" ${s.dados.recorrente === 'nao' ? 'checked' : ''}/> Não</label></div>
            <span class="form-hint" id="recHint"></span></div>
          <div class="form-field full"><label>Profissional contratado? <span class="req">*</span></label><div class="radio-row">
            <label class="radio-chip"><input type="radio" name="contratado" value="sim"/> Sim</label>
            <label class="radio-chip"><input type="radio" name="contratado" value="nao"/> Não</label></div></div>
          <div class="form-field"><label>Data de contratação</label><input class="input" type="date" name="dataContratacao"/></div>
          <div class="form-field"><label>Data prevista para onboarding</label><input class="input" type="date" name="dataOnboarding"/></div>
        </div><span class="form-hint">As duas datas são obrigatórias quando o profissional foi contratado.</span></form>
        <div class="alert-box" id="rhErr" style="display:none;margin-top:12px;"></div></div>
      <div class="modal-foot"><button class="btn" id="rhCancel">Cancelar</button><button class="btn btn-approve" id="rhOk">${ICONS.check}Aprovar</button></div>`, { locked: true });
    const f = document.getElementById('rhForm'), er = document.getElementById('rhErr');
    const hint = () => { const r = (f.querySelector('input[name=recorrente]:checked') || {}).value; document.getElementById('recHint').textContent = r === 'sim' ? 'Recorrente: após esta aprovação o RH 2 acompanha o contrato até o fim, sem passar pelo Financeiro.' : r === 'nao' ? 'Não recorrente: segue para o Financeiro.' : ''; };
    f.querySelectorAll('input[name=recorrente]').forEach(i => i.addEventListener('change', hint)); hint();
    document.getElementById('rhCancel').addEventListener('click', () => { closeModal(); resolve(null); });
    document.getElementById('rhOk').addEventListener('click', () => {
      const contratado = (f.querySelector('input[name=contratado]:checked') || {}).value;
      const dc = f.dataContratacao.value, dob = f.dataOnboarding.value;
      const recorrente = (f.querySelector('input[name=recorrente]:checked') || {}).value;
      const erro = !recorrente ? 'Informe se a contratação é recorrente.' : !contratado ? 'Informe se o profissional foi contratado.' : contratado === 'sim' && !dc ? 'Informe a data de contratação.' : contratado === 'sim' && !dob ? 'Informe a data prevista para o onboarding.' : contratado === 'sim' && dob < dc ? 'O onboarding não pode ser anterior à data de contratação.' : '';
      if (erro) { er.textContent = erro; er.style.display = 'block'; return; }
      closeModal(); resolve({ recorrente, contratado, dataContratacao: dc || null, dataOnboarding: dob || null });
    });
  });
}


/* ---------- RH 2: ajustar valor e/ou término do contrato recorrente (motivo e anexo obrigatórios) ---------- */
function ajusteDialog(s) {
  return new Promise((resolve) => {
    let anexos = [];
    openModal(`<div class="modal-head"><h3>${modalIcon('edit')} Ajustar contrato — ${escapeHtml(s.numero)}</h3></div>
      <div class="modal-body"><p class="form-hint" style="margin-bottom:12px;">Contrato recorrente de <strong>${escapeHtml(s.dados.nomeFreelancer || '')}</strong>. Altere o valor e/ou a data de término. O motivo e ao menos um anexo são obrigatórios e ficam no histórico.</p>
        <form id="ajForm"><div class="form-grid">
          <div class="form-field"><label>Valor total <span class="req">*</span></label><div class="money-wrap"><input class="input" id="ajValor" inputmode="decimal" value="${maskBRL(s.valor)}"/></div></div>
          <div class="form-field"><label>Data de término <span class="req">*</span></label><input class="input" type="date" id="ajFim" value="${escapeHtml(s.dados.dataFim || '')}"/></div>
          <div class="form-field full"><label>Motivo da alteração <span class="req">*</span></label><textarea id="ajMotivo" rows="3" placeholder="Explique por que o valor ou a data de término mudou"></textarea></div>
          <div class="form-field full"><label>Anexos <span class="req">*</span></label>
            <div class="upload-slot" id="ajSlot"><div class="upload-ico">${ICONS.upload}</div><div class="upload-text"><strong>Anexar arquivo</strong><span>PDF, DOCX, XLSX, PNG ou JPEG · até ${DB.config.maxUploadMB || 20} MB</span></div></div>
            <input type="file" id="ajInput" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" multiple style="display:none;"/><div class="attach-list" id="ajList"></div></div>
        </div></form>
        <div class="alert-box" id="ajErr" style="display:none;margin-top:12px;"></div></div>
      <div class="modal-foot"><button class="btn" id="ajCancel">Cancelar</button><button class="btn btn-approve" id="ajOk">${ICONS.check}Salvar ajuste</button></div>`, { locked: true });
    attachMoneyMask(document.getElementById('ajValor'));
    const er = document.getElementById('ajErr'), list = document.getElementById('ajList'), slot = document.getElementById('ajSlot'), input = document.getElementById('ajInput');
    const paint = () => { list.innerHTML = anexos.map((a, i) => `<div class="attach-item">${ICONS.file}<span class="nm">${escapeHtml(a.nome)}</span><span class="sz">${humanFileSize(a.tamanho)}</span><button type="button" class="icon-btn danger" data-rm="${i}" title="Remover">${ICONS.x}</button></div>`).join(''); list.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { anexos.splice(Number(b.dataset.rm), 1); paint(); })); };
    slot.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      for (const f of Array.from(input.files || [])) { try { slot.querySelector('strong').textContent = 'Enviando ' + f.name + '…'; anexos.push(await uploadFile(f)); paint(); } catch (e) { toast(e.message, 'error'); } finally { slot.querySelector('strong').textContent = 'Anexar arquivo'; } }
      input.value = '';
    });
    document.getElementById('ajCancel').addEventListener('click', () => { closeModal(); resolve(null); });
    document.getElementById('ajOk').addEventListener('click', () => {
      const valor = parseBRL(document.getElementById('ajValor').value), dataFim = document.getElementById('ajFim').value, justificativa = document.getElementById('ajMotivo').value.trim();
      const erro = !(valor > 0) ? 'Informe um valor maior que zero.' : !dataFim ? 'Informe a data de término.' : dataFim < (s.dados.dataInicio || '') ? 'A data de término não pode ser anterior à data de início.'
        : (valor === s.valor && dataFim === s.dados.dataFim) ? 'Altere o valor e/ou a data de término.' : justificativa.length < 5 ? 'Informe o motivo da alteração.' : !anexos.length ? 'Inclua ao menos um anexo.' : '';
      if (erro) { er.textContent = erro; er.style.display = 'block'; return; }
      closeModal(); resolve({ valor, dataFim, justificativa, anexos });
    });
  });
}
