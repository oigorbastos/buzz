# Buzz-Alis Lab V2 — runbook da build portátil Windows

- **Revisão:** 08/08/2026 (BRT)
- **Repositório:** `/home/codexdev/projects/buzz-alis-preview`
- **Fork:** `oigorbastos/buzz`
- **UX aprovada:** `1550474e325c979ae890709bb7ac89accd4125b3`
- **Workflow full-build de referência:** `c98fc0c91aa18d0032d9cc421a27c5adbc295fc4`

Este runbook produz um ZIP portátil Windows x64 do Buzz-Alis com o Lab V2
real. Ele não autoriza deploy do relay, alteração de produção, assinatura,
updater, tag, GitHub Release ou instalação no Gringo.

## 1. Estado inicial: NO-GO para build

O commit visual aprovado é um staging de UX. Neste ponto da história:

- `desktop/src/features/lab/api.ts` envia `op=create_v2`, `op=update_v2`,
  `access_scope` e tags `t`;
- o mock do navegador simula as ACLs;
- o relay ainda aceita somente o contrato V1 (`create`, `update`, etc.);
- `migrations/0029_lab_boards.sql` não persiste escopo, dono canônico ou tags;
- a CLI ainda não expõe o contrato V2;
- o workflow atual `.github/workflows/windows-lab-preview.yml` é um hotfix que
  compila somente `buzz-acp.exe`, não uma build portátil completa.

Portanto, compilar o HEAD atual pode gerar uma janela bonita, mas criação V2
será rejeitada e privacidade não estará protegida no servidor. **Não dispare o
runner Windows até concluir os gates 1 a 4.**

O staging web não conta como prova de sigilo. O próprio
`deploy-lab/WEB-PREVIEW-RUNBOOK.md` registra essa limitação.

O arquivo histórico
`/home/codexdev/projects/alis-bot/RUNBOOK-BUZZ-LAB-AGENT-WINDOWS-CANARY.md`
está superado: ele contém o antigo glob frágil de `update` e não preserva a
permissão de resposta `buzz messages send`. Não o use como fonte desta build.

## 2. Contrato aprovado desta rodada

### 2.1 Escopos

| Escopo | Descobrir e ler | Editar |
|---|---|---|
| `community` | todos os humanos e agentes membros | todos os humanos e agentes membros |
| `community_readonly` | todos os humanos e agentes membros | dono humano e agentes gerenciados por ele |
| `private` | somente dono humano e agentes gerenciados por ele | somente dono humano e agentes gerenciados por ele |

Para um agente gerenciado, o relay deriva o dono humano a partir do vínculo
criptograficamente comprovado já materializado em `users.agent_owner_pubkey`.
Nunca confie em um `owner` enviado pelo cliente. Um agente sem vínculo de dono
comprovado deve falhar fechado ao criar um board restrito.

Nesta versão, `access_scope` e dono são imutáveis depois da criação. Isso evita
uma transição de ACL incompleta. Alteração de escopo fica para uma rodada com
protocolo e auditoria próprios.

### 2.2 Tags e UX

- até 12 tags por board;
- até 32 caracteres por tag;
- normalização idêntica entre relay, CLI e desktop;
- `tags=replace` + tags `t` substitui o conjunto inteiro;
- update sem a intenção explícita de substituir tags preserva as atuais;
- restore preserva escopo, dono e tags do head atual;
- filtro por tag acontece somente sobre boards já autorizados;
- grade/lista, preferência persistente, cópia de ID e ordenação por última
  edição descendente permanecem como aprovados;
- busca global de Boards **não entra nesta build**. Os kinds do Lab continuam
  fora da busca geral até existir desenho de busca que aplique a ACL antes de
  ranking, contagem e limite.

### 2.3 Compatibilidade

- board V1 sem `access_scope` continua sendo `community`;
- `create_v2` exige um escopo válido e falha fechado em relay antigo;
- `update_v2` representa substituição explícita de tags;
- `update`/`restore` em board V2 aplicam a ACL do head e preservam seus
  metadados mesmo quando o cliente não conhece o V2;
- CAS continua obrigatório: `buzz lab update` exige `--base` obtido pelo
  mesmo `buzz lab get` usado para editar o snapshot.

## 3. Limites de autoridade e segurança

- Não tocar em `main` nem nas branches V1 remotas.
- Não usar force-push.
- Não recuperar, imprimir ou criar token/deploy key em conversa ou log.
- Não usar banco, chaves ou conteúdo de produção nos testes.
- Não executar migrations nem reiniciar/redeployar o relay da VPS sem nova
  autorização explícita do Igor.
- Não instalar ou executar o Buzz no Gringo durante a sessão de build.
- Não montar uma release juntando binários de runs diferentes.
- Não habilitar `bypassPermissions`, Bash geral, updater ou assinatura.
- Commits do Buzz devem usar `git commit -s` conforme `AGENTS.md`.
- Preserve mudanças de usuário e pare se encontrar worktree sujo sobreposto.

## 4. Gate 0 — orientação e fonte

Antes de alterar código:

1. Leia integralmente `/home/codexdev/projects/alis-bot/CLAUDE.md` e o
   `AGENTS.md` do Buzz (o `CLAUDE.md` do Buzz é um link para ele).
2. Faça brain-first em `vps-brain` para infra/MC.
3. Leia este runbook e `deploy-lab/WEB-PREVIEW-RUNBOOK.md`.
4. Confirme o estado real, sem assumir que os SHAs continuam iguais:

```bash
cd /home/codexdev/projects/buzz-alis-preview
. ./bin/activate-hermit
git status --short --branch
git remote -v
git rev-parse HEAD
git merge-base --is-ancestor \
  1550474e325c979ae890709bb7ac89accd4125b3 HEAD
git ls-remote --heads origin \
  refs/heads/feat/lab-boards-v1 \
  refs/heads/build/lab-windows-canary \
  'refs/heads/codex/lab-v2-production-*' \
  'refs/heads/codex/lab-v2-windows-canary-*'
```

O SHA visual aprovado ainda pode estar somente no clone local. Isso não é
motivo para descartá-lo nem para reconstruir a UX. Escolha um sufixo versionado
livre (por exemplo `20260808-1200`) e crie um worktree dedicado em uma branch
como `codex/lab-v2-production-<sufixo>`, a partir do HEAD local que contém o
SHA aprovado. Se houver branch com o mesmo nome, escolha outro sufixo; não a
apague nem a reutilize silenciosamente.

Registre no relatório:

- `APPROVED_UX_SHA`;
- `START_SHA`;
- branch/worktree usado;
- heads remotos encontrados;
- `git status` limpo.

## 5. Gate 1 — promover o V2 para o full stack

Arquivos prováveis, não lista exaustiva:

- nova migration após `0030_lab_board_d_tag_backfill.sql`;
- `crates/buzz-db/src/lab.rs`;
- `crates/buzz-relay/src/handlers/lab.rs`;
- caminhos genéricos de query, COUNT e fan-out/subscription do relay;
- `crates/buzz-cli/src/commands/lab.rs` e `crates/buzz-cli/src/lib.rs`;
- `desktop/src/features/lab/api.ts` e testes;
- testes de integração em relay/test-client;
- política ACP existente em `crates/buzz-acp`.

### 5.1 Persistência e projeção

A migration deve, no mínimo:

- persistir `access_scope`, dono humano canônico e tags de modo transacional;
- exigir dono para `community_readonly` e `private`;
- aplicar defaults/backfill V1 como `community` sem tornar boards antigos
  privados por acidente;
- indexar os campos usados pelos gates de leitura;
- manter o histórico append-only e o CAS atual.

No ingest:

- reconhecer `create_v2` e `update_v2` explicitamente;
- validar os valores fechados de escopo e os limites/normalização das tags;
- derivar o dono efetivo no servidor;
- ignorar ou rejeitar `owner` client-asserted, nunca assiná-lo como verdade;
- gravar head, revision, metadados e projeção no mesmo commit;
- projetar `access_scope`, `owner` e tags `t` no kind `30623`;
- aplicar a ACL do head antes de aceitar update/restore;
- preservar scope/owner/tags nos caminhos legados que não os enviam.

### 5.2 Leitura sem vazamento

Privacidade precisa valer para os kinds de head e de revision em todas as
superfícies Nostr/HTTP existentes:

- listagem por kind;
- consulta por `#d`/UUID;
- consulta direta por event ID;
- histórico;
- paginação e `limit`;
- `COUNT`;
- subscriptions existentes e live fan-out;
- reconnect/backfill;
- qualquer cache ou projeção intermediária.

A autorização ocorre **antes** de ordenação, contagem, paginação e limite.
Filtrar depois de `LIMIT` vaza atividade e também produz páginas incorretas.
Um principal sem acesso não pode distinguir “board privado existe” de “não
existe”: use resposta uniforme e não revele título, tags, revisão, timestamps,
autor, tamanho, existência ou frequência de atualização.

Não resolva isso apenas no React ou na CLI. O relay é a fronteira de confiança.

### 5.3 CLI e agentes

A CLI deve permitir:

- create com `--access community|community_readonly|private` (default
  `community`) e tags repetíveis;
- list/get mostrando escopo, dono e tags quando autorizados;
- update que preserva tags quando omitidas e oferece uma forma não ambígua de
  substituí-las/limpá-las;
- history/restore respeitando ACL e CAS;
- mensagens de erro sem oracle de existência.

Preserve os dois consertos já comprovados no Gringo:

- `9b6e65b1d5d050e16edbbcbfc02649327367f66e`: a allowlist Claude usa
  `Bash(buzz lab update:*)`, enquanto o Clap exige `--base`;
- `88da732c22991dbf66c2fee4b527e04818401f4e`: a allowlist também contém
  `Bash(buzz messages send:*)`, para o agente confirmar o resultado.

A Cloclo ainda usa a tool Bash internamente; o que foi corrigido é a execução
pré-autorizada e estreita em `dontAsk`, sem prompt de permissão. Não volte ao
glob frágil `Bash(buzz lab update * --base *:*)` e não amplie para Bash geral.

Fluxo obrigatório do agente:

```text
buzz lab list -> buzz lab get -> editar snapshot completo ->
buzz lab update --base <base-do-get> -> buzz lab get ->
buzz messages send (confirmação)
```

## 6. Gate 2 — matriz de segurança em relay isolado

Use identidades sintéticas: humano A, agente gerenciado por A, humano B e
agente gerenciado por B. Use Postgres/Redis/relay isolados; nada de produção.

| Caso | A | agente A | B | agente B |
|---|---:|---:|---:|---:|
| community: ler | PASS | PASS | PASS | PASS |
| community: editar | PASS | PASS | PASS | PASS |
| readonly de A: ler | PASS | PASS | PASS | PASS |
| readonly de A: editar | PASS | PASS | NEGADO | NEGADO |
| private de A: descobrir/ler | PASS | PASS | INVISÍVEL | INVISÍVEL |
| private de A: histórico/subscription | PASS | PASS | INVISÍVEL | INVISÍVEL |
| private de A: editar | PASS | PASS | NEGADO UNIFORME | NEGADO UNIFORME |

Também prove:

- UUID adivinhado não vira oracle;
- filtro ocorre antes de `limit` e `COUNT`;
- evento privado ao vivo não chega a subscriber não autorizado;
- reconnect não recupera evento privado estrangeiro;
- tags privadas não aparecem como opções de filtro para outro dono;
- replace/clear de tags é atômico;
- update concorrente com base antiga retorna conflito e preserva o vencedor;
- restore cria nova revisão e preserva metadados/ACL;
- board V1 continua community e editável pela comunidade;
- cliente V1 não remove ACL/tags de board V2;
- ban, membership e freeze continuam prevalecendo;
- desktop production mode funciona sem `VITE_LAB_PREVIEW` e sem mock.

Estenda `deploy-lab/roundtrip.sh` ou o test-client para deixar a prova
repetível. Teste Playwright do preview é complementar, não substituto.

## 7. Gate 3 — qualidade antes do Windows

Ative o Hermit e use os comandos definidos pelo repositório. No mínimo:

```bash
. ./bin/activate-hermit
just ci
just test
pnpm -C desktop check
pnpm -C desktop typecheck
pnpm -C desktop test
pnpm -C desktop build:e2e
cargo test -p buzz-acp
cargo test -p buzz-cli lab --lib
cargo test --manifest-path desktop/src-tauri/Cargo.toml managed_agents::nest
```

Inclua testes focados de DB/relay/ACL adicionados nesta rodada. Se um comando
não puder rodar na VPS, registre a causa concreta e rode-o num job Linux barato
antes do job Windows. Ausência de toolchain não transforma “não rodou” em PASS.

Peça revisão independente de segurança com foco em leitura antes de `LIMIT`,
fan-out e vínculo owner/agente. Qualquer P0/P1 aberto mantém NO-GO.

Faça commits pequenos e assinados (`git commit -s`). Ao final, publique por
push normal a branch versionada nova `codex/lab-v2-production-<sufixo>` e fixe
seu SHA completo como `FEATURE_SHA`. Não publique a branch de UX como se o
mock já fosse produção.

## 8. Gate 4 — compatibilidade do relay

Compare o `FEATURE_SHA` com o binário/config/migrations do relay que roda na
VPS. Produza uma resposta explícita:

- `relay atual compatível`: sim/não;
- migration/deploy necessários: quais;
- build portátil pode abrir contra o relay atual: sim;
- recursos V2 funcionarão contra o relay atual: sim/não.

**Não execute o deploy.** Se o relay atual for V1, a build ainda pode ser
gerada depois que o código e os testes isolados estiverem aprovados, mas o
handoff deve dizer claramente que o teste funcional V2 no Gringo depende de
uma rodada de deploy autorizada.

## 9. Gate 5 — workflow portátil econômico

O arquivo atual é hotfix-only. Use como referência de proveniência e
empacotamento a versão integral:

```bash
git show c98fc0c91aa18d0032d9cc421a27c5adbc295fc4:\
.github/workflows/windows-lab-preview.yml
```

Inspecione-a, mas adapte com `apply_patch`; não restaure cegamente. Nesta
rodada o artefato pedido é somente o portátil: **não gere NSIS**.

### 9.1 Branch imutável

1. Escolha outro nome remoto livre e crie
   `codex/lab-v2-windows-canary-<sufixo>` exatamente em `FEATURE_SHA`.
2. Adicione um único commit filho que altera somente
   `.github/workflows/windows-lab-preview.yml`.
3. Defina `LAB_BASE_SHA=$FEATURE_SHA` completo.
4. Antes do push, prove:

```bash
git merge-base --is-ancestor "$FEATURE_SHA" HEAD
git diff --name-only "$FEATURE_SHA" HEAD
```

O segundo comando deve imprimir somente:

```text
.github/workflows/windows-lab-preview.yml
```

Faça um único push normal. A branch é nova; não force, não reutilize um nome
já remoto e não use `build/lab-windows-canary`, cujo workflow atual é de
hotfix.

### 9.2 Estrutura do workflow

- restrito a `oigorbastos/buzz` e ao nome versionado exato da nova branch
  `codex/lab-v2-windows-canary-<sufixo>`;
- `permissions: contents: read`;
- actions fixadas por SHA;
- `SOURCE_SHA=${{ github.sha }}` e conferência do checkout completo;
- `LAB_BASE_SHA` ancestral e diff de um único workflow;
- `concurrency` para impedir dois builds simultâneos;
- job Linux de preflight; job Windows com `needs: preflight`;
- `windows-latest`, `x86_64-pc-windows-msvc`;
- Rust 1.95.0 + rustfmt, Node 24.14.1 e pnpm 11.4.0;
- caches Cargo e pnpm;
- `pnpm install --frozen-lockfile`;
- fmt, ACP, CLI Lab, Nest, desktop check/typecheck/test;
- todos os testes V2 relevantes antes de compilar release;
- sidecars: `buzz-acp`, `buzz-agent`, `buzz-dev-mcp`,
  `git-credential-nostr` e `buzz-cli`;
- `./scripts/bundle-sidecars.sh "$TARGET"` antes dos testes Nest/Tauri;
- passo anterior ao Tauri que gere, somente no runner, o arquivo não versionado
  `desktop/src-tauri/tauri.canary.conf.json`;
- o config canary não entra no commit: o diff canário continua sendo somente
  o workflow;
- Tauri portátil com `CMAKE_POLICY_VERSION_MINIMUM: "3.5"` no ambiente, sem
  bundle e sem assinatura;
- nenhuma variável `BUZZ_UPDATER_*`, `TAURI_SIGNING_*` ou secret;
- nenhuma tag, Release ou metadata de updater;
- retenção do artifact por sete dias.

O config canário gerado no runner deve conter exatamente:

```json
{
  "bundle": { "createUpdaterArtifacts": false },
  "plugins": { "updater": { "endpoints": [] } }
}
```

O comando Tauri é:

```bash
pnpm -C desktop tauri build \
  --target x86_64-pc-windows-msvc \
  --no-bundle \
  --no-sign \
  --ci \
  --config src-tauri/tauri.canary.conf.json
```

O `CMAKE_POLICY_VERSION_MINIMUM` é obrigatório porque o workflow Windows já
comprovado precisou dele; não o remova ao trocar NSIS por `--no-bundle`.

O `--no-bundle` é suportado pelo Tauri CLI 2.11 presente no lockfile. Se a
opção ou o path do executável divergir no runner, leia o log e corrija a causa;
não substitua automaticamente por NSIS.

### 9.3 Conteúdo obrigatório do ZIP

```text
buzz-desktop.exe
buzz-acp.exe
buzz-agent.exe
buzz-dev-mcp.exe
git-credential-nostr.exe
buzz.exe
BUILD-MANIFEST.txt
SHA256SUMS.txt
```

O nome da CLI é **`buzz.exe`**, nunca `buzz-cli.exe`. Os seis executáveis
ficam juntos na raiz do ZIP.

O manifest registra, no mínimo:

- `APPROVED_UX_SHA`, `FEATURE_SHA`, `LAB_BASE_SHA`, `SOURCE_SHA` e workflow;
- repository, ref, run ID e run URL;
- versão, target, runner e toolchains;
- comandos/gates executados;
- lista dos arquivos;
- `TAURI_BUNDLE=none`, `TAURI_SIGNING=disabled`,
  `CREATE_UPDATER_ARTIFACTS=false` e retenção.

`SHA256SUMS.txt` interno cobre os seis executáveis e o manifest, nunca a si
próprio. No envelope do artifact, inclua também um hash externo do ZIP.

### 9.4 Smokes no próprio runner

Depois de criar o ZIP, extraia-o novamente em outra pasta do runner, confira os
hashes e rode a CLI extraída:

```bash
./buzz.exe lab --help
./buzz.exe lab get --help
./buzz.exe lab update --help
```

O help de update deve mostrar `--base` como obrigatório. Valide também que os
seis `.exe` existem, que não há NSIS/updater e que o PE não tem assinatura
Authenticode. Não tente abrir a GUI no runner como prova de UX.

Em caso de falha, leia o passo e o log exatos. Faça uma correção causal por
vez; não dispare rerun cego nem monte artefato com binários antigos.

## 10. Handoff para teste no Gringo

A sessão de build termina entregando o ZIP, não o executando. Informe ao Igor:

- run URL/ID e conclusão;
- `FEATURE_SHA` e workflow `SOURCE_SHA`;
- nome, tamanho em bytes, SHA-256 e expiração do ZIP;
- conteúdo e manifest verificados;
- status do relay V2;
- confirmação de que nada foi instalado/executado no Gringo e nada foi
  implantado em produção.

Para o teste manual posterior:

1. baixar o ZIP pelo GitHub;
2. conferir o SHA-256 antes de extrair;
3. extrair em pasta nova versionada, sem sobrescrever a build funcional;
4. manter os seis executáveis juntos;
5. fechar a build antiga e abrir `buzz-desktop.exe`;
6. esperar o SmartScreen por ser unsigned e usar “Mais informações” apenas
   depois de conferir o hash;
7. manter a pasta antiga para rollback;
8. não apagar os dados/configuração do Buzz, que ficam fora do ZIP.

Smoke funcional quando o relay V2 estiver implantado:

- criar um board community, um read-only e um private;
- confirmar tags/filtro, grade/lista, ordenação e cópia do ID;
- testar visibilidade com duas identidades;
- pedir à Cloclo uma edição Markdown com bullet e sub-bullet;
- confirmar ausência de prompt de permissão, incremento de revisão e resposta
  final da Cloclo no DM.

## 11. Critério de conclusão

A tarefa só está concluída com todos os itens abaixo:

- GO full-stack documentado;
- matriz ACL real aprovada;
- revisão independente sem P0/P1;
- `FEATURE_SHA` remoto e imutável;
- diff canary restrito ao workflow;
- job Linux e job Windows verdes;
- ZIP reextraído, hashes e smokes aprovados;
- status de compatibilidade/deploy do relay explícito;
- nenhuma assinatura, updater, NSIS, tag ou Release;
- nenhum deploy de produção nem execução no Gringo pela sessão.

“Compilou” não significa “privacidade pronta”. Se algum gate falhar, entregue
NO-GO rapidamente, com a causa e o próximo passo exato, sem iniciar a build
cara.
