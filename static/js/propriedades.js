/* ===================== NexarPay — Propriedades & Cadastros (Administrador) ===================== */

const PROP_DEFS = [
  { key: 'departamentos', label: 'Departamentos', singular: 'Departamento', ico: 'building', special: true },
  { key: 'categorias', label: 'Categorias', singular: 'Categoria', ico: 'tag', usedField: 'categoria' },
  { key: 'clientes', label: 'Clientes', singular: 'Cliente', ico: 'briefcase', usedField: 'cliente' },
  { key: 'fornecedores', label: 'Fornecedores', singular: 'Fornecedor', ico: 'truck', usedField: 'fornecedor' },
  { key: 'categoriasReembolso', label: 'Categorias de Reembolso', singular: 'Categoria de Reembolso', ico: 'repeat' },
  { key: 'tiposCompra', label: 'Tipos de Compra', singular: 'Tipo de Compra', ico: 'box', usedField: 'tipoCompra' },
  { key: 'empresas', label: 'Empresas', singular: 'Empresa', ico: 'building', special: 'empresas' },
  { key: 'setores', label: 'Setores', singular: 'Setor', ico: 'layers', usedField: 'setor' },
  { key: 'subsetores', label: 'Subsetores', singular: 'Subsetor', ico: 'grid', usedField: 'subsetor' },
];
const propState = { tab: 'departamentos', search: '' };
function usageCount(field, value) { return field ? DB.launches.filter(l => l[field] === value).length : 0; }

function renderPropriedades() {
  const def = PROP_DEFS.find(d => d.key === propState.tab);
  const el = document.getElementById('page-propriedades');
  const tabs = `<div class="tabbar anim-in" style="margin-bottom:18px; flex-wrap:wrap;">${PROP_DEFS.map(d => `<button data-tab="${d.key}" class="${d.key === propState.tab ? 'active' : ''}">${d.label} <span class="cell-dim" style="font-size:11px;">(${d.special === 'empresas' ? DB.empresas.length : d.special ? DB.departamentos.length : (DB.properties[d.key] || []).length})</span></button>`).join('')}</div>`;
  if (def.special === 'empresas') { renderEmpresasTab(el, tabs); return; }
  if (def.special) { renderDepartamentosTab(el, tabs); return; }
  const items = (DB.properties[def.key] || []).slice().sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const filtered = propState.search ? items.filter(i => i.toLowerCase().includes(propState.search.toLowerCase())) : items;
  el.innerHTML = `
    <div class="section-title-row" style="margin-top:0;"><h2>Propriedades &amp; Cadastros</h2><div class="hint">${escapeHtml(def.hint || 'Listas usadas nos formulários de Lançamentos e Solicitações')}</div></div>
    ${tabs}
    <div class="card table-card anim-in">
      <div class="table-toolbar"><div class="search-box">${ICONS.search}<input id="propSearch" placeholder="Buscar ${def.label.toLowerCase()}..." value="${escapeHtml(propState.search)}"/></div><button class="btn btn-primary" id="addPropBtn">${ICONS.plus}Novo ${def.singular}</button></div>
      <div class="table-scroll">${filtered.length ? `<table class="data-table"><thead><tr><th>${def.singular}</th><th>Em uso em</th><th style="text-align:right;">Ações</th></tr></thead>
        <tbody>${filtered.map(v => { const count = usageCount(def.usedField, v); return `<tr><td class="cell-strong">${escapeHtml(v)}</td>
          <td><span class="badge" style="background:color-mix(in srgb, ${count ? cssVar('--c1') : cssVar('--text-faint')} 14%, transparent); color:${count ? cssVar('--c1') : cssVar('--text-faint')};">${def.usedField ? count + ' lançamento(s)' : '—'}</span></td>
          <td><div class="row-actions" style="justify-content:flex-end;"><button class="icon-btn" data-edit-prop="${escapeHtml(v)}" title="Renomear">${ICONS.edit}</button><button class="icon-btn danger" data-del-prop="${escapeHtml(v)}" title="Excluir">${ICONS.trash}</button></div></td></tr>`; }).join('')}</tbody></table>` : emptyState('props', 'Nenhum item cadastrado', `Adicione o primeiro ${def.singular.toLowerCase()}.`)}</div>
    </div>`;
  wireTabs(el);
  document.getElementById('propSearch').addEventListener('input', debounce(e => { propState.search = e.target.value; renderPropriedades(); }, 180));
  document.getElementById('addPropBtn').addEventListener('click', () => openPropForm(def));
  el.querySelectorAll('[data-edit-prop]').forEach(b => b.addEventListener('click', () => openPropForm(def, b.dataset.editProp)));
  el.querySelectorAll('[data-del-prop]').forEach(b => b.addEventListener('click', () => deleteProp(def, b.dataset.delProp)));
}
function wireTabs(el) { el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { propState.tab = b.dataset.tab; propState.search = ''; renderPropriedades(); })); }

async function saveProp(def, valores, renomear) {
  try { await api('PUT', `/properties/${def.key}`, { valores, renomear, campoLancamento: def.usedField }); await reloadProperties(); if (renomear) await reloadLaunches(); }
  catch (e) { toast(e.message, 'error'); }
  renderPropriedades();
}
function openPropForm(def, current) {
  const editing = current !== undefined;
  openModal(`<div class="modal-head"><h3>${modalIcon(editing ? 'edit' : 'plus')} ${editing ? 'Editar' : 'Novo'} ${def.singular}</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="propForm"><div class="form-field full"><label>${def.singular} <span class="req">*</span></label><input class="input" name="valor" required value="${escapeHtml(current || '')}"/></div></form>
      ${editing && def.usedField ? `<p class="form-hint" style="margin-top:10px;">Renomear atualiza automaticamente os ${usageCount(def.usedField, current)} lançamento(s) que usam este valor.</p>` : ''}</div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="savePropBtn">${ICONS.check}Salvar</button></div>`);
  document.getElementById('savePropBtn').addEventListener('click', () => {
    const form = document.getElementById('propForm'); if (!form.reportValidity()) return;
    const valor = form.valor.value.trim(); if (!valor) return;
    const list = (DB.properties[def.key] || []).slice();
    if (editing) { if (valor !== current) { const idx = list.indexOf(current); if (idx > -1) list[idx] = valor; } }
    else { if (list.includes(valor)) { toast('Este item já existe.', 'error'); return; } list.push(valor); }
    closeModal(); saveProp(def, list, editing && valor !== current ? { de: current, para: valor } : null).then(() => toast(`${def.singular} salvo.`, 'success'));
  });
}
function deleteProp(def, value) {
  const count = usageCount(def.usedField, value);
  confirmDialog({ title: `Excluir ${def.singular.toLowerCase()}`, message: count ? `"${value}" está em uso em ${count} lançamento(s). Excluir o cadastro não remove os lançamentos, mas eles ficarão com um valor não cadastrado.` : `Deseja excluir "${value}"?` })
    .then(ok => { if (!ok) return; saveProp(def, (DB.properties[def.key] || []).filter(v => v !== value)).then(() => toast(`${def.singular} excluído.`, 'success')); });
}

/* ---- departamentos ---- */
function renderDepartamentosTab(el, tabs) {
  const deps = DB.departamentos.slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const usersByDep = (id) => DB.users.filter(u => u.ativo && (DB.usersFull ? (DB.usersFull.find(x => x.id === u.id)?.departamentos || []) : []).includes(id)).length;
  el.innerHTML = `
    <div class="section-title-row" style="margin-top:0;"><h2>Propriedades &amp; Cadastros</h2><div class="hint">Cada departamento tem orçamento próprio; usuários podem pertencer a mais de um</div></div>
    ${tabs}
    <div class="card table-card anim-in">
      <div class="table-toolbar"><div class="hint">${deps.length} departamento(s)</div><button class="btn btn-primary" id="addDepBtn">${ICONS.plus}Novo Departamento</button></div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>Departamento</th><th>Orçamentos</th><th>Lançamentos</th><th>Status</th><th style="text-align:right;">Ações</th></tr></thead>
        <tbody>${deps.map(d => `<tr><td class="cell-strong">${escapeHtml(d.nome)}</td>
          <td class="cell-dim">${DB.budgets.filter(b => b.departamentoId === d.id).map(b => b.ano).sort().join(', ') || '—'}</td>
          <td class="cell-dim">${DB.launches.filter(l => l.departamentoId === d.id).length}</td>
          <td><span class="pill ${d.ativo ? 'pill-good' : 'pill-crit'}">${d.ativo ? 'Ativo' : 'Inativo'}</span></td>
          <td><div class="row-actions" style="justify-content:flex-end;"><button class="icon-btn" data-edit-dep="${d.id}" title="Editar">${ICONS.edit}</button><button class="icon-btn danger" data-del-dep="${d.id}" title="Excluir">${ICONS.trash}</button></div></td></tr>`).join('')}</tbody></table></div>
    </div>`;
  wireTabs(el);
  document.getElementById('addDepBtn').addEventListener('click', () => openDepForm());
  el.querySelectorAll('[data-edit-dep]').forEach(b => b.addEventListener('click', () => openDepForm(b.dataset.editDep)));
  el.querySelectorAll('[data-del-dep]').forEach(b => b.addEventListener('click', async () => {
    const d = DB.departamentos.find(x => x.id === b.dataset.delDep);
    if (!await confirmDialog({ title: 'Excluir departamento', message: `Excluir "${d.nome}"? Só é possível se não houver orçamento, lançamentos ou solicitações vinculados.` })) return;
    try { await api('DELETE', `/departamentos/${d.id}`); await reloadDepartamentos(); toast('Departamento excluído.', 'success'); } catch (e) { toast(e.message, 'error'); }
    renderPropriedades();
  }));
}
function openDepForm(id) {
  const d = id ? DB.departamentos.find(x => x.id === id) : { nome: '', ativo: 1 };
  openModal(`<div class="modal-head"><h3>${modalIcon(id ? 'edit' : 'plus')} ${id ? 'Editar' : 'Novo'} Departamento</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="depForm"><div class="form-grid"><div class="form-field full"><label>Nome <span class="req">*</span></label><input class="input" name="nome" required value="${escapeHtml(d.nome)}"/></div>
      ${id ? `<div class="form-field full"><label class="radio-chip"><input type="checkbox" name="ativo" ${d.ativo ? 'checked' : ''}/> Departamento ativo (aparece nos formulários)</label></div>` : ''}</div></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveDepBtn">${ICONS.check}Salvar</button></div>`);
  document.getElementById('saveDepBtn').addEventListener('click', async () => {
    const f = document.getElementById('depForm'); if (!f.reportValidity()) return;
    try { if (id) await api('PUT', `/departamentos/${id}`, { nome: f.nome.value.trim(), ativo: f.ativo.checked }); else await api('POST', '/departamentos', { nome: f.nome.value.trim() }); await reloadDepartamentos(); closeModal(); toast('Departamento salvo.', 'success'); renderPropriedades(); }
    catch (e) { toast(e.message, 'error'); }
  });
}


/* ---- empresas (cadastro único: formulários, rateio e dashboards leem daqui) ---- */
async function renderEmpresasTab(el, tabs) {
  el.innerHTML = `<div class="section-title-row" style="margin-top:0;"><h2>Propriedades &amp; Cadastros</h2></div>${tabs}<div class="card empty-state">${ICONS.clock}<h4>Carregando…</h4></div>`;
  wireTabs(el);
  let pend = null;
  try { const r = await reloadEmpresas(); pend = r.pendencias || null; } catch (e) { toast(e.message, 'error'); }
  if (propState.tab !== 'empresas') return;
  const emps = DB.empresas.slice();
  const soma = emps.filter(e => e.ativa && e.participaRateio).reduce((t, e) => t + (Number(e.rateioPadrao) || 0), 0);
  const nPart = emps.filter(e => e.ativa && e.participaRateio).length;
  const uso = (id) => DB.launches.filter(l => l.empresaId === id).length;
  const pendHtml = pend && (pend.solicitacoes.length || pend.lancamentos) ? `<div class="alert-box warn">${ICONS.alert}<div><strong>Registros sem empresa (a empresa agora é obrigatória)</strong><br/>${pend.solicitacoes.length ? 'Solicitações: ' + pend.solicitacoes.map(x => escapeHtml(x.numero) + ' (' + escapeHtml(x.status) + ')').join(', ') + '. Quem aprova deve usar <em>Alterar</em> para devolvê-las ao solicitante informar a empresa.' : ''}${pend.lancamentos ? `<br/>${pend.lancamentos} lançamento(s) sem empresa: edite-os em Lançamentos.` : ''}</div></div>` : '';
  el.innerHTML = `
    <div class="section-title-row" style="margin-top:0;"><h2>Propriedades &amp; Cadastros</h2><div class="hint">Empresas do cliente: usadas nas solicitações, nos lançamentos, no rateio do orçamento e nos dashboards</div></div>
    ${tabs}${pendHtml}
    <div class="card anim-in" style="padding:16px 18px; margin-bottom:14px;">
      <div class="form-grid"><div class="form-field"><label>Nome do grupo</label><input class="input" id="grupoNomeInput" value="${escapeHtml(DB.grupoNome || '')}" placeholder="Ex.: Grupo Gpac"/></div>
      <div class="form-field" style="justify-content:flex-end;"><button class="btn" id="saveGrupoBtn">${ICONS.check}Salvar nome do grupo</button></div></div>
      <p class="form-hint" style="margin-top:10px;"><strong>Regras:</strong> com <strong>duas ou mais</strong> empresas no rateio, os formulários oferecem a opção "<strong>${escapeHtml(DB.grupoNome || 'Grupo')}</strong>": a despesa é dividida entre as empresas pelo rateio do orçamento do departamento. Ao escolher uma empresa específica, o valor é abatido 100% dela. Com uma empresa só, a opção do grupo não aparece. O percentual padrão é o ponto de partida do rateio ao criar um orçamento.</p>
    </div>
    <div class="card table-card anim-in">
      <div class="table-toolbar"><div class="hint">${emps.length} empresa(s) · soma dos percentuais padrão das que participam do rateio: <strong style="color:${Math.abs(soma - 100) < 0.01 || !nPart ? cssVar('--good') : cssVar('--critical')};">${fmtNum(soma, 2)}%</strong>${nPart && Math.abs(soma - 100) >= 0.01 ? ' (deveria somar 100%)' : ''}</div><button class="btn btn-primary" id="addEmpBtn">${ICONS.plus}Nova Empresa</button></div>
      <div class="table-scroll">${emps.length ? `<table class="data-table"><thead><tr><th>Empresa</th><th>Rateio padrão</th><th>Participa do rateio</th><th>Lançamentos</th><th>Status</th><th style="text-align:right;">Ações</th></tr></thead>
        <tbody>${emps.map(e => `<tr><td class="cell-strong">${escapeHtml(e.nome)}</td><td>${e.participaRateio ? fmtNum(e.rateioPadrao, 2) + '%' : '—'}</td><td>${e.participaRateio ? 'Sim' : 'Não'}</td><td class="cell-dim">${uso(e.id)}</td>
          <td><span class="pill ${e.ativa ? 'pill-good' : 'pill-crit'}">${e.ativa ? 'Ativa' : 'Inativa'}</span></td>
          <td><div class="row-actions" style="justify-content:flex-end;"><button class="icon-btn" data-edit-emp="${escapeHtml(e.id)}" title="Editar">${ICONS.edit}</button><button class="icon-btn danger" data-del-emp="${escapeHtml(e.id)}" title="Excluir">${ICONS.trash}</button></div></td></tr>`).join('')}</tbody></table>` : emptyState('building', 'Nenhuma empresa cadastrada', 'Cadastre ao menos uma empresa para poder criar solicitações e lançamentos.')}</div>
    </div>`;
  wireTabs(el);
  document.getElementById('saveGrupoBtn').addEventListener('click', async () => { try { await api('PUT', '/empresas/grupo', { nome: document.getElementById('grupoNomeInput').value }); await reloadEmpresas(); toast('Nome do grupo salvo.', 'success'); renderPropriedades(); } catch (e) { toast(e.message, 'error'); } });
  document.getElementById('addEmpBtn').addEventListener('click', () => openEmpForm());
  el.querySelectorAll('[data-edit-emp]').forEach(b => b.addEventListener('click', () => openEmpForm(b.dataset.editEmp)));
  el.querySelectorAll('[data-del-emp]').forEach(b => b.addEventListener('click', async () => {
    const e = DB.empresas.find(x => x.id === b.dataset.delEmp);
    if (!await confirmDialog({ title: 'Excluir empresa', message: `Excluir "${e.nome}"? Só é possível se ela nunca foi usada em lançamentos, solicitações ou rateio (senão, desative).` })) return;
    try { await api('DELETE', `/empresas/${e.id}`); await reloadEmpresas(); toast('Empresa excluída.', 'success'); } catch (er) { toast(er.message, 'error'); }
    renderPropriedades();
  }));
}
function openEmpForm(id) {
  const e = id ? DB.empresas.find(x => x.id === id) : { nome: '', ativa: true, participaRateio: true, rateioPadrao: 0 };
  openModal(`<div class="modal-head"><h3>${modalIcon(id ? 'edit' : 'plus')} ${id ? 'Editar' : 'Nova'} Empresa</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="empForm"><div class="form-grid">
      <div class="form-field full"><label>Nome <span class="req">*</span></label><input class="input" name="nome" required value="${escapeHtml(e.nome)}"/></div>
      <div class="form-field"><label>Percentual padrão do rateio (%)</label><input class="input" type="number" min="0" max="100" step="0.01" name="pct" value="${e.rateioPadrao || 0}"/></div>
      <div class="form-field" style="display:flex;flex-direction:column;gap:8px;justify-content:flex-end;">
        <label class="radio-chip"><input type="checkbox" name="participa" ${e.participaRateio ? 'checked' : ''}/> Participa do rateio</label>
        ${id ? `<label class="radio-chip"><input type="checkbox" name="ativa" ${e.ativa ? 'checked' : ''}/> Empresa ativa (aparece nos formulários)</label>` : ''}</div>
    </div></form>
    <p class="form-hint" style="margin-top:10px;">Renomear atualiza o nome em todo o histórico. Alterar o percentual padrão não muda orçamentos já criados. Os percentuais das empresas que participam devem somar 100%.</p></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveEmpBtn">${ICONS.check}Salvar</button></div>`);
  document.getElementById('saveEmpBtn').addEventListener('click', async () => {
    const f = document.getElementById('empForm'); if (!f.reportValidity()) return;
    const body = { nome: f.nome.value.trim(), rateioPadrao: Number(f.pct.value) || 0, participaRateio: f.participa.checked, ativa: id ? f.ativa.checked : true };
    try { if (id) await api('PUT', `/empresas/${id}`, body); else await api('POST', '/empresas', body); await reloadEmpresas(); closeModal(); toast('Empresa salva.', 'success'); renderPropriedades(); }
    catch (er) { toast(er.message, 'error'); }
  });
}
