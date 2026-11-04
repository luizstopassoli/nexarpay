# Relatório de segurança — NexarPay (Sistema de Gestão Financeira)

Data: 24/10/2026 · Escopo: `server.py` (1.902 linhas), `static/` (JS/HTML), `Dockerfile`, `docker-compose.yml`, `deploy/`, `config*.json`, `seed/`, `data/`, guia de deploy.
Método: leitura completa do backend e dos pontos críticos do frontend, mais inspeção do banco e das permissões locais. **Não foi feito teste dinâmico (pentest) nem varredura de dependências com ferramenta**; os achados vêm de análise de código.

## Veredito

O código tem uma base de segurança **acima da média para um sistema caseiro**. Já existem: PBKDF2 com 600 mil iterações, token de sessão guardado só como hash, cookie HttpOnly/SameSite, proteção CSRF por cabeçalho customizado, CSP restritiva sem script inline, SQL 100% parametrizado, upload validado por extensão e assinatura, proteção contra path traversal, rate limit de login, segregação de funções e trava otimista nas aprovações.

Mesmo assim, **ele não está pronto para operar na nuvem com dados reais de clientes nem para ser vendido**. Os bloqueios não são bugs pontuais. São de arquitetura (sem multi-tenant, SQLite, servidor `http.server`) e de governança (sem MFA, sem auditoria imutável, dados sensíveis em texto puro, administrador com poder irrestrito). Para uma **demo fechada com dados fictícios** atrás do portão do Caddy, o estado atual é aceitável depois de corrigir os itens "Crítico" e "Alto" marcados com ★.

Legenda: **C** crítico · **A** alto · **M** médio · **B** baixo.

---

## 1. Arquitetura e produto (bloqueios para comercializar)

| # | Sev | Achado | Recomendação |
|---|---|---|---|
| 1.1 | **C** | **Sem multi-tenant.** Um banco, um `dominio_permitido`, um conjunto de departamentos. Dois clientes no mesmo servidor veriam os dados um do outro. O perfil `admin` enxerga tudo. | Para SaaS: coluna `tenant_id` em toda tabela, aplicada em toda consulta (ou um banco/instância por cliente). Separar "admin da plataforma" de "admin do cliente". |
| 1.2 | **A** | **SQLite em arquivo único** + `http.server` da biblioteca padrão. A própria documentação do Python diz que ele não é para produção. Sem TLS próprio, sem limite de threads, sem fila, sem alta disponibilidade, sem réplica. | PostgreSQL gerenciado + app atrás de gunicorn/uvicorn (ou migrar para FastAPI/Django). Manter o Caddy/Nginx na frente. |
| 1.3 | **A** | Nomes e regras da Gpac cravados no código: empresas `GPAC/ETOOLS/GNK/HUGHAUS` (rateio), logos `logo-gpac-*`, seeds com orçamento real da T.I. | Tirar tudo isso do produto vendável. Parametrizar por tenant. Entregar seed genérico. |
| 1.4 | **A** | **Sem trilha de auditoria.** O histórico (`historico`) só cobre solicitações. Não registra criação/exclusão de usuário, troca de perfil, exportação ou importação de backup, login falho, nem edição de orçamento/lançamento. Além disso, o admin **pode apagar** o histórico (ver 3.1). | Tabela de auditoria *append-only* (quem, quando, IP, ação, antes/depois), sem rota de exclusão. |
| 1.5 | **M** | **Sem MFA** em nenhum perfil, nem no administrador e no Financeiro, que liberam pagamentos. | TOTP obrigatório para admin/financeiro/diretor (depois SSO/SAML-OIDC, que clientes corporativos exigem). |
| 1.6 | **M** | Valores monetários em `REAL` (float). Arredondamento acumulado em somas e rateios. | Guardar centavos em inteiro ou `NUMERIC`/`Decimal`. |
| 1.7 | **M** | Sem FKs declaradas no schema (`PRAGMA foreign_keys=ON` não faz efeito). Exclusão deixa lançamentos órfãos. | Declarar `REFERENCES` e `ON DELETE` coerentes (migrando para Postgres). |

---

## 2. Configuração de implantação

| # | Sev | Achado | Recomendação |
|---|---|---|---|
| 2.1 | **C ★** | **`docker-compose.yml` fixa `NEXARPAY_DEMO=1`.** No modo demo: (a) `POST /api/backup/reset` **apaga todo o banco** e recria os dados fictícios, bastando um admin chamar a rota (ou sessão de admin roubada); (b) o corpo dos e-mails, incluindo **senhas provisórias e iniciais**, é gravado em claro no `email_log` e exibido na tela. | Criar um compose de produção separado, sem `DEMO`. Em produção a rota de reset deve nem existir. |
| 2.2 | **A ★** | Modo demo usa **uma única senha para todos os usuários, inclusive admin** (`DEMO_SENHA`), e os logins são previsíveis (`admin@`, `diretor1@`…). A única barreira real é o *basic_auth* do Caddy. | Manter o portão. Em produção, senha única por usuário e sem usuários-semente. |
| 2.3 | **A** | **Operação atual na LAN em HTTP puro** (`url_base: http://192.168.0.10:8765`, escuta em `0.0.0.0`). Senhas e cookie de sessão trafegam em texto claro na rede interna. O cookie só ganha `Secure` com `NEXARPAY_HTTPS=1`. | Mesmo na LAN, colocar HTTPS (Caddy com certificado interno). Escutar em `127.0.0.1` atrás do proxy. |
| 2.4 | **A** | **Senha SMTP em texto puro no `config.json`.** O guia admite que a senha de app do Google "passou por muitos arquivos". O arquivo atual tem permissão 600 e valor placeholder, o que é bom. | Trocar a senha de app (já recomendado no guia). Ler segredos de variável de ambiente/secret manager. Em produção usar serviço transacional (SES, Postmark, SendGrid) com domínio autenticado (SPF/DKIM/DMARC). |
| 2.5 | **A** | **Backup sem criptografia, na mesma máquina**, em `~/backups` (permissão padrão 755), sem cópia externa automática, sem teste de restauração. | Criptografar (age/gpg), enviar para armazenamento externo, `chmod 700`, testar restauração periodicamente. |
| 2.6 | **M** | `reset-demo.sh` faz `rm -rf /d/*` no volume de dados. Se rodar no servidor errado, destrói a produção. | Guardar o script fora do repositório de produção ou exigir variável de confirmação. |
| 2.7 | **M** | Imagens sem versão fixa (`caddy:2`) e sem digest. Sem limites de memória/CPU/PIDs nem rotação de logs no compose: um abuso pode encher disco ou derrubar o host. | Fixar versões/digest, `mem_limit`, `pids_limit`, `logging: max-size`. Rodar `docker scout`/Trivy no CI. |
| 2.8 | **M** | Caddy sem rate limit, sem timeouts de leitura configurados. O app aceita threads ilimitadas (`ThreadingHTTPServer`). Conexões lentas (slowloris) podem esgotá-lo. | Timeouts no Caddy, limite de conexões por IP, WAF (Cloudflare com IP real via `CF-Connecting-IP`; hoje o guia manda deixar a nuvem cinza, o que dispensa o WAF). |
| 2.9 | **B** | Não é repositório git ainda. Quando fizer `git init`, o `.gitignore` cobre `config.json`, `data/`, `seed/dados-iniciais-completos.json`, `.env`. O arquivo `data/.fuse_hidden…` e `*.sqlite*` também. Está correto. | Antes do primeiro commit, rodar `git status` (o guia já pede) e uma varredura com `gitleaks`. |
| 2.10 | **B** | Falta cabeçalho `Permissions-Policy` e `Cross-Origin-Opener-Policy`. CSP permite `style-src 'unsafe-inline'`. | Adicionar. Mover estilos inline para CSS para remover o `unsafe-inline`. |

---

## 3. Controle de acesso e lógica de negócio (o que mais importa num sistema de pagamento)

| # | Sev | Achado | Onde | Recomendação |
|---|---|---|---|---|
| 3.1 | **A ★** | **Administrador pode tudo sozinho:** aprovar etapa 1, 2 e 3 de qualquer solicitação, inclusive **a própria** (a regra de segregação exclui admin: `and not is_admin`); excluir solicitação **encerrada** junto com o histórico; importar backup que substitui todo o banco. Uma única conta comprometida (ou um admin mal-intencionado) autoriza e apaga a evidência de pagamentos. | `sol_acao`, `sol_excluir`, `import_v2` | Admin **não aprova** pagamentos. Nunca excluir solicitação encerrada (só "cancelar" com motivo, *soft delete*). Importação de backup só em manutenção e com dupla confirmação. Retenção mínima de 5 anos (obrigação fiscal). |
| 3.2 | **A ★** | **Perfil TV contorna a proteção de dados bancários.** `sol_out` remove banco/agência/conta/CPF para `tv`, mas `sol_visivel` libera todas as solicitações para `tv`, então ele baixa o **PDF do recibo** (`/api/solicitacoes/<id>/recibo`, que contém "Dados Bancários") e os **anexos** (`arquivo_permitido` → `sol_visivel`). A conta de TV é compartilhada e fica numa tela pública. | `sol_visivel`, `api_solicitacoes`, `arquivo_permitido` | Perfil `tv` só recebe agregados do dashboard, nunca `solicitacoes`, anexos ou recibos. Bloquear essas rotas para `tv`. |
| 3.3 | **A** | **Sem alçada por valor.** Qualquer valor até R$ 1 bilhão exige as mesmas duas aprovações. Sem detecção de duplicidade (mesmo fornecedor + valor + OC/PI). Sem checagem de orçamento (a solicitação pode estourar o orçamento do departamento). | `validar_solicitacao`, `sol_acao` | Alçadas configuráveis (ex.: acima de R$ X exige diretor adicional), alerta de duplicidade, bloqueio ou aviso de estouro de orçamento. |
| 3.4 | **A** | **Dados de pagamento sem proteção especial.** Banco, agência, conta e CPF/CNPJ ficam em texto no JSON `dados`, em backups e no PDF. Não há revalidação quando o dado bancário muda num reenvio. Quem edita uma solicitação em "alteração solicitada" pode trocar a conta de destino, e `reenvio_retorna_para_aprovacao1` pode ser `False`, caso em que um valor ou conta alterado volta direto para a **etapa 2**, sem passar de novo pela etapa 1. | `sol_editar`, `config` | Sempre voltar à etapa 1 quando valor ou dados bancários mudarem. Destacar mudança de conta para o aprovador. Criptografar campos bancários em repouso. |
| 3.5 | **A** | **Credenciais em texto puro no banco:** campos `usuarioConta` e `senhaSerial` dos lançamentos funcionam como cofre de senhas/seriais (a seed completa tem 39 desses registros). São enviados a admin e gestor e **vão inteiros no backup JSON**. | `launches`, `launch_out`, `api_backup` | Não guardar segredos no sistema financeiro, ou usar criptografia de campo com chave fora do banco (KMS) e log de acesso. Excluir do backup. |
| 3.6 | **M** | **Backup exporta hashes e salts de senha de todos os usuários** (`SELECT * FROM users`, incluindo `reset_hash`) e é enviado **sem `Cache-Control: no-store` nem cabeçalhos de segurança**. | `api_backup` | Excluir colunas de credencial do export. Adicionar `no-store`. Registrar quem exportou. |
| 3.7 | **M** | `senha_provisoria` só é imposta pelo **frontend**. Quem entra com senha provisória pode usar a API inteira sem trocá-la. | `api`/`require_user` | Bloquear todas as rotas (exceto `change-password`/`logout`/`me`) enquanto `senha_provisoria=1`. |
| 3.8 | **M** | **Qualquer usuário autenticado recebe a lista de todos os usuários** (nome, e-mail, perfil) no `bootstrap`. Também enxerga todos os departamentos. Facilita phishing interno e enumeração. | `api_bootstrap` | Enviar só o necessário ao perfil (aprovadores próprios, etc.). |
| 3.9 | **M** | Gestor/Admin cria lançamento manual que **abate o orçamento** sem solicitação nem segunda aprovação. | `api_launches` | Lançamento manual acima de um limite exige aprovação, e fica na auditoria. |
| 3.10 | **M** | Diretor, Financeiro e TV veem **todos** os departamentos e solicitações. Não há "diretor de uma área só". | `pode_ver_todos_deps`, `sol_visivel` | Escopo por departamento também para diretor/financeiro quando o cliente exigir. |
| 3.11 | **B** | Usuários aceitam IDs de departamento inexistentes; `PUT /departamentos/<id>` não verifica existência; `int()`/`float()` de entrada do admin gera 500 em vez de 400 (`ano`, `dolar`, `email/ver/<id>`); `float` aceita `NaN`/`inf` em `dolar`. | vários | Validação centralizada de entrada (schema). |
| 3.12 | **B** | O e-mail de notificação vai para o campo `email` que o solicitante digita (qualquer endereço do domínio), não necessariamente o dele. Texto livre (título/descrição) vai no corpo dos e-mails aos diretores. | `validar_solicitacao`, `resumo_email` | Usar sempre o e-mail do usuário. Avisar nos e-mails que o conteúdo é informado pelo solicitante. |
| 3.13 | **B** | A geração do recibo pode falhar depois de a solicitação já estar "encerrada" (ex.: campo `descricao` com tipo inesperado). O erro é engolido e não existe rota para gerar de novo; o solicitante fica sem recibo. | `sol_acao` | Validar tipos dos campos de `dados` (string/tamanho) e oferecer "regerar recibo". |

---

## 4. Autenticação e sessão

| # | Sev | Achado | Recomendação |
|---|---|---|---|
| 4.1 | **M** | **Bloqueio por e-mail permite negar acesso a qualquer pessoa:** 8 falhas em 15 min travam a conta-alvo, e basta saber o e-mail (que o `bootstrap` entrega a todos). | Bloqueio progressivo por (IP + e-mail), CAPTCHA/atraso exponencial; alerta ao dono da conta. |
| 4.2 | **M** | Contadores de tentativa ficam **em memória**: zeram a cada reinício e não valem entre várias instâncias. | Guardar em Redis/banco ao escalar. |
| 4.3 | **M** | Recuperação de senha **envia a senha provisória por e-mail** em vez de link de uso único. A senha trafega e fica na caixa de entrada; o `email_log` em modo demo a registra em claro. Boas-vindas de admin também enviam a senha. | Link com token aleatório de uso único e expiração curta. Nunca enviar senha. |
| 4.4 | **M** | Sessão deslizante de 12 h, **sem expiração absoluta**, sem lista de sessões ativas, sem vínculo a IP/dispositivo, sem "sair de todos os dispositivos" (existe só ao trocar a senha). | Expiração absoluta (ex.: 12 h), tela de sessões, reautenticação para ações sensíveis (aprovar acima de X, exportar backup, criar usuário). |
| 4.5 | **B** | Política de senha: 10 caracteres com letra e número. Sem verificação de senhas vazadas/comuns. Hash legado de 120 mil iterações ainda é aceito (migra no login, o que é bom). | Verificar contra lista de senhas comuns (ex.: HIBP k-anonymity) e remover o legado depois da migração. |
| 4.6 | **B** | O IP do cliente usa o **último** valor de `X-Forwarded-For` quando `TRUST_PROXY=1`. Está correto com o Caddy; fica burlável se o app for publicado direto, ou inútil com Cloudflare laranja (IP do Cloudflare). | Documentar. Usar `CF-Connecting-IP` com validação das faixas do Cloudflare se for usá-lo. |
| 4.7 | **B** | `POST /auth/logout` e `forgot` são "públicos" e dispensam autenticação; o logout continua exigindo o cabeçalho CSRF (ok). Não há bloqueio de CSRF de login além do cabeçalho. | Sem ação urgente. |

---

## 5. Upload, arquivos e disponibilidade

| # | Sev | Achado | Recomendação |
|---|---|---|---|
| 5.1 | **A** | **Sem antivírus.** O sistema aceita PDF/DOC/XLS/DOCX/XLSX de qualquer usuário autenticado e os repassa a diretores e ao Financeiro, que os abrem. Só há checagem de assinatura inicial (`%PDF-`, `PK`, etc.). `.doc/.xls` (OLE) podem ter macros. | ClamAV (ou serviço de varredura) antes de aceitar. Considerar aceitar só PDF/PNG/JPEG. |
| 5.2 | **M** | Upload por JSON/base64: o corpo inteiro (até ~27 MB) é lido em memória e decodificado. **Sem cota por usuário, por tempo ou total**: qualquer usuário autenticado pode encher o disco ou a memória. | Upload multipart com streaming, cota por usuário/tenant, limite de uploads por hora. |
| 5.3 | **M** | Arquivos órfãos (enviados e nunca anexados, ou de solicitações excluídas) nunca são removidos. | Rotina de limpeza e política de retenção. |
| 5.4 | **M** | Arquivos e recibos ficam no disco local em claro. Servidos com `inline` para PDF/PNG/JPEG (com `nosniff` e CSP; bom). | Armazenamento de objetos (S3 compatível) com criptografia e URLs assinadas de curta duração. |
| 5.5 | **B** | `hash do arquivo`/deduplicação inexistente; mesmo PDF enviado várias vezes (há dois PDFs de 51.718 bytes no `uploads/`). | Calcular SHA-256 e detectar o mesmo comprovante em solicitações diferentes (ajuda contra pagamento duplicado). |

---

## 6. Pontos positivos confirmados (não mexer)

- SQL parametrizado em todas as consultas dinâmicas (os `%s` do código vêm de constantes).
- XSS: o frontend passa todo texto de usuário por `escapeHtml` nos pontos auditados. O CSP bloqueia script inline e de terceiros. Links de anexo só aceitam `http(s)` e `data:` de PDF/PNG/JPEG.
- Sem dependências Python de terceiros (superfície de CVE mínima). Chart.js 4.5.1 está local, sem CDN.
- Path traversal bloqueado (`is_inside` com `realpath`, `os.path.basename` nos caminhos de arquivo, validação dos caminhos do backup importado).
- CSRF: mutações exigem `X-NexarPay: 1` e o servidor não envia CORS. Cookie `SameSite=Lax`, `HttpOnly`.
- Token de sessão aleatório (256 bits) guardado só como SHA-256; sessões revogadas ao trocar senha/perfil/inativar.
- Anti-enumeração: `forgot` responde igual, e login gasta o mesmo tempo para usuário inexistente.
- Segregação de funções para não-admin e trava otimista (`UPDATE ... WHERE status=?`) contra aprovação em duplicidade.
- Container sem root, sistema de arquivos somente leitura, `cap_drop: ALL`, `no-new-privileges`, app sem porta publicada, HTTPS automático e HSTS.
- Dados reais não vão ao Git (`.gitignore`/`.dockerignore` corretos). `config.json` com permissão 600; hoje está em modo "simulado" com senha placeholder. Nenhuma credencial real foi encontrada nos arquivos do projeto.

---

## 7. Plano de ação sugerido

**Antes de qualquer demo pública (1–2 dias)**
1. Compose de demo mantém o portão do Caddy; confirmar que o reset só existe em demo (2.1) e que a demo não recebe dado real.
2. Bloquear `tv` em solicitações, anexos e recibos (3.2).
3. Admin não aprova e não apaga solicitação encerrada (3.1). Exigir troca de senha provisória no servidor (3.7).
4. Remover hashes do backup e adicionar `no-store` (3.6). Trocar a senha SMTP antiga (2.4).

**Antes de usar com dados reais da Gpac (2–4 semanas)**
5. HTTPS também na LAN, escuta em localhost atrás do proxy (2.3).
6. Auditoria append-only (1.4), MFA para admin/financeiro/diretor (1.5), alçadas e duplicidade (3.3), dados bancários criptografados (3.4/3.5).
7. Link de redefinição em vez de senha por e-mail (4.3). Antivírus nos uploads e cota (5.1/5.2). Backup criptografado e externo (2.5).

**Antes de vender (projeto de 2–4 meses)**
8. Multi-tenant (1.1), PostgreSQL e servidor de aplicação de produção (1.2), armazenamento de objetos (5.4).
9. LGPD: contrato de operador, política de privacidade, retenção/exclusão, registro de tratamento, plano de resposta a incidentes.
10. SSO (OIDC/SAML), observabilidade (logs centralizados, alertas, uptime), CI com SAST/SCA/escaneamento de imagem, **pentest externo** e testes automatizados das regras de aprovação.

---

*Limites desta análise: sem execução dinâmica contra o servidor, sem varredura de CVE por ferramenta (o código quase não tem dependências), sem revisão linha a linha de cada template do frontend (dashboard, orçamento, propriedades), sem análise do servidor Linux/Docker em produção (firewall, SSH, patches).*

---

## Correções aplicadas (24/10/2026)

Testadas em servidor temporário isolado (cópia do código, banco novo), com 19 verificações de fluxo.

| Item | O que mudou |
|---|---|
| 3.1 | Administrador não aprova por conta própria: só age se for o(a) Diretor(a) designado(a); a etapa do Financeiro é só do perfil Financeiro. Segregação de funções vale para todos, inclusive admin. Solicitação aprovada ou encerrada **não pode mais ser excluída por ninguém**. Só o solicitante edita os dados (nem o admin altera valor/conta de outra pessoa). Frontend ajustado. |
| 3.2 | Perfil `tv` recebe só uma projeção mínima (status, valor, departamento, datas); detalhe, anexos e recibo retornam 404. |
| 3.6 | Backup não exporta mais hash/salt/reset de senha, sai com `Cache-Control: no-store` e cabeçalhos de segurança, e exportar/importar gera linha de log `[auditoria]`. Ao importar, os hashes atuais dos usuários são preservados. |
| 3.7 | Com senha provisória, o servidor só aceita trocar a senha, sair ou consultar a sessão (403 nas demais rotas). |
| 2.1/2.2 | `docker-compose.yml` agora é **produção** (sem modo demo, com limites de memória/PIDs e rotação de logs, `deploy/Caddyfile.prod`, `deploy/prod.env.example`). A demo foi para `docker-compose.demo.yml`, com projeto e volume próprios (`nexarpay-demo`). `reset-demo.sh` exige `NEXARPAY_CONFIRMA_DEMO=1`. `backup.sh` usa `umask 077`. O guia de deploy usa o compose da demo. |

Pendências conhecidas destes itens: o backup ainda inclui `senhaSerial`/`usuarioConta` dos lançamentos (item 3.5); a auditoria do backup é só em log, não em tabela (item 1.4); o modo produção ainda cria usuários-semente na primeira execução, com senhas aleatórias em `data/credenciais-iniciais.txt`.

### Segunda rodada (24/10/2026): itens 1.4, 3.5 e 3.4

| Item | O que mudou |
|---|---|
| 1.4 Auditoria | Nova tabela `auditoria`, só de inclusão (gatilhos do banco bloqueiam UPDATE e DELETE) e **encadeada por hash**: mexer num registro quebra a verificação dali em diante. Registra login (ok/falha), logout, recuperação e troca de senha, criação/alteração/exclusão de usuário (com antes/depois de perfil, departamentos e aprovadores), departamentos, cadastros, orçamentos, lançamentos, uploads, todas as ações de solicitação (criar, editar, aprovar, devolver, reprovar, encerrar, excluir, documento fiscal), exportação/importação de backup e revelação de senha. Nunca grava senhas nem dados bancários. Admin consulta em Configurações → Trilha de Auditoria e verifica a integridade com um botão. |
| 3.5 Credenciais | `senhaSerial` e `usuarioConta` ficam **cifradas no banco** (e portanto no backup). A senha nunca mais vai na listagem: só aparece pelo botão "Revelar" (somente admin/gestor do departamento), que fica na auditoria. Em branco no formulário mantém a senha; há opção de remover. A conta de acesso só é decifrada para admin/gestor. |
| 3.4 Dados bancários | `banco`, `agência`, `conta` e `CPF/CNPJ` das solicitações ficam cifrados no banco e no backup. O histórico de edições registra *que* o dado mudou, sem o valor. O recibo em PDF continua mostrando os dados normalmente. |
| Migração | Ao subir, o servidor cifra tudo o que ainda estiver em texto (idempotente) e mascara valores bancários antigos do histórico. Também roda após importar backup. |

**Chave de criptografia:** em produção use `NEXARPAY_SECRET_KEY` (o compose de produção exige `APP_SECRET_KEY`). Sem ela o servidor cria `data/secret.key` (0600). O `backup.sh` deixa esse arquivo de fora de propósito. **Sem a chave, os dados cifrados e os backups não podem ser lidos: guarde uma cópia fora do servidor.**

Limites: a cifra usa só a biblioteca padrão (keystream HMAC-SHA256 em modo contador + etiqueta HMAC, encrypt-then-MAC). Ao migrar para PostgreSQL, trocar por AES-GCM (biblioteca `cryptography`) ou KMS do provedor. A auditoria encadeada detecta adulteração, mas quem tem acesso total ao banco consegue reescrever a cadeia inteira; para prova forte, enviar o último hash para fora (e-mail/armazenamento externo) periodicamente.

### Terceira rodada (24/10/2026): itens 3.3, 5.1, 5.2 e 5.3

| Item | O que mudou |
|---|---|
| 3.3 Duplicidade | Ao enviar ou reenviar, o servidor compara com as solicitações dos últimos 2 anos (exceto reprovadas): **mesmo valor + mesmo fornecedor/beneficiário**, **mesmo Nº de OC/PI + mesmo valor** e **mesmo arquivo anexado** (SHA-256, inclusive anexos antigos, que foram indexados na subida). Se houver semelhança, responde 409 e o frontend pede confirmação explícita; a confirmação (e quem confirmou) fica registrada na solicitação, no histórico e na auditoria. |
| 3.3 Orçamento | Compara o valor com o orçamento aprovado do ano da data de pagamento, por **categoria** e pelo **total do departamento** (orçado × lançado × em aprovação × esta solicitação). Avisa (não bloqueia) e mostra os alertas ao aprovador, no detalhe e no e-mail de aviso; os alertas de orçamento são recalculados a cada aprovação. Para bloquear, use `"controles": {"bloquear_estouro_orcamento": true}` no `config.json`. Também avisa quando não há orçamento do ano ou a categoria não está vinculada a nenhuma linha. |
| 5.2 Upload/cotas | O upload não usa mais JSON/base64: o arquivo vai em streaming para um temporário (memória constante), com limites **por usuário** (40 envios/hora, 1 GB) e **globais** (20 GB e mínimo de disco livre), configuráveis em `limites` no `config.json`. Recusas antecipadas descartam o corpo para o navegador receber a mensagem. |
| 5.1 Conteúdo/antivírus | Recusa PDF com JavaScript/Launch/arquivo embutido; DOCX/XLSX com macro, ActiveX, objetos embutidos, executáveis, modelo externo vinculado ou zip bomb. `.doc`/`.xls` legados (macros OLE) deixaram de ser aceitos. **ClamAV opcional** (`CLAMAV_HOST`, `AV_OBRIGATORIO=1` recusa o upload se o scanner estiver fora do ar), com serviço pronto no compose de produção (`docker compose --profile av up -d`). |
| 5.3 Órfãos | Anexos enviados e nunca vinculados são removidos após 72 h (limpeza a cada 6 h, registrada na auditoria), liberando a cota. |

Limites conhecidos: a checagem de PDF é por padrão no texto e não enxerga script dentro de fluxos comprimidos, por isso o ClamAV é o controle de fato; a deteção de duplicidade é heurística (nomes de fornecedor escritos de forma diferente não casam); o controle de orçamento considera lançamentos em BRL.

### Quarta rodada (24/10/2026): itens 4.3 e 1.5

| Item | O que mudou |
|---|---|
| 4.3 Link de redefinição | "Esqueci minha senha" não envia mais senha: envia um **link de uso único, válido por 30 min**, com token aleatório guardado só como hash. O token vai no `#fragmento` (não aparece em logs de acesso nem em Referer) e some da barra de endereço ao abrir. Ao redefinir, todas as sessões do usuário caem. O e-mail de boas-vindas de novo usuário também deixou de levar a senha: leva um link (24 h) para ele definir a própria. Tentativas limitadas por IP. |
| 1.5 MFA (TOTP) | Verificação em duas etapas com aplicativo autenticador (RFC 6238, 6 dígitos, janela ±30 s). **Obrigatória para admin, financeiro e diretor** (configurável em `seguranca.mfa_perfis` no `config.json`); opcional para os demais, que ativam e desativam em "Verificação em 2 etapas". Quem tem perfil obrigatório sem MFA entra, mas a API fica bloqueada até cadastrar. |
| Login com MFA | Senha correta cria só uma sessão **pendente de 5 min**, sem acesso a nada; o código troca por uma sessão nova. Código aceito uma única vez (anti-replay), 5 erros derrubam a pendência, limite compartilhado com o bloqueio por e-mail. |
| Recuperação | 8 códigos de recuperação de uso único (guardados só como hash, mostrados uma vez). Administrador redefine o MFA de um usuário (checkbox no cadastro) e, em emergência no servidor: `python3 server.py --resetar-mfa usuario@dominio`. Tudo na auditoria. |
| Proteção dos segredos | O segredo TOTP fica cifrado no banco; o backup não exporta segredo nem códigos, e a importação preserva o MFA já cadastrado. |

**Antes de reiniciar o servidor com seus usuários reais:** admin, financeiro e diretores serão obrigados a cadastrar o MFA no próximo login. Combine com eles e tenha o comando `--resetar-mfa` à mão. O modo demo não força MFA (use `NEXARPAY_DEMO_MFA=1` para demonstrá-lo).

Limites: a tela de cadastro mostra a chave para digitar e um link `otpauth://` (sem QR code, para não depender de biblioteca de terceiros); chaves de hardware (WebAuthn/passkeys) e SSO (OIDC/SAML) ficam para a fase de produto. O link de redefinição depende do e-mail do usuário: o e-mail precisa estar protegido (idealmente com MFA no provedor).

### Quinta rodada (24/10/2026): primeiro acesso, 4.1, 4.4 e 2.8

| Item | O que mudou |
|---|---|
| Primeiro acesso (produção) | Banco novo fora do modo demo **não cria mais usuários nem dados de exemplo**: cria só o primeiro administrador (`NEXARPAY_ADMIN_EMAIL`; no compose, `APP_ADMIN_EMAIL`), com senha provisória aleatória em `data/credenciais-iniciais.txt` (0600), troca obrigatória e arquivo apagado ao trocar a senha. Sem a variável, o servidor se recusa a subir com uma mensagem explicando. A demonstração (`NEXARPAY_DEMO=1`) segue criando os dados fictícios. Bancos já existentes não mudam. |
| 4.1 Bloqueio | O bloqueio agora vale para **IP + e-mail**: quem erra a senha é bloqueado (1, 2, 4, 8, 16, no máximo 30 min, crescendo a cada reincidência) sem travar a conta do dono em outro IP. Contra ataque distribuído (25 erros em 1 h na mesma conta), só entram IPs já usados com sucesso pelo dono. O limite de 8 tentativas por 15 min continua no segundo fator, onde o atacante já sabe a senha. |
| 4.4 Sessões | Expiração por **inatividade de 4 h** e **vida máxima de 12 h** mesmo com uso contínuo (o perfil TV fica 30 dias). Tela "Minhas sessões" (dispositivo, IP, início) para encerrar uma ou todas as outras. **Reautenticação** (senha, mais código do MFA se ativo; vale 10 min) para criar/editar/excluir usuário, exportar/importar backup e restaurar a demo; o frontend pede sozinho e repete a ação. Tudo na auditoria. |
| 2.8 Limites | Caddy (demo e produção): timeouts de leitura de cabeçalho (10 s) e corpo (120 s), inatividade de 2 min e cabeçalho máximo de 16 KB. No app: teto de conexões simultâneas (150) e limite de requisições por minuto por IP (600), ambos configuráveis em `limites` no `config.json`. |

Não verificado: a sintaxe dos Caddyfiles (o Docker não estava ativo para rodar `caddy validate`; confira na primeira subida com `docker compose logs caddy`). O limite por minuto usa o IP do cliente informado pelo Caddy; atrás de Cloudflare com nuvem laranja todos os usuários pareceriam um só IP.

### Revisão final (24/10/2026)

**Teste no navegador** (servidor local isolado, navegador embutido): carregamento sem erros de JavaScript; login → cadastro obrigatório de MFA → códigos de recuperação → sistema aberto; "Minhas sessões"; pedido de confirmação de senha (com código do MFA) ao criar usuário e repetição automática da ação; tela de redefinição pelo link (com o token saindo da barra de endereço) e mensagem de link inválido; tela do código do MFA no login. Dois defeitos reais encontrados e **corrigidos**: a chave do MFA aparecia clara demais sobre fundo branco (quase ilegível) e, ao recarregar a página já logado, a tela de cadastro do MFA ficava escondida atrás da tela de abertura. **Ainda não conferidos no navegador:** diálogo de duplicidade, botão "Revelar" de senha, tela de auditoria e exportar backup.

**Guia de deploy** (`GUIA_DEPLOY_CONTABO.md`): agora com dois caminhos. Demo (etapas 8 a 12) e Produção (P1 a P10: `config.json` e `.env`, subida com ClamAV, primeiro acesso, verificação, backup criptografado e externo com restauração, atualização, operação e checklist de entrada). O `deploy/backup.sh` ganhou criptografia (age) e cópia externa (scp), e avisa quando uma das duas não está configurada.

**Pendências que continuam abertas** (nenhuma bloqueia o uso interno na Gpac depois do checklist P10): 1.1 multi-tenant, 1.2 PostgreSQL e servidor de aplicação, 1.3 regras da Gpac no código, 1.6 centavos inteiros, 1.7 chaves estrangeiras, alçada por valor, 2.7 imagens com versão fixa, 2.9 `gitleaks`, 2.10 cabeçalhos extras, 3.8 lista de usuários no `bootstrap`, 3.9 aprovação de lançamento manual, 3.10 escopo por departamento, 3.11 a 3.13 validação de entrada e "regerar recibo", 4.2 contadores em memória (reiniciam com o servidor), 4.5 senhas vazadas, 4.6 IP real atrás de proxy, 5.4 armazenamento de objetos, e SSO, LGPD, monitoramento e pentest para a fase comercial.

### Empresas e rateio — Etapa 1 (25/10/2026)

Não é item de segurança: é a primeira parte da configuração por cliente (item 1.3) e do modelo de rateio definido com o Luiz.

**Feito:** cadastro único de **Empresas** (Propriedades → Empresas: nome, ativa, participa do rateio, percentual padrão) e **nome do grupo** editável, no lugar das duas listas antigas e das quatro empresas fixas do código. Solicitações (os 3 tipos) e lançamentos guardam a empresa por identificador; renomear atualiza o histórico. **Empresa é obrigatória**; a opção do grupo ("Grupo Gpac — dividido entre as empresas") só aparece com 2 ou mais empresas no rateio. Os dashboards leem as empresas do cadastro; despesa do **Grupo** é dividida pelo rateio do orçamento do departamento e ano, despesa de uma empresa vai 100% para ela, e Grupo em ano/departamento sem rateio aparece como "(sem rateio)", sem dividir. Solicitação sem empresa não pode ser aprovada (usa-se "Alterar"). Backup e restauração incluem o cadastro; backups antigos são convertidos.

**Migração dos dados** (testada numa cópia da base real; total preservado, R$ 681.860,24): Grupo Gpac/GRUPO GPAC → Grupo (31), Gpac (23), Etools (12), Imobiliário → Squad Imobiliário (7). A REQ-2026-0007 (sem empresa, aguardando Aprovação 2) fica como pendência a corrigir pelo solicitante.

**Ainda não feito (próximas etapas):** saldo por empresa e categoria na tela de Orçamento, aviso de estouro por empresa, tela de rateio com soma obrigatória de 100%, prévia de impacto e recálculo, fechamento do ano fiscal, percentual padrão aplicado ao criar orçamento, tipos de solicitação editáveis.

### Empresas e rateio — Etapa 4 (25/10/2026): rateio e fechamento do ano fiscal

- **Rateio com soma obrigatória de 100%** (no servidor e na tela): só empresas cadastradas que participam do rateio, percentuais de 0 a 100%, soma exata. Não é possível apagar o rateio de um orçamento. Orçamento novo nasce com o rateio do ano anterior (se ainda válido) ou com o percentual padrão das empresas.
- **Troca de rateio em uso:** o servidor devolve a **prévia do impacto** (orçado, gasto e saldo por empresa, antes e depois; o total gasto não muda; avisa quem ficará com saldo negativo). Só grava depois da confirmação e da confirmação de senha, e registra na auditoria os percentuais antes e depois. O recálculo é automático: a divisão do gasto do grupo é sempre calculada com o rateio vigente.
- **Fechamento do ano fiscal** (Orçamento → "Fechamento do ano", só Administrador, com senha e justificativa para reabrir): ano fechado não permite alterar/excluir/criar orçamento, rateio ou lançamentos, nem solicitações com pagamento naquele ano; o Financeiro não encerra solicitação com data em ano fechado (usa-se "Alterar"); renomear cadastros usados em lançamentos de ano fechado é bloqueado. A tela mostra o aviso "Ano fechado" e esconde os botões de edição. Fechamento e reabertura ficam na auditoria; backup e restauração preservam os anos fechados.

**Ainda não feito:** saldo por empresa e categoria na tela de Orçamento, aviso de estouro por empresa nas solicitações, tipos de solicitação editáveis.

### Módulo Freelancer e perfil RH (novembro/2026)

**Módulo Freelancer** (4º tipo de solicitação): formulário com solicitante, e-mail, empresa, departamento, motivo, recorrente, modalidade, início, término, valor, nome completo, dados bancários (banco, agência, C/C, CNPJ) e "Anexar NF". Fluxo: Aprovação 1 → Aprovação 2 → **RH** → Financeiro. A aprovação do RH sempre abre a tela de contratação (profissional contratado? data de contratação, onboarding previsto); fica no histórico e no recibo. Regras: período de início a término de **no máximo 31 dias**; término anterior a hoje só pode ser pedido por quem tem perfil **Diretoria**; CNPJ validado (dígitos verificadores); dados bancários cifrados como nos outros módulos; a data de pagamento é a data de término (define o ano fiscal e a agenda).

**NF e bloqueio:** a NF pode ir no formulário ou depois do encerramento. Passada a data de término sem NF, o solicitante fica bloqueado **só para novos Freelancers** (os outros módulos seguem liberados); anexar a NF encerra o bloqueio; o **Financeiro** pode remover a NF (com justificativa, registrada no histórico e na auditoria; o arquivo é preservado como evidência) e o bloqueio volta. **Revisão diária às 9h:** e-mail ao solicitante com os pedidos sem NF (avisando se já está bloqueado) e resumo ao Financeiro e ao RH; se o servidor estiver desligado às 9h, a revisão roda quando ele subir no mesmo dia.

**Perfil RH:** semelhante ao Gestor (dashboard, lançamentos e orçamento só do departamento do RH, mais um bloco com todos os Freelancers), faz solicitações de qualquer módulo, e **aprova apenas a etapa do RH do Freelancer**. Decisões minhas (fáceis de mudar): o RH **não** lança manualmente, **não** vê senha/serial de lançamentos e **não** entra na lista de perfis com MFA obrigatório.

**Interpretações a confirmar:** (1) "somente a Diretoria pode realizar o pedido" retroativo = só usuários de perfil Diretoria **criam** o pedido (precisam ter Diretor 1 e 2 definidos); (2) qualquer usuário RH ativo pode aprovar a etapa do RH; (3) a revisão das 9h considera pedidos já **encerrados** pelo Financeiro e sem NF.

Correção de higiene feita junto: a lista de solicitações do usuário anterior deixou de ficar na memória da aba quando outra pessoa entra no sistema.

### Relatórios — primeira leva (novembro/2026)

Seis relatórios (solicitações, orçado × realizado, rateio por empresa, aprovações e prazos, agenda de pagamentos, documentos fiscais pendentes) em tela, Excel e PDF, com e-mail, agendamento mensal, filtros salvos por usuário e colunas padrão por cliente.

**Controles de acesso e segurança:** emitem relatório Admin, Diretoria, Financeiro, Gestor e RH; Colaborador e Dashboard TV recebem 403 (no servidor, não só no menu). O alcance de cada relatório é o mesmo do sistema: Diretoria/Financeiro/Admin veem tudo; Gestor e RH, só os departamentos deles (RH também vê todos os Freelancers); escolher um departamento fora do alcance dá 403. Dados bancários nunca entram nos relatórios. Exportar, enviar por e-mail, agendar e mudar colunas padrão ficam na **auditoria** (com os filtros usados). E-mail só para o próprio usuário e até 5 endereços do domínio da empresa, no máximo 10 envios por hora por usuário; agendamentos limitados a 10 por usuário e rodam com as permissões atuais do dono (se ele perder o acesso, o envio é pulado). Os arquivos temporários dos e-mails (`data/relatorios/`, que contêm dados financeiros) são apagados após 2 dias. O Excel e o PDF são gerados sem bibliotecas de terceiros (PDF de várias páginas, A4 paisagem).

**Decisões minhas (fáceis de mudar):** o RH também emite relatórios (escopo de gestor); o realizado segue a regra combinada (encerrado pelo Financeiro, ano pela data de pagamento); no relatório simples de solicitações o período considera a data da solicitação.
