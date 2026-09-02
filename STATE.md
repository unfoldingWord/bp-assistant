# STATE.md — bp-assistant

What this project **is**: the durable gotchas, lessons, and human blockers that
do not live in code or git history. Read it before non-trivial work. Never a
session log — what you just did belongs in the commit message and PR body.

## Gotchas

- **Windows `npm test` baseline.** On a Windows checkout, 15 tests fail on an
  untouched `origin/main` for environment reasons (hardcoded `/srv/bot/app`
  paths, POSIX ownership checks, path separators): `aligned-batch-merge`,
  `ownership-sweep`, `tqs-routing`, `self-diagnosis`, `tn-quick-api`,
  `api-runner-provider-regressions`, plus three in `pipeline-regressions` /
  `tn-tools`. Compare failing test *names* against a clean baseline worktree
  before chasing them; do not "fix" them in a feature PR.
- **Workspace paths are env-driven.** Pipeline code resolves everything against
  `CSKILLBP_DIR` (default `/srv/bot/workspace`) and reads the merged Door43
  clones from `DOOR43_REPOS_PATH` (default `/srv/bot/workspace/door43-repos`).
  Set both to scratch dirs for offline replays; neither exists on a laptop.
- **dotenv 17 prints a "tip" line to stdout on every `require`.** Filter it out
  of scripted output; it is not a pipeline message.
- **Hebrew compares must NFC-normalize first.** Byte-wise quote checks have
  failed on visually identical strings more than once.

## Lessons learned

- **See-how pointers are deterministic (decision 2026-09-02).** The recurrence
  index (`src/workspace-tools/recurrence-index.js`) and `runSeeHowDetection`
  in `src/notes-pipeline.js` implement the rule: same-chapter repeats fold into
  the first note's "This also occurs in verses …" sentence; the first
  occurrence in a chapter of a phrase noted in an earlier chapter points to the
  phrase's **first** occurrence in the book (never the nearest, never a chain);
  never forward, never at nothing. The LLM must never write pointers. Cross-book
  pointers are unfoldingWord/bp-assistant#367.
- **Published corpus reference points for see-how share:** 9.1% of all notes;
  JOS 13%, GEN 16%, 2KI/PRO ~25%. Zechariah's 13 published pointers are all
  same-chapter, so under the rule they become "also occurs" lists, not pointers.
- **UHB span reconstruction is not always exact.** ~1–1.5% of aligned spans
  cannot be located in the UHB verse and fall back to a space-join (counted in
  `counts.inexactSpans`). Those quotes may fail `syncCanonicalHebrewQuotes`.

## Escalated

- None.
