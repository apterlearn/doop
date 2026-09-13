# doop — agent working rules

Rules for AI agents editing this repository. `CLAUDE.md` is the context index; this file is how to
work here.

## Verification cost

- **NEVER run a full-project typecheck (`bun run typecheck`) or the full test suite
  (`bun run test`) while implementing.** They take tens of seconds and re-report failures you
  already know about. Do not run them per edit, per phase, or "just to be sure".
- Verify with the narrowest thing that can fail: the single test file you touched
  (`bunx vitest run tests/<file>.test.ts`), a one-off script that exercises the changed path, or a
  direct look at the running feature. One focused command per change.
- Full-project `bun run typecheck`, `bun run lint` and `bun run test` belong to the **final**
  verification pass before handing work over, and to CI. Run them once there, not before.
- Never re-run a check to confirm what the user already reported, and never re-audit an edit you
  just applied.

## Scope

- Edit only the files the change needs. Do not run repo-wide formatters, linters or codemods as
  part of a feature change.
- Match existing patterns in the file you are editing; do not introduce a second convention beside
  an existing one.
