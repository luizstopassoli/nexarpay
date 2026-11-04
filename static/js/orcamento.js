/* ===================== NexarPay — Orçamento por departamento (categorias → linhas → cenários) ===================== */

const orcState = { openCats: new Set(), ano: null, dep: null };
function catIconFor(id) { const map = { hardware: 'cpu', software: 'box', rede: 'wifi', servidor: 'server', seguranca: 'shield', consumiveis: 'drop', ia: 'brain' }; return map[id] || 'layers'; }
function currentOrcBudget() { return getBudget(orcState.ano, orcState.dep); }
function findCat(id) { return (currentOrcBudget()?.categorias || []).find(c => c.id === id); }
function findLinha(catId, linhaId) { return findCat(catId)?.linhas.find(l => String(l.id) === String(linhaId)); }
async function saveBudget(b, msg) {
  try { await api('PUT', `/budgets/${b.id}`, { dolar: b.dolar, rateio: b.rateio, categorias: b.categorias }); if (msg) toast(msg, 'success'); }
  catch (e) { toast(e.message, 'error'); await reloadBudgets(); }
  renderOrcamento();
}

function renderOrcamento() {
  const el = document.getElementById('page-orcamento');
  const deps = depsVisiveis();
  if (!deps.length) { el.innerHTML = emptyState('building', 'Nenhum departamento atribuído', 'Peça ao Administrador para vincular seu usuário a um departamento.'); return; }
  if (!orcState.dep || !deps.find(d => d.id === orcState.dep)) orcState.dep = deps[0].id;
  const anosDep = DB.budgets.filter(b => b.departamentoId === orcState.dep).map(b => b.ano).sort((a, b) => b - a);
  if (orcState.ano === null || !anosDep.includes(orcState.ano)) orcState.ano = anosDep[0] || null;
  const ano = orcState.ano, depId = orcState.dep, budget = currentOrcBudget();

  const header = `<div class="section-title-row" style="margin-top:0;">
      <h2>${icon('building')} <select id="orcDep" class="input" style="padding:6px 10px; font-size:13px; font-weight:700;">${selectOptions(deps, depId)}</select></h2>
      <div class="hint" style="display:flex; align-items:center; gap:8px;">Ano fiscal
        ${anosDep.length ? `<select id="orcAnoSelect" class="input" style="padding:5px 10px; font-size:12px;">${anosDep.map(y => `<option value="${y}" ${y === ano ? 'selected' : ''}>${y}</option>`).join('')}</select>` : '<span>—</span>'}
        ${anoFechado(ano) ? `<span class="pill pill-crit">Ano fechado</span>` : ''}
        <button class="btn btn-sm admin-only" id="fechamentoBtn">${ICONS.check}Fechamento do ano</button>
        <button class="btn btn-primary btn-sm admin-only" id="addBudgetBtn">${ICONS.plus}Novo Orçamento</button>
      </div></div>`;

  if (!budget) {
    el.innerHTML = header + `<div class="card empty-state">${ICONS.wallet}<h4>Nenhum orçamento cadastrado para ${escapeHtml(depNome(depId))}</h4><p>${isAdmin() ? 'Crie o primeiro orçamento deste departamento para começar a planejar categorias e cenários.' : 'Peça ao Administrador para cadastrar o orçamento.'}</p></div>`;
    wireOrcHeader();
    return;
  }
  const totalOrcado = totalBudgetApproved(budget);
  const gastoAno = somaCusto(DB.launches.filter(l => l.ano === ano && l.departamentoId === depId));
  const fechado = anoFechado(ano);
  el.innerHTML = header + (fechado ? `<div class="alert-box warn">${icon('alert')}<div><strong>Ano fiscal ${ano} fechado.</strong> Orçamento, rateio e lançamentos deste ano não podem ser alterados. O Administrador pode reabrir o ano em "Fechamento do ano".</div></div>` : '') + `<div class="${fechado ? 'ano-fechado' : ''}">
    <div class="grid grid-3 anim-in">
      <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Orçamento Total Aprovado</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c1')} 18%, transparent); color:${cssVar('--c1')};">${ICONS.wallet}</div></div>
        <div class="kpi-value">${fmtBRL(totalOrcado)}</div><div class="kpi-sub">${escapeHtml(depNome(depId))} · ${ano} · Dólar ref. R$ ${Number(budget.dolar || 0).toFixed(2)}</div></div>
      <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Gasto Realizado</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c2')} 18%, transparent); color:${cssVar('--c2')};">${ICONS['trend-up']}</div></div>
        <div class="kpi-value">${fmtBRL(gastoAno)}</div><div class="kpi-sub">${fmtPct(totalOrcado ? gastoAno / totalOrcado * 100 : 0)} do orçamento consumido</div></div>
      <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Rateio Configurado</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c7')} 18%, transparent); color:${cssVar('--c7')};">${ICONS.scale}</div></div>
        <div class="kpi-value" style="font-size:15px; display:flex; gap:10px; flex-wrap:wrap;">${COMPANY_KEYS.some(k => Number(budget.rateio[k]) > 0) ? COMPANY_KEYS.map(k => `<span>${COMPANY_LABELS[k]} <strong>${fmtPct((budget.rateio[k] || 0) * 100, 2).replace(/,00%$/, '%')}</strong></span>`).join('') : '<span class="cell-dim">Sem rateio cadastrado (gastos do grupo não são divididos)</span>'}</div>
        <div class="kpi-sub"><button class="btn btn-sm admin-only" id="editRateioBtn" style="margin-top:4px;">${ICONS.edit}Editar rateio / dólar</button></div></div>
    </div>
    <div class="section-title-row"><h2>Categorias &amp; Cenários — ${ano}</h2><div style="display:flex; gap:10px;"><button class="btn btn-danger btn-sm admin-only" id="delBudgetBtn">${ICONS.trash}Excluir orçamento</button></div></div>
    <div class="anim-in" style="display:flex; flex-direction:column; gap:14px;">
      ${budget.categorias.map(c => renderCatCard(c, ano, depId, budget)).join('') || '<p class="cell-dim">Nenhuma categoria cadastrada.</p>'}
      <button class="btn btn-sm admin-only" id="addCatBtn" style="align-self:flex-start;">${ICONS.plus}Nova Categoria neste orçamento</button>
    </div>
    <div class="footer-note">Marque um cenário como aprovado (radio) para definir o valor oficial da linha orçamentária. Solicitações de pagamento encerradas abatem automaticamente do orçamento do departamento.</div></div>`;
  wireOrcHeader();
  const q = (id) => document.getElementById(id);
  q('editRateioBtn').addEventListener('click', openRateioModal);
  q('addCatBtn').addEventListener('click', () => openCategoryForm());
  q('delBudgetBtn').addEventListener('click', async () => { if (await confirmDialog({ title: 'Excluir orçamento', message: `Excluir o orçamento de ${depNome(depId)} em ${ano}? As categorias e cenários serão perdidos.` })) { try { await api('DELETE', `/budgets/${budget.id}`); await reloadBudgets(); toast('Orçamento excluído.', 'success'); } catch (e) { toast(e.message, 'error'); } renderOrcamento(); } });
  el.querySelectorAll('[data-toggle-cat]').forEach(h => h.addEventListener('click', (e) => { if (e.target.closest('[data-stop]')) return; const id = h.dataset.toggleCat; orcState.openCats.has(id) ? orcState.openCats.delete(id) : orcState.openCats.add(id); renderOrcamento(); }));
  el.querySelectorAll('[data-edit-cat]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openCategoryForm(b.dataset.editCat); }));
  el.querySelectorAll('[data-del-cat]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); deleteCategory(b.dataset.delCat); }));
  el.querySelectorAll('[data-add-linha]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openLinhaForm(b.dataset.addLinha); }));
  el.querySelectorAll('[data-edit-linha]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openLinhaForm(b.dataset.catId, b.dataset.editLinha); }));
  el.querySelectorAll('[data-del-linha]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); deleteLinha(b.dataset.catId, b.dataset.delLinha); }));
  el.querySelectorAll('[data-add-cen]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openCenarioForm(b.dataset.catId, b.dataset.addCen); }));
  el.querySelectorAll('[data-edit-cen]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openCenarioForm(b.dataset.catId, b.dataset.linhaId, b.dataset.editCen); }));
  el.querySelectorAll('[data-del-cen]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); deleteCenario(b.dataset.catId, b.dataset.linhaId, b.dataset.delCen); }));
  el.querySelectorAll('[data-approve-cen]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); if (!isAdmin() || anoFechado(orcState.ano)) return; approveCenario(b.dataset.catId, b.dataset.linhaId, b.dataset.approveCen); }));
}
function wireOrcHeader() {
  document.getElementById('orcDep').addEventListener('change', e => { orcState.dep = e.target.value; orcState.ano = null; orcState.openCats = new Set(); renderOrcamento(); });
  const a = document.getElementById('orcAnoSelect'); if (a) a.addEventListener('change', e => { orcState.ano = Number(e.target.value); orcState.openCats = new Set(); renderOrcamento(); });
  const nb = document.getElementById('addBudgetBtn'); if (nb) nb.addEventListener('click', openNewBudgetForm);
  const fb = document.getElementById('fechamentoBtn'); if (fb) fb.addEventListener('click', openFechamentoModal);
}
function renderCatCard(c, ano, depId, budget) {
  const open = orcState.openCats.has(c.id);
  const orcado = approvedTotalForCategory(c);
  const gasto = somaCusto(DB.launches.filter(l => l.ano === ano && l.departamentoId === depId && budgetCategoryForLaunch(l.categoria, budget) === c.id));
  const rateio = approvedRateioForCategory(c, budget.rateio);
  const color = colorForIndex(budget.categorias.findIndex(x => x.id === c.id));
  return `<div class="card cat-card hoverable">
    <div class="cat-head" data-toggle-cat="${c.id}">
      <div class="cat-head-left"><div class="cat-ico" style="background:color-mix(in srgb, ${color} 16%, transparent); color:${color};">${ICONS[catIconFor(c.id)] || ICONS.layers}</div>
        <div><div class="cat-title">${escapeHtml(c.nome)}</div><div class="cat-sub">${(c.linhas || []).length} linha(s) orçamentária(s) · ${escapeHtml((c.categoriasLancamento || []).join(', ')) || 'sem vínculo direto'}</div></div></div>
      <div class="cat-right">
        <div class="cat-stat"><div class="v">${fmtBRL(orcado)}</div><div class="l">Orçado</div></div>
        <div class="cat-stat"><div class="v">${fmtBRL(gasto)}</div><div class="l">Gasto</div></div>
        <div class="row-actions admin-only" data-stop><button class="icon-btn" data-edit-cat="${c.id}" title="Editar categoria">${ICONS.edit}</button><button class="icon-btn danger" data-del-cat="${c.id}" title="Excluir categoria">${ICONS.trash}</button></div>
        <div class="chev ${open ? 'open' : ''}">${ICONS.chevDown}</div>
      </div></div>
    <div class="cat-body ${open ? 'open' : ''}">
      ${(c.linhas || []).map(linha => renderLinhaBlock(c.id, linha)).join('') || '<p class="cell-dim" style="font-size:12.5px;">Nenhuma linha cadastrada ainda.</p>'}
      <button class="btn btn-sm admin-only" data-add-linha="${c.id}" data-stop>${ICONS.plus}Adicionar linha orçamentária</button>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border);">
        <div class="line-head"><h4>Rateio por empresa (sobre ${fmtBRL(orcado)})</h4></div>
        <div class="rateio-bar">${COMPANY_KEYS.map(k => `<div style="width:${(budget.rateio[k] || 0) * 100}%; background:${cssVar(COMPANY_COLOR_VAR[k])}"></div>`).join('')}</div>
        <div class="rateio-legend">${COMPANY_KEYS.map(k => `<div class="legend-item"><span class="legend-dot" style="background:${cssVar(COMPANY_COLOR_VAR[k])}"></span>${COMPANY_LABELS[k]}: <strong style="color:var(--text);">${fmtBRL(rateio[k])}</strong></div>`).join('')}</div>
      </div></div></div>`;
}
function renderLinhaBlock(catId, linha) {
  return `<div class="line-block"><div class="line-head"><h4>${escapeHtml(linha.nome)}</h4>
      <div class="row-actions admin-only" data-stop><button class="icon-btn" data-cat-id="${catId}" data-edit-linha="${linha.id}" title="Renomear linha">${ICONS.edit}</button><button class="icon-btn danger" data-cat-id="${catId}" data-del-linha="${linha.id}" title="Excluir linha">${ICONS.trash}</button><button class="icon-btn" data-add-cen="${linha.id}" data-cat-id="${catId}" title="Adicionar cenário">${ICONS.plus}</button></div></div>
    ${(linha.cenarios || []).map(cen => `<div class="scenario-row ${cen.aprovado ? 'approved' : ''}">
        <div class="scenario-radio ${cen.aprovado ? 'checked' : ''}" data-cat-id="${catId}" data-linha-id="${linha.id}" data-approve-cen="${cen.id}" title="Definir como aprovado"></div>
        <div class="scenario-name">${escapeHtml(cen.nome)} <span class="scenario-meta">· prioridade ${escapeHtml(cen.prioridade || '—')}</span>${cen.observacao ? `<div class="scenario-meta">${escapeHtml(cen.observacao)}</div>` : ''}</div>
        <div class="scenario-value">${fmtBRL(cen.valor)}</div>
        <div class="row-actions admin-only" data-stop><button class="icon-btn" data-cat-id="${catId}" data-linha-id="${linha.id}" data-edit-cen="${cen.id}" title="Editar">${ICONS.edit}</button><button class="icon-btn danger" data-cat-id="${catId}" data-linha-id="${linha.id}" data-del-cen="${cen.id}" title="Excluir">${ICONS.trash}</button></div>
      </div>`).join('')}</div>`;
}
function approveCenario(catId, linhaId, cenId) {
  const linha = findLinha(catId, linhaId); if (!linha) return;
  linha.cenarios.forEach(c => c.aprovado = (String(c.id) === String(cenId)));
  saveBudget(currentOrcBudget(), 'Cenário definido como aprovado.');
}
// rateio inicial de um orçamento novo: copia o do ano anterior (se ainda válido) ou usa o percentual padrão do cadastro de empresas
function rateioInicial(source) {
  const soma = (o) => COMPANY_KEYS.reduce((t, k) => t + (Number(o[k]) || 0), 0);
  if (source && source.rateio) { const o = {}; COMPANY_KEYS.forEach(k => { if (Number(source.rateio[k])) o[k] = Number(source.rateio[k]); }); if (Math.abs(soma(o) - 1) < 0.0001) return o; }
  const pad = {}; COMPANY_KEYS.forEach(k => { const e = DB.empresas.find(x => x.id === k); if (e && e.rateioPadrao) pad[k] = e.rateioPadrao / 100; });
  return Math.abs(soma(pad) - 1) < 0.0001 ? pad : {};
}
function openNewBudgetForm() {
  const depId = orcState.dep;
  const anos = DB.budgets.filter(b => b.departamentoId === depId).map(b => b.ano).sort((a, b) => b - a);
  const lastYear = anos.length ? anos[0] : new Date().getFullYear() - 1;
  const source = getBudget(lastYear, depId);
  openModal(`
    <div class="modal-head"><h3>${modalIcon('plus')} Novo Orçamento — ${escapeHtml(depNome(depId))}</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="newBudgetForm"><div class="form-grid">
      <div class="form-field"><label>Ano fiscal <span class="req">*</span></label><input class="input" type="number" name="ano" required value="${lastYear + 1}"/></div>
      <div class="form-field"><label>Cotação do Dólar (R$)</label><input class="input" type="number" min="0" step="0.01" name="dolar" value="${source ? source.dolar : 5.5}"/></div></div>
      <p class="form-hint" style="margin-top:12px;">${source ? `As categorias e linhas de <strong>${lastYear}</strong> serão copiadas como ponto de partida (rateio também). Os cenários começam com valor <strong>R$ 0,00</strong> e sem aprovação.` : 'Nenhum orçamento anterior deste departamento — começará em branco.'}</p></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveNewBudgetBtn">${ICONS.check}Criar Orçamento</button></div>`);
  document.getElementById('saveNewBudgetBtn').addEventListener('click', async () => {
    const form = document.getElementById('newBudgetForm'); if (!form.reportValidity()) return;
    const novoAno = Number(form.ano.value);
    const categorias = (source?.categorias || []).map(c => ({ id: 'cat_' + uid(), nome: c.nome, categoriasLancamento: [...(c.categoriasLancamento || [])], linhas: (c.linhas || []).map(l => ({ id: 'linha_' + uid(), nome: l.nome, cenarios: (l.cenarios || []).map(cen => ({ id: 'cen_' + uid(), nome: cen.nome, valor: 0, prioridade: cen.prioridade || 'Média', aprovado: false, observacao: '' })) })) }));
    try { await api('POST', '/budgets', { ano: novoAno, departamentoId: depId, dolar: Number(form.dolar.value) || 5.5, rateio: rateioInicial(source), categorias }); await reloadBudgets(); orcState.ano = novoAno; orcState.openCats = new Set(); closeModal(); renderOrcamento(); toast(`Orçamento de ${novoAno} criado.`, 'success'); }
    catch (e) { toast(e.message, 'error'); }
  });
}
function openRateioModal() {
  const budget = currentOrcBudget();
  if (!COMPANY_KEYS.length) { toast('Cadastre as empresas do cliente (Propriedades → Empresas) antes de definir o rateio.', 'error'); return; }
  const temRateio = COMPANY_KEYS.some(k => Number(budget.rateio[k]) > 0);
  const padrao = (k) => (DB.empresas.find(e => e.id === k) || {}).rateioPadrao || 0;
  const valorInicial = (k) => temRateio ? (Number(budget.rateio[k]) || 0) * 100 : padrao(k);
  openModal(`
    <div class="modal-head"><h3>${modalIcon('scale')} Rateio por Empresa &amp; Câmbio — ${budget.ano}</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="rateioForm"><div class="form-grid">
      ${COMPANY_KEYS.map(k => `<div class="form-field"><label>${escapeHtml(COMPANY_LABELS[k])} (%)</label><input class="input" type="number" min="0" max="100" step="0.01" name="${escapeHtml(k)}" value="${Number(valorInicial(k).toFixed(2))}"/></div>`).join('')}
      <div class="form-field"><label>Cotação do Dólar (R$)</label><input class="input" type="number" min="0" step="0.01" name="dolar" value="${budget.dolar}"/></div></div>
      <p class="form-hint" id="rateioSumHint" style="margin-top:12px;"></p>
      <p class="form-hint" style="margin-top:6px;">${temRateio ? '<strong>Atenção:</strong> alterar o rateio recalcula o orçado de cada empresa e a divisão dos gastos já lançados para o grupo (o total gasto não muda). Antes de salvar você verá a prévia do impacto e precisará confirmar.' : 'Este orçamento ainda não tem rateio: os gastos lançados para o grupo ficam sem divisão até você salvar.'}</p>
      <button type="button" class="btn btn-sm" id="rateioPadraoBtn" style="margin-top:8px;">${ICONS.refresh}Usar percentuais padrão das empresas</button></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveRateioBtn">${ICONS.check}Salvar</button></div>`);
  const form = document.getElementById('rateioForm'), btn = document.getElementById('saveRateioBtn');
  const soma = () => COMPANY_KEYS.reduce((t, k) => t + (Number(form[k].value) || 0), 0);
  const updateHint = () => { const sm = soma(), ok = Math.abs(sm - 100) < 0.005; const hint = document.getElementById('rateioSumHint'); hint.textContent = `Soma atual: ${sm.toFixed(2)}%${ok ? ' ✓' : ' — a soma precisa ser exatamente 100%.'}`; hint.style.color = ok ? 'var(--good)' : 'var(--critical)'; btn.disabled = !ok; };
  form.addEventListener('input', updateHint); updateHint();
  document.getElementById('rateioPadraoBtn').addEventListener('click', () => { COMPANY_KEYS.forEach(k => { form[k].value = Number(padrao(k).toFixed(2)); }); updateHint(); });
  btn.addEventListener('click', () => {
    if (Math.abs(soma() - 100) >= 0.005) return;
    const rateio = {}; COMPANY_KEYS.forEach(k => { const v = (Number(form[k].value) || 0) / 100; if (v > 0) rateio[k] = v; });
    const dolar = Number(form.dolar.value) || budget.dolar;
    closeModal(); salvarRateio(budget, rateio, dolar);
  });
}
async function salvarRateio(budget, rateio, dolar) {
  const payload = { dolar, rateio, categorias: budget.categorias };
  try {
    try { await api('PUT', `/budgets/${budget.id}`, payload); }
    catch (e) {
      if (e.status === 409 && e.data && e.data.requerConfirmacao) {  // rateio já em uso: mostra a prévia e só grava se confirmar
        if (!await confirmarImpactoRateio(e.data.impacto)) return;
        await api('PUT', `/budgets/${budget.id}`, { ...payload, confirmarRecalculo: true });
      } else throw e;
    }
    await reloadBudgets(); toast('Rateio atualizado; orçado e gastos recalculados.', 'success');
  } catch (e) { toast(e.message, 'error'); await reloadBudgets(); }
  renderOrcamento();
}
function confirmarImpactoRateio(imp) {
  return new Promise((resolve) => {
    const seta = (a, d) => `${fmtBRL(a)} <span class="cell-dim">→</span> <strong>${fmtBRL(d)}</strong>`;
    const lin = imp.linhas.map(l => `<tr><td class="cell-strong">${escapeHtml(l.nome)}</td><td>${seta(l.orcadoAntes, l.orcadoDepois)}</td><td>${seta(l.gastoAntes, l.gastoDepois)}</td><td style="color:${l.saldoDepois < -0.005 ? 'var(--critical)' : 'inherit'};">${seta(l.saldoAntes, l.saldoDepois)}</td></tr>`).join('');
    openModal(`<div class="modal-head"><h3>${modalIcon('alert')} Confirmar alteração do rateio — ${imp.ano}</h3></div>
      <div class="modal-body"><p style="font-size:13px;margin-bottom:12px;">O <strong>total já gasto (${fmtBRL(imp.totalGasto)}) não muda</strong>. Muda o orçado de cada empresa e a divisão do que foi lançado para o grupo. Despesas lançadas direto em uma empresa continuam 100% nela.</p>
        ${imp.ficamNegativas.length ? `<div class="alert-box warn">${icon('alert')}<div><strong>Ficarão com saldo negativo:</strong> ${imp.ficamNegativas.map(escapeHtml).join(', ')}.</div></div>` : ''}
        <div class="table-scroll"><table class="data-table" style="font-size:12px;"><thead><tr><th>Empresa</th><th>Orçado (antes → depois)</th><th>Gasto (antes → depois)</th><th>Saldo (antes → depois)</th></tr></thead><tbody>${lin}</tbody></table></div>
        <p class="form-hint" style="margin-top:12px;">A alteração fica registrada na auditoria (quem, quando, percentuais antes e depois).</p></div>
      <div class="modal-foot"><button class="btn" id="impCancel">Cancelar</button><button class="btn btn-primary" id="impOk">${ICONS.check}Confirmar e recalcular</button></div>`, { size: 'lg', locked: true });
    document.getElementById('impCancel').addEventListener('click', () => { closeModal(); resolve(false); });
    document.getElementById('impOk').addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

/* ---- fechamento do ano fiscal ---- */
async function openFechamentoModal() {
  openModal(`<div class="modal-head"><h3>${modalIcon('check')} Fechamento do ano fiscal</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body" id="fechBody">Carregando…</div><div class="modal-foot"><button class="btn" data-close-modal>Fechar janela</button></div>`, { size: 'lg' });
  const pintar = async () => {
    const body = document.getElementById('fechBody'); if (!body) return;
    try {
      const r = await api('GET', '/anos');
      body.innerHTML = `<p class="form-hint" style="margin-bottom:10px;">Um ano <strong>fechado</strong> vira histórico: ninguém altera orçamento, rateio nem lançamentos dele, e não entram solicitações com pagamento nesse ano. Só o Administrador reabre, com justificativa registrada.</p>
        <div class="table-scroll"><table class="data-table" style="font-size:12.5px;"><thead><tr><th>Ano</th><th>Situação</th><th>Orçamentos</th><th>Lançamentos</th><th>Em aberto</th><th></th></tr></thead><tbody>${r.anos.map(a => `<tr><td class="cell-strong">${a.ano}</td>
          <td>${a.fechado ? `<span class="pill pill-crit">Fechado</span> <span class="cell-dim" style="font-size:11px;">${fmtDateTime(a.fechadoEm)} · ${escapeHtml(a.fechadoPor || '')}</span>` : '<span class="pill pill-good">Aberto</span>'}</td>
          <td class="cell-dim">${a.orcamentos}</td><td class="cell-dim">${a.lancamentos}</td><td class="cell-dim">${a.solicitacoesAbertas}</td>
          <td style="text-align:right;">${a.fechado ? `<button class="btn btn-sm" data-reabrir="${a.ano}">Reabrir</button>` : `<button class="btn btn-sm btn-danger" data-fechar="${a.ano}" data-abertas="${a.solicitacoesAbertas}">Fechar ano</button>`}</td></tr>`).join('')}</tbody></table></div>`;
      body.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', async () => {
        const ano = b.dataset.fechar, ab = Number(b.dataset.abertas);
        if (!await confirmDialog({ title: `Fechar o ano fiscal ${ano}`, okLabel: 'Fechar o ano', message: `Depois de fechado, ninguém altera orçamento, rateio nem lançamentos de ${ano}.${ab ? ` Atenção: há ${ab} solicitação(ões) em aberto com pagamento em ${ano}; elas não poderão ser encerradas pelo Financeiro enquanto o ano estiver fechado (devolva-as para corrigir a data).` : ''}` })) { openFechamentoModal(); return; }
        try { const x = await api('POST', `/anos/${ano}/fechar`, { confirmar: true }); DB.anosFechados = x.anosFechados; toast(`Ano ${ano} fechado.`, 'success'); } catch (e) { toast(e.message, 'error'); }
        openFechamentoModal(); renderOrcamento();
      }));
      body.querySelectorAll('[data-reabrir]').forEach(b => b.addEventListener('click', async () => {
        const ano = b.dataset.reabrir;
        const just = await justificativaDialog({ title: `Reabrir o ano fiscal ${ano}`, message: 'A reabertura fica registrada na auditoria com a sua justificativa.', okLabel: 'Reabrir o ano', danger: true });
        if (!just) { openFechamentoModal(); return; }
        try { const x = await api('POST', `/anos/${ano}/reabrir`, { justificativa: just }); DB.anosFechados = x.anosFechados; toast(`Ano ${ano} reaberto.`, 'success'); } catch (e) { toast(e.message, 'error'); }
        openFechamentoModal(); renderOrcamento();
      }));
    } catch (e) { body.textContent = e.message; }
  };
  pintar();
}
function openCategoryForm(catId) {
  const editing = !!catId;
  const c = editing ? findCat(catId) : { id: null, nome: '', categoriasLancamento: [], linhas: [] };
  openModal(`
    <div class="modal-head"><h3>${modalIcon(editing ? 'edit' : 'plus')} ${editing ? 'Editar' : 'Nova'} Categoria Orçamentária</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="catForm"><div class="form-grid">
      <div class="form-field full"><label>Nome da Categoria <span class="req">*</span></label><input class="input" name="nome" required value="${escapeHtml(c.nome)}"/></div>
      <div class="form-field full"><label>Vincular a categorias de Lançamento</label>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">${DB.properties.categorias.map(cat => `<label class="radio-chip"><input type="checkbox" value="${escapeHtml(cat)}" ${(c.categoriasLancamento || []).includes(cat) ? 'checked' : ''}/> ${escapeHtml(cat)}</label>`).join('')}</div>
        <span class="form-hint">Define quais lançamentos (incluindo solicitações aprovadas) contam como "gasto" desta categoria.</span></div></div></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveCatBtn">${ICONS.check}Salvar</button></div>`);
  document.getElementById('saveCatBtn').addEventListener('click', () => {
    const form = document.getElementById('catForm'); if (!form.reportValidity()) return;
    const nome = form.nome.value.trim(); const checked = Array.from(form.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
    if (editing) { c.nome = nome; c.categoriasLancamento = checked; } else currentOrcBudget().categorias.push({ id: 'cat_' + uid(), nome, categoriasLancamento: checked, linhas: [] });
    closeModal(); saveBudget(currentOrcBudget(), 'Categoria salva.');
  });
}
function deleteCategory(catId) { const c = findCat(catId); confirmDialog({ title: 'Excluir categoria', message: `Excluir a categoria "${c?.nome}" e todas as suas linhas/cenários?` }).then(ok => { if (!ok) return; const b = currentOrcBudget(); b.categorias = b.categorias.filter(x => x.id !== catId); saveBudget(b, 'Categoria excluída.'); }); }
function openLinhaForm(catId, linhaId) {
  const editing = !!linhaId; const linha = editing ? findLinha(catId, linhaId) : { id: null, nome: '', cenarios: [] };
  openModal(`<div class="modal-head"><h3>${editing ? 'Renomear' : 'Nova'} Linha Orçamentária</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="linhaForm"><div class="form-field full"><label>Nome da linha <span class="req">*</span></label><input class="input" name="nome" required value="${escapeHtml(linha.nome)}"/></div></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveLinhaBtn">${ICONS.check}Salvar</button></div>`);
  document.getElementById('saveLinhaBtn').addEventListener('click', () => { const form = document.getElementById('linhaForm'); if (!form.reportValidity()) return; const nome = form.nome.value.trim(); const cat = findCat(catId); if (editing) linha.nome = nome; else { cat.linhas = cat.linhas || []; cat.linhas.push({ id: 'linha_' + uid(), nome, cenarios: [] }); } closeModal(); saveBudget(currentOrcBudget(), 'Linha salva.'); });
}
function deleteLinha(catId, linhaId) { confirmDialog({ title: 'Excluir linha', message: 'Excluir esta linha orçamentária e todos os seus cenários?' }).then(ok => { if (!ok) return; const cat = findCat(catId); cat.linhas = cat.linhas.filter(l => String(l.id) !== String(linhaId)); saveBudget(currentOrcBudget(), 'Linha excluída.'); }); }
function openCenarioForm(catId, linhaId, cenId) {
  const editing = !!cenId; const linha = findLinha(catId, linhaId);
  const cen = editing ? linha.cenarios.find(c => String(c.id) === String(cenId)) : { id: null, nome: '', valor: 0, prioridade: 'Média', aprovado: false, observacao: '' };
  openModal(`<div class="modal-head"><h3>${editing ? 'Editar' : 'Novo'} Cenário</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="cenForm"><div class="form-grid">
      <div class="form-field full"><label>Nome do cenário <span class="req">*</span></label><input class="input" name="nome" required value="${escapeHtml(cen.nome)}"/></div>
      <div class="form-field"><label>Valor (R$)</label><input class="input" type="number" step="0.01" name="valor" value="${cen.valor}"/></div>
      <div class="form-field"><label>Prioridade</label><select name="prioridade">${['Necessária', 'Urgente', 'Alta', 'Média', 'Média/Alta', 'Baixa'].map(p => `<option ${p === cen.prioridade ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="form-field full"><label>Observação</label><textarea name="observacao">${escapeHtml(cen.observacao || '')}</textarea></div></div></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveCenBtn">${ICONS.check}Salvar</button></div>`);
  document.getElementById('saveCenBtn').addEventListener('click', () => { const form = document.getElementById('cenForm'); if (!form.reportValidity()) return; const obj = { nome: form.nome.value.trim(), valor: Number(form.valor.value) || 0, prioridade: form.prioridade.value, observacao: form.observacao.value }; if (editing) Object.assign(cen, obj); else { linha.cenarios = linha.cenarios || []; linha.cenarios.push({ id: 'cen_' + uid(), aprovado: linha.cenarios.length === 0, ...obj }); } closeModal(); saveBudget(currentOrcBudget(), 'Cenário salvo.'); });
}
function deleteCenario(catId, linhaId, cenId) { confirmDialog({ title: 'Excluir cenário', message: 'Excluir este cenário orçamentário?' }).then(ok => { if (!ok) return; const linha = findLinha(catId, linhaId); linha.cenarios = linha.cenarios.filter(c => String(c.id) !== String(cenId)); saveBudget(currentOrcBudget(), 'Cenário excluído.'); }); }
