/* ===================== NexarPay — núcleo (utilitários, API, estado, UI base) ===================== */

/* ---------- formatação ---------- */
const fmtBRL = (v) => { if (v === null || v === undefined || isNaN(v)) v = 0; return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
const fmtNum = (v, dec = 0) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtPct = (v, dec = 1) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '%';
const fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(String(iso).slice(0, 10) + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('pt-BR'); };
const fmtDateTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const escapeHtml = (s) => (s === null || s === undefined) ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const deepClone = (o) => JSON.parse(JSON.stringify(o));
const humanFileSize = (bytes) => { if (!bytes) return '0 KB'; const kb = bytes / 1024; return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`; };
// "1.234,56" -> 1234.56 (máscara de moeda pt-BR)
const parseBRL = (s) => { if (typeof s === 'number') return s; s = String(s || '').replace(/[R$\s]/g, ''); if (!s) return 0; if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); return Number(s) || 0; };
const maskBRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

// Empresas vêm do cadastro do cliente (DB.empresas). COMPANY_* são recalculados por refreshCompanies() a cada carga.
const GRUPO_ID = 'GRUPO';          // opção "grupo": despesa dividida entre as empresas pelo rateio do orçamento
const SEM_RATEIO = 'SEM_RATEIO';   // despesa do grupo em ano/departamento sem rateio cadastrado: fica sem divisão
const COMPANY_KEYS = [];
const COMPANY_LABELS = {};
const COMPANY_COLOR_VAR = {};
const COMPANY_COLOR_ORDER = ['--c1', '--c2', '--c7', '--c5', '--c3', '--c4', '--c6', '--c8'];
function refreshCompanies() {
  COMPANY_KEYS.length = 0;
  Object.keys(COMPANY_LABELS).forEach(k => delete COMPANY_LABELS[k]);
  Object.keys(COMPANY_COLOR_VAR).forEach(k => delete COMPANY_COLOR_VAR[k]);
  (DB.empresas || []).filter(e => e.participaRateio).forEach((e, i) => {
    COMPANY_KEYS.push(e.id); COMPANY_LABELS[e.id] = e.nome; COMPANY_COLOR_VAR[e.id] = COMPANY_COLOR_ORDER[i % COMPANY_COLOR_ORDER.length];
  });
}
function anoFechado(ano) { return (DB.anosFechados || []).includes(Number(ano)); }
function empresaNome(id) { if (id === GRUPO_ID) return DB.grupoNome || 'Grupo'; const e = (DB.empresas || []).find(x => x.id === id); return e ? e.nome : '—'; }
// opções do campo Empresa nos formulários: "Grupo" (só com 2+ empresas no rateio) + empresas ativas. 'manter' = valor atual, mesmo inativo.
function empresaOptions(manter) {
  const ativas = (DB.empresas || []).filter(e => e.ativa);
  const out = ativas.filter(e => e.participaRateio).length >= 2 ? [{ id: GRUPO_ID, nome: `${DB.grupoNome || 'Grupo'} — dividido entre todas as empresas (rateio)` }] : [];
  ativas.forEach(e => out.push({ id: e.id, nome: e.nome }));
  if (manter && !out.some(o => o.id === manter) && (manter === GRUPO_ID || (DB.empresas || []).some(e => e.id === manter))) out.push({ id: manter, nome: empresaNome(manter) + ' (inativa)' });
  return out;
}
const CATEGORY_COLOR_ORDER = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
function colorForIndex(i) { return cssVar(CATEGORY_COLOR_ORDER[((i % CATEGORY_COLOR_ORDER.length) + CATEGORY_COLOR_ORDER.length) % CATEGORY_COLOR_ORDER.length]); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* ---------- ícones (feather-style, inline svg) ---------- */
const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  budget: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  props: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.4"/><path d="M12 2v2.4M12 19.6V22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2 12h2.4M19.6 12H22M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 4.9L5 9.8l4.1 3-1.5 5 4.4-3 4.4 3-1.5-5 4.1-3-5.1-1.9z"/></svg>',
  'trend-up': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>',
  building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v18"/><path d="M2 22h20M9 6h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1"/></svg>',
  scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 8l-3 6a4 4 0 0 0 8 0zM19 8l-3 6a4 4 0 0 0 8 0zM3 8h18M12 3l-4 5h8z"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.83Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="15" x2="23" y2="15"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="15" x2="4" y2="15"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.5A2.5 2.5 0 0 1 4 17.5v-1.75A2.5 2.5 0 0 1 2.5 13.5 2.5 2.5 0 0 1 4 11v-1.5A2.5 2.5 0 0 1 2.5 7 2.5 2.5 0 0 1 5 4.5 2.5 2.5 0 0 1 7.5 2 2.5 2.5 0 0 1 9.5 2ZM14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.5A2.5 2.5 0 0 0 20 17.5v-1.75a2.5 2.5 0 0 0 1.5-2.25A2.5 2.5 0 0 0 20 11v-1.5A2.5 2.5 0 0 0 21.5 7 2.5 2.5 0 0 0 19 4.5 2.5 2.5 0 0 0 16.5 2 2.5 2.5 0 0 0 14.5 2Z"/></svg>',
  drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69s-5.5 6.42-5.5 10.31a5.5 5.5 0 0 0 11 0C17.5 9.11 12 2.69 12 2.69Z"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  userPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="17" y1="11" x2="23" y2="11"/></svg>',
  shieldCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  xCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  fileText: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  userX: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  userCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>',
  bank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>',
  dollar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
  pie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="13" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>',
};
function icon(name, cls) { return `<span class="nav-ico ${cls || ''}">${ICONS[name] || ''}</span>`; }
function modalIcon(name) { return `<span class="modal-head-icon">${ICONS[name] || ''}</span>`; }

/* ---------- estado global (carregado do servidor) ---------- */
const DB = {
  user: null, departamentos: [], empresas: [], grupoNome: '', anosFechados: [], properties: {}, budgets: [], launches: [], users: [], perfis: {}, tiposSolicitacao: {}, statusLabel: {},
  config: {}, trava: { bloqueado: false, vencidas: [], pendentes: [] }, travaFreelancer: { bloqueado: false, vencidas: [], pendentes: [] }, solicitacoes: [],
};
function depNome(id) { const d = DB.departamentos.find(x => x.id === id); return d ? d.nome : (id || '—'); }
function userNome(id) { const u = DB.users.find(x => x.id === id); return u ? u.nome : '—'; }
function perfilLabel(p) { return DB.perfis[p] || p; }
function isAdmin() { return DB.user && DB.user.perfil === 'admin'; }
function perfil() { return DB.user ? DB.user.perfil : null; }
function podeVerTodosDeps() { return ['admin', 'diretor', 'financeiro', 'tv'].includes(perfil()); }
function meusDeps() { return DB.user ? (DB.user.departamentos || []) : []; }
// departamentos que o usuário pode selecionar em filtros (todos para admin/diretor/financeiro; os seus para gestor/colaborador)
function depsVisiveis() { return podeVerTodosDeps() ? DB.departamentos.filter(d => d.ativo) : DB.departamentos.filter(d => meusDeps().includes(d.id)); }

/* ---------- cliente da API ---------- */
async function api(method, path, body, _retry) {
  const opts = { method, headers: { 'X-NexarPay': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch('/api' + path, opts); }
  catch (e) { throw new Error('Não foi possível falar com o servidor. Verifique se o NexarPay está em execução.'); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* respostas sem corpo */ }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (window.__onSessionExpired) window.__onSessionExpired();
    throw new Error(data.erro || 'Sessão expirada.');
  }
  if (res.status === 403 && data.reauth && !_retry) { await pedirReauth(); return api(method, path, body, true); }  // ação sensível: pede a senha e repete
  if (!res.ok) { const err = new Error(data.erro || ('Erro ' + res.status)); err.status = res.status; err.data = data; throw err; }
  return data;
}
async function loadBootstrap() {
  const d = await api('GET', '/bootstrap');
  Object.assign(DB, d);
  refreshCompanies();
  return d;
}
async function reloadEmpresas() { const d = await api('GET', '/empresas'); DB.empresas = d.empresas; DB.grupoNome = d.grupoNome; refreshCompanies(); return d; }
async function reloadLaunches() { DB.launches = (await api('GET', '/launches')).launches; }
async function reloadBudgets() { DB.budgets = (await api('GET', '/budgets')).budgets; }
async function reloadProperties() { DB.properties = (await api('GET', '/properties')).properties; }
async function reloadDepartamentos() { DB.departamentos = (await api('GET', '/departamentos')).departamentos; }
async function reloadSolicitacoes() { const d = await api('GET', '/solicitacoes'); DB.solicitacoes = d.solicitacoes; DB.trava = d.trava; DB.travaFreelancer = d.travaFreelancer || DB.travaFreelancer; }

/* ---------- upload (corpo binário em streaming; máx., cotas e verificação no servidor) ---------- */
const EXT_OK = ['.pdf', '.docx', '.xlsx', '.png', '.jpg', '.jpeg'];
async function uploadFile(file) {
  const max = (DB.config.maxUploadMB || 20) * 1024 * 1024;
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  if (!EXT_OK.includes(ext)) throw new Error('Formato não permitido. Envie PDF, DOCX, XLSX, PNG ou JPEG.');
  if (file.size > max) throw new Error(`Arquivo muito grande (máx. ${DB.config.maxUploadMB || 20} MB).`);
  let res;
  try { res = await fetch('/api/files?nome=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'X-NexarPay': '1', 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'same-origin' }); }
  catch (e) { throw new Error('Não foi possível enviar o arquivo. Verifique a conexão.'); }
  let data = {};
  try { data = await res.json(); } catch (e) { }
  if (res.status === 401 && window.__onSessionExpired) { window.__onSessionExpired(); throw new Error(data.erro || 'Sessão expirada.'); }
  if (!res.ok) throw new Error(data.erro || ('Erro ' + res.status));
  return data.arquivo;
}
function fileUrl(id) { return '/api/files/' + encodeURIComponent(id); }

/* ---------- toasts ---------- */
function toast(message, type = 'info') {
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = type === 'success' ? ICONS.check : type === 'error' ? ICONS.alert : ICONS.info;
  el.innerHTML = `${ic}<span>${escapeHtml(message)}</span>`;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; el.style.transition = 'all .25s ease'; setTimeout(() => el.remove(), 260); }, type === 'error' ? 5200 : 3200);
}

/* ---------- modais ---------- */
const modalBackdrop = () => document.getElementById('modalBackdrop');
function openModal(html, { size = 'md', locked = false } = {}) {
  const bd = modalBackdrop();
  bd.innerHTML = `<div class="modal ${size === 'lg' ? 'modal-lg' : ''}">${html}</div>`;
  bd.classList.add('open');
  document.body.style.overflow = 'hidden';
  bd.querySelectorAll('[data-close-modal]').forEach(b => b.addEventListener('click', closeModal));
  bd.onclick = null;  // clicar fora NUNCA fecha: sair só por X, Cancelar ou salvar/registrar
}
function closeModal() {
  const bd = modalBackdrop();
  bd.classList.remove('open');
  bd.onclick = null;
  document.body.style.overflow = '';
  setTimeout(() => { if (!bd.classList.contains('open')) bd.innerHTML = ''; }, 180);
}
function confirmDialog({ title = 'Confirmar ação', message = 'Tem certeza?', okLabel = 'Excluir', danger = true } = {}) {
  return new Promise((resolve) => {
    openModal(`
      <div class="modal-body"><div class="confirm-box"><div class="confirm-ico">${ICONS.alert}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div></div>
      <div class="modal-foot"><button class="btn" id="confirmCancelBtn">Cancelar</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmOkBtn">${escapeHtml(okLabel)}</button></div>`);
    const bd = modalBackdrop();
    document.getElementById('confirmOkBtn').addEventListener('click', () => { closeModal(); resolve(true); });
    document.getElementById('confirmCancelBtn').addEventListener('click', () => { closeModal(); resolve(false); });
  });
}
// Modal com campo de justificativa obrigatória (Alterar / Reprovar)
function justificativaDialog({ title, message, okLabel, danger = false, placeholder = 'Descreva o motivo…' }) {
  return new Promise((resolve) => {
    openModal(`
      <div class="modal-head"><h3>${modalIcon(danger ? 'xCircle' : 'edit')} ${escapeHtml(title)}</h3><button class="modal-close" data-close-modal>${ICONS.x}</button></div>
      <div class="modal-body">
        <p style="font-size:13px; color:var(--text-dim); margin-bottom:12px;">${escapeHtml(message)}</p>
        <div class="form-field full"><label>Justificativa <span class="req">*</span></label><textarea id="justTxt" rows="4" placeholder="${escapeHtml(placeholder)}"></textarea><span class="form-hint">Obrigatória — será registrada no histórico e enviada ao solicitante.</span></div>
      </div>
      <div class="modal-foot"><button class="btn" id="justCancel">Cancelar</button><button class="btn ${danger ? 'btn-danger' : 'btn-warn'}" id="justOk">${escapeHtml(okLabel)}</button></div>`);
    const bd = modalBackdrop();
    const done = (v) => { closeModal(); resolve(v); };
    document.getElementById('justCancel').addEventListener('click', () => done(null));
    document.getElementById('justOk').addEventListener('click', () => {
      const t = document.getElementById('justTxt').value.trim();
      if (t.length < 5) { document.getElementById('justTxt').classList.add('error'); toast('Informe a justificativa (mínimo 5 caracteres).', 'error'); return; }
      done(t);
    });
    setTimeout(() => document.getElementById('justTxt').focus(), 60);
  });
}

/* ---------- tema ---------- */
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('nexarpay_theme', theme); } catch (e) { }
  const bd = document.getElementById('themeBtnDark'), bl = document.getElementById('themeBtnLight');
  if (bd) bd.classList.toggle('active', theme === 'dark');
  if (bl) bl.classList.toggle('active', theme === 'light');
  if (window.__rerenderCurrentPage) window.__rerenderCurrentPage();
}
function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('nexarpay_theme') || 'dark'; } catch (e) { }
  document.documentElement.setAttribute('data-theme', saved);
  const bd = document.getElementById('themeBtnDark'), bl = document.getElementById('themeBtnLight');
  if (bd) bd.classList.toggle('active', saved === 'dark');
  if (bl) bl.classList.toggle('active', saved === 'light');
}

/* ---------- pequenos componentes ---------- */
function kpiCard({ label, value, icoBg, ico, sub, barPct, barColor, compact, onClick, id }) {
  return `<div class="card kpi hoverable ${compact ? 'compact' : ''} ${onClick ? 'clickable' : ''}" ${id ? `id="${id}"` : ''}>
    <div class="kpi-top"><span class="kpi-label">${label}</span><div class="kpi-ico" style="background:color-mix(in srgb, ${cssVar(icoBg)} 18%, transparent); color:${cssVar(icoBg)};">${ICONS[ico] || ''}</div></div>
    <div class="kpi-value">${value}</div>
    ${sub !== undefined ? `<div class="kpi-sub">${sub}</div>` : ''}
    ${barPct !== undefined ? `<div class="kpi-bar"><div style="width:${barPct}%; background:${cssVar(barColor)};"></div></div>` : ''}
  </div>`;
}
function statusPill(s) {
  const cls = s.status;
  const extra = s.atrasada && ['aprovacao1', 'aprovacao2', 'rh', 'rh2', 'financeiro', 'alteracao'].includes(s.status) ? ` <span class="st st-atrasada" title="Data de pagamento já passou">Atrasada</span>` : '';
  return `<span class="st st-${cls}">${escapeHtml(DB.statusLabel[s.status] || s.statusLabel || s.status)}</span>${extra}`;
}
function emptyState(ico, title, msg) { return `<div class="empty-state">${ICONS[ico] || ICONS.list}<h4>${escapeHtml(title)}</h4><p>${escapeHtml(msg || '')}</p></div>`; }
function selectOptions(arr, sel, labelFn) { return arr.map(v => { const val = typeof v === 'object' ? v.id : v; const lab = labelFn ? labelFn(v) : (typeof v === 'object' ? v.nome : v); return `<option value="${escapeHtml(val)}" ${String(val) === String(sel) ? 'selected' : ''}>${escapeHtml(lab)}</option>`; }).join(''); }
function sparklineSVG(values, { w = 120, h = 36, colorVar = '--c1' } = {}) {
  if (!values.length) return '';
  const max = Math.max(...values, 1), min = Math.min(...values, 0), range = (max - min) || 1, step = w / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${cssVar(colorVar)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
// aplica máscara de moeda pt-BR a um <input>
function attachMoneyMask(input) {
  const fmt = () => { const n = parseBRL(input.value); input.value = n ? maskBRL(n) : ''; };
  input.addEventListener('blur', fmt);
  input.addEventListener('input', () => { input.value = input.value.replace(/[^\d.,]/g, ''); });
  if (input.value) fmt();
}
