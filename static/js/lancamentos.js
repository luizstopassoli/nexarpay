/* ===================== NexarPay — Lançamentos (por departamento; manuais e gerados por solicitações aprovadas) ===================== */

const lancState = { search: '', categoria: '', empresa: '', ano: '', dep: '', origem: '', page: 1, pageSize: 10, sortKey: 'dataCompra', sortDir: 'desc' };
function podeLancar() { return ['admin', 'gestor'].includes(perfil()); }
function podeEditarLancamento(l) { if (anoFechado(l.ano)) return false; if (isAdmin()) return true; return perfil() === 'gestor' && meusDeps().includes(l.departamentoId); }

function filteredLaunches() {
  let list = DB.launches.slice();
  const q = lancState.search.trim().toLowerCase();
  if (q) list = list.filter(l => [l.descricao, l.fornecedor, l.usadoPor, l.setor, l.categoria, l.solicitacaoNumero, l.cliente].filter(Boolean).join(' ').toLowerCase().includes(q));
  if (lancState.categoria) list = list.filter(l => l.categoria === lancState.categoria);
  if (lancState.empresa) list = list.filter(l => l.empresa === lancState.empresa);
  if (lancState.ano) list = list.filter(l => String(l.ano) === lancState.ano);
  if (lancState.dep) list = list.filter(l => l.departamentoId === lancState.dep);
  if (lancState.origem === 'sol') list = list.filter(l => l.solicitacaoId);
  if (lancState.origem === 'manual') list = list.filter(l => !l.solicitacaoId);
  list.sort((a, b) => {
    const k = lancState.sortKey; let va = a[k], vb = b[k];
    if (k === 'custoTotal' || k === 'quantidade') { va = Number(va) || 0; vb = Number(vb) || 0; } else { va = (va || '').toString(); vb = (vb || '').toString(); }
    const cmp = va > vb ? 1 : va < vb ? -1 : 0; return lancState.sortDir === 'asc' ? cmp : -cmp;
  });
  return list;
}
function categoryBadgeColor(cat) { const idx = (DB.properties.categorias || []).indexOf(cat); return colorForIndex(idx < 0 ? 0 : idx); }

function renderLancamentos() {
  const all = filteredLaunches();
  const totalPages = Math.max(1, Math.ceil(all.length / lancState.pageSize));
  lancState.page = clamp(lancState.page, 1, totalPages);
  const pageItems = all.slice((lancState.page - 1) * lancState.pageSize, lancState.page * lancState.pageSize);
  const el = document.getElementById('page-lancamentos');
  const deps = depsVisiveis();
  el.innerHTML = `
    <div class="section-title-row" style="margin-top:0;">
      <h2>Lançamentos de Gastos</h2>
      <div class="hint">${all.length} de ${DB.launches.length} lançamentos · ${fmtBRL(all.reduce((s, l) => s + (Number(l.custoTotal) || 0), 0))} filtrado</div>
    </div>
    <div class="card table-card anim-in">
      <div class="table-toolbar">
        <div class="search-box">${ICONS.search}<input id="lancSearch" placeholder="Buscar por descrição, fornecedor, nº da solicitação…" value="${escapeHtml(lancState.search)}"/></div>
        <select id="filtDep"><option value="">Departamento (todos)</option>${selectOptions(deps, lancState.dep)}</select>
        <select id="filtCategoria"><option value="">Categoria (todas)</option>${selectOptions(DB.properties.categorias || [], lancState.categoria)}</select>
        <select id="filtAno"><option value="">Ano (todos)</option>${availableYears().map(y => `<option ${String(y) === lancState.ano ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <select id="filtOrigem"><option value="">Origem (todas)</option><option value="sol" ${lancState.origem === 'sol' ? 'selected' : ''}>Solicitações aprovadas</option><option value="manual" ${lancState.origem === 'manual' ? 'selected' : ''}>Lançamentos manuais</option></select>
        ${podeLancar() ? `<button class="btn btn-primary" id="btnNovoLancamento">${ICONS.plus}Novo Lançamento</button>` : ''}
      </div>
      <div class="table-scroll">${pageItems.length ? `
        <table class="data-table">
          <thead><tr><th data-sort="descricao">Descrição</th><th>Departamento</th><th data-sort="categoria">Categoria</th><th data-sort="fornecedor">Fornecedor</th><th data-sort="empresa">Empresa</th><th data-sort="dataCompra">Data</th><th data-sort="custoTotal">Custo Total</th><th>Nº Pedido / Recibo</th><th>Nota Fiscal</th><th style="text-align:right;">Ações</th></tr></thead>
          <tbody>${pageItems.map(l => `<tr>
              <td class="cell-strong" style="white-space:normal; min-width:220px;">${escapeHtml(l.descricao || '—')}${l.solicitacaoNumero ? `<div class="cell-dim" style="font-size:11px;">${ICONS.send ? '' : ''}Solicitação ${escapeHtml(l.solicitacaoNumero)}</div>` : ''}</td>
              <td><span class="dept-chip">${escapeHtml(depNome(l.departamentoId))}</span></td>
              <td><span class="badge" style="background:color-mix(in srgb, ${categoryBadgeColor(l.categoria)} 16%, transparent); color:${categoryBadgeColor(l.categoria)};"><span class="badge-dot" style="background:${categoryBadgeColor(l.categoria)}"></span>${escapeHtml(l.categoria || '—')}</span></td>
              <td class="cell-dim" style="max-width:200px; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(l.fornecedor || '—')}</td>
              <td>${escapeHtml(l.empresa || '—')}</td>
              <td class="cell-dim">${fmtDate(l.dataCompra)}</td>
              <td class="cell-num">${fmtBRL(l.custoTotal)}</td>
              <td>${fileChip(l.numPedido, l.id, 'numPedido')}</td>
              <td>${fileChip(l.notaFiscal, l.id, 'notaFiscal')}</td>
              <td><div class="row-actions" style="justify-content:flex-end;">
                <button class="icon-btn" data-view="${l.id}" title="Visualizar">${ICONS.eye}</button>
                ${podeEditarLancamento(l) ? `<button class="icon-btn" data-edit="${l.id}" title="Editar">${ICONS.edit}</button>` : ''}
                ${podeEditarLancamento(l) && (!l.solicitacaoId || isAdmin()) ? `<button class="icon-btn danger" data-del="${l.id}" title="Excluir">${ICONS.trash}</button>` : ''}
              </div></td></tr>`).join('')}</tbody></table>` : emptyState('list', 'Nenhum lançamento encontrado', 'Ajuste os filtros ou cadastre um novo lançamento.')}</div>
      <div class="table-pagination"><span>Mostrando ${pageItems.length ? ((lancState.page - 1) * lancState.pageSize + 1) : 0}–${(lancState.page - 1) * lancState.pageSize + pageItems.length} de ${all.length}</span>
        <div class="pg-btns"><button class="btn btn-sm" id="pgPrev" ${lancState.page <= 1 ? 'disabled' : ''}>Anterior</button><button class="btn btn-sm" id="pgNext" ${lancState.page >= totalPages ? 'disabled' : ''}>Próxima</button></div></div>
    </div>`;
  document.getElementById('lancSearch').addEventListener('input', debounce(e => { lancState.search = e.target.value; lancState.page = 1; renderLancamentos(); }, 200));
  ['filtDep:dep', 'filtCategoria:categoria', 'filtAno:ano', 'filtOrigem:origem'].forEach(pair => { const [id, k] = pair.split(':'); document.getElementById(id).addEventListener('change', e => { lancState[k] = e.target.value; lancState.page = 1; renderLancamentos(); }); });
  const nb = document.getElementById('btnNovoLancamento'); if (nb) nb.addEventListener('click', () => openLaunchForm());
  document.getElementById('pgPrev').addEventListener('click', () => { lancState.page--; renderLancamentos(); });
  document.getElementById('pgNext').addEventListener('click', () => { lancState.page++; renderLancamentos(); });
  el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => viewLaunch(Number(b.dataset.view))));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openLaunchForm(Number(b.dataset.edit))));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteLaunch(Number(b.dataset.del))));
  el.querySelectorAll('[data-sort]').forEach(th => th.addEventListener('click', () => { const k = th.dataset.sort; if (lancState.sortKey === k) lancState.sortDir = lancState.sortDir === 'asc' ? 'desc' : 'asc'; else { lancState.sortKey = k; lancState.sortDir = 'asc'; } renderLancamentos(); }));
}

// O chip guarda só (id do lançamento, campo); o objeto é buscado em DB no clique.
function fileChip(fileObj, launchId, field) {
  if (!fileObj) return `<span class="file-chip">${ICONS.upload}Sem arquivo</span>`;
  const label = fileObj.tipo === 'link' ? 'Link' : fileObj.tipo === 'recibo' ? 'Recibo' : (fileObj.nome ? fileObj.nome.slice(0, 14) : 'arquivo');
  return `<span class="file-chip has-file" data-openfile-id="${escapeHtml(launchId)}" data-openfile-field="${escapeHtml(field)}">${fileObj.tipo === 'link' ? ICONS.link : ICONS.file}${escapeHtml(label)}</span>`;
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-openfile-id]');
  if (!chip) return;
  const l = DB.launches.find(x => String(x.id) === chip.dataset.openfileId);
  const f = l && l[chip.dataset.openfileField];
  if (f) openFilePreview(f);
});
function openFilePreview(f) {
  if (!f) return;
  if (f.tipo === 'link') { if (/^https?:\/\//i.test(f.url || '')) window.open(f.url, '_blank', 'noopener,noreferrer'); else toast('Link inválido.', 'error'); return; }
  if (f.tipo === 'servidor') { window.open(fileUrl(f.id), '_blank'); return; }
  if (f.tipo === 'recibo') { window.open(`/api/solicitacoes/${f.solicitacaoId}/recibo`, '_blank'); return; }
  if (f.tipo === 'arquivo' && f.dataUrl) {
    const m = /^data:(application\/pdf|image\/png|image\/jpeg);base64,([A-Za-z0-9+\/=]+)$/i.exec(f.dataUrl);
    if (!m) { toast('Arquivo embutido inválido.', 'error'); return; }
    const bin = atob(m[2]); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    window.open(URL.createObjectURL(new Blob([arr], { type: m[1] })), '_blank', 'noopener');
  }
}

async function deleteLaunch(id) {
  const l = DB.launches.find(x => x.id === id);
  if (!await confirmDialog({ title: 'Excluir lançamento', message: `Deseja excluir "${l?.descricao || ''}"? Esta ação não pode ser desfeita.` })) return;
  try { await api('DELETE', `/launches/${id}`); await reloadLaunches(); renderLancamentos(); toast('Lançamento excluído.', 'success'); } catch (e) { toast(e.message, 'error'); }
}

function viewLaunch(id) {
  const l = DB.launches.find(x => x.id === id); if (!l) return;
  const rows = [['Descrição', l.descricao], ['Departamento', depNome(l.departamentoId)], ['Quantidade', l.quantidade], ['Categoria', l.categoria], ['Fornecedor', l.fornecedor], ['Cliente', l.cliente || '—'],
    ['Custo Aquisição (R$)', fmtBRL(l.custoAquisicaoBRL)], ['Custo Aquisição (US$)', (l.custoAquisicaoUSD || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })], ['Custo Total', fmtBRL(l.custoTotal)],
    ['Data da Compra', fmtDate(l.dataCompra)], ['Ano', l.ano || '—'], ['Tipo de Compra', l.tipoCompra], ['Data de Vencimento', fmtDate(l.dataVencimento)], ['Empresa', l.empresa], ['Usado Por', l.usadoPor], ['Setor', l.setor], ['Subsetor', l.subsetor || '—'],
    ['Usuário (Conta de Acesso)', l.usuarioConta || (l.usuarioContaDefinida ? '(restrito)' : '—')], ['Para que Serve?', l.paraQueServe || '—'], ['Origem', l.solicitacaoNumero ? 'Solicitação ' + l.solicitacaoNumero : 'Lançamento manual']];
  openModal(`
    <div class="modal-head"><h3>${modalIcon('eye')} Detalhes do Lançamento</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><div class="form-grid">
      ${rows.map(([k, v]) => `<div class="form-field ${['Descrição', 'Para que Serve?'].includes(k) ? 'full' : ''}"><label>${k}</label><div class="cell-strong" style="font-size:13px; font-weight:600;">${escapeHtml(v ?? '—')}</div></div>`).join('')}
      <div class="form-field"><label>Senha / Serial</label><div style="display:flex;gap:8px;align-items:center;"><span id="segTxt" class="cell-strong" style="font-size:13px;font-weight:600;">${l.senhaSerialDefinida ? '••••••••' : '—'}</span>${l.senhaSerialDefinida && ['admin', 'gestor'].includes(DB.user.perfil) ? '<button class="btn btn-sm" id="segBtn" type="button">Revelar</button>' : ''}</div><span class="form-hint">A consulta fica registrada na trilha de auditoria.</span></div>
      <div class="form-field"><label>Nº Pedido / Recibo</label>${fileChip(l.numPedido, l.id, 'numPedido')}</div>
      <div class="form-field"><label>Nota Fiscal / Invoice</label>${fileChip(l.notaFiscal, l.id, 'notaFiscal')}</div>
    </div></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Fechar</button>${podeEditarLancamento(l) ? `<button class="btn btn-primary" id="viewEditBtn">${ICONS.edit}Editar</button>` : ''}${l.solicitacaoId ? `<button class="btn" id="viewSolBtn">${ICONS.send}Abrir solicitação</button>` : ''}</div>`, { size: 'lg' });
  const sg = document.getElementById('segBtn'); if (sg) sg.addEventListener('click', async () => { try { const r = await api('GET', `/launches/${id}/segredo`); const t = document.getElementById('segTxt'); t.textContent = r.senhaSerial || '—'; sg.remove(); setTimeout(() => { if (t.isConnected) t.textContent = '••••••••'; }, 15000); } catch (e) { toast(e.message, 'error'); } });
  const eb = document.getElementById('viewEditBtn'); if (eb) eb.addEventListener('click', () => { closeModal(); setTimeout(() => openLaunchForm(id), 200); });
  const sb = document.getElementById('viewSolBtn'); if (sb) sb.addEventListener('click', () => { closeModal(); setTimeout(() => openSolicitacao(l.solicitacaoId), 200); });
}

function openLaunchForm(id) {
  const editing = id !== undefined;
  const deps = depsVisiveis();
  const l = editing ? DB.launches.find(x => x.id === id) : {
    id: null, descricao: '', quantidade: 1, categoria: DB.properties.categorias[0] || '', fornecedor: DB.properties.fornecedores[0] || '', custoAquisicaoBRL: 0, custoAquisicaoUSD: 0, custoTotal: 0,
    dataCompra: todayISO(), ano: new Date().getFullYear(), tipoCompra: DB.properties.tiposCompra[0] || '', dataVencimento: '', empresaId: '', usadoPor: '', setor: DB.properties.setores[0] || '',
    subsetor: '', usuarioConta: '', senhaSerial: '', paraQueServe: '', numPedido: null, notaFiscal: null, departamentoId: deps[0] ? deps[0].id : '',
  };
  const P = DB.properties;
  const opts = (arr, sel) => arr.map(v => `<option value="${escapeHtml(v)}" ${v === sel ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  openModal(`
    <div class="modal-head"><h3>${modalIcon(editing ? 'edit' : 'plus')} ${editing ? 'Editar' : 'Novo'} Lançamento</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="launchForm"><div class="form-grid">
      <div class="form-field full"><label>Descrição <span class="req">*</span></label><input class="input" name="descricao" required value="${escapeHtml(l.descricao)}"/></div>
      <div class="form-field"><label>Departamento <span class="req">*</span></label><select name="departamentoId" required>${selectOptions(deps, l.departamentoId)}</select></div>
      <div class="form-field"><label>Quantidade</label><input class="input" type="number" min="0" step="1" name="quantidade" value="${l.quantidade || 0}"/></div>
      <div class="form-field"><label>Categoria</label><select name="categoria">${opts(P.categorias, l.categoria)}</select></div>
      <div class="form-field"><label>Fornecedor</label><select name="fornecedor">${opts(P.fornecedores, l.fornecedor)}</select></div>
      <div class="form-field"><label>Custo Aquisição (R$)</label><input class="input" type="number" step="0.01" name="custoAquisicaoBRL" value="${l.custoAquisicaoBRL || 0}"/></div>
      <div class="form-field"><label>Custo Aquisição (US$)</label><input class="input" type="number" step="0.01" name="custoAquisicaoUSD" value="${l.custoAquisicaoUSD || 0}"/></div>
      <div class="form-field"><label>Custo Total (R$)</label><input class="input" type="number" step="0.01" name="custoTotal" value="${l.custoTotal || 0}"/><span class="form-hint">Preenchido automaticamente a partir do custo em R$ — ajuste se necessário.</span></div>
      <div class="form-field"><label>Tipo de Compra</label><select name="tipoCompra">${opts(P.tiposCompra, l.tipoCompra)}</select></div>
      <div class="form-field"><label>Data da Compra</label><input class="input" type="date" name="dataCompra" value="${l.dataCompra || ''}"/></div>
      <div class="form-field"><label>Data de Vencimento</label><input class="input" type="date" name="dataVencimento" value="${l.dataVencimento || ''}"/></div>
      <div class="form-field"><label>Empresa <span class="req">*</span></label><select name="empresaId" required><option value="">Selecione…</option>${selectOptions(empresaOptions(l.empresaId), l.empresaId)}</select></div>
      <div class="form-field"><label>Setor</label><select name="setor">${opts(P.setores, l.setor)}</select></div>
      <div class="form-field"><label>Subsetor</label><select name="subsetor"><option value="">—</option>${opts(P.subsetores, l.subsetor)}</select></div>
      <div class="form-field"><label>Usado Por</label><input class="input" name="usadoPor" value="${escapeHtml(l.usadoPor || '')}"/></div>
      <div class="form-field"><label>Usuário (Conta de Acesso)</label><input class="input" name="usuarioConta" value="${escapeHtml(l.usuarioConta || '')}"/></div>
      <div class="form-field"><label>Senha / Serial</label><input class="input" type="password" name="senhaSerial" value="" placeholder="${l.senhaSerialDefinida ? '(definida — deixe em branco para manter)' : ''}" autocomplete="new-password"/>${l.senhaSerialDefinida ? '<label class="radio-chip" style="margin-top:6px;"><input type="checkbox" name="limparSenhaSerial"/> Remover a senha/serial atual</label>' : ''}</div>
      <div class="form-field full"><label>Para que Serve?</label><textarea name="paraQueServe">${escapeHtml(l.paraQueServe || '')}</textarea></div>
      <div class="form-field"><label>Nº Pedido / Recibo</label>${uploadSlotHtml('numPedido', l.numPedido)}</div>
      <div class="form-field"><label>Nota Fiscal / Invoice</label>${uploadSlotHtml('notaFiscal', l.notaFiscal)}</div>
      <input type="file" id="fileInput_numPedido" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" style="display:none;"/>
      <input type="file" id="fileInput_notaFiscal" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" style="display:none;"/>
    </div></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveLaunchBtn">${ICONS.check}Salvar Lançamento</button></div>`, { size: 'lg' });

  const pending = { numPedido: l.numPedido || null, notaFiscal: l.notaFiscal || null };
  const wireSlot = (field) => {
    const slot = document.getElementById(`uploadSlot_${field}`);
    slot.addEventListener('click', (e) => { if (e.target.closest('.upload-remove')) { pending[field] = null; refreshSlot(field); return; } document.getElementById(`fileInput_${field}`).click(); });
  };
  const refreshSlot = (field) => { document.getElementById(`uploadSlot_${field}`).outerHTML = uploadSlotHtml(field, pending[field]); wireSlot(field); };
  ['numPedido', 'notaFiscal'].forEach(field => {
    wireSlot(field);
    document.getElementById(`fileInput_${field}`).addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { const a = await uploadFile(file); pending[field] = { tipo: 'servidor', id: a.id, nome: a.nome, size: a.tamanho }; refreshSlot(field); toast('Arquivo anexado.', 'success'); } catch (err) { toast(err.message, 'error'); }
      e.target.value = '';
    });
  });
  const form = document.getElementById('launchForm');
  form.custoAquisicaoBRL.addEventListener('input', () => { if (!editing) form.custoTotal.value = (Number(form.custoAquisicaoBRL.value) || 0).toFixed(2); });
  document.getElementById('saveLaunchBtn').addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const obj = Object.fromEntries(new FormData(form).entries());
    ['quantidade', 'custoAquisicaoBRL', 'custoAquisicaoUSD', 'custoTotal'].forEach(k => obj[k] = Number(obj[k]) || 0);
    obj.ano = obj.dataCompra ? Number(obj.dataCompra.slice(0, 4)) : (l.ano || new Date().getFullYear());
    obj.numPedido = pending.numPedido; obj.notaFiscal = pending.notaFiscal;
    const depId = obj.departamentoId; delete obj.departamentoId;
    if (editing) { obj.solicitacaoNumero = l.solicitacaoNumero; obj.cliente = l.cliente; }
    try {
      if (editing) await api('PUT', `/launches/${id}`, { departamentoId: depId, dados: obj }); else await api('POST', '/launches', { departamentoId: depId, dados: obj });
      await reloadLaunches(); closeModal(); renderLancamentos(); toast(editing ? 'Lançamento atualizado.' : 'Lançamento cadastrado.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
}
function uploadSlotHtml(field, f) {
  if (f) {
    const label = f.tipo === 'link' ? 'Link externo (legado)' : f.tipo === 'recibo' ? f.nome : f.nome;
    const sub = f.tipo === 'link' ? 'Google Drive' : f.tipo === 'recibo' ? 'Recibo de aprovação (PDF)' : humanFileSize(f.size);
    return `<div class="upload-slot filled" id="uploadSlot_${field}"><div class="upload-ico">${f.tipo === 'link' ? ICONS.link : ICONS.file}</div><div class="upload-text"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(sub)}</span></div><div class="upload-remove" data-field="${field}" title="Remover">${ICONS.x}</div></div>`;
  }
  return `<div class="upload-slot" id="uploadSlot_${field}"><div class="upload-ico">${ICONS.upload}</div><div class="upload-text"><strong>Enviar arquivo</strong><span>PDF, DOCX, XLSX, PNG ou JPEG (máx. ${DB.config.maxUploadMB || 20} MB)</span></div></div>`;
}
