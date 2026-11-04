/* ===================== NexarPay — Dashboards: departamento (Gestor/Admin) e Gerencial (Diretoria/Financeiro/Admin) ===================== */

const dashState = { period: 'all', ano: null, dep: null };
const gerState = { period: 'all', ano: null, dep: '' };
let chartRefs = {};
function destroyChart(key) { if (chartRefs[key]) { chartRefs[key].destroy(); delete chartRefs[key]; } }
function destroyAllCharts() { Object.keys(chartRefs).forEach(destroyChart); }

/* ---------- cálculos ---------- */
function getBudget(ano, depId) { return DB.budgets.find(b => b.ano === ano && b.departamentoId === depId); }
function budgetYears() { return Array.from(new Set(DB.budgets.map(b => b.ano))).sort((a, b) => b - a); }
function availableYears() { const ys = new Set(DB.launches.map(l => l.ano).filter(y => y && y > 0)); budgetYears().forEach(y => ys.add(y)); if (!ys.size) ys.add(new Date().getFullYear()); return Array.from(ys).sort((a, b) => b - a); }
function approvedTotalForCategory(cat) { let t = 0; (cat.linhas || []).forEach(l => (l.cenarios || []).forEach(c => { if (c.aprovado) t += Number(c.valor) || 0; })); return t; }
function approvedRateioForCategory(cat, rateio) { const total = approvedTotalForCategory(cat); rateio = rateio || {}; const out = {}; COMPANY_KEYS.forEach(k => out[k] = total * (rateio[k] || 0)); return out; }
function totalBudgetApproved(b) { return b ? b.categorias.reduce((s, c) => s + approvedTotalForCategory(c), 0) : 0; }
function budgetCategoryForLaunch(categoria, b) { if (!b) return null; const cat = b.categorias.find(c => (c.categoriasLancamento || []).includes(categoria)); return cat ? cat.id : null; }
function statusForPct(pct) { if (pct <= 75) return { cls: 'pill-good', color: '--good', label: 'Sob controle' }; if (pct <= 100) return { cls: 'pill-warn', color: '--warning', label: 'Atenção' }; return { cls: 'pill-crit', color: '--critical', label: 'Estourado' }; }
// Divide o gasto de um lançamento entre as empresas: "Grupo" pelo rateio do orçamento (departamento + ano); empresa específica, 100% nela.
function alocarLancamento(l) {
  const v = Number(l.custoTotal) || 0;
  if (l.empresaId === GRUPO_ID) {
    const b = DB.budgets.find(x => x.ano === l.ano && x.departamentoId === l.departamentoId);
    const r = b ? (b.rateio || {}) : {};
    const soma = COMPANY_KEYS.reduce((t, k) => t + (Number(r[k]) || 0), 0);
    if (!(soma > 0)) return [{ key: SEM_RATEIO, valor: v }];  // ano sem rateio cadastrado: não divide
    return COMPANY_KEYS.map(k => ({ key: k, valor: v * (Number(r[k]) || 0) / soma })).filter(a => a.valor);
  }
  return [{ key: l.empresaId || 'SEM_EMPRESA', valor: v }];
}
function gastoPorEmpresa(list) { const m = {}; list.forEach(l => alocarLancamento(l).forEach(a => { m[a.key] = (m[a.key] || 0) + a.valor; })); return m; }
// Recorte de período DENTRO do ano fiscal (janela termina hoje ou em 31/12 de anos passados)
function launchesInPeriod(period, ano, depIds) {
  let list = DB.launches.filter(l => (!ano || l.ano === ano) && (!depIds || depIds.includes(l.departamentoId)));
  if (period === 'all') return list;
  const now = new Date();
  const ref = (ano && ano < now.getFullYear()) ? new Date(ano, 11, 31) : now;
  const months = period === '6m' ? 6 : 12;
  const cutoff = new Date(ref.getFullYear(), ref.getMonth() - months, ref.getDate());
  return list.filter(l => l.dataCompra && new Date(l.dataCompra + 'T00:00:00') >= cutoff);
}
const somaCusto = (arr) => arr.reduce((s, l) => s + (Number(l.custoTotal) || 0), 0);
function periodLabel(p) { return p === '6m' ? 'Últimos 6 meses' : p === '12m' ? 'Últimos 12 meses' : 'Ano fiscal inteiro'; }
function monthLabel(ym) { const [y, m] = ym.split('-'); return ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'][Number(m) - 1] + '/' + y.slice(2); }
function trendFor(list) { const by = {}; list.forEach(l => { if (!l.dataCompra) return; const k = l.dataCompra.slice(0, 7); by[k] = (by[k] || 0) + (Number(l.custoTotal) || 0); }); const keys = Object.keys(by).sort(); return { labels: keys.map(monthLabel), values: keys.map(k => by[k]) }; }
function topFornecedores(list, n = 6) { const m = {}; list.forEach(l => { m[l.fornecedor || '—'] = (m[l.fornecedor || '—'] || 0) + (Number(l.custoTotal) || 0); }); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n); }
function periodFilterHtml(state, onChange) {
  return `<div class="period-filter">${[['6m', '6 meses'], ['12m', '12 meses'], ['all', 'Ano inteiro']].map(([k, l]) => `<button data-p="${k}" class="${state.period === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
}
function wirePeriodFilter(container, state, rerender) {
  container.querySelectorAll('.period-filter button').forEach(b => b.addEventListener('click', () => { state.period = b.dataset.p; rerender(); }));
}
// linhas por categoria orçamentária de um departamento/ano
function catRowsFor(b, ano, depId) {
  if (!b) return [];
  return b.categorias.map(c => {
    const orcado = approvedTotalForCategory(c);
    const gasto = somaCusto(DB.launches.filter(l => l.ano === ano && l.departamentoId === depId && budgetCategoryForLaunch(l.categoria, b) === c.id));
    return { id: c.id, nome: c.nome, orcado, gasto, saldo: orcado - gasto, pct: orcado ? gasto / orcado * 100 : (gasto > 0 ? 999 : 0) };
  });
}
function solicitacoesAbertasValor(depId, ano) { return DB.solicitacoes.filter(s => ['aprovacao1', 'aprovacao2', 'rh', 'rh2', 'financeiro', 'alteracao'].includes(s.status) && (!depId || s.departamentoId === depId) && (!ano || (s.dataPagamento || s.criadoEm || '').slice(0, 4) == ano)).reduce((t, s) => t + (Number(s.valor) || 0), 0); }

// Consolidado de todos os departamentos num ano/período — usado pelo Dashboard Gerencial e pelo Dashboard (TV).
function computeConsolidado(deps, ano, period) {
  const rows = deps.map(d => {
    const b = getBudget(ano, d.id);
    const orcado = totalBudgetApproved(b);
    const gasto = somaCusto(DB.launches.filter(l => l.ano === ano && l.departamentoId === d.id));
    const emAprov = solicitacoesAbertasValor(d.id, ano);
    return { id: d.id, nome: d.nome, orcado, gasto, emAprov, saldo: orcado - gasto, pct: orcado ? gasto / orcado * 100 : (gasto > 0 ? 999 : 0), temOrc: !!b };
  });
  const orcadoTotal = rows.reduce((s, r) => s + r.orcado, 0);
  const gastoTotal = rows.reduce((s, r) => s + r.gasto, 0);
  const emAprovTotal = rows.reduce((s, r) => s + r.emAprov, 0);
  const saldo = orcadoTotal - gastoTotal;
  const pct = orcadoTotal ? gastoTotal / orcadoTotal * 100 : 0;
  const st = statusForPct(pct);
  const listPeriodo = launchesInPeriod(period, ano);
  const gastoPeriodo = somaCusto(listPeriodo);
  // categorias (nome) agregadas em todos os departamentos
  const catAgg = {};
  DB.launches.filter(l => l.ano === ano).forEach(l => { catAgg[l.categoria || '—'] = (catAgg[l.categoria || '—'] || 0) + (Number(l.custoTotal) || 0); });
  const topCats = Object.entries(catAgg).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const sols = DB.solicitacoes.filter(s => (s.criadoEm || '').slice(0, 4) == ano);
  const cnt = (f) => sols.filter(f).length;
  const maior = rows.slice().sort((a, b) => b.gasto - a.gasto)[0];
  const maisConsumido = rows.filter(r => r.orcado > 0).sort((a, b) => b.pct - a.pct)[0];
  const meses = new Set(DB.launches.filter(l => l.ano === ano && l.dataCompra).map(l => l.dataCompra.slice(0, 7))).size || 1;
  const mediaMensal = gastoTotal / meses;
  const mesesRestantes = ano === new Date().getFullYear() ? 12 - new Date().getMonth() : (ano > new Date().getFullYear() ? 12 : 0);
  const projecao = gastoTotal + mediaMensal * mesesRestantes;
  return { rows, orcadoTotal, gastoTotal, emAprovTotal, saldo, pct, st, listPeriodo, gastoPeriodo, catAgg, topCats, sols, cnt, maior, maisConsumido, mediaMensal, mesesRestantes, projecao };
}

/* ---------- DASHBOARD DO DEPARTAMENTO ---------- */
async function renderDashboard() {
  const el = document.getElementById('page-dashboard');
  const deps = depsVisiveis();
  if (!deps.length) { el.innerHTML = emptyState('building', 'Nenhum departamento atribuído', 'Peça ao Administrador para vincular seu usuário a um departamento.'); return; }
  if (!dashState.dep || !deps.find(d => d.id === dashState.dep)) dashState.dep = deps[0].id;
  if (!dashState.ano) dashState.ano = availableYears()[0];
  try { if (!DB.solicitacoes.length) await reloadSolicitacoes(); } catch (e) { }
  if (currentPage !== 'dashboard') return; // usuário já trocou de página
  const ano = dashState.ano, period = dashState.period, depId = dashState.dep;
  const b = getBudget(ano, depId);

  document.getElementById('topbarRight').innerHTML = periodFilterHtml(dashState);
  wirePeriodFilter(document.getElementById('topbarRight'), dashState, renderDashboard);

  el.innerHTML = `
    <div class="section-title-row anim-in" style="margin-top:0;">
      <h2>${icon('building')} <select id="dashDep" class="input" style="padding:6px 10px; font-size:13px; font-weight:700;">${selectOptions(deps, depId)}</select></h2>
      <div class="hint">Ano de referência <select id="dashAno" class="input" style="margin-left:8px; padding:5px 10px; font-size:12px;">${availableYears().map(y => `<option value="${y}" ${y === ano ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
    </div>
    ${deptDashboardBody(depId, ano, period, b, 'dash')}
    ${perfil() === 'rh' ? freelancerDashHtml(ano) : ''}`;
  document.getElementById('dashDep').addEventListener('change', e => { dashState.dep = e.target.value; renderDashboard(); });
  document.getElementById('dashAno').addEventListener('change', e => { dashState.ano = Number(e.target.value); renderDashboard(); });
  paintDeptCharts(depId, ano, period, b, 'dash', el);
  el.querySelectorAll('[data-open-sol]').forEach(tr => tr.addEventListener('click', () => openSolicitacao(Number(tr.dataset.openSol))));
}

/* Bloco do perfil RH: visão dos Freelancers de todos os departamentos (o restante do dashboard é só do departamento do RH). */
function freelancerDashHtml(ano) {
  const fl = DB.solicitacoes.filter(s => s.tipo === 'freelancer' && String(s.dataPagamento || s.criadoEm || '').slice(0, 4) == ano);
  const hoje = todayISO();
  const soma = (a) => a.reduce((t, s) => t + (Number(s.valor) || 0), 0);
  const abertas = fl.filter(s => ['aprovacao1', 'aprovacao2', 'rh', 'rh2', 'financeiro', 'alteracao'].includes(s.status));
  const enc = fl.filter(s => s.status === 'encerrada');
  const aguardoRh = fl.filter(s => s.status === 'rh');
  const semNf = enc.filter(s => !s.docFiscal);
  const vencidas = semNf.filter(s => s.docFiscalVencido);
  const contratados = fl.filter(s => s.dados && s.dados.rh && s.dados.rh.contratado === 'sim');
  const onboardings = contratados.filter(s => (s.dados.rh.dataOnboarding || '') >= hoje).sort((a, b) => a.dados.rh.dataOnboarding.localeCompare(b.dados.rh.dataOnboarding)).slice(0, 5);
  return `
    <div class="section-title-row" style="margin-top:28px;"><h2>${icon('users')} Freelancers — todos os departamentos · ${ano}</h2><div class="hint">${fl.length} pedido(s) no ano</div></div>
    <div class="grid grid-4 anim-in">
      ${kpiCard({ label: 'Aguardando o RH', value: aguardoRh.length, icoBg: '--c4', ico: 'userCheck', sub: `${fmtBRL(soma(aguardoRh))} para sua análise`, compact: true })}
      ${kpiCard({ label: 'Em aprovação', value: abertas.length, icoBg: '--c1', ico: 'clock', sub: `${fmtBRL(soma(abertas))} em andamento`, compact: true })}
      ${kpiCard({ label: 'Encerrados (pagos)', value: enc.length, icoBg: '--good', ico: 'checkCircle', sub: `${fmtBRL(soma(enc))} lançados`, compact: true })}
      ${kpiCard({ label: 'Sem Nota Fiscal', value: semNf.length, icoBg: vencidas.length ? '--critical' : '--serious', ico: 'fileText', sub: vencidas.length ? `${vencidas.length} com prazo vencido (solicitante bloqueado)` : 'dentro do prazo', compact: true })}
    </div>
    <div class="grid grid-2 anim-in">
      <div class="card" style="padding:14px 16px;"><h3 style="font-size:13px;margin-bottom:8px;">Profissionais contratados</h3><div class="kpi-value" style="font-size:22px;">${contratados.length}</div><div class="hint">${fl.filter(s => s.dados && s.dados.rh && s.dados.rh.contratado === 'nao').length} aprovado(s) sem contratação</div></div>
      <div class="card" style="padding:14px 16px;"><h3 style="font-size:13px;margin-bottom:8px;">Próximos onboardings</h3>${onboardings.length ? onboardings.map(s => `<div style="font-size:12.5px;padding:3px 0;">${fmtDate(s.dados.rh.dataOnboarding)} · <strong>${escapeHtml(s.dados.nomeFreelancer || '')}</strong> <span class="cell-dim">(${escapeHtml(depNome(s.departamentoId))})</span></div>`).join('') : '<div class="cell-dim" style="font-size:12.5px;">Nenhum onboarding agendado.</div>'}</div>
    </div>
    <div class="card table-card anim-in"><div class="table-scroll">${fl.length ? tabelaSolicitacoes(fl.slice(0, 12)) : `<div class="empty-state" style="padding:26px;">${ICONS.inbox}<p>Nenhum pedido de Freelancer neste ano.</p></div>`}</div></div>`;
}

function deptDashboardBody(depId, ano, period, b, pfx) {
  const catRows = catRowsFor(b, ano, depId);
  const orcadoTotal = totalBudgetApproved(b);
  const gastoAno = somaCusto(DB.launches.filter(l => l.ano === ano && l.departamentoId === depId));
  const saldo = orcadoTotal - gastoAno;
  const pct = orcadoTotal ? gastoAno / orcadoTotal * 100 : 0;
  const st = statusForPct(pct);
  const gastoPeriodo = somaCusto(launchesInPeriod(period, ano, [depId]));
  const emAprov = solicitacoesAbertasValor(depId, ano);
  const mostConsumed = catRows.filter(c => c.orcado > 0).sort((a, b2) => b2.pct - a.pct)[0];
  if (!b) return `<div class="card empty-state anim-in">${ICONS.wallet}<h4>Sem orçamento cadastrado para ${escapeHtml(depNome(depId))} em ${ano}</h4><p>${isAdmin() ? 'Crie o orçamento na página Orçamento.' : 'Peça ao Administrador para cadastrar o orçamento deste departamento.'}</p></div>
    <div class="section-title-row"><h2>Gastos lançados em ${ano}</h2><div class="hint">${fmtBRL(gastoAno)}</div></div>`;
  return `
    <div class="grid grid-4 anim-in">
      ${kpiCard({ label: 'Orçamento Aprovado', value: fmtBRL(orcadoTotal), icoBg: '--c1', ico: 'wallet', sub: `${escapeHtml(depNome(depId))} · ano fiscal ${ano}`, barPct: 100, barColor: '--c1' })}
      ${kpiCard({ label: 'Gasto Realizado', value: fmtBRL(gastoAno), icoBg: '--c2', ico: 'trend-up', sub: `${fmtPct(pct)} do orçamento`, barPct: clamp(pct, 0, 100), barColor: st.color })}
      ${kpiCard({ label: 'Saldo Disponível', value: fmtBRL(Math.max(saldo, 0)), icoBg: saldo >= 0 ? '--good' : '--critical', ico: 'scale', sub: saldo >= 0 ? (emAprov ? `${fmtBRL(emAprov)} em solicitações em aprovação` : 'dentro do orçamento') : `estouro de ${fmtBRL(Math.abs(saldo))}`, barPct: clamp(100 - pct, 0, 100), barColor: saldo >= 0 ? '--good' : '--critical' })}
      <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Consumo do Orçamento</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar(st.color)} 18%, transparent); color:${cssVar(st.color)};">${ICONS.spark}</div></div>
        <div class="kpi-value">${fmtPct(pct)}</div><div class="kpi-sub"><span class="pill ${st.cls}">${st.label}</span></div><div class="kpi-sub" style="margin-top:2px;">${fmtBRL(gastoPeriodo)} gastos · ${periodLabel(period).toLowerCase()} de ${ano}</div></div>
    </div>
    <div class="section-title-row"><h2>Orçamento × Gasto por Categoria</h2><div class="hint">${catRows.length} categorias · dólar ref. R$ ${(b.dolar || 0).toFixed(2)}</div></div>
    <div class="grid grid-2 anim-in"><div class="card chart-card hoverable" style="grid-column:1/-1">
      <div class="chart-head"><div><h3>Orçado vs. Realizado por categoria</h3></div><div class="legend-row"><div class="legend-item"><span class="legend-dot" style="background:${cssVar('--c1')}"></span>Orçamento</div><div class="legend-item"><span class="legend-dot" style="background:${cssVar('--c2')}"></span>Gasto</div></div></div>
      <div class="chart-wrap" style="height:300px;"><canvas id="${pfx}CatBar"></canvas></div>
      <div class="chart-insight">${ICONS.spark}<span>${mostConsumed && mostConsumed.gasto > 0 ? `<strong>${escapeHtml(mostConsumed.nome)}</strong> é a categoria com maior consumo relativo do orçamento (${fmtPct(mostConsumed.pct)}).` : 'Ainda não há gastos lançados para o ano selecionado.'}</span></div>
    </div></div>
    <div class="grid grid-2 anim-in">
      <div class="card chart-card hoverable"><div class="chart-head"><h3>Orçamento × Gasto por empresa (rateio)</h3></div><div class="chart-wrap" style="height:260px;"><canvas id="${pfx}EmpresaBar"></canvas></div></div>
      <div class="card chart-card hoverable"><div class="chart-head"><h3>Participação do gasto por categoria</h3></div><div class="chart-wrap" style="height:260px;"><canvas id="${pfx}CatDonut"></canvas></div></div>
    </div>
    <div class="section-title-row"><h2>Tendência de gastos</h2><div class="hint">Ano fiscal ${ano} · ${periodLabel(period)}</div></div>
    <div class="grid grid-2 anim-in"><div class="card chart-card hoverable" style="grid-column:1/-1;"><div class="chart-head"><h3>Evolução mensal do gasto</h3></div><div class="chart-wrap" style="height:240px;"><canvas id="${pfx}Trend"></canvas></div></div></div>
    <div class="section-title-row"><h2>Resumo por categoria orçamentária</h2><div class="hint">${catRows.length} categorias monitoradas</div></div>
    <div class="card table-card anim-in"><div class="table-scroll"><table class="data-table">
      <thead><tr><th>Categoria</th><th>Orçado</th><th>Gasto</th><th>Saldo</th><th>Consumo</th><th>Status</th></tr></thead>
      <tbody>${catRows.map(c => { const s = statusForPct(c.pct); return `<tr><td class="cell-strong">${escapeHtml(c.nome)}</td><td class="cell-num">${fmtBRL(c.orcado)}</td><td class="cell-num">${fmtBRL(c.gasto)}</td><td class="cell-num" style="color:${c.saldo < 0 ? cssVar('--critical') : 'inherit'}">${fmtBRL(c.saldo)}</td><td style="min-width:140px;"><div class="kpi-bar" style="margin-top:0;"><div style="width:${clamp(c.pct, 0, 100)}%; background:${cssVar(s.color)}"></div></div><span class="cell-dim" style="font-size:11px;">${fmtPct(c.pct)}</span></td><td><span class="pill ${s.cls}">${s.label}</span></td></tr>`; }).join('')}</tbody></table></div></div>
    <div class="section-title-row"><h2>Maiores fornecedores</h2><div class="hint">Top 6 · ${escapeHtml(depNome(depId))} · ${periodLabel(period).toLowerCase()}</div></div>
    <div class="grid grid-2 anim-in"><div class="card chart-card hoverable" style="grid-column:1/-1;"><div class="chart-wrap" style="height:${Math.max(220, topFornecedores(launchesInPeriod(period, ano, [depId])).length * 40)}px;"><canvas id="${pfx}Fornecedores"></canvas></div></div></div>
    <div class="footer-note">Dashboard gerado em ${new Date().toLocaleDateString('pt-BR')} · NexarPay — Grupo Gpac</div>`;
}
function paintDeptCharts(depId, ano, period, b, pfx, root) {
  if (!b) return;
  const catRows = catRowsFor(b, ano, depId);
  const gastoEmp = gastoPorEmpresa(DB.launches.filter(l => l.ano === ano && l.departamentoId === depId));
  const empresaRows = COMPANY_KEYS.map(k => ({ key: k, label: COMPANY_LABELS[k], orcado: b.categorias.reduce((s, c) => s + approvedRateioForCategory(c, b.rateio)[k], 0), gasto: gastoEmp[k] || 0 }));
  Object.keys(gastoEmp).filter(k => !COMPANY_KEYS.includes(k) && gastoEmp[k] > 0.005).forEach(k => empresaRows.push({ key: k, label: k === SEM_RATEIO ? `${DB.grupoNome || 'Grupo'} (sem rateio)` : k === 'SEM_EMPRESA' ? 'Sem empresa' : empresaNome(k), orcado: 0, gasto: gastoEmp[k] }));
  const list = launchesInPeriod(period, ano, [depId]);
  try {
    if (typeof Chart === 'undefined') throw new Error('Chart.js indisponível');
    chartDefaults();
    buildBarChart(pfx + 'CatBar', catRows.map(c => c.nome), [{ label: 'Orçamento', data: catRows.map(c => c.orcado), color: '--c1' }, { label: 'Gasto', data: catRows.map(c => c.gasto), color: '--c2' }]);
    buildBarChart(pfx + 'EmpresaBar', empresaRows.map(r => r.label), [{ label: 'Orçamento', data: empresaRows.map(r => r.orcado), color: '--c1' }, { label: 'Gasto', data: empresaRows.map(r => r.gasto), color: '--c2' }], true);
    buildDonutChart(pfx + 'CatDonut', catRows.filter(c => c.gasto > 0).map(c => [c.nome, c.gasto]), 'Sem gastos registrados para o ano selecionado.');
    buildTrendChart(pfx + 'Trend', trendFor(list));
    buildHBarChart(pfx + 'Fornecedores', topFornecedores(list), 'Sem lançamentos no período selecionado.');
  } catch (err) {
    console.error('Falha ao renderizar gráficos:', err);
    root.querySelectorAll('.chart-wrap').forEach(w => { w.innerHTML = emptyChartState('Não foi possível carregar os gráficos neste navegador.'); });
  }
}

/* ---------- DASHBOARD GERENCIAL (diretoria) ---------- */
async function renderGerencial() {
  const el = document.getElementById('page-gerencial');
  if (!gerState.ano) gerState.ano = availableYears()[0];
  try { await reloadSolicitacoes(); } catch (e) { }
  if (currentPage !== 'gerencial') return; // usuário já trocou de página
  const ano = gerState.ano, period = gerState.period;
  const deps = DB.departamentos.filter(d => d.ativo);
  document.getElementById('topbarRight').innerHTML = periodFilterHtml(gerState);
  wirePeriodFilter(document.getElementById('topbarRight'), gerState, renderGerencial);

  const header = `<div class="section-title-row anim-in" style="margin-top:0;">
      <h2>${icon('pie')} Visão da Diretoria</h2>
      <div class="hint" style="display:flex; gap:8px; align-items:center;">Departamento <select id="gerDep" class="input" style="padding:5px 10px; font-size:12px;"><option value="">Todos os departamentos</option>${selectOptions(deps, gerState.dep)}</select>
        Ano <select id="gerAno" class="input" style="padding:5px 10px; font-size:12px;">${availableYears().map(y => `<option value="${y}" ${y === ano ? 'selected' : ''}>${y}</option>`).join('')}</select></div></div>`;

  if (gerState.dep) {
    const b = getBudget(ano, gerState.dep);
    el.innerHTML = header + deptDashboardBody(gerState.dep, ano, period, b, 'ger');
    wireGer(el);
    paintDeptCharts(gerState.dep, ano, period, b, 'ger', el);
    return;
  }

  // consolidado
  const c = computeConsolidado(deps, ano, period);
  const { rows, orcadoTotal, gastoTotal, emAprovTotal, saldo, pct, st, listPeriodo, gastoPeriodo, topCats, sols, cnt, maior, maisConsumido, mediaMensal, mesesRestantes, projecao } = c;

  el.innerHTML = header + `
    <div class="grid grid-4 anim-in">
      ${kpiCard({ label: 'Orçamento Anual Total Aprovado', value: fmtBRL(orcadoTotal), icoBg: '--c1', ico: 'wallet', sub: `${rows.filter(r => r.temOrc).length} de ${rows.length} departamentos com orçamento em ${ano}`, barPct: 100, barColor: '--c1' })}
      ${kpiCard({ label: 'Gasto até o momento', value: fmtBRL(gastoTotal), icoBg: '--c2', ico: 'trend-up', sub: `${fmtPct(pct)} do orçamento consumido`, barPct: clamp(pct, 0, 100), barColor: st.color })}
      ${kpiCard({ label: 'Saldo Disponível', value: fmtBRL(Math.max(saldo, 0)), icoBg: saldo >= 0 ? '--good' : '--critical', ico: 'scale', sub: saldo >= 0 ? `${fmtBRL(emAprovTotal)} comprometidos em solicitações abertas` : `estouro de ${fmtBRL(Math.abs(saldo))}`, barPct: clamp(100 - pct, 0, 100), barColor: saldo >= 0 ? '--good' : '--critical' })}
      <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Consumo Consolidado</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar(st.color)} 18%, transparent); color:${cssVar(st.color)};">${ICONS.spark}</div></div>
        <div class="kpi-value">${fmtPct(pct)}</div><div class="kpi-sub"><span class="pill ${st.cls}">${st.label}</span></div><div class="kpi-sub" style="margin-top:2px;">${fmtBRL(gastoPeriodo)} gastos · ${periodLabel(period).toLowerCase()} de ${ano}</div></div>
    </div>

    <div class="section-title-row"><h2>Análise gerencial</h2><div class="hint">Leitura executiva do ano fiscal ${ano}</div></div>
    <div class="grid grid-3 anim-in">
      <div class="card kpi compact hoverable"><div class="kpi-top"><span class="kpi-label">Projeção de fechamento</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c7')} 18%, transparent); color:${cssVar('--c7')};">${ICONS['trend-up']}</div></div>
        <div class="kpi-value">${fmtBRL(projecao)}</div><div class="kpi-sub">média de ${fmtBRL(mediaMensal)}/mês × ${mesesRestantes} mês(es) restante(s) → ${orcadoTotal ? fmtPct(projecao / orcadoTotal * 100) : '—'} do orçamento</div></div>
      <div class="card kpi compact hoverable"><div class="kpi-top"><span class="kpi-label">Solicitações de pagamento em ${ano}</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c1')} 18%, transparent); color:${cssVar('--c1')};">${ICONS.send}</div></div>
        <div class="kpi-value">${sols.length}</div><div class="kpi-sub"><span class="st st-aprovacao1">${cnt(s => ['aprovacao1', 'aprovacao2', 'rh', 'rh2', 'financeiro'].includes(s.status))} em aprovação</span> <span class="st st-alteracao">${cnt(s => s.status === 'alteracao')} pendentes</span> <span class="st st-encerrada">${cnt(s => s.status === 'encerrada')} encerradas</span> <span class="st st-reprovada">${cnt(s => s.status === 'reprovada')} reprovadas</span></div></div>
      <div class="card kpi compact hoverable"><div class="kpi-top"><span class="kpi-label">Destaques</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c4')} 18%, transparent); color:${cssVar('--c4')};">${ICONS.spark}</div></div>
        <div class="kpi-sub" style="line-height:1.6;">${maior ? `<strong>${escapeHtml(maior.nome)}</strong> concentra o maior gasto (${fmtBRL(maior.gasto)}).<br/>` : ''}${maisConsumido ? `<strong>${escapeHtml(maisConsumido.nome)}</strong> é o departamento com maior consumo relativo (${fmtPct(maisConsumido.pct)}).<br/>` : ''}${cnt(s => s.atrasada) ? `<span style="color:${cssVar('--serious')}">${cnt(s => s.atrasada)} solicitação(ões) com pagamento atrasado.</span>` : 'Nenhuma solicitação atrasada.'}</div></div>
    </div>

    <div class="section-title-row"><h2>Orçamento × Gasto por departamento</h2><div class="hint">Clique em um departamento para detalhar</div></div>
    <div class="grid grid-3 anim-in">${rows.map(r => { const s = statusForPct(r.pct); return `<div class="card dept-card hoverable" style="cursor:pointer;" data-dep="${r.id}">
        <h4>${escapeHtml(r.nome)} <span class="pill ${r.temOrc ? s.cls : ''}" style="${r.temOrc ? '' : 'color:var(--text-faint);'}">${r.temOrc ? s.label : 'sem orçamento'}</span></h4>
        <div class="progress"><div style="width:${clamp(r.pct, 0, 100)}%; background:${cssVar(s.color)}"></div></div>
        <div class="nums"><span>Orçado <strong>${fmtBRL(r.orcado)}</strong></span><span>Gasto <strong>${fmtBRL(r.gasto)}</strong></span><span>${fmtPct(r.pct)}</span></div>
        ${r.emAprov ? `<div class="nums"><span class="cell-dim">Em aprovação: ${fmtBRL(r.emAprov)}</span><span class="cell-dim">Saldo após aprovações: ${fmtBRL(r.saldo - r.emAprov)}</span></div>` : ''}
      </div>`; }).join('')}</div>

    <div class="grid grid-2 anim-in">
      <div class="card chart-card hoverable"><div class="chart-head"><div><h3>Orçado vs. Realizado por departamento</h3></div><div class="legend-row"><div class="legend-item"><span class="legend-dot" style="background:${cssVar('--c1')}"></span>Orçamento</div><div class="legend-item"><span class="legend-dot" style="background:${cssVar('--c2')}"></span>Gasto</div></div></div><div class="chart-wrap" style="height:280px;"><canvas id="gerDepBar"></canvas></div></div>
      <div class="card chart-card hoverable"><div class="chart-head"><h3>Participação do gasto por departamento</h3></div><div class="chart-wrap" style="height:280px;"><canvas id="gerDepDonut"></canvas></div></div>
    </div>
    <div class="section-title-row"><h2>Evolução mensal consolidada</h2><div class="hint">Ano fiscal ${ano} · ${periodLabel(period)}</div></div>
    <div class="grid grid-2 anim-in"><div class="card chart-card hoverable" style="grid-column:1/-1;"><div class="chart-wrap" style="height:240px;"><canvas id="gerTrend"></canvas></div></div></div>
    <div class="grid grid-2 anim-in">
      <div class="card chart-card hoverable"><div class="chart-head"><h3>Maiores categorias de gasto</h3></div><div class="chart-wrap" style="height:${Math.max(220, topCats.length * 34)}px;"><canvas id="gerCats"></canvas></div></div>
      <div class="card chart-card hoverable"><div class="chart-head"><h3>Maiores fornecedores</h3></div><div class="chart-wrap" style="height:${Math.max(220, topFornecedores(listPeriodo).length * 34)}px;"><canvas id="gerForn"></canvas></div></div>
    </div>
    <div class="section-title-row"><h2>Resumo por departamento</h2><div class="hint">${rows.length} departamentos</div></div>
    <div class="card table-card anim-in"><div class="table-scroll"><table class="data-table">
      <thead><tr><th>Departamento</th><th>Orçado</th><th>Gasto</th><th>Em aprovação</th><th>Saldo</th><th>Consumo</th><th>Status</th></tr></thead>
      <tbody>${rows.map(r => { const s = statusForPct(r.pct); return `<tr data-dep="${r.id}" style="cursor:pointer;"><td class="cell-strong">${escapeHtml(r.nome)}</td><td class="cell-num">${fmtBRL(r.orcado)}</td><td class="cell-num">${fmtBRL(r.gasto)}</td><td class="cell-num cell-dim">${fmtBRL(r.emAprov)}</td><td class="cell-num" style="color:${r.saldo < 0 ? cssVar('--critical') : 'inherit'}">${fmtBRL(r.saldo)}</td><td style="min-width:140px;"><div class="kpi-bar" style="margin-top:0;"><div style="width:${clamp(r.pct, 0, 100)}%; background:${cssVar(s.color)}"></div></div><span class="cell-dim" style="font-size:11px;">${fmtPct(r.pct)}</span></td><td><span class="pill ${r.temOrc ? s.cls : ''}">${r.temOrc ? s.label : 'sem orçamento'}</span></td></tr>`; }).join('')}
      <tr style="font-weight:800;"><td>Total</td><td class="cell-num">${fmtBRL(orcadoTotal)}</td><td class="cell-num">${fmtBRL(gastoTotal)}</td><td class="cell-num">${fmtBRL(emAprovTotal)}</td><td class="cell-num">${fmtBRL(saldo)}</td><td>${fmtPct(pct)}</td><td><span class="pill ${st.cls}">${st.label}</span></td></tr></tbody></table></div></div>
    <div class="footer-note">Dashboard gerencial gerado em ${new Date().toLocaleDateString('pt-BR')} · NexarPay — Grupo Gpac</div>`;
  wireGer(el);
  el.querySelectorAll('[data-dep]').forEach(c => c.addEventListener('click', () => { gerState.dep = c.dataset.dep; renderGerencial(); }));
  try {
    if (typeof Chart === 'undefined') throw new Error('Chart.js indisponível');
    chartDefaults();
    buildBarChart('gerDepBar', rows.map(r => r.nome), [{ label: 'Orçamento', data: rows.map(r => r.orcado), color: '--c1' }, { label: 'Gasto', data: rows.map(r => r.gasto), color: '--c2' }]);
    buildDonutChart('gerDepDonut', rows.filter(r => r.gasto > 0).map(r => [r.nome, r.gasto]), 'Sem gastos registrados no ano.');
    buildTrendChart('gerTrend', trendFor(listPeriodo));
    buildHBarChart('gerCats', topCats, 'Sem gastos no ano.');
    buildHBarChart('gerForn', topFornecedores(listPeriodo), 'Sem lançamentos no período.');
  } catch (err) { console.error(err); el.querySelectorAll('.chart-wrap').forEach(w => { w.innerHTML = emptyChartState('Não foi possível carregar os gráficos.'); }); }
}
function wireGer(el) {
  document.getElementById('gerDep').addEventListener('change', e => { gerState.dep = e.target.value; renderGerencial(); });
  document.getElementById('gerAno').addEventListener('change', e => { gerState.ano = Number(e.target.value); renderGerencial(); });
}

/* ---------- DASHBOARD (TV) — perfil "tv": somente leitura, dashboard customizável, atualização automática ----------
   Roda hoje no mesmo servidor local do NexarPay (sem nuvem). "Tempo real" aqui = a página busca os dados mais
   recentes do servidor a cada N segundos (padrão 30s, configurável) e redesenha — funciona em qualquer navegador
   apontando para o servidor, inclusive numa TV, sem precisar de infraestrutura adicional. */
const tvState = { period: 'all', ano: null, dep: '' };
let tvPollTimer = null;

const WIDGET_CATALOG = [
  { id: 'kpis', label: 'Indicadores principais (orçamento, gasto, saldo, consumo)' },
  { id: 'analise', label: 'Análise gerencial (projeção, solicitações, destaques)' },
  { id: 'deptCards', label: 'Orçamento × gasto por departamento (cards)' },
  { id: 'deptCharts', label: 'Orçado vs. realizado e participação por departamento (gráficos)' },
  { id: 'evolucao', label: 'Evolução mensal consolidada' },
  { id: 'categoriasFornecedores', label: 'Maiores categorias de gasto e maiores fornecedores' },
  { id: 'resumoTabela', label: 'Resumo em tabela por departamento' },
];
function defaultTvWidgets() { return WIDGET_CATALOG.map(w => w.id); }
function tvConfig() {
  const cfg = (DB.user && DB.user.dashboardTvConfig) || null;
  const widgets = (cfg && Array.isArray(cfg.widgets) && cfg.widgets.length) ? cfg.widgets.filter(id => WIDGET_CATALOG.find(w => w.id === id)) : defaultTvWidgets();
  const intervaloSegundos = (cfg && cfg.intervaloSegundos) || 30;
  return { widgets, intervaloSegundos };
}

async function renderDashboardTV() {
  const el = document.getElementById('page-dashboard_tv');
  if (!tvState.ano) tvState.ano = availableYears()[0];
  try { await reloadSolicitacoes(); } catch (e) { }
  if (currentPage !== 'dashboard_tv') return; // usuário já trocou de página
  const ano = tvState.ano, period = tvState.period;
  const deps = DB.departamentos.filter(d => d.ativo);
  const cfg = tvConfig();

  document.getElementById('topbarRight').innerHTML = periodFilterHtml(tvState) +
    `<span class="tv-live-chip" style="margin-left:10px;" title="Atualiza sozinho a cada ${cfg.intervaloSegundos}s"><span class="tv-live-dot"></span>Ao vivo · <span id="tvUpdatedAt">${new Date().toLocaleTimeString('pt-BR')}</span></span>
     <button class="btn btn-sm" id="tvCustomizeBtn" style="margin-left:8px;">${icon('sliders')}Personalizar</button>`;
  wirePeriodFilter(document.getElementById('topbarRight'), tvState, renderDashboardTV);
  document.getElementById('tvCustomizeBtn').addEventListener('click', openTvCustomizeModal);

  const header = `<div class="section-title-row anim-in" style="margin-top:0;">
      <h2>${icon('pie')} Painel de Monitoramento</h2>
      <div class="hint" style="display:flex; gap:8px; align-items:center;">Ano <select id="tvAno" class="input" style="padding:5px 10px; font-size:12px;">${availableYears().map(y => `<option value="${y}" ${y === ano ? 'selected' : ''}>${y}</option>`).join('')}</select></div></div>`;

  if (tvState.dep) {
    const b = getBudget(ano, tvState.dep);
    el.innerHTML = header + deptDashboardBody(tvState.dep, ano, period, b, 'tv') +
      `<div style="margin-top:14px;"><button class="btn btn-sm" id="tvBackBtn">${icon('x')}Voltar à visão consolidada</button></div>`;
    document.getElementById('tvAno').addEventListener('change', e => { tvState.ano = Number(e.target.value); renderDashboardTV(); });
    document.getElementById('tvBackBtn').addEventListener('click', () => { tvState.dep = ''; renderDashboardTV(); });
    paintDeptCharts(tvState.dep, ano, period, b, 'tv', el);
    startTvPolling(cfg.intervaloSegundos);
    return;
  }

  const c = computeConsolidado(deps, ano, period);
  el.innerHTML = header + cfg.widgets.map(id => tvWidgetHtml(id, { c, ano, period })).join('') +
    `<div class="footer-note">Dashboard (TV) atualizado automaticamente · NexarPay — Grupo Gpac</div>`;
  document.getElementById('tvAno').addEventListener('change', e => { tvState.ano = Number(e.target.value); renderDashboardTV(); });
  el.querySelectorAll('[data-dep]').forEach(card => card.addEventListener('click', () => { tvState.dep = card.dataset.dep; renderDashboardTV(); }));
  try {
    if (typeof Chart === 'undefined') throw new Error('Chart.js indisponível');
    chartDefaults();
    if (cfg.widgets.includes('deptCharts')) {
      buildBarChart('tvDepBar', c.rows.map(r => r.nome), [{ label: 'Orçamento', data: c.rows.map(r => r.orcado), color: '--c1' }, { label: 'Gasto', data: c.rows.map(r => r.gasto), color: '--c2' }]);
      buildDonutChart('tvDepDonut', c.rows.filter(r => r.gasto > 0).map(r => [r.nome, r.gasto]), 'Sem gastos registrados no ano.');
    }
    if (cfg.widgets.includes('evolucao')) buildTrendChart('tvTrend', trendFor(c.listPeriodo));
    if (cfg.widgets.includes('categoriasFornecedores')) {
      buildHBarChart('tvCats', c.topCats, 'Sem gastos no ano.');
      buildHBarChart('tvForn', topFornecedores(c.listPeriodo), 'Sem lançamentos no período.');
    }
  } catch (err) { console.error(err); el.querySelectorAll('.chart-wrap').forEach(w => { w.innerHTML = emptyChartState('Não foi possível carregar os gráficos.'); }); }

  startTvPolling(cfg.intervaloSegundos);
}

function tvWidgetHtml(id, ctx) {
  const { c, ano, period } = ctx;
  switch (id) {
    case 'kpis':
      return `<div class="grid grid-4 anim-in">
        ${kpiCard({ label: 'Orçamento Anual Total Aprovado', value: fmtBRL(c.orcadoTotal), icoBg: '--c1', ico: 'wallet', sub: `${c.rows.filter(r => r.temOrc).length} de ${c.rows.length} departamentos com orçamento em ${ano}`, barPct: 100, barColor: '--c1' })}
        ${kpiCard({ label: 'Gasto até o momento', value: fmtBRL(c.gastoTotal), icoBg: '--c2', ico: 'trend-up', sub: `${fmtPct(c.pct)} do orçamento consumido`, barPct: clamp(c.pct, 0, 100), barColor: c.st.color })}
        ${kpiCard({ label: 'Saldo Disponível', value: fmtBRL(Math.max(c.saldo, 0)), icoBg: c.saldo >= 0 ? '--good' : '--critical', ico: 'scale', sub: c.saldo >= 0 ? `${fmtBRL(c.emAprovTotal)} comprometidos em solicitações abertas` : `estouro de ${fmtBRL(Math.abs(c.saldo))}`, barPct: clamp(100 - c.pct, 0, 100), barColor: c.saldo >= 0 ? '--good' : '--critical' })}
        <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Consumo Consolidado</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar(c.st.color)} 18%, transparent); color:${cssVar(c.st.color)};">${ICONS.spark}</div></div>
          <div class="kpi-value">${fmtPct(c.pct)}</div><div class="kpi-sub"><span class="pill ${c.st.cls}">${c.st.label}</span></div><div class="kpi-sub" style="margin-top:2px;">${fmtBRL(c.gastoPeriodo)} gastos · ${periodLabel(period).toLowerCase()} de ${ano}</div></div>
      </div>`;
    case 'analise':
      return `<div class="section-title-row"><h2>Análise gerencial</h2><div class="hint">Leitura executiva do ano fiscal ${ano}</div></div>
      <div class="grid grid-3 anim-in">
        <div class="card kpi compact hoverable"><div class="kpi-top"><span class="kpi-label">Projeção de fechamento</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c7')} 18%, transparent); color:${cssVar('--c7')};">${ICONS['trend-up']}</div></div>
          <div class="kpi-value">${fmtBRL(c.projecao)}</div><div class="kpi-sub">média de ${fmtBRL(c.mediaMensal)}/mês × ${c.mesesRestantes} mês(es) restante(s) → ${c.orcadoTotal ? fmtPct(c.projecao / c.orcadoTotal * 100) : '—'} do orçamento</div></div>
        <div class="card kpi compact hoverable"><div class="kpi-top"><span class="kpi-label">Solicitações de pagamento em ${ano}</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c1')} 18%, transparent); color:${cssVar('--c1')};">${ICONS.send}</div></div>
          <div class="kpi-value">${c.sols.length}</div><div class="kpi-sub"><span class="st st-aprovacao1">${c.cnt(s => ['aprovacao1', 'aprovacao2', 'rh', 'rh2', 'financeiro'].includes(s.status))} em aprovação</span> <span class="st st-alteracao">${c.cnt(s => s.status === 'alteracao')} pendentes</span> <span class="st st-encerrada">${c.cnt(s => s.status === 'encerrada')} encerradas</span> <span class="st st-reprovada">${c.cnt(s => s.status === 'reprovada')} reprovadas</span></div></div>
        <div class="card kpi compact hoverable"><div class="kpi-top"><span class="kpi-label">Destaques</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c4')} 18%, transparent); color:${cssVar('--c4')};">${ICONS.spark}</div></div>
          <div class="kpi-sub" style="line-height:1.6;">${c.maior ? `<strong>${escapeHtml(c.maior.nome)}</strong> concentra o maior gasto (${fmtBRL(c.maior.gasto)}).<br/>` : ''}${c.maisConsumido ? `<strong>${escapeHtml(c.maisConsumido.nome)}</strong> é o departamento com maior consumo relativo (${fmtPct(c.maisConsumido.pct)}).<br/>` : ''}${c.cnt(s => s.atrasada) ? `<span style="color:${cssVar('--serious')}">${c.cnt(s => s.atrasada)} solicitação(ões) com pagamento atrasado.</span>` : 'Nenhuma solicitação atrasada.'}</div></div>
      </div>`;
    case 'deptCards':
      return `<div class="section-title-row"><h2>Orçamento × Gasto por departamento</h2><div class="hint">Clique em um departamento para detalhar</div></div>
      <div class="grid grid-3 anim-in">${c.rows.map(r => { const s = statusForPct(r.pct); return `<div class="card dept-card hoverable" style="cursor:pointer;" data-dep="${r.id}">
          <h4>${escapeHtml(r.nome)} <span class="pill ${r.temOrc ? s.cls : ''}" style="${r.temOrc ? '' : 'color:var(--text-faint);'}">${r.temOrc ? s.label : 'sem orçamento'}</span></h4>
          <div class="progress"><div style="width:${clamp(r.pct, 0, 100)}%; background:${cssVar(s.color)}"></div></div>
          <div class="nums"><span>Orçado <strong>${fmtBRL(r.orcado)}</strong></span><span>Gasto <strong>${fmtBRL(r.gasto)}</strong></span><span>${fmtPct(r.pct)}</span></div>
          ${r.emAprov ? `<div class="nums"><span class="cell-dim">Em aprovação: ${fmtBRL(r.emAprov)}</span><span class="cell-dim">Saldo após aprovações: ${fmtBRL(r.saldo - r.emAprov)}</span></div>` : ''}
        </div>`; }).join('')}</div>`;
    case 'deptCharts':
      return `<div class="grid grid-2 anim-in">
        <div class="card chart-card hoverable"><div class="chart-head"><div><h3>Orçado vs. Realizado por departamento</h3></div><div class="legend-row"><div class="legend-item"><span class="legend-dot" style="background:${cssVar('--c1')}"></span>Orçamento</div><div class="legend-item"><span class="legend-dot" style="background:${cssVar('--c2')}"></span>Gasto</div></div></div><div class="chart-wrap" style="height:280px;"><canvas id="tvDepBar"></canvas></div></div>
        <div class="card chart-card hoverable"><div class="chart-head"><h3>Participação do gasto por departamento</h3></div><div class="chart-wrap" style="height:280px;"><canvas id="tvDepDonut"></canvas></div></div>
      </div>`;
    case 'evolucao':
      return `<div class="section-title-row"><h2>Evolução mensal consolidada</h2><div class="hint">Ano fiscal ${ano} · ${periodLabel(period)}</div></div>
      <div class="grid grid-2 anim-in"><div class="card chart-card hoverable" style="grid-column:1/-1;"><div class="chart-wrap" style="height:240px;"><canvas id="tvTrend"></canvas></div></div></div>`;
    case 'categoriasFornecedores':
      return `<div class="grid grid-2 anim-in">
        <div class="card chart-card hoverable"><div class="chart-head"><h3>Maiores categorias de gasto</h3></div><div class="chart-wrap" style="height:${Math.max(220, c.topCats.length * 34)}px;"><canvas id="tvCats"></canvas></div></div>
        <div class="card chart-card hoverable"><div class="chart-head"><h3>Maiores fornecedores</h3></div><div class="chart-wrap" style="height:${Math.max(220, topFornecedores(c.listPeriodo).length * 34)}px;"><canvas id="tvForn"></canvas></div></div>
      </div>`;
    case 'resumoTabela':
      return `<div class="section-title-row"><h2>Resumo por departamento</h2><div class="hint">${c.rows.length} departamentos</div></div>
      <div class="card table-card anim-in"><div class="table-scroll"><table class="data-table">
        <thead><tr><th>Departamento</th><th>Orçado</th><th>Gasto</th><th>Em aprovação</th><th>Saldo</th><th>Consumo</th><th>Status</th></tr></thead>
        <tbody>${c.rows.map(r => { const s = statusForPct(r.pct); return `<tr data-dep="${r.id}" style="cursor:pointer;"><td class="cell-strong">${escapeHtml(r.nome)}</td><td class="cell-num">${fmtBRL(r.orcado)}</td><td class="cell-num">${fmtBRL(r.gasto)}</td><td class="cell-num cell-dim">${fmtBRL(r.emAprov)}</td><td class="cell-num" style="color:${r.saldo < 0 ? cssVar('--critical') : 'inherit'}">${fmtBRL(r.saldo)}</td><td style="min-width:140px;"><div class="kpi-bar" style="margin-top:0;"><div style="width:${clamp(r.pct, 0, 100)}%; background:${cssVar(s.color)}"></div></div><span class="cell-dim" style="font-size:11px;">${fmtPct(r.pct)}</span></td><td><span class="pill ${r.temOrc ? s.cls : ''}">${r.temOrc ? s.label : 'sem orçamento'}</span></td></tr>`; }).join('')}
        <tr style="font-weight:800;"><td>Total</td><td class="cell-num">${fmtBRL(c.orcadoTotal)}</td><td class="cell-num">${fmtBRL(c.gastoTotal)}</td><td class="cell-num">${fmtBRL(c.emAprovTotal)}</td><td class="cell-num">${fmtBRL(c.saldo)}</td><td>${fmtPct(c.pct)}</td><td><span class="pill ${c.st.cls}">${c.st.label}</span></td></tr></tbody></table></div></div>`;
    default: return '';
  }
}

// Poll: busca os dados mais recentes do servidor local em intervalos e redesenha — só enquanto a
// página do Dashboard (TV) estiver aberta e visível (evita gastar rede/CPU à toa em segundo plano).
function startTvPolling(intervaloSegundos) {
  if (tvPollTimer) { clearInterval(tvPollTimer); tvPollTimer = null; }
  const ms = Math.max(15, intervaloSegundos || 30) * 1000;
  tvPollTimer = setInterval(async () => {
    if (currentPage !== 'dashboard_tv' || document.hidden) return;
    try {
      await Promise.all([reloadLaunches(), reloadBudgets(), reloadDepartamentos(), reloadSolicitacoes()]);
      if (currentPage === 'dashboard_tv') renderDashboardTV();
    } catch (e) { console.error('Falha ao atualizar o Dashboard (TV):', e); }
  }, ms);
}

function openTvCustomizeModal() {
  const cfg = tvConfig();
  const state = {
    order: WIDGET_CATALOG.map(w => w.id).sort((a, b) => {
      const ia = cfg.widgets.indexOf(a), ib = cfg.widgets.indexOf(b);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }),
    on: new Set(cfg.widgets),
  };
  function renderList() {
    return state.order.map((id, i) => {
      const w = WIDGET_CATALOG.find(x => x.id === id);
      const isOn = state.on.has(id);
      return `<div class="widget-row ${isOn ? '' : 'off'}" data-id="${id}">
        <input type="checkbox" class="widget-check" ${isOn ? 'checked' : ''}/>
        <span class="widget-name">${escapeHtml(w.label)}</span>
        <div class="widget-move">
          <button type="button" data-dir="up" ${i === 0 ? 'disabled' : ''} title="Mover para cima"><span style="display:inline-flex; transform:rotate(180deg);">${ICONS.chevDown}</span></button>
          <button type="button" data-dir="down" ${i === state.order.length - 1 ? 'disabled' : ''} title="Mover para baixo">${ICONS.chevDown}</button>
        </div>
      </div>`;
    }).join('');
  }
  function wireRows() {
    document.querySelectorAll('#tvWidgetList .widget-check').forEach(chk => chk.addEventListener('change', (e) => {
      const id = e.target.closest('.widget-row').dataset.id;
      if (e.target.checked) state.on.add(id); else state.on.delete(id);
      refresh();
    }));
    document.querySelectorAll('#tvWidgetList .widget-move button').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.closest('.widget-row').dataset.id;
      const i = state.order.indexOf(id);
      const j = i + (btn.dataset.dir === 'up' ? -1 : 1);
      if (j < 0 || j >= state.order.length) return;
      [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
      refresh();
    }));
  }
  function refresh() { document.getElementById('tvWidgetList').innerHTML = renderList(); wireRows(); }

  openModal(`
    <div class="modal-head"><h3>${modalIcon('sliders')} Personalizar Dashboard</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body">
      <p style="font-size:12.5px; color:var(--text-dim); margin-bottom:10px;">Marque o que este painel deve exibir e use as setas para definir a ordem. Vale só para o seu usuário.</p>
      <div id="tvWidgetList">${renderList()}</div>
      <div class="form-field" style="margin-top:16px; max-width:220px;"><label>Atualizar automaticamente a cada</label>
        <select id="tvIntervalo" class="input">${[15, 30, 60, 120, 300].map(s => `<option value="${s}" ${s === cfg.intervaloSegundos ? 'selected' : ''}>${s < 60 ? s + ' segundos' : (s / 60) + ' minuto(s)'}</option>`).join('')}</select>
      </div>
    </div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="tvSaveBtn">${ICONS.check}Salvar</button></div>`, { size: 'lg' });
  wireRows();
  document.getElementById('tvSaveBtn').addEventListener('click', async () => {
    const widgets = state.order.filter(id => state.on.has(id));
    if (!widgets.length) { toast('Selecione ao menos um item para exibir.', 'error'); return; }
    const intervaloSegundos = Number(document.getElementById('tvIntervalo').value) || 30;
    try {
      const r = await api('PUT', '/auth/dashboard-config', { widgets, intervaloSegundos });
      DB.user.dashboardTvConfig = r.dashboardTvConfig;
      closeModal();
      toast('Dashboard personalizado com sucesso.', 'success');
      renderDashboardTV();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ---------- Chart.js helpers ---------- */
function chartDefaults() { Chart.defaults.font.family = "'Inter', system-ui, sans-serif"; Chart.defaults.color = cssVar('--text-faint'); Chart.defaults.borderColor = cssVar('--grid'); }
function baseTooltip() { return { backgroundColor: cssVar('--elevated'), titleColor: cssVar('--text'), bodyColor: cssVar('--text-dim'), borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10, titleFont: { weight: 700, size: 12 }, bodyFont: { size: 12 }, cornerRadius: 8, displayColors: true, boxPadding: 4 }; }
function fmtBRLShort(v) { const abs = Math.abs(v); if (abs >= 1000000) return 'R$ ' + (v / 1000000).toFixed(1).replace('.', ',') + 'M'; if (abs >= 1000) return 'R$ ' + (v / 1000).toFixed(0) + 'k'; return 'R$ ' + Number(v).toFixed(0); }
function hexWithAlpha(hex, alpha) { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`; }
function emptyChartState(msg) { return `<div class="empty-state" style="padding:30px 10px;">${ICONS.info}<p>${escapeHtml(msg)}</p></div>`; }
function buildBarChart(id, labels, datasets, horizontal) {
  destroyChart(id); const ctx = document.getElementById(id); if (!ctx) return;
  chartRefs[id] = new Chart(ctx, { type: 'bar', data: { labels, datasets: datasets.map(d => ({ label: d.label, data: d.data, backgroundColor: cssVar(d.color), borderRadius: 6, maxBarThickness: horizontal ? 26 : 34 })) },
    options: { indexAxis: horizontal ? 'y' : 'x', responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { ...baseTooltip(), callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtBRL(c.raw)}` } } },
      scales: horizontal ? { x: { grid: { color: cssVar('--grid') }, border: { display: false }, ticks: { color: cssVar('--text-faint'), callback: (v) => fmtBRLShort(v) } }, y: { grid: { display: false }, ticks: { color: cssVar('--text-dim'), font: { weight: 700, size: 12 } } } }
        : { x: { grid: { display: false }, ticks: { color: cssVar('--text-faint'), font: { size: 11, weight: 600 } } }, y: { grid: { color: cssVar('--grid') }, border: { display: false }, ticks: { color: cssVar('--text-faint'), callback: (v) => fmtBRLShort(v) } } } } });
}
function buildHBarChart(id, rows, emptyMsg) {
  destroyChart(id); const ctx = document.getElementById(id); if (!ctx) return;
  if (!rows.length) { ctx.parentElement.innerHTML = emptyChartState(emptyMsg); return; }
  chartRefs[id] = new Chart(ctx, { type: 'bar', data: { labels: rows.map(r => r[0]), datasets: [{ data: rows.map(r => r[1]), backgroundColor: rows.map((_, i) => colorForIndex(i)), borderRadius: 6, maxBarThickness: 22 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...baseTooltip(), callbacks: { label: (c) => ` ${fmtBRL(c.raw)}` } } }, scales: { x: { grid: { color: cssVar('--grid') }, border: { display: false }, ticks: { color: cssVar('--text-faint'), callback: (v) => fmtBRLShort(v) } }, y: { grid: { display: false }, ticks: { color: cssVar('--text-dim'), font: { size: 11.5, weight: 600 } } } } } });
}
function buildDonutChart(id, rows, emptyMsg) {
  destroyChart(id); const ctx = document.getElementById(id); if (!ctx) return;
  if (!rows.length) { ctx.parentElement.innerHTML = emptyChartState(emptyMsg); return; }
  chartRefs[id] = new Chart(ctx, { type: 'doughnut', data: { labels: rows.map(r => r[0]), datasets: [{ data: rows.map(r => r[1]), backgroundColor: rows.map((_, i) => colorForIndex(i)), borderWidth: 3, borderColor: cssVar('--card'), hoverOffset: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { position: 'bottom', labels: { color: cssVar('--text-dim'), boxWidth: 10, boxHeight: 10, padding: 14, font: { size: 11, weight: 600 } } }, tooltip: { ...baseTooltip(), callbacks: { label: (c) => ` ${c.label}: ${fmtBRL(c.raw)}` } } } } });
}
function buildTrendChart(id, trend) {
  destroyChart(id); const ctx = document.getElementById(id); if (!ctx) return;
  if (!trend.labels.length) { ctx.parentElement.innerHTML = emptyChartState('Sem lançamentos com data no período selecionado.'); return; }
  const g = ctx.getContext('2d').createLinearGradient(0, 0, 0, 240); g.addColorStop(0, hexWithAlpha(cssVar('--c1'), 0.35)); g.addColorStop(1, hexWithAlpha(cssVar('--c1'), 0));
  chartRefs[id] = new Chart(ctx, { type: 'line', data: { labels: trend.labels, datasets: [{ data: trend.values, borderColor: cssVar('--c1'), backgroundColor: g, fill: true, tension: .35, pointRadius: 3, pointBackgroundColor: cssVar('--c1'), pointBorderColor: cssVar('--card'), pointBorderWidth: 2, borderWidth: 2.5 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...baseTooltip(), callbacks: { label: (c) => ` ${fmtBRL(c.raw)}` } } }, scales: { x: { grid: { display: false }, ticks: { color: cssVar('--text-faint'), font: { size: 11 } } }, y: { grid: { color: cssVar('--grid') }, border: { display: false }, ticks: { color: cssVar('--text-faint'), callback: (v) => fmtBRLShort(v) } } } } });
}
