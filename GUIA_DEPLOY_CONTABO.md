# Guia passo a passo — NexarPay na nuvem (GitHub + Contabo + Cloudflare)

Este guia tem **dois caminhos**, que compartilham as Etapas 1 a 7 (conta, servidor, Docker, código):

| Caminho | Para quê | Etapas |
|---|---|---|
| **A — Demonstração** | Mostrar a clientes, com dados **fictícios**, atrás de um portão de usuário/senha | 8 a 12 |
| **B — Produção** | Uso real, com dados reais, MFA, antivírus e backup criptografado | **P1 a P10** (no fim do guia) |

> **Não misture os dois no mesmo servidor.** Os dois usam as portas 80/443 e a demo se apaga sozinha toda madrugada. Use um VPS (ou domínio) para cada um. Para dados reais, siga o Caminho B.

Tempo estimado: demo 1h30 a 2h; produção, meio dia na primeira vez.

> Convenções: `SEUDOMINIO.com.br` = seu domínio no Cloudflare · `IP_DO_VPS` = IP que a Contabo enviar · comandos em blocos cinza = copie e cole.
> **Pré-requisito:** o domínio precisa estar ativo no Cloudflare (aba *Websites*). Se não tiver domínio, registre um (Cloudflare Registrar ou Registro.br) antes.

---

## Visão geral da arquitetura

```
Cliente ──HTTPS──▶ Caddy (VPS, portas 80/443, certificado Let's Encrypt automático)
                     │  pede usuário/senha do "portão"
                     ▼
                  NexarPay (container Python, sem porta aberta para a internet)
                     │
                  volume Docker (banco SQLite + anexos)
```

- **GitHub**: guarda o código (repositório PRIVADO) — é por onde você leva o código ao servidor e o atualiza.
- **Contabo**: o servidor (VPS) onde roda o Docker.
- **Cloudflare**: DNS (aponta `demo.SEUDOMINIO.com.br` para o IP do VPS).

---

## ETAPA 1 — Preparar seu Mac

### 1.1 Gerar a chave SSH (se ainda não tiver)
No Terminal do Mac:
```bash
ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519 -C "luiz-gpac"
```
(Enter para aceitar o local; defina uma senha para a chave quando pedir.)

Mostrar a chave pública (você vai colar na Contabo e no GitHub):
```bash
cat ~/.ssh/id_ed25519.pub
```

### 1.2 Conferir o que NÃO vai para o GitHub
O arquivo `.gitignore` já exclui: `.env`, `config.json` (tem a senha SMTP), `data/` (banco e anexos), `seed/` (dados reais da T.I.), `legado/`.
Mesmo assim, **troque a senha SMTP do Google** (a atual passou por muitos arquivos).

---

## ETAPA 2 — Subir o código para o GitHub

1. Em github.com → **New repository** → nome `nexarpay` → marque **Private** → NÃO marque README/.gitignore → **Create**.
2. No Terminal, dentro da pasta do projeto:
```bash
cd /Users/luizstopassoli/Documents/Projetos_Grupo_Gpac/Gestao_Gastos/Sistema_Gestao_Financeira
git init -b main
git add .
git status
```
3. **Confira a lista do `git status`**: NÃO podem aparecer `config.json`, `data/`, `.env` nem `seed/`. Se aparecerem, pare e me avise.
4. Envie:
```bash
git commit -m "NexarPay: versão para demonstração"
git remote add origin git@github.com:SEU_USUARIO/nexarpay.git
git push -u origin main
```
(Se pedir autenticação e você ainda não cadastrou a chave: GitHub → *Settings → SSH and GPG keys → New SSH key* → cole o conteúdo do `id_ed25519.pub`.)

---

## ETAPA 3 — Contratar o VPS na Contabo

1. Acesse contabo.com → **VPS** → escolha **Cloud VPS 10** (ou superior). Para a demo basta: 4 vCPU / 8 GB RAM.
2. Configuração:
   - **Região:** a mais perto de você disponível (EU ou US; a Contabo não tem datacenter no Brasil — para demo está ok).
   - **Imagem:** **Ubuntu 24.04** (sem painel — não escolha cPanel/Plesk).
   - **Armazenamento:** o padrão.
   - **Acesso:** cole sua **chave SSH pública** (`id_ed25519.pub`) e defina uma **senha de root** forte (guarde no gerenciador de senhas).
   - **Backup automático/snapshots:** se oferecerem, contrate (barato e útil).
3. Finalize. Você receberá e-mail com o **IP** em alguns minutos (às vezes até 1 hora). Também aparece no *Customer Control Panel*.

---

## ETAPA 4 — Apontar o domínio no Cloudflare

1. Cloudflare → seu domínio → **DNS → Records → Add record**:
   - Type: `A` · Name: `demo` · IPv4: `IP_DO_VPS`
   - **Proxy status: "DNS only" (nuvem CINZA)**. Importante: com a nuvem laranja ligada, o servidor enxerga o IP do Cloudflare em vez do IP do cliente e o bloqueio de tentativas de login passa a valer para todos de uma vez. Para a demo, deixe cinza.
2. Teste (pode levar alguns minutos):
```bash
dig +short demo.SEUDOMINIO.com.br
```
Deve responder o `IP_DO_VPS`.

---

## ETAPA 5 — Primeiro acesso e blindagem do servidor

### 5.1 Entrar como root
```bash
ssh root@IP_DO_VPS
```
(Responda `yes` à pergunta da impressão digital.)

### 5.2 Atualizar o sistema
```bash
apt update && apt -y upgrade
apt -y install ufw fail2ban unattended-upgrades git
timedatectl set-timezone America/Sao_Paulo
reboot
```
Aguarde ~1 min e entre de novo (`ssh root@IP_DO_VPS`).

### 5.3 Criar um usuário comum (não usar root no dia a dia)
```bash
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```
**Antes de continuar**, abra OUTRO terminal no Mac e teste: `ssh deploy@IP_DO_VPS`. Se entrou, siga.

### 5.4 Desligar login de root e por senha
```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```
(Mantenha o outro terminal aberto até confirmar que `ssh deploy@IP_DO_VPS` ainda funciona.)

### 5.5 Firewall
```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
systemctl enable --now fail2ban
dpkg-reconfigure -plow unattended-upgrades   # responda "Yes"
```
> Se você escolher Docker + `ufw`: o Docker pode publicar portas por cima do ufw. Nossa configuração só publica 80 e 443 (Caddy), então está correta.

Saia do root (`exit`) e daqui em diante use **`ssh deploy@IP_DO_VPS`**.

---

## ETAPA 6 — Instalar o Docker (como `deploy`)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
exit
```
Entre de novo (`ssh deploy@IP_DO_VPS`) e teste:
```bash
docker --version && docker compose version
docker run --rm hello-world
```

---

## ETAPA 7 — Levar o código do GitHub para o servidor

Usaremos uma **deploy key** (chave só de leitura, só para este repositório).

1. No servidor:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/nexarpay_deploy -N "" -C "deploy-nexarpay"
cat ~/.ssh/nexarpay_deploy.pub
```
2. GitHub → repositório `nexarpay` → **Settings → Deploy keys → Add deploy key** → cole a chave → **NÃO** marque "Allow write access" → Add.
3. No servidor:
```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/nexarpay_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
git clone git@github.com:SEU_USUARIO/nexarpay.git
cd nexarpay && ls
```
(Responda `yes` na primeira conexão.)

---

> **Daqui para a Etapa 12 é só o Caminho A (demo).** Para produção, pule para a **Etapa P1**, no fim do guia.

## ETAPA 8 (DEMO) — Configurar a demonstração (`.env`)

Ainda em `~/nexarpay`:

### 8.1 Gerar o hash da senha do portão
Escolha uma senha para o portão (a que você dará aos clientes, ex.: 16+ caracteres):
```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'SENHA-DO-PORTAO-AQUI'
```
Ele imprime algo como `$2a$14$xxxxxxxx...` — copie.

### 8.2 Criar o `.env`
```bash
cp deploy/demo.env.example .env
nano .env
```
Preencha:
```
DEMO_DOMINIO=demo.SEUDOMINIO.com.br
DEMO_SENHA=UmaSenhaDemo2026            # senha dos usuários de demonstração (10+ caracteres, letras e números)
DEMO_EMAIL_DOMINIO=demo.SEUDOMINIO.com.br   # os logins serão admin@demo.SEUDOMINIO.com.br etc.
DEMO_ACESSO_USER=demo
DEMO_ACESSO_HASH=$$2a$$14$$xxxxxxxx...      # o hash do passo 8.1, trocando CADA "$" por "$$"
```
> ⚠️ O `$$` é obrigatório: o Docker Compose interpreta `$` como variável. Hash `$2a$14$abc` vira `$$2a$$14$$abc`.

Salve (`Ctrl+O`, Enter, `Ctrl+X`) e proteja:
```bash
chmod 600 .env
```

---

## ETAPA 9 (DEMO) — Subir o sistema

```bash
docker compose -f docker-compose.demo.yml up -d --build
docker compose -f docker-compose.demo.yml ps
docker compose -f docker-compose.demo.yml logs -f
```
- Aguarde a mensagem `Servidor em http://localhost:8765 [MODO DEMO]` (app) e o Caddy obtendo o certificado (`certificate obtained successfully`). `Ctrl+C` sai dos logs.
- Se o certificado falhar: confira se o DNS (etapa 4) já aponta para o IP e se as portas 80/443 estão liberadas.

### Testar
1. Abra `https://demo.SEUDOMINIO.com.br` → o navegador pede **usuário/senha do portão** (`demo` / a senha do 8.1).
2. Aparece a tela de login do NexarPay. Entre com `admin@demo.SEUDOMINIO.com.br` e a `DEMO_SENHA`.
3. Perfis disponíveis (todos com a mesma `DEMO_SENHA`): `admin@`, `diretor1@`, `diretor2@`, `financeiro@`, `gestor.ti@`, `gestor.criacao@`, `colaborador@`, `tv@` — todos `@demo.SEUDOMINIO.com.br`.
4. Sugestão de roteiro de demo: entre como `colaborador@` e crie uma solicitação → `diretor1@` aprova → `diretor2@` aprova → `financeiro@` encerra e baixa o recibo PDF → `admin@` mostra o Dashboard Gerencial.

> Em aba anônima, para cada perfil, ou use navegadores diferentes (a sessão é por navegador).

---

## ETAPA 10 (DEMO) — Backup e reinício automático da demo

```bash
crontab -e
```
Adicione (escolha o editor `nano` se perguntar):
```
30 3 * * *  VOLUME=nexarpay-demo_nexarpay-data /home/deploy/nexarpay/deploy/backup.sh
0 4 * * *   NEXARPAY_CONFIRMA_DEMO=1 /home/deploy/nexarpay/deploy/reset-demo.sh
```
- `backup.sh` guarda um .tar.gz diário do banco e anexos em `~/backups` (14 dias).
- `reset-demo.sh` zera a demo toda madrugada (dados voltam ao exemplo). **Se você quiser guardar o que foi feito na demo, não ative o reset.**
- Copie os backups para fora do servidor de tempos em tempos (`scp deploy@IP_DO_VPS:backups/*.tar.gz ~/Desktop/`), ou use o snapshot da Contabo.

---

## ETAPA 11 (DEMO) — Atualizar o sistema depois (rotina)

No Mac, após qualquer alteração:
```bash
git add . && git commit -m "descrição" && git push
```
No servidor:
```bash
cd ~/nexarpay && git pull && docker compose -f docker-compose.demo.yml up -d --build
```

---

## ETAPA 12 (DEMO) — Comandos úteis

| Ação | Comando |
|---|---|
| Ver logs do app | `docker compose -f docker-compose.demo.yml logs -f app` |
| Ver logs do Caddy | `docker compose -f docker-compose.demo.yml logs -f caddy` |
| Reiniciar | `docker compose -f docker-compose.demo.yml restart` |
| Parar tudo | `docker compose -f docker-compose.demo.yml down` (os dados ficam no volume) |
| Status | `docker compose -f docker-compose.demo.yml ps` |
| Espaço em disco | `df -h` |
| Tentativas de invasão bloqueadas | `sudo fail2ban-client status sshd` |

---

## Problemas comuns

| Sintoma | Causa provável / solução |
|---|---|
| `https://` dá erro de certificado | DNS ainda não propagou, ou nuvem laranja ligada no Cloudflare. Deixe cinza, aguarde e rode `docker compose -f docker-compose.demo.yml restart caddy`. |
| `variable is not set` ao subir | Falta preencher algo no `.env`. |
| Portão rejeita a senha certa | Faltou dobrar os `$` no hash (`$$`). |
| "Muitas tentativas" no login | Bloqueio temporário (por conta ou IP) após erros; aguarde 10–15 min. |
| Tela em branco / sem estilos | Cache do navegador (Ctrl+F5). |
| Perdi acesso SSH | Use o *VNC/Rescue* no painel da Contabo para recuperar. |

---

---

# CAMINHO B — PRODUÇÃO

> Pré-requisito: Etapas 1 a 7 concluídas (use um domínio como `pay.SEUDOMINIO.com.br` na Etapa 4, DNS **"somente DNS" / nuvem cinza**).
> Use o **compose de produção** (`docker-compose.yml`). Nunca use `docker-compose.demo.yml` com dados reais: ele liga o modo demo, que permite apagar todo o banco.

## ETAPA P1 — Conferir antes de subir (no seu Mac)

1. `git status` não pode listar `config.json`, `.env`, `data/` nem `seed/dados-iniciais-completos.json`.
2. Troque a senha de app do Google usada antes pelo sistema (Conta Google → Segurança → Senhas de app → **revogar** a antiga e **criar uma nova** só para o NexarPay). Ela é digitada só no servidor (P2).
3. Tenha à mão um gerenciador de senhas para guardar: a `APP_SECRET_KEY`, os códigos de recuperação do MFA e a chave de backup (P7).

## ETAPA P2 — Criar o `config.json` no servidor (antes de subir!)

O arquivo **não vai pelo Git** (tem a senha do SMTP). No servidor, dentro de `~/nexarpay`:
```bash
cp config.example.json config.json
nano config.json
chmod 600 config.json
```
Ajuste:
```json
{
  "porta": 8765,
  "dominio_permitido": "seudominio.com.br",
  "url_base": "https://pay.seudominio.com.br",
  "email": {
    "modo": "smtp",
    "host": "smtp.gmail.com", "porta": 465, "ssl": true,
    "usuario": "gpacpay@seudominio.com.br",
    "senha": "SENHA-DE-APP-NOVA",
    "remetente": "NexarPay <gpacpay@seudominio.com.br>"
  }
}
```
Opcional (valores padrão já são seguros): `"controles": {"bloquear_estouro_orcamento": true}` bloqueia, em vez de só avisar, solicitações acima do orçamento; `"seguranca": {"mfa_perfis": ["admin","financeiro","diretor"]}` define quem **deve** usar MFA; `"limites"` ajusta cotas de upload e limites de requisição.

## ETAPA P3 — Criar o `.env`

```bash
cp deploy/prod.env.example .env
nano .env
chmod 600 .env
```
Preencha:
```
APP_DOMINIO=pay.seudominio.com.br
APP_EMAIL_DOMINIO=seudominio.com.br
APP_ADMIN_EMAIL=voce@seudominio.com.br
APP_ADMIN_NOME=Seu Nome
APP_SECRET_KEY=            # gere com:  openssl rand -base64 36
CLAMAV_HOST=clamav
AV_OBRIGATORIO=1
```
> ⚠️ **Guarde a `APP_SECRET_KEY` no gerenciador de senhas agora.** Ela cifra credenciais e dados bancários no banco. Se for perdida, esses dados e os backups **não podem ser recuperados**. Não a envie por e-mail/WhatsApp e não a coloque no Git.

## ETAPA P4 — Subir

```bash
docker compose --profile av up -d --build
docker compose ps
docker compose logs app | head -20
```
- Nos logs do app deve aparecer `Antivírus: ClamAV em clamav (obrigatório)` e `[setup] Administrador inicial criado`.
- O ClamAV baixa as assinaturas no primeiro início (3 a 10 min). Até terminar, uploads respondem "verificação indisponível" (é o comportamento seguro). Acompanhe: `docker compose logs -f clamav` (procure "socket found, clamd started").
- Sem antivírus (não recomendado): deixe `CLAMAV_HOST=` e `AV_OBRIGATORIO=0` e use `docker compose up -d --build`.

## ETAPA P5 — Primeiro acesso e configuração inicial

1. Leia a senha provisória: `docker compose exec app cat /app/data/credenciais-iniciais.txt`
2. Abra `https://pay.seudominio.com.br`, entre com `APP_ADMIN_EMAIL` e a senha provisória, **crie a sua senha** (10+ caracteres, letras e números).
3. O sistema obriga o **MFA**: no celular, abra um aplicativo autenticador (Google/Microsoft Authenticator, Authy, 1Password), adicione uma conta **digitando a chave** mostrada, informe o código de 6 dígitos e **guarde os 8 códigos de recuperação** no gerenciador de senhas.
4. (O arquivo de credenciais é apagado ao trocar a senha.)
5. Configure, nesta ordem: **Propriedades** (departamentos, categorias, empresas, clientes) → **Configurações** (usuários: crie primeiro os Diretores, depois os demais, definindo Diretor 1 e 2 de cada um; Financeiro; TV) → **Orçamento** de cada departamento.
6. Em Configurações → E-mail, use **Enviar teste** e confirme que chegou.
7. Peça que cada usuário com perfil Admin/Financeiro/Diretor faça o primeiro login (eles cadastram o próprio MFA).

> Solicitações aprovadas **não podem ser excluídas** (registro financeiro). Por isso, faça testes de ponta a ponta na **demo**, não na produção; na produção, no máximo crie uma solicitação e devolva/reprove.

## ETAPA P6 — Verificar a publicação

```bash
curl -sI https://pay.seudominio.com.br | grep -iE "strict-transport|content-security|x-frame|x-content-type"
```
Devem aparecer os 4 cabeçalhos. Depois, no navegador:
- Cadeado válido e `http://` redirecionando para `https://`.
- Erre a senha 5 vezes de um usuário de teste: a 6ª tentativa deve mostrar o bloqueio temporário.
- Configurações → **Trilha de Auditoria** → *Verificar integridade* → "Integridade confirmada".
- (Opcional) teste de segurança externo gratuito: ssllabs.com/ssltest (esperado A ou A+).

## ETAPA P7 — Backup criptografado e fora do servidor

O `deploy/backup.sh` gera o backup diário do banco e dos anexos, **sem** a chave do sistema. Para criptografar e copiar para fora:

1. **No seu Mac**, gere o par de chaves de backup e guarde o arquivo no gerenciador de senhas:
```bash
brew install age
age-keygen -o ~/chave-backup-nexarpay.txt
```
Ele imprime `Public key: age1...` (a parte pública pode ficar no servidor; o arquivo inteiro **não**).

2. **No servidor**: `sudo apt -y install age` e crie `~/.nexarpay-backup.env`:
```bash
cat > ~/.nexarpay-backup.env <<'EOF'
BACKUP_AGE_RECIPIENT=age1COLE_AQUI_A_CHAVE_PUBLICA
BACKUP_DESTINO=usuario@servidor-de-backup:/pasta/nexarpay
EOF
chmod 600 ~/.nexarpay-backup.env
```
`BACKUP_DESTINO` é outra máquina (um segundo VPS, um NAS, um servidor da empresa) acessível por SSH com uma chave **sem senha criada só para isso** (`ssh-keygen -t ed25519 -f ~/.ssh/backup_nexarpay -N ""` e cadastre a `.pub` lá, preferencialmente restrita a `scp`).

3. Agende (como `deploy`): `crontab -e`
```
30 3 * * *  /home/deploy/nexarpay/deploy/backup.sh >> /home/deploy/backup.log 2>&1
```
4. **Teste o backup hoje** e **teste a restauração** (um backup que nunca foi restaurado não é backup):
```bash
~/nexarpay/deploy/backup.sh && ls -la ~/backups
```
**Como restaurar** (num servidor novo ou no mesmo, depois de subir o compose com a MESMA `APP_SECRET_KEY`):
```bash
# 1) trazer o arquivo do backup e descriptografar (no Mac, com a chave guardada)
age -d -i ~/chave-backup-nexarpay.txt nexarpay-AAAA-MM-DD.tar.gz.age > restaurar.tar.gz
scp restaurar.tar.gz deploy@IP_DO_VPS:~/
# 2) no servidor
cd ~/nexarpay && docker compose stop app
docker run --rm -v nexarpay_nexarpay-data:/d -v "$HOME":/b alpine sh -c 'find /d -mindepth 1 -delete && tar xzf /b/restaurar.tar.gz -C /d'
docker compose --profile av up -d
```
Confirme o login e a trilha de auditoria. **Ensaie a restauração na primeira semana e a cada trimestre.**

## ETAPA P8 — Atualizar o sistema (rotina)

No Mac: `git add . && git commit -m "descrição" && git push`. No servidor:
```bash
cd ~/nexarpay
~/nexarpay/deploy/backup.sh          # backup antes de atualizar
git pull
docker compose --profile av up -d --build
docker compose logs --tail=30 app
```
O banco se atualiza sozinho (colunas novas e cifragem de dados antigos acontecem na subida). Para voltar atrás: `git checkout <commit-anterior>` e repetir o `up --build`; se a versão nova já tiver alterado o banco, restaure o backup da véspera.
Uma vez por mês: `docker compose pull caddy clamav && docker compose --profile av up -d` (atualiza o proxy e o antivírus) e `sudo apt update && sudo apt -y upgrade`.

## ETAPA P9 — Operação do dia a dia

| Situação | O que fazer |
|---|---|
| Ver logs | `docker compose logs -f app` · `docker compose logs -f caddy` |
| Usuário perdeu o celular (MFA) | Configurações → editar usuário → marcar "Redefinir verificação em 2 etapas". Ele cadastra de novo no próximo login. |
| **Admin** perdeu o celular e os códigos | No servidor: `docker compose exec app python server.py --resetar-mfa admin@seudominio.com.br` |
| Esqueceu a senha | "Esqueci minha senha" na tela de login (link por e-mail, vale 30 min). |
| Suspeita de acesso indevido | Configurações → Trilha de Auditoria; cada usuário vê/encerra seus acessos em "Minhas sessões"; para derrubar um usuário, desative-o. |
| Integridade da auditoria | Uma vez por mês: Trilha de Auditoria → *Verificar integridade*. |
| Disco/saúde | `df -h` · `docker compose ps` · monitor externo grátis (UptimeRobot) em `https://pay.seudominio.com.br/` com alerta por e-mail. |
| Tentativas no SSH | `sudo fail2ban-client status sshd` |

## ETAPA P10 — Checklist de entrada em produção

- [ ] Etapas 1 a 7 feitas; SSH só com chave; firewall liberando apenas 22, 80 e 443; atualizações automáticas ligadas.
- [ ] DNS em "somente DNS" (nuvem **cinza**); HTTPS válido; cabeçalhos de segurança presentes (P6).
- [ ] `config.json` e `.env` com permissão 600, **fora do Git**; senha de app do Google **nova** (a antiga revogada).
- [ ] `APP_SECRET_KEY` guardada em gerenciador de senhas, **fora do servidor**.
- [ ] Antivírus ativo (`Antivírus: ClamAV ... (obrigatório)` no log).
- [ ] Administrador com senha própria e MFA cadastrado; **códigos de recuperação guardados**.
- [ ] Diretores, Financeiro e demais usuários criados; cada um com Diretor 1 e 2; todos de Admin/Financeiro/Diretor já cadastraram o MFA.
- [ ] E-mail de teste recebido.
- [ ] Backup diário **criptografado** e **copiado para fora**, e **restauração testada** (P7).
- [ ] Monitor de disponibilidade configurado.
- [ ] Combinado com a equipe: o que é a confirmação de senha, o bloqueio por tentativas e como pedir redefinição do MFA.

---

## Problemas comuns (produção)

| Sintoma | Causa provável / solução |
|---|---|
| `variable APP_... is not set` ao subir | Falta preencher algo no `.env` (APP_DOMINIO, APP_EMAIL_DOMINIO, APP_ADMIN_EMAIL, APP_SECRET_KEY). |
| `config.json` virou uma **pasta** | Você subiu o compose antes de criar o arquivo. `docker compose down`, `rm -rf config.json`, crie o arquivo (P2) e suba de novo. |
| Servidor não sobe e pede `NEXARPAY_ADMIN_EMAIL` | Banco novo sem o e-mail do primeiro administrador no `.env`. |
| Upload falha com "verificação antivírus indisponível" (503) | O ClamAV ainda está baixando as assinaturas (3 a 10 min no 1º start) ou não foi iniciado com `--profile av`. Veja `docker compose logs clamav`. |
| Tela pede "Confirme sua identidade" | É a confirmação de senha (e código do MFA) para ações sensíveis: usuários e backup. Vale por 10 min. |
| "Muitas tentativas a partir deste acesso" | Bloqueio temporário por IP + e-mail (1 a 30 min). Os outros acessos da conta não são afetados. |
| Usuário perdeu o celular do MFA | Admin: Configurações → editar o usuário → "Redefinir verificação em 2 etapas". Sem admin: P9. |
| Todos aparecem com o mesmo IP / "Muitas requisições" | Cloudflare com nuvem **laranja**. Mantenha **cinza** (Etapa 4). |
| Dados cifrados aparecem vazios depois de restaurar | `APP_SECRET_KEY` diferente da original. Use exatamente a mesma chave. |

---

## O que ainda NÃO está pronto (para vender para outras empresas)

O que está nesta publicação serve para **a Gpac usar com os próprios dados**. Para oferecer a **clientes externos**, ainda faltam (veja o `RELATORIO_SEGURANCA.md`):
1. **Multi-tenant** (isolar cada cliente), PostgreSQL e servidor de aplicação de produção.
2. Remover regras e nomes específicos da Gpac do código (empresas do rateio, logos, seeds) e parametrizar por cliente.
3. Valores monetários em centavos inteiros/`Decimal`; alçada de aprovação por valor.
4. SSO (OIDC/SAML), LGPD completa (contrato de operador, política de privacidade, retenção/exclusão, registro de incidentes), armazenamento de objetos para anexos.
5. Monitoramento e alertas centralizados, pipeline de CI com varredura de vulnerabilidades e **pentest externo** antes do lançamento comercial.
