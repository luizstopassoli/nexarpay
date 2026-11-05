/* ===================== NexarPay — Preferências (conta do próprio usuário) ===================== */
function renderPreferencias() {
  const u = DB.user, el = document.getElementById('page-preferencias');
  if (!u) { el.innerHTML = ''; return; }
  const deps = (u.departamentos || []).map(depNome).join(', ') || '—';
  const flags = [u.rh1 ? 'RH 1' : '', u.rh2 ? 'RH 2' : ''].filter(Boolean).join(' · ');
  const info = (rot, val) => `<div class="pref-row"><span class="pref-label">${rot}</span><span class="pref-value">${escapeHtml(val)}</span></div>`;
  const card = (id, ico, titulo, desc, extra) => `<div class="card kpi hoverable"><div class="kpi-top"><span class="kpi-label">${titulo}</span><div class="kpi-ico" style="background:color-mix(in srgb, var(--brand-navy) 18%, transparent); color:var(--text);">${ico}</div></div>
      <div class="kpi-sub" style="margin-top:6px;">${desc}</div>${extra || ''}
      <div style="margin-top:14px;"><button class="btn btn-sm" id="${id}">Abrir</button></div></div>`;
  el.innerHTML = `
    <div class="settings-block anim-in">
      <div class="section-title-row" style="margin-top:0;"><h2 style="font-size:14px;">Meu perfil</h2></div>
      <div class="card" style="padding:18px 20px;">
        ${info('Nome', u.nome)}${info('E-mail', u.email)}${info('Perfil', perfilLabel(u.perfil) + (flags ? ' · ' + flags : ''))}${info('Departamentos', deps)}
      </div>
    </div>
    <div class="settings-block anim-in">
      <div class="section-title-row" style="margin-top:0;"><h2 style="font-size:14px;">Segurança da conta</h2></div>
      <div class="grid grid-3">
        ${card('prefSenha', ICONS.key, 'Trocar minha senha', 'Defina uma nova senha de acesso (mínimo de 10 caracteres).')}
        ${card('prefMfa', ICONS.lock, 'Verificação em 2 etapas', 'Proteja o acesso com um código gerado no aplicativo autenticador do celular.', `<div style="margin-top:8px;"><span class="pill ${u.mfaAtivo ? 'pill-good' : 'pill-warn'}">${u.mfaAtivo ? 'Ativada' : 'Desativada'}</span></div>`)}
        ${card('prefSessoes', ICONS.list, 'Minhas sessões', 'Veja os acessos abertos na sua conta e encerre os que não reconhecer.')}
      </div>
    </div>`;
  document.getElementById('prefSenha').addEventListener('click', () => openChangePasswordModal());
  document.getElementById('prefMfa').addEventListener('click', () => openMfaModal());
  document.getElementById('prefSessoes').addEventListener('click', () => openSessoesModal());
}
