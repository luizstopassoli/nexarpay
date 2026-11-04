/* ===================== NexarPay — Configurações (usuários, perfis, aprovadores, backup, e-mail) ===================== */

const cfgState = { users: [], emailLog: [], emailModo: '' };

async function renderConfiguracoes() {
  const el = document.getElementById('page-configuracoes');
  el.innerHTML = `<div class="empty-state">${ICONS.clock}<h4>Carregando…</h4></div>`;
  try {
    const [u, l] = await Promise.all([api('GET', '/users'), api('GET', '/email/log')]);
    cfgState.users = u.users; cfgState.emailLog = l.log; cfgState.emailModo = l.modo;
  } catch (e) { el.innerHTML = emptyState('alert', 'Não foi possível carregar', e.message); return; }
  if (currentPage !== 'configuracoes') return;
  const users = cfgState.users.slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const dom = DB.config.dominio;
  el.innerHTML = `
    <div class="section-title-row" style="margin-top:0;"><h2>Configurações</h2><div class="hint">Usuários e perfis de acesso, aprovadores, backup e e-mail</div></div>

    <div class="settings-block anim-in">
      <div class="section-title-row" style="margin-top:0;"><h2 style="font-size:14px;">Usuários do Sistema</h2><button class="btn btn-primary btn-sm" id="addUserBtn">${ICONS.userPlus}Novo Usuário</button></div>
      <div class="card table-card"><div class="table-scroll"><table class="data-table">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Departamentos</th><th>Diretor(a) 1</th><th>Diretor(a) 2</th><th>Status</th><th style="text-align:right;">Ações</th></tr></thead>
        <tbody>${users.map(u => `<tr>
          <td class="cell-strong">${escapeHtml(u.nome)}${u.senhaProvisoria ? ' <span class="st st-alteracao" title="Deverá trocar a senha no próximo login">senha provisória</span>' : ''}</td>
          <td class="cell-dim">${escapeHtml(u.email)}</td>
          <td><span class="role-badge ${u.perfil}">${escapeHtml(perfilLabel(u.perfil))}</span>${u.rh1 ? ' <span class="dept-chip">RH 1</span>' : ''}${u.rh2 ? ' <span class="dept-chip">RH 2</span>' : ''}</td>
          <td>${(u.departamentos || []).map(d => `<span class="dept-chip">${escapeHtml(depNome(d))}</span>`).join(' ') || '<span class="cell-dim">—</span>'}</td>
          <td class="cell-dim">${escapeHtml(u.diretor1Id ? userNome(u.diretor1Id) : '—')}</td>
          <td class="cell-dim">${escapeHtml(u.diretor2Id ? userNome(u.diretor2Id) : '—')}</td>
          <td><span class="pill ${u.ativo ? 'pill-good' : 'pill-crit'}">${u.ativo ? 'Ativo' : 'Inativo'}</span></td>
          <td><div class="row-actions" style="justify-content:flex-end;"><button class="icon-btn" data-edit-user="${u.id}" title="Editar">${ICONS.edit}</button><button class="icon-btn danger" data-del-user="${u.id}" title="Excluir">${ICONS.trash}</button></div></td></tr>`).join('')}</tbody></table></div></div>
      <p class="form-hint" style="margin-top:10px;">
        <strong>Administrador</strong>: acesso total, sem restrição. · <strong>Diretor(a)</strong>: dashboard gerencial (filtro por departamento) e aprovação/alteração/reprovação das solicitações. ·
        <strong>Gestor(a)</strong>: dashboard do(s) seu(s) departamento(s), solicitações, lançamentos manuais e acompanhamento. · <strong>Colaborador(a)</strong>: apenas solicitações de pagamento e acompanhamento. ·
        <strong>Financeiro</strong>: mesma visão do Diretor(a) e etapa final (encerrar/reprovar).<br/>Somente e-mails <strong>@${escapeHtml(dom)}</strong> podem ser cadastrados. Os aprovadores (Diretor 1 e 2) definidos no perfil de cada usuário recebem as solicitações desse usuário.</p>
    </div>

    <div class="settings-block anim-in">
      <div class="section-title-row" style="margin-top:0;"><h2 style="font-size:14px;">E-mail (notificações e senha provisória)</h2></div>
      <div class="grid grid-2">
        <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Modo atual</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar(cfgState.emailModo === 'smtp' ? '--good' : '--warning')} 18%, transparent); color:${cssVar(cfgState.emailModo === 'smtp' ? '--good' : '--warning')};">${ICONS.mail}</div></div>
          <div class="kpi-value" style="font-size:18px;">${cfgState.emailModo === 'smtp' ? 'SMTP (envio real)' : 'Simulado (somente registro)'}</div>
          <div class="kpi-sub">Configure em <code>config.json</code> na pasta do servidor: <code>"modo": "smtp"</code>, usuário e senha de app do Google Workspace. Reinicie o servidor após alterar.</div>
          <div style="display:flex; gap:8px; margin-top:12px;"><input class="input" id="emailTestePara" placeholder="destinatário do teste" value="${escapeHtml(DB.user.email)}" style="flex:1;"/><button class="btn btn-sm" id="emailTesteBtn">${ICONS.send}Enviar teste</button></div></div>
        <div class="card table-card"><div class="table-toolbar"><div class="hint">Últimos e-mails (${cfgState.emailLog.length})</div></div>
          <div class="table-scroll" style="max-height:260px;"><table class="data-table email-log"><thead><tr><th>Data</th><th>Para</th><th>Assunto</th><th>Status</th></tr></thead>
            <tbody>${cfgState.emailLog.map(e => `<tr data-email="${e.id}" style="cursor:pointer;"><td class="cell-dim" style="white-space:nowrap;">${fmtDateTime(e.data)}</td><td>${escapeHtml(e.para)}</td><td style="white-space:normal;">${escapeHtml(e.assunto)}${e.anexo ? ' 📎' : ''}</td><td><span class="pill ${e.status === 'enviado' ? 'pill-good' : e.status === 'erro' ? 'pill-crit' : 'pill-warn'}" title="${escapeHtml(e.erro || '')}">${e.status}</span></td></tr>`).join('') || '<tr><td colspan="4" class="cell-dim">Nenhum e-mail registrado ainda.</td></tr>'}</tbody></table></div></div>
      </div>
    </div>

    <div class="settings-block anim-in">
      <div class="section-title-row" style="margin-top:0;"><h2 style="font-size:14px;">Backup de Dados</h2></div>
      <div class="grid grid-3">
        <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Exportar</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c1')} 18%, transparent); color:${cssVar('--c1')};">${ICONS.download}</div></div>
          <div class="kpi-sub" style="margin-top:4px;">Baixa um .json com departamentos, usuários, cadastros, orçamentos, lançamentos, solicitações e histórico (os arquivos anexados ficam na pasta <code>data/uploads</code> do servidor).</div>
          <button class="btn btn-primary btn-sm" id="cfgExportBtn" style="margin-top:12px;">${ICONS.download}Exportar backup (.json)</button></div>
        <div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">Importar</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--c3')} 18%, transparent); color:${cssVar('--c3')};">${ICONS.upload}</div></div>
          <div class="kpi-sub" style="margin-top:4px;">Restaura um backup do NexarPay (substitui tudo) ou importa um backup do sistema antigo (lançamentos/orçamento entram no departamento T.I.).</div>
          <label class="btn btn-sm" style="margin-top:12px; cursor:pointer;">${ICONS.upload}Importar backup<input type="file" id="cfgImportInput" accept="application/json" style="display:none;"/></label></div>
        ${DB.config.demo ? `<div class="card kpi hoverable danger-zone"><div class="kpi-top"><span class="kpi-label">Restaurar Exemplo</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar('--critical')} 16%, transparent); color:${cssVar('--critical')};">${ICONS.refresh}</div></div>
          <div class="kpi-sub" style="margin-top:4px;">Apaga tudo (inclusive usuários e solicitações) e volta aos dados iniciais de teste. Não pode ser desfeito.</div>
          <button class="btn btn-sm btn-danger" id="cfgResetBtn" style="margin-top:12px;">${ICONS.refresh}Restaurar exemplo</button></div>` : ''}
      </div>
    </div>
    <div class="settings-block anim-in">
      <div class="section-title-row" style="margin-top:0;"><h2 style="font-size:14px;">Trilha de Auditoria</h2><div class="hint">Registro de inclusão apenas, encadeado por hash (não pode ser alterado nem apagado pelo sistema)</div></div>
      <div class="card table-card"><div class="table-toolbar"><div class="hint" id="audInfo">Carregando…</div><button class="btn btn-sm" id="audVerifyBtn">${ICONS.check}Verificar integridade</button></div>
        <div class="table-scroll" style="max-height:300px;"><table class="data-table"><thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Alvo</th><th>IP</th></tr></thead><tbody id="audBody"></tbody></table></div></div>
    </div>
    <div class="footer-note">As senhas são armazenadas apenas como hash (PBKDF2-SHA256) no servidor. Sessões expiram após 12 horas sem uso.</div>`;

  api('GET', '/auditoria?limite=100').then(r => { document.getElementById('audInfo').textContent = `Últimos ${r.auditoria.length} eventos`; document.getElementById('audBody').innerHTML = r.auditoria.map(a => `<tr title="${escapeHtml(JSON.stringify(a.detalhes || {}))}"><td class="cell-dim" style="white-space:nowrap;">${fmtDateTime(a.data)}</td><td>${escapeHtml(a.user_email || '—')}</td><td>${escapeHtml(a.acao)}</td><td>${escapeHtml(a.alvo || '')}</td><td class="cell-dim">${escapeHtml(a.ip || '')}</td></tr>`).join(''); }).catch(e => { document.getElementById('audInfo').textContent = e.message; });
  document.getElementById('audVerifyBtn').addEventListener('click', async () => { try { const r = await api('GET', '/auditoria/verificar'); toast(r.ok ? `Integridade confirmada (${r.total} registros).` : `ALERTA: trilha adulterada a partir do registro ${r.primeiraQuebra}.`, r.ok ? 'success' : 'error'); } catch (e) { toast(e.message, 'error'); } });
  document.getElementById('cfgExportBtn').addEventListener('click', async () => { try { await garantirReauth(); window.location.href = '/api/backup'; } catch (e) { toast(e.message, 'error'); } });
  document.getElementById('addUserBtn').addEventListener('click', () => openUserForm());
  el.querySelectorAll('[data-edit-user]').forEach(b => b.addEventListener('click', () => openUserForm(b.dataset.editUser)));
  el.querySelectorAll('[data-del-user]').forEach(b => b.addEventListener('click', () => deleteUser(b.dataset.delUser)));
  el.querySelectorAll('[data-email]').forEach(tr => tr.addEventListener('click', async () => { try { const r = (await api('GET', `/email/ver/${tr.dataset.email}`)).email; openModal(`<div class="modal-head"><h3>${modalIcon('mail')} ${escapeHtml(r.assunto)}</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div><div class="modal-body"><p class="cell-dim" style="font-size:12px;">Para: ${escapeHtml(r.para)} · ${fmtDateTime(r.data)} · ${r.status}${r.erro ? ' — ' + escapeHtml(r.erro) : ''}${r.anexo ? ' · anexo: ' + escapeHtml(r.anexo.split('/').pop()) : ''}</p><pre style="white-space:pre-wrap; font-family:inherit; font-size:13px; margin-top:12px; background:var(--card-alt); padding:14px; border-radius:10px;">${escapeHtml(r.corpo)}</pre></div><div class="modal-foot"><button class="btn" data-close-modal>Fechar</button></div>`, { size: 'lg' }); } catch (e) { toast(e.message, 'error'); } }));
  document.getElementById('emailTesteBtn').addEventListener('click', async () => { const b = document.getElementById('emailTesteBtn'); b.disabled = true; try { const r = await api('POST', '/email/teste', { para: document.getElementById('emailTestePara').value }); toast(r.status === 'enviado' ? 'E-mail de teste enviado.' : r.status === 'simulado' ? 'Modo simulado: e-mail registrado no log (não enviado).' : 'Falha: ' + (r.erro || ''), r.status === 'erro' ? 'error' : 'success'); renderConfiguracoes(); } catch (e) { toast(e.message, 'error'); b.disabled = false; } });
  document.getElementById('cfgImportInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!await confirmDialog({ title: 'Importar backup', message: 'Um backup do NexarPay substitui TODOS os dados atuais. Um backup do sistema antigo substitui apenas os lançamentos/orçamento do departamento T.I. Continuar?', okLabel: 'Importar', danger: true })) { e.target.value = ''; return; }
    try { const data = JSON.parse(await file.text()); await api('POST', '/backup/import', { backup: data }); toast('Backup importado com sucesso.', 'success'); const me = await api('GET', '/auth/me'); if (!me.user) { window.__onSessionExpired(); return; } await loadBootstrap(); refreshShellForUser(); renderConfiguracoes(); }
    catch (err) { toast(err.message || 'Não foi possível importar este arquivo.', 'error'); }
    e.target.value = '';
  });
  const _rb = document.getElementById('cfgResetBtn'); if (_rb) _rb.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Restaurar dados de exemplo', message: 'Isso substituirá TODOS os dados atuais (usuários, solicitações, orçamentos, lançamentos) pelos dados iniciais de teste. Deseja continuar?', okLabel: 'Restaurar' })) return;
    try { await api('POST', '/backup/reset'); toast('Dados de exemplo restaurados. Faça login novamente.', 'success'); DB.user = null; closeModal(); showLoginScreen(); } catch (e) { toast(e.message, 'error'); }
  });
}

function openUserForm(userId) {
  const editing = !!userId;
  const u = editing ? cfgState.users.find(x => x.id === userId) : { nome: '', email: '', perfil: 'colaborador', departamentos: [], diretor1Id: '', diretor2Id: '', ativo: true };
  const diretores = cfgState.users.filter(x => x.ativo && (x.perfil === 'diretor' || x.perfil === 'admin') && x.id !== userId);
  const dom = DB.config.dominio;
  openModal(`
    <div class="modal-head"><h3>${modalIcon(editing ? 'edit' : 'userPlus')} ${editing ? 'Editar' : 'Novo'} Usuário</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="userForm"><div class="form-grid">
      <div class="form-field full"><label>Nome completo <span class="req">*</span></label><input class="input" name="nome" required value="${escapeHtml(u.nome)}"/></div>
      <div class="form-field"><label>E-mail corporativo (login) <span class="req">*</span></label><input class="input" type="email" name="email" required placeholder="nome@${escapeHtml(dom)}" value="${escapeHtml(u.email)}"/><span class="form-hint">Somente @${escapeHtml(dom)}</span></div>
      <div class="form-field"><label>Perfil <span class="req">*</span></label><select name="perfil">${Object.keys(DB.perfis).map(p => `<option value="${p}" ${p === u.perfil ? 'selected' : ''}>${escapeHtml(DB.perfis[p])}</option>`).join('')}</select></div>
      <div class="form-field full"><label>Departamentos</label><div class="radio-row">${DB.departamentos.filter(d => d.ativo || (u.departamentos || []).includes(d.id)).map(d => `<label class="radio-chip"><input type="checkbox" name="dep" value="${d.id}" ${(u.departamentos || []).includes(d.id) ? 'checked' : ''}/> ${escapeHtml(d.nome)}</label>`).join('')}</div><span class="form-hint">Orçamentos e solicitações que o usuário gerencia/visualiza. Pode marcar mais de um.</span></div>
      <div class="form-section">Fluxo de aprovação deste usuário</div>
      <div class="form-field"><label>Diretor(a) 1 — primeira aprovação</label><select name="diretor1Id"><option value="">— não definido —</option>${selectOptions(diretores, u.diretor1Id, x => x.nome + ' (' + x.email + ')')}</select></div>
      <div class="form-field"><label>Diretor(a) 2 — segunda aprovação</label><select name="diretor2Id"><option value="">— não definido —</option>${selectOptions(diretores, u.diretor2Id, x => x.nome + ' (' + x.email + ')')}</select></div>
      <div class="form-field full ${u.perfil === 'rh' ? '' : 'hidden'}" id="rhFlags"><label>Permissões do RH</label><div class="radio-row">
        <label class="radio-chip"><input type="checkbox" name="rh1" ${u.rh1 ? 'checked' : ''}/> RH 1 — Primeira aprovação</label>
        <label class="radio-chip"><input type="checkbox" name="rh2" ${u.rh2 ? 'checked' : ''}/> RH 2 — Segunda aprovação</label></div>
        <span class="form-hint">RH 1: aprova o Freelancer (e pode alterar "Recorrente") e a Rescisão. RH 2: acompanha o Freelancer recorrente até o fim do contrato (ajusta valor/término e encerra). Ambos podem solicitar Rescisões.</span></div>
      <div class="form-section">Acesso</div>
      <div class="form-field"><label>${editing ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial'} ${editing ? '' : '<span class="req">*</span>'}</label><input class="input" type="password" name="senha" autocomplete="new-password" minlength="10" ${editing ? '' : 'required'}/></div>
      <div class="form-field" style="display:flex; flex-direction:column; gap:8px; justify-content:flex-end;">
        <label class="radio-chip"><input type="checkbox" name="senhaProvisoria" ${!editing ? 'checked' : ''}/> Obrigar troca de senha no próximo login</label>
        ${!editing ? `<label class="radio-chip"><input type="checkbox" name="enviarBoasVindas" checked/> Enviar e-mail de boas-vindas com link para o usuário definir a senha</label>` : `<label class="radio-chip"><input type="checkbox" name="ativo" ${u.ativo ? 'checked' : ''}/> Usuário ativo</label>`}
        ${editing && u.mfaAtivo ? `<label class="radio-chip"><input type="checkbox" name="resetarMfa"/> Redefinir verificação em 2 etapas (perdeu o celular)</label>` : ''}
      </div>
    </div></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="saveUserBtn">${ICONS.check}Salvar</button></div>`, { size: 'lg' });
  const fPerfil = document.querySelector('#userForm select[name=perfil]');
  fPerfil.addEventListener('change', () => document.getElementById('rhFlags').classList.toggle('hidden', fPerfil.value !== 'rh'));
  document.getElementById('saveUserBtn').addEventListener('click', async () => {
    const f = document.getElementById('userForm'); if (!f.reportValidity()) return;
    const body = { nome: f.nome.value.trim(), email: f.email.value.trim().toLowerCase(), perfil: f.perfil.value, departamentos: Array.from(f.querySelectorAll('input[name=dep]:checked')).map(i => i.value), diretor1Id: f.diretor1Id.value || null, diretor2Id: f.diretor2Id.value || null, rh1: f.perfil.value === 'rh' && f.rh1.checked, rh2: f.perfil.value === 'rh' && f.rh2.checked, resetarMfa: !!(f.resetarMfa && f.resetarMfa.checked), senha: f.senha.value, senhaProvisoria: f.senhaProvisoria.checked, ativo: editing ? f.ativo.checked : true, enviarBoasVindas: !editing && f.enviarBoasVindas.checked };
    if (!body.email.endsWith('@' + dom)) { toast('Somente e-mails @' + dom + ' podem ser cadastrados.', 'error'); return; }
    if (body.diretor1Id && body.diretor1Id === body.diretor2Id) { toast('Diretor(a) 1 e 2 devem ser pessoas diferentes.', 'error'); return; }
    try { if (editing) await api('PUT', `/users/${userId}`, body); else await api('POST', '/users', body); closeModal(); toast('Usuário salvo.', 'success'); await loadBootstrap(); refreshShellForUser(); renderConfiguracoes(); }
    catch (e) { toast(e.message, 'error'); }
  });
}
async function deleteUser(userId) {
  const u = cfgState.users.find(x => x.id === userId); if (!u) return;
  if (!await confirmDialog({ title: 'Excluir usuário', message: `Excluir o acesso de "${u.nome}"? Se participar de solicitações, será apenas desativado (mantido no histórico).` })) return;
  try { const r = await api('DELETE', `/users/${userId}`); toast(r.mensagem || 'Usuário excluído.', 'success'); await loadBootstrap(); renderConfiguracoes(); } catch (e) { toast(e.message, 'error'); }
}
