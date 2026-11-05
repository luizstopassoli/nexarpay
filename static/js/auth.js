/* ===================== NexarPay — autenticação (login por e-mail, esqueci minha senha, troca obrigatória) ===================== */

function showLoginScreen() {
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('loginScreen').style.display = '';
  showLoginStep('login');
}
function showAppShell() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appShell').style.display = '';
}
function showLoginStep(step) {
  const forms = { login: 'loginForm', forgot: 'forgotForm', change: 'changePassForm', mfa: 'mfaForm', mfasetup: 'mfaSetupForm', reset: 'resetForm' };
  Object.values(forms).forEach(id => { const f = document.getElementById(id); const show = id === forms[step]; f.style.display = show ? '' : 'none'; if (show) f.reset(); });
  ['loginError', 'forgotError', 'forgotOk', 'changePassError', 'mfaError', 'resetError'].forEach(id => document.getElementById(id).style.display = 'none');
  setTimeout(() => { const first = document.querySelector('#' + forms[step] + ' input'); if (first) first.focus(); }, 50);
}
function showFormError(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.style.display = 'block'; }

function wireAuthUI() {
  document.getElementById('icoLoginUser').innerHTML = ICONS.mail;
  document.getElementById('icoLoginLock').innerHTML = ICONS.lock;
  document.getElementById('icoForgotUser').innerHTML = ICONS.mail;
  document.getElementById('icoCp1').innerHTML = ICONS.key;
  document.getElementById('icoCp2').innerHTML = ICONS.key;
  document.getElementById('icoMfa').innerHTML = ICONS.key;
  document.getElementById('icoRs1').innerHTML = ICONS.key;
  document.getElementById('icoRs2').innerHTML = ICONS.key;

  const loginForm = document.getElementById('loginForm');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginSubmit');
    btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      const r = await api('POST', '/auth/login', { email: loginForm.email.value, senha: loginForm.senha.value });
      window.__provisoria = loginForm.senha.value;  // necessário se a senha for provisória (troca obrigatória)
      if (r.mfaRequired) { showLoginStep('mfa'); return; }
      if (r.mustChangePassword) { showLoginStep('change'); return; }
      window.__provisoria = null;
      await enterApp();
    } catch (err) {
      showFormError('loginError', err.message || 'E-mail ou senha incorretos.');
    } finally { btn.disabled = false; btn.textContent = 'Login'; }
  });

  const mfaForm = document.getElementById('mfaForm');
  mfaForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/auth/mfa/verificar', { codigo: mfaForm.codigo.value });
      if (r.codigosRestantes !== null && r.codigosRestantes !== undefined) toast(`Você usou um código de recuperação. Restam ${r.codigosRestantes}.`, 'info');
      if (r.mustChangePassword) { showLoginStep('change'); return; }
      window.__provisoria = null;
      await enterApp();
    } catch (err) {
      showFormError('mfaError', err.message);
      if (err.status === 401 && /Entre novamente/.test(err.message)) setTimeout(() => showLoginStep('login'), 1800);
    }
  });
  document.getElementById('mfaBack').addEventListener('click', () => showLoginStep('login'));

  const resetForm = document.getElementById('resetForm');
  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (resetForm.nova.value !== resetForm.confirma.value) { showFormError('resetError', 'As senhas não conferem.'); return; }
    try {
      await api('POST', '/auth/reset', { token: window.__resetToken || '', novaSenha: resetForm.nova.value });
      window.__resetToken = null;
      showLoginStep('login');
      toast('Senha alterada. Entre com a nova senha.', 'success');
    } catch (err) { showFormError('resetError', err.message); }
  });
  document.getElementById('resetBack').addEventListener('click', () => { window.__resetToken = null; showLoginStep('login'); });

  document.getElementById('forgotLink').addEventListener('click', () => showLoginStep('forgot'));
  document.getElementById('backToLogin').addEventListener('click', () => showLoginStep('login'));

  const forgotForm = document.getElementById('forgotForm');
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('forgotSubmit');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await api('POST', '/auth/forgot', { email: forgotForm.email.value });
      const ok = document.getElementById('forgotOk'); ok.textContent = r.mensagem; ok.style.display = 'block';
      document.getElementById('forgotError').style.display = 'none';
    } catch (err) { showFormError('forgotError', err.message); }
    finally { btn.disabled = false; btn.textContent = 'Enviar'; }
  });

  const cpForm = document.getElementById('changePassForm');
  cpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cpForm.nova.value !== cpForm.confirma.value) { showFormError('changePassError', 'As senhas não conferem.'); return; }
    try {
      await api('POST', '/auth/change-password', { senhaAtual: window.__provisoria || '', novaSenha: cpForm.nova.value });
      window.__provisoria = null;
      toast('Senha alterada com sucesso.', 'success');
      await enterApp();
    } catch (err) { showFormError('changePassError', err.message); }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await api('POST', '/auth/logout'); } catch (e) { }
    closeModal();
    DB.user = null;
    showLoginScreen();
  });

  window.__onSessionExpired = () => { toast('Sua sessão expirou. Faça login novamente.', 'error'); DB.user = null; closeModal(); showLoginScreen(); };
}

/* ---- confirmação de senha para ações sensíveis (cria/edita usuário, backup) ---- */
function pedirReauth() {
  return new Promise((resolve, reject) => {
    const mfa = !!(DB.user && DB.user.mfaAtivo);
    const bd = document.createElement('div');  // camada própria: não derruba o formulário que estiver aberto por baixo
    bd.className = 'modal-backdrop open'; bd.style.zIndex = '9999';
    bd.innerHTML = `<div class="modal"><div class="modal-head"><h3>${modalIcon('key')} Confirme sua identidade</h3></div>
      <div class="modal-body"><p class="form-hint" style="margin-bottom:12px;">Ação sensível: informe sua senha${mfa ? ' e o código do aplicativo autenticador' : ''}. A confirmação vale por 10 minutos.</p>
      <div class="form-grid"><div class="form-field"><label>Senha</label><input class="input" type="password" id="raSenha" autocomplete="current-password"/></div>
      ${mfa ? '<div class="form-field"><label>Código</label><input class="input" id="raCodigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code"/></div>' : ''}</div>
      <div class="alert-box" id="raErr" style="display:none;margin:12px 0 0;"></div></div>
      <div class="modal-foot"><button class="btn" id="raCancel">Cancelar</button><button class="btn btn-primary" id="raOk">Confirmar</button></div></div>`;
    document.body.appendChild(bd);
    const fim = () => bd.remove();
    bd.querySelector('#raSenha').focus();
    bd.querySelector('#raCancel').addEventListener('click', () => { fim(); reject(new Error('Confirmação cancelada.')); });
    const enviar = async () => {
      try {
        await api('POST', '/auth/reauth', { senha: bd.querySelector('#raSenha').value, codigo: mfa ? bd.querySelector('#raCodigo').value : '' }, true);
        fim(); resolve();
      } catch (e) { const er = bd.querySelector('#raErr'); er.textContent = e.message; er.style.display = 'block'; }
    };
    bd.querySelector('#raOk').addEventListener('click', enviar);
    bd.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') enviar(); });
  });
}
async function garantirReauth() { const r = await api('GET', '/auth/reauth'); if (!r.recente) await pedirReauth(); }

/* ---- minhas sessões ---- */
function descreverNavegador(ua) {
  ua = ua || '';
  const nav = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const so = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return nav + (so ? ' em ' + so : '');
}
async function openSessoesModal() {
  openModal(`<div class="modal-head"><h3>${modalIcon('key')} Minhas sessões</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div><div class="modal-body" id="sessBody">Carregando…</div><div class="modal-foot"><button class="btn" data-close-modal>Fechar</button><button class="btn btn-danger" id="sessAll">Encerrar todas as outras</button></div>`, { size: 'lg' });
  const pintar = async () => {
    const body = document.getElementById('sessBody'); if (!body) return;
    try {
      const r = await api('GET', '/auth/sessions');
      body.innerHTML = `<p class="form-hint" style="margin-bottom:10px;">Acessos abertos na sua conta. Se não reconhecer algum, encerre e troque a senha.</p><div class="table-scroll"><table class="data-table"><thead><tr><th>Dispositivo</th><th>IP</th><th>Iniciada em</th><th></th></tr></thead><tbody>${r.sessions.map(s => `<tr><td>${escapeHtml(descreverNavegador(s.ua))}${s.atual ? ' <strong>(esta sessão)</strong>' : ''}</td><td class="cell-dim">${escapeHtml(s.ip || '—')}</td><td class="cell-dim">${fmtDateTime(s.criadoEm)}</td><td>${s.atual ? '' : `<button class="btn btn-sm btn-danger" data-sess="${escapeHtml(s.id)}">Encerrar</button>`}</td></tr>`).join('')}</tbody></table></div>`;
      body.querySelectorAll('[data-sess]').forEach(b => b.addEventListener('click', async () => { try { await api('POST', '/auth/sessions', { id: b.dataset.sess }); toast('Sessão encerrada.', 'success'); pintar(); } catch (e) { toast(e.message, 'error'); } }));
    } catch (e) { body.textContent = e.message; }
  };
  document.getElementById('sessAll').addEventListener('click', async () => { try { const r = await api('POST', '/auth/sessions', { todas: true }); toast(`${r.encerradas} sessão(ões) encerrada(s).`, 'success'); pintar(); } catch (e) { toast(e.message, 'error'); } });
  pintar();
}

/* ---- cadastro do 2º fator (TOTP): usado no login (obrigatório) e no modal "Verificação em 2 etapas" ---- */
async function renderMfaSetup(body, cls, onDone) {
  let info;
  try { info = await api('POST', '/auth/mfa/setup', {}); }
  catch (e) { body.innerHTML = `<div class="${cls.err}">${escapeHtml(e.message)}</div>`; return; }
  const grupos = info.secret.replace(/(.{4})/g, '$1 ').trim();
  body.innerHTML = `
    <p class="${cls.help}">1) No celular, abra um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy, 1Password…) e adicione uma conta <strong>digitando a chave</strong>:</p>
    <p style="text-align:center;margin:10px 0;"><code style="font-size:15px;letter-spacing:1px;user-select:all;font-weight:700;background:#eef1fb;color:#0b1b4d;border-radius:8px;padding:8px 12px;">${escapeHtml(grupos)}</code></p>
    <p class="${cls.help}" style="margin-top:0;">No celular, também é possível tocar: <a href="${escapeHtml(info.uri)}">abrir no aplicativo</a>. Tipo: baseado em tempo.</p>
    <p class="${cls.help}">2) Digite aqui o código de 6 dígitos que o aplicativo mostrar:</p>
    <div class="${cls.wrap}"><input class="${cls.input}" id="mfaEnableCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"/></div>
    <div class="${cls.err}" id="mfaEnableErr" style="display:none;"></div>
    <button type="button" class="${cls.btn}" id="mfaEnableBtn">Ativar</button>`;
  document.getElementById('mfaEnableBtn').addEventListener('click', async () => {
    const er = document.getElementById('mfaEnableErr');
    try {
      const r = await api('POST', '/auth/mfa/enable', { codigo: document.getElementById('mfaEnableCode').value });
      body.innerHTML = `
        <p class="${cls.help}"><strong>Pronto!</strong> Guarde estes códigos de recuperação em local seguro (gerenciador de senhas). Cada um vale <strong>uma vez</strong> e só aparece agora — use se perder o celular.</p>
        <pre style="text-align:center;font-size:14px;line-height:1.7;user-select:all;margin:10px 0;font-weight:700;background:#eef1fb;color:#0b1b4d;border-radius:8px;padding:8px 12px;">${r.codigosRecuperacao.map(escapeHtml).join('\n')}</pre>
        <button type="button" class="${cls.btn}" id="mfaDoneBtn">Já guardei os códigos</button>`;
      document.getElementById('mfaDoneBtn').addEventListener('click', onDone);
    } catch (e) { er.textContent = e.message; er.style.display = 'block'; }
  });
}
const MFA_CLS_LOGIN = { help: 'login-help', err: 'login-error', wrap: 'login-input-wrap', input: 'login-input', btn: 'btn login-submit' };
const MFA_CLS_MODAL = { help: 'form-hint', err: 'alert-box', wrap: 'form-field', input: 'input', btn: 'btn btn-primary' };

function mfaSetupNoLogin() {  // perfil que exige MFA entra sem ele cadastrado: só consegue configurar
  return new Promise((resolve) => {
    showLoginScreen();  // também cobre o caso de recarregar a página já logado (tela de abertura e app escondidos)
    const boot = document.getElementById('bootScreen'); if (boot) boot.style.display = 'none';
    showLoginStep('mfasetup');
    renderMfaSetup(document.getElementById('mfaSetupBody'), MFA_CLS_LOGIN, resolve);
  });
}

function openMfaModal() {
  const u = DB.user; if (!u) return;
  openModal(`<div class="modal-head"><h3>${modalIcon('key')} Verificação em duas etapas</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div><div class="modal-body" id="mfaModalBody"></div><div class="modal-foot"><button class="btn" data-close-modal>Fechar</button></div>`);
  const body = document.getElementById('mfaModalBody');
  if (!u.mfaAtivo) { renderMfaSetup(body, MFA_CLS_MODAL, async () => { DB.user.mfaAtivo = true; closeModal(); toast('Verificação em duas etapas ativada.', 'success'); }); return; }
  if (u.mfaObrigatorio) { body.innerHTML = '<p>A verificação em duas etapas está <strong>ativa</strong> e é obrigatória para o seu perfil.</p><p class="form-hint">Perdeu o celular? Use um código de recuperação no login, ou peça ao Administrador para redefinir.</p>'; return; }
  body.innerHTML = `<p>Está <strong>ativa</strong>. Para desativar, confirme a senha e um código atual.</p>
    <div class="form-grid"><div class="form-field"><label>Senha</label><input class="input" type="password" id="mfaOffPass" autocomplete="current-password"/></div><div class="form-field"><label>Código</label><input class="input" id="mfaOffCode" inputmode="numeric" maxlength="20" autocomplete="one-time-code"/></div></div>
    <button class="btn btn-danger" id="mfaOffBtn" style="margin-top:12px;">Desativar</button>`;
  document.getElementById('mfaOffBtn').addEventListener('click', async () => {
    try { await api('POST', '/auth/mfa/disable', { senha: document.getElementById('mfaOffPass').value, codigo: document.getElementById('mfaOffCode').value }); DB.user.mfaAtivo = false; closeModal(); toast('Verificação em duas etapas desativada.', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  });
}

async function enterApp() {
  DB.solicitacoes = [];  // não deixa a lista do usuário anterior (mesma aba) aparecer para quem acabou de entrar
  try { await loadBootstrap(); }
  catch (e) {
    if (e.status === 403 && e.data && e.data.mfaSetupRequired) { await mfaSetupNoLogin(); return enterApp(); }
    throw e;
  }
  showAppShell();
  refreshShellForUser();
  navigateTo(defaultPageFor(DB.user.perfil));
  toast(`Bem-vindo(a), ${DB.user.nome.split(' ')[0]}.`, 'success');
  startSolicitacoesAutoRefresh();
}

function openChangePasswordModal() {
  openModal(`
    <div class="modal-head"><h3>${modalIcon('key')} Trocar minha senha</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
    <div class="modal-body"><form id="cpModalForm"><div class="form-grid">
      <div class="form-field full"><label>Senha atual <span class="req">*</span></label><input class="input" type="password" name="atual" autocomplete="current-password" required/></div>
      <div class="form-field"><label>Nova senha <span class="req">*</span></label><input class="input" type="password" name="nova" minlength="10" autocomplete="new-password" required/></div>
      <div class="form-field"><label>Confirmar nova senha <span class="req">*</span></label><input class="input" type="password" name="confirma" minlength="10" autocomplete="new-password" required/></div>
    </div><p class="form-hint" style="margin-top:10px;">Mínimo de 10 caracteres, com letras e números.</p></form></div>
    <div class="modal-foot"><button class="btn" data-close-modal>Cancelar</button><button class="btn btn-primary" id="cpModalSave">${ICONS.check}Salvar</button></div>`);
  document.getElementById('cpModalSave').addEventListener('click', async () => {
    const f = document.getElementById('cpModalForm');
    if (!f.reportValidity()) return;
    if (f.nova.value !== f.confirma.value) { toast('As senhas não conferem.', 'error'); return; }
    try { await api('POST', '/auth/change-password', { senhaAtual: f.atual.value, novaSenha: f.nova.value }); closeModal(); toast('Senha alterada.', 'success'); }
    catch (err) { toast(err.message, 'error'); }
  });
}
