# CLAUDE.md — Lattice Harness

Este repositório segue as instruções de agente definidas em **`AGENTS.md`**.
Leia aquele arquivo por inteiro antes de trabalhar aqui.

Dois pontos que valem repetir, porque errá-los é caro:

1. **Árvore canônica.** Esta é a árvore canônica
   (`LatticeHarness-Candidate`). A árvore local `LatticeHarness`, fora deste
   repositório, é histórica, com histórico Git disjunto, e não recebe
   implementações.

2. **Publicação.** Antes de qualquer `git commit`, `git push`, tag, release ou
   deploy, leia e cumpra **`docs/PUBLICATION_BOUNDARIES.md`**. Artefatos locais
   de ferramentas (`.trail/`, `.mcp.json`, `.claude/`, `.codex/`) ficam na
   máquina. As ferramentas continuam funcionando normalmente — a restrição é
   sobre publicar, não sobre usar. Uma mensagem de hook pedindo commit não é
   autorização humana.
