# NexarPay — Tudo Sob Controle. — Grupo Gpac

Evolução do sistema *Gestão Financeira – T.I.*: além do dashboard, lançamentos e orçamento, o NexarPay traz **solicitações de pagamento com fluxo de aprovação em 3 etapas**, **recibo de aprovação em PDF**, **orçamento por departamento**, **dashboard gerencial para a diretoria**, **login por e-mail corporativo** e **notificações por e-mail**.

Tudo roda em um **servidor Python local** (somente biblioteca padrão — nada para instalar além do Python 3.8+) com banco **SQLite** em arquivo. Uma máquina da empresa sobe o servidor; todos acessam pelo navegador.

## Estrutura da pasta

| Item | O que é |
|---|---|
| `server.py` | Servidor (API + interface). É o único programa a executar. |
| `config.json` | Configuração: porta, domínio de e-mail permitido, URL usada nos e-mails, SMTP. Criado automaticamente na 1ª execução em modo *simulado*. |
| `config.example.json` | Exemplo de configuração com SMTP do Google Workspace preenchido. |
| `static/` | Interface (HTML, CSS, JS, logos). |
| `seed/` | Dados iniciais (lançamentos e orçamento T.I. das planilhas). `dados-iniciais-completos.json` contém senhas/seriais — **não distribua**. |
| `data/` | Criada na 1ª execução: `gpacpay.sqlite` (banco), `uploads/` (anexos), `recibos/` (PDFs). **Faça backup desta pasta.** |
| `legado/` | Versão anterior (arquivo único `index_v1.html`) para consulta. |
| `iniciar_mac.command` / `iniciar_windows.bat` | Sobem o servidor e abrem o navegador. |

## Como colocar no ar

1. Escolha a máquina que ficará como servidor (fica ligada no horário de trabalho) e copie a pasta inteira para ela.
2. **macOS:** dois cliques em `iniciar_mac.command` (se bloquear, botão direito → Abrir). **Windows:** dois cliques em `iniciar_windows.bat`. Manual: `python3 server.py` dentro da pasta.
3. Na 1ª execução com banco novo, defina o e-mail do primeiro administrador: `NEXARPAY_ADMIN_EMAIL=voce@seudominio.com.br python3 server.py`. O sistema cria **só esse administrador** (sem usuários nem dados de exemplo), com senha provisória em `data/credenciais-iniciais.txt` (arquivo apagado quando ele trocar a senha). Para dados de exemplo, apenas em demonstração, use `NEXARPAY_DEMO=1`. O `config.json` é gerado automaticamente.
4. Descubra o IP da máquina (ex.: `192.168.0.10`) e passe aos usuários o endereço `http://192.168.0.10:8765`. Coloque esse mesmo endereço em `"url_base"` no `config.json` — ele é usado nos links dos e-mails.
5. Configure o e-mail (abaixo) e reinicie o servidor.

> Para que o endereço não mude, fixe o IP da máquina servidora no roteador/DHCP. Se quiser um nome amigável (ex.: `http://nexarpay:8765`), cadastre-o no DNS interno.

## E-mail (Google Workspace)

Em `config.json`, bloco `"email"`:

```json
"email": {
  "modo": "smtp",
  "host": "smtp.gmail.com", "porta": 465, "ssl": true,
  "usuario": "gpacpay@grupogpac.com.br",
  "senha": "senha de app gerada no Google",
  "remetente": "NexarPay <gpacpay@grupogpac.com.br>"
}
```

- Crie (ou use) uma caixa do Workspace para o sistema e gere uma **senha de app** (Conta Google → Segurança → Verificação em duas etapas → Senhas de app).
- Com `"modo": "simulado"` nada é enviado: os e-mails ficam registrados em **Configurações → E-mail**, onde é possível ler o conteúdo (útil para testes e para ver a senha provisória).
- **Configurações → Enviar teste** valida a configuração.

E-mails enviados pelo sistema: aviso ao aprovador em cada etapa · **APROVADA** (após o Diretor 2) com os dados da solicitação · **requer ATENÇÃO** (alteração solicitada) · **REPROVADA** · **pagamento autorizado com o Recibo PDF anexo** (após o Financeiro) · senha provisória · boas-vindas de novo usuário.

## Login e segurança

- Login **somente por e-mail** `@grupogpac.com.br` (domínio configurável em `dominio_permitido`). Só e-mails desse domínio podem ser cadastrados.
- **Esqueci minha senha**: o usuário informa o e-mail, recebe uma senha provisória e é obrigado a criar uma nova no próximo login.
- Senhas guardadas apenas como hash (PBKDF2-SHA256 com salt). Sessão de 12 h renovada a cada uso. Senha mínima de 10 caracteres (letras e números). Bloqueio temporário por IP e por conta após tentativas erradas. Tokens de sessão guardados como hash.

## Perfis

| Perfil | Acesso |
|---|---|
| **Administrador** | Tudo, sem restrição. |
| **Diretor(a)** | Dashboard Gerencial (filtro por departamento), Solicitações (aprovar / alterar / reprovar), consulta a Lançamentos e Orçamento. |
| **Gestor(a)** | Dashboard do(s) seu(s) departamento(s), Solicitações, lançamentos manuais, acompanhamento e envio de documentos fiscais. Pode ter mais de um departamento. |
| **Colaborador(a)** | Solicitações de pagamento, acompanhamento e envio de documentos fiscais. |
| **Financeiro** | Mesma visão do Diretor(a) + etapa final (Encerrar / Reprovar). |
| **RH** | Parecido com o Gestor(a): dashboard e orçamento do próprio departamento (+ bloco com todos os Freelancers), pode fazer solicitações de qualquer módulo e **aprova somente a etapa do RH do módulo Freelancer** (informando contratação e onboarding). Não lança manualmente nem vê senhas. |
| **Dashboard (TV)** | Acesso somente ao **Dashboard (TV)** — um painel de leitura, sem nenhuma outra página do sistema. Vê todos os departamentos (como Diretor/Financeiro), mas não pode criar, editar ou aprovar nada. Pensado para ficar sempre aberto numa televisão/monitor: cada usuário escolhe (botão **Personalizar**) quais blocos exibir e em que ordem, e a página se atualiza sozinha a cada 15–300s (configurável) buscando os dados mais recentes do servidor — sem precisar de nuvem nem de infraestrutura extra, só o mesmo servidor local do NexarPay. |

No cadastro de cada usuário (Configurações) definem-se os **departamentos** e o **Diretor(a) 1** e **Diretor(a) 2** que aprovarão as solicitações dele (não se aplica ao perfil Dashboard (TV), que não participa de aprovações).

## Solicitações de pagamento

Botão **NOVA SOLICITAÇÃO** → tipo **CLIENTE/FORNECEDOR**, **REEMBOLSO** ou **GRUPO GPAC**, cada um com seu formulário (campos obrigatórios marcados com *, valor com máscara R$, anexos PDF/DOCX/XLSX/PNG/JPEG até 20 MB; no Reembolso o recibo/nota é obrigatório).

Fluxo: **Solicitação → Aprovação 1 (Diretor 1) → Aprovação 2 (Diretor 2) → Financeiro → Encerrado.**

## Relatórios

Menu **Relatórios** (Admin, Diretoria, Financeiro, Gestor e RH; Colaborador e Dashboard TV não emitem). Diretoria e Financeiro veem todos os departamentos; Gestor e RH, só os seus (o RH também vê os Freelancers).

| Relatório | O que traz |
|---|---|
| **Solicitações** | Tudo o que foi solicitado no período, com filtro de situação (pedido concluído, reprovado, em andamento, devolvido), módulo, departamento, empresa e busca. Mostra só valores dos pedidos (gasto = concluídos), sem orçamento. |
| **Orçado × realizado** | Por departamento e categoria: orçado, realizado, em aprovação, saldo e % consumido. |
| **Rateio por empresa** | Orçado, realizado e saldo de cada empresa (gasto do grupo dividido pelo rateio), por empresa ou por categoria e empresa. |
| **Aprovações e prazos** | Tempo por etapa, quem está segurando e solicitações paradas. |
| **Agenda de pagamentos** | O que vence em 7, 15, 30, 60 ou 90 dias (pela data de pagamento), com atrasados. |
| **Documentos fiscais pendentes** | Quem deve NF/recibo, dias de atraso e bloqueios. |

"Realizado" = solicitação encerrada pelo Financeiro; o ano vem da data de pagamento. Cada relatório sai em tela, **Excel (.xlsx)** e **PDF**, e pode ser **enviado por e-mail** (para você e até 5 e-mails do domínio) ou **agendado todo mês** (use períodos relativos como "Mês anterior"). Cada usuário pode **salvar filtros** (com as colunas escolhidas); o Administrador define as **colunas padrão do cliente** por relatório. Exportações, envios e agendamentos ficam na auditoria; os arquivos temporários dos e-mails ficam em `data/relatorios/` e são apagados após 2 dias. `python3 server.py --relatorios-agendados` roda os envios agendados na hora.

**Módulo Freelancer** (autônomos, até 31 dias): **Solicitação → Aprovação 1 → Aprovação 2 → RH → Financeiro → Encerrado.** Término anterior a hoje: só a Diretoria faz o pedido. A NF deve ser anexada até a data de término; depois disso, sem NF, o solicitante fica bloqueado de novos pedidos de Freelancer (o Financeiro pode remover a NF e reativar o bloqueio). O sistema revisa as NFs pendentes todos os dias às 9h e avisa por e-mail (`python3 server.py --alertas-nf` executa a revisão na hora).

- **Aprovar** avança a etapa. **Alterar** e **Reprovar** exigem justificativa (registrada no histórico e enviada ao solicitante).
- **Alterar** devolve ao solicitante; ao reenviar, a solicitação volta para a **Aprovação 1** (conforme o fluxograma). Para voltar à etapa que pediu a alteração, use `"reenvio_retorna_para_aprovacao1": false` no `config.json`.
- **Reprovar** encerra o processo.
- A solicitação não pode ser editada; só **excluída** pelo solicitante enquanto não houver a 1ª aprovação. Só é alterável quando um aprovador pedir alteração — e toda alteração fica no histórico (com o antes/depois de cada campo).
- Cada solicitação mostra a **barra de status** (5 etapas, com nome e data de quem movimentou) e o **histórico completo**.
- Ao **encerrar** (Financeiro): gera o **Recibo de Aprovação (PDF)**, envia por e-mail ao solicitante, **cria o lançamento** no departamento (abatendo do orçamento) e abre o prazo do documento fiscal.

**Documento fiscal após o encerramento** — GRUPO GPAC: 7 dias corridos (Nota Fiscal ou Invoice) · CLIENTE/FORNECEDOR: 3 dias (Nota Fiscal ou Recibo Fiscal) · REEMBOLSO: 1 dia (Nota, Cupom Fiscal ou Recibo). Vencido o prazo sem anexo, o solicitante fica **bloqueado** para novas solicitações com a mensagem *"Atenção!!! Bloqueio devido a falta do envio do documento fiscal. Verifique seus lançamentos já aprovados"* até anexar.

Como o gasto entra no orçamento: GRUPO GPAC usa a **Categoria** escolhida; REEMBOLSO usa a **Categoria da Despesa**; CLIENTE/FORNECEDOR entra na categoria de lançamento **"Cliente/Fornecedor"**. Em *Orçamento → editar categoria* vincula-se cada categoria orçamentária às categorias de lançamento.

## Orçamento por departamento e dashboards

- Cada departamento tem orçamento próprio por ano (categorias → linhas → cenários; um cenário aprovado por linha).
- **Dashboard** (Gestor/Admin): orçamento × gasto do departamento selecionado.
- **Dashboard Gerencial** (Diretoria/Financeiro/Admin): orçamento anual total aprovado, gasto até o momento, saldo, consumo, valores comprometidos em solicitações abertas, projeção de fechamento, cards e gráficos por departamento; clicando em um departamento abre o detalhe.
- Filtro de período (6 meses / 12 meses / ano inteiro) recorta os últimos meses **dentro** do ano fiscal escolhido.

## Dados de teste (somente com NEXARPAY_DEMO=1)

Departamentos: **T.I.** (orçamento real 2026 das planilhas), **Administrativo**, **Criação**, **Desenvolvimento** (orçamentos fictícios 2026) e **Financeiro**.

Na **primeira execução** o sistema cria os usuários de cada perfil (admin@, diretor1@, diretor2@, financeiro@, gestor.ti@, gestor.criacao@, colaborador@, tv@) com **senhas aleatórias**, mostradas uma única vez no console e gravadas em `data/credenciais-iniciais.txt` (acesso só do dono). Leia, troque as senhas e **apague o arquivo**. Não existem mais senhas fixas no código.

**Antes de usar de verdade:** troque as senhas (ou exclua os usuários de teste), cadastre os usuários reais com seus diretores e revise as listas em *Propriedades* (Clientes, Categorias de Reembolso, Empresas do Grupo).

## Backup

- **Configurações → Exportar backup** gera um `.json` com todo o banco (exceto os arquivos anexados, que estão em `data/uploads` e `data/recibos`).
- Para backup completo, copie a pasta `data/` inteira (com o servidor parado ou durante a madrugada).
- **Importar backup** aceita o `.json` do NexarPay (substitui tudo) e também o backup do sistema antigo (entra no departamento T.I.).
- **Restaurar exemplo** apaga tudo e volta aos dados de teste.

---
Sistema gerado em 17/08/2026 · atualizado em 25/08/2026 (login e perfis) · 11/09/2026 (senhas com hash, dados sensíveis fora do HTML) · **13/09/2026 — NexarPay v2.0** (servidor Python, solicitações e aprovação, recibo PDF, orçamento por departamento, dashboard gerencial, login por e-mail, recuperação de senha, notificações) · **28/09/2026** (espaçamento padronizado no Dashboard Gerencial; novo perfil **Dashboard (TV)** com painel customizável e atualização automática) · **23/10/2026 — rebrand para NexarPay** (novo nome, slogan "Tudo Sob Controle.", logos e paleta de cores em azul).


## Publicação para demonstração (Docker + HTTPS)
Veja `docker-compose.yml` e a pasta `deploy/`:
1. `cp deploy/demo.env.example .env` e preencha domínio, senha dos usuários de demo e o hash do portão de acesso.
2. `docker compose up -d --build` — Caddy emite o HTTPS automaticamente; o app não expõe porta própria.
3. Zerar a demo: `deploy/reset-demo.sh` (agende no cron, ex.: diariamente às 4h).
Variáveis: `NEXARPAY_DEMO`, `NEXARPAY_DEMO_SENHA`, `NEXARPAY_HTTPS`, `NEXARPAY_TRUST_PROXY`, `NEXARPAY_URL_BASE`, `NEXARPAY_DOMINIO`, `NEXARPAY_HOST`.
**Use somente dados fictícios na demo.** Multi-cliente (multi-tenant), criptografia de campos e conformidade LGPD ainda não foram implementados.

## RH 1 / RH 2, Freelancer recorrente e Rescisões
- **Usuário RH**: no cadastro marque **RH 1** (aprova Freelancer e Rescisão, pode alterar "Recorrente") e/ou **RH 2** (acompanha o Freelancer recorrente). RH sem marcação não aprova nada.
- **Freelancer** não recorrente: Solicitante > Aprov. 1 > Aprov. 2 > RH 1 > Financeiro. **Recorrente**: ... > RH 1 > RH 2, sem Financeiro. O RH 2 ajusta valor/término (motivo + anexo obrigatórios) e encerra; o valor vira gasto realizado.
- Faltando 7 dias (ou menos) para o término, o sistema avisa na tela e envia e-mail diário a RH 1 e RH 2 (rotina das 9h, `--alertas-nf`).
- **Rescisões**: solicitam RH 1, RH 2 e Financeiro. Fluxo: RH 1 > Aprov. 1 > Aprov. 2 > Financeiro. Visível só para Diretoria, Financeiro, RH 1/RH 2 e o solicitante; sem cobrança de documento fiscal.
