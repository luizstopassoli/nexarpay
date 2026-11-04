/* ===================== NexarPay — Relatórios (filtros, prévia, Excel/PDF, e-mail, agendamento, filtros salvos, colunas do cliente) ===================== */

const relState = { cat: [], rid: null, filtros: {}, colunas: null, resultado: null, salvos: [], agenda: [], podeConfigurar: false, carregando: false };
const REL_ICONES = { solicitacoes: 'list', orcado_realizado: 'budget', rateio_empresa: 'scale', aprovacoes: 'clock', agenda: 'wallet', doc_fiscal: 'fileText' };

function relAtual() { return relState.cat.find(r => r.id === relState.rid); }

async function renderRelatorios() {
  const el = document.getElementById('page-relatorios');
  el.innerHTML = `<div class="empty-state">${ICONS.clock}<h4>Carregando relatórios…</h4></div>`;
  try {
    const d = await api('GET', '/relatorios');
    relState.cat = d.relatorios; relState.salvos = d.filtrosSalvos; relState.agenda = d.agendamentos; relState.podeConfigurar = d.podeConfigurar;
  } catch (e) { el.innerHTML = emptyState('alert', 'Não foi possível carregar', e.message); return; }
  if (currentPage !== 'relatorios') return;
  paintRelatorios();
}

function paintRelatorios() {
  const el = document.getElementById('page-relatorios');
  if (!relState.rid) { paintCatalogoRelatorios(el); return; }
  paintConstrutorRelatorio(el);
}

/* ---------- catálogo ---------- */
function paintCatalogoRelatorios(el) {
  el.innerHTML = `
    <div class="section-title-row" style="margin-top:0;"><h2>Relatórios</h2><div class="hint">Escolha um relatório, ajuste os filtros e exporte em Excel ou PDF</div></div>
    <div class="grid grid-3 anim-in">${relState.cat.map(r => `
      <div class="card hoverable" data-rel="${escapeHtml(r.id)}" style="padding:16px 18px; cursor:pointer;">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;"><span class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c1')} 18%, transparent); color:${cssVar('--c1')};">${ICONS[REL_ICONES[r.id]] || ICONS.list}</span><strong style="font-size:14px;">${escapeHtml(r.titulo)}</strong></div>
        <p class="form-hint" style="margin:6px 0 10px; line-height:1.5;">${escapeHtml(r.descricao)}</p>
        <span class="badge">${escapeHtml(r.publico)}</span>
      </div>`).join('')}</div>
    ${relState.agenda.length ? `<div class="section-title-row"><h2>${icon('clock')} Meus envios agendados</h2><div class="hint">Enviados por e-mail uma vez por mês</div></div>
      <div class="card table-card anim-in"><div class="table-scroll"><table class="data-table"><thead><tr><th>Relatório</th><th>Dia do mês</th><th>Formatos</th><th>Outros destinatários</th><th>Último envio</th><th></th></tr></thead><tbody>
      ${relState.agenda.map(a => `<tr><td class="cell-strong">${escapeHtml(a.titulo)}</td><td>${a.dia}</td><td>${a.formatos.map(f => f === 'xlsx' ? 'Excel' : 'PDF').join(' + ')}</td><td class="cell-dim">${escapeHtml((a.destinatarios || []).join(', ') || '—')}</td><td class="cell-dim">${a.ultimoEnvio ? fmtDate(a.ultimoEnvio) : '—'}</td><td><button class="icon-btn danger" data-del-agenda="${a.id}" title="Cancelar envio">${ICONS.trash}</button></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
    <div class="footer-note">O "realizado" considera as solicitações encerradas pelo Financeiro; o ano vem da data de pagamento. Diretoria e Financeiro veem todos os departamentos; Gestor e RH, só os seus.</div>`;
  el.querySelectorAll('[data-rel]').forEach(c => c.addEventListener('click', () => abrirRelatorio(c.dataset.rel)));
  el.querySelectorAll('[data-del-agenda]').forEach(b => b.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Cancelar envio agendado', message: 'Este relatório deixará de ser enviado por e-mail todo mês.', okLabel: 'Cancelar envio' })) return;
    try { await api('DELETE', `/relatorios/_agenda/${b.dataset.delAgenda}`); toast('Envio cancelado.', 'success'); renderRelatorios(); } catch (e) { toast(e.message, 'error'); }
  }));
}

function abrirRelatorio(rid) {
  relState.rid = rid; relState.resultado = null;
  const r = relAtual();
  relState.filtros = {};
  r.filtros.forEach(c => { if (c.tipo === 'periodo') relState.filtros.periodo = 'mes_atual'; else if (c.padrao !== undefined) relState.filtros[c.id] = c.padrao; });
  relState.colunas = r.colunasPadrao.slice();
  paintRelatorios();
}

/* ---------- construtor ---------- */
function controleHtml(c) {
  const v = relState.filtros[c.id];
  if (c.tipo === 'periodo') {
    const p = relState.filtros.periodo || 'mes_atual';
    return `<div class="form-field"><label>${escapeHtml(c.label)}</label><select data-f="periodo">${selectOptions(c.opcoes, p)}</select></div>
      <div class="form-field rel-datas" style="${p === 'personalizado' ? '' : 'display:none;'}"><label>De</label><input class="input" type="date" data-f="de" value="${escapeHtml(relState.filtros.de || '')}"/></div>
      <div class="form-field rel-datas" style="${p === 'personalizado' ? '' : 'display:none;'}"><label>Até</label><input class="input" type="date" data-f="ate" value="${escapeHtml(relState.filtros.ate || '')}"/></div>`;
  }
  if (c.tipo === 'select') return `<div class="form-field"><label>${escapeHtml(c.label)}</label><select data-f="${escapeHtml(c.id)}">${selectOptions(c.opcoes, v === undefined ? (c.padrao || '') : v)}</select></div>`;
  if (c.tipo === 'checkbox') return `<div class="form-field" style="justify-content:flex-end;"><label class="radio-chip"><input type="checkbox" data-f="${escapeHtml(c.id)}" ${(v === undefined ? c.padrao : v) ? 'checked' : ''}/> ${escapeHtml(c.label)}</label></div>`;
  return `<div class="form-field"><label>${escapeHtml(c.label)}</label><input class="input" ${c.tipo === 'numero' ? 'type="number" min="0" step="1"' : ''} data-f="${escapeHtml(c.id)}" value="${escapeHtml(v || '')}"/></div>`;
}

function lerFiltros() {
  const f = {};
  document.querySelectorAll('#relFiltros [data-f]').forEach(i => {
    const k = i.dataset.f;
    if (i.type === 'checkbox') f[k] = i.checked;
    else if (String(i.value).trim() !== '') f[k] = String(i.value).trim();
  });
  relState.filtros = f;
  return f;
}
function lerColunas() {
  const marc = Array.from(document.querySelectorAll('#relColunas input:checked')).map(i => i.value);
  relState.colunas = marc.length ? marc : relAtual().colunasPadrao.slice();
  return relState.colunas;
}
function relQuery(extra) { return `f=${encodeURIComponent(JSON.stringify(lerFiltros()))}&c=${encodeURIComponent(lerColunas().join(','))}${extra || ''}`; }

function paintConstrutorRelatorio(el) {
  const r = relAtual();
  const salvos = relState.salvos.filter(s => s.relatorio === r.id);
  el.innerHTML = `
    <div class="section-title-row" style="margin-top:0;"><h2><a href="#" id="relVoltar" style="color:inherit;" title="Voltar aos relatórios">←</a> ${escapeHtml(r.titulo)}</h2><div class="hint">${escapeHtml(r.descricao)}</div></div>
    <div class="card anim-in" style="padding:16px 18px; margin-bottom:14px;" id="relFiltros">
      <div class="form-grid">${r.filtros.map(controleHtml).join('')}</div>
      <details id="relColunas" style="margin-top:12px;"><summary style="cursor:pointer; font-size:12.5px; color:var(--text-dim);">Colunas do relatório (${relState.colunas.length} de ${r.colunas.length})</summary>
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;">${r.colunas.map(c => `<label class="radio-chip"><input type="checkbox" value="${escapeHtml(c.id)}" ${relState.colunas.includes(c.id) ? 'checked' : ''}/> ${escapeHtml(c.label)}</label>`).join('')}</div>
        <div style="margin-top:8px; display:flex; gap:8px;"><button class="btn btn-sm" type="button" id="relColPadrao">Voltar às colunas padrão${r.personalizado ? ' do cliente' : ''}</button>${relState.podeConfigurar ? '<button class="btn btn-sm" type="button" id="relColCliente">Definir como padrão do cliente</button>' : ''}</div></details>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; align-items:center;">
        <button class="btn btn-primary" id="relGerar">${ICONS.search}Gerar relatório</button>
        <button class="btn" id="relXlsx">${ICONS.download}Excel</button>
        <button class="btn" id="relPdf">${ICONS.download}PDF</button>
        <button class="btn" id="relEmail">${ICONS.send}Enviar por e-mail</button>
        <button class="btn" id="relAgendar">${ICONS.clock}Agendar envio mensal</button>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; align-items:center; font-size:12.5px;">
        <span class="cell-dim">Filtros salvos:</span>
        <select id="relSalvos" class="input" style="padding:5px 10px; font-size:12px; max-width:220px;"><option value="">— escolher —</option>${salvos.map(s => `<option value="${s.id}">${escapeHtml(s.nome)}</option>`).join('')}</select>
        <button class="btn btn-sm" id="relAplicar">Aplicar</button>
        <button class="btn btn-sm" id="relSalvar">${ICONS.check}Salvar filtros atuais</button>
        <button class="btn btn-sm btn-danger" id="relExcluirSalvo">${ICONS.trash}</button>
      </div>
    </div>
    <div id="relResultado">${relState.resultado ? resultadoHtml(relState.resultado) : `<div class="card empty-state">${ICONS.list}<h4>Escolha os filtros e clique em "Gerar relatório"</h4><p>O Excel e o PDF saem com as mesmas colunas e filtros.</p></div>`}</div>`;
  const q = (id) => document.getElementById(id);
  q('relVoltar').addEventListener('click', (e) => { e.preventDefault(); relState.rid = null; paintRelatorios(); });
  el.querySelector('select[data-f=periodo]')?.addEventListener('change', (e) => document.querySelectorAll('.rel-datas').forEach(d => { d.style.display = e.target.value === 'personalizado' ? '' : 'none'; }));
  q('relGerar').addEventListener('click', gerarRelatorioTela);
  q('relXlsx').addEventListener('click', () => baixarRelatorio('xlsx'));
  q('relPdf').addEventListener('click', () => baixarRelatorio('pdf'));
  q('relEmail').addEventListener('click', abrirEnvioRelatorio);
  q('relAgendar').addEventListener('click', abrirAgendamentoRelatorio);
  q('relColPadrao').addEventListener('click', () => { relState.colunas = r.colunasPadrao.slice(); document.querySelectorAll('#relColunas input[type=checkbox]').forEach(i => { i.checked = relState.colunas.includes(i.value); }); });
  const cc = q('relColCliente'); if (cc) cc.addEventListener('click', definirColunasCliente);
  q('relSalvar').addEventListener('click', salvarFiltrosRelatorio);
  q('relAplicar').addEventListener('click', () => {
    const s = relState.salvos.find(x => String(x.id) === q('relSalvos').value); if (!s) { toast('Escolha um filtro salvo.', 'error'); return; }
    relState.filtros = Object.assign({}, s.filtros); relState.colunas = (s.colunas && s.colunas.length ? s.colunas : r.colunasPadrao).slice(); relState.resultado = null; paintRelatorios(); gerarRelatorioTela();
  });
  q('relExcluirSalvo').addEventListener('click', async () => {
    const id = q('relSalvos').value; if (!id) { toast('Escolha um filtro salvo.', 'error'); return; }
    try { await api('DELETE', `/relatorios/_filtros/${id}`); relState.salvos = relState.salvos.filter(x => String(x.id) !== id); toast('Filtro excluído.', 'success'); paintRelatorios(); } catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------- resultado ---------- */
function celulaRelatorio(v, tipo) {
  if (v === null || v === undefined || v === '') return '';
  if (tipo === 'moeda') return fmtBRL(v);
  if (tipo === 'data') return fmtDate(v);
  if (tipo === 'pct') return fmtPct(v, 1);
  if (tipo === 'num1') return fmtNum(v, 1);
  if (tipo === 'inteiro') return fmtNum(v, 0);
  return String(v);
}
function resultadoHtml(res) {
  const num = (t) => ['moeda', 'pct', 'num1', 'inteiro'].includes(t);
  return `
    ${res.subtitulo ? `<p class="form-hint" style="margin:0 0 10px;">${escapeHtml(res.subtitulo)}</p>` : ''}
    <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px;">${res.resumo.map(x => `<div class="card" style="padding:10px 14px; min-width:140px;"><div class="form-hint">${escapeHtml(x.label)}</div><div style="font-size:16px; font-weight:700;">${escapeHtml(celulaRelatorio(x.valor, x.tipo) || '0')}</div></div>`).join('')}</div>
    <div class="card table-card anim-in"><div class="table-toolbar"><div class="hint">${res.total} registro(s)${res.truncado ? ` — mostrando os primeiros ${res.linhas.length}; o Excel e o PDF trazem todos` : ''}</div></div>
      <div class="table-scroll">${res.linhas.length ? `<table class="data-table"><thead><tr>${res.colunas.map(c => `<th ${num(c.tipo) ? 'style="text-align:right;"' : ''}>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${res.linhas.map(l => `<tr>${res.colunas.map(c => `<td ${num(c.tipo) ? 'class="cell-num"' : ''} ${c.id === 'saldo' && Number(l[c.id]) < 0 ? 'style="color:var(--critical);"' : ''}>${escapeHtml(celulaRelatorio(l[c.id], c.tipo))}</td>`).join('')}</tr>`).join('')}</tbody></table>` : `<div class="empty-state" style="padding:26px;">${ICONS.inbox}<p>Nenhum registro para os filtros escolhidos.</p></div>`}</div></div>`;
}
async function gerarRelatorioTela() {
  const b = document.getElementById('relGerar'); b.disabled = true;
  try { relState.resultado = await api('GET', `/relatorios/${relState.rid}?${relQuery()}`); document.getElementById('relResultado').innerHTML = resultadoHtml(relState.resultado); }
  catch (e) { toast(e.message, 'error'); }
  finally { b.disabled = false; }
}
async function baixarRelatorio(formato) {
  let res;
  try { res = await fetch(`/api/relatorios/${relState.rid}/exportar?formato=${formato}&${relQuery()}`, { credentials: 'same-origin' }); }
  catch (e) { toast('Não foi possível falar com o servidor.', 'error'); return; }
  if (!res.ok) { let m = 'Erro ' + res.status; try { m = (await res.json()).erro || m; } catch (e) { } if (res.status === 401 && window.__onSessionExpired) window.__onSessionExpired(); toast(m, 'error'); return; }
  const blob = await res.blob();
  const nome = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || `relatorio.${formato}`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`${formato === 'xlsx' ? 'Excel' : 'PDF'} gerado.`, 'success');
}

/* ---------- e-mail, agendamento, filtros salvos, colunas do cliente ---------- */
function extrasDe(texto) { return String(texto || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean); }
function formatosModal() { return Array.from(document.querySelectorAll('#relFormatos input:checked')).map(i => i.value); }
const FORMATOS_HTML = `<div class="form-field full" id="relFormatos"><label>Formatos</label><div class="radio-row"><label class="radio-chip"><input type="checkbox" value="xlsx" checked/> Excel</label><label class="radio-chip"><input type="checkbox" value="pdf" checked/> PDF</label></div></div>`;

function abrirEnvioRelatorio() {
  const f = lerFiltros(), cols = lerColunas();
  openModal(`<div class="modal-head"><h3>${modalIcon('send')} Enviar por e-mail</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><p class="form-hint" style="margin-bottom:12px;">O relatório "${escapeHtml(relAtual().titulo)}" será enviado para <strong>${escapeHtml(DB.user.email)}</strong>, com os filtros e as colunas que estão na tela.</p>
      <div class="form-grid">${FORMATOS_HTML}<div class="form-field full"><label>Outros destinatários (opcional, até 5, e-mails @${escapeHtml(DB.config.dominio || '')})</label><input class="input" id="relExtras" placeholder="nome@${escapeHtml(DB.config.dominio || 'empresa.com.br')}, outro@…"/></div></div></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="relEnviarOk">${ICONS.send}Enviar</button></div>`);
  document.getElementById('relEnviarOk').addEventListener('click', async () => {
    const fm = formatosModal(); if (!fm.length) { toast('Escolha Excel e/ou PDF.', 'error'); return; }
    try { const r = await api('POST', `/relatorios/${relState.rid}/enviar`, { filtros: f, colunas: cols, formatos: fm, destinatarios: extrasDe(document.getElementById('relExtras').value) }); closeModal(); toast(`Relatório enviado para ${r.destinatarios.join(', ')}.`, 'success'); }
    catch (e) { toast(e.message, 'error'); }
  });
}
function abrirAgendamentoRelatorio() {
  const f = lerFiltros(), cols = lerColunas();
  openModal(`<div class="modal-head"><h3>${modalIcon('clock')} Agendar envio mensal</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><p class="form-hint" style="margin-bottom:12px;">Todo mês, a partir do dia escolhido, o relatório "${escapeHtml(relAtual().titulo)}" é gerado com os filtros e colunas atuais e enviado para <strong>${escapeHtml(DB.user.email)}</strong>. ${f.periodo === 'personalizado' ? '<strong>Atenção:</strong> o período está fixo em datas; prefira "Mês anterior" para o envio ficar sempre atualizado.' : 'Períodos como "Mês anterior" se atualizam sozinhos a cada envio.'}</p>
      <div class="form-grid"><div class="form-field"><label>Dia do mês</label><select id="relDia">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${i === 0 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div>${FORMATOS_HTML}
        <div class="form-field full"><label>Outros destinatários (opcional)</label><input class="input" id="relExtras" placeholder="nome@${escapeHtml(DB.config.dominio || 'empresa.com.br')}"/></div></div></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="relAgOk">${ICONS.check}Agendar</button></div>`);
  document.getElementById('relAgOk').addEventListener('click', async () => {
    const fm = formatosModal(); if (!fm.length) { toast('Escolha Excel e/ou PDF.', 'error'); return; }
    try { await api('POST', '/relatorios/_agenda', { relatorio: relState.rid, filtros: f, colunas: cols, formatos: fm, dia: Number(document.getElementById('relDia').value), destinatarios: extrasDe(document.getElementById('relExtras').value) }); closeModal(); toast('Envio mensal agendado.', 'success'); const d = await api('GET', '/relatorios'); relState.agenda = d.agendamentos; }
    catch (e) { toast(e.message, 'error'); }
  });
}
async function salvarFiltrosRelatorio() {
  const f = lerFiltros(), cols = lerColunas();
  openModal(`<div class="modal-head"><h3>${modalIcon('check')} Salvar filtros</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><div class="form-field full"><label>Nome para este conjunto de filtros e colunas <span class="req">*</span></label><input class="input" id="relNomeFiltro" maxlength="60" placeholder="Ex.: Concluídos do mês"/></div></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="relNomeOk">${ICONS.check}Salvar</button></div>`);
  setTimeout(() => document.getElementById('relNomeFiltro').focus(), 60);
  document.getElementById('relNomeOk').addEventListener('click', async () => {
    const nome = document.getElementById('relNomeFiltro').value.trim(); if (!nome) { toast('Informe um nome.', 'error'); return; }
    try { await api('POST', '/relatorios/_filtros', { relatorio: relState.rid, nome, filtros: f, colunas: cols }); const d = await api('GET', '/relatorios'); relState.salvos = d.filtrosSalvos; closeModal(); toast('Filtros salvos.', 'success'); paintRelatorios(); }
    catch (e) { toast(e.message, 'error'); }
  });
}
async function definirColunasCliente() {
  const cols = lerColunas();
  if (!await confirmDialog({ title: 'Colunas padrão do cliente', message: `Todos os usuários passarão a abrir "${relAtual().titulo}" com estas ${cols.length} coluna(s). Cada pessoa ainda pode escolher outras na hora.`, okLabel: 'Definir como padrão', danger: false })) { paintRelatorios(); return; }
  try { await api('PUT', '/relatorios/_config', { relatorio: relState.rid, colunas: cols }); const d = await api('GET', '/relatorios'); relState.cat = d.relatorios; toast('Colunas padrão do cliente salvas.', 'success'); }
  catch (e) { toast(e.message, 'error'); }
  paintRelatorios();
}
