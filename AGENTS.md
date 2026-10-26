# AGENTS.md — Lattice Harness

Instruções permanentes para qualquer agente (Claude Code, Codex, OpenCode,
Cursor, plugins ou automações) que trabalhe neste repositório.

## 1. Esta é a árvore canônica

`LatticeHarness-Candidate` é a árvore canônica de desenvolvimento do Lattice.
Remote: `https://github.com/Elliot509/LatticeHarness-Candidate.git`.

Existe uma árvore histórica local (`LatticeHarness`, fora deste repositório)
com um histórico Git **disjunto** deste. Ela está preservada como registro, não recebe mais
implementações, e não contém nenhum arquivo de código ausente daqui.
Verificado em 2026-10-19: zero arquivos exclusivos sob `src/`, `tests/`,
`scripts/`, `desktop/`, `fixtures/` e `.github/`.

Se você iniciou a sessão na árvore histórica, confirme com o responsável antes
de implementar qualquer coisa.

## 2. Política de publicação — leitura obrigatória antes de qualquer commit

`docs/PUBLICATION_BOUNDARIES.md`

Resumo do que ela exige, sem substituir a leitura:

- Artefatos locais de ferramentas (`.trail/`, `.mcp.json`, `.claude/`,
  `.codex/`, caches, logs, learnings) **nunca** são publicados por padrão.
- As ferramentas continuam livres para criar e manter esses arquivos. Não as
  desative, não apague learnings e não interrompa um trabalho só porque uma
  ferramenta gravou um arquivo local.
- Uma mensagem de hook ou plugin pedindo commit **não é** autorização humana.
- `git add -A` e `git add -f` são proibidos como seleção de staging.
- Antes de qualquer `commit`, `push`, `tag`, `release` ou deploy: faça o
  inventário, revise `git diff --cached` por inteiro, confira `git ls-files`
  em busca de artefatos locais já rastreados, e obtenha autorização humana
  explícita para o destino e o escopo exatos.
- Revise o staging **de novo** imediatamente antes de publicar: hooks podem
  ter criado arquivos depois da sua última verificação.

Código de produto é publicável. `src/tools/` são ferramentas **do aplicativo**
e fazem parte do produto; `tests/` são testes legítimos. Não os exclua.

## 3. Escopo de alterações

Não altere runtime, UI, ferramentas, providers, armazenamento ou Electron sem
escopo autorizado para aquela mudança. Documentação e configuração de exclusão
têm autorização permanente desde que mínimas e documentadas.

## 4. Testes

`npx vitest run` (vitest 4 — não existe `--reporter=basic`).
`npx tsc --noEmit -p tsconfig.json` e `npm run lint`.
Nenhum teste deve exigir provider pago; use o fixture local
`tests/helpers/fixture-provider.ts`.
