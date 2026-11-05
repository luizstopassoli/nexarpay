#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NexarPay — Tudo Sob Controle. — servidor local.

Somente biblioteca padrão do Python (3.8+): http.server + sqlite3 + smtplib.
Sobe em http://0.0.0.0:<porta> e serve a interface (static/) e a API (/api/...).

Uso:  python3 server.py            (lê config.json na mesma pasta; cria se não existir)
"""
import base64
import datetime as dt
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import smtplib
import socket
import sqlite3
import ssl
import struct
import sys
import threading
import traceback
import unicodedata
import urllib.parse
import zipfile
import zlib
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, 'static')
DATA_DIR = os.path.join(BASE_DIR, 'data')
UPLOAD_DIR = os.path.join(DATA_DIR, 'uploads')
RECIBO_DIR = os.path.join(DATA_DIR, 'recibos')
SEED_DIR = os.path.join(BASE_DIR, 'seed')
DB_PATH = os.path.join(DATA_DIR, 'gpacpay.sqlite')
CONFIG_PATH = os.path.join(BASE_DIR, 'config.json')

SESSION_COOKIE = 'nexarpay_session'
SESSION_HOURS = 12            # vida MÁXIMA (absoluta) de uma sessão comum, mesmo com uso contínuo
SESSION_IDLE_HOURS = 4        # expira após este tempo sem uso
SESSION_TV_HOURS = 24 * 30    # o painel de TV precisa ficar logado
REAUTH_MINUTOS = 10           # validade da confirmação de senha para ações sensíveis


def limites_sessao(perfil):
    """(inatividade, vida máxima) em segundos."""
    if perfil == 'tv':
        return SESSION_TV_HOURS * 3600, SESSION_TV_HOURS * 3600
    return SESSION_IDLE_HOURS * 3600, SESSION_HOURS * 3600
MAX_UPLOAD_MB = 20
DOMINIO_PADRAO = 'grupogpac.com.br'

# --- ambiente (variáveis de ambiente) ---
# NEXARPAY_HTTPS=1       atrás de HTTPS: cookie Secure + HSTS
# NEXARPAY_TRUST_PROXY=1 confia no X-Forwarded-For (use só atrás de proxy reverso próprio)
# NEXARPAY_DEMO=1        modo demonstração: libera "Restaurar exemplo" e mostra e-mails simulados
# NEXARPAY_DEMO_SENHA    senha única dos usuários de demonstração (senão, aleatórias por usuário)
# NEXARPAY_HOST          endereço de escuta (padrão 0.0.0.0)
# NEXARPAY_URL_BASE / NEXARPAY_DOMINIO  sobrescrevem config.json
USE_HTTPS = os.environ.get('NEXARPAY_HTTPS') == '1'
TRUST_PROXY = os.environ.get('NEXARPAY_TRUST_PROXY') == '1'
DEMO_MODE = os.environ.get('NEXARPAY_DEMO') == '1'
PBKDF2_ITER = 600000
PBKDF2_ITER_LEGADO = 120000
MAX_VALOR = 1e9
CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
# tipos de arquivo aceitos no upload: extensão -> (MIME servido, assinatura inicial do arquivo)
UPLOAD_TIPOS = {
    '.pdf': ('application/pdf', (b'%PDF-',)),
    '.png': ('image/png', (b'\x89PNG\r\n\x1a\n',)),
    '.jpg': ('image/jpeg', (b'\xff\xd8\xff',)),
    '.jpeg': ('image/jpeg', (b'\xff\xd8\xff',)),
    '.docx': ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', (b'PK\x03\x04',)),
    '.xlsx': ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', (b'PK\x03\x04',)),
}

PERFIS = {
    'admin': 'Administrador',
    'diretor': 'Diretor(a)',
    'gestor': 'Gestor(a)',
    'colaborador': 'Colaborador(a)',
    'financeiro': 'Financeiro',
    'rh': 'RH',
    'tv': 'Dashboard (TV)',
}
TIPOS_SOLICITACAO = {
    'fornecedor': 'Cliente/Fornecedor',
    'reembolso': 'Reembolso',
    'grupo': 'Interno',
    'freelancer': 'Freelancer',
    'rescisao': 'Rescisões',
}
RESCISAO_TIPOS = {'pedido_dispensa': 'Pedido de Dispensa', 'dispensado': 'Dispensado'}
# prazo (dias corridos) para anexar o documento fiscal após o encerramento
PRAZO_DOC_FISCAL = {'grupo': 7, 'fornecedor': 3, 'reembolso': 1}
MSG_BLOQUEIO = 'Atenção!!! Bloqueio devido a falta do envio do documento fiscal. Verifique seus lançamentos já aprovados'

STATUS_LABEL = {
    'aprovacao1': 'Aguardando Aprovação 1',
    'aprovacao2': 'Aguardando Aprovação 2',
    'rh': 'Aguardando RH 1',
    'rh2': 'Acompanhamento RH 2',
    'financeiro': 'Aguardando Financeiro',
    'alteracao': 'Alteração solicitada',
    'reprovada': 'Reprovada',
    'encerrada': 'Encerrada',
}
STATUS_ABERTOS = ('aprovacao1', 'aprovacao2', 'rh', 'rh2', 'financeiro', 'alteracao')
ETAPA_RH = 4   # etapa do RH no histórico (só no módulo Freelancer; o Financeiro continua sendo a etapa 3)
ETAPA_RH2 = 5  # acompanhamento do Freelancer recorrente (RH 2), no lugar do Financeiro
DIAS_AVISO_TERMINO = 7
MODALIDADES = {'presencial': 'Presencial', 'home_office': 'Home office', 'hibrido': 'Híbrido'}
MAX_DIAS_FREELA = 31
MSG_BLOQUEIO_FREELA = 'Atenção!!! Bloqueio de novas solicitações de Freelancer: há contratação encerrada sem a Nota Fiscal anexada. Anexe a NF para liberar.'

DEFAULT_CONFIG = {
    'porta': 8765,
    'dominio_permitido': DOMINIO_PADRAO,
    'url_base': 'http://localhost:8765',
    'reenvio_retorna_para_aprovacao1': True,
    # controles de negócio: o estouro de orçamento só avisa; com true, bloqueia o envio
    'controles': {'bloquear_estouro_orcamento': False},
    # perfis que DEVEM usar verificação em duas etapas (TOTP); os demais podem ativar por conta própria
    'seguranca': {'mfa_perfis': ['admin', 'financeiro', 'diretor']},
    # cotas de upload (por usuário e globais)
    'limites': {'requisicoes_por_minuto_ip': 600, 'max_conexoes': 150, 'uploads_por_hora_usuario': 40, 'armazenamento_usuario_mb': 1024, 'armazenamento_total_gb': 20, 'disco_livre_minimo_mb': 500},
    'email': {
        'modo': 'simulado',          # "simulado" (grava em log) ou "smtp"
        'host': 'smtp.gmail.com',
        'porta': 465,
        'ssl': True,
        'usuario': 'gpacpay@grupogpac.com.br',
        'senha': 'COLOQUE-AQUI-A-SENHA-DE-APP',
        'remetente': 'NexarPay <gpacpay@grupogpac.com.br>',
        'copia_para': [],
    },
}


# ============================================================ util
def now_iso():
    return dt.datetime.now().replace(microsecond=0).isoformat()


def today_iso():
    return dt.date.today().isoformat()


def fmt_data(iso):
    if not iso:
        return '—'
    try:
        return dt.datetime.fromisoformat(iso[:19]).strftime('%d/%m/%Y')
    except Exception:
        try:
            return dt.date.fromisoformat(iso[:10]).strftime('%d/%m/%Y')
        except Exception:
            return iso


def fmt_data_hora(iso):
    try:
        return dt.datetime.fromisoformat(iso[:19]).strftime('%d/%m/%Y %H:%M')
    except Exception:
        return fmt_data(iso)


def fmt_brl(v):
    try:
        v = float(v or 0)
    except Exception:
        v = 0.0
    s = '{:,.2f}'.format(v).replace(',', 'X').replace('.', ',').replace('X', '.')
    return 'R$ ' + s


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if os.path.exists(CONFIG_PATH):
        try:
            user_cfg = json.load(open(CONFIG_PATH, encoding='utf-8'))
            for k, v in user_cfg.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except Exception as e:
            print('[config] erro ao ler config.json:', e)
    else:
        try:
            json.dump(cfg, open(CONFIG_PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
            print('[config] config.json criado com valores padrão (e-mail em modo simulado).')
        except OSError:
            pass
    if os.environ.get('NEXARPAY_URL_BASE'):
        cfg['url_base'] = os.environ['NEXARPAY_URL_BASE']
    if os.environ.get('NEXARPAY_DOMINIO'):
        cfg['dominio_permitido'] = os.environ['NEXARPAY_DOMINIO']
    if os.environ.get('NEXARPAY_SMTP_HOST'):  # SMTP por variáveis de ambiente (Docker); a tela de Configurações, se usada, prevalece
        e = cfg['email']
        e.update({'modo': 'smtp', 'host': os.environ['NEXARPAY_SMTP_HOST'],
                  'porta': int(os.environ.get('NEXARPAY_SMTP_PORTA') or 465),
                  'ssl': (os.environ.get('NEXARPAY_SMTP_SSL', '1') != '0'),
                  'usuario': os.environ.get('NEXARPAY_SMTP_USUARIO', ''),
                  'senha': os.environ.get('NEXARPAY_SMTP_SENHA', '')})
        if os.environ.get('NEXARPAY_SMTP_REMETENTE'):
            e['remetente'] = os.environ['NEXARPAY_SMTP_REMETENTE']
    return cfg


CONFIG = load_config()


def hash_password(senha, salt=None, iteracoes=PBKDF2_ITER):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', senha.encode('utf-8'), bytes.fromhex(salt), iteracoes).hex()
    return h, salt


def verify_password(senha, h, salt):
    """0 = inválida, 2 = válida (hash atual), 1 = válida mas com hash legado (deve ser regravado)."""
    if not h or not salt:
        return 0
    if hmac.compare_digest(hash_password(senha, salt)[0], h):
        return 2
    if hmac.compare_digest(hash_password(senha, salt, PBKDF2_ITER_LEGADO)[0], h):
        return 1
    return 0


_DUMMY_HASH = hash_password('dummy-' + secrets.token_hex(8))


def senha_forte(senha):
    """Mínimo de 10 caracteres, com letras e números."""
    return len(senha) >= 10 and re.search(r'[A-Za-z]', senha) is not None and re.search(r'\d', senha) is not None


MSG_SENHA_FRACA = 'A senha deve ter pelo menos 10 caracteres, com letras e números.'


def parse_data_iso(s):
    try:
        return dt.date.fromisoformat(str(s)[:10]).isoformat()
    except Exception:
        return None


def mime_por_arquivo(caminho):
    t = UPLOAD_TIPOS.get(os.path.splitext(caminho or '')[1].lower())
    return t[0] if t else 'application/octet-stream'


def email_valido_dominio(email):
    dom = (CONFIG.get('dominio_permitido') or DOMINIO_PADRAO).lower().lstrip('@')
    email = (email or '').strip().lower()
    return re.match(r'^[a-z0-9._%+\-]+@' + re.escape(dom) + '$', email) is not None


def hash_token(tok):
    """O banco guarda só o SHA-256 do token de sessão (um vazamento do banco não entrega sessões válidas)."""
    return hashlib.sha256((tok or '').encode('utf-8')).hexdigest()


# ------------------------------------------------------------ criptografia de campos sensíveis
# Cifra autenticada só com a biblioteca padrão: keystream HMAC-SHA256 em modo contador + etiqueta HMAC-SHA256
# (encrypt-then-MAC, subchaves distintas, nonce aleatório de 16 bytes). Chave mestra: NEXARPAY_SECRET_KEY
# (recomendado: segredo fora do disco/volume) ou o arquivo data/secret.key (0600, criado na 1ª execução).
ENC_PREFIX = 'enc:v1:'
_KEYS = {}


def _chaves():
    if not _KEYS:
        env = os.environ.get('NEXARPAY_SECRET_KEY')
        if env:
            if len(env) < 24:
                raise SystemExit('NEXARPAY_SECRET_KEY deve ter pelo menos 24 caracteres (use um valor aleatório).')
            mestra = hashlib.sha256(env.encode('utf-8')).digest()
        else:
            kp = os.environ.get('NEXARPAY_KEY_FILE') or os.path.join(DATA_DIR, 'secret.key')
            if not os.path.exists(kp):
                os.makedirs(os.path.dirname(kp), exist_ok=True)
                fd = os.open(kp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as f:
                    f.write(secrets.token_hex(32))
                print('[cripto] chave criada em %s — FAÇA BACKUP DELA SEPARADO do banco (sem ela os dados cifrados não abrem).' % kp)
            mestra = bytes.fromhex(open(kp).read().strip())
        _KEYS['enc'] = hmac.new(mestra, b'nexarpay-enc', hashlib.sha256).digest()
        _KEYS['mac'] = hmac.new(mestra, b'nexarpay-mac', hashlib.sha256).digest()
    return _KEYS['enc'], _KEYS['mac']


def _keystream(k, nonce, n):
    out = bytearray()
    i = 0
    while len(out) < n:
        out += hmac.new(k, nonce + i.to_bytes(8, 'big'), hashlib.sha256).digest()
        i += 1
    return bytes(out[:n])


def cifrar(texto):
    ke, km = _chaves()
    pt = str(texto).encode('utf-8')
    nonce = secrets.token_bytes(16)
    ct = bytes(a ^ b for a, b in zip(pt, _keystream(ke, nonce, len(pt))))
    tag = hmac.new(km, b'v1' + nonce + ct, hashlib.sha256).digest()
    return ENC_PREFIX + base64.urlsafe_b64encode(nonce + ct + tag).decode('ascii')


def decifrar(valor):
    """Devolve o texto claro. Valores sem o prefixo (dados antigos ainda não migrados) voltam como estão."""
    if not isinstance(valor, str) or not valor.startswith(ENC_PREFIX):
        return valor
    ke, km = _chaves()
    try:
        raw = base64.urlsafe_b64decode(valor[len(ENC_PREFIX):].encode('ascii'))
        nonce, ct, tag = raw[:16], raw[16:-32], raw[-32:]
        if not hmac.compare_digest(hmac.new(km, b'v1' + nonce + ct, hashlib.sha256).digest(), tag):
            raise ValueError('etiqueta inválida')
        return bytes(a ^ b for a, b in zip(ct, _keystream(ke, nonce, len(ct)))).decode('utf-8')
    except Exception as e:
        print('[cripto] falha ao decifrar campo (chave errada ou dado adulterado):', e)
        return ''


def totp_codigo(secret_b32, passo):
    chave = base64.b32decode(secret_b32, casefold=True)
    h = hmac.new(chave, struct.pack('>Q', passo), hashlib.sha1).digest()
    o = h[-1] & 15
    return '%06d' % ((int.from_bytes(h[o:o + 4], 'big') & 0x7fffffff) % 1000000)


def mfa_exigido(u):
    if DEMO_MODE and not os.environ.get('NEXARPAY_DEMO_MFA'):
        return False  # a demonstração não força MFA (use NEXARPAY_DEMO_MFA=1 para demonstrar)
    return u['perfil'] in ((CONFIG.get('seguranca') or {}).get('mfa_perfis') or [])


def _hash_recuperacao(codigo):
    return hashlib.sha256(re.sub(r'[\s-]', '', codigo).upper().encode('utf-8')).hexdigest()


CAMPOS_LANC_SECRETOS = ('senhaSerial', 'usuarioConta')


def _cifrar_campos(d, campos):
    """Devolve (cópia de d com os campos cifrados, mudou?). Idempotente: valor já cifrado ou vazio não muda."""
    novo, mudou = dict(d), False
    for c in campos:
        v = novo.get(c)
        if v not in (None, '') and not (isinstance(v, str) and v.startswith(ENC_PREFIX)):
            novo[c] = cifrar(v)
            mudou = True
    return novo, mudou


def _decifrar_campos(d, campos):
    novo = dict(d)
    for c in campos:
        if isinstance(novo.get(c), str):
            novo[c] = decifrar(novo[c])
    return novo


def uid(prefix=''):
    return prefix + secrets.token_hex(6)


def is_inside(path, base):
    """True se 'path' está dentro de 'base' (resolve .. e links; evita o prefixo-irmão static_x)."""
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(base)]) == os.path.realpath(base)
    except ValueError:
        return False


class ApiError(Exception):
    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


# ============================================================ banco
DB_LOCK = threading.Lock()


def db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  senha_hash TEXT, salt TEXT, perfil TEXT NOT NULL, departamentos TEXT NOT NULL DEFAULT '[]',
  diretor1_id TEXT, diretor2_id TEXT, ativo INTEGER NOT NULL DEFAULT 1,
  senha_provisoria INTEGER NOT NULL DEFAULT 0, criado_em TEXT, ultimo_login TEXT,
  dashboard_tv_config TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, criado_em TEXT, expira_em TEXT
);
CREATE TABLE IF NOT EXISTS departamentos (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL UNIQUE, ativo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS properties ( chave TEXT PRIMARY KEY, valor TEXT NOT NULL );
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY, ano INTEGER NOT NULL, departamento_id TEXT NOT NULL,
  dolar REAL DEFAULT 5.5, rateio TEXT DEFAULT '{}', categorias TEXT DEFAULT '[]',
  UNIQUE(ano, departamento_id)
);
CREATE TABLE IF NOT EXISTS launches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ano INTEGER, departamento_id TEXT,
  solicitacao_id INTEGER, dados TEXT NOT NULL, criado_em TEXT, criado_por TEXT
);
CREATE TABLE IF NOT EXISTS solicitacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT UNIQUE, tipo TEXT NOT NULL, status TEXT NOT NULL,
  retorno_para INTEGER, solicitante_id TEXT NOT NULL, solicitante_nome TEXT, email TEXT,
  departamento_id TEXT, valor REAL NOT NULL DEFAULT 0, data_pagamento TEXT,
  dados TEXT NOT NULL, anexos TEXT NOT NULL DEFAULT '[]',
  aprovador1_id TEXT, aprovador2_id TEXT, criado_em TEXT, atualizado_em TEXT, encerrado_em TEXT,
  prazo_doc_fiscal TEXT, doc_fiscal TEXT, lancamento_id INTEGER, recibo_arquivo TEXT, motivo_ultimo TEXT
);
CREATE TABLE IF NOT EXISTS historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT, solicitacao_id INTEGER NOT NULL, data TEXT,
  user_id TEXT, user_nome TEXT, acao TEXT NOT NULL, etapa INTEGER, justificativa TEXT, detalhes TEXT
);
CREATE TABLE IF NOT EXISTS arquivos (
  id TEXT PRIMARY KEY, nome TEXT, mime TEXT, tamanho INTEGER, caminho TEXT, user_id TEXT, criado_em TEXT
);
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, para TEXT, assunto TEXT, corpo TEXT, anexo TEXT,
  status TEXT, erro TEXT
);
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, user_id TEXT, user_email TEXT, ip TEXT,
  acao TEXT NOT NULL, alvo TEXT, detalhes TEXT, hash_ant TEXT, hash TEXT
);
CREATE TRIGGER IF NOT EXISTS auditoria_sem_update BEFORE UPDATE ON auditoria
BEGIN SELECT RAISE(ABORT, 'a trilha de auditoria é somente de inclusão'); END;
CREATE TRIGGER IF NOT EXISTS auditoria_sem_delete BEFORE DELETE ON auditoria
BEGIN SELECT RAISE(ABORT, 'a trilha de auditoria é somente de inclusão'); END;
CREATE INDEX IF NOT EXISTS idx_aud_data ON auditoria(data);
CREATE TABLE IF NOT EXISTS empresas (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL UNIQUE COLLATE NOCASE, ativa INTEGER NOT NULL DEFAULT 1,
  participa_rateio INTEGER NOT NULL DEFAULT 1, rateio_padrao REAL NOT NULL DEFAULT 0, ordem INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ajustes ( chave TEXT PRIMARY KEY, valor TEXT );
CREATE TABLE IF NOT EXISTS anos_fechados ( ano INTEGER PRIMARY KEY, fechado_em TEXT, fechado_por TEXT );
CREATE TABLE IF NOT EXISTS relatorios_filtros (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, relatorio TEXT NOT NULL, nome TEXT NOT NULL, filtros TEXT NOT NULL, colunas TEXT, criado_em TEXT
);
CREATE TABLE IF NOT EXISTS relatorios_agenda (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, relatorio TEXT NOT NULL, filtros TEXT NOT NULL, colunas TEXT, formatos TEXT NOT NULL,
  dia INTEGER NOT NULL, destinatarios TEXT, ativo INTEGER NOT NULL DEFAULT 1, ultimo_envio TEXT, criado_em TEXT
);
CREATE TABLE IF NOT EXISTS ips_conhecidos (
  user_id TEXT NOT NULL, ip TEXT NOT NULL, ultimo_uso TEXT, PRIMARY KEY(user_id, ip)
);
CREATE INDEX IF NOT EXISTS idx_sol_status ON solicitacoes(status);
CREATE INDEX IF NOT EXISTS idx_sol_solic ON solicitacoes(solicitante_id);
CREATE INDEX IF NOT EXISTS idx_hist_sol ON historico(solicitacao_id);
"""


def j(v):
    return json.dumps(v, ensure_ascii=False)


def pj(s, default):
    try:
        return json.loads(s) if s else default
    except Exception:
        return default


def ensure_column(conn, table, column, coldef):
    """Migração leve: adiciona a coluna se o banco já existir sem ela (bancos criados antes desta versão)."""
    cols = [r['name'] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()]
    if column not in cols:
        conn.execute('ALTER TABLE %s ADD COLUMN %s %s' % (table, column, coldef))


def _sha256_arquivo(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


AUDIT_LOCK = threading.Lock()


def _hash_auditoria(ant, data, user_id, email, ip, acao, alvo, det):
    return hashlib.sha256('|'.join([ant or '', data, user_id or '', email or '', ip or '', acao, alvo or '', det or '']).encode('utf-8')).hexdigest()


def audit(conn, user, acao, alvo=None, detalhes=None, ip=None, email=None):
    """Registra na trilha (encadeada por hash: qualquer alteração/remoção posterior quebra a verificação).
    Nunca passe senhas, tokens nem dados bancários em 'detalhes'. Chamar DEPOIS do commit da ação."""
    try:
        data = now_iso()
        uid_ = user['id'] if user else None
        em = (user['email'] if user else (email or ''))[:200] or None
        det = j(detalhes) if detalhes is not None else None
        with AUDIT_LOCK:
            r = conn.execute('SELECT hash FROM auditoria ORDER BY id DESC LIMIT 1').fetchone()
            ant = r['hash'] if r else ''
            h = _hash_auditoria(ant, data, uid_, em, ip, acao, str(alvo) if alvo is not None else None, det)
            conn.execute('INSERT INTO auditoria(data,user_id,user_email,ip,acao,alvo,detalhes,hash_ant,hash) VALUES(?,?,?,?,?,?,?,?,?)',
                         (data, uid_, em, ip, acao, str(alvo) if alvo is not None else None, det, ant, h))
            conn.commit()
    except Exception:
        traceback.print_exc()
        print('[auditoria] FALHA ao registrar:', acao)


def verificar_auditoria(conn):
    ant, total = '', 0
    for r in conn.execute('SELECT * FROM auditoria ORDER BY id'):
        total += 1
        esperado = _hash_auditoria(ant, r['data'], r['user_id'], r['user_email'], r['ip'], r['acao'], r['alvo'], r['detalhes'])
        if r['hash_ant'] != ant or r['hash'] != esperado:
            return {'ok': False, 'total': total, 'primeiraQuebra': r['id']}
        ant = r['hash']
    return {'ok': True, 'total': total, 'primeiraQuebra': None}


def migrar_cifragem(conn):
    """Cifra o que ainda estiver em texto puro (credenciais dos lançamentos e dados bancários das solicitações) e
    oculta valores bancários que ficaram no histórico de alterações. Idempotente; não faz commit."""
    n = 0
    for r in conn.execute('SELECT id,dados FROM launches').fetchall():
        novo, mudou = _cifrar_campos(pj(r['dados'], {}), CAMPOS_LANC_SECRETOS)
        if mudou:
            conn.execute('UPDATE launches SET dados=? WHERE id=?', (j(novo), r['id']))
            n += 1
    for r in conn.execute('SELECT id,dados FROM solicitacoes').fetchall():
        novo, mudou = _cifrar_campos(pj(r['dados'], {}), CAMPOS_BANCARIOS)
        if mudou:
            conn.execute('UPDATE solicitacoes SET dados=? WHERE id=?', (j(novo), r['id']))
            n += 1
    for r in conn.execute("SELECT id,detalhes FROM historico WHERE acao='editada' AND detalhes IS NOT NULL").fetchall():
        det = pj(r['detalhes'], None)
        if isinstance(det, dict) and any(k in det and (det[k] or {}).get('de') != MASCARA_BANCARIA for k in CAMPOS_BANCARIOS):
            for k in CAMPOS_BANCARIOS:
                if k in det:
                    det[k] = {'de': MASCARA_BANCARIA, 'para': MASCARA_BANCARIA}
            conn.execute('UPDATE historico SET detalhes=? WHERE id=?', (j(det), r['id']))
            n += 1
    if n:
        print('[cripto] %d registro(s) migrado(s) para armazenamento cifrado.' % n)
    return n


# ------------------------------------------------------------ empresas (cadastro por cliente)
GRUPO_ID = 'GRUPO'  # opção especial: despesa do grupo, dividida entre as empresas pelo rateio do orçamento


def empresa_out(r):
    return {'id': r['id'], 'nome': r['nome'], 'ativa': bool(r['ativa']), 'participaRateio': bool(r['participa_rateio']),
            'rateioPadrao': round((r['rateio_padrao'] or 0) * 100, 4), 'ordem': r['ordem']}


def empresas_lista(conn):
    return [empresa_out(r) for r in conn.execute('SELECT * FROM empresas ORDER BY ordem, nome')]


def get_ajuste(conn, chave, padrao=None):
    r = conn.execute('SELECT valor FROM ajustes WHERE chave=?', (chave,)).fetchone()
    return pj(r['valor'], padrao) if r else padrao


def set_ajuste(conn, chave, valor):
    conn.execute('INSERT OR REPLACE INTO ajustes(chave,valor) VALUES(?,?)', (chave, j(valor)))


CAMPOS_SMTP = ('modo', 'host', 'porta', 'ssl', 'usuario', 'remetente')


def aplicar_smtp_db(conn):
    """Se o admin salvou o SMTP pela tela, ele passa a valer (a senha fica cifrada no banco)."""
    c = get_ajuste(conn, 'smtp', None)
    if not c:
        return False
    e = CONFIG['email']
    for k in CAMPOS_SMTP:
        if k in c:
            e[k] = c[k]
    if c.get('senha'):
        e['senha'] = decifrar(c['senha'])
    e['_origem'] = 'tela'
    return True


def grupo_nome(conn):
    return get_ajuste(conn, 'grupoNome', 'Grupo') or 'Grupo'


def mapa_empresas(conn):
    m = {r['id']: r['nome'] for r in conn.execute('SELECT id,nome FROM empresas')}
    m[GRUPO_ID] = grupo_nome(conn)
    return m


def validar_empresa(conn, eid):
    """Empresa é obrigatória: 'GRUPO' (só com 2+ empresas no rateio) ou o id de uma empresa ativa."""
    if not eid or not isinstance(eid, str):
        raise ApiError(400, 'Informe a empresa.')
    if eid == GRUPO_ID:
        if conn.execute('SELECT COUNT(*) FROM empresas WHERE ativa=1 AND participa_rateio=1').fetchone()[0] < 2:
            raise ApiError(400, 'A opção do grupo só existe quando há duas ou mais empresas no rateio.')
        return eid
    r = conn.execute('SELECT ativa FROM empresas WHERE id=?', (eid,)).fetchone()
    if not r or not r['ativa']:
        raise ApiError(400, 'Empresa inválida ou inativa.')
    return eid


def _sem_acento(t):
    return ''.join(c for c in unicodedata.normalize('NFD', str(t or '')) if unicodedata.category(c) != 'Mn').lower().strip()


def mapear_empresa_legada(conn, texto):
    """Converte o texto livre antigo ('Grupo Gpac', 'Gpac', 'Imobiliário'…) no id do cadastro. None = não reconhecido."""
    t = _sem_acento(texto)
    if not t:
        return None
    if t in ('grupo gpac', 'grupo'):
        cand = GRUPO_ID
    elif 'etools' in t:
        cand = 'ETOOLS'
    elif 'gnk' in t:
        cand = 'GNK'
    elif 'hug' in t or 'squad' in t or 'imobili' in t:
        cand = 'HUGHAUS'
    elif 'gpac' in t:
        cand = 'GPAC'
    else:
        return None
    if cand != GRUPO_ID and not conn.execute('SELECT 1 FROM empresas WHERE id=?', (cand,)).fetchone():
        return None
    return cand


def garantir_empresas_legado(conn):
    """Base antiga (já tem orçamentos/lançamentos/solicitações, mas ainda não tem cadastro de empresas): cria as 4 empresas
    do Grupo Gpac, com os ids iguais às chaves antigas do rateio (assim o rateio já gravado nos orçamentos continua válido)."""
    if conn.execute('SELECT COUNT(*) FROM empresas').fetchone()[0]:
        return False
    if not any(conn.execute('SELECT COUNT(*) FROM %s' % t).fetchone()[0] for t in ('budgets', 'launches', 'solicitacoes')):
        return False
    for i, (eid, nome, pct) in enumerate((('GPAC', 'Gpac', .60), ('ETOOLS', 'Etools', .30), ('GNK', 'GNK', .05), ('HUGHAUS', 'Squad Imobiliário', .05))):
        conn.execute('INSERT INTO empresas(id,nome,ativa,participa_rateio,rateio_padrao,ordem) VALUES(?,?,1,1,?,?)', (eid, nome, pct, i))
    if get_ajuste(conn, 'grupoNome') is None:
        set_ajuste(conn, 'grupoNome', 'Grupo Gpac')
    print('[empresas] cadastro criado a partir da base existente (Gpac, Etools, GNK, Squad Imobiliário).')
    return True


def normalizar_empresas(conn):
    """Troca o campo de texto 'empresa' por 'empresaId' em lançamentos e solicitações. Idempotente; não faz commit."""
    rel = {'lancamentos': 0, 'solicitacoes': 0, 'nao_reconhecidos': {}, 'sem_empresa': 0}
    for tabela in ('launches', 'solicitacoes'):
        for r in conn.execute('SELECT id,dados FROM %s' % tabela).fetchall():
            d = pj(r['dados'], {})
            if d.get('empresaId'):
                continue
            eid = mapear_empresa_legada(conn, d.get('empresa'))
            if eid:
                d['empresaId'] = eid
                d.pop('empresa', None)
                conn.execute('UPDATE %s SET dados=? WHERE id=?' % tabela, (j(d), r['id']))
                rel['lancamentos' if tabela == 'launches' else 'solicitacoes'] += 1
            elif d.get('empresa'):
                rel['nao_reconhecidos'][str(d['empresa'])] = rel['nao_reconhecidos'].get(str(d['empresa']), 0) + 1
            else:
                rel['sem_empresa'] += 1
    if conn.execute('SELECT COUNT(*) FROM empresas').fetchone()[0]:
        conn.execute("DELETE FROM properties WHERE chave IN ('empresas','empresasSolicitacao')")  # as duas listas antigas deixam de existir
    return rel


def migrar_empresas(conn):
    criou = garantir_empresas_legado(conn)
    rel = normalizar_empresas(conn)
    if criou or rel['lancamentos'] or rel['solicitacoes']:
        print('[empresas] migração: %d lançamento(s) e %d solicitação(ões) vinculados ao cadastro; sem empresa: %d; não reconhecidos: %s' % (
            rel['lancamentos'], rel['solicitacoes'], rel['sem_empresa'], rel['nao_reconhecidos'] or '—'))
        conn.commit()
        audit(conn, None, 'empresas.migracao', None, rel)
    return rel


SEM_RATEIO = 'SEM_RATEIO'  # gasto do grupo em ano/departamento sem rateio cadastrado: não é dividido


def ano_fechado(conn, ano):
    try:
        return conn.execute('SELECT 1 FROM anos_fechados WHERE ano=?', (int(ano),)).fetchone() is not None
    except (TypeError, ValueError):
        return False


def exige_ano_aberto(conn, ano, o_que):
    if ano_fechado(conn, ano):
        raise ApiError(403, 'O ano fiscal %s está fechado: %s não pode ser alterado. O Administrador pode reabrir o ano, com justificativa.' % (ano, o_que))


def validar_rateio(conn, rateio):
    """Rateio = {id_da_empresa: fração}. Só empresas cadastradas que participam do rateio; soma exatamente 100%."""
    if not isinstance(rateio, dict) or not rateio:
        raise ApiError(400, 'Informe o rateio.')
    soma = 0.0
    for k, v in rateio.items():
        r = conn.execute('SELECT participa_rateio FROM empresas WHERE id=?', (k,)).fetchone()
        if not r or not r['participa_rateio']:
            raise ApiError(400, 'Rateio inválido: empresa desconhecida ou fora do rateio (%s).' % k)
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise ApiError(400, 'Rateio inválido: percentual não numérico.')
        if not (0 <= v <= 1):
            raise ApiError(400, 'Rateio inválido: cada percentual deve estar entre 0% e 100%.')
        soma += v
    if abs(soma - 1.0) > 0.0001:
        raise ApiError(400, 'Rateio inválido: a soma é %.2f%% (deve ser exatamente 100%%).' % (soma * 100))


def _rateio_igual(a, b):
    a, b = a or {}, b or {}
    return all(abs(float(a.get(k) or 0) - float(b.get(k) or 0)) < 1e-6 for k in set(a) | set(b))


def _alocar(valor, empresa_id, rateio):
    if empresa_id == GRUPO_ID:
        soma = sum(float(v or 0) for v in rateio.values())
        if soma <= 0:
            return {SEM_RATEIO: valor}
        return {k: valor * float(v) / soma for k, v in rateio.items() if v}
    return {empresa_id or 'SEM_EMPRESA': valor}


def gastos_por_empresa(conn, dep, ano, rateio):
    m = {}
    for r in conn.execute('SELECT dados FROM launches WHERE departamento_id=? AND ano=?', (dep, ano)):
        d = pj(r['dados'], {})
        for k, v in _alocar(float(d.get('custoTotal') or 0), d.get('empresaId'), rateio).items():
            m[k] = m.get(k, 0.0) + v
    return m


def impacto_rateio(conn, b, novo):
    """Prévia da troca de rateio de um orçamento: orçado, gasto e saldo por empresa, antes e depois. O gasto TOTAL não muda;
    muda a divisão do que foi gasto no 'grupo' (despesas de uma empresa específica continuam 100% nela)."""
    antigo = pj(b['rateio'], {})
    total = sum(_aprovado_cat(c) for c in pj(b['categorias'], []))
    ga, gd = gastos_por_empresa(conn, b['departamento_id'], b['ano'], antigo), gastos_por_empresa(conn, b['departamento_id'], b['ano'], novo)
    nomes = mapa_empresas(conn)
    linhas = []
    for k in dict.fromkeys(list(antigo) + list(novo) + list(ga) + list(gd)):
        oa, od = total * float(antigo.get(k) or 0), total * float(novo.get(k) or 0)
        nome = nomes.get(k) or ('%s (sem rateio)' % grupo_nome(conn) if k == SEM_RATEIO else 'Sem empresa' if k == 'SEM_EMPRESA' else k)
        linhas.append({'id': k, 'nome': nome, 'orcadoAntes': round(oa, 2), 'orcadoDepois': round(od, 2), 'gastoAntes': round(ga.get(k, 0.0), 2),
                       'gastoDepois': round(gd.get(k, 0.0), 2), 'saldoAntes': round(oa - ga.get(k, 0.0), 2), 'saldoDepois': round(od - gd.get(k, 0.0), 2)})
    negativos = [l['nome'] for l in linhas if l['id'] in nomes and l['saldoDepois'] < -0.005 and l['saldoAntes'] >= -0.005]
    return {'ano': b['ano'], 'totalOrcado': round(total, 2), 'totalGasto': round(sum(ga.values()), 2), 'linhas': linhas, 'ficamNegativas': negativos}


def estatisticas_ano(conn, ano):
    return {'ano': ano, 'orcamentos': conn.execute('SELECT COUNT(*) FROM budgets WHERE ano=?', (ano,)).fetchone()[0],
            'lancamentos': conn.execute('SELECT COUNT(*) FROM launches WHERE ano=?', (ano,)).fetchone()[0],
            'solicitacoesAbertas': conn.execute("SELECT COUNT(*) FROM solicitacoes WHERE status IN ('aprovacao1','aprovacao2','rh','rh2','financeiro','alteracao') AND substr(data_pagamento,1,4)=?", (str(ano),)).fetchone()[0]}


def pendencias_empresa(conn):
    sols = [{'numero': r['numero'], 'status': STATUS_LABEL.get(r['status'], r['status'])}
            for r in conn.execute("SELECT numero,status,dados FROM solicitacoes WHERE status<>'reprovada' ORDER BY id") if not pj(r['dados'], {}).get('empresaId')]
    lan = sum(1 for r in conn.execute('SELECT dados FROM launches') if not pj(r['dados'], {}).get('empresaId'))
    return {'solicitacoes': sols, 'lancamentos': lan}


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(RECIBO_DIR, exist_ok=True)
    conn = db()
    conn.executescript(SCHEMA)
    ensure_column(conn, 'users', 'dashboard_tv_config', 'TEXT')
    ensure_column(conn, 'users', 'rh1', 'INTEGER NOT NULL DEFAULT 0')
    ensure_column(conn, 'users', 'rh2', 'INTEGER NOT NULL DEFAULT 0')
    ensure_column(conn, 'users', 'reset_hash', 'TEXT')
    ensure_column(conn, 'users', 'reset_salt', 'TEXT')
    ensure_column(conn, 'users', 'reset_exp', 'TEXT')
    ensure_column(conn, 'solicitacoes', 'alertas', 'TEXT')
    ensure_column(conn, 'users', 'mfa_secret', 'TEXT')
    ensure_column(conn, 'users', 'mfa_ativo', 'INTEGER NOT NULL DEFAULT 0')
    ensure_column(conn, 'users', 'mfa_codes', 'TEXT')
    ensure_column(conn, 'users', 'mfa_ultimo_passo', 'INTEGER NOT NULL DEFAULT 0')
    ensure_column(conn, 'sessions', 'etapa', 'TEXT')
    ensure_column(conn, 'sessions', 'ip', 'TEXT')
    ensure_column(conn, 'sessions', 'ua', 'TEXT')
    ensure_column(conn, 'sessions', 'reauth_em', 'TEXT')
    ensure_column(conn, 'arquivos', 'sha256', 'TEXT')
    conn.commit()
    if conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0:
        if DEMO_MODE:
            seed_db(conn)  # só a demonstração recebe usuários e dados fictícios
        else:
            criar_admin_inicial(conn)
    migrar_cifragem(conn)
    migrar_empresas(conn)
    for r in conn.execute('SELECT id,caminho FROM arquivos WHERE sha256 IS NULL').fetchall():  # hash dos anexos antigos (detecção de arquivo repetido)
        pth = os.path.join(UPLOAD_DIR, os.path.basename(r['caminho'] or ''))
        if os.path.isfile(pth):
            conn.execute('UPDATE arquivos SET sha256=? WHERE id=?', (_sha256_arquivo(pth), r['id']))
    conn.commit()
    conn.close()


# ------------------------------------------------------------ primeiro acesso (produção)
def criar_admin_inicial(conn):
    """Banco novo fora do modo demo: cria SÓ o primeiro administrador (e-mail em NEXARPAY_ADMIN_EMAIL), sem usuários nem
    orçamentos de exemplo. A senha provisória é aleatória, vai para um arquivo 0600 e a troca é obrigatória no 1º login."""
    email = (os.environ.get('NEXARPAY_ADMIN_EMAIL') or '').strip().lower()
    dom = CONFIG.get('dominio_permitido') or DOMINIO_PADRAO
    if not email_valido_dominio(email):
        conn.close()
        raise SystemExit('Banco novo: defina NEXARPAY_ADMIN_EMAIL com o e-mail do primeiro administrador (precisa ser @%s).\n'
                         'Exemplo:  NEXARPAY_ADMIN_EMAIL=voce@%s python3 server.py\n'
                         'Para dados de exemplo (só demonstração), use NEXARPAY_DEMO=1.' % (dom, dom))
    nome = (os.environ.get('NEXARPAY_ADMIN_NOME') or 'Administrador').strip()[:120]
    senha = secrets.token_urlsafe(12) + str(secrets.randbelow(90) + 10)
    h, sl = hash_password(senha)
    conn.execute('INSERT INTO users(id,nome,email,senha_hash,salt,perfil,departamentos,ativo,senha_provisoria,criado_em) VALUES(?,?,?,?,?,?,?,1,1,?)',
                 (uid('u_'), nome, email, h, sl, 'admin', '[]', now_iso()))
    listas = {'categorias': [], 'categoriasReembolso': ['Alimentação hora extra', 'Alimentação com cliente', 'Alimentação em viagem', 'Hospedagem', 'Uber/Transporte', 'Motoboy', 'Combustível', 'Outro'],
              'fornecedores': [], 'setores': [], 'clientes': [], 'tiposCompra': ['Solicitação de Pagamento']}
    listas['categorias'] = list(listas['categoriasReembolso']) + ['Cliente/Fornecedor']
    for k, v in listas.items():
        conn.execute('INSERT OR REPLACE INTO properties(chave,valor) VALUES(?,?)', (k, j(v)))
    conn.commit()
    arq = os.path.join(DATA_DIR, 'credenciais-iniciais.txt')
    fd = os.open(arq, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('Primeiro acesso do NexarPay (a troca de senha é obrigatória; este arquivo é apagado quando você trocar)\n%s\t%s\n' % (email, senha))
    print('[setup] Administrador inicial criado: %s' % email)
    print('[setup] Senha provisória em %s (leia com: cat %s). Nenhum usuário ou dado de exemplo foi criado.' % (arq, arq))


# ------------------------------------------------------------ seed
def seed_db(conn):
    """Popula o banco na primeira execução: usuários de teste de cada perfil, departamentos,
    orçamento real da T.I. (planilhas) e orçamentos fictícios para teste."""
    print('[seed] banco vazio — carregando dados iniciais…')
    seed_path = os.path.join(SEED_DIR, 'dados-iniciais.json')
    seed = json.load(open(seed_path, encoding='utf-8')) if os.path.exists(seed_path) else {'launches': [], 'properties': {}, 'budget': None}
    dom = CONFIG.get('dominio_permitido') or DOMINIO_PADRAO

    deps = [('dep_ti', 'T.I.'), ('dep_adm', 'Administrativo'), ('dep_cri', 'Criação'), ('dep_dev', 'Desenvolvimento'), ('dep_fin', 'Financeiro'), ('dep_rh', 'RH')]
    for did, nome in deps:
        conn.execute('INSERT INTO departamentos(id,nome,ativo) VALUES(?,?,1)', (did, nome))

    demo_senha = os.environ.get('NEXARPAY_DEMO_SENHA')
    credenciais = []

    def add_user(uid_, nome, email, senha_ignorada, perfil, departamentos, d1=None, d2=None):
        # nenhuma senha fixa no código: aleatória por usuário (ou a senha única de NEXARPAY_DEMO_SENHA)
        senha = demo_senha or (secrets.token_urlsafe(9) + str(secrets.randbelow(90) + 10))
        h, s = hash_password(senha)
        conn.execute('INSERT INTO users(id,nome,email,senha_hash,salt,perfil,departamentos,diretor1_id,diretor2_id,ativo,senha_provisoria,criado_em) VALUES(?,?,?,?,?,?,?,?,?,1,0,?)',
                     (uid_, nome, email.lower(), h, s, perfil, j(departamentos), d1, d2, now_iso()))
        credenciais.append((email.lower(), senha, perfil))

    add_user('u_admin', 'Administrador', 'admin@' + dom, None, 'admin', ['dep_ti', 'dep_adm', 'dep_cri', 'dep_dev', 'dep_fin'], 'u_dir1', 'u_dir2')
    add_user('u_dir1', 'Diretor(a) Um', 'diretor1@' + dom, None, 'diretor', [])
    add_user('u_dir2', 'Diretor(a) Dois', 'diretor2@' + dom, None, 'diretor', [])
    add_user('u_fin', 'Contas a Pagar', 'financeiro@' + dom, None, 'financeiro', ['dep_fin'])
    add_user('u_gestor_ti', 'Gestor(a) T.I.', 'gestor.ti@' + dom, None, 'gestor', ['dep_ti', 'dep_adm'], 'u_dir1', 'u_dir2')
    add_user('u_gestor_cri', 'Gestor(a) Criação', 'gestor.criacao@' + dom, None, 'gestor', ['dep_cri'], 'u_dir1', 'u_dir2')
    add_user('u_colab', 'Colaborador(a) Dev', 'colaborador@' + dom, None, 'colaborador', ['dep_dev'], 'u_dir1', 'u_dir2')
    add_user('u_rh', 'RH', 'rh@' + dom, None, 'rh', ['dep_rh'], 'u_dir1', 'u_dir2')
    add_user('u_rh2', 'RH 2', 'rh2@' + dom, None, 'rh', ['dep_rh'], 'u_dir1', 'u_dir2')
    conn.execute("UPDATE users SET rh1=1 WHERE id='u_rh'")
    conn.execute("UPDATE users SET rh2=1 WHERE id='u_rh2'")
    add_user('u_tv', 'Painel TV', 'tv@' + dom, None, 'tv', [])

    props = seed.get('properties') or {}
    props.setdefault('categorias', [])
    for c in ['Cliente/Fornecedor', 'Material de Escritório', 'Serviços Terceirizados', 'Manutenção Predial', 'Viagens e Deslocamentos',
              'Software de Design', 'Banco de Imagens e Fontes', 'Freelancers', 'Equipamentos', 'Infraestrutura Cloud', 'Licenças de Desenvolvimento', 'Ferramentas SaaS']:
        if c not in props['categorias']:
            props['categorias'].append(c)
    props['categoriasReembolso'] = ['Alimentação hora extra', 'Alimentação com cliente', 'Alimentação em viagem', 'Hospedagem', 'Uber/Transporte', 'Motoboy', 'Combustível', 'Outro']
    for c in props['categoriasReembolso']:
        if c not in props['categorias']:
            props['categorias'].append(c)
    props['clientes'] = ['Cliente Exemplo A', 'Cliente Exemplo B', 'Cliente Exemplo C']
    props.setdefault('tiposCompra', [])
    if 'Solicitação de Pagamento' not in props['tiposCompra']:
        props['tiposCompra'].append('Solicitação de Pagamento')
    for k, v in props.items():
        conn.execute('INSERT OR REPLACE INTO properties(chave,valor) VALUES(?,?)', (k, j(v)))

    for i, (eid, nome, pct) in enumerate((('GPAC', 'Gpac', .60), ('ETOOLS', 'Etools', .30), ('GNK', 'GNK', .05), ('HUGHAUS', 'Squad Imobiliário', .05))):
        conn.execute('INSERT INTO empresas(id,nome,ativa,participa_rateio,rateio_padrao,ordem) VALUES(?,?,1,1,?,?)', (eid, nome, pct, i))
    set_ajuste(conn, 'grupoNome', 'Grupo Gpac')
    for l in seed.get('launches') or []:
        lid = l.pop('id', None)
        conn.execute('INSERT INTO launches(id,ano,departamento_id,solicitacao_id,dados,criado_em,criado_por) VALUES(?,?,?,?,?,?,?)',
                     (lid, l.get('ano'), 'dep_ti', None, j(l), now_iso(), 'seed'))

    # orçamento T.I. real (planilhas) + fictícios para testes
    if seed.get('budget'):
        b = seed['budget']
        conn.execute('INSERT INTO budgets(id,ano,departamento_id,dolar,rateio,categorias) VALUES(?,?,?,?,?,?)',
                     ('bud_ti_2026', int(b.get('ano') or 2026), 'dep_ti', float(b.get('dolar') or 5.5), j(b.get('rateio') or {}), j(b.get('categorias') or [])))

    def cat(id_, nome, vinc, linhas):
        return {'id': id_, 'nome': nome, 'categoriasLancamento': vinc,
                'linhas': [{'id': id_ + '_l' + str(i), 'nome': ln, 'cenarios': [{'id': id_ + '_c' + str(i), 'nome': 'Proposta aprovada', 'valor': val, 'prioridade': 'Média', 'aprovado': True, 'observacao': ''}]}
                           for i, (ln, val) in enumerate(linhas)]}

    reemb = props['categoriasReembolso']
    rateio = {'GPAC': 0.6, 'ETOOLS': 0.3, 'GNK': 0.05, 'HUGHAUS': 0.05}
    ficticios = {
        'dep_adm': [cat('adm_escritorio', 'Material de Escritório', ['Material de Escritório'], [('Papelaria e suprimentos', 18000), ('Mobiliário', 25000)]),
                    cat('adm_terceiros', 'Serviços Terceirizados', ['Serviços Terceirizados'], [('Limpeza e conservação', 96000), ('Segurança patrimonial', 60000)]),
                    cat('adm_predial', 'Manutenção Predial', ['Manutenção Predial'], [('Reparos e manutenção', 40000)]),
                    cat('adm_viagens', 'Viagens e Deslocamentos', ['Viagens e Deslocamentos'], [('Passagens e hospedagem', 55000)]),
                    cat('adm_reemb', 'Reembolsos', reemb, [('Reembolsos de colaboradores', 30000)]),
                    cat('adm_forn', 'Pagamentos a Clientes/Fornecedores', ['Cliente/Fornecedor'], [('Pagamentos diversos', 80000)])],
        'dep_cri': [cat('cri_design', 'Software de Design', ['Software de Design'], [('Adobe Creative Cloud', 42000), ('Figma / Canva', 9000)]),
                    cat('cri_bancos', 'Banco de Imagens e Fontes', ['Banco de Imagens e Fontes'], [('Shutterstock / Getty', 24000), ('Fontes e plugins', 6000)]),
                    cat('cri_free', 'Freelancers', ['Freelancers'], [('Ilustração e motion', 70000)]),
                    cat('cri_equip', 'Equipamentos', ['Equipamentos'], [('Monitores e mesas digitalizadoras', 35000)]),
                    cat('cri_reemb', 'Reembolsos', reemb, [('Reembolsos de colaboradores', 15000)]),
                    cat('cri_forn', 'Pagamentos a Clientes/Fornecedores', ['Cliente/Fornecedor'], [('Gráficas e produção', 120000)])],
        'dep_dev': [cat('dev_cloud', 'Infraestrutura Cloud', ['Infraestrutura Cloud'], [('AWS / Google Cloud', 90000), ('Domínios e CDN', 8000)]),
                    cat('dev_lic', 'Licenças de Desenvolvimento', ['Licenças de Desenvolvimento'], [('JetBrains / GitHub', 22000)]),
                    cat('dev_saas', 'Ferramentas SaaS', ['Ferramentas SaaS'], [('Monitoramento e CI/CD', 30000)]),
                    cat('dev_free', 'Freelancers', ['Freelancers'], [('Desenvolvedores externos', 110000)]),
                    cat('dev_reemb', 'Reembolsos', reemb, [('Reembolsos de colaboradores', 12000)]),
                    cat('dev_forn', 'Pagamentos a Clientes/Fornecedores', ['Cliente/Fornecedor'], [('Pagamentos diversos', 45000)])],
    }
    ficticios['dep_rh'] = [cat('rh_free', 'Freelancers', ['Freelancers'], [('Profissionais autônomos', 60000)]),
                           cat('rh_forn', 'Pagamentos a Clientes/Fornecedores', ['Cliente/Fornecedor'], [('Pagamentos diversos', 15000)]),
                           cat('rh_reemb', 'Reembolsos', reemb, [('Reembolsos de colaboradores', 8000)])]
    for did, cats in ficticios.items():
        conn.execute('INSERT INTO budgets(id,ano,departamento_id,dolar,rateio,categorias) VALUES(?,?,?,?,?,?)',
                     ('bud_' + did + '_2026', 2026, did, 5.5, j(rateio), j(cats)))
    migrar_cifragem(conn)
    normalizar_empresas(conn)
    conn.commit()
    arq = os.path.join(DATA_DIR, 'credenciais-iniciais.txt')
    try:
        fd = os.open(arq, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write('Credenciais iniciais do NexarPay (gere novas senhas e APAGUE este arquivo)\n')
            for em, sn, pf in credenciais:
                f.write('%s\t%s\t%s\n' % (em, sn, pf))
    except OSError as e:
        print('[seed] não foi possível gravar credenciais-iniciais.txt:', e)
    print('[seed] concluído. Credenciais iniciais gravadas em %s (somente leitura do dono) — troque as senhas no 1º acesso.' % arq)
    if demo_senha:
        print('[seed] modo demo: todos os usuários usam a senha de NEXARPAY_DEMO_SENHA.')
    else:
        for em, sn, pf in credenciais:
            print('[seed]   %-34s %-14s %s' % (em, pf, sn))


# ============================================================ e-mail
def email_log(conn, para, assunto, corpo, anexo, status, erro=None):
    conn.execute('INSERT INTO email_log(data,para,assunto,corpo,anexo,status,erro) VALUES(?,?,?,?,?,?,?)',
                 (now_iso(), para, assunto, corpo, anexo, status, erro))
    conn.commit()


def _smtp_send(para, assunto, corpo, anexo_path=None):
    ecfg = CONFIG['email']
    msg = EmailMessage()
    msg['From'] = ecfg.get('remetente') or ecfg.get('usuario')
    msg['To'] = para
    if ecfg.get('copia_para'):
        msg['Cc'] = ', '.join(ecfg['copia_para'])
    msg['Subject'] = assunto
    msg.set_content(corpo)
    mimes = {'.pdf': 'pdf', '.xlsx': 'vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
    for caminho in ([anexo_path] if isinstance(anexo_path, str) else (anexo_path or [])):
        if caminho and os.path.exists(caminho):
            with open(caminho, 'rb') as f:
                msg.add_attachment(f.read(), maintype='application', subtype=mimes.get(os.path.splitext(caminho)[1].lower(), 'octet-stream'), filename=os.path.basename(caminho))
    host, port = ecfg.get('host'), int(ecfg.get('porta') or 465)
    if ecfg.get('ssl', True):
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=30) as s:
            s.login(ecfg['usuario'], ecfg['senha'])
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(ecfg['usuario'], ecfg['senha'])
            s.send_message(msg)


def enviar_email(para, assunto, corpo, anexo_path=None, sincrono=False, sensivel=False):
    """Envia (ou simula) um e-mail em segundo plano e registra no email_log."""
    modo = (CONFIG.get('email') or {}).get('modo', 'simulado')
    corpo_log = '[conteúdo omitido do log: contém credenciais]' if (sensivel and not DEMO_MODE) else corpo
    anexo_log = ', '.join(os.path.basename(a) for a in anexo_path) if isinstance(anexo_path, (list, tuple)) else anexo_path

    def run():
        conn = db()
        try:
            if modo == 'smtp':
                _smtp_send(para, assunto, corpo, anexo_path)
                email_log(conn, para, assunto, corpo_log, anexo_log, 'enviado')
            else:
                email_log(conn, para, assunto, corpo_log, anexo_log, 'simulado')
                print('[email simulado] para=%s assunto=%s' % (para, assunto))
        except Exception as e:
            email_log(conn, para, assunto, corpo_log, anexo_log, 'erro', str(e))
            print('[email] falha ao enviar para %s: %s' % (para, e))
        finally:
            conn.close()

    if sincrono:
        run()
    else:
        threading.Thread(target=run, daemon=True).start()


# ============================================================ PDF (recibo) — gerador mínimo, sem dependências
def _pdf_escape(text):
    b = (text or '').encode('cp1252', 'replace')
    return b.replace(b'\\', b'\\\\').replace(b'(', b'\\(').replace(b')', b'\\)')


_HELV_W = {  # larguras aproximadas (Helvetica, /1000) para quebra de linha
    ' ': 278, 'i': 222, 'l': 222, 'j': 222, 't': 278, 'f': 278, 'r': 333, 'I': 278, '.': 278, ',': 278, ':': 278, '-': 333,
    'm': 833, 'w': 722, 'M': 833, 'W': 944, 'O': 778, 'G': 778, 'Q': 778, 'C': 722, 'D': 722, 'H': 722, 'N': 722, 'R': 722, 'U': 722,
}


def _text_width(text, size):
    return sum(_HELV_W.get(ch, 556) for ch in (text or '')) * size / 1000.0


def _wrap(text, size, max_w):
    lines = []
    for para in (text or '').replace('\r', '').split('\n'):
        cur = ''
        for word in para.split(' '):
            trial = (cur + ' ' + word).strip()
            if _text_width(trial, size) <= max_w or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


def _read_jpeg_size(data):
    i = 2
    while i < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            h = int.from_bytes(data[i + 5:i + 7], 'big')
            w = int.from_bytes(data[i + 7:i + 9], 'big')
            return w, h
        seg = int.from_bytes(data[i + 2:i + 4], 'big')
        i += 2 + seg
    return 400, 100


def build_pdf(lines_ops, logo_jpeg=None):
    """Monta um PDF A4 de uma página. lines_ops: lista de operações
    ('text', x, y, size, bold, str) | ('line', x1, y1, x2, y2, width) | ('image', x, y, w, h) | ('rect', x, y, w, h, gray)."""
    content = []
    for op in lines_ops:
        if op[0] == 'text':
            _, x, y, size, bold, s = op
            content.append(b'BT /%s %.1f Tf %.1f %.1f Td (%s) Tj ET' % (b'F2' if bold else b'F1', size, x, y, _pdf_escape(s)))
        elif op[0] == 'line':
            _, x1, y1, x2, y2, w = op
            content.append(b'%.1f w %.1f %.1f m %.1f %.1f l S' % (w, x1, y1, x2, y2))
        elif op[0] == 'rect':
            _, x, y, w, h, g = op
            content.append(b'%.2f g %.1f %.1f %.1f %.1f re f 0 g' % (g, x, y, w, h))
        elif op[0] == 'image' and logo_jpeg:
            _, x, y, w, h = op
            content.append(b'q %.1f 0 0 %.1f %.1f %.1f cm /Im1 Do Q' % (w, h, x, y))
    stream = b'\n'.join(content)
    objs = []
    objs.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    objs.append(b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
    res = b'/Font << /F1 4 0 R /F2 5 0 R >>'
    if logo_jpeg:
        res += b' /XObject << /Im1 7 0 R >>'
    objs.append(b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << ' + res + b' >> /Contents 6 0 R >>')
    objs.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    objs.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
    objs.append(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
    if logo_jpeg:
        w, h = _read_jpeg_size(logo_jpeg)
        objs.append(b'<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n' % (w, h, len(logo_jpeg)) + logo_jpeg + b'\nendstream')
    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, o in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % i + o + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    for off in offsets:
        out += b'%010d 00000 n \n' % off
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    return bytes(out)


def gerar_recibo_pdf(conn, sol):
    """Gera o 'Recibo de Aprovação' da solicitação encerrada e devolve o caminho do arquivo."""
    d = dados_decifrar(pj(sol['dados'], {}))
    d['empresa'] = mapa_empresas(conn).get(d.get('empresaId')) or ''
    hist = conn.execute('SELECT * FROM historico WHERE solicitacao_id=? ORDER BY id', (sol['id'],)).fetchall()
    dep = conn.execute('SELECT nome FROM departamentos WHERE id=?', (sol['departamento_id'],)).fetchone()
    dep_nome = dep['nome'] if dep else '—'
    logo_path = os.path.join(STATIC_DIR, 'assets', 'recibo-logo.jpg')
    logo = open(logo_path, 'rb').read() if os.path.exists(logo_path) else None

    ops = []
    L, R, TOP = 50, 545, 790
    if logo:
        # Logo_ML_02 (NexarPay) tem proporção ~2.4:1 (mais "quadrada" que a logo antiga, 4.35:1);
        # mantém a largura e o topo alinhados ao cabeçalho, ajustando a altura à proporção real
        # para não esticar/achatar a imagem.
        ops.append(('image', R - 150, TOP - 77.9, 150, 62.4))
    ops.append(('text', L, TOP - 20, 17, True, 'Recibo De APROVAÇÃO'))
    y = TOP - 62
    for lab, val in [('Nº Solicitação:', sol['numero']), ('Data Solicitação:', fmt_data(sol['criado_em'])), ('Data Aprovação:', fmt_data(sol['encerrado_em']))]:
        ops.append(('text', L, y, 10.5, True, lab))
        ops.append(('text', L + 105, y, 10.5, False, str(val)))
        y -= 15
    y -= 18
    tipo = sol['tipo']
    titulo_sec = {'fornecedor': 'CLIENTE/FORNECEDOR', 'reembolso': 'REEMBOLSO', 'grupo': 'SOLICITAÇÃO DE PAGAMENTO — ' + grupo_nome(conn).upper(), 'freelancer': 'FREELANCER', 'rescisao': 'RESCISÃO'}[tipo]
    ops.append(('text', L, y, 11.5, True, titulo_sec))
    y -= 22

    def campo(x, yy, lab, val, labw=78):
        ops.append(('text', x, yy, 10, True, lab))
        ops.append(('text', x + labw, yy, 10, False, str(val if val not in (None, '') else '—')))

    col2 = 320
    if tipo == 'fornecedor':
        campo(L, y, 'Título:', d.get('titulo')); y -= 15
        campo(L, y, 'Solicitante:', d.get('solicitante')); campo(col2, y, 'Departamento:', dep_nome, 90); y -= 15
        campo(L, y, 'E-mail:', sol['email']); campo(col2, y, 'Nº da OC/PI:', d.get('numeroOcPi'), 90); y -= 15
        campo(L, y, 'Fornecedor:', d.get('fornecedor')); campo(col2, y, 'Cliente:', d.get('cliente'), 90); y -= 15
        campo(L, y, 'Empresa:', d.get('empresa')); y -= 15
    elif tipo == 'reembolso':
        campo(L, y, 'Nome:', d.get('nome')); y -= 15
        campo(L, y, 'E-mail:', sol['email']); campo(col2, y, 'Departamento:', dep_nome, 90); y -= 15
        campo(L, y, 'Cliente:', d.get('cliente')); campo(col2, y, 'Categoria:', d.get('categoriaDespesa'), 90); y -= 15
        campo(L, y, 'Empresa:', d.get('empresa')); campo(col2, y, 'Reemb. cliente:', 'Sim' if d.get('reembolsadoCliente') else 'Não', 90); y -= 15
    elif tipo == 'freelancer':
        campo(L, y, 'Freelancer:', d.get('nomeFreelancer')); y -= 15
        campo(L, y, 'Solicitante:', d.get('solicitante')); campo(col2, y, 'Departamento:', dep_nome, 90); y -= 15
        campo(L, y, 'E-mail:', sol['email']); campo(col2, y, 'Empresa:', d.get('empresa'), 90); y -= 15
        campo(L, y, 'Modalidade:', MODALIDADES.get(d.get('modalidade'), '—')); campo(col2, y, 'Recorrente:', 'Sim' if d.get('recorrente') == 'sim' else 'Não', 90); y -= 15
        campo(L, y, 'Período:', '%s a %s' % (fmt_data(d.get('dataInicio')), fmt_data(d.get('dataFim')))); y -= 15
    elif tipo == 'rescisao':
        campo(L, y, 'Tipo:', RESCISAO_TIPOS.get(d.get('tipoRescisao'), '—')); y -= 15
        campo(L, y, 'Solicitante:', d.get('solicitante')); campo(col2, y, 'Departamento:', dep_nome, 90); y -= 15
        campo(L, y, 'E-mail:', sol['email']); campo(col2, y, 'Empresa:', d.get('empresa'), 90); y -= 15
    else:
        campo(L, y, 'Título:', d.get('titulo')); y -= 15
        campo(L, y, 'Solicitante:', d.get('solicitante')); campo(col2, y, 'Departamento:', dep_nome, 90); y -= 15
        campo(L, y, 'E-mail:', sol['email']); campo(col2, y, 'Fornecedor:', d.get('fornecedor'), 90); y -= 15
        campo(L, y, 'Empresa:', d.get('empresa')); campo(col2, y, 'Categoria:', d.get('categoria'), 90); y -= 15
    y -= 4
    ops.append(('text', L, y, 10, True, {'freelancer': 'Motivo da contratação:', 'rescisao': 'Motivo do desligamento:'}.get(tipo, 'Descrição:')))
    y -= 14
    for ln in _wrap(d.get('descricao') or '—', 10, R - L)[:14]:
        ops.append(('text', L, y, 10, False, ln)); y -= 13
    y = min(y, 470)
    ops.append(('line', L - 15, y - 6, R + 15, y - 6, 1.6))
    y -= 40
    ops.append(('text', R - 200, y, 16, True, 'Total:'))
    ops.append(('text', R - 135, y, 16, True, fmt_brl(sol['valor'])))
    y -= 16
    ops.append(('text', R - 200, y, 9.5, False, 'Data do pagamento: ' + fmt_data(sol['data_pagamento'])))
    y -= 40
    if tipo in ('reembolso', 'freelancer'):
        ops.append(('text', L, y, 10.5, True, 'Dados Bancários')); y -= 18
        campo(L, y, 'Banco:', d.get('banco'), 55); campo(col2 - 80, y, 'Agência:', d.get('agencia'), 60); y -= 15
        campo(L, y, 'C/C.:', d.get('conta'), 55); campo(col2 - 80, y, 'CPF/CNPJ:', d.get('cpfCnpj'), 60); y -= 24
    if d.get('rh'):
        rh = d['rh']
        ops.append(('text', L, y, 10, False, 'RH — Contratado: %s · Contratação: %s · Onboarding previsto: %s' % ('Sim' if rh.get('contratado') == 'sim' else 'Não', fmt_data(rh.get('dataContratacao')), fmt_data(rh.get('dataOnboarding')))))
        y -= 20
    ops.append(('text', L, y, 10.5, True, 'Trilha de aprovação')); y -= 16
    nomes = {'criada': 'Solicitação enviada', 'reenviada': 'Solicitação reenviada', 'aprovada': 'Aprovado', 'encerrada': 'Pagamento autorizado', 'ajustada': 'Valor/término ajustado'}
    for h in hist:
        if h['acao'] in nomes:
            rotulo = {ETAPA_RH: 'RH 1', ETAPA_RH2: 'RH 2', 3: 'Financeiro'}.get(h['etapa'], 'Aprovação %s' % h['etapa'])
            et = (' — ' + rotulo) if h['acao'] in ('aprovada', 'encerrada', 'ajustada') and h['etapa'] else ''
            ops.append(('text', L, y, 9.5, False, '%s%s: %s em %s' % (nomes[h['acao']], et, h['user_nome'] or '', fmt_data_hora(h['data']))))
            y -= 13
    ops.append(('line', L, 60, R, 60, 0.5))
    ops.append(('text', L, 48, 8, False, 'NexarPay - Tudo Sob Controle — documento gerado automaticamente em %s' % fmt_data_hora(now_iso())))
    pdf = build_pdf(ops, logo)
    fname = 'recibo-%s.pdf' % sol['numero'].replace('/', '-')
    path = os.path.join(RECIBO_DIR, fname)
    with open(path, 'wb') as f:
        f.write(pdf)
    return fname


# ============================================================ segurança de upload
_PDF_PERIGOSO = re.compile(rb'/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b')
_EXT_BINARIA_PERIGOSA = ('.exe', '.dll', '.js', '.vbs', '.bat', '.cmd', '.scr', '.com', '.ps1', '.jar', '.lnk', '.hta')


def conteudo_seguro(path, ext):
    """Recusa conteúdo ativo (macros, scripts, executáveis embutidos, zip bomb). Complementa — não substitui — o antivírus."""
    if ext == '.pdf':
        with open(path, 'rb') as f:
            if _PDF_PERIGOSO.search(f.read()):
                raise ApiError(400, 'PDF com script ou arquivo embutido não é aceito. Gere o PDF novamente (imprimir/exportar como PDF).')
    elif ext in ('.docx', '.xlsx'):
        if not zipfile.is_zipfile(path):
            raise ApiError(400, 'O conteúdo do arquivo não corresponde ao formato %s.' % ext)
        try:
            with zipfile.ZipFile(path) as z:
                infos = z.infolist()
                if len(infos) > 3000 or sum(i.file_size for i in infos) > 250 * 1024 * 1024:
                    raise ApiError(400, 'Arquivo compactado suspeito (tamanho descompactado excessivo).')
                nomes = [i.filename.lower() for i in infos]
                if any(i.compress_size and i.file_size / i.compress_size > 200 and i.file_size > 5 * 1024 * 1024 for i in infos):
                    raise ApiError(400, 'Arquivo compactado suspeito (taxa de compressão anormal).')
                if not any(n.startswith('word/' if ext == '.docx' else 'xl/') for n in nomes):
                    raise ApiError(400, 'O conteúdo do arquivo não corresponde ao formato %s.' % ext)
                if any(n.endswith('vbaproject.bin') or '/macros/' in n or 'activex' in n or '/embeddings/' in n or n.endswith(_EXT_BINARIA_PERIGOSA) for n in nomes):
                    raise ApiError(400, 'Arquivo com macro, ActiveX ou objeto embutido não é aceito. Salve uma cópia sem macros.')
                for i in infos:
                    if i.filename.lower().endswith('.rels') and i.file_size < 1024 * 1024 and b'attachedTemplate' in z.read(i):
                        raise ApiError(400, 'Documento com modelo externo vinculado não é aceito.')
                if '[content_types].xml' in nomes and b'macroEnabled' in z.read([i for i in infos if i.filename.lower() == '[content_types].xml'][0]):
                    raise ApiError(400, 'Arquivo habilitado para macros não é aceito.')
        except zipfile.BadZipFile:
            raise ApiError(400, 'Arquivo corrompido ou inválido.')


def varrer_antivirus(path):
    """ClamAV (clamd, protocolo INSTREAM) quando NEXARPAY_CLAMAV_HOST está definido. Com NEXARPAY_AV_OBRIGATORIO=1,
    se o scanner estiver fora do ar o upload é recusado (falha fechada)."""
    host = os.environ.get('NEXARPAY_CLAMAV_HOST')
    if not host:
        return
    obrigatorio = os.environ.get('NEXARPAY_AV_OBRIGATORIO') == '1'
    try:
        with socket.create_connection((host, int(os.environ.get('NEXARPAY_CLAMAV_PORT') or 3310)), timeout=30) as sk:
            sk.sendall(b'zINSTREAM\0')
            with open(path, 'rb') as f:
                for chunk in iter(lambda: f.read(65536), b''):
                    sk.sendall(struct.pack('>I', len(chunk)) + chunk)
            sk.sendall(struct.pack('>I', 0))
            resp = b''
            while not resp.endswith(b'\0') and len(resp) < 4096:
                parte = sk.recv(4096)
                if not parte:
                    break
                resp += parte
        txt = resp.decode('utf-8', 'replace').strip('\0\n ')
    except (OSError, ValueError) as e:
        print('[antivirus] scanner indisponível:', e)
        if obrigatorio:
            raise ApiError(503, 'A verificação antivírus está indisponível no momento. Tente novamente em instantes.')
        return
    if txt.endswith('FOUND'):
        raise ApiError(400, 'O arquivo foi bloqueado pelo antivírus (%s).' % txt.split(':', 1)[-1].replace('FOUND', '').strip())
    if not txt.endswith('OK'):
        print('[antivirus] resposta inesperada:', txt)
        if obrigatorio:
            raise ApiError(503, 'A verificação antivírus falhou. Tente novamente.')


def limpar_orfaos(horas=72):
    """Remove anexos enviados e nunca vinculados a solicitação/lançamento (após uma carência), liberando a cota."""
    conn = db()
    try:
        corte = (dt.datetime.now() - dt.timedelta(hours=horas)).replace(microsecond=0).isoformat()
        n = 0
        for a in conn.execute('SELECT * FROM arquivos WHERE criado_em < ?', (corte,)).fetchall():
            marca = '%' + a['id'] + '%'
            if conn.execute('SELECT 1 FROM solicitacoes WHERE anexos LIKE ? OR doc_fiscal LIKE ?', (marca, marca)).fetchone() or \
                    conn.execute('SELECT 1 FROM launches WHERE dados LIKE ?', (marca,)).fetchone() or \
                    conn.execute('SELECT 1 FROM historico WHERE detalhes LIKE ?', (marca,)).fetchone():
                continue
            pth = os.path.join(UPLOAD_DIR, os.path.basename(a['caminho'] or ''))
            try:
                if os.path.isfile(pth) and is_inside(pth, UPLOAD_DIR):
                    os.remove(pth)
            except OSError:
                continue
            conn.execute('DELETE FROM arquivos WHERE id=?', (a['id'],))
            conn.commit()
            audit(conn, None, 'arquivo.orfao_removido', a['id'], {'nome': a['nome'], 'enviadoPor': a['user_id']})
            n += 1
        if n:
            print('[limpeza] %d anexo(s) órfão(s) removido(s).' % n)
    except Exception:
        traceback.print_exc()
    finally:
        conn.close()


def executar_alertas_nf(conn):
    """Revisão diária (9h): freelancers encerrados sem NF. Avisa cada solicitante e manda um resumo ao Financeiro e ao RH."""
    hoje = today_iso()
    por_email, todos = {}, []
    for r in conn.execute("SELECT * FROM solicitacoes WHERE tipo='freelancer' AND status='encerrada' AND (doc_fiscal IS NULL OR doc_fiscal='') ORDER BY id").fetchall():
        d = pj(r['dados'], {})
        solic = conn.execute('SELECT email FROM users WHERE id=?', (r['solicitante_id'],)).fetchone()
        para = r['email'] or (solic['email'] if solic else None)
        fim = d.get('dataFim') or ''
        item = {'numero': r['numero'], 'nome': d.get('nomeFreelancer') or '—', 'fim': fim, 'vencida': bool(fim) and fim < hoje, 'solicitante': r['solicitante_nome'] or '—'}
        todos.append(item)
        if para:
            por_email.setdefault(para, []).append(item)
    fmt = lambda i: '  • %s — %s — término %s%s' % (i['numero'], i['nome'], fmt_data(i['fim']), '  (PRAZO VENCIDO: você está bloqueado(a) de novas solicitações de Freelancer)' if i['vencida'] else '')
    for para, itens in por_email.items():
        enviar_email(para, 'NexarPay — Freelancer: Nota Fiscal pendente (%d)' % len(itens),
                     'Bom dia.\n\nAs contratações de Freelancer abaixo ainda estão sem a Nota Fiscal anexada:\n\n%s\n\nAnexe a NF no sistema (%s). O bloqueio de novas solicitações de Freelancer termina assim que a NF for anexada.\n\nAtenciosamente\nNexarPay'
                     % ('\n'.join(fmt(i) for i in itens), CONFIG.get('url_base')))
    if todos:
        resumo = '\n'.join(fmt(i) + ' · solicitante: ' + i['solicitante'] for i in todos)
        for u in conn.execute("SELECT email FROM users WHERE ativo=1 AND (perfil='financeiro' OR (perfil='rh' AND (rh1=1 OR rh2=1)))"):
            enviar_email(u['email'], 'NexarPay — Resumo diário: Freelancers sem Nota Fiscal (%d)' % len(todos),
                         'Resumo da revisão diária das 9h:\n\n%s\n\nAtenciosamente\nNexarPay' % resumo)
    return len(todos)


def executar_alertas_termino(conn):
    """Todo dia: Freelancers recorrentes em acompanhamento que terminam em até 7 dias (ou já terminaram) → e-mail para RH 1 e RH 2."""
    itens = []
    for r in conn.execute("SELECT * FROM solicitacoes WHERE tipo='freelancer' AND status='rh2' ORDER BY id"):
        d = pj(r['dados'], {})
        n = dias_para_termino(r, d)
        if n is not None:
            itens.append('  • %s — %s — término %s (%s) — %s' % (r['numero'], d.get('nomeFreelancer') or '—', fmt_data(d.get('dataFim')),
                         'termina hoje' if n == 0 else ('termina em %d dia(s)' % n if n > 0 else 'TERMINOU há %d dia(s)' % -n), fmt_brl(r['valor'])))
    if itens:
        for u in conn.execute("SELECT email FROM users WHERE perfil='rh' AND ativo=1 AND (rh1=1 OR rh2=1)"):
            enviar_email(u['email'], 'NexarPay — Freelancer recorrente: contrato perto do fim (%d)' % len(itens),
                         'Bom dia.\n\nOs contratos de Freelancer recorrente abaixo terminam em até %d dias. Ajuste o valor/data de término ou encerre a solicitação no sistema (%s):\n\n%s\n\n'
                         'Este aviso é enviado todos os dias até o encerramento.\n\nAtenciosamente\nNexarPay' % (DIAS_AVISO_TERMINO, CONFIG.get('url_base'), '\n'.join(itens)))
    return len(itens)


def _loop_alertas_nf():
    while True:
        try:
            if dt.datetime.now().hour >= 9:
                conn = db()
                try:
                    if get_ajuste(conn, 'alertaNfData') != today_iso():
                        n = executar_alertas_nf(conn)
                        executar_alertas_termino(conn)
                        set_ajuste(conn, 'alertaNfData', today_iso())
                        conn.commit()
                        print('[freelancer] revisão diária das 9h: %d contratação(ões) sem NF.' % n)
                finally:
                    conn.close()
        except Exception:
            traceback.print_exc()
        threading.Event().wait(300)


def _loop_limpeza():
    while True:
        limpar_orfaos()
        threading.Event().wait(6 * 3600)


# ============================================================ controles de negócio (duplicidade e orçamento)
def _norm(v):
    return re.sub(r'\s+', ' ', str(v or '').strip().lower())


def categoria_orcamento(tipo, d):
    if tipo == 'grupo':
        return d.get('categoria') or 'Cliente/Fornecedor'
    if tipo == 'reembolso':
        return d.get('categoriaDespesa') or 'Outro'
    if tipo == 'freelancer':
        return 'Freelancers'
    if tipo == 'rescisao':
        return 'Rescisões'
    return 'Cliente/Fornecedor'


def _aprovado_cat(cat):
    return sum(float(c.get('valor') or 0) for l in (cat.get('linhas') or []) for c in (l.get('cenarios') or []) if c.get('aprovado'))


def _duplicidades(conn, tipo, d, valor, anexos, excluir_id):
    corte = (dt.date.today() - dt.timedelta(days=730)).isoformat()
    rows = conn.execute("SELECT * FROM solicitacoes WHERE status<>'reprovada' AND id<>? AND criado_em>=?", (excluir_id or 0, corte)).fetchall()
    quem, oc = _norm(d.get('fornecedor') or d.get('nomeFreelancer') or d.get('nome')), _norm(d.get('numeroOcPi'))
    achados = {}
    for r in rows:
        dd = pj(r['dados'], {})
        mesmo_valor = abs((r['valor'] or 0) - valor) < 0.005
        if mesmo_valor and quem and r['tipo'] == tipo and quem == _norm(dd.get('fornecedor') or dd.get('nomeFreelancer') or dd.get('nome')):
            achados.setdefault(r['numero'], (r, []))[1].append('mesmo valor e mesmo fornecedor/beneficiário')
        if mesmo_valor and oc and oc == _norm(dd.get('numeroOcPi')):
            achados.setdefault(r['numero'], (r, []))[1].append('mesmo Nº de OC/PI e mesmo valor')
    ids = [a['id'] for a in anexos]
    if ids:
        ph = ','.join('?' * len(ids))
        hashes = [x['sha256'] for x in conn.execute('SELECT sha256 FROM arquivos WHERE id IN (%s)' % ph, ids) if x['sha256']]
        if hashes:
            dono = {}
            for r in rows:
                for a in pj(r['anexos'], []) + [pj(r['doc_fiscal'], None)]:
                    if isinstance(a, dict) and a.get('id'):
                        dono[a['id']] = r
            for x in conn.execute('SELECT id FROM arquivos WHERE sha256 IN (%s) AND id NOT IN (%s)' % (','.join('?' * len(hashes)), ph), hashes + ids):
                if x['id'] in dono:
                    achados.setdefault(dono[x['id']]['numero'], (dono[x['id']], []))[1].append('o mesmo arquivo (idêntico) já foi anexado lá')
    out = []
    for numero, (r, motivos) in achados.items():
        out.append({'tipo': 'duplicidade', 'solicitacao': numero, 'status': STATUS_LABEL.get(r['status'], r['status']), 'valor': r['valor'],
                    'mensagem': 'Semelhante à %s (%s, %s, por %s): %s.' % (numero, STATUS_LABEL.get(r['status'], r['status']), fmt_brl(r['valor']), r['solicitante_nome'] or '—', '; '.join(dict.fromkeys(motivos)))})
    return out


def _orcamento(conn, tipo, d, valor, dep, excluir_id):
    try:
        ano = int(str(d.get('dataPagamento'))[:4])
    except ValueError:
        return []
    b = conn.execute('SELECT * FROM budgets WHERE ano=? AND departamento_id=?', (ano, dep)).fetchone()
    if not b:
        return [{'tipo': 'orcamento', 'estouro': False, 'mensagem': 'Não há orçamento de %d cadastrado para este departamento: não foi possível comparar o valor.' % ano}]
    cats = pj(b['categorias'], [])
    lancs = [pj(r['dados'], {}) for r in conn.execute('SELECT dados FROM launches WHERE departamento_id=? AND ano=?', (dep, ano))]
    abertas = conn.execute("SELECT id,tipo,valor,dados FROM solicitacoes WHERE departamento_id=? AND status IN ('aprovacao1','aprovacao2','rh','rh2','financeiro','alteracao') AND substr(data_pagamento,1,4)=? AND id<>?",
                           (dep, str(ano), excluir_id or 0)).fetchall()
    out = []
    total = sum(_aprovado_cat(c) for c in cats)
    gasto, emaprov = sum(float(l.get('custoTotal') or 0) for l in lancs), sum(r['valor'] or 0 for r in abertas)
    if gasto + emaprov + valor > total + 0.005:
        out.append({'tipo': 'orcamento', 'estouro': True, 'escopo': 'departamento',
                    'mensagem': 'Orçamento %d do departamento: orçado %s, já lançado %s, em aprovação %s; com esta solicitação (%s) excede em %s.' % (
                        ano, fmt_brl(total), fmt_brl(gasto), fmt_brl(emaprov), fmt_brl(valor), fmt_brl(gasto + emaprov + valor - total))})
    nome_cat = categoria_orcamento(tipo, d)
    cat = next((c for c in cats if nome_cat in (c.get('categoriasLancamento') or [])), None)
    if not cat:
        out.append({'tipo': 'orcamento', 'estouro': False, 'mensagem': 'A categoria "%s" não está vinculada a nenhuma linha do orçamento %d.' % (nome_cat, ano)})
    else:
        vinc = set(cat.get('categoriasLancamento') or [])
        orc = _aprovado_cat(cat)
        g = sum(float(l.get('custoTotal') or 0) for l in lancs if l.get('categoria') in vinc)
        e = sum(r['valor'] or 0 for r in abertas if categoria_orcamento(r['tipo'], pj(r['dados'], {})) in vinc)
        if g + e + valor > orc + 0.005:
            out.append({'tipo': 'orcamento', 'estouro': True, 'escopo': 'categoria',
                        'mensagem': 'Categoria "%s": orçado %s, já lançado %s, em aprovação %s; com esta solicitação (%s) excede em %s.' % (
                            cat.get('nome'), fmt_brl(orc), fmt_brl(g), fmt_brl(e), fmt_brl(valor), fmt_brl(g + e + valor - orc))})
    return out


def avaliar_alertas(conn, tipo, d, valor, dep, anexos, excluir_id=None, so_orcamento=False):
    return ([] if so_orcamento else _duplicidades(conn, tipo, d, valor, anexos, excluir_id)) + _orcamento(conn, tipo, d, valor, dep, excluir_id)


# ============================================================ relatórios
# Seis relatórios (solicitações, orçado × realizado, rateio por empresa, aprovações e prazos, agenda de pagamentos,
# documentos fiscais pendentes), exportação em Excel (.xlsx) e PDF sem bibliotecas externas, envio por e-mail,
# agendamento mensal, filtros salvos por usuário e colunas padrão por cliente. "Realizado" = solicitação encerrada pelo
# Financeiro (vira lançamento); o ano vem da data de pagamento.
ROLES_RELATORIOS = ('admin', 'diretor', 'financeiro', 'gestor', 'rh')  # colaborador e TV não emitem relatórios
LIMITE_LINHAS_TELA = 1000
LIMITE_LINHAS_EXPORT = 20000
TIPO_LANC_HIST = 'lancamento_historico'
STATUS_REL = {'concluido': ('encerrada',), 'reprovado': ('reprovada',), 'em_andamento': ('aprovacao1', 'aprovacao2', 'rh', 'rh2', 'financeiro'), 'alteracao': ('alteracao',)}
STATUS_REL_NOMES = [('todos', 'Todos'), ('concluido', 'Pedido concluído'), ('reprovado', 'Pedido reprovado'),
                    ('em_andamento', 'Em andamento (aguardando aprovação)'), ('alteracao', 'Devolvido para alteração')]
PERIODOS_REL = [('mes_atual', 'Mês atual'), ('mes_anterior', 'Mês anterior'), ('ultimos_30', 'Últimos 30 dias'), ('ano_atual', 'Ano atual'), ('personalizado', 'Personalizado')]
REL_DIR = os.path.join(DATA_DIR, 'relatorios')


def sol_visivel_para(conn, user, r):
    """Quem enxerga a solicitação (usado pelo detalhe e pelos relatórios, para os dois terem sempre o mesmo alcance)."""
    if user['perfil'] in ('admin', 'diretor', 'financeiro'):
        return True
    if r['solicitante_id'] == user['id']:
        return True
    if r['tipo'] == 'rescisao':  # desligamento é sigiloso: só a área de RH (RH 1 / RH 2) e quem a solicitou
        return eh_rh1(user) or eh_rh2(user)
    if user['perfil'] == 'gestor' and r['departamento_id'] in deps_do_usuario(user):
        return True
    if user['perfil'] == 'rh' and (r['tipo'] == 'freelancer' or r['departamento_id'] in deps_do_usuario(user)):
        return True
    return False


def _col(id_, label, tipo='texto', padrao=True):
    return {'id': id_, 'label': label, 'tipo': tipo, 'padrao': padrao}


def resolver_periodo(f, hoje=None, padrao='mes_atual'):
    hoje = hoje or dt.date.today()
    p = f.get('periodo') or padrao
    if p == 'mes_atual':
        de = hoje.replace(day=1)
        ate = (de.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
    elif p == 'mes_anterior':
        ate = hoje.replace(day=1) - dt.timedelta(days=1)
        de = ate.replace(day=1)
    elif p == 'ultimos_30':
        de, ate = hoje - dt.timedelta(days=29), hoje
    elif p == 'ano_atual':
        de, ate = dt.date(hoje.year, 1, 1), dt.date(hoje.year, 12, 31)
    elif p == 'personalizado':
        a, b = parse_data_iso(f.get('de')), parse_data_iso(f.get('ate'))
        if not a or not b:
            raise ApiError(400, 'Informe a data inicial e a data final do período.')
        de, ate = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
        if de > ate:
            raise ApiError(400, 'A data inicial não pode ser depois da data final.')
        if (ate - de).days > 3660:
            raise ApiError(400, 'O período máximo é de 10 anos.')
    else:
        raise ApiError(400, 'Período inválido.')
    return de.isoformat(), ate.isoformat(), '%s a %s' % (fmt_data(de.isoformat()), fmt_data(ate.isoformat()))


def _ano_rel(f):
    v = str(f.get('ano') or '').strip()
    if v in ('', 'atual'):
        return dt.date.today().year
    try:
        a = int(v)
    except ValueError:
        raise ApiError(400, 'Ano inválido.')
    if not (2000 <= a <= 2100):
        raise ApiError(400, 'Ano inválido.')
    return a


def _bool_rel(v, padrao=True):
    if v is None or v == '':
        return padrao
    return str(v).lower() in ('1', 'true', 'sim', 'on')


def rel_deps(conn, user, dep_filtro):
    if user['perfil'] in ('admin', 'diretor', 'financeiro'):
        ids = [r['id'] for r in conn.execute('SELECT id FROM departamentos ORDER BY nome')]
    else:
        ids = sorted(deps_do_usuario(user))
    if dep_filtro:
        if dep_filtro not in ids:
            raise ApiError(403, 'Você não tem acesso a este departamento.')
        ids = [dep_filtro]
    return ids


def _nomes_dep(conn):
    return {r['id']: r['nome'] for r in conn.execute('SELECT id,nome FROM departamentos')}


def _favorecido(d):
    return d.get('fornecedor') or d.get('nomeFreelancer') or d.get('nome') or ''


def _solicitacoes_visiveis(conn, user):
    return [r for r in conn.execute('SELECT * FROM solicitacoes ORDER BY id DESC') if sol_visivel_para(conn, user, r)]


def _resumo(label, valor, tipo='moeda'):
    return {'label': label, 'valor': valor, 'tipo': tipo}


def _filtros_texto(pares):
    return ' · '.join('%s: %s' % (a, b) for a, b in pares if b)


# ---------- 1. solicitações (relatório simples: tudo o que foi solicitado no período; só valores dos pedidos, sem orçamento)
def _rel_solicitacoes(conn, user, f):
    de, ate, plabel = resolver_periodo(f)
    st = f.get('status') or 'todos'
    if st != 'todos' and st not in STATUS_REL:
        raise ApiError(400, 'Situação inválida.')
    tipo, dep, emp, busca = f.get('tipo') or '', f.get('departamento') or '', f.get('empresa') or '', _norm(f.get('busca'))
    if tipo and tipo not in TIPOS_SOLICITACAO and tipo != TIPO_LANC_HIST:
        raise ApiError(400, 'Módulo inválido.')
    deps_ok = set(rel_deps(conn, user, dep))  # valida o acesso ao departamento escolhido
    nomes_emp, nomes_dep = mapa_empresas(conn), _nomes_dep(conn)
    linhas = []
    for r in ([] if tipo == TIPO_LANC_HIST else _solicitacoes_visiveis(conn, user)):
        data = (r['criado_em'] or '')[:10]
        if not (de <= data <= ate):
            continue
        if st != 'todos' and r['status'] not in STATUS_REL[st]:
            continue
        if tipo and r['tipo'] != tipo or dep and r['departamento_id'] != dep:
            continue
        d = pj(r['dados'], {})
        if emp and d.get('empresaId') != emp:
            continue
        titulo = titulo_solicitacao(r['tipo'], d)
        if busca and busca not in _norm(' '.join([titulo, r['solicitante_nome'] or '', _favorecido(d), r['numero']])):
            continue
        linhas.append({'numero': r['numero'], 'data': data, 'solicitante': r['solicitante_nome'] or '', 'departamento': nomes_dep.get(r['departamento_id'], '—'),
                       'modulo': TIPOS_SOLICITACAO.get(r['tipo'], r['tipo']), 'titulo': titulo, 'empresa': nomes_emp.get(d.get('empresaId'), '—'), 'favorecido': _favorecido(d),
                       'valor': r['valor'] or 0, 'status': STATUS_LABEL.get(r['status'], r['status']), 'dataPagamento': r['data_pagamento'] or '',
                       'dataConclusao': (r['encerrado_em'] or '')[:10] if r['status'] == 'encerrada' else '',
                       'motivo': (r['motivo_ultimo'] or '') if r['status'] in ('reprovada', 'alteracao') else '', '_status': r['status']})
    # lançamentos históricos (sem pedido): entram como gasto realizado, pela data da compra
    if (not tipo or tipo == TIPO_LANC_HIST) and st in ('todos', 'concluido'):
        for r in conn.execute('SELECT * FROM launches WHERE solicitacao_id IS NULL ORDER BY id DESC'):
            if r['departamento_id'] not in deps_ok:
                continue
            d = pj(r['dados'], {})
            data = parse_data_iso(d.get('dataCompra')) or (r['criado_em'] or '')[:10]
            if not (de <= data <= ate) or emp and d.get('empresaId') != emp:
                continue
            titulo = d.get('descricao') or ''
            if busca and busca not in _norm(' '.join([titulo, d.get('fornecedor') or '', d.get('usadoPor') or ''])):
                continue
            linhas.append({'numero': 'LAN-%d' % r['id'], 'data': data, 'solicitante': d.get('usadoPor') or '', 'departamento': nomes_dep.get(r['departamento_id'], '—'),
                           'modulo': 'Lançamento histórico', 'titulo': titulo, 'empresa': nomes_emp.get(d.get('empresaId'), '—'), 'favorecido': d.get('fornecedor') or '',
                           'valor': float(d.get('custoTotal') or 0), 'status': STATUS_LABEL.get('encerrada', 'Concluída'), 'dataPagamento': data, 'dataConclusao': data,
                           'motivo': '', '_status': 'encerrada'})
    linhas.sort(key=lambda x: (x['data'], x['numero']), reverse=True)
    soma = lambda sts: sum(x['valor'] for x in linhas if x['_status'] in sts)
    cont = lambda sts: sum(1 for x in linhas if x['_status'] in sts)
    resumo = [_resumo('Pedidos no período', len(linhas), 'inteiro'), _resumo('Total solicitado', sum(x['valor'] for x in linhas)),
              _resumo('Gasto realizado (concluídos)', soma(('encerrada',))), _resumo('Concluídos', cont(('encerrada',)), 'inteiro'),
              _resumo('Reprovados', cont(('reprovada',)), 'inteiro'), _resumo('Em andamento', cont(STATUS_REL['em_andamento'] + ('alteracao',)), 'inteiro')]
    for x in linhas:
        x.pop('_status')
    sub = _filtros_texto([('Período (data da solicitação)', plabel), ('Situação', dict(STATUS_REL_NOMES).get(st) if st != 'todos' else ''), ('Módulo', TIPOS_SOLICITACAO.get(tipo, 'Lançamento histórico' if tipo == TIPO_LANC_HIST else '')),
                          ('Departamento', nomes_dep.get(dep, '')), ('Empresa', nomes_emp.get(emp, '')), ('Busca', f.get('busca'))])
    return {'linhas': linhas, 'resumo': resumo, 'subtitulo': sub}


# ---------- 2. orçado × realizado
def _rel_orcado_realizado(conn, user, f):
    ano = _ano_rel(f)
    deps = rel_deps(conn, user, f.get('departamento') or '')
    nomes_dep = _nomes_dep(conn)
    linhas = []
    for dep in deps:
        b = conn.execute('SELECT * FROM budgets WHERE ano=? AND departamento_id=?', (ano, dep)).fetchone()
        if not b:
            continue
        cats = pj(b['categorias'], [])
        lancs = [pj(r['dados'], {}) for r in conn.execute('SELECT dados FROM launches WHERE departamento_id=? AND ano=?', (dep, ano))]
        abertas = [(r['tipo'], pj(r['dados'], {}), r['valor'] or 0) for r in conn.execute(
            "SELECT tipo,dados,valor FROM solicitacoes WHERE departamento_id=? AND status IN ('aprovacao1','aprovacao2','rh','rh2','financeiro','alteracao') AND substr(data_pagamento,1,4)=?", (dep, str(ano)))]
        usados = set()
        for c in cats:
            vinc = set(c.get('categoriasLancamento') or [])
            orc = _aprovado_cat(c)
            real = sum(float(l.get('custoTotal') or 0) for l in lancs if l.get('categoria') in vinc)
            usados |= vinc
            em_ap = sum(v for t, d, v in abertas if categoria_orcamento(t, d) in vinc)
            linhas.append({'departamento': nomes_dep.get(dep, dep), 'categoria': c.get('nome') or '—', 'orcado': round(orc, 2), 'realizado': round(real, 2), 'emAprovacao': round(em_ap, 2),
                           'saldo': round(orc - real, 2), 'pct': round(real / orc * 100, 1) if orc else None})
        sem = sum(float(l.get('custoTotal') or 0) for l in lancs if l.get('categoria') not in usados)
        if sem > 0.005:
            linhas.append({'departamento': nomes_dep.get(dep, dep), 'categoria': 'Sem categoria no orçamento', 'orcado': 0, 'realizado': round(sem, 2), 'emAprovacao': 0, 'saldo': round(-sem, 2), 'pct': None})
    orc_t, real_t = sum(x['orcado'] for x in linhas), sum(x['realizado'] for x in linhas)
    resumo = [_resumo('Orçado', orc_t), _resumo('Realizado', real_t), _resumo('Em aprovação', sum(x['emAprovacao'] for x in linhas)), _resumo('Saldo', orc_t - real_t),
              _resumo('Consumido', round(real_t / orc_t * 100, 1) if orc_t else 0, 'pct')]
    return {'linhas': linhas, 'resumo': resumo, 'subtitulo': _filtros_texto([('Ano fiscal', str(ano)), ('Departamento', nomes_dep.get(f.get('departamento') or '', ''))])}


# ---------- 3. rateio por empresa
def _rateio_linhas_dep(conn, b, nomes):
    """Por categoria e empresa: orçado (valor aprovado × % do rateio) e realizado (gasto do grupo dividido pelo rateio; gasto direto 100% na empresa)."""
    rat = pj(b['rateio'], {})
    cats = [{'nome': c.get('nome') or '—', 'vinc': set(c.get('categoriasLancamento') or []), 'orc': _aprovado_cat(c), 'real': {}} for c in pj(b['categorias'], [])]
    sem = {'nome': 'Sem categoria no orçamento', 'vinc': set(), 'orc': 0, 'real': {}}
    for r in conn.execute('SELECT dados FROM launches WHERE departamento_id=? AND ano=?', (b['departamento_id'], b['ano'])):
        l = pj(r['dados'], {})
        alvo = next((c for c in cats if l.get('categoria') in c['vinc']), sem)
        for k, v in _alocar(float(l.get('custoTotal') or 0), l.get('empresaId'), rat).items():
            alvo['real'][k] = alvo['real'].get(k, 0.0) + v
    out = []
    for c in cats + [sem]:
        for e in dict.fromkeys(list(rat) + list(c['real'])):
            out.append({'categoria': c['nome'], 'empresaId': e, 'orcado': c['orc'] * float(rat.get(e) or 0), 'realizado': c['real'].get(e, 0.0)})
    return out


def _rel_rateio(conn, user, f):
    ano = _ano_rel(f)
    detalhe = f.get('detalhe') or 'empresa'
    if detalhe not in ('empresa', 'categoria'):
        raise ApiError(400, 'Detalhamento inválido.')
    deps = rel_deps(conn, user, f.get('departamento') or '')
    nomes, nomes_dep = mapa_empresas(conn), _nomes_dep(conn)
    nome_emp = lambda k: nomes.get(k) or ('%s (sem rateio)' % grupo_nome(conn) if k == SEM_RATEIO else 'Sem empresa' if k == 'SEM_EMPRESA' else k)
    agg = {}
    for dep in deps:
        b = conn.execute('SELECT * FROM budgets WHERE ano=? AND departamento_id=?', (ano, dep)).fetchone()
        if not b:
            continue
        for x in _rateio_linhas_dep(conn, b, nomes):
            chave = (nomes_dep.get(dep, dep), x['categoria'], x['empresaId']) if detalhe == 'categoria' else ('Todos', 'Todas', x['empresaId'])
            a = agg.setdefault(chave, [0.0, 0.0])
            a[0] += x['orcado']
            a[1] += x['realizado']
    linhas = []
    for (dep, cat, e), (orc, real) in agg.items():
        if abs(orc) < 0.005 and abs(real) < 0.005:
            continue
        linhas.append({'departamento': dep, 'categoria': cat, 'empresa': nome_emp(e), 'orcado': round(orc, 2), 'realizado': round(real, 2), 'saldo': round(orc - real, 2), 'pct': round(real / orc * 100, 1) if orc else None})
    linhas.sort(key=lambda x: (x['departamento'], x['categoria'], x['empresa']))
    orc_t, real_t = sum(x['orcado'] for x in linhas), sum(x['realizado'] for x in linhas)
    resumo = [_resumo('Orçado', orc_t), _resumo('Realizado', real_t), _resumo('Saldo', orc_t - real_t)]
    sug = ['empresa', 'orcado', 'realizado', 'saldo', 'pct'] if detalhe == 'empresa' else ['departamento', 'categoria', 'empresa', 'orcado', 'realizado', 'saldo', 'pct']
    return {'linhas': linhas, 'resumo': resumo, 'colunas_padrao': sug,
            'subtitulo': _filtros_texto([('Ano fiscal', str(ano)), ('Departamento', nomes_dep.get(f.get('departamento') or '', '')), ('Detalhe', 'por empresa' if detalhe == 'empresa' else 'por categoria e empresa')])}


# ---------- 4. aprovações e prazos
def _rel_aprovacoes(conn, user, f):
    de, ate, plabel = resolver_periodo(f)
    tipo, dep = f.get('tipo') or '', f.get('departamento') or ''
    if tipo and tipo not in TIPOS_SOLICITACAO:
        raise ApiError(400, 'Módulo inválido.')
    rel_deps(conn, user, dep)
    try:
        parada_min = float(f.get('paradas') or 0)
    except ValueError:
        raise ApiError(400, 'Informe um número de dias válido.')
    rows = [r for r in _solicitacoes_visiveis(conn, user) if de <= (r['criado_em'] or '')[:10] <= ate and (not tipo or r['tipo'] == tipo) and (not dep or r['departamento_id'] == dep)]
    ids = [r['id'] for r in rows]
    hist = {}
    for i in range(0, len(ids), 500):
        parte = ids[i:i + 500]
        for h in conn.execute('SELECT solicitacao_id,data,acao,etapa FROM historico WHERE solicitacao_id IN (%s) ORDER BY id' % ','.join('?' * len(parte)), parte):
            hist.setdefault(h['solicitacao_id'], []).append(h)
    agora = dt.datetime.now()
    nomes_dep = _nomes_dep(conn)
    users = {u['id']: u['nome'] for u in conn.execute('SELECT id,nome FROM users')}
    ts = lambda s: dt.datetime.fromisoformat(str(s)[:19])
    dias = lambda a, b: round((b - a).total_seconds() / 86400.0, 1)
    linhas = []
    for r in rows:
        ev = hist.get(r['id'], [])
        criada = ts(r['criado_em'])
        prev, d1, d2, drh, dfin, total = criada, None, None, None, None, None
        for h in ev:
            t = ts(h['data'])
            if h['acao'] in ('criada', 'reenviada'):
                prev = t
            elif h['acao'] == 'aprovada':
                dd = dias(prev, t)
                if h['etapa'] == 1:
                    d1 = dd
                elif h['etapa'] == 2:
                    d2 = dd
                elif h['etapa'] == ETAPA_RH:
                    drh = dd
                prev = t
            elif h['acao'] == 'encerrada':
                dfin, total, prev = dias(prev, t), dias(criada, t), t
        aberto = r['status'] in STATUS_ABERTOS
        parado = dias(ts(ev[-1]['data']) if ev else criada, agora) if aberto else None
        if parada_min and (parado is None or parado < parada_min):
            continue
        atual = {'aprovacao1': users.get(r['aprovador1_id']), 'aprovacao2': users.get(r['aprovador2_id']), 'rh': 'RH 1', 'rh2': 'RH 2', 'financeiro': 'Financeiro', 'alteracao': r['solicitante_nome']}.get(r['status'], '')
        d = pj(r['dados'], {})
        linhas.append({'numero': r['numero'], 'titulo': titulo_solicitacao(r['tipo'], d), 'modulo': TIPOS_SOLICITACAO.get(r['tipo'], r['tipo']), 'departamento': nomes_dep.get(r['departamento_id'], '—'),
                       'solicitante': r['solicitante_nome'] or '', 'data': (r['criado_em'] or '')[:10], 'status': STATUS_LABEL.get(r['status'], r['status']), 'aprovadorAtual': atual or '',
                       'diasEtapaAtual': parado, 'diasA1': d1, 'diasA2': d2, 'diasRh': drh, 'diasFinanceiro': dfin, 'diasTotal': total})
    linhas.sort(key=lambda x: (x['data'], x['numero']), reverse=True)
    media = lambda k: round(sum(x[k] for x in linhas if x[k] is not None) / max(1, sum(1 for x in linhas if x[k] is not None)), 1) if any(x[k] is not None for x in linhas) else 0
    resumo = [_resumo('Solicitações', len(linhas), 'inteiro'), _resumo('Em aberto', sum(1 for x in linhas if x['diasEtapaAtual'] is not None), 'inteiro'),
              _resumo('Média Aprovação 1 (dias)', media('diasA1'), 'num1'), _resumo('Média Aprovação 2 (dias)', media('diasA2'), 'num1'),
              _resumo('Média RH (dias)', media('diasRh'), 'num1'), _resumo('Média Financeiro (dias)', media('diasFinanceiro'), 'num1'), _resumo('Média até o pagamento (dias)', media('diasTotal'), 'num1')]
    return {'linhas': linhas, 'resumo': resumo,
            'subtitulo': _filtros_texto([('Período (data da solicitação)', plabel), ('Módulo', TIPOS_SOLICITACAO.get(tipo, '')), ('Departamento', nomes_dep.get(dep, '')), ('Paradas há pelo menos', ('%g dia(s)' % parada_min) if parada_min else '')])}


# ---------- 5. agenda de pagamentos
def _rel_agenda(conn, user, f):
    hoje = dt.date.today()
    try:
        janela = int(f.get('janela') or 30)
    except ValueError:
        janela = 0
    if janela not in (7, 15, 30, 60, 90):
        raise ApiError(400, 'Janela inválida.')
    ate = (hoje + dt.timedelta(days=janela)).isoformat()
    incluir_atr = _bool_rel(f.get('atrasadas'), True)
    stm = {'abertas': STATUS_ABERTOS, 'aguardando_financeiro': ('financeiro',), 'em_aprovacao': ('aprovacao1', 'aprovacao2', 'rh', 'rh2', 'alteracao')}
    st = f.get('status') or 'abertas'
    if st not in stm:
        raise ApiError(400, 'Situação inválida.')
    dep, emp = f.get('departamento') or '', f.get('empresa') or ''
    rel_deps(conn, user, dep)
    nomes_emp, nomes_dep = mapa_empresas(conn), _nomes_dep(conn)
    linhas = []
    for r in _solicitacoes_visiveis(conn, user):
        dp = r['data_pagamento'] or ''
        if r['status'] not in stm[st] or not dp or dp > ate or (dp < hoje.isoformat() and not incluir_atr):
            continue
        if dep and r['departamento_id'] != dep:
            continue
        d = pj(r['dados'], {})
        if emp and d.get('empresaId') != emp:
            continue
        linhas.append({'dataPagamento': dp, 'numero': r['numero'], 'titulo': titulo_solicitacao(r['tipo'], d), 'solicitante': r['solicitante_nome'] or '', 'departamento': nomes_dep.get(r['departamento_id'], '—'),
                       'empresa': nomes_emp.get(d.get('empresaId'), '—'), 'favorecido': _favorecido(d), 'valor': r['valor'] or 0, 'status': STATUS_LABEL.get(r['status'], r['status']),
                       'situacao': 'Atrasada' if dp < hoje.isoformat() else 'No prazo'})
    linhas.sort(key=lambda x: (x['dataPagamento'], x['numero']))
    resumo = [_resumo('Pagamentos previstos', len(linhas), 'inteiro'), _resumo('Valor total', sum(x['valor'] for x in linhas)),
              _resumo('Já em atraso', sum(x['valor'] for x in linhas if x['situacao'] == 'Atrasada')),
              _resumo('Aguardando o Financeiro', sum(x['valor'] for x in linhas if x['status'] == STATUS_LABEL['financeiro']))]
    return {'linhas': linhas, 'resumo': resumo,
            'subtitulo': _filtros_texto([('Pagamentos até', fmt_data(ate)), ('Atrasados', 'incluídos' if incluir_atr else 'não incluídos'), ('Situação', {'abertas': 'todas as em aberto', 'aguardando_financeiro': 'aguardando o Financeiro', 'em_aprovacao': 'em aprovação'}[st]),
                                         ('Departamento', nomes_dep.get(dep, '')), ('Empresa', nomes_emp.get(emp, ''))])}


# ---------- 6. documentos fiscais pendentes
def _rel_doc_fiscal(conn, user, f):
    hoje = dt.date.today().isoformat()
    sit, tipo, dep = f.get('situacao') or 'todas', f.get('tipo') or '', f.get('departamento') or ''
    if sit not in ('todas', 'vencidas', 'no_prazo'):
        raise ApiError(400, 'Situação inválida.')
    if tipo and tipo not in TIPOS_SOLICITACAO:
        raise ApiError(400, 'Módulo inválido.')
    rel_deps(conn, user, dep)
    nomes_dep = _nomes_dep(conn)
    linhas = []
    for r in _solicitacoes_visiveis(conn, user):
        if r['status'] != 'encerrada' or r['doc_fiscal'] or r['tipo'] == 'rescisao' or (tipo and r['tipo'] != tipo) or (dep and r['departamento_id'] != dep):
            continue
        prazo = r['prazo_doc_fiscal'] or ''
        venc = bool(prazo) and prazo < hoje
        if (sit == 'vencidas' and not venc) or (sit == 'no_prazo' and venc):
            continue
        atraso = (dt.date.fromisoformat(hoje) - dt.date.fromisoformat(prazo)).days if venc else 0
        d = pj(r['dados'], {})
        linhas.append({'numero': r['numero'], 'titulo': titulo_solicitacao(r['tipo'], d), 'modulo': TIPOS_SOLICITACAO.get(r['tipo'], r['tipo']), 'solicitante': r['solicitante_nome'] or '',
                       'departamento': nomes_dep.get(r['departamento_id'], '—'), 'valor': r['valor'] or 0, 'dataConclusao': (r['encerrado_em'] or '')[:10], 'prazo': prazo, 'diasAtraso': atraso,
                       'situacao': 'Vencido — solicitante bloqueado' if venc else 'No prazo'})
    linhas.sort(key=lambda x: (x['prazo'] or '9999', x['numero']))
    resumo = [_resumo('Pendentes', len(linhas), 'inteiro'), _resumo('Vencidos', sum(1 for x in linhas if x['diasAtraso'] > 0), 'inteiro'), _resumo('Valor sem documento', sum(x['valor'] for x in linhas))]
    return {'linhas': linhas, 'resumo': resumo,
            'subtitulo': _filtros_texto([('Situação', {'todas': 'todas', 'vencidas': 'vencidas', 'no_prazo': 'no prazo'}[sit]), ('Módulo', TIPOS_SOLICITACAO.get(tipo, '')), ('Departamento', nomes_dep.get(dep, ''))])}


REL = {
    'solicitacoes': {'titulo': 'Solicitações', 'descricao': 'Tudo o que foi solicitado no período, com filtro por situação (concluído, reprovado…). Mostra só os valores dos pedidos, sem o orçamento.',
                     'publico': 'Diretoria · Financeiro · Gestor · RH', 'filtros': ['periodo', 'status', 'tipo_sol', 'departamento', 'empresa', 'busca'], 'fn': _rel_solicitacoes,
                     'colunas': [_col('numero', 'Nº'), _col('data', 'Data da solicitação', 'data'), _col('solicitante', 'Solicitante'), _col('departamento', 'Departamento'), _col('modulo', 'Módulo'),
                                 _col('titulo', 'Título'), _col('empresa', 'Empresa'), _col('favorecido', 'Fornecedor / beneficiário', 'texto', False), _col('valor', 'Valor', 'moeda'),
                                 _col('status', 'Status'), _col('dataPagamento', 'Data do pagamento', 'data'), _col('dataConclusao', 'Concluído em', 'data'), _col('motivo', 'Motivo (reprovação/devolução)', 'texto', False)]},
    'orcado_realizado': {'titulo': 'Orçado × realizado', 'descricao': 'Por departamento e categoria: orçado, realizado, em aprovação, saldo e % consumido.', 'publico': 'Diretoria · Financeiro · Gestor · RH',
                         'filtros': ['ano', 'departamento'], 'fn': _rel_orcado_realizado,
                         'colunas': [_col('departamento', 'Departamento'), _col('categoria', 'Categoria'), _col('orcado', 'Orçado', 'moeda'), _col('realizado', 'Realizado', 'moeda'),
                                     _col('emAprovacao', 'Em aprovação', 'moeda', False), _col('saldo', 'Saldo', 'moeda'), _col('pct', '% consumido', 'pct')]},
    'rateio_empresa': {'titulo': 'Rateio por empresa', 'descricao': 'Quanto cada empresa recebeu do orçamento, gastou e ainda tem de saldo (gasto do grupo dividido pelo rateio).', 'publico': 'Diretoria · Financeiro · Gestor · RH',
                       'filtros': ['ano', 'departamento', 'detalhe'], 'fn': _rel_rateio,
                       'colunas': [_col('departamento', 'Departamento', 'texto', False), _col('categoria', 'Categoria', 'texto', False), _col('empresa', 'Empresa'), _col('orcado', 'Orçado', 'moeda'),
                                   _col('realizado', 'Realizado', 'moeda'), _col('saldo', 'Saldo', 'moeda'), _col('pct', '% consumido', 'pct')]},
    'aprovacoes': {'titulo': 'Aprovações e prazos', 'descricao': 'Tempo por etapa de aprovação e solicitações paradas, com o aprovador responsável.', 'publico': 'Diretoria · Financeiro · Gestor · RH',
                   'filtros': ['periodo', 'tipo', 'departamento', 'paradas'], 'fn': _rel_aprovacoes,
                   'colunas': [_col('numero', 'Nº'), _col('titulo', 'Título'), _col('modulo', 'Módulo'), _col('departamento', 'Departamento'), _col('solicitante', 'Solicitante', 'texto', False),
                               _col('data', 'Solicitada em', 'data', False), _col('status', 'Status'), _col('aprovadorAtual', 'Aguardando'), _col('diasEtapaAtual', 'Dias na etapa atual', 'num1'),
                               _col('diasA1', 'Dias até Aprov. 1', 'num1'), _col('diasA2', 'Dias até Aprov. 2', 'num1'), _col('diasRh', 'Dias até RH', 'num1', False),
                               _col('diasFinanceiro', 'Dias no Financeiro', 'num1'), _col('diasTotal', 'Dias até o pagamento', 'num1')]},
    'agenda': {'titulo': 'Agenda de pagamentos', 'descricao': 'O que vence nos próximos 7, 15, 30, 60 ou 90 dias, pela data de pagamento.', 'publico': 'Financeiro · Diretoria · Gestor · RH',
               'filtros': ['janela', 'atrasadas', 'agenda_status', 'departamento', 'empresa'], 'fn': _rel_agenda,
               'colunas': [_col('dataPagamento', 'Data do pagamento', 'data'), _col('numero', 'Nº'), _col('titulo', 'Título'), _col('solicitante', 'Solicitante'), _col('departamento', 'Departamento'),
                           _col('empresa', 'Empresa'), _col('favorecido', 'Fornecedor / beneficiário', 'texto', False), _col('valor', 'Valor', 'moeda'), _col('status', 'Status'), _col('situacao', 'Situação')]},
    'doc_fiscal': {'titulo': 'Documentos fiscais pendentes', 'descricao': 'Quem deve nota ou recibo, há quantos dias, e quem está bloqueado.', 'publico': 'Financeiro · Diretoria · Gestor · RH',
                   'filtros': ['situacao', 'tipo', 'departamento'], 'fn': _rel_doc_fiscal,
                   'colunas': [_col('numero', 'Nº'), _col('titulo', 'Título'), _col('modulo', 'Módulo'), _col('solicitante', 'Solicitante'), _col('departamento', 'Departamento'), _col('valor', 'Valor', 'moeda'),
                               _col('dataConclusao', 'Concluído em', 'data', False), _col('prazo', 'Prazo da NF', 'data'), _col('diasAtraso', 'Dias de atraso', 'inteiro'), _col('situacao', 'Situação')]},
}
FILTROS_REL = {'periodo', 'de', 'ate', 'status', 'tipo', 'departamento', 'empresa', 'busca', 'ano', 'detalhe', 'paradas', 'janela', 'atrasadas', 'agenda_status', 'situacao'}


def _controle_filtro(conn, user, nome):
    deps = [{'id': '', 'nome': 'Todos (que você pode ver)'}] + [{'id': d, 'nome': n} for d, n in ((d, _nomes_dep(conn).get(d, d)) for d in rel_deps(conn, user, ''))]
    anos = sorted({r[0] for r in conn.execute('SELECT ano FROM budgets UNION SELECT ano FROM launches') if r[0]} | {dt.date.today().year}, reverse=True)
    return {
        'periodo': {'id': 'periodo', 'tipo': 'periodo', 'label': 'Período', 'opcoes': [{'id': a, 'nome': b} for a, b in PERIODOS_REL]},
        'status': {'id': 'status', 'tipo': 'select', 'label': 'Situação do pedido', 'opcoes': [{'id': a, 'nome': b} for a, b in STATUS_REL_NOMES], 'padrao': 'todos'},
        'tipo': {'id': 'tipo', 'tipo': 'select', 'label': 'Módulo', 'opcoes': [{'id': '', 'nome': 'Todos'}] + [{'id': k, 'nome': v} for k, v in TIPOS_SOLICITACAO.items()]},
        'tipo_sol': {'id': 'tipo', 'tipo': 'select', 'label': 'Módulo', 'opcoes': [{'id': '', 'nome': 'Todos'}] + [{'id': k, 'nome': v} for k, v in TIPOS_SOLICITACAO.items()] + [{'id': TIPO_LANC_HIST, 'nome': 'Lançamento histórico (sem pedido)'}]},
        'departamento': {'id': 'departamento', 'tipo': 'select', 'label': 'Departamento', 'opcoes': deps},
        'empresa': {'id': 'empresa', 'tipo': 'select', 'label': 'Empresa', 'opcoes': [{'id': '', 'nome': 'Todas'}] + [{'id': k, 'nome': v} for k, v in mapa_empresas(conn).items()]},
        'busca': {'id': 'busca', 'tipo': 'texto', 'label': 'Buscar (título, solicitante, fornecedor, nº)'},
        'ano': {'id': 'ano', 'tipo': 'select', 'label': 'Ano fiscal', 'opcoes': [{'id': str(a), 'nome': str(a)} for a in anos], 'padrao': str(dt.date.today().year)},
        'detalhe': {'id': 'detalhe', 'tipo': 'select', 'label': 'Detalhar', 'opcoes': [{'id': 'empresa', 'nome': 'Por empresa'}, {'id': 'categoria', 'nome': 'Por categoria e empresa'}], 'padrao': 'empresa'},
        'paradas': {'id': 'paradas', 'tipo': 'numero', 'label': 'Somente paradas há mais de (dias)'},
        'janela': {'id': 'janela', 'tipo': 'select', 'label': 'Próximos', 'opcoes': [{'id': str(n), 'nome': '%d dias' % n} for n in (7, 15, 30, 60, 90)], 'padrao': '30'},
        'atrasadas': {'id': 'atrasadas', 'tipo': 'checkbox', 'label': 'Incluir os já atrasados', 'padrao': True},
        'agenda_status': {'id': 'status', 'tipo': 'select', 'label': 'Situação', 'opcoes': [{'id': 'abertas', 'nome': 'Todas em aberto'}, {'id': 'aguardando_financeiro', 'nome': 'Aguardando o Financeiro'}, {'id': 'em_aprovacao', 'nome': 'Em aprovação'}], 'padrao': 'abertas'},
        'situacao': {'id': 'situacao', 'tipo': 'select', 'label': 'Situação da NF', 'opcoes': [{'id': 'todas', 'nome': 'Todas'}, {'id': 'vencidas', 'nome': 'Vencidas (solicitante bloqueado)'}, {'id': 'no_prazo', 'nome': 'No prazo'}], 'padrao': 'todas'},
    }[nome]


def colunas_padrao_cliente(conn, rid, sugeridas=None):
    rel = REL[rid]
    ids = {c['id'] for c in rel['colunas']}
    cfg = (get_ajuste(conn, 'relatorios', {}) or {}).get(rid, {}).get('colunas')
    if isinstance(cfg, list):
        cfg = [c for c in cfg if c in ids]
        if cfg:
            return cfg
    if sugeridas:
        return [c for c in sugeridas if c in ids]
    return [c['id'] for c in rel['colunas'] if c['padrao']]


def gerar_relatorio(conn, user, rid, f, colunas_req=None, limite=LIMITE_LINHAS_TELA):
    if user['perfil'] not in ROLES_RELATORIOS:
        raise ApiError(403, 'Seu perfil não emite relatórios.')
    rel = REL.get(rid)
    if not rel:
        raise ApiError(404, 'Relatório não encontrado.')
    f = {k: (str(v) if not isinstance(v, bool) else v) for k, v in (f or {}).items() if k in FILTROS_REL and v is not None}
    res = rel['fn'](conn, user, f)
    todas = {c['id']: c for c in rel['colunas']}
    cliente_cfg = (get_ajuste(conn, 'relatorios', {}) or {}).get(rid, {}).get('colunas')
    padrao = colunas_padrao_cliente(conn, rid, None if cliente_cfg else res.get('colunas_padrao'))
    sel = colunas_req if colunas_req else padrao
    if not isinstance(sel, list) or not sel or any(c not in todas for c in sel):
        raise ApiError(400, 'Colunas inválidas.')
    linhas = res['linhas']
    return {'id': rid, 'titulo': rel['titulo'], 'subtitulo': res['subtitulo'], 'colunas': [todas[c] for c in sel], 'resumo': res['resumo'], 'total': len(linhas),
            'truncado': bool(limite) and len(linhas) > limite, 'linhas': linhas[:limite] if limite else linhas[:LIMITE_LINHAS_EXPORT], 'geradoEm': now_iso(), 'geradoPor': user['nome']}


# ---------- exportação (sem bibliotecas): Excel e PDF
def _texto_celula(v, tipo):
    if v is None or v == '':
        return ''
    if tipo == 'moeda':
        return fmt_brl(v)
    if tipo == 'data':
        return fmt_data(v)
    if tipo == 'pct':
        return ('%.1f%%' % float(v)).replace('.', ',')
    if tipo == 'num1':
        return ('%.1f' % float(v)).replace('.', ',')
    if tipo == 'inteiro':
        return str(int(v))
    return str(v)


def _xml(s):
    s = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', str(s))
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def _col_letra(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def relatorio_xlsx(out):
    """Planilha .xlsx mínima (OOXML escrito à mão): título, filtros, resumo, tabela com formatos de moeda/data/percentual."""
    cols, linhas = out['colunas'], out['linhas']
    S = {'texto': 0, 'moeda': 1, 'data': 2, 'cab': 3, 'pct': 4, 'num1': 5, 'neg': 6, 'inteiro': 7}
    rows = []

    def cel_txt(r, c, t, s=0):
        return '<c r="%s%d" t="inlineStr" s="%d"><is><t xml:space="preserve">%s</t></is></c>' % (_col_letra(c), r, s, _xml(t))

    def cel_num(r, c, v, s):
        return '<c r="%s%d" s="%d"><v>%s</v></c>' % (_col_letra(c), r, s, repr(float(v)) if not float(v).is_integer() else str(int(float(v))))
    n = 1
    rows.append('<row r="%d">%s</row>' % (n, cel_txt(n, 0, out['titulo'], S['neg'])))
    n += 1
    if out['subtitulo']:
        rows.append('<row r="%d">%s</row>' % (n, cel_txt(n, 0, out['subtitulo'])))
        n += 1
    rows.append('<row r="%d">%s</row>' % (n, cel_txt(n, 0, 'Gerado em %s por %s' % (fmt_data_hora(out['geradoEm']), out['geradoPor']))))
    n += 2
    for rs in out['resumo']:
        celulas = cel_txt(n, 0, rs['label'], S['neg'])
        celulas += cel_num(n, 1, rs['valor'], S[rs['tipo']] if rs['tipo'] in S else 0)
        rows.append('<row r="%d">%s</row>' % (n, celulas))
        n += 1
    n += 1
    cab = n
    rows.append('<row r="%d">%s</row>' % (n, ''.join(cel_txt(n, i, c['label'], S['cab']) for i, c in enumerate(cols))))
    larg = [max(10, len(c['label']) + 2) for c in cols]
    for ln in linhas:
        n += 1
        celulas = []
        for i, c in enumerate(cols):
            v = ln.get(c['id'])
            if v is None or v == '':
                continue
            t = c['tipo']
            if t == 'data':
                try:
                    celulas.append(cel_num(n, i, (dt.date.fromisoformat(str(v)[:10]) - dt.date(1899, 12, 30)).days, S['data']))
                except ValueError:
                    celulas.append(cel_txt(n, i, v))
            elif t in ('moeda', 'pct', 'num1', 'inteiro'):
                celulas.append(cel_num(n, i, v, S[t]))
            else:
                celulas.append(cel_txt(n, i, v))
            larg[i] = min(60, max(larg[i], len(_texto_celula(v, t)) + 2))
        rows.append('<row r="%d">%s</row>' % (n, ''.join(celulas)))
    colsxml = ''.join('<col min="%d" max="%d" width="%d" customWidth="1"/>' % (i + 1, i + 1, w) for i, w in enumerate(larg))
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<sheetViews><sheetView workbookViewId="0"><pane ySplit="%d" topLeftCell="A%d" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
             '<cols>%s</cols><sheetData>%s</sheetData></worksheet>') % (cab, cab + 1, colsxml, ''.join(rows))
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/>'
              '<numFmt numFmtId="166" formatCode="dd/mm/yyyy"/><numFmt numFmtId="167" formatCode="0.0"/></numFmts>'
              '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
              '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
              '<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill></fills>'
              '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
              '<cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
              '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
              '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
              '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
              '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
              '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
              '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
              '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>')
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Relatório" sheetId="1" r:id="rId1"/></sheets></workbook>')
    wbrels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
              '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
              '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
    bio = io.BytesIO()
    with zipfile.ZipFile(bio, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', rels)
        z.writestr('xl/workbook.xml', wb)
        z.writestr('xl/_rels/workbook.xml.rels', wbrels)
        z.writestr('xl/styles.xml', styles)
        z.writestr('xl/worksheets/sheet1.xml', sheet)
    return bio.getvalue()


def _pdf_paginas(paginas, logo_jpeg=None, largura=842, altura=595):
    """PDF de várias páginas (A4 paisagem): cada página é uma lista de operações no mesmo formato de build_pdf."""
    def stream(ops):
        c = []
        for op in ops:
            if op[0] == 'text':
                _, x, y, size, bold, t = op
                c.append(b'BT /%s %.1f Tf %.1f %.1f Td (%s) Tj ET' % (b'F2' if bold else b'F1', size, x, y, _pdf_escape(t)))
            elif op[0] == 'line':
                _, x1, y1, x2, y2, w = op
                c.append(b'%.1f w %.1f %.1f m %.1f %.1f l S' % (w, x1, y1, x2, y2))
            elif op[0] == 'rect':
                _, x, y, w, h, g = op
                c.append(b'%.2f g %.1f %.1f %.1f %.1f re f 0 g' % (g, x, y, w, h))
            elif op[0] == 'image' and logo_jpeg:
                _, x, y, w, h = op
                c.append(b'q %.1f 0 0 %.1f %.1f %.1f cm /Im1 Do Q' % (w, h, x, y))
        return b'\n'.join(c)
    objs = [b'', b'', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']
    res = b'/Font << /F1 3 0 R /F2 4 0 R >>'
    if logo_jpeg:
        w, h = _read_jpeg_size(logo_jpeg)
        objs.append(b'<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n' % (w, h, len(logo_jpeg)) + logo_jpeg + b'\nendstream')
        res += b' /XObject << /Im1 5 0 R >>'
    kids = []
    for ops in paginas:
        st = stream(ops)
        objs.append(b'<< /Length %d >>\nstream\n' % len(st) + st + b'\nendstream')
        cid = len(objs)
        objs.append(b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << ' % (largura, altura) + res + b' >> /Contents %d 0 R >>' % cid)
        kids.append(b'%d 0 R' % len(objs))
    objs[0] = b'<< /Type /Catalog /Pages 2 0 R >>'
    objs[1] = b'<< /Type /Pages /Kids [' + b' '.join(kids) + b'] /Count %d >>' % len(kids)
    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offs = []
    for i, o in enumerate(objs, start=1):
        offs.append(len(out))
        out += b'%d 0 obj\n' % i + o + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    for off in offs:
        out += b'%010d 00000 n \n' % off
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    return bytes(out)


def relatorio_pdf(out):
    W, H, M = 842, 595, 28
    usable = W - 2 * M
    cols, linhas = out['colunas'], out['linhas']
    size, pad, alt = 7.5, 3, 13
    txt = lambda ln, c: _texto_celula(ln.get(c['id']), c['tipo'])
    larg = []
    for c in cols:
        w = _text_width(c['label'], size) * 1.1 + 2 * pad
        for ln in linhas[:300]:
            w = max(w, _text_width(txt(ln, c), size) + 2 * pad)
        larg.append(min(max(w, 34), 230))
    tot = sum(larg)
    f = usable / tot if tot else 1
    larg = [max(26, w * min(f, 1.35)) for w in larg]
    f2 = usable / sum(larg)
    larg = [w * f2 for w in larg] if f2 < 1 else larg

    def ajusta(t, w):
        if _text_width(t, size) <= w - 2 * pad:
            return t
        while t and _text_width(t + '…', size) > w - 2 * pad:
            t = t[:-1]
        return t + '…'

    def cabecalho(ops, y, pagina):
        if pagina == 0:
            ops.append(('image', W - M - 90, H - M - 30, 90, 37))
            ops.append(('text', M, H - M - 12, 15, True, out['titulo']))
            y = H - M - 28
            for ln in _wrap(out['subtitulo'], 8.5, usable - 100)[:3]:
                ops.append(('text', M, y, 8.5, False, ln))
                y -= 11
            ops.append(('text', M, y, 8, False, 'Gerado em %s por %s' % (fmt_data_hora(out['geradoEm']), out['geradoPor'])))
            y -= 16
            x = M
            for rs in out['resumo']:
                t = '%s: %s' % (rs['label'], _texto_celula(rs['valor'], rs['tipo']) if rs['valor'] != '' else '—')
                w = _text_width(t, 8.5) + 22
                if x + w > W - M:
                    x, y = M, y - 14
                ops.append(('rect', x, y - 4, w - 6, 15, 0.93))
                ops.append(('text', x + 4, y, 8.5, True, t))
                x += w
            y -= 24
        else:
            ops.append(('text', M, H - M - 10, 10, True, out['titulo'] + ' (continuação)'))
            y = H - M - 28
        x = M
        ops.append(('rect', M, y - 4, usable, alt, 0.85))
        for c, w in zip(cols, larg):
            t = ajusta(c['label'], w)
            ops.append(('text', x + (w - pad - _text_width(t, size) if c['tipo'] in ('moeda', 'pct', 'num1', 'inteiro') else pad), y, size, True, t))
            x += w
        return y - alt

    paginas, ops, y, pg = [], [], 0, 0
    y = cabecalho(ops, 0, 0)
    for i, ln in enumerate(linhas):
        if y < M + 30:
            paginas.append(ops)
            ops, pg = [], pg + 1
            y = cabecalho(ops, 0, pg)
        if i % 2:
            ops.append(('rect', M, y - 4, usable, alt, 0.97))
        x = M
        for c, w in zip(cols, larg):
            t = ajusta(txt(ln, c), w)
            ops.append(('text', x + (w - pad - _text_width(t, size) if c['tipo'] in ('moeda', 'pct', 'num1', 'inteiro') else pad), y, size, False, t))
            x += w
        y -= alt
    if not linhas:
        ops.append(('text', M, y, 9, False, 'Nenhum registro para os filtros escolhidos.'))
    paginas.append(ops)
    for n, p in enumerate(paginas, start=1):
        p.append(('line', M, M + 8, W - M, M + 8, 0.4))
        p.append(('text', M, M - 2, 7, False, 'NexarPay — Tudo Sob Controle · %d registro(s)%s' % (out['total'], ' (exibidos os primeiros %d)' % len(linhas) if out['total'] > len(linhas) else '')))
        p.append(('text', W - M - 60, M - 2, 7, False, 'Página %d de %d' % (n, len(paginas))))
    logo_path = os.path.join(STATIC_DIR, 'assets', 'recibo-logo.jpg')
    logo = open(logo_path, 'rb').read() if os.path.exists(logo_path) else None
    return _pdf_paginas(paginas, logo, W, H)


def arquivo_relatorio(formato, out):
    base = 'relatorio-%s-%s' % (out['id'], today_iso().replace('-', ''))
    if formato == 'xlsx':
        return relatorio_xlsx(out), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base + '.xlsx'
    if formato == 'pdf':
        return relatorio_pdf(out), 'application/pdf', base + '.pdf'
    raise ApiError(400, 'Formato inválido (use xlsx ou pdf).')


def enviar_relatorio(conn, user, rid, f, colunas, formatos, extras, origem='manual'):
    """Gera os arquivos e envia ao próprio usuário (e a até 5 e-mails do domínio da empresa)."""
    formatos = [x for x in (formatos or ['xlsx', 'pdf']) if x in ('xlsx', 'pdf')] or ['xlsx', 'pdf']
    out = gerar_relatorio(conn, user, rid, f, colunas, limite=None)
    pasta = os.path.join(REL_DIR, secrets.token_hex(6))
    os.makedirs(pasta, exist_ok=True)
    caminhos = []
    for fm in formatos:
        dados, _, nome = arquivo_relatorio(fm, out)
        with open(os.path.join(pasta, nome), 'wb') as fh:
            fh.write(dados)
        caminhos.append(os.path.join(pasta, nome))
    dest = [user['email']] + [e for e in extras if e and e != user['email']]
    corpo = ('Olá, %s.\n\nSegue em anexo o relatório "%s" (%d registro(s)).\n\n%s\n\nGerado em %s.\n\nAtenciosamente\nNexarPay'
             % (user['nome'], out['titulo'], out['total'], out['subtitulo'], fmt_data_hora(out['geradoEm'])))
    for e in dest:
        enviar_email(e, 'NexarPay — Relatório: %s' % out['titulo'], corpo, anexo_path=caminhos)
    return {'destinatarios': dest, 'arquivos': [os.path.basename(c) for c in caminhos], 'registros': out['total']}


def limpar_relatorios_temp(dias=2):
    if not os.path.isdir(REL_DIR):
        return
    corte = dt.datetime.now().timestamp() - dias * 86400
    for nome in os.listdir(REL_DIR):
        p = os.path.join(REL_DIR, nome)
        try:
            if os.path.isdir(p) and os.path.getmtime(p) < corte:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass


def executar_agendamentos(conn, hoje=None):
    """Envio mensal: roda uma vez por mês, a partir do dia escolhido (se o servidor estava desligado no dia, envia quando subir)."""
    hoje = hoje or dt.date.today()
    enviados = 0
    for a in conn.execute('SELECT * FROM relatorios_agenda WHERE ativo=1').fetchall():
        if a['ultimo_envio'] and a['ultimo_envio'][:7] >= hoje.isoformat()[:7]:
            continue
        if hoje.day < a['dia']:
            continue
        u = conn.execute('SELECT * FROM users WHERE id=? AND ativo=1', (a['user_id'],)).fetchone()
        try:
            if not u or u['perfil'] not in ROLES_RELATORIOS:
                continue
            enviar_relatorio(conn, u, a['relatorio'], pj(a['filtros'], {}), pj(a['colunas'], None), pj(a['formatos'], ['xlsx', 'pdf']), pj(a['destinatarios'], []), 'agendado')
            conn.execute('UPDATE relatorios_agenda SET ultimo_envio=? WHERE id=?', (hoje.isoformat(), a['id']))
            conn.commit()
            audit(conn, u, 'relatorio.enviado_agendado', a['relatorio'], {'agendamento': a['id']})
            enviados += 1
        except Exception:
            traceback.print_exc()
    return enviados


def _loop_relatorios():
    while True:
        try:
            if dt.datetime.now().hour >= 7:
                conn = db()
                try:
                    n = executar_agendamentos(conn)
                    if n:
                        print('[relatórios] %d envio(s) mensal(is) agendado(s).' % n)
                    limpar_relatorios_temp()
                finally:
                    conn.close()
        except Exception:
            traceback.print_exc()
        threading.Event().wait(600)


# ============================================================ regras de negócio
def row_to_dict(r):
    return {k: r[k] for k in r.keys()} if r is not None else None


def user_public(u):
    if not u:
        return None
    return {'id': u['id'], 'nome': u['nome'], 'email': u['email'], 'perfil': u['perfil'], 'perfilLabel': PERFIS.get(u['perfil'], u['perfil']),
            'departamentos': pj(u['departamentos'], []), 'diretor1Id': u['diretor1_id'], 'diretor2Id': u['diretor2_id'],
            'ativo': bool(u['ativo']), 'senhaProvisoria': bool(u['senha_provisoria']), 'criadoEm': u['criado_em'], 'ultimoLogin': u['ultimo_login'],
            'dashboardTvConfig': pj(u['dashboard_tv_config'], None),
            'rh1': bool(u['rh1']) and u['perfil'] == 'rh', 'rh2': bool(u['rh2']) and u['perfil'] == 'rh',
            'mfaAtivo': bool(u['mfa_ativo']), 'mfaObrigatorio': mfa_exigido(u)}


def deps_do_usuario(u):
    return set(pj(u['departamentos'], []))


def eh_rh1(u):
    return u['perfil'] == 'rh' and bool(u['rh1'])


def eh_rh2(u):
    return u['perfil'] == 'rh' and bool(u['rh2'])


def pode_solicitar_rescisao(u):
    return u['perfil'] in ('admin', 'financeiro') or eh_rh1(u) or eh_rh2(u)


def pode_ver_todos_deps(u):
    return u['perfil'] in ('admin', 'diretor', 'financeiro', 'tv')


def launch_out(r, user=None, nomes=None):
    d = pj(r['dados'], {})
    d['empresa'] = (nomes or {}).get(d.get('empresaId')) or d.get('empresa') or ''  # nome derivado do cadastro (renomear não quebra o histórico)
    pode = bool(user and user['perfil'] in ('admin', 'gestor'))
    # a senha/serial nunca viaja na listagem: só a indicação de que existe (revelar = rota própria, auditada)
    if d.get('senhaSerial'):
        d['senhaSerial'] = ''
        d['senhaSerialDefinida'] = True
    # a conta de acesso só é decifrada para Administrador e Gestor(a)
    if d.get('usuarioConta'):
        if pode:
            d['usuarioConta'] = decifrar(d['usuarioConta'])
        else:
            d['usuarioConta'] = ''
            d['usuarioContaDefinida'] = True
    d['id'] = r['id']
    d['departamentoId'] = r['departamento_id']
    d['solicitacaoId'] = r['solicitacao_id']
    return d


def budget_out(r):
    return {'id': r['id'], 'ano': r['ano'], 'departamentoId': r['departamento_id'], 'dolar': r['dolar'], 'rateio': pj(r['rateio'], {}), 'categorias': pj(r['categorias'], [])}


CAMPOS_BANCARIOS = ('banco', 'agencia', 'conta', 'cpfCnpj')
MASCARA_BANCARIA = '(dado bancário alterado — valor oculto)'
CAMPOS_CREDENCIAL = ('senha_hash', 'salt', 'reset_hash', 'reset_salt', 'reset_exp', 'mfa_secret', 'mfa_ativo', 'mfa_codes', 'mfa_ultimo_passo')


def dados_cifrar(d):
    return _cifrar_campos(d, CAMPOS_BANCARIOS)[0]


def dados_decifrar(d):
    return _decifrar_campos(d, CAMPOS_BANCARIOS)


def dias_para_termino(r, d):
    """Freelancer recorrente em acompanhamento (RH 2): dias até o fim do contrato, quando faltam 7 ou menos (negativo = já terminou)."""
    if r['tipo'] != 'freelancer' or r['status'] != 'rh2' or not d.get('dataFim'):
        return None
    n = (dt.date.fromisoformat(d['dataFim']) - dt.date.today()).days
    return n if n <= DIAS_AVISO_TERMINO else None


def sol_out(conn, r, com_historico=False, user=None, nomes=None):
    d = dados_decifrar(pj(r['dados'], {}))
    d['empresa'] = (nomes if nomes is not None else mapa_empresas(conn)).get(d.get('empresaId')) or d.get('empresa') or ''
    if user and user['perfil'] == 'tv':  # painel de TV não precisa (nem deve) ver dados bancários
        for c in CAMPOS_BANCARIOS:
            d.pop(c, None)
    out = {
        'id': r['id'], 'numero': r['numero'], 'tipo': r['tipo'], 'tipoLabel': TIPOS_SOLICITACAO.get(r['tipo'], r['tipo']),
        'status': r['status'], 'statusLabel': STATUS_LABEL.get(r['status'], r['status']), 'retornoPara': r['retorno_para'],
        'solicitanteId': r['solicitante_id'], 'solicitanteNome': r['solicitante_nome'], 'email': r['email'],
        'departamentoId': r['departamento_id'], 'valor': r['valor'], 'dataPagamento': r['data_pagamento'],
        'dados': d, 'anexos': pj(r['anexos'], []), 'aprovador1Id': r['aprovador1_id'], 'aprovador2Id': r['aprovador2_id'],
        'criadoEm': r['criado_em'], 'atualizadoEm': r['atualizado_em'], 'encerradoEm': r['encerrado_em'],
        'prazoDocFiscal': r['prazo_doc_fiscal'], 'docFiscal': pj(r['doc_fiscal'], None), 'lancamentoId': r['lancamento_id'],
        'reciboArquivo': r['recibo_arquivo'], 'motivoUltimo': r['motivo_ultimo'], 'alertas': pj(r['alertas'], []),
        'titulo': titulo_solicitacao(r['tipo'], d),
    }
    out['atrasada'] = r['status'] in STATUS_ABERTOS and bool(r['data_pagamento']) and r['data_pagamento'] < today_iso()
    out['alertaTermino'] = dias_para_termino(r, d)
    out['docFiscalPendente'] = r['status'] == 'encerrada' and not r['doc_fiscal'] and r['tipo'] != 'rescisao'
    out['docFiscalVencido'] = out['docFiscalPendente'] and bool(r['prazo_doc_fiscal']) and r['prazo_doc_fiscal'] < today_iso()
    if com_historico:
        out['historico'] = [{'id': h['id'], 'data': h['data'], 'userId': h['user_id'], 'userNome': h['user_nome'], 'acao': h['acao'], 'etapa': h['etapa'],
                             'justificativa': h['justificativa'], 'detalhes': pj(h['detalhes'], None)}
                            for h in conn.execute('SELECT * FROM historico WHERE solicitacao_id=? ORDER BY id', (r['id'],))]
    return out


def sol_out_tv(r):
    """Projeção mínima para o painel de TV: só o que alimenta os indicadores (sem nomes, descrição, dados bancários, anexos)."""
    return {
        'id': r['id'], 'numero': r['numero'], 'tipo': r['tipo'], 'tipoLabel': TIPOS_SOLICITACAO.get(r['tipo'], r['tipo']),
        'status': r['status'], 'statusLabel': STATUS_LABEL.get(r['status'], r['status']), 'departamentoId': r['departamento_id'],
        'valor': r['valor'], 'dataPagamento': r['data_pagamento'], 'criadoEm': r['criado_em'], 'encerradoEm': r['encerrado_em'],
        'prazoDocFiscal': r['prazo_doc_fiscal'], 'dados': {}, 'anexos': [], 'titulo': r['numero'],
        'atrasada': r['status'] in STATUS_ABERTOS and bool(r['data_pagamento']) and r['data_pagamento'] < today_iso(),
        'docFiscalPendente': r['status'] == 'encerrada' and not r['doc_fiscal'] and r['tipo'] != 'rescisao',
        'docFiscalVencido': r['status'] == 'encerrada' and not r['doc_fiscal'] and r['tipo'] != 'rescisao' and bool(r['prazo_doc_fiscal']) and r['prazo_doc_fiscal'] < today_iso(),
    }


def add_hist(conn, sol_id, user, acao, etapa=None, justificativa=None, detalhes=None):
    conn.execute('INSERT INTO historico(solicitacao_id,data,user_id,user_nome,acao,etapa,justificativa,detalhes) VALUES(?,?,?,?,?,?,?,?)',
                 (sol_id, now_iso(), user['id'] if user else None, user['nome'] if user else 'Sistema', acao, etapa, justificativa, j(detalhes) if detalhes is not None else None))


def titulo_solicitacao(tipo, d):
    if tipo == 'rescisao':
        return 'Rescisão — ' + RESCISAO_TIPOS.get(d.get('tipoRescisao'), '')
    if tipo == 'freelancer':
        return 'Freelancer — ' + (d.get('nomeFreelancer') or '')
    return d.get('titulo') or ('Reembolso — ' + (d.get('categoriaDespesa') or ''))


def cnpj_valido(txt):
    n = re.sub(r'\D', '', str(txt or ''))
    if len(n) != 14 or n == n[0] * 14:
        return False

    def dv(base, pesos):
        r = sum(int(a) * b for a, b in zip(base, pesos)) % 11
        return '0' if r < 2 else str(11 - r)
    p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    return n[12] == dv(n[:12], p1) and n[13] == dv(n[:13], [6] + p1)


def validar_freelancer(user, d):
    """Regras do módulo Freelancer. Preenche dataPagamento = data de término (o pagamento é feito ao fim da contratação)."""
    if d.get('recorrente') not in ('sim', 'nao'):
        raise ApiError(400, 'Informe se a contratação é recorrente.')
    if d.get('modalidade') not in MODALIDADES:
        raise ApiError(400, 'Informe a modalidade (presencial, home office ou híbrido).')
    ini, fim = parse_data_iso(d.get('dataInicio')), parse_data_iso(d.get('dataFim'))
    if not ini or not fim:
        raise ApiError(400, 'Informe as datas de início e de término.')
    di, df = dt.date.fromisoformat(ini), dt.date.fromisoformat(fim)
    if df < di:
        raise ApiError(400, 'A data de término não pode ser anterior à data de início.')
    if (df - di).days > MAX_DIAS_FREELA:
        raise ApiError(400, 'O período do freelancer não pode passar de %d dias (da data de início à data de término).' % MAX_DIAS_FREELA)
    if df < dt.date.today() and user['perfil'] != 'diretor':
        raise ApiError(403, 'Pedido com data de término anterior a hoje (retroativo) só pode ser feito pela Diretoria.')
    if not cnpj_valido(d.get('cpfCnpj')):
        raise ApiError(400, 'CNPJ inválido. Confira os 14 dígitos.')
    n = re.sub(r'\D', '', str(d['cpfCnpj']))
    d['cpfCnpj'] = '%s.%s.%s/%s-%s' % (n[:2], n[2:5], n[5:8], n[8:12], n[12:])
    d['dataInicio'], d['dataFim'], d['dataPagamento'] = ini, fim, fim


def validar_rh(rh, user):
    if not isinstance(rh, dict) or rh.get('contratado') not in ('sim', 'nao'):
        raise ApiError(400, 'Informe se o profissional foi contratado.')
    dc, do = parse_data_iso(rh.get('dataContratacao')), parse_data_iso(rh.get('dataOnboarding'))
    if rh['contratado'] == 'sim':
        if not dc:
            raise ApiError(400, 'Informe a data de contratação.')
        if not do:
            raise ApiError(400, 'Informe a data prevista para o onboarding.')
        if do < dc:
            raise ApiError(400, 'A data do onboarding não pode ser anterior à data de contratação.')
    return {'contratado': rh['contratado'], 'dataContratacao': dc, 'dataOnboarding': do, 'por': user['nome'], 'em': now_iso()}


def bloqueio_freelancer(conn, user_id):
    """Quem tem contratação de freelancer encerrada, já terminada e sem NF anexada fica impedido de nova solicitação de Freelancer."""
    hoje, pend, venc = today_iso(), [], []
    for r in conn.execute("SELECT id,numero,dados FROM solicitacoes WHERE solicitante_id=? AND tipo='freelancer' AND status='encerrada' AND (doc_fiscal IS NULL OR doc_fiscal='')", (user_id,)):
        d = pj(r['dados'], {})
        item = {'id': r['id'], 'numero': r['numero'], 'nome': d.get('nomeFreelancer'), 'dataFim': d.get('dataFim')}
        pend.append(item)
        if (d.get('dataFim') or '9999-12-31') < hoje:
            venc.append(item)
    return {'bloqueado': bool(venc), 'vencidas': venc, 'pendentes': pend, 'mensagem': MSG_BLOQUEIO_FREELA if venc else None}


def pendencias_doc_fiscal(conn, user_id):
    hoje = today_iso()
    rows = conn.execute("SELECT id,numero,tipo,prazo_doc_fiscal FROM solicitacoes WHERE solicitante_id=? AND tipo NOT IN ('freelancer','rescisao') AND status='encerrada' AND (doc_fiscal IS NULL OR doc_fiscal='')", (user_id,)).fetchall()
    venc = [{'id': r['id'], 'numero': r['numero'], 'tipo': r['tipo'], 'prazo': r['prazo_doc_fiscal']} for r in rows if r['prazo_doc_fiscal'] and r['prazo_doc_fiscal'] < hoje]
    pend = [{'id': r['id'], 'numero': r['numero'], 'tipo': r['tipo'], 'prazo': r['prazo_doc_fiscal']} for r in rows]
    return {'bloqueado': len(venc) > 0, 'vencidas': venc, 'pendentes': pend, 'mensagem': MSG_BLOQUEIO if venc else None}


def proximo_numero(conn):
    ano = dt.date.today().year
    n = conn.execute("SELECT COUNT(*) FROM solicitacoes WHERE numero LIKE ?", ('REQ-%d-%%' % ano,)).fetchone()[0] + 1
    while conn.execute('SELECT 1 FROM solicitacoes WHERE numero=?', ('REQ-%d-%04d' % (ano, n),)).fetchone():
        n += 1
    return 'REQ-%d-%04d' % (ano, n)


CAMPOS_OBRIGATORIOS = {
    'fornecedor': ['titulo', 'solicitante', 'fornecedor', 'cliente', 'numeroOcPi', 'empresaId', 'descricao', 'valor', 'dataPagamento', 'erroInterno'],
    'reembolso': ['nome', 'cliente', 'reembolsadoCliente', 'categoriaDespesa', 'empresaId', 'descricao', 'valor', 'dataPagamento'],
    'grupo': ['titulo', 'solicitante', 'fornecedor', 'empresaId', 'categoria', 'descricao', 'valor', 'dataPagamento', 'erroInterno'],
    'rescisao': ['solicitante', 'empresaId', 'tipoRescisao', 'descricao', 'valor', 'dataPagamento'],
    'freelancer': ['solicitante', 'empresaId', 'descricao', 'recorrente', 'modalidade', 'dataInicio', 'dataFim', 'valor', 'nomeFreelancer', 'banco', 'agencia', 'conta', 'cpfCnpj'],
}


def validar_solicitacao(conn, user, body):
    tipo = body.get('tipo')
    if tipo == 'fornecedor' and user['perfil'] == 'rh':
        raise ApiError(403, 'O módulo Cliente/Fornecedor não está disponível para o perfil RH.')
    if tipo not in TIPOS_SOLICITACAO:
        raise ApiError(400, 'Tipo de solicitação inválido.')
    d = body.get('dados') or {}
    faltando = [c for c in CAMPOS_OBRIGATORIOS[tipo] if d.get(c) in (None, '', [])]
    if tipo == 'reembolso' and not (body.get('anexos') or []):
        faltando.append('reciboNotaFiscal')
    if faltando:
        raise ApiError(400, 'Preencha os campos obrigatórios: ' + ', '.join(faltando))
    d.pop('empresa', None)
    validar_empresa(conn, d.get('empresaId'))
    if tipo == 'freelancer':
        validar_freelancer(user, d)
    if tipo == 'rescisao':
        if d.get('tipoRescisao') not in RESCISAO_TIPOS:
            raise ApiError(400, 'Informe o tipo: Pedido de Dispensa ou Dispensado.')
        if not pode_solicitar_rescisao(user):
            raise ApiError(403, 'Somente o RH (RH 1 ou RH 2) e o Financeiro podem solicitar Rescisões.')
    try:
        valor = float(d.get('valor'))
    except Exception:
        raise ApiError(400, 'Valor total inválido.')
    if not (0 < valor <= MAX_VALOR):  # também rejeita NaN e infinito
        raise ApiError(400, 'O valor total deve ser maior que zero e menor que R$ 1 bilhão.')
    valor = round(valor, 2)
    dp = parse_data_iso(d.get('dataPagamento'))
    if not dp:
        raise ApiError(400, 'Data de pagamento inválida.')
    d['dataPagamento'] = dp
    exige_ano_aberto(conn, dp[:4], 'solicitações com data de pagamento neste ano')
    email = (d.get('email') or user['email']).strip().lower()
    if not email_valido_dominio(email):
        raise ApiError(400, 'Use somente o e-mail corporativo @' + (CONFIG.get('dominio_permitido') or DOMINIO_PADRAO) + '.')
    dep = body.get('departamentoId') or d.get('departamentoId')
    if not dep:
        raise ApiError(400, 'Informe o departamento.')
    if tipo == 'rescisao':  # qualquer departamento cadastrado (o RH desliga gente de todas as áreas)
        if not conn.execute('SELECT 1 FROM departamentos WHERE id=? AND ativo=1', (dep,)).fetchone():
            raise ApiError(400, 'Departamento inválido.')
    elif user['perfil'] != 'admin' and dep not in deps_do_usuario(user):
        raise ApiError(403, 'Você não pertence a este departamento.')
    return tipo, d, valor, email, dep


# ============================================================ handler HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = 'NexarPay'
    sys_version = ''
    protocol_version = 'HTTP/1.1'
    timeout = 30  # segundos de inatividade do socket (mitiga conexões lentas / slowloris)

    def security_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        if USE_HTTPS:
            self.send_header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

    def client_ip(self):
        if TRUST_PROXY:
            xff = (self.headers.get('X-Forwarded-For') or '').split(',')
            if xff and xff[-1].strip():
                return xff[-1].strip()
        return self.client_address[0]

    def log_message(self, fmt, *args):
        msg = fmt % args
        if '/api/' in msg or 'code' in msg:
            sys.stdout.write('%s - %s\n' % (self.address_string(), msg))

    # ---------- helpers
    def send_json(self, obj, status=200, cookies=None):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.security_headers()
        for c in (cookies or []):
            self.send_header('Set-Cookie', c)
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path, download_name=None, mime=None, forcar_download=False):
        if not os.path.isfile(path):
            self.send_json({'erro': 'Arquivo não encontrado.'}, 404)
            return
        mime = mime or mimetypes.guess_type(path)[0] or 'application/octet-stream'
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(size))
        if download_name:
            # nome seguro: sem quebras de linha/aspas (evita injeção de cabeçalho) e codificado em UTF-8
            limpo = re.sub(r'[\x00-\x1f\x7f"\\/]', '_', download_name)
            ascii_nome = limpo.encode('ascii', 'replace').decode('ascii').replace('?', '_')
            disp = 'attachment' if forcar_download else 'inline'
            self.send_header('Content-Disposition', "%s; filename=\"%s\"; filename*=UTF-8''%s" % (disp, ascii_nome, urllib.parse.quote(limpo)))
        if is_inside(path, STATIC_DIR):
            self.send_header('Cache-Control', 'no-cache')
        else:
            self.send_header('Cache-Control', 'private, no-store')
        self.security_headers()
        self.end_headers()
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def read_body(self, limite=None):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            raise ApiError(400, 'Requisição inválida.')
        if n < 0:
            raise ApiError(400, 'Requisição inválida.')
        if n > (limite or (MAX_UPLOAD_MB * 1024 * 1024 * 4 // 3 + 200000)):
            raise ApiError(413, 'Conteúdo muito grande.')
        raw = self.rfile.read(n) if n else b''
        if not raw:
            return {}
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            raise ApiError(400, 'JSON inválido.')

    def cookie(self, name):
        raw = self.headers.get('Cookie') or ''
        for part in raw.split(';'):
            k, _, v = part.strip().partition('=')
            if k == name:
                return v
        return None

    def current_user(self, conn):
        tok = self.cookie(SESSION_COOKIE)
        if not tok:
            return None
        tok = hash_token(tok)
        s = conn.execute('SELECT * FROM sessions WHERE token=?', (tok,)).fetchone()
        if not s or s['expira_em'] < now_iso() or s['etapa']:
            return None  # sessão inexistente, vencida ou ainda aguardando o 2º fator
        u = conn.execute('SELECT * FROM users WHERE id=? AND ativo=1', (s['user_id'],)).fetchone()
        if u:
            idle, absol = limites_sessao(u['perfil'])
            agora = dt.datetime.now()
            try:
                fim_abs = dt.datetime.fromisoformat(s['criado_em']) + dt.timedelta(seconds=absol)
            except (TypeError, ValueError):
                fim_abs = agora + dt.timedelta(seconds=idle)
            if agora >= fim_abs:  # vida máxima atingida: mesmo com uso contínuo, é preciso entrar de novo
                conn.execute('DELETE FROM sessions WHERE token=?', (tok,))
                conn.commit()
                return None
            conn.execute('UPDATE sessions SET expira_em=? WHERE token=?', (min(agora + dt.timedelta(seconds=idle), fim_abs).replace(microsecond=0).isoformat(), tok))
        return u

    def require_user(self, conn, perfis=None):
        u = self.current_user(conn)
        if not u:
            raise ApiError(401, 'Sessão expirada. Faça login novamente.')
        if perfis and u['perfil'] not in perfis:
            raise ApiError(403, 'Seu perfil não tem permissão para esta ação.')
        return u

    # ---------- roteamento
    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def do_PUT(self):
        self.route('PUT')

    def do_DELETE(self):
        self.route('DELETE')

    TAXA = {}  # ip -> [timestamps] (limite de requisições por minuto)

    def _taxa_excedida(self):
        lim = int((CONFIG.get('limites') or {}).get('requisicoes_por_minuto_ip', 600))
        ip, agora = self.client_ip(), dt.datetime.now().timestamp()
        v = [t for t in Handler.TAXA.get(ip, []) if t > agora - 60]
        v.append(agora)
        Handler.TAXA[ip] = v
        if len(Handler.TAXA) > 5000:
            for k in [k for k, x in Handler.TAXA.items() if not x or x[-1] < agora - 60][:2000]:
                Handler.TAXA.pop(k, None)
        return len(v) > lim

    def route(self, method):
        if self._taxa_excedida():
            self.close_connection = True
            return self.send_json({'erro': 'Muitas requisições. Aguarde um instante.'}, 429)
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        self.query = urllib.parse.parse_qs(parsed.query)
        if path.startswith('/api/'):
            conn = db()
            try:
                if method != 'GET' and self.headers.get('X-NexarPay') != '1':
                    raise ApiError(403, 'Requisição inválida.')
                self.api(conn, method, path)
            except ApiError as e:
                conn.rollback()
                body = {'erro': e.message}
                body.update(e.extra)
                self.send_json(body, e.status)
            except Exception:
                conn.rollback()
                traceback.print_exc()
                self.send_json({'erro': 'Erro interno no servidor.'}, 500)
            finally:
                conn.close()
            return
        if method != 'GET':
            self.send_json({'erro': 'Método não permitido.'}, 405)
            return
        self.serve_static(path)

    def serve_static(self, path):
        if path in ('/', '/index.html'):
            path = '/static/index.html'
        if not path.startswith('/static/'):
            self.send_json({'erro': 'Não encontrado.'}, 404)
            return
        rel = urllib.parse.unquote(path[len('/static/'):])
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not is_inside(full, STATIC_DIR) or not os.path.isfile(full):
            self.send_json({'erro': 'Não encontrado.'}, 404)
            return
        self.send_file(full)

    # ---------- API
    def api(self, conn, method, path):
        parts = [p for p in path.split('/') if p][1:]  # remove 'api'
        key = (method, '/'.join(parts[:2]) if len(parts) >= 2 and parts[0] in ('auth', 'backup', 'email') else parts[0] if parts else '')
        publica = key in (('POST', 'auth/login'), ('POST', 'auth/logout'), ('POST', 'auth/forgot'), ('POST', 'auth/reset'), ('POST', 'auth/mfa'), ('GET', 'auth/me'))
        if method in ('POST', 'PUT') and not publica:
            self.require_user(conn)  # só lê corpos grandes (uploads) de quem já está autenticado
        upload = method == 'POST' and parts[:1] == ['files']  # corpo binário: lido em blocos por api_files_upload
        body = self.read_body(32 * 1024 if publica or parts[0] == 'auth' else None) if method in ('POST', 'PUT') and not upload else {}

        # ---- autenticação
        if key == ('POST', 'auth/login'):
            return self.api_login(conn, body)
        if key == ('POST', 'auth/logout'):
            tok = self.cookie(SESSION_COOKIE)
            if tok:
                u_out = self.current_user(conn)
                conn.execute('DELETE FROM sessions WHERE token=?', (hash_token(tok),))
                conn.commit()
                if u_out:
                    self.audit(conn, u_out, 'logout', u_out['email'])
            return self.send_json({'ok': True}, cookies=[self.cookie_str('', 0)])
        if key == ('POST', 'auth/forgot'):
            return self.api_forgot(conn, body)
        if key == ('POST', 'auth/reset'):
            return self.api_reset(conn, body)
        if key == ('POST', 'auth/mfa'):
            return self.api_mfa(conn, body, parts[2] if len(parts) > 2 else '')
        if key == ('GET', 'auth/me'):
            u = self.current_user(conn)
            conn.commit()
            return self.send_json({'user': user_public(u)})
        if key[1] == 'auth/sessions':
            return self.api_sessions(conn, method, body)
        if key[1] == 'auth/reauth':
            return self.api_reauth(conn, method, body)
        if key == ('POST', 'auth/change-password'):
            return self.api_change_password(conn, body)
        if key == ('PUT', 'auth/dashboard-config'):
            return self.api_dashboard_config(conn, body)

        user = self.require_user(conn)
        if mfa_exigido(user) and not user['mfa_ativo']:  # perfil que exige MFA e ainda não ativou: só consegue configurar (rotas /auth/mfa/*)
            raise ApiError(403, 'Ative a verificação em duas etapas para continuar.', {'mfaSetupRequired': True})
        if user['senha_provisoria']:  # senha provisória: só é possível trocar a senha ou sair (não depende do frontend)
            raise ApiError(403, 'Defina uma nova senha para continuar.', {'mustChangePassword': True})
        if user['perfil'] == 'tv' and method != 'GET':
            raise ApiError(403, 'Este perfil tem acesso somente de leitura ao Dashboard.')

        if key == ('GET', 'bootstrap'):
            return self.api_bootstrap(conn, user)

        # ---- usuários (admin)
        if parts[0] == 'users':
            return self.api_users(conn, user, method, parts, body)
        if parts[0] == 'departamentos':
            return self.api_departamentos(conn, user, method, parts, body)
        if parts[0] == 'properties':
            return self.api_properties(conn, user, method, parts, body)
        if parts[0] == 'budgets':
            return self.api_budgets(conn, user, method, parts, body)
        if parts[0] == 'launches':
            return self.api_launches(conn, user, method, parts, body)
        if parts[0] == 'files':
            return self.api_files(conn, user, method, parts, body)
        if parts[0] == 'solicitacoes':
            return self.api_solicitacoes(conn, user, method, parts, body)
        if parts[0] == 'backup':
            return self.api_backup(conn, user, method, parts, body)
        if parts[0] == 'email':
            return self.api_email(conn, user, method, parts, body)
        if parts[0] == 'empresas':
            return self.api_empresas(conn, user, method, parts, body)
        if parts[0] == 'anos':
            return self.api_anos(conn, user, method, parts, body)
        if parts[0] == 'relatorios':
            return self.api_relatorios(conn, user, method, parts, body)
        if parts[0] == 'auditoria':
            return self.api_auditoria(conn, user, method, parts)
        raise ApiError(404, 'Rota não encontrada.')

    # ---- auth
    LOGIN_FAILS = {}      # ip -> [timestamps]
    LOGIN_FAILS_EMAIL = {}  # e-mail -> [timestamps] (usado no 2º fator, quando o atacante já sabe a senha)
    LOGIN_FAILS_EMAIL_H = {}  # e-mail -> [timestamps] (janela de 1 h: ataque distribuído)
    BLOQUEIOS = {}        # 'ip|e-mail' -> {falhas, strikes, ate}: bloqueio progressivo de quem erra a senha
    FORGOT_HITS = {}      # ip/e-mail -> [timestamps]

    def audit(self, conn, user, acao, alvo=None, detalhes=None, email=None):
        audit(conn, user, acao, alvo, detalhes, ip=self.client_ip(), email=email)

    def cookie_str(self, valor, max_age):
        return '%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d%s' % (SESSION_COOKIE, valor, max_age, '; Secure' if USE_HTTPS else '')

    @staticmethod
    def _janela(d, chave, segundos):
        agora = dt.datetime.now().timestamp()
        v = [t for t in d.get(chave, []) if t > agora - segundos]
        if v:
            d[chave] = v
        else:
            d.pop(chave, None)
        return v

    def _limite(self, d, chave, segundos, maximo, msg):
        if len(self._janela(d, chave, segundos)) >= maximo:
            raise ApiError(429, msg)

    @staticmethod
    def _registra(d, chave):
        d.setdefault(chave, []).append(dt.datetime.now().timestamp())
        if len(d) > 5000:  # evita crescimento ilimitado da memória
            for k in list(d)[:1000]:
                d.pop(k, None)

    MFA_FAILS = {}        # hash da sessão pendente -> [timestamps]
    RESET_HITS = {}       # ip -> [timestamps]

    def _abrir_sessao(self, conn, u, etapa=None, segundos=None):
        tok = secrets.token_urlsafe(32)
        idle, absol = limites_sessao(u['perfil'])
        exp = (dt.datetime.now() + dt.timedelta(seconds=segundos or idle)).replace(microsecond=0).isoformat()
        conn.execute('INSERT INTO sessions(token,user_id,criado_em,expira_em,etapa,ip,ua) VALUES(?,?,?,?,?,?,?)',
                     (hash_token(tok), u['id'], now_iso(), exp, etapa, self.client_ip(), (self.headers.get('User-Agent') or '')[:200]))
        return tok, segundos or absol

    def _checar_bloqueio(self, par):
        b = Handler.BLOQUEIOS.get(par)
        agora = dt.datetime.now().timestamp()
        if b and b['ate'] > agora:
            raise ApiError(429, 'Muitas tentativas a partir deste acesso. Aguarde %d min e tente de novo.' % (int((b['ate'] - agora) / 60) + 1))

    def _falha_par(self, par):
        agora = dt.datetime.now().timestamp()
        b = Handler.BLOQUEIOS.setdefault(par, {'falhas': [], 'strikes': 0, 'ate': 0, 'ultimo': agora})
        if agora - b['ultimo'] > 86400:
            b['strikes'] = 0
        b['ultimo'] = agora
        b['falhas'] = [t for t in b['falhas'] if t > agora - 900] + [agora]
        if len(b['falhas']) >= 5:  # 5 erros em 15 min: bloqueia 1, 2, 4, 8, 16 e no máximo 30 min (cresce a cada reincidência)
            b['strikes'] += 1
            b['falhas'] = []
            b['ate'] = agora + min(60 * 2 ** (b['strikes'] - 1), 1800)
        if len(Handler.BLOQUEIOS) > 5000:
            for k in sorted(Handler.BLOQUEIOS, key=lambda x: Handler.BLOQUEIOS[x]['ultimo'])[:1000]:
                Handler.BLOQUEIOS.pop(k, None)

    def _registrar_ip(self, conn, u):
        ip = self.client_ip()
        conn.execute('INSERT OR REPLACE INTO ips_conhecidos(user_id,ip,ultimo_uso) VALUES(?,?,?)', (u['id'], ip, now_iso()))
        conn.execute('DELETE FROM ips_conhecidos WHERE user_id=? AND ip NOT IN (SELECT ip FROM ips_conhecidos WHERE user_id=? ORDER BY ultimo_uso DESC LIMIT 20)', (u['id'], u['id']))

    def api_login(self, conn, body):
        email = str(body.get('email') or '').strip().lower()[:200]
        senha = str(body.get('senha') or '')[:200]
        ip = self.client_ip()
        msg = 'Muitas tentativas. Aguarde alguns minutos.'
        self._limite(Handler.LOGIN_FAILS, ip, 600, 20, msg)
        par = ip + '|' + email
        self._checar_bloqueio(par)  # o bloqueio vale para ESTE IP + ESTE e-mail: quem erra não trava a conta para o dono
        u = conn.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
        if u and len(self._janela(Handler.LOGIN_FAILS_EMAIL_H, email, 3600)) >= 25 and \
                not conn.execute('SELECT 1 FROM ips_conhecidos WHERE user_id=? AND ip=?', (u['id'], ip)).fetchone():
            raise ApiError(429, msg)  # ataque distribuído contra a conta: só IPs já usados pelo dono passam
        ok = 0
        if u and u['ativo']:
            ok = verify_password(senha, u['senha_hash'], u['salt'])
        else:
            verify_password(senha, *_DUMMY_HASH)  # custo igual para usuário inexistente (evita enumeração por tempo)
        if not ok:
            self._registra(Handler.LOGIN_FAILS, ip)
            self._registra(Handler.LOGIN_FAILS_EMAIL_H, email)
            self._falha_par(par)
            self.audit(conn, None, 'login.falha', email, {'contaExiste': bool(u)}, email=email)
            raise ApiError(401, 'E-mail ou senha incorretos.')
        Handler.LOGIN_FAILS.pop(ip, None)
        Handler.BLOQUEIOS.pop(par, None)
        if ok == 1:  # hash antigo (120 mil iterações): regrava com o padrão atual
            h, sl = hash_password(senha)
            conn.execute('UPDATE users SET senha_hash=?, salt=? WHERE id=?', (h, sl, u['id']))
        conn.execute("DELETE FROM sessions WHERE expira_em < ?", (now_iso(),))
        if u['mfa_ativo']:  # senha ok, falta o 2º fator: sessão pendente de 5 min, sem acesso a nada
            tok, dur = self._abrir_sessao(conn, u, 'mfa', 300)
            conn.commit()
            self.audit(conn, u, 'login.aguardando_mfa', u['email'])
            return self.send_json({'mfaRequired': True}, cookies=[self.cookie_str(tok, dur)])
        Handler.LOGIN_FAILS_EMAIL.pop(email, None)
        tok, dur = self._abrir_sessao(conn, u)
        conn.execute('UPDATE users SET ultimo_login=? WHERE id=?', (now_iso(), u['id']))
        self._registrar_ip(conn, u)
        conn.commit()
        print('[auth] login ok: %s ip=%s' % (u['email'], ip))
        self.audit(conn, u, 'login.ok', u['email'], {'mfa': False})
        self.send_json({'user': user_public(u), 'mustChangePassword': bool(u['senha_provisoria'])}, cookies=[self.cookie_str(tok, dur)])

    def _gerar_link_reset(self, conn, u, horas):
        """Token de uso único (guardado só como hash). O link usa #fragmento: o token não vai em logs de acesso nem em Referer."""
        tok = secrets.token_urlsafe(32)
        exp = (dt.datetime.now() + dt.timedelta(hours=horas)).replace(microsecond=0).isoformat()
        conn.execute('UPDATE users SET reset_hash=?, reset_salt=NULL, reset_exp=? WHERE id=?', (hash_token(tok), exp, u['id']))
        conn.commit()
        return '%s/#redefinir=%s' % ((CONFIG.get('url_base') or '').rstrip('/'), tok)

    def api_forgot(self, conn, body):
        email = str(body.get('email') or '').strip().lower()[:200]
        ip = self.client_ip()
        resposta = {'ok': True, 'mensagem': 'Se o e-mail estiver cadastrado, você receberá em instantes um link para criar uma nova senha.'}
        msg = 'Muitos pedidos de recuperação. Tente novamente mais tarde.'
        self._limite(Handler.FORGOT_HITS, 'ip:' + ip, 3600, 10, msg)
        if len(self._janela(Handler.FORGOT_HITS, 'em:' + email, 3600)) >= 3:
            return self.send_json(resposta)  # silencioso: não revela cadastro nem permite inundar a caixa do usuário
        self._registra(Handler.FORGOT_HITS, 'ip:' + ip)
        self._registra(Handler.FORGOT_HITS, 'em:' + email)
        u = conn.execute('SELECT * FROM users WHERE email=? AND ativo=1', (email,)).fetchone()
        if u:
            link = self._gerar_link_reset(conn, u, 0.5)
            corpo = ('Olá, %s.\n\nRecebemos um pedido para redefinir a senha do NexarPay.\n\n'
                     'Para criar uma nova senha, abra o link abaixo (vale por 30 minutos e só pode ser usado uma vez):\n\n%s\n\n'
                     'Se você não fez este pedido, ignore esta mensagem: nada será alterado e sua senha atual continua valendo.\n\nAtenciosamente\nNexarPay') % (u['nome'], link)
            enviar_email(u['email'], 'NexarPay — Redefinição de senha', corpo, sensivel=True)
            self.audit(conn, u, 'senha.redefinicao_solicitada', u['email'])
        self.send_json(resposta)

    def api_reset(self, conn, body):
        ip = self.client_ip()
        self._limite(Handler.RESET_HITS, ip, 3600, 20, 'Muitas tentativas. Tente novamente mais tarde.')
        self._registra(Handler.RESET_HITS, ip)
        tok = str(body.get('token') or '')[:200]
        nova = str(body.get('novaSenha') or '')
        u = conn.execute('SELECT * FROM users WHERE reset_hash=? AND reset_exp>? AND ativo=1', (hash_token(tok), now_iso())).fetchone() if len(tok) >= 20 else None
        if not u:
            raise ApiError(400, 'Link inválido ou expirado. Peça um novo em "Esqueci minha senha".')
        if not senha_forte(nova):
            raise ApiError(400, MSG_SENHA_FRACA)
        h, sl = hash_password(nova)
        conn.execute('UPDATE users SET senha_hash=?, salt=?, senha_provisoria=0, reset_hash=NULL, reset_salt=NULL, reset_exp=NULL WHERE id=?', (h, sl, u['id']))
        conn.execute('DELETE FROM sessions WHERE user_id=?', (u['id'],))  # derruba qualquer sessão aberta com a senha antiga
        conn.commit()
        Handler.LOGIN_FAILS_EMAIL.pop(u['email'], None)
        self.audit(conn, u, 'senha.redefinida_por_link', u['email'])
        self.send_json({'ok': True, 'mensagem': 'Senha alterada. Entre com a nova senha.'})

    # ---- MFA (TOTP)
    def _confere_totp(self, conn, u, codigo, igual=False):
        """igual=True (reautenticação com sessão já aberta) aceita o código do mesmo passo do último login; no login, nunca."""
        if not u['mfa_secret'] or not re.fullmatch(r'\d{6}', codigo or ''):
            return False
        segredo = decifrar(u['mfa_secret'])
        atual = int(dt.datetime.now().timestamp() // 30)
        for passo in (atual - 1, atual, atual + 1):
            if hmac.compare_digest(totp_codigo(segredo, passo), codigo):
                ultimo = u['mfa_ultimo_passo'] or 0
                if passo < ultimo or (passo == ultimo and not igual):
                    return False  # código já usado (anti-replay)
                if passo > ultimo:
                    conn.execute('UPDATE users SET mfa_ultimo_passo=? WHERE id=?', (passo, u['id']))
                return True
        return False

    def _usa_recuperacao(self, conn, u, codigo):
        codes = pj(u['mfa_codes'], [])
        h = _hash_recuperacao(codigo)
        if len(re.sub(r'[\s-]', '', codigo)) >= 8 and h in codes:
            codes.remove(h)
            conn.execute('UPDATE users SET mfa_codes=? WHERE id=?', (j(codes), u['id']))
            return True
        return False

    def api_mfa(self, conn, body, sub):
        codigo = re.sub(r'[\s-]', '', str(body.get('codigo') or ''))[:32]
        ip = self.client_ip()
        if sub == 'verificar':  # 2º passo do login (usa a sessão pendente)
            tok = self.cookie(SESSION_COOKIE)
            s_ = conn.execute('SELECT * FROM sessions WHERE token=? AND etapa=? AND expira_em>?', (hash_token(tok or ''), 'mfa', now_iso())).fetchone() if tok else None
            if not s_:
                raise ApiError(401, 'A verificação expirou. Entre novamente com e-mail e senha.')
            u = conn.execute('SELECT * FROM users WHERE id=? AND ativo=1', (s_['user_id'],)).fetchone()
            chave = hash_token(tok)
            self._limite(Handler.LOGIN_FAILS_EMAIL, u['email'], 900, 8, 'Muitas tentativas. Aguarde alguns minutos.')
            if len(self._janela(Handler.MFA_FAILS, chave, 300)) >= 5:
                conn.execute('DELETE FROM sessions WHERE token=?', (chave,))
                conn.commit()
                raise ApiError(401, 'Muitas tentativas de código. Entre novamente com e-mail e senha.')
            por_recuperacao = False
            ok = self._confere_totp(conn, u, codigo)
            if not ok:
                por_recuperacao = ok = self._usa_recuperacao(conn, u, codigo)
            if not ok:
                self._registra(Handler.MFA_FAILS, chave)
                self._registra(Handler.LOGIN_FAILS_EMAIL, u['email'])
                conn.commit()
                self.audit(conn, u, 'login.mfa_falha', u['email'])
                raise ApiError(401, 'Código inválido ou expirado.')
            Handler.MFA_FAILS.pop(chave, None)
            Handler.LOGIN_FAILS_EMAIL.pop(u['email'], None)
            conn.execute('DELETE FROM sessions WHERE token=?', (chave,))
            novo, dur = self._abrir_sessao(conn, u)  # sessão nova (evita fixação)
            conn.execute('UPDATE users SET ultimo_login=? WHERE id=?', (now_iso(), u['id']))
            self._registrar_ip(conn, u)
            conn.commit()
            self.audit(conn, u, 'login.ok', u['email'], {'mfa': True, 'codigoDeRecuperacao': por_recuperacao})
            u = conn.execute('SELECT * FROM users WHERE id=?', (u['id'],)).fetchone()
            return self.send_json({'user': user_public(u), 'mustChangePassword': bool(u['senha_provisoria']),
                                   'codigosRestantes': len(pj(u['mfa_codes'], [])) if por_recuperacao else None}, cookies=[self.cookie_str(novo, dur)])
        u = self.require_user(conn)  # as demais rotas exigem sessão completa
        if sub == 'setup':
            if u['mfa_ativo']:
                raise ApiError(400, 'A verificação em duas etapas já está ativa.')
            segredo = base64.b32encode(secrets.token_bytes(20)).decode('ascii')
            conn.execute('UPDATE users SET mfa_secret=? WHERE id=?', (cifrar(segredo), u['id']))
            conn.commit()
            uri = 'otpauth://totp/NexarPay:%s?secret=%s&issuer=NexarPay&digits=6&period=30' % (urllib.parse.quote(u['email']), segredo)
            return self.send_json({'secret': segredo, 'uri': uri})
        if sub == 'enable':
            if u['mfa_ativo'] or not u['mfa_secret']:
                raise ApiError(400, 'Inicie a configuração primeiro.')
            self._limite(Handler.LOGIN_FAILS_EMAIL, u['email'], 900, 8, 'Muitas tentativas. Aguarde alguns minutos.')
            if not self._confere_totp(conn, u, codigo):
                self._registra(Handler.LOGIN_FAILS_EMAIL, u['email'])
                raise ApiError(400, 'Código incorreto. Confira o horário do celular e tente de novo.')
            alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
            codes = ['-'.join(''.join(secrets.choice(alfabeto) for _ in range(5)) for _ in range(2)) for _ in range(8)]
            conn.execute('UPDATE users SET mfa_ativo=1, mfa_codes=? WHERE id=?', (j([_hash_recuperacao(c) for c in codes]), u['id']))
            tok = self.cookie(SESSION_COOKIE)
            conn.execute('DELETE FROM sessions WHERE user_id=? AND token<>?', (u['id'], hash_token(tok or '')))
            conn.commit()
            self.audit(conn, u, 'mfa.ativado', u['email'])
            return self.send_json({'ok': True, 'codigosRecuperacao': codes})
        if sub == 'disable':
            if mfa_exigido(u):
                raise ApiError(403, 'A verificação em duas etapas é obrigatória para o seu perfil.')
            if not u['mfa_ativo']:
                raise ApiError(400, 'A verificação em duas etapas não está ativa.')
            if not verify_password(str(body.get('senha') or ''), u['senha_hash'], u['salt']) or not (self._confere_totp(conn, u, codigo) or self._usa_recuperacao(conn, u, codigo)):
                raise ApiError(400, 'Senha ou código incorretos.')
            conn.execute('UPDATE users SET mfa_ativo=0, mfa_secret=NULL, mfa_codes=NULL, mfa_ultimo_passo=0 WHERE id=?', (u['id'],))
            conn.commit()
            self.audit(conn, u, 'mfa.desativado', u['email'])
            return self.send_json({'ok': True})
        raise ApiError(404, 'Rota não encontrada.')

    def exige_reauth(self, conn, user):
        """Ações sensíveis (usuários, backup) pedem a senha de novo se a última confirmação passou de REAUTH_MINUTOS."""
        tok = self.cookie(SESSION_COOKIE)
        s_ = conn.execute('SELECT reauth_em FROM sessions WHERE token=?', (hash_token(tok or ''),)).fetchone()
        limite = (dt.datetime.now() - dt.timedelta(minutes=REAUTH_MINUTOS)).replace(microsecond=0).isoformat()
        if not s_ or not s_['reauth_em'] or s_['reauth_em'] < limite:
            raise ApiError(403, 'Por segurança, confirme sua senha para continuar.', {'reauth': True})

    def api_reauth(self, conn, method, body):
        u = self.require_user(conn)
        tok = hash_token(self.cookie(SESSION_COOKIE) or '')
        if method == 'GET':
            try:
                self.exige_reauth(conn, u)
                return self.send_json({'recente': True})
            except ApiError:
                return self.send_json({'recente': False, 'mfa': bool(u['mfa_ativo'])})
        self._limite(Handler.LOGIN_FAILS_EMAIL, u['email'], 900, 8, 'Muitas tentativas. Aguarde alguns minutos.')
        ok = verify_password(str(body.get('senha') or ''), u['senha_hash'], u['salt']) and \
            (not u['mfa_ativo'] or self._confere_totp(conn, u, re.sub(r'[\s-]', '', str(body.get('codigo') or '')), igual=True))
        if not ok:
            self._registra(Handler.LOGIN_FAILS_EMAIL, u['email'])
            self.audit(conn, u, 'sessao.reauth_falha', u['email'])
            raise ApiError(400, 'Senha ou código incorretos.')
        conn.execute('UPDATE sessions SET reauth_em=? WHERE token=?', (now_iso(), tok))
        conn.commit()
        self.audit(conn, u, 'sessao.reautenticada', u['email'])
        return self.send_json({'ok': True})

    def api_sessions(self, conn, method, body):
        u = self.require_user(conn)
        atual = hash_token(self.cookie(SESSION_COOKIE) or '')
        if method == 'GET':
            rows = conn.execute('SELECT * FROM sessions WHERE user_id=? AND etapa IS NULL AND expira_em>? ORDER BY criado_em DESC', (u['id'], now_iso())).fetchall()
            return self.send_json({'sessions': [{'id': r['token'][:16], 'criadoEm': r['criado_em'], 'expiraEm': r['expira_em'], 'ip': r['ip'], 'ua': r['ua'], 'atual': r['token'] == atual} for r in rows]})
        if method == 'POST':
            if body.get('todas'):
                n = conn.execute('DELETE FROM sessions WHERE user_id=? AND token<>?', (u['id'], atual)).rowcount
            else:
                sid = str(body.get('id') or '')
                if len(sid) != 16:
                    raise ApiError(400, 'Sessão inválida.')
                n = conn.execute('DELETE FROM sessions WHERE user_id=? AND substr(token,1,16)=? AND token<>?', (u['id'], sid, atual)).rowcount
            conn.commit()
            self.audit(conn, u, 'sessao.encerrada', u['email'], {'quantidade': n, 'todas': bool(body.get('todas'))})
            return self.send_json({'ok': True, 'encerradas': n})
        raise ApiError(405, 'Método não permitido.')

    def api_change_password(self, conn, body):
        u = self.require_user(conn)
        atual = str(body.get('senhaAtual') or '')
        nova = str(body.get('novaSenha') or '')
        if not senha_forte(nova):
            raise ApiError(400, MSG_SENHA_FRACA)
        if not verify_password(atual, u['senha_hash'], u['salt']):
            raise ApiError(400, 'Senha atual incorreta.')
        if nova == atual:
            raise ApiError(400, 'A nova senha deve ser diferente da atual.')
        h, s = hash_password(nova)
        conn.execute('UPDATE users SET senha_hash=?, salt=?, senha_provisoria=0, reset_hash=NULL, reset_salt=NULL, reset_exp=NULL WHERE id=?', (h, s, u['id']))
        tok = self.cookie(SESSION_COOKIE)  # encerra as demais sessões do usuário, mantendo a atual
        conn.execute('DELETE FROM sessions WHERE user_id=? AND token<>?', (u['id'], hash_token(tok or '')))
        conn.commit()
        print('[auth] senha alterada: %s' % u['email'])
        if not DEMO_MODE and u['perfil'] == 'admin':  # a senha provisória do 1º acesso não deve ficar no disco
            try:
                os.remove(os.path.join(DATA_DIR, 'credenciais-iniciais.txt'))
            except OSError:
                pass
        self.audit(conn, u, 'senha.alterada', u['email'])
        self.send_json({'ok': True})

    # ---- preferências do dashboard (perfil Dashboard/TV, mas qualquer usuário pode ter as suas)
    def api_dashboard_config(self, conn, body):
        user = self.require_user(conn)
        widgets = body.get('widgets')
        if not isinstance(widgets, list) or not all(isinstance(w, str) for w in widgets):
            raise ApiError(400, 'Lista de widgets inválida.')
        try:
            intervalo = int(body.get('intervaloSegundos') or 30)
        except Exception:
            intervalo = 30
        intervalo = max(15, min(intervalo, 600))
        cfg = {'widgets': widgets, 'intervaloSegundos': intervalo}
        conn.execute('UPDATE users SET dashboard_tv_config=? WHERE id=?', (j(cfg), user['id']))
        conn.commit()
        self.send_json({'ok': True, 'dashboardTvConfig': cfg})

    # ---- bootstrap
    def api_bootstrap(self, conn, user):
        nomes = mapa_empresas(conn)
        deps = [row_to_dict(r) for r in conn.execute('SELECT * FROM departamentos ORDER BY nome')]
        props = {r['chave']: pj(r['valor'], []) for r in conn.execute('SELECT * FROM properties')}
        users_light = [{'id': r['id'], 'nome': r['nome'], 'email': r['email'], 'perfil': r['perfil'], 'ativo': bool(r['ativo'])}
                       for r in conn.execute('SELECT id,nome,email,perfil,ativo FROM users ORDER BY nome')]
        if pode_ver_todos_deps(user):
            budgets = [budget_out(r) for r in conn.execute('SELECT * FROM budgets ORDER BY ano DESC')]
            launches = [launch_out(r, user, nomes) for r in conn.execute('SELECT * FROM launches ORDER BY id')]
        else:
            ids = list(deps_do_usuario(user)) or ['__none__']
            ph = ','.join('?' * len(ids))
            budgets = [budget_out(r) for r in conn.execute('SELECT * FROM budgets WHERE departamento_id IN (%s) ORDER BY ano DESC' % ph, ids)]
            launches = [launch_out(r, user, nomes) for r in conn.execute('SELECT * FROM launches WHERE departamento_id IN (%s) ORDER BY id' % ph, ids)]
        conn.commit()
        self.send_json({
            'user': user_public(user), 'departamentos': deps, 'properties': props, 'budgets': budgets, 'launches': launches,
            'empresas': empresas_lista(conn), 'grupoNome': grupo_nome(conn),
            'anosFechados': [r['ano'] for r in conn.execute('SELECT ano FROM anos_fechados ORDER BY ano')],
            'users': users_light, 'perfis': PERFIS, 'tiposSolicitacao': TIPOS_SOLICITACAO, 'statusLabel': STATUS_LABEL,
            'config': {'demo': DEMO_MODE, 'dominio': CONFIG.get('dominio_permitido'), 'prazosDocFiscal': PRAZO_DOC_FISCAL, 'maxUploadMB': MAX_UPLOAD_MB,
                       'emailModo': (CONFIG.get('email') or {}).get('modo'), 'reenvioParaAprovacao1': bool(CONFIG.get('reenvio_retorna_para_aprovacao1', True))},
            'trava': pendencias_doc_fiscal(conn, user['id']), 'travaFreelancer': bloqueio_freelancer(conn, user['id']),
        })

    # ---- usuários
    def api_users(self, conn, user, method, parts, body):
        if method == 'GET':
            self.require_user(conn, ['admin'])
            return self.send_json({'users': [user_public(r) for r in conn.execute('SELECT * FROM users ORDER BY nome')]})
        self.require_user(conn, ['admin'])
        self.exige_reauth(conn, user)  # criar/alterar/excluir usuário é ação sensível
        if method == 'POST' or (method == 'PUT' and len(parts) == 2):
            uid_ = parts[1] if method == 'PUT' else None
            existing = conn.execute('SELECT * FROM users WHERE id=?', (uid_,)).fetchone() if uid_ else None
            if uid_ and not existing:
                raise ApiError(404, 'Usuário não encontrado.')
            nome = (body.get('nome') or '').strip()
            email = (body.get('email') or '').strip().lower()
            perfil = body.get('perfil')
            if not nome or not email or perfil not in PERFIS:
                raise ApiError(400, 'Nome, e-mail e perfil são obrigatórios.')
            if not email_valido_dominio(email):
                raise ApiError(400, 'Somente e-mails do domínio @%s podem ser cadastrados.' % CONFIG.get('dominio_permitido'))
            dupe = conn.execute('SELECT id FROM users WHERE email=? AND id<>?', (email, uid_ or '')).fetchone()
            if dupe:
                raise ApiError(400, 'Já existe um usuário com esse e-mail.')
            deps = [d for d in (body.get('departamentos') or []) if isinstance(d, str)]
            d1, d2 = body.get('diretor1Id') or None, body.get('diretor2Id') or None
            for d in (d1, d2):
                if d:
                    r = conn.execute("SELECT perfil FROM users WHERE id=? AND ativo=1", (d,)).fetchone()
                    if not r or r['perfil'] not in ('diretor', 'admin'):
                        raise ApiError(400, 'Os aprovadores devem ser usuários ativos com perfil Diretor(a).')
            if d1 and d1 == d2:
                raise ApiError(400, 'Diretor(a) 1 e Diretor(a) 2 devem ser pessoas diferentes.')
            rh1 = 1 if (perfil == 'rh' and body.get('rh1')) else 0
            rh2 = 1 if (perfil == 'rh' and body.get('rh2')) else 0
            ativo = 1 if body.get('ativo', True) else 0
            senha = body.get('senha') or ''
            provisoria = 1 if body.get('senhaProvisoria') else 0
            if existing:
                if existing['id'] == user['id'] and (perfil != 'admin' or not ativo):
                    raise ApiError(400, 'Você não pode remover seu próprio acesso de administrador.')
                if existing['perfil'] == 'admin' and (perfil != 'admin' or not ativo):
                    n = conn.execute("SELECT COUNT(*) FROM users WHERE perfil='admin' AND ativo=1 AND id<>?", (existing['id'],)).fetchone()[0]
                    if n == 0:
                        raise ApiError(400, 'Não é possível remover o único administrador ativo.')
                conn.execute('UPDATE users SET nome=?,email=?,perfil=?,departamentos=?,diretor1_id=?,diretor2_id=?,ativo=?,rh1=?,rh2=? WHERE id=?',
                             (nome, email, perfil, j(deps), d1, d2, ativo, rh1, rh2, uid_))
                if senha:
                    if not senha_forte(senha):
                        raise ApiError(400, MSG_SENHA_FRACA)
                    h, s = hash_password(senha)
                    conn.execute('UPDATE users SET senha_hash=?,salt=?,senha_provisoria=?,reset_hash=NULL,reset_salt=NULL,reset_exp=NULL WHERE id=?', (h, s, provisoria, uid_))
                    conn.execute('DELETE FROM sessions WHERE user_id=?', (uid_,))
                if not ativo or perfil != existing['perfil']:
                    conn.execute('DELETE FROM sessions WHERE user_id=?', (uid_,))
                mfa_resetado = bool(body.get('resetarMfa')) and bool(existing['mfa_ativo'])
                if mfa_resetado:  # perdeu o celular: apaga o 2º fator (perfis obrigatórios refazem o cadastro no próximo login)
                    conn.execute('UPDATE users SET mfa_ativo=0, mfa_secret=NULL, mfa_codes=NULL, mfa_ultimo_passo=0 WHERE id=?', (uid_,))
                    conn.execute('DELETE FROM sessions WHERE user_id=?', (uid_,))
                conn.commit()
                if mfa_resetado:
                    self.audit(conn, user, 'mfa.resetado_por_admin', uid_, {'email': existing['email']})
                mud = {k: {'de': a, 'para': b} for k, a, b in (
                    ('nome', existing['nome'], nome), ('email', existing['email'], email), ('perfil', existing['perfil'], perfil),
                    ('ativo', bool(existing['ativo']), bool(ativo)), ('departamentos', pj(existing['departamentos'], []), deps),
                    ('diretor1Id', existing['diretor1_id'], d1), ('diretor2Id', existing['diretor2_id'], d2),
                    ('rh1', bool(existing['rh1']), bool(rh1)), ('rh2', bool(existing['rh2']), bool(rh2))) if a != b}
                if senha:
                    mud['senha'] = 'redefinida pelo administrador'
                self.audit(conn, user, 'usuario.alterado', uid_, {'email': email, 'mudancas': mud})
                return self.send_json({'user': user_public(conn.execute('SELECT * FROM users WHERE id=?', (uid_,)).fetchone())})
            if not senha_forte(senha):
                raise ApiError(400, MSG_SENHA_FRACA)
            h, s = hash_password(senha)
            new_id = uid('u_')
            conn.execute('INSERT INTO users(id,nome,email,senha_hash,salt,perfil,departamentos,diretor1_id,diretor2_id,ativo,senha_provisoria,criado_em,rh1,rh2) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                         (new_id, nome, email, h, s, perfil, j(deps), d1, d2, ativo, provisoria, now_iso(), rh1, rh2))
            conn.commit()
            self.audit(conn, user, 'usuario.criado', new_id, {'email': email, 'perfil': perfil, 'ativo': bool(ativo), 'departamentos': deps, 'senhaProvisoria': bool(provisoria)})
            if body.get('enviarBoasVindas'):  # nenhuma senha viaja por e-mail: o usuário cria a própria pelo link (vale 24 h)
                novo_u = conn.execute('SELECT * FROM users WHERE id=?', (new_id,)).fetchone()
                link = self._gerar_link_reset(conn, novo_u, 24)
                corpo = ('Olá, %s.\n\nSeu acesso ao NexarPay foi criado (login: %s).\n\nPara definir sua senha, abra o link abaixo (vale por 24 horas e só pode ser usado uma vez):\n\n%s\n\n'
                         'Depois acesse %s e entre com seu e-mail e a senha que você criou.\n\nAtenciosamente\nNexarPay' % (nome, email, link, CONFIG.get('url_base')))
                enviar_email(email, 'NexarPay — Seu acesso foi criado', corpo, sensivel=True)
            return self.send_json({'user': user_public(conn.execute('SELECT * FROM users WHERE id=?', (new_id,)).fetchone())}, 201)
        if method == 'DELETE' and len(parts) == 2:
            uid_ = parts[1]
            if uid_ == user['id']:
                raise ApiError(400, 'Você não pode excluir o próprio usuário logado.')
            alvo = conn.execute('SELECT * FROM users WHERE id=?', (uid_,)).fetchone()
            if not alvo:
                raise ApiError(404, 'Usuário não encontrado.')
            if alvo['perfil'] == 'admin' and conn.execute("SELECT COUNT(*) FROM users WHERE perfil='admin' AND ativo=1").fetchone()[0] <= 1:
                raise ApiError(400, 'Não é possível excluir o único administrador do sistema.')
            em_uso = conn.execute('SELECT COUNT(*) FROM solicitacoes WHERE solicitante_id=? OR aprovador1_id=? OR aprovador2_id=?', (uid_, uid_, uid_)).fetchone()[0]
            if em_uso:
                conn.execute('UPDATE users SET ativo=0 WHERE id=?', (uid_,))
                conn.execute('DELETE FROM sessions WHERE user_id=?', (uid_,))
                conn.commit()
                self.audit(conn, user, 'usuario.desativado', uid_, {'email': alvo['email']})
                return self.send_json({'ok': True, 'desativado': True, 'mensagem': 'O usuário participa de solicitações e foi desativado (mantido no histórico).'})
            conn.execute('DELETE FROM sessions WHERE user_id=?', (uid_,))
            conn.execute('DELETE FROM users WHERE id=?', (uid_,))
            conn.commit()
            self.audit(conn, user, 'usuario.excluido', uid_, {'email': alvo['email'], 'perfil': alvo['perfil']})
            return self.send_json({'ok': True})
        raise ApiError(404, 'Rota não encontrada.')

    # ---- departamentos
    def api_departamentos(self, conn, user, method, parts, body):
        if method == 'GET':
            return self.send_json({'departamentos': [row_to_dict(r) for r in conn.execute('SELECT * FROM departamentos ORDER BY nome')]})
        self.require_user(conn, ['admin'])
        if method == 'POST':
            nome = (body.get('nome') or '').strip()
            if not nome:
                raise ApiError(400, 'Informe o nome do departamento.')
            if conn.execute('SELECT 1 FROM departamentos WHERE lower(nome)=lower(?)', (nome,)).fetchone():
                raise ApiError(400, 'Já existe um departamento com esse nome.')
            did = uid('dep_')
            conn.execute('INSERT INTO departamentos(id,nome,ativo) VALUES(?,?,1)', (did, nome))
            conn.commit()
            self.audit(conn, user, 'departamento.criado', did, {'nome': nome})
            return self.send_json({'departamento': {'id': did, 'nome': nome, 'ativo': 1}}, 201)
        if method == 'PUT' and len(parts) == 2:
            nome = (body.get('nome') or '').strip()
            if not nome:
                raise ApiError(400, 'Informe o nome do departamento.')
            conn.execute('UPDATE departamentos SET nome=?, ativo=? WHERE id=?', (nome, 1 if body.get('ativo', True) else 0, parts[1]))
            conn.commit()
            self.audit(conn, user, 'departamento.alterado', parts[1], {'nome': nome, 'ativo': bool(body.get('ativo', True))})
            return self.send_json({'ok': True})
        if method == 'DELETE' and len(parts) == 2:
            did = parts[1]
            uso = conn.execute('SELECT COUNT(*) FROM launches WHERE departamento_id=?', (did,)).fetchone()[0] + \
                conn.execute('SELECT COUNT(*) FROM budgets WHERE departamento_id=?', (did,)).fetchone()[0] + \
                conn.execute('SELECT COUNT(*) FROM solicitacoes WHERE departamento_id=?', (did,)).fetchone()[0]
            if uso:
                raise ApiError(400, 'Este departamento possui orçamento, lançamentos ou solicitações. Desative-o em vez de excluir.')
            conn.execute('DELETE FROM departamentos WHERE id=?', (did,))
            conn.commit()
            self.audit(conn, user, 'departamento.excluido', did)
            return self.send_json({'ok': True})
        raise ApiError(404, 'Rota não encontrada.')

    # ---- propriedades (cadastros)
    def api_properties(self, conn, user, method, parts, body):
        if method == 'GET':
            return self.send_json({'properties': {r['chave']: pj(r['valor'], []) for r in conn.execute('SELECT * FROM properties')}})
        self.require_user(conn, ['admin'])
        if method == 'PUT' and len(parts) == 2:
            chave = parts[1]
            valores = body.get('valores')
            if not isinstance(valores, list):
                raise ApiError(400, 'Lista inválida.')
            conn.execute('INSERT OR REPLACE INTO properties(chave,valor) VALUES(?,?)', (chave, j(valores)))
            # renomear/propagar nos lançamentos
            ren = body.get('renomear')
            campo = body.get('campoLancamento')
            if ren and campo and isinstance(ren, dict):
                for r in conn.execute('SELECT ano,dados FROM launches').fetchall():
                    if pj(r['dados'], {}).get(campo) == ren.get('de') and ano_fechado(conn, r['ano']):
                        raise ApiError(403, 'Este item é usado em lançamentos do ano fiscal %s, que está fechado: não é possível renomeá-lo. Reabra o ano ou crie um item novo.' % r['ano'])
                for r in conn.execute('SELECT id,dados FROM launches').fetchall():
                    d = pj(r['dados'], {})
                    if d.get(campo) == ren.get('de'):
                        d[campo] = ren.get('para')
                        conn.execute('UPDATE launches SET dados=? WHERE id=?', (j(d), r['id']))
            conn.commit()
            self.audit(conn, user, 'cadastro.alterado', chave, {'itens': len(valores), 'renomear': ren if isinstance(ren, dict) else None})
            return self.send_json({'ok': True})
        raise ApiError(404, 'Rota não encontrada.')

    # ---- orçamentos
    def api_budgets(self, conn, user, method, parts, body):
        if method == 'GET':
            rows = conn.execute('SELECT * FROM budgets ORDER BY ano DESC').fetchall()
            if not pode_ver_todos_deps(user):
                rows = [r for r in rows if r['departamento_id'] in deps_do_usuario(user)]
            return self.send_json({'budgets': [budget_out(r) for r in rows]})
        self.require_user(conn, ['admin'])
        if method == 'POST':
            ano, dep = int(body.get('ano') or 0), body.get('departamentoId')
            if not (2000 <= ano <= 2100) or not dep:
                raise ApiError(400, 'Informe ano fiscal e departamento válidos.')
            if conn.execute('SELECT 1 FROM budgets WHERE ano=? AND departamento_id=?', (ano, dep)).fetchone():
                raise ApiError(400, 'Já existe um orçamento para este departamento em %d.' % ano)
            exige_ano_aberto(conn, ano, 'o orçamento')
            if body.get('rateio'):
                validar_rateio(conn, body['rateio'])
            bid = uid('bud_')
            conn.execute('INSERT INTO budgets(id,ano,departamento_id,dolar,rateio,categorias) VALUES(?,?,?,?,?,?)',
                         (bid, ano, dep, float(body.get('dolar') or 5.5), j(body.get('rateio') or {}), j(body.get('categorias') or [])))
            conn.commit()
            self.audit(conn, user, 'orcamento.criado', bid, {'ano': ano, 'departamento': dep})
            return self.send_json({'budget': budget_out(conn.execute('SELECT * FROM budgets WHERE id=?', (bid,)).fetchone())}, 201)
        if method == 'PUT' and len(parts) == 2:
            b = conn.execute('SELECT * FROM budgets WHERE id=?', (parts[1],)).fetchone()
            if not b:
                raise ApiError(404, 'Orçamento não encontrado.')
            exige_ano_aberto(conn, b['ano'], 'o orçamento')
            antigo, novo = pj(b['rateio'], {}), body.get('rateio')
            mudou_rateio = novo is not None and not _rateio_igual(novo, antigo)
            if mudou_rateio:
                if not novo:
                    raise ApiError(400, 'Não é permitido remover o rateio de um orçamento. Informe os percentuais (soma 100%).')
                validar_rateio(conn, novo)
                if any(float(v or 0) for v in antigo.values()):  # troca de um rateio já em uso: prévia + confirmação + senha
                    imp = impacto_rateio(conn, b, novo)
                    if not body.get('confirmarRecalculo'):
                        raise ApiError(409, 'Alterar o rateio recalcula o orçado e a divisão dos gastos do grupo deste orçamento. Confira o impacto e confirme.',
                                       {'requerConfirmacao': True, 'impacto': imp})
                    self.exige_reauth(conn, user)
            conn.execute('UPDATE budgets SET dolar=?, rateio=?, categorias=? WHERE id=?',
                         (float(body.get('dolar') if body.get('dolar') is not None else b['dolar']),
                          j(body.get('rateio') if body.get('rateio') is not None else pj(b['rateio'], {})),
                          j(body.get('categorias') if body.get('categorias') is not None else pj(b['categorias'], [])), parts[1]))
            conn.commit()
            self.audit(conn, user, 'orcamento.alterado', parts[1], {'ano': b['ano'], 'departamento': b['departamento_id'], 'campos': [k for k in ('dolar', 'rateio', 'categorias') if body.get(k) is not None]})
            if mudou_rateio:
                self.audit(conn, user, 'orcamento.rateio_alterado', parts[1], {'ano': b['ano'], 'departamento': b['departamento_id'], 'antes': antigo, 'depois': novo,
                                                                               'totalGasto': impacto_rateio(conn, conn.execute('SELECT * FROM budgets WHERE id=?', (parts[1],)).fetchone(), novo)['totalGasto']})
            return self.send_json({'ok': True})
        if method == 'DELETE' and len(parts) == 2:
            bd = conn.execute('SELECT ano FROM budgets WHERE id=?', (parts[1],)).fetchone()
            if bd:
                exige_ano_aberto(conn, bd['ano'], 'o orçamento')
            conn.execute('DELETE FROM budgets WHERE id=?', (parts[1],))
            conn.commit()
            self.audit(conn, user, 'orcamento.excluido', parts[1])
            return self.send_json({'ok': True})
        raise ApiError(404, 'Rota não encontrada.')

    # ---- lançamentos
    def api_launches(self, conn, user, method, parts, body):
        nomes = mapa_empresas(conn)
        if method == 'GET' and len(parts) == 3 and parts[2] == 'segredo':
            if user['perfil'] not in ('admin', 'gestor'):
                raise ApiError(403, 'Somente Administrador ou Gestor(a) podem ver a senha/serial.')
            lid = int(parts[1]) if parts[1].isdigit() else 0
            ex = conn.execute('SELECT * FROM launches WHERE id=?', (lid,)).fetchone()
            if not ex or (user['perfil'] != 'admin' and ex['departamento_id'] not in deps_do_usuario(user)):
                raise ApiError(404, 'Lançamento não encontrado.')
            seg = decifrar(pj(ex['dados'], {}).get('senhaSerial') or '')
            self.audit(conn, user, 'lancamento.segredo_revelado', lid, {'departamento': ex['departamento_id']})
            return self.send_json({'senhaSerial': seg})
        if method == 'GET':
            rows = conn.execute('SELECT * FROM launches ORDER BY id').fetchall()
            if not pode_ver_todos_deps(user):
                rows = [r for r in rows if r['departamento_id'] in deps_do_usuario(user)]
            return self.send_json({'launches': [launch_out(r, user, nomes) for r in rows]})
        if user['perfil'] not in ('admin', 'gestor'):
            raise ApiError(403, 'Somente Administrador ou Gestor(a) podem lançar manualmente.')
        if method == 'GET':
            raise ApiError(404, 'Rota não encontrada.')
        if method in ('POST', 'PUT'):
            d = dict(body.get('dados') or {})
            dep = body.get('departamentoId') or d.pop('departamentoId', None)
            if not dep:
                raise ApiError(400, 'Informe o departamento do lançamento.')
            if user['perfil'] != 'admin' and dep not in deps_do_usuario(user):
                raise ApiError(403, 'Você não gerencia este departamento.')
            d.pop('id', None)
            d.pop('solicitacaoId', None)
            try:
                ano = int(d.get('ano') or (d.get('dataCompra') or '')[:4] or dt.date.today().year)
            except (TypeError, ValueError):
                raise ApiError(400, 'Ano do lançamento inválido.')
            if not (2000 <= ano <= 2100):
                raise ApiError(400, 'Ano do lançamento inválido.')
            d['ano'] = ano
            d.pop('senhaSerialDefinida', None)
            d.pop('usuarioContaDefinida', None)
            d.pop('empresa', None)  # o texto livre antigo não é mais aceito: vale o cadastro (empresaId)
            limpar_senha = bool(d.pop('limparSenhaSerial', False))
            nf = d.get('numPedido'), d.get('notaFiscal')
            for ref in nf:  # anexos do tipo link/arquivo embutido só aceitam esquemas seguros
                if isinstance(ref, dict):
                    if ref.get('url') and not re.match(r'^https?://', str(ref['url']), re.I):
                        raise ApiError(400, 'Links de anexo devem começar com http:// ou https://.')
                    if ref.get('dataUrl') and not re.match(r'^data:(application/pdf|image/(png|jpeg));base64,', str(ref['dataUrl']), re.I):
                        raise ApiError(400, 'Arquivo embutido inválido.')
            exige_ano_aberto(conn, ano, 'lançamentos')
            if method == 'POST':
                validar_empresa(conn, d.get('empresaId'))
                d, _ = _cifrar_campos(d, CAMPOS_LANC_SECRETOS)
                cur = conn.execute('INSERT INTO launches(ano,departamento_id,solicitacao_id,dados,criado_em,criado_por) VALUES(?,?,?,?,?,?)',
                                   (ano, dep, None, j(d), now_iso(), user['id']))
                conn.commit()
                self.audit(conn, user, 'lancamento.criado', cur.lastrowid, {'departamento': dep, 'valor': d.get('custoTotal')})
                return self.send_json({'launch': launch_out(conn.execute('SELECT * FROM launches WHERE id=?', (cur.lastrowid,)).fetchone(), user, nomes)}, 201)
            lid = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            ex = conn.execute('SELECT * FROM launches WHERE id=?', (lid,)).fetchone()
            if not ex:
                raise ApiError(404, 'Lançamento não encontrado.')
            if user['perfil'] != 'admin' and ex['departamento_id'] not in deps_do_usuario(user):
                raise ApiError(403, 'Você não gerencia este departamento.')
            if ex['solicitacao_id'] and user['perfil'] != 'admin':
                raise ApiError(403, 'Lançamentos gerados por solicitação aprovada só podem ser alterados pelo Administrador.')
            exige_ano_aberto(conn, ex['ano'], 'lançamentos')
            antigo = pj(ex['dados'], {})
            if not d.get('empresaId') or d.get('empresaId') != antigo.get('empresaId'):
                validar_empresa(conn, d.get('empresaId'))  # manter a mesma empresa (mesmo inativa) é permitido
            if not d.get('senhaSerial') and not limpar_senha and antigo.get('senhaSerial'):
                d['senhaSerial'] = antigo['senhaSerial']  # em branco no formulário = manter a senha atual (já cifrada)
            d, _ = _cifrar_campos(d, CAMPOS_LANC_SECRETOS)
            conn.execute('UPDATE launches SET ano=?, departamento_id=?, dados=? WHERE id=?', (ano, dep, j(d), lid))
            conn.commit()
            self.audit(conn, user, 'lancamento.alterado', lid, {'departamento': dep, 'senhaAlterada': bool(d.get('senhaSerial')) and d.get('senhaSerial') != antigo.get('senhaSerial'), 'senhaRemovida': limpar_senha})
            return self.send_json({'launch': launch_out(conn.execute('SELECT * FROM launches WHERE id=?', (lid,)).fetchone(), user, mapa_empresas(conn))})
        if method == 'DELETE' and len(parts) == 2:
            lid = int(parts[1]) if parts[1].isdigit() else 0
            ex = conn.execute('SELECT * FROM launches WHERE id=?', (lid,)).fetchone()
            if not ex:
                raise ApiError(404, 'Lançamento não encontrado.')
            if user['perfil'] != 'admin' and ex['departamento_id'] not in deps_do_usuario(user):
                raise ApiError(403, 'Você não gerencia este departamento.')
            if ex['solicitacao_id'] and user['perfil'] != 'admin':
                raise ApiError(400, 'Lançamentos gerados por solicitação aprovada só podem ser excluídos pelo Administrador.')
            exige_ano_aberto(conn, ex['ano'], 'lançamentos')
            conn.execute('DELETE FROM launches WHERE id=?', (lid,))
            conn.commit()
            self.audit(conn, user, 'lancamento.excluido', lid, {'departamento': ex['departamento_id'], 'origemSolicitacao': ex['solicitacao_id']})
            return self.send_json({'ok': True})
        raise ApiError(404, 'Rota não encontrada.')

    # ---- arquivos
    def arquivo_permitido(self, conn, user, a):
        """Quem pode abrir o arquivo: quem enviou, perfis globais (admin/diretor/financeiro) ou quem enxerga
        a solicitação / o lançamento ao qual o arquivo está anexado."""
        if a['user_id'] == user['id'] or user['perfil'] in ('admin', 'diretor', 'financeiro'):
            return True
        marca = '%' + a['id'] + '%'
        for r in conn.execute('SELECT * FROM solicitacoes WHERE anexos LIKE ? OR doc_fiscal LIKE ?', (marca, marca)):
            if self.sol_visivel(conn, user, r):
                return True
        if user['perfil'] in ('gestor', 'colaborador', 'rh'):
            deps = deps_do_usuario(user)
            for r in conn.execute('SELECT departamento_id FROM launches WHERE dados LIKE ?', (marca,)):
                if r['departamento_id'] in deps:
                    return True
        return False

    def _recusa_upload(self, status, msg, restante=0):
        # descarta o que falta do corpo (até o limite) para o navegador receber a mensagem de erro em vez de "conexão reiniciada"
        try:
            while 0 < restante <= MAX_UPLOAD_MB * 1024 * 1024:
                chunk = self.rfile.read(min(65536, restante))
                if not chunk:
                    break
                restante -= len(chunk)
        except OSError:
            pass
        self.close_connection = True
        raise ApiError(status, msg)

    def api_files_upload(self, conn, user):
        """POST /api/files?nome=...  (corpo = bytes do arquivo). Lê em blocos para um arquivo temporário (memória constante),
        aplica cotas, confere assinatura/conteúdo/antivírus e só então publica."""
        lim = CONFIG.get('limites') or {}
        nome = os.path.basename(urllib.parse.unquote((self.query.get('nome') or ['arquivo'])[0]).replace('\\', '/')).strip()[:180] or 'arquivo'
        nome = re.sub(r'[\x00-\x1f\x7f]', '', nome)
        ext = os.path.splitext(nome)[1].lower()
        tipo = UPLOAD_TIPOS.get(ext)
        if not tipo:
            self._recusa_upload(400, 'Formato não permitido. Envie PDF, DOCX, XLSX, PNG ou JPEG.', int(self.headers.get('Content-Length') or 0))
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        if n <= 0:
            self._recusa_upload(400, 'Arquivo vazio ou tamanho não informado.')
        if n > MAX_UPLOAD_MB * 1024 * 1024:
            self._recusa_upload(413, 'Arquivo muito grande (máx. %d MB).' % MAX_UPLOAD_MB)
        # cotas
        hora = (dt.datetime.now() - dt.timedelta(hours=1)).replace(microsecond=0).isoformat()
        if conn.execute('SELECT COUNT(*) FROM arquivos WHERE user_id=? AND criado_em>?', (user['id'], hora)).fetchone()[0] >= int(lim.get('uploads_por_hora_usuario', 40)):
            self._recusa_upload(429, 'Limite de envios por hora atingido. Tente novamente mais tarde.', n)
        usado = conn.execute('SELECT COALESCE(SUM(tamanho),0) FROM arquivos WHERE user_id=?', (user['id'],)).fetchone()[0]
        if usado + n > int(lim.get('armazenamento_usuario_mb', 1024)) * 1024 * 1024:
            self._recusa_upload(413, 'Sua cota de armazenamento de anexos foi atingida. Fale com o Administrador.', n)
        total = conn.execute('SELECT COALESCE(SUM(tamanho),0) FROM arquivos').fetchone()[0]
        if total + n > int(lim.get('armazenamento_total_gb', 20)) * 1024 ** 3 or shutil.disk_usage(UPLOAD_DIR).free - n < int(lim.get('disco_livre_minimo_mb', 500)) * 1024 * 1024:
            self._recusa_upload(507, 'O armazenamento do sistema está cheio. Avise o Administrador.', n)
        tmp = os.path.join(UPLOAD_DIR, '.tmp_' + secrets.token_hex(8))
        h, restante, primeiro = hashlib.sha256(), n, True
        try:
            with open(tmp, 'wb') as f:
                while restante:
                    chunk = self.rfile.read(min(65536, restante))
                    if not chunk:
                        self._recusa_upload(400, 'Envio interrompido.')
                    if primeiro:
                        primeiro = False
                        if not any(chunk.startswith(sig) for sig in tipo[1]):  # confere o conteúdo real, não só o nome
                            self._recusa_upload(400, 'O conteúdo do arquivo não corresponde ao formato %s.' % ext, restante - len(chunk))
                    h.update(chunk)
                    f.write(chunk)
                    restante -= len(chunk)
            conteudo_seguro(tmp, ext)
            varrer_antivirus(tmp)
            fid = uid('f_')
            caminho = fid + ('.jpg' if ext == '.jpeg' else ext)
            os.replace(tmp, os.path.join(UPLOAD_DIR, caminho))
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        mime = tipo[0]  # o MIME vem da extensão validada, nunca do cliente
        conn.execute('INSERT INTO arquivos(id,nome,mime,tamanho,caminho,user_id,criado_em,sha256) VALUES(?,?,?,?,?,?,?,?)', (fid, nome, mime, n, caminho, user['id'], now_iso(), h.hexdigest()))
        conn.commit()
        self.audit(conn, user, 'arquivo.enviado', fid, {'nome': nome, 'tamanho': n})
        return self.send_json({'arquivo': {'id': fid, 'nome': nome, 'mime': mime, 'tamanho': n}}, 201)

    def api_files(self, conn, user, method, parts, body):
        if method == 'POST':
            return self.api_files_upload(conn, user)
        if method == 'GET' and len(parts) == 2:
            a = conn.execute('SELECT * FROM arquivos WHERE id=?', (parts[1],)).fetchone()
            if not a or not self.arquivo_permitido(conn, user, a):
                raise ApiError(404, 'Arquivo não encontrado.')
            caminho = os.path.join(UPLOAD_DIR, os.path.basename(a['caminho'] or ''))
            mime = mime_por_arquivo(a['caminho'])
            inline = mime in ('application/pdf', 'image/png', 'image/jpeg')
            return self.send_file(caminho, a['nome'], mime, forcar_download=not inline)
        raise ApiError(404, 'Rota não encontrada.')

    # ---- solicitações
    def sol_visivel(self, conn, user, r):
        return sol_visivel_para(conn, user, r)

    def api_solicitacoes(self, conn, user, method, parts, body):
        if method == 'GET' and len(parts) == 1 and user['perfil'] == 'tv':
            rows = conn.execute('SELECT * FROM solicitacoes ORDER BY id DESC').fetchall()
            return self.send_json({'solicitacoes': [sol_out_tv(r) for r in rows], 'trava': pendencias_doc_fiscal(conn, user['id'])})
        if method == 'GET' and len(parts) == 1:
            rows = [r for r in conn.execute('SELECT * FROM solicitacoes ORDER BY id DESC') if self.sol_visivel(conn, user, r)]
            conn.commit()
            nomes = mapa_empresas(conn)
            return self.send_json({'solicitacoes': [sol_out(conn, r, user=user, nomes=nomes) for r in rows], 'trava': pendencias_doc_fiscal(conn, user['id']),
                                   'travaFreelancer': bloqueio_freelancer(conn, user['id'])})
        if method == 'GET' and len(parts) == 2 and parts[1] == 'trava':
            return self.send_json(dict(pendencias_doc_fiscal(conn, user['id']), freelancer=bloqueio_freelancer(conn, user['id'])))
        if method == 'POST' and len(parts) == 1:
            return self.sol_criar(conn, user, body)
        sid = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None
        if sid is None:
            raise ApiError(404, 'Rota não encontrada.')
        r = conn.execute('SELECT * FROM solicitacoes WHERE id=?', (sid,)).fetchone()
        if not r or not self.sol_visivel(conn, user, r):
            raise ApiError(404, 'Solicitação não encontrada.')
        if method == 'GET' and len(parts) == 2:
            return self.send_json({'solicitacao': sol_out(conn, r, com_historico=True, user=user)})
        if method == 'GET' and len(parts) == 3 and parts[2] == 'recibo':
            if not r['recibo_arquivo']:
                raise ApiError(404, 'Recibo ainda não gerado.')
            return self.send_file(os.path.join(RECIBO_DIR, os.path.basename(r['recibo_arquivo'])), os.path.basename(r['recibo_arquivo']), 'application/pdf')
        if method == 'PUT' and len(parts) == 2:
            return self.sol_editar(conn, user, r, body)
        if method == 'DELETE' and len(parts) == 2:
            return self.sol_excluir(conn, user, r)
        if method == 'POST' and len(parts) == 3 and parts[2] == 'acao':
            return self.sol_acao(conn, user, r, body)
        if method == 'POST' and len(parts) == 3 and parts[2] == 'doc-fiscal':
            return self.sol_doc_fiscal(conn, user, r, body)
        if method == 'POST' and len(parts) == 4 and parts[2] == 'doc-fiscal' and parts[3] == 'remover':
            return self.sol_doc_fiscal_remover(conn, user, r, body)
        raise ApiError(404, 'Rota não encontrada.')

    def anexos_validos(self, conn, user, lista, manter=()):
        """Reconstrói os anexos a partir do registro no servidor (não confia em nome/tamanho vindos do cliente)."""
        ja = {a.get('id') for a in manter if isinstance(a, dict)}
        out = []
        for a in (lista or []):
            if not isinstance(a, dict) or not isinstance(a.get('id'), str):
                continue
            reg = conn.execute('SELECT * FROM arquivos WHERE id=?', (a['id'],)).fetchone()
            if not reg or (reg['user_id'] != user['id'] and a['id'] not in ja and user['perfil'] != 'admin'):
                raise ApiError(400, 'Anexo inválido ou não enviado por você.')
            out.append({'id': reg['id'], 'nome': reg['nome'], 'mime': reg['mime'], 'tamanho': reg['tamanho']})
        return out

    def checar_controles(self, conn, user, tipo, d, valor, dep, anexos, body, excluir_id=None):
        """Duplicidade exige confirmação explícita (409 → reenviar com confirmarDuplicidade); estouro de orçamento só
        avisa, a menos que controles.bloquear_estouro_orcamento esteja ligado."""
        alertas = avaliar_alertas(conn, tipo, d, valor, dep, anexos, excluir_id)
        dup = [a for a in alertas if a['tipo'] == 'duplicidade']
        if dup and not body.get('confirmarDuplicidade'):
            raise ApiError(409, 'Possível solicitação duplicada. Confira antes de enviar.', {'requerConfirmacao': True, 'duplicidades': dup})
        if (CONFIG.get('controles') or {}).get('bloquear_estouro_orcamento') and any(a.get('estouro') for a in alertas):
            raise ApiError(422, 'Esta solicitação ultrapassa o orçamento do departamento e o sistema está configurado para bloquear. Fale com o Administrador.',
                           {'alertas': [a['mensagem'] for a in alertas if a.get('estouro')]})
        for a in dup:
            a['confirmadaPor'] = user['nome']
        return alertas

    def sol_criar(self, conn, user, body):
        trava = pendencias_doc_fiscal(conn, user['id'])
        if trava['bloqueado']:
            raise ApiError(423, MSG_BLOQUEIO, {'trava': trava})
        if body.get('tipo') == 'freelancer':
            bf = bloqueio_freelancer(conn, user['id'])
            if bf['bloqueado']:
                raise ApiError(423, MSG_BLOQUEIO_FREELA, {'travaFreelancer': bf})
        tipo, d, valor, email, dep = validar_solicitacao(conn, user, body)
        d1, d2 = user['diretor1_id'], user['diretor2_id']
        if not d1 or not d2:
            raise ApiError(400, 'Seu perfil não tem Diretor(a) 1 e Diretor(a) 2 definidos. Peça ao Administrador para configurar seus aprovadores.')
        if user['id'] in (d1, d2):
            raise ApiError(400, 'Você não pode ser o próprio aprovador. Peça ao Administrador para definir outros Diretores no seu perfil.')
        for did in (d1, d2):
            if not conn.execute('SELECT 1 FROM users WHERE id=? AND ativo=1', (did,)).fetchone():
                raise ApiError(400, 'Um dos aprovadores definidos no seu perfil está inativo. Peça ao Administrador para revisar.')
        anexos = self.anexos_validos(conn, user, body.get('anexos'))
        alertas = self.checar_controles(conn, user, tipo, d, valor, dep, anexos, body)
        nf_doc = None
        if tipo == 'freelancer' and isinstance(body.get('nf'), dict) and body['nf'].get('id'):  # "Anexar NF" no próprio formulário (opcional na criação)
            reg = conn.execute('SELECT * FROM arquivos WHERE id=?', (body['nf']['id'],)).fetchone()
            if not reg or reg['user_id'] != user['id']:
                raise ApiError(400, 'Anexo da NF inválido ou não enviado por você.')
            nf_doc = {'id': reg['id'], 'nome': reg['nome'], 'mime': reg['mime'], 'tamanho': reg['tamanho'], 'anexadoEm': now_iso(), 'por': user['nome']}
        nome_sol = d.get('solicitante') or d.get('nome') or user['nome']
        for tentativa in range(6):  # número é UNIQUE: em caso de corrida entre dois pedidos, tenta o próximo
            numero = proximo_numero(conn)
            try:
                cur = conn.execute('''INSERT INTO solicitacoes(numero,tipo,status,retorno_para,solicitante_id,solicitante_nome,email,departamento_id,valor,data_pagamento,dados,anexos,aprovador1_id,aprovador2_id,criado_em,atualizado_em)
                                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                                   (numero, tipo, 'rh' if tipo == 'rescisao' else 'aprovacao1', None, user['id'], nome_sol, email, dep, valor, d.get('dataPagamento'), j(dados_cifrar(d)), j(anexos), d1, d2, now_iso(), now_iso()))
                break
            except sqlite3.IntegrityError:
                conn.rollback()
                if tentativa == 5:
                    raise ApiError(409, 'Não foi possível gerar o número da solicitação. Tente novamente.')
        sid = cur.lastrowid
        if nf_doc:
            conn.execute('UPDATE solicitacoes SET doc_fiscal=? WHERE id=?', (j(nf_doc), sid))
        conn.execute('UPDATE solicitacoes SET alertas=? WHERE id=?', (j(alertas), sid))
        add_hist(conn, sid, user, 'criada', ETAPA_RH if tipo == 'rescisao' else 1, None, {'alertas': [a['mensagem'] for a in alertas]} if alertas else None)
        conn.commit()
        self.audit(conn, user, 'solicitacao.criada', numero, {'tipo': tipo, 'valor': valor, 'departamento': dep,
                                                              'duplicidadeConfirmada': any(a['tipo'] == 'duplicidade' for a in alertas), 'estouroOrcamento': any(a.get('estouro') for a in alertas)})
        if tipo == 'rescisao':
            self.notificar_rh(conn, sid)
        else:
            self.notificar_aprovador(conn, sid, d1, 1)
        return self.send_json({'solicitacao': sol_out(conn, conn.execute('SELECT * FROM solicitacoes WHERE id=?', (sid,)).fetchone(), True)}, 201)

    def sol_editar(self, conn, user, r, body):
        if r['solicitante_id'] != user['id']:  # nem o Administrador altera valor/dados bancários de outra pessoa
            raise ApiError(403, 'Somente o solicitante pode alterar a solicitação.')
        if r['status'] != 'alteracao':
            raise ApiError(400, 'A solicitação só pode ser alterada quando um aprovador solicitar alteração.')
        body = dict(body)
        body['tipo'] = r['tipo']
        tipo, d, valor, email, dep = validar_solicitacao(conn, user, body)
        anexos = self.anexos_validos(conn, user, body.get('anexos'), manter=pj(r['anexos'], []))
        alertas = self.checar_controles(conn, user, tipo, d, valor, dep, anexos, body, excluir_id=r['id'])
        antigo = dados_decifrar(pj(r['dados'], {}))
        diff = {k: {'de': antigo.get(k), 'para': d.get(k)} for k in set(antigo) | set(d) if antigo.get(k) != d.get(k)}
        for k in CAMPOS_BANCARIOS:  # o histórico registra QUE o dado bancário mudou, nunca o valor
            if k in diff:
                diff[k] = {'de': MASCARA_BANCARIA, 'para': MASCARA_BANCARIA}
        if pj(r['anexos'], []) != anexos:
            diff['anexos'] = {'de': [a.get('nome') for a in pj(r['anexos'], [])], 'para': [a.get('nome') for a in anexos]}
        if CONFIG.get('reenvio_retorna_para_aprovacao1', True):
            novo_status = 'aprovacao1'
        else:
            novo_status = {2: 'aprovacao2', ETAPA_RH: 'rh'}.get(r['retorno_para'], 'aprovacao1')
        if tipo == 'rescisao' and novo_status == 'aprovacao1':  # o fluxo da Rescisão começa no RH 1
            novo_status = 'rh'
        conn.execute('UPDATE solicitacoes SET status=?, dados=?, anexos=?, valor=?, data_pagamento=?, email=?, departamento_id=?, solicitante_nome=?, atualizado_em=?, motivo_ultimo=NULL WHERE id=?',
                     (novo_status, j(dados_cifrar(d)), j(anexos), valor, d.get('dataPagamento'), email, dep, d.get('solicitante') or d.get('nome') or r['solicitante_nome'], now_iso(), r['id']))
        conn.execute('UPDATE solicitacoes SET alertas=? WHERE id=?', (j(alertas), r['id']))
        add_hist(conn, r['id'], user, 'editada', None, body.get('comentario') or None, diff)
        add_hist(conn, r['id'], user, 'reenviada', {'aprovacao1': 1, 'aprovacao2': 2, 'rh': ETAPA_RH}[novo_status])
        conn.commit()
        self.audit(conn, user, 'solicitacao.editada', r['numero'], {'campos': sorted(diff), 'valorDe': r['valor'], 'valorPara': valor})
        if novo_status == 'rh':
            self.notificar_rh(conn, r['id'])
        else:
            self.notificar_aprovador(conn, r['id'], r['aprovador1_id'] if novo_status == 'aprovacao1' else r['aprovador2_id'], 1 if novo_status == 'aprovacao1' else 2)
        return self.send_json({'solicitacao': sol_out(conn, conn.execute('SELECT * FROM solicitacoes WHERE id=?', (r['id'],)).fetchone(), True)})

    def sol_excluir(self, conn, user, r):
        if r['solicitante_id'] != user['id'] and user['perfil'] != 'admin':
            raise ApiError(403, 'Somente o solicitante pode excluir a solicitação.')
        # registro financeiro: depois da primeira aprovação (ou do encerramento) ninguém exclui, nem o Administrador
        ja_aprovada = conn.execute("SELECT 1 FROM historico WHERE solicitacao_id=? AND acao IN ('aprovada','encerrada')", (r['id'],)).fetchone()
        if ja_aprovada or r['status'] == 'encerrada':
            raise ApiError(400, 'A solicitação já foi aprovada e não pode ser excluída (registro financeiro preservado).')
        conn.execute('DELETE FROM historico WHERE solicitacao_id=?', (r['id'],))
        conn.execute('DELETE FROM solicitacoes WHERE id=?', (r['id'],))
        conn.commit()
        self.audit(conn, user, 'solicitacao.excluida', r['numero'], {'status': r['status'], 'valor': r['valor']})
        return self.send_json({'ok': True})

    def sol_acao(self, conn, user, r, body):
        acao = body.get('acao')
        just = (body.get('justificativa') or '').strip()
        status = r['status']
        if acao in ('alterar', 'reprovar') and len(just) < 5:
            raise ApiError(400, 'Justifique o motivo (mínimo de 5 caracteres).')

        def exige(cond, msg):
            if not cond:
                raise ApiError(403, msg)

        # o Administrador age em qualquer etapa (única restrição: não age em solicitação criada por ele mesmo)
        adm = user['perfil'] == 'admin'
        if status == 'aprovacao1':
            exige(adm or user['id'] == r['aprovador1_id'], 'Esta etapa cabe ao(à) Diretor(a) 1 desta solicitação.')
            etapa = 1
        elif status == 'aprovacao2':
            exige(adm or user['id'] == r['aprovador2_id'], 'Esta etapa cabe ao(à) Diretor(a) 2 desta solicitação.')
            etapa = 2
        elif status == 'rh':
            exige(adm or eh_rh1(user), 'Esta etapa cabe ao RH 1.')
            etapa = ETAPA_RH
        elif status == 'rh2':
            exige(adm or eh_rh2(user), 'O acompanhamento cabe ao RH 2.')
            etapa = ETAPA_RH2
        elif status == 'financeiro':
            exige(adm or user['perfil'] == 'financeiro', 'Esta etapa cabe ao Financeiro.')
            etapa = 3
        else:
            raise ApiError(400, 'A solicitação não está em uma etapa de aprovação (%s).' % STATUS_LABEL.get(status, status))

        if user['id'] == r['solicitante_id']:  # vale para todos os perfis, inclusive Administrador
            raise ApiError(403, 'Segregação de funções: você não pode aprovar, reprovar ou devolver uma solicitação criada por você.')
        if etapa == ETAPA_RH2 and acao not in ('encerrar', 'ajustar'):
            raise ApiError(400, 'No acompanhamento o RH 2 pode ajustar valor/data de término ou encerrar a solicitação.')
        if acao in ('aprovar', 'encerrar') and etapa in (3, ETAPA_RH2) and ano_fechado(conn, (r['data_pagamento'] or today_iso())[:4]):
            raise ApiError(400, 'O ano fiscal %s está fechado. Use "Alterar" para devolver a solicitação e corrigir a data de pagamento, ou peça ao Administrador para reabrir o ano.' % (r['data_pagamento'] or today_iso())[:4])
        if acao in ('aprovar', 'encerrar') and not pj(r['dados'], {}).get('empresaId'):
            raise ApiError(400, 'Esta solicitação não tem empresa informada. Use "Alterar" para devolvê-la ao solicitante.')
        rh_dados = validar_rh(body.get('rh'), user) if (acao == 'aprovar' and etapa == ETAPA_RH and r['tipo'] == 'freelancer') else None  # a aprovação do RH 1 sempre traz os dados da contratação
        nova_rec = None
        if rh_dados:
            nova_rec = (body.get('rh') or {}).get('recorrente') or pj(r['dados'], {}).get('recorrente')
            if nova_rec not in ('sim', 'nao'):
                raise ApiError(400, 'Informe se a contratação é recorrente.')
        if acao == 'ajustar':
            return self.sol_ajustar(conn, user, r, body, just)
        # trava otimista: só segue se o status ainda for o lido (evita aprovação/encerramento em duplicidade)
        if conn.execute('UPDATE solicitacoes SET atualizado_em=? WHERE id=? AND status=?', (now_iso(), r['id'], status)).rowcount != 1:
            raise ApiError(409, 'Esta solicitação foi alterada por outra pessoa. Atualize a página.')

        solic = conn.execute('SELECT * FROM users WHERE id=?', (r['solicitante_id'],)).fetchone()
        para = r['email'] or (solic['email'] if solic else None)
        resumo = self.resumo_email(conn, r)

        if acao == 'aprovar' and etapa in (1, 2, ETAPA_RH):
            if etapa == 1:
                novo = 'aprovacao2'
            elif etapa == 2:
                novo = 'rh' if r['tipo'] == 'freelancer' else 'financeiro'
            elif r['tipo'] == 'rescisao':
                novo = 'aprovacao1'   # Rescisão: RH 1 → Aprovador 1 → Aprovador 2 → Financeiro
            else:
                novo = 'rh2' if nova_rec == 'sim' else 'financeiro'   # Freelancer recorrente é acompanhado pelo RH 2, sem passar pelo Financeiro
            conn.execute('UPDATE solicitacoes SET status=?, atualizado_em=?, motivo_ultimo=NULL WHERE id=?', (novo, now_iso(), r['id']))
            det = rh_dados
            if rh_dados:
                dd = pj(r['dados'], {})
                if dd.get('recorrente') != nova_rec:
                    det = dict(rh_dados, recorrente={'de': dd.get('recorrente'), 'para': nova_rec})
                    dd['recorrente'] = nova_rec
                dd['rh'] = rh_dados
                conn.execute('UPDATE solicitacoes SET dados=? WHERE id=?', (j(dd), r['id']))
            add_hist(conn, r['id'], user, 'aprovada', etapa, just or None, det)
            antigos = [a for a in pj(r['alertas'], []) if a.get('tipo') == 'duplicidade']
            novos = _orcamento(conn, r['tipo'], pj(r['dados'], {}), r['valor'], r['departamento_id'], r['id'])
            conn.execute('UPDATE solicitacoes SET alertas=? WHERE id=?', (j(antigos + novos), r['id']))
            conn.commit()
            if etapa == 1:
                self.notificar_aprovador(conn, r['id'], r['aprovador2_id'], 2)
            elif novo == 'aprovacao1':
                self.notificar_aprovador(conn, r['id'], r['aprovador1_id'], 1)
            elif novo == 'rh2':
                if para:
                    enviar_email(para, 'NexarPay — Solicitação %s aprovada pelo RH' % r['numero'],
                                 'Sua solicitação de Freelancer recorrente foi aprovada pelo RH 1 e segue em acompanhamento pelo RH 2 até o fim do contrato.\n\n%s\n\nAtenciosamente\nNexarPay' % resumo)
                self.notificar_acompanhamento(conn, r['id'], 'Freelancer recorrente aprovado: o RH 2 acompanha o contrato até o fim, pode ajustar valor/data de término (com motivo e anexo) e encerrar.')
            elif novo == 'rh':
                if para:
                    enviar_email(para, 'NexarPay — Solicitação %s aprovada pela Diretoria' % r['numero'],
                                 'Sua solicitação de Freelancer foi aprovada pelas duas diretorias e agora aguarda o RH.\n\n%s\n\nAtenciosamente\nNexarPay' % resumo)
                self.notificar_rh(conn, r['id'])
            else:
                corpo = ('Sua Solicitação de Pagamento foi APROVADA, logo o setor de contas a pagar irá realizar o pagamento ou realizar as orientações.\n\n'
                         'Data da aprovação: %s\n\n%s\n\nAtenciosamente\nNexarPay' % (fmt_data_hora(now_iso()), resumo))
                if para:
                    enviar_email(para, 'NexarPay — Solicitação %s APROVADA' % r['numero'], corpo)
                for f in conn.execute("SELECT email FROM users WHERE perfil='financeiro' AND ativo=1"):
                    enviar_email(f['email'], 'NexarPay — Solicitação %s aguardando o Financeiro' % r['numero'],
                                 'A solicitação abaixo foi aprovada por todas as etapas e aguarda o encerramento pelo Financeiro.\n\n%s\n\nAcesse: %s\n\nAtenciosamente\nNexarPay' % (resumo, CONFIG.get('url_base')))
        elif acao in ('aprovar', 'encerrar') and etapa in (3, ETAPA_RH2):
            quem = 'pelo Financeiro' if etapa == 3 else 'pelo RH 2'
            agora = now_iso()
            if r['tipo'] == 'rescisao':
                prazo = None  # rescisão não tem documento fiscal a cobrar
            elif r['tipo'] == 'freelancer':
                prazo = pj(r['dados'], {}).get('dataFim') or today_iso()  # NF até o fim da contratação
            else:
                prazo = (dt.date.today() + dt.timedelta(days=PRAZO_DOC_FISCAL.get(r['tipo'], 3))).isoformat()
            conn.execute('UPDATE solicitacoes SET status=?, encerrado_em=?, prazo_doc_fiscal=?, atualizado_em=?, motivo_ultimo=NULL WHERE id=?', ('encerrada', agora, prazo, agora, r['id']))
            add_hist(conn, r['id'], user, 'encerrada', etapa, just or None)
            lid = self.criar_lancamento(conn, r)
            conn.execute('UPDATE solicitacoes SET lancamento_id=? WHERE id=?', (lid, r['id']))
            conn.commit()
            r2 = conn.execute('SELECT * FROM solicitacoes WHERE id=?', (r['id'],)).fetchone()
            try:
                recibo = gerar_recibo_pdf(conn, r2)
                conn.execute('UPDATE solicitacoes SET recibo_arquivo=? WHERE id=?', (recibo, r['id']))
                conn.commit()
            except Exception:
                traceback.print_exc()
                recibo = None
            doc = {'grupo': 'a Nota Fiscal ou Invoice', 'fornecedor': 'a Nota Fiscal ou Recibo Fiscal', 'reembolso': 'a Nota Fiscal, Cupom Fiscal ou Recibo', 'freelancer': 'a Nota Fiscal do serviço', 'rescisao': 'o documento fiscal'}[r['tipo']]
            if r['tipo'] == 'rescisao':
                corpo = ('A solicitação de Rescisão %s foi ENCERRADA pelo Financeiro e o pagamento está autorizado. O Recibo de Aprovação segue em anexo.\n\n%s\n\nAtenciosamente\nNexarPay') % (r['numero'], resumo)
            elif r['tipo'] == 'freelancer':
                corpo = ('Sua solicitação de Freelancer %s foi ENCERRADA %s e o pagamento está autorizado. O Recibo de Aprovação segue em anexo.\n\n%s\n\n'
                         'ATENÇÃO: anexe %s no sistema até o fim da contratação (%s). Depois dessa data, sem a NF, você fica bloqueado(a) de fazer novas solicitações de Freelancer. '
                         'O sistema envia um lembrete todos os dias às 9h enquanto a NF não for anexada.\n\nAtenciosamente\nNexarPay') % (r['numero'], quem, resumo, doc, fmt_data(prazo))
            else:
                corpo = ('Sua Solicitação de Pagamento %s foi ENCERRADA pelo Financeiro e o pagamento está autorizado. O Recibo de Aprovação segue em anexo.\n\n%s\n\n'
                         'ATENÇÃO: você tem %d dia(s) corrido(s) (até %s) para anexar %s no sistema. Após esse prazo, novas solicitações ficam bloqueadas.\n\n'
                         'Atenciosamente\nNexarPay') % (r['numero'], resumo, PRAZO_DOC_FISCAL.get(r['tipo'], 3), fmt_data(prazo), doc)
            if para:
                enviar_email(para, 'NexarPay — Pagamento autorizado — Recibo %s' % r['numero'], corpo, os.path.join(RECIBO_DIR, recibo) if recibo else None)
        elif acao == 'alterar' and etapa in (1, 2, ETAPA_RH):
            conn.execute('UPDATE solicitacoes SET status=?, retorno_para=?, atualizado_em=?, motivo_ultimo=? WHERE id=?', ('alteracao', etapa, now_iso(), just, r['id']))
            add_hist(conn, r['id'], user, 'alteracao_solicitada', etapa, just)
            conn.commit()
            if para:
                enviar_email(para, 'NexarPay — Solicitação %s requer atenção' % r['numero'],
                             'Sua Solicitação de Pagamento requer ATENÇÃO, verifique no sistema.\n\nMotivo informado por %s: %s\n\n%s\n\nAcesse: %s\n\nAtenciosamente\nNexarPay' % (user['nome'], just, resumo, CONFIG.get('url_base')))
        elif acao == 'reprovar':
            conn.execute('UPDATE solicitacoes SET status=?, encerrado_em=?, atualizado_em=?, motivo_ultimo=? WHERE id=?', ('reprovada', now_iso(), now_iso(), just, r['id']))
            add_hist(conn, r['id'], user, 'reprovada', etapa, just)
            conn.commit()
            if para:
                enviar_email(para, 'NexarPay — Solicitação %s REPROVADA' % r['numero'],
                             'Infelizmente Sua Solicitação de Pagamento foi REPROVADA, verifique no sistema.\n\nMotivo informado por %s: %s\n\n%s\n\nAtenciosamente\nNexarPay' % (user['nome'], just, resumo))
        else:
            raise ApiError(400, 'Ação inválida para esta etapa.')
        self.audit(conn, user, 'solicitacao.' + str(acao), r['numero'], {'etapa': etapa, 'de': status, 'valor': r['valor'], 'justificativa': just or None})
        return self.send_json({'solicitacao': sol_out(conn, conn.execute('SELECT * FROM solicitacoes WHERE id=?', (r['id'],)).fetchone(), True)})

    def sol_ajustar(self, conn, user, r, body, just):
        """RH 2 no acompanhamento do Freelancer recorrente: altera valor e/ou data de término — sempre com motivo e anexo."""
        if len(just) < 5:
            raise ApiError(400, 'Informe o motivo da alteração (mínimo de 5 caracteres).')
        if r['status'] != 'rh2':
            raise ApiError(400, 'O ajuste só vale durante o acompanhamento do RH 2.')
        dd = pj(r['dados'], {})
        try:
            valor = round(float(body.get('valor', r['valor'])), 2)
        except Exception:
            raise ApiError(400, 'Valor inválido.')
        if not (0 < valor <= MAX_VALOR):
            raise ApiError(400, 'O valor total deve ser maior que zero e menor que R$ 1 bilhão.')
        fim = parse_data_iso(body.get('dataFim')) or dd.get('dataFim')
        if not fim or fim < (dd.get('dataInicio') or ''):
            raise ApiError(400, 'A data de término não pode ser anterior à data de início.')
        if valor == r['valor'] and fim == dd.get('dataFim'):
            raise ApiError(400, 'Altere o valor e/ou a data de término.')
        novos = self.anexos_validos(conn, user, body.get('anexos'))
        if not novos:
            raise ApiError(400, 'Inclua ao menos um anexo que justifique a alteração.')
        exige_ano_aberto(conn, fim[:4], 'solicitações com data de pagamento neste ano')
        if conn.execute('UPDATE solicitacoes SET atualizado_em=? WHERE id=? AND status=?', (now_iso(), r['id'], 'rh2')).rowcount != 1:
            raise ApiError(409, 'Esta solicitação foi alterada por outra pessoa. Atualize a página.')
        diff = {}
        if valor != r['valor']:
            diff['valor'] = {'de': r['valor'], 'para': valor}
        if fim != dd.get('dataFim'):
            diff['dataFim'] = {'de': dd.get('dataFim'), 'para': fim}
        diff['anexos'] = [a['nome'] for a in novos]
        dd['dataFim'] = dd['dataPagamento'] = fim
        todos = pj(r['anexos'], [])
        todos += [a for a in novos if a['id'] not in {x.get('id') for x in todos}]
        conn.execute('UPDATE solicitacoes SET valor=?, data_pagamento=?, dados=?, anexos=?, atualizado_em=? WHERE id=?', (valor, fim, j(dd), j(todos), now_iso(), r['id']))
        novos_alertas = _orcamento(conn, r['tipo'], dd, valor, r['departamento_id'], r['id'])
        conn.execute('UPDATE solicitacoes SET alertas=? WHERE id=?', (j([a for a in pj(r['alertas'], []) if a.get('tipo') == 'duplicidade'] + novos_alertas), r['id']))
        add_hist(conn, r['id'], user, 'ajustada', ETAPA_RH2, just, diff)
        conn.commit()
        self.audit(conn, user, 'solicitacao.ajustada', r['numero'], {'valorDe': r['valor'], 'valorPara': valor, 'dataFimDe': diff.get('dataFim', {}).get('de'), 'dataFimPara': fim, 'justificativa': just})
        self.notificar_acompanhamento(conn, r['id'], 'O RH 2 ajustou o contrato: %s.\nMotivo: %s' % (
            '; '.join(x for x in ('valor de %s para %s' % (fmt_brl(r['valor']), fmt_brl(valor)) if 'valor' in diff else '',
                                  'término de %s para %s' % (fmt_data(dd and diff['dataFim']['de']), fmt_data(fim)) if 'dataFim' in diff else '') if x), just))
        return self.send_json({'solicitacao': sol_out(conn, conn.execute('SELECT * FROM solicitacoes WHERE id=?', (r['id'],)).fetchone(), True)})

    def sol_doc_fiscal(self, conn, user, r, body):
        if r['solicitante_id'] != user['id'] and user['perfil'] not in ('admin', 'gestor', 'financeiro'):
            raise ApiError(403, 'Somente o solicitante pode anexar o documento fiscal.')
        if r['status'] != 'encerrada':
            raise ApiError(400, 'O documento fiscal é anexado após o encerramento da solicitação.')
        arq = body.get('arquivo') or {}
        reg = conn.execute('SELECT * FROM arquivos WHERE id=?', (arq.get('id'),)).fetchone() if arq.get('id') else None
        if not reg or (reg['user_id'] != user['id'] and user['perfil'] not in ('admin', 'financeiro')):
            raise ApiError(400, 'Envie o arquivo primeiro.')
        arq = {'id': reg['id'], 'nome': reg['nome'], 'mime': reg['mime'], 'tamanho': reg['tamanho']}
        doc = {'id': arq['id'], 'nome': arq.get('nome'), 'mime': arq.get('mime'), 'tamanho': arq.get('tamanho'), 'anexadoEm': now_iso(), 'por': user['nome']}
        conn.execute('UPDATE solicitacoes SET doc_fiscal=?, atualizado_em=? WHERE id=?', (j(doc), now_iso(), r['id']))
        add_hist(conn, r['id'], user, 'doc_fiscal_anexado', None, None, {'nome': arq.get('nome')})
        if r['lancamento_id']:
            l = conn.execute('SELECT dados FROM launches WHERE id=?', (r['lancamento_id'],)).fetchone()
            if l:
                d = pj(l['dados'], {})
                d['notaFiscal'] = {'tipo': 'servidor', 'id': arq['id'], 'nome': arq.get('nome'), 'size': arq.get('tamanho')}
                conn.execute('UPDATE launches SET dados=? WHERE id=?', (j(d), r['lancamento_id']))
        conn.commit()
        self.audit(conn, user, 'solicitacao.doc_fiscal_anexado', r['numero'], {'arquivo': arq.get('nome')})
        return self.send_json({'solicitacao': sol_out(conn, conn.execute('SELECT * FROM solicitacoes WHERE id=?', (r['id'],)).fetchone(), True), 'trava': pendencias_doc_fiscal(conn, user['id'])})

    def sol_doc_fiscal_remover(self, conn, user, r, body):
        """O Financeiro pode excluir a NF de um Freelancer (erro ou tentativa de burla): o bloqueio volta a valer."""
        if user['perfil'] != 'financeiro':
            raise ApiError(403, 'Somente o Financeiro pode remover a Nota Fiscal anexada.')
        if r['tipo'] != 'freelancer':
            raise ApiError(400, 'A remoção da NF vale para solicitações de Freelancer.')
        if not r['doc_fiscal']:
            raise ApiError(400, 'Não há Nota Fiscal anexada nesta solicitação.')
        just = (body.get('justificativa') or '').strip()
        if len(just) < 5:
            raise ApiError(400, 'Justifique a remoção da NF (mínimo de 5 caracteres).')
        antigo = pj(r['doc_fiscal'], {})
        conn.execute('UPDATE solicitacoes SET doc_fiscal=NULL, atualizado_em=? WHERE id=?', (now_iso(), r['id']))
        add_hist(conn, r['id'], user, 'doc_fiscal_removido', None, just, {'nome': antigo.get('nome'), 'id': antigo.get('id')})
        if r['lancamento_id']:
            l = conn.execute('SELECT dados FROM launches WHERE id=?', (r['lancamento_id'],)).fetchone()
            if l:
                ld = pj(l['dados'], {})
                ld['notaFiscal'] = None
                conn.execute('UPDATE launches SET dados=? WHERE id=?', (j(ld), r['lancamento_id']))
        conn.commit()
        self.audit(conn, user, 'solicitacao.doc_fiscal_removido', r['numero'], {'arquivo': antigo.get('nome'), 'justificativa': just})
        if r['email']:
            enviar_email(r['email'], 'NexarPay — Nota Fiscal removida pelo Financeiro (%s)' % r['numero'],
                         'O Financeiro removeu a Nota Fiscal anexada à solicitação %s.\n\nMotivo: %s\n\nAnexe a NF correta no sistema. Enquanto não houver NF anexada e a contratação já tiver terminado, '
                         'novas solicitações de Freelancer ficam bloqueadas.\n\nAtenciosamente\nNexarPay' % (r['numero'], just))
        return self.send_json({'solicitacao': sol_out(conn, conn.execute('SELECT * FROM solicitacoes WHERE id=?', (r['id'],)).fetchone(), True)})

    def criar_lancamento(self, conn, r):
        """Solicitação encerrada vira um lançamento do departamento (abate do orçamento)."""
        d = pj(r['dados'], {})
        tipo = r['tipo']
        if tipo == 'grupo':
            categoria = d.get('categoria') or 'Cliente/Fornecedor'
        elif tipo == 'reembolso':
            categoria = d.get('categoriaDespesa') or 'Outro'
        elif tipo == 'freelancer':
            categoria = 'Freelancers'
        elif tipo == 'rescisao':
            categoria = 'Rescisões'
        else:
            categoria = 'Cliente/Fornecedor'
        props = pj(conn.execute("SELECT valor FROM properties WHERE chave='categorias'").fetchone()['valor'], [])
        if categoria not in props:
            props.append(categoria)
            conn.execute("UPDATE properties SET valor=? WHERE chave='categorias'", (j(props),))
        lanc = {
            'descricao': titulo_solicitacao(tipo, d),
            'quantidade': 1, 'categoria': categoria, 'fornecedor': d.get('fornecedor') or d.get('nomeFreelancer') or d.get('nome') or r['solicitante_nome'],
            'custoAquisicaoBRL': r['valor'], 'custoAquisicaoUSD': 0, 'custoTotal': r['valor'],
            'dataCompra': r['data_pagamento'] or today_iso(), 'ano': int((r['data_pagamento'] or today_iso())[:4]),
            'tipoCompra': 'Solicitação de Pagamento', 'dataVencimento': '', 'empresaId': d.get('empresaId'),
            'usadoPor': r['solicitante_nome'], 'setor': '', 'subsetor': '', 'usuarioConta': '', 'senhaSerial': '',
            'paraQueServe': d.get('descricao') or '', 'numPedido': {'tipo': 'recibo', 'solicitacaoId': r['id'], 'nome': 'Recibo ' + r['numero']},
            'notaFiscal': None, 'solicitacaoNumero': r['numero'], 'cliente': d.get('cliente') or '',
        }
        cur = conn.execute('INSERT INTO launches(ano,departamento_id,solicitacao_id,dados,criado_em,criado_por) VALUES(?,?,?,?,?,?)',
                           (lanc['ano'], r['departamento_id'], r['id'], j(lanc), now_iso(), 'solicitacao'))
        return cur.lastrowid

    def resumo_email(self, conn, r):
        d = pj(r['dados'], {})
        dep = conn.execute('SELECT nome FROM departamentos WHERE id=?', (r['departamento_id'],)).fetchone()
        linhas = ['Nº da solicitação: %s' % r['numero'], 'Tipo: %s' % TIPOS_SOLICITACAO.get(r['tipo']),
                  'Título: %s' % titulo_solicitacao(r['tipo'], d),
                  'Solicitante: %s' % r['solicitante_nome'], 'Departamento: %s' % (dep['nome'] if dep else '—'),
                  'Valor total: %s' % fmt_brl(r['valor']), 'Data do pagamento: %s' % fmt_data(r['data_pagamento']),
                  'Data da solicitação: %s' % fmt_data_hora(r['criado_em'])]
        if d.get('empresaId'):
            linhas.insert(5, 'Empresa: %s' % (mapa_empresas(conn).get(d['empresaId']) or '—'))
        if r['tipo'] == 'freelancer':
            linhas.append('Modalidade: %s · Recorrente: %s' % (MODALIDADES.get(d.get('modalidade'), '—'), 'Sim' if d.get('recorrente') == 'sim' else 'Não'))
            linhas.append('Período: %s a %s' % (fmt_data(d.get('dataInicio')), fmt_data(d.get('dataFim'))))
        if d.get('fornecedor'):
            linhas.append('Fornecedor: %s' % d['fornecedor'])
        if d.get('descricao'):
            linhas.append('Descrição: %s' % d['descricao'])
        return '\n'.join(linhas)

    def notificar_aprovador(self, conn, sid, aprovador_id, etapa):
        r = conn.execute('SELECT * FROM solicitacoes WHERE id=?', (sid,)).fetchone()
        a = conn.execute('SELECT * FROM users WHERE id=?', (aprovador_id,)).fetchone()
        if r and a:
            avisos = ''.join('\n⚠ ' + x['mensagem'] for x in pj(r['alertas'], []))
            enviar_email(a['email'], 'NexarPay — Solicitação %s aguarda sua aprovação (etapa %d)' % (r['numero'], etapa),
                         'Olá, %s.\n\nHá uma solicitação de pagamento aguardando sua análise (Aprovação %d).\n\n%s%s\n\nAcesse: %s\n\nAtenciosamente\nNexarPay' % (a['nome'], etapa, self.resumo_email(conn, r), ('\n\nALERTAS:' + avisos) if avisos else '', CONFIG.get('url_base')))

    def notificar_rh(self, conn, sid):
        r = conn.execute('SELECT * FROM solicitacoes WHERE id=?', (sid,)).fetchone()
        if not r:
            return
        if r['tipo'] == 'rescisao':
            texto = 'Há uma solicitação de Rescisão aguardando a sua análise (RH 1): aprovar, reprovar ou solicitar alteração.'
        else:
            texto = ('Há uma solicitação de Freelancer aguardando a sua análise (RH 1). Ao aprovar, você informará se o profissional foi contratado, '
                     'a data de contratação e a data prevista de onboarding, e pode alterar a opção Recorrente.')
        for u in conn.execute("SELECT * FROM users WHERE perfil='rh' AND rh1=1 AND ativo=1"):
            enviar_email(u['email'], 'NexarPay — Solicitação %s aguarda o RH 1' % r['numero'],
                         'Olá, %s.\n\n%s\n\n%s\n\nAcesse: %s\n\nAtenciosamente\nNexarPay' % (u['nome'], texto, self.resumo_email(conn, r), CONFIG.get('url_base')))

    def notificar_acompanhamento(self, conn, sid, texto):
        r = conn.execute('SELECT * FROM solicitacoes WHERE id=?', (sid,)).fetchone()
        if not r:
            return
        for u in conn.execute("SELECT * FROM users WHERE perfil='rh' AND (rh1=1 OR rh2=1) AND ativo=1"):
            enviar_email(u['email'], 'NexarPay — Freelancer recorrente %s' % r['numero'],
                         'Olá, %s.\n\n%s\n\n%s\n\nAcesse: %s\n\nAtenciosamente\nNexarPay' % (u['nome'], texto, self.resumo_email(conn, r), CONFIG.get('url_base')))

    # ---- backup
    def api_backup(self, conn, user, method, parts, body):
        self.require_user(conn, ['admin'])
        sub = parts[1] if len(parts) > 1 else ''
        if method == 'GET' and sub == '':
            self.exige_reauth(conn, user)
            payload = {
                'sistema': 'NexarPay', 'versao': 2, 'exportadoEm': now_iso(),
                'departamentos': [row_to_dict(r) for r in conn.execute('SELECT * FROM departamentos')],
                'empresas': [row_to_dict(r) for r in conn.execute('SELECT * FROM empresas')],
                'ajustes': {r['chave']: pj(r['valor'], None) for r in conn.execute("SELECT * FROM ajustes WHERE chave<>'smtp'")},
                'anos_fechados': [row_to_dict(r) for r in conn.execute('SELECT * FROM anos_fechados')],
                # sem credenciais: hash/salt de senha e de recuperação nunca saem do banco (na importação os hashes atuais são mantidos)
                'users': [{k: v for k, v in row_to_dict(r).items() if k not in CAMPOS_CREDENCIAL} for r in conn.execute('SELECT * FROM users')],
                'properties': {r['chave']: pj(r['valor'], []) for r in conn.execute('SELECT * FROM properties')},
                'budgets': [budget_out(r) for r in conn.execute('SELECT * FROM budgets')],
                'launches': [row_to_dict(r) for r in conn.execute('SELECT * FROM launches')],
                'solicitacoes': [row_to_dict(r) for r in conn.execute('SELECT * FROM solicitacoes')],
                'historico': [row_to_dict(r) for r in conn.execute('SELECT * FROM historico')],
                'arquivos': [row_to_dict(r) for r in conn.execute('SELECT * FROM arquivos')],
            }
            data = json.dumps(payload, ensure_ascii=False, indent=1).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Disposition', 'attachment; filename="backup-nexarpay-%s.json"' % today_iso())
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.security_headers()
            self.end_headers()
            self.wfile.write(data)
            self.audit(conn, user, 'backup.exportado', None, {'solicitacoes': len(payload['solicitacoes']), 'usuarios': len(payload['users'])})
            return
        if method == 'POST' and sub == 'import':
            self.exige_reauth(conn, user)
            data = body.get('backup') or {}
            if data.get('versao') == 2 and 'solicitacoes' in data:
                self.import_v2(conn, data)
            elif 'launches' in data and 'properties' in data:
                self.import_v1(conn, data)
            else:
                raise ApiError(400, 'Arquivo de backup inválido.')
            migrar_cifragem(conn)
            migrar_empresas(conn)
            conn.commit()
            self.audit(conn, user, 'backup.importado', None, {'versao': data.get('versao')})
            return self.send_json({'ok': True})
        if method == 'POST' and sub == 'reset':
            self.exige_reauth(conn, user)
            if not DEMO_MODE:
                raise ApiError(403, 'Restaurar o exemplo está desativado fora do modo demonstração.')
            for t in ('historico', 'solicitacoes', 'launches', 'budgets', 'properties', 'sessions', 'users', 'departamentos', 'arquivos', 'email_log', 'empresas', 'ajustes', 'anos_fechados', 'relatorios_filtros', 'relatorios_agenda'):
                conn.execute('DELETE FROM %s' % t)
            conn.commit()
            seed_db(conn)
            self.audit(conn, user, 'demo.reset', None, {'aviso': 'todos os dados foram apagados e recriados'})
            return self.send_json({'ok': True, 'relogar': True})
        raise ApiError(404, 'Rota não encontrada.')

    def import_v1(self, conn, data):
        """Backup do sistema antigo (só T.I.): lançamentos, cadastros e orçamento entram no departamento T.I."""
        dep = conn.execute("SELECT id FROM departamentos WHERE nome='T.I.'").fetchone()
        did = dep['id'] if dep else 'dep_ti'
        if not dep:
            conn.execute('INSERT INTO departamentos(id,nome,ativo) VALUES(?,?,1)', (did, 'T.I.'))
        conn.execute('DELETE FROM launches WHERE departamento_id=? AND solicitacao_id IS NULL', (did,))
        for l in data['launches']:
            l = dict(l)
            l.pop('id', None)
            conn.execute('INSERT INTO launches(ano,departamento_id,solicitacao_id,dados,criado_em,criado_por) VALUES(?,?,?,?,?,?)', (l.get('ano'), did, None, j(l), now_iso(), 'import'))
        atuais = {r['chave']: pj(r['valor'], []) for r in conn.execute('SELECT * FROM properties')}
        for k, v in data['properties'].items():
            merged = list(atuais.get(k, []))
            for item in v:
                if item not in merged:
                    merged.append(item)
            conn.execute('INSERT OR REPLACE INTO properties(chave,valor) VALUES(?,?)', (k, j(merged)))
        budgets = data.get('budgets') or ([data['budget']] if data.get('budget') else [])
        for b in budgets:
            conn.execute('DELETE FROM budgets WHERE ano=? AND departamento_id=?', (int(b.get('ano') or 2026), did))
            conn.execute('INSERT INTO budgets(id,ano,departamento_id,dolar,rateio,categorias) VALUES(?,?,?,?,?,?)',
                         (uid('bud_'), int(b.get('ano') or 2026), did, float(b.get('dolar') or 5.5), j(b.get('rateio') or {}), j(b.get('categorias') or [])))

    def import_v2(self, conn, data):
        def nome_seguro(n):
            return n is None or (isinstance(n, str) and n == os.path.basename(n) and n not in ('', '.', '..') and '\\' not in n)
        if not all(nome_seguro(a.get('caminho')) for a in data.get('arquivos', [])) or \
                not all(nome_seguro(sl.get('recibo_arquivo')) for sl in data.get('solicitacoes', [])):
            raise ApiError(400, 'Backup rejeitado: caminhos de arquivo inválidos.')
        # o backup não traz credenciais: preserva hash/salt atuais dos usuários que continuam existindo (por id ou e-mail)
        atuais, mfa_atuais = {}, {}
        for r in conn.execute('SELECT id,email,senha_hash,salt,mfa_secret,mfa_ativo,mfa_codes,mfa_ultimo_passo FROM users'):
            atuais[r['id']] = atuais[r['email']] = (r['senha_hash'], r['salt'])
            mfa_atuais[r['id']] = mfa_atuais[r['email']] = (r['mfa_secret'], r['mfa_ativo'], r['mfa_codes'], r['mfa_ultimo_passo'])
        smtp_atual = get_ajuste(conn, 'smtp', None)  # SMTP é da instalação, não do backup: sobrevive à importação
        for t in ('historico', 'solicitacoes', 'launches', 'budgets', 'properties', 'sessions', 'users', 'departamentos', 'arquivos', 'empresas', 'ajustes', 'anos_fechados'):
            conn.execute('DELETE FROM %s' % t)
        if smtp_atual:
            set_ajuste(conn, 'smtp', smtp_atual)
        for a in data.get('anos_fechados', []):
            conn.execute('INSERT INTO anos_fechados(ano,fechado_em,fechado_por) VALUES(?,?,?)', (a['ano'], a.get('fechado_em'), a.get('fechado_por')))
        for e in data.get('empresas', []):
            conn.execute('INSERT INTO empresas(id,nome,ativa,participa_rateio,rateio_padrao,ordem) VALUES(?,?,?,?,?,?)',
                         (e['id'], e['nome'], e.get('ativa', 1), e.get('participa_rateio', 1), e.get('rateio_padrao', 0), e.get('ordem', 0)))
        for k, v in (data.get('ajustes') or {}).items():
            set_ajuste(conn, k, v)
        for d in data.get('departamentos', []):
            conn.execute('INSERT INTO departamentos(id,nome,ativo) VALUES(?,?,?)', (d['id'], d['nome'], d.get('ativo', 1)))
        for u in data.get('users', []):
            m = mfa_atuais.get(u['id']) or mfa_atuais.get(u['email'])
            sh, sl = (u.get('senha_hash'), u.get('salt')) if u.get('senha_hash') and u.get('salt') else atuais.get(u['id']) or atuais.get(u['email']) or (None, None)
            conn.execute('INSERT INTO users(id,nome,email,senha_hash,salt,perfil,departamentos,diretor1_id,diretor2_id,ativo,senha_provisoria,criado_em,ultimo_login,rh1,rh2) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                         (u['id'], u['nome'], u['email'], sh, sl, u['perfil'], u.get('departamentos') or '[]', u.get('diretor1_id'), u.get('diretor2_id'), u.get('ativo', 1), u.get('senha_provisoria', 0), u.get('criado_em'), u.get('ultimo_login'), u.get('rh1') or 0, u.get('rh2') or 0))
            if m:  # o backup não traz o 2º fator: mantém o que o usuário já tinha cadastrado
                conn.execute('UPDATE users SET mfa_secret=?, mfa_ativo=?, mfa_codes=?, mfa_ultimo_passo=? WHERE id=?', tuple(m) + (u['id'],))
        for k, v in (data.get('properties') or {}).items():
            conn.execute('INSERT INTO properties(chave,valor) VALUES(?,?)', (k, j(v)))
        for b in data.get('budgets', []):
            conn.execute('INSERT INTO budgets(id,ano,departamento_id,dolar,rateio,categorias) VALUES(?,?,?,?,?,?)', (b['id'], b['ano'], b['departamentoId'], b.get('dolar') or 5.5, j(b.get('rateio') or {}), j(b.get('categorias') or [])))
        for l in data.get('launches', []):
            conn.execute('INSERT INTO launches(id,ano,departamento_id,solicitacao_id,dados,criado_em,criado_por) VALUES(?,?,?,?,?,?,?)', (l['id'], l.get('ano'), l.get('departamento_id'), l.get('solicitacao_id'), l['dados'], l.get('criado_em'), l.get('criado_por')))
        cols_s = ['id', 'numero', 'tipo', 'status', 'retorno_para', 'solicitante_id', 'solicitante_nome', 'email', 'departamento_id', 'valor', 'data_pagamento', 'dados', 'anexos', 'aprovador1_id', 'aprovador2_id', 'criado_em', 'atualizado_em', 'encerrado_em', 'prazo_doc_fiscal', 'doc_fiscal', 'lancamento_id', 'recibo_arquivo', 'motivo_ultimo']
        for s in data.get('solicitacoes', []):
            conn.execute('INSERT INTO solicitacoes(%s) VALUES(%s)' % (','.join(cols_s), ','.join('?' * len(cols_s))), [s.get(c) for c in cols_s])
        for h in data.get('historico', []):
            conn.execute('INSERT INTO historico(id,solicitacao_id,data,user_id,user_nome,acao,etapa,justificativa,detalhes) VALUES(?,?,?,?,?,?,?,?,?)',
                         (h['id'], h['solicitacao_id'], h.get('data'), h.get('user_id'), h.get('user_nome'), h['acao'], h.get('etapa'), h.get('justificativa'), h.get('detalhes')))
        for a in data.get('arquivos', []):
            conn.execute('INSERT INTO arquivos(id,nome,mime,tamanho,caminho,user_id,criado_em,sha256) VALUES(?,?,?,?,?,?,?,?)', (a['id'], a.get('nome'), a.get('mime'), a.get('tamanho'), a.get('caminho'), a.get('user_id'), a.get('criado_em'), a.get('sha256')))

    # ---- relatórios
    def _f_query(self):
        try:
            f = json.loads((self.query.get('f') or ['{}'])[0][:4000])
        except ValueError:
            raise ApiError(400, 'Filtros inválidos.')
        if not isinstance(f, dict):
            raise ApiError(400, 'Filtros inválidos.')
        cols = [c for c in ((self.query.get('c') or [''])[0]).split(',') if c] or None
        return f, cols

    def api_relatorios(self, conn, user, method, parts, body):
        if user['perfil'] not in ROLES_RELATORIOS:
            raise ApiError(403, 'Seu perfil não emite relatórios.')  # colaborador e Dashboard (TV) não têm relatórios
        sub = parts[1] if len(parts) > 1 else ''
        if method == 'GET' and sub == '':
            cfg = get_ajuste(conn, 'relatorios', {}) or {}
            cat = [{'id': rid, 'titulo': r['titulo'], 'descricao': r['descricao'], 'publico': r['publico'], 'filtros': [_controle_filtro(conn, user, n) for n in r['filtros']],
                    'colunas': r['colunas'], 'colunasPadrao': colunas_padrao_cliente(conn, rid), 'personalizado': bool((cfg.get(rid) or {}).get('colunas'))} for rid, r in REL.items()]
            salvos = [{'id': x['id'], 'relatorio': x['relatorio'], 'nome': x['nome'], 'filtros': pj(x['filtros'], {}), 'colunas': pj(x['colunas'], None)}
                      for x in conn.execute('SELECT * FROM relatorios_filtros WHERE user_id=? ORDER BY nome', (user['id'],))]
            agenda = [{'id': x['id'], 'relatorio': x['relatorio'], 'titulo': REL.get(x['relatorio'], {}).get('titulo', x['relatorio']), 'filtros': pj(x['filtros'], {}), 'formatos': pj(x['formatos'], []),
                       'dia': x['dia'], 'destinatarios': pj(x['destinatarios'], []), 'ultimoEnvio': x['ultimo_envio']} for x in conn.execute('SELECT * FROM relatorios_agenda WHERE user_id=? AND ativo=1 ORDER BY id', (user['id'],))]
            return self.send_json({'relatorios': cat, 'filtrosSalvos': salvos, 'agendamentos': agenda, 'podeConfigurar': user['perfil'] == 'admin'})
        if sub == '_filtros':
            if method == 'POST':
                rid, nome = str(body.get('relatorio') or ''), str(body.get('nome') or '').strip()[:60]
                if rid not in REL or not nome:
                    raise ApiError(400, 'Informe o relatório e um nome para o filtro.')
                f = body.get('filtros') if isinstance(body.get('filtros'), dict) else {}
                gerar_relatorio(conn, user, rid, f, body.get('colunas') or None, limite=1)  # valida antes de salvar
                if conn.execute('SELECT COUNT(*) FROM relatorios_filtros WHERE user_id=?', (user['id'],)).fetchone()[0] >= 40:
                    raise ApiError(400, 'Limite de 40 filtros salvos. Exclua algum antes.')
                conn.execute('DELETE FROM relatorios_filtros WHERE user_id=? AND relatorio=? AND nome=?', (user['id'], rid, nome))
                cur = conn.execute('INSERT INTO relatorios_filtros(user_id,relatorio,nome,filtros,colunas,criado_em) VALUES(?,?,?,?,?,?)', (user['id'], rid, nome, j(f), j(body.get('colunas') or None), now_iso()))
                conn.commit()
                return self.send_json({'id': cur.lastrowid}, 201)
            if method == 'DELETE' and len(parts) == 3 and parts[2].isdigit():
                conn.execute('DELETE FROM relatorios_filtros WHERE id=? AND user_id=?', (int(parts[2]), user['id']))
                conn.commit()
                return self.send_json({'ok': True})
        if sub == '_agenda':
            if method == 'POST':
                rid = str(body.get('relatorio') or '')
                f = body.get('filtros') if isinstance(body.get('filtros'), dict) else {}
                formatos = [x for x in (body.get('formatos') or ['xlsx', 'pdf']) if x in ('xlsx', 'pdf')]
                try:
                    dia = int(body.get('dia'))
                except (TypeError, ValueError):
                    dia = 0
                extras = [str(e).strip().lower() for e in (body.get('destinatarios') or []) if str(e).strip()][:5]
                if rid not in REL or not formatos or not (1 <= dia <= 28):
                    raise ApiError(400, 'Escolha o relatório, os formatos e o dia do mês (de 1 a 28).')
                if any(not email_valido_dominio(e) for e in extras):
                    raise ApiError(400, 'Os destinatários extras devem ser e-mails do domínio da empresa.')
                gerar_relatorio(conn, user, rid, f, body.get('colunas') or None, limite=1)
                if conn.execute('SELECT COUNT(*) FROM relatorios_agenda WHERE user_id=? AND ativo=1', (user['id'],)).fetchone()[0] >= 10:
                    raise ApiError(400, 'Limite de 10 envios agendados. Exclua algum antes.')
                cur = conn.execute('INSERT INTO relatorios_agenda(user_id,relatorio,filtros,colunas,formatos,dia,destinatarios,criado_em) VALUES(?,?,?,?,?,?,?,?)',
                                   (user['id'], rid, j(f), j(body.get('colunas') or None), j(formatos), dia, j(extras), now_iso()))
                conn.commit()
                self.audit(conn, user, 'relatorio.agendado', rid, {'dia': dia, 'formatos': formatos, 'extras': extras})
                return self.send_json({'id': cur.lastrowid}, 201)
            if method == 'DELETE' and len(parts) == 3 and parts[2].isdigit():
                conn.execute('UPDATE relatorios_agenda SET ativo=0 WHERE id=? AND user_id=?', (int(parts[2]), user['id']))
                conn.commit()
                self.audit(conn, user, 'relatorio.agendamento_removido', parts[2])
                return self.send_json({'ok': True})
        if sub == '_config' and method == 'PUT':  # colunas padrão do cliente (todos os usuários partem delas)
            self.require_user(conn, ['admin'])
            rid = str(body.get('relatorio') or '')
            if rid not in REL:
                raise ApiError(404, 'Relatório não encontrado.')
            cfg = get_ajuste(conn, 'relatorios', {}) or {}
            cols = body.get('colunas')
            if cols is None:
                cfg.pop(rid, None)
            else:
                ids = {c['id'] for c in REL[rid]['colunas']}
                if not isinstance(cols, list) or not cols or any(c not in ids for c in cols):
                    raise ApiError(400, 'Escolha ao menos uma coluna válida.')
                cfg[rid] = {'colunas': cols}
            set_ajuste(conn, 'relatorios', cfg)
            conn.commit()
            self.audit(conn, user, 'relatorio.colunas_padrao', rid, {'colunas': cols})
            return self.send_json({'ok': True, 'colunasPadrao': colunas_padrao_cliente(conn, rid)})
        if sub in REL:
            rid = sub
            if method == 'GET' and len(parts) == 2:
                f, cols = self._f_query()
                return self.send_json(gerar_relatorio(conn, user, rid, f, cols))
            if method == 'GET' and len(parts) == 3 and parts[2] == 'exportar':
                f, cols = self._f_query()
                formato = (self.query.get('formato') or ['xlsx'])[0]
                out = gerar_relatorio(conn, user, rid, f, cols, limite=None)
                dados, mime, nome = arquivo_relatorio(formato, out)
                self.audit(conn, user, 'relatorio.exportado', rid, {'formato': formato, 'registros': out['total'], 'filtros': f})
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(dados)))
                self.send_header('Content-Disposition', 'attachment; filename="%s"' % nome)
                self.send_header('Cache-Control', 'private, no-store')
                self.security_headers()
                self.end_headers()
                self.wfile.write(dados)
                return
            if method == 'POST' and len(parts) == 3 and parts[2] == 'enviar':
                hora = (dt.datetime.now() - dt.timedelta(hours=1)).replace(microsecond=0).isoformat()
                if conn.execute("SELECT COUNT(*) FROM auditoria WHERE user_id=? AND acao='relatorio.enviado' AND data>?", (user['id'], hora)).fetchone()[0] >= 10:
                    raise ApiError(429, 'Limite de 10 envios de relatório por hora. Tente mais tarde.')
                extras = [str(e).strip().lower() for e in (body.get('destinatarios') or []) if str(e).strip()][:5]
                if any(not email_valido_dominio(e) for e in extras):
                    raise ApiError(400, 'Os destinatários extras devem ser e-mails do domínio da empresa.')
                f = body.get('filtros') if isinstance(body.get('filtros'), dict) else {}
                res = enviar_relatorio(conn, user, rid, f, body.get('colunas') or None, body.get('formatos'), extras)
                self.audit(conn, user, 'relatorio.enviado', rid, {'destinatarios': res['destinatarios'], 'registros': res['registros'], 'filtros': f})
                return self.send_json(dict(res, ok=True))
        raise ApiError(404, 'Rota não encontrada.')

    # ---- anos fiscais (fechamento)
    def api_anos(self, conn, user, method, parts, body):
        if method == 'GET':
            self.require_user(conn, ['admin', 'diretor', 'financeiro'])
            anos = {r[0] for r in conn.execute('SELECT ano FROM budgets UNION SELECT ano FROM launches UNION SELECT ano FROM anos_fechados') if r[0]}
            anos.add(dt.date.today().year)
            fechados = {r['ano']: r for r in conn.execute('SELECT * FROM anos_fechados')}
            out = []
            for a in sorted(anos, reverse=True):
                e = estatisticas_ano(conn, a)
                e.update({'fechado': a in fechados, 'fechadoEm': fechados[a]['fechado_em'] if a in fechados else None, 'fechadoPor': fechados[a]['fechado_por'] if a in fechados else None})
                out.append(e)
            return self.send_json({'anos': out})
        self.require_user(conn, ['admin'])
        if method == 'POST' and len(parts) == 3 and parts[1].isdigit() and parts[2] in ('fechar', 'reabrir'):
            ano = int(parts[1])
            if not (2000 <= ano <= 2100):
                raise ApiError(400, 'Ano inválido.')
            self.exige_reauth(conn, user)
            if parts[2] == 'fechar':
                if not body.get('confirmar'):
                    raise ApiError(400, 'Confirme o fechamento do ano.')
                if ano_fechado(conn, ano):
                    raise ApiError(400, 'Este ano já está fechado.')
                conn.execute('INSERT INTO anos_fechados(ano,fechado_em,fechado_por) VALUES(?,?,?)', (ano, now_iso(), user['email']))
                conn.commit()
                self.audit(conn, user, 'ano.fechado', ano, estatisticas_ano(conn, ano))
            else:
                just = str(body.get('justificativa') or '').strip()
                if len(just) < 5:
                    raise ApiError(400, 'Informe a justificativa da reabertura (mínimo de 5 caracteres).')
                if not ano_fechado(conn, ano):
                    raise ApiError(400, 'Este ano não está fechado.')
                conn.execute('DELETE FROM anos_fechados WHERE ano=?', (ano,))
                conn.commit()
                self.audit(conn, user, 'ano.reaberto', ano, {'justificativa': just})
            return self.send_json({'ok': True, 'anosFechados': [r['ano'] for r in conn.execute('SELECT ano FROM anos_fechados ORDER BY ano')]})
        raise ApiError(404, 'Rota não encontrada.')

    # ---- empresas
    def _empresa_em_uso(self, conn, eid):
        marca = '%"empresaId": "' + eid + '"%'
        if conn.execute('SELECT 1 FROM launches WHERE dados LIKE ?', (marca,)).fetchone() or conn.execute('SELECT 1 FROM solicitacoes WHERE dados LIKE ?', (marca,)).fetchone():
            return True
        return any((pj(b['rateio'], {}) or {}).get(eid) for b in conn.execute('SELECT rateio FROM budgets'))

    def api_empresas(self, conn, user, method, parts, body):
        if method == 'GET':
            out = {'empresas': empresas_lista(conn), 'grupoNome': grupo_nome(conn)}
            if user['perfil'] == 'admin':
                out['pendencias'] = pendencias_empresa(conn)
            return self.send_json(out)
        self.require_user(conn, ['admin'])
        if method == 'PUT' and parts[1:] == ['grupo']:
            nome = str(body.get('nome') or '').strip()[:80]
            if not nome:
                raise ApiError(400, 'Informe o nome do grupo.')
            set_ajuste(conn, 'grupoNome', nome)
            conn.commit()
            self.audit(conn, user, 'empresas.grupo_renomeado', None, {'nome': nome})
            return self.send_json({'ok': True, 'grupoNome': nome})
        if method in ('POST', 'PUT') and (method == 'POST' or len(parts) == 2):
            existente = conn.execute('SELECT * FROM empresas WHERE id=?', (parts[1],)).fetchone() if method == 'PUT' else None
            if method == 'PUT' and not existente:
                raise ApiError(404, 'Empresa não encontrada.')
            nome = str(body.get('nome') or '').strip()[:80]
            if not nome:
                raise ApiError(400, 'Informe o nome da empresa.')
            if _sem_acento(nome) == _sem_acento(grupo_nome(conn)):
                raise ApiError(400, 'O nome da empresa não pode ser igual ao nome do grupo.')
            if conn.execute('SELECT 1 FROM empresas WHERE lower(nome)=lower(?) AND id<>?', (nome, existente['id'] if existente else '')).fetchone():
                raise ApiError(400, 'Já existe uma empresa com esse nome.')
            try:
                pct = float(body.get('rateioPadrao') or 0)
            except (TypeError, ValueError):
                raise ApiError(400, 'Percentual padrão inválido.')
            if not (0 <= pct <= 100):
                raise ApiError(400, 'O percentual padrão deve estar entre 0 e 100.')
            participa = 1 if body.get('participaRateio', True) else 0
            ativa = 1 if body.get('ativa', True) else 0
            if existente:
                conn.execute('UPDATE empresas SET nome=?, ativa=?, participa_rateio=?, rateio_padrao=? WHERE id=?', (nome, ativa, participa, pct / 100.0, existente['id']))
                conn.commit()
                self.audit(conn, user, 'empresa.alterada', existente['id'], {'de': empresa_out(existente), 'para': {'nome': nome, 'ativa': bool(ativa), 'participaRateio': bool(participa), 'rateioPadrao': pct}})
                return self.send_json({'empresa': empresa_out(conn.execute('SELECT * FROM empresas WHERE id=?', (existente['id'],)).fetchone())})
            eid = uid('emp_')
            ordem = (conn.execute('SELECT COALESCE(MAX(ordem),-1) FROM empresas').fetchone()[0]) + 1
            conn.execute('INSERT INTO empresas(id,nome,ativa,participa_rateio,rateio_padrao,ordem) VALUES(?,?,?,?,?,?)', (eid, nome, ativa, participa, pct / 100.0, ordem))
            conn.commit()
            self.audit(conn, user, 'empresa.criada', eid, {'nome': nome, 'participaRateio': bool(participa), 'rateioPadrao': pct})
            return self.send_json({'empresa': empresa_out(conn.execute('SELECT * FROM empresas WHERE id=?', (eid,)).fetchone())}, 201)
        if method == 'DELETE' and len(parts) == 2:
            e = conn.execute('SELECT * FROM empresas WHERE id=?', (parts[1],)).fetchone()
            if not e:
                raise ApiError(404, 'Empresa não encontrada.')
            if self._empresa_em_uso(conn, e['id']):
                raise ApiError(400, 'Esta empresa já tem lançamentos, solicitações ou rateio. Desative-a em vez de excluir.')
            conn.execute('DELETE FROM empresas WHERE id=?', (e['id'],))
            conn.commit()
            self.audit(conn, user, 'empresa.excluida', e['id'], {'nome': e['nome']})
            return self.send_json({'ok': True})
        raise ApiError(404, 'Rota não encontrada.')

    # ---- trilha de auditoria (somente leitura, admin)
    def api_auditoria(self, conn, user, method, parts):
        self.require_user(conn, ['admin'])
        if method != 'GET':
            raise ApiError(405, 'A trilha de auditoria é somente de leitura.')
        if len(parts) > 1 and parts[1] == 'verificar':
            return self.send_json(verificar_auditoria(conn))
        try:
            limite = max(1, min(int((self.query.get('limite') or ['200'])[0]), 1000))
        except ValueError:
            limite = 200
        filtros, args = [], []
        for campo, col in (('acao', 'acao'), ('usuario', 'user_email')):
            v = (self.query.get(campo) or [''])[0].strip()
            if v:
                filtros.append('%s LIKE ?' % col)
                args.append('%' + v + '%')
        where = (' WHERE ' + ' AND '.join(filtros)) if filtros else ''
        rows = conn.execute('SELECT id,data,user_email,ip,acao,alvo,detalhes FROM auditoria%s ORDER BY id DESC LIMIT ?' % where, args + [limite]).fetchall()
        return self.send_json({'auditoria': [dict(row_to_dict(r), detalhes=pj(r['detalhes'], None)) for r in rows]})

    # ---- e-mail (admin)
    def api_email(self, conn, user, method, parts, body):
        self.require_user(conn, ['admin'])
        sub = parts[1] if len(parts) > 1 else ''
        if method == 'GET' and sub == 'log':
            rows = conn.execute('SELECT id,data,para,assunto,status,erro,anexo FROM email_log ORDER BY id DESC LIMIT 100').fetchall()
            return self.send_json({'log': [row_to_dict(r) for r in rows], 'modo': (CONFIG.get('email') or {}).get('modo')})
        if method == 'GET' and sub == 'ver' and len(parts) > 2:
            r = conn.execute('SELECT * FROM email_log WHERE id=?', (int(parts[2]),)).fetchone()
            return self.send_json({'email': row_to_dict(r)})
        if sub == 'config' and method == 'GET':
            e = CONFIG['email']
            return self.send_json({'config': {'modo': e.get('modo', 'simulado'), 'host': e.get('host') or '', 'porta': int(e.get('porta') or 465),
                                              'ssl': bool(e.get('ssl', True)), 'usuario': e.get('usuario') or '', 'remetente': e.get('remetente') or '',
                                              'senhaDefinida': bool(e.get('senha')) and not str(e.get('senha')).startswith('COLOQUE'),
                                              'origem': e.get('_origem') or ('ambiente' if os.environ.get('NEXARPAY_SMTP_HOST') else 'arquivo')}})
        if sub == 'config' and method == 'PUT':
            self.exige_reauth(conn, user)
            modo = 'smtp' if body.get('modo') == 'smtp' else 'simulado'
            host = str(body.get('host') or '').strip()[:200]
            usuario = str(body.get('usuario') or '').strip()[:200]
            remetente = str(body.get('remetente') or '').strip()[:300]
            try:
                porta = int(body.get('porta') or 0)
            except (TypeError, ValueError):
                porta = 0
            if modo == 'smtp':
                if not re.fullmatch(r'[A-Za-z0-9.-]{1,200}', host):
                    raise ApiError(400, 'Servidor SMTP inválido (informe só o nome, ex.: smtp.office365.com).')
                if not 1 <= porta <= 65535:
                    raise ApiError(400, 'Porta inválida.')
                if '\n' in remetente or '\r' in remetente or '\n' in usuario or '\r' in usuario:
                    raise ApiError(400, 'Valor inválido.')
            atual = get_ajuste(conn, 'smtp', {}) or {}
            nova = str(body.get('senha') or '')
            sen_atual = CONFIG['email'].get('senha')
            senha_cif = cifrar(nova) if nova else (atual.get('senha') or (cifrar(sen_atual) if sen_atual and not str(sen_atual).startswith('COLOQUE') else ''))
            set_ajuste(conn, 'smtp', {'modo': modo, 'host': host, 'porta': porta, 'ssl': bool(body.get('ssl')), 'usuario': usuario,
                                      'remetente': remetente or usuario, 'senha': senha_cif})
            conn.commit()
            aplicar_smtp_db(conn)
            self.audit(conn, user, 'email.config_alterada', 'smtp', {'modo': modo, 'host': host, 'porta': porta, 'ssl': bool(body.get('ssl')), 'usuario': usuario, 'senhaAlterada': bool(nova)})
            return self.send_json({'ok': True})
        if method == 'POST' and sub == 'teste':
            para = (body.get('para') or user['email']).strip()
            enviar_email(para, 'NexarPay — Teste de envio', 'Este é um e-mail de teste enviado pelo NexarPay em %s.\n\nAtenciosamente\nNexarPay' % fmt_data_hora(now_iso()), sincrono=True)
            r = conn.execute('SELECT status,erro FROM email_log ORDER BY id DESC LIMIT 1').fetchone()
            return self.send_json({'status': r['status'], 'erro': r['erro'], 'modo': (CONFIG.get('email') or {}).get('modo')})
        raise ApiError(404, 'Rota não encontrada.')


# ============================================================ main
class ServidorLimitado(ThreadingHTTPServer):
    """Teto de conexões simultâneas: acima dele a conexão é fechada na hora (evita esgotar threads/memória com conexões lentas)."""
    request_queue_size = 128

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self._ativas, self._trava = set(), threading.Lock()
        self.max_conexoes = int((CONFIG.get('limites') or {}).get('max_conexoes', 150))

    def verify_request(self, request, client_address):
        with self._trava:
            if len(self._ativas) >= self.max_conexoes:
                return False
            self._ativas.add(id(request))
            return True

    def shutdown_request(self, request):
        with self._trava:
            self._ativas.discard(id(request))
        super().shutdown_request(request)


def main():
    init_db()
    _c = db()
    try:
        aplicar_smtp_db(_c)
    finally:
        _c.close()
    if '--relatorios-agendados' in sys.argv:  # envia agora os relatórios agendados que estiverem no prazo (também útil em cron)
        conn = db()
        print('%d envio(s) agendado(s).' % executar_agendamentos(conn))
        for _ in range(120):
            if threading.active_count() <= 1:
                break
            threading.Event().wait(0.5)
        raise SystemExit(0)
    if '--alertas-nf' in sys.argv:  # executa a revisão de NF dos Freelancers uma vez (também útil em cron)
        conn = db()
        print('%d contratação(ões) de Freelancer sem NF.' % executar_alertas_nf(conn))
        print('%d contrato(s) recorrente(s) perto do fim.' % executar_alertas_termino(conn))
        for _ in range(120):  # espera os e-mails em segundo plano terminarem de sair
            if threading.active_count() <= 1:
                break
            threading.Event().wait(0.5)
        raise SystemExit(0)
    if '--resetar-mfa' in sys.argv:  # recuperação de emergência, no servidor: python3 server.py --resetar-mfa usuario@dominio
        i = sys.argv.index('--resetar-mfa')
        alvo = (sys.argv[i + 1] if len(sys.argv) > i + 1 else '').strip().lower()
        conn = db()
        u = conn.execute('SELECT * FROM users WHERE email=?', (alvo,)).fetchone()
        if not u:
            raise SystemExit('Usuário não encontrado: %s' % alvo)
        conn.execute('UPDATE users SET mfa_ativo=0, mfa_secret=NULL, mfa_codes=NULL, mfa_ultimo_passo=0 WHERE id=?', (u['id'],))
        conn.execute('DELETE FROM sessions WHERE user_id=?', (u['id'],))
        conn.commit()
        audit(conn, None, 'mfa.resetado_no_servidor', u['id'], {'email': u['email']}, ip='console')
        raise SystemExit('MFA de %s removido. No próximo login ele(a) cadastra um novo aplicativo.' % u['email'])
    porta = int(CONFIG.get('porta') or 8765)
    srv = ServidorLimitado((os.environ.get('NEXARPAY_HOST') or '0.0.0.0', porta), Handler)
    srv.daemon_threads = True
    print('NexarPay — Tudo Sob Controle.')
    print('Servidor em http://localhost:%d  (na rede: http://<ip-desta-máquina>:%d)%s' % (porta, porta, '  [MODO DEMO]' if DEMO_MODE else ''))
    print('E-mail: modo %s. Banco: %s' % ((CONFIG.get('email') or {}).get('modo'), DB_PATH))
    print('Antivírus: %s' % (('ClamAV em %s%s' % (os.environ['NEXARPAY_CLAMAV_HOST'], ' (obrigatório)' if os.environ.get('NEXARPAY_AV_OBRIGATORIO') == '1' else ' (opcional)'))
                           if os.environ.get('NEXARPAY_CLAMAV_HOST') else 'NÃO configurado (só a verificação de conteúdo embutida)'))
    threading.Thread(target=_loop_limpeza, daemon=True).start()
    threading.Thread(target=_loop_alertas_nf, daemon=True).start()
    threading.Thread(target=_loop_relatorios, daemon=True).start()
    if DEMO_MODE:
        print('[AVISO] NEXARPAY_DEMO=1: a rota de reset apaga TODOS os dados e senhas aparecem no log de e-mail. NUNCA use com dados reais.')
    print('Ctrl+C para encerrar.')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()
