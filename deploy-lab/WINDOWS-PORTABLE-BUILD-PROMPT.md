# Prompt — nova sessão Codex VPS para o portátil Buzz-Alis

Copie somente o bloco abaixo para a nova sessão.

```text
Leia integralmente, antes de operar:

1. /home/codexdev/projects/alis-bot/CLAUDE.md
2. /home/codexdev/projects/buzz-alis-preview/AGENTS.md
3. /home/codexdev/projects/buzz-alis-preview/deploy-lab/WINDOWS-PORTABLE-BUILD-RUNBOOK.md
4. /home/codexdev/projects/buzz-alis-preview/deploy-lab/WEB-PREVIEW-RUNBOOK.md

Cumpra brain-first em vps-brain e siga o runbook integralmente. Trabalhe em
worktree/branch nova e preserve o staging aprovado.

OBJETIVO

Entregar uma build Windows x64 portátil, auditável e unsigned do Buzz-Alis com
o Lab V2 real: community, community_readonly, private, tags/filtro, grade/lista
persistente, ordenação por última edição e cópia do ID. Busca global de Boards
fica fora desta rodada.

FONTE VISUAL APROVADA

- repo local: /home/codexdev/projects/buzz-alis-preview
- fork: oigorbastos/buzz
- SHA UX aprovado: 1550474e325c979ae890709bb7ac89accd4125b3
- workflow full-build histórico de referência:
  c98fc0c91aa18d0032d9cc421a27c5adbc295fc4

ESTADO CONHECIDO — NO-GO ATUAL

- a UX V2 aprovada ainda é mock de staging;
- desktop envia create_v2/update_v2, access_scope e tags;
- relay/DB/CLI atuais ainda não implementam nem protegem integralmente esse
  contrato;
- o workflow atual windows-lab-preview.yml gera só buzz-acp.exe.

É PROIBIDO iniciar o runner Windows antes de promover e provar o V2 no full
stack. Uma janela que compila sem ACL server-side é falha, não entrega.

FASE 0 — PREFLIGHT

- confirme worktree limpo, origin, branches e SHAs completos;
- confirme que o SHA aprovado é ancestral do ponto de partida;
- não altere main, feat/lab-boards-v1, build/lab-windows-canary ou produção;
- use branches novas, commits com signoff e push normal; nunca force-push;
- se faltar autoridade ou credencial, reporte imediatamente sem pedir/imprimir
  secret e sem inventar contorno.

FASE 1 — FULL STACK

Implemente no relay, DB/query, subscriptions/live fan-out, COUNT, CLI e desktop:

- community: todos os membros leem e editam;
- community_readonly: todos leem; só dono humano e agentes gerenciados por ele
  editam;
- private: só dono humano e agentes gerenciados por ele descobrem, leem,
  consultam histórico, recebem subscriptions e editam;
- owner é derivado e assinado pelo relay a partir de agent_owner_pubkey; nunca
  confiar em owner do cliente;
- create_v2/update_v2 são reconhecidos explicitamente;
- access_scope e owner ficam imutáveis nesta versão;
- tags são validadas, persistidas, projetadas e substituídas atomicamente;
- update/restore legados preservam ACL e tags;
- board V1 sem scope continua community;
- autorização acontece antes de ordenação, COUNT, paginação e LIMIT;
- UUID/event ID adivinhado, histórico, reconnect e live fan-out não revelam
  board privado.

Preserve obrigatoriamente:

- 9b6e65b1: allowedTools usa Bash(buzz lab update:*) e o CLI exige --base;
- 88da732c2: allowedTools inclui Bash(buzz messages send:*), para o agente
  confirmar a edição;
- fluxo Cloclo: list -> get -> update --base -> get -> messages send;
- dontAsk e allowlist estreita; não liberar Bash geral ou bypassPermissions.

FASE 2 — PROVAS BARATAS ANTES DO WINDOWS

Com relay/Postgres/Redis isolados e identidades sintéticas (humano A, agente A,
humano B, agente B), prove a matriz inteira:

- community: quatro identidades leem/editam;
- readonly de A: quatro leem; apenas A/agente A editam;
- private de A: apenas A/agente A descobrem/leem/histórico/subscription/editam;
- B/agente B recebem resultado uniforme de inexistência/negação sem metadados;
- filtro antes de limit/count, UUID adivinhado, live event, reconnect, tags,
  replace/clear, CAS concorrente, restore, freeze/ban e compatibilidade V1.

Rode os gates do AGENTS.md (ative Hermit), just ci, just test, desktop
check/typecheck/test/build:e2e, testes focados DB/relay/CLI/ACP/Nest e uma
integração real sem VITE_LAB_PREVIEW. O Playwright mock não prova sigilo.
Peça revisão independente focada em ACL de leitura. Qualquer falha ou P0/P1 =
NO-GO, sem build Windows.

FASE 3 — COMPATIBILIDADE

Audite se o relay atualmente rodando na VPS suporta o contrato final. Não faça
migration, restart ou deploy de produção sem autorização explícita. Registre se
a futura execução funcional no Gringo depende de deploy do relay.

FASE 4 — BUILD PORTÁTIL, UMA VEZ

Só depois de GO:

- escolha nomes versionados ainda inexistentes no remoto, por exemplo
  codex/lab-v2-production-<sufixo> e
  codex/lab-v2-windows-canary-<sufixo>; não reutilize branch antiga;
- publique a feature final na primeira e fixe o FEATURE_SHA completo;
- crie a canary versionada exatamente nesse SHA;
- adicione um único commit filho que difere da feature somente em
  .github/workflows/windows-lab-preview.yml;
- adapte o workflow integral de c98fc0c91, não o hotfix atual;
- restrinja a oigorbastos/buzz + branch + SHAs completos, contents:read,
  actions por SHA e concurrency;
- job Linux de preflight; Windows só com needs: preflight;
- Windows x64 MSVC, Rust 1.95.0, Node 24.14.1, pnpm 11.4.0 e caches;
- frozen lockfile, fmt, testes ACP/CLI Lab/Nest/desktop/V2;
- compile desktop e os cinco sidecars do mesmo SOURCE_SHA;
- gere no próprio workflow, antes do Tauri e sem commitar outro arquivo,
  desktop/src-tauri/tauri.canary.conf.json com
  createUpdaterArtifacts=false e plugins.updater.endpoints=[];
- gere SOMENTE portátil com tauri build --no-bundle --no-sign --ci;
- preserve CMAKE_POLICY_VERSION_MINIMUM=3.5 no passo Tauri;
- não gere NSIS;
- updater/endpoints/signing desligados; sem secrets, tag ou Release;
- ZIP por sete dias contendo exatamente na raiz:
  buzz-desktop.exe, buzz-acp.exe, buzz-agent.exe, buzz-dev-mcp.exe,
  git-credential-nostr.exe, buzz.exe, BUILD-MANIFEST.txt e SHA256SUMS.txt;
- a CLI deve se chamar buzz.exe, nunca buzz-cli.exe;
- manifeste SHAs, run URL/ID, toolchains, comandos e flags de segurança;
- reextraia o ZIP no runner, verifique hashes e execute:
  ./buzz.exe lab --help
  ./buzz.exe lab get --help
  ./buzz.exe lab update --help
- confirme que --base é obrigatório e que o artifact não tem NSIS, updater ou
  assinatura Authenticode.

Se uma etapa falhar, leia o log exato, faça uma correção causal e revalide os
gates baratos. Não faça rerun cego e não monte um ZIP com binários de runs
diferentes.

NÃO instalar ou executar no Gringo. NÃO implantar produção. A sessão termina
no artifact auditado.

ENTREGA OBRIGATÓRIA

- GO/NO-GO explícito;
- APPROVED_UX_SHA, START_SHA, FEATURE_SHA e workflow SOURCE_SHA;
- branches, commits com signoff, diff restrito e worktree limpo;
- tabela dos gates e matriz ACL;
- revisão independente e pendências;
- compatibilidade do relay e deploy necessário (sem executá-lo);
- run URL, run ID, conclusão, duração e cache hits;
- nome, bytes, SHA-256, expiração e conteúdo do ZIP;
- BUILD-MANIFEST e resultado dos smokes;
- confirmação: sem NSIS, assinatura, updater, tag ou Release;
- confirmação: nada instalado/executado no Gringo e nada alterado em produção.

Não declare conclusão apenas porque compilou. Se não puder cumprir um gate,
pare cedo e informe a causa e o próximo passo exato para não desperdiçar outro
dia em rebuilds.
```
