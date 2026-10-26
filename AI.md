# AI Development Instructions

Binding rules for any AI coding agent (and human contributor) working in this repository.

**Read this file before you write a single line of code.**

---

## 0. Startup ritual — do this every session

1. Read `PRD.json` — especially `currentState`, the story you intend to work on and its `acceptanceCriteria`.
2. Read `AGENT_STATE.md` — find out where the previous session stopped.
3. Read `TASKS.md` — the current queue.
4. Skim `DECISIONS.md` — do not re-litigate settled decisions.
5. Read the relevant section of `ARCHITECTURE.md`, `DATABASE.md` or `API.md` for the area you are touching.
6. Confirm the story's `dependsOn` entries are `done`. If not, stop and report it.

Skipping this ritual is the most common cause of duplicated or conflicting work.

## 1. Hard rules

1. **Never delete or rewrite existing functionality without approval.** Refactors that change behaviour require an explicit request.
2. **Work on one story at a time.** Identify the story ID (`PAIR-002`) in commits and in `AGENT_STATE.md`.
3. **Test before marking done.** A story is only `done` when its acceptance criteria are verified, not when the code compiles.
4. **Never invent credentials, API keys, URLs or customer data.** If a secret is needed, add a placeholder to `.env.example` and ask.
5. **Never commit secrets.** No `.env`, no private keys, no tokens, no customer documents. See `SECURITY.md`.
6. **Ask before destructive changes** — dropping tables, rewriting migrations, force-pushing, deleting files, changing the data model incompatibly.
7. **Do not change `PRD.json` scope silently.** You may update statuses; adding/removing stories or acceptance criteria needs owner approval.
8. **No placeholder code left behind.** No `TODO` implementation, no fake success paths, no silently swallowed errors. If something cannot be finished, mark the story `blocked` with the reason.
9. **Do not add heavy dependencies without recording a decision** in `DECISIONS.md`.
10. **Never send customer document content to a third-party service** unless that provider is approved (see `PRD.json` Q-001) and recorded in `DECISIONS.md`.

## 2. Working loop

```
pick story from TASKS.md / PRD.json
        ↓
set status = in_progress in PRD.json + AGENT_STATE.md
        ↓
read acceptance criteria, write a test plan (TESTING.md)
        ↓
implement in small commits
        ↓
run: typecheck → lint → tests → build
        ↓
verify each acceptance criterion manually if needed
        ↓
update docs (API.md / DATABASE.md / ARCHITECTURE.md / CHANGELOG.md)
        ↓
set status = done, update AGENT_STATE.md + TASKS.md
```

If the session ends early, **still** update `AGENT_STATE.md` with what is done, what is half-done, what is broken and the exact next action.

## 3. Status vocabulary

Use exactly these values in `PRD.json` and `AGENT_STATE.md`:

| Status        | Meaning                                                         |
| ------------- | --------------------------------------------------------------- |
| `done`        | Meets all acceptance criteria, tested, documented.              |
| `in_progress` | Actively being built; may be partially working.                 |
| `pending`     | Not started.                                                    |
| `blocked`     | Waiting on a dependency, decision or access. Always state what. |
| `deferred`    | Deliberately pushed out of the current phase.                   |

Never mark `done` because "the code is written". Never leave `in_progress` without a note.

## 4. Definition of done

- [ ] All acceptance criteria in `PRD.json` verified.
- [ ] Tests added and passing (unit; integration where the change crosses a boundary).
- [ ] `npm run typecheck`, `npm run lint`, `npm test` clean — no new warnings.
- [ ] No secrets or personal data in the diff; `.env.example` updated if config was added.
- [ ] Docs updated: `API.md` for endpoints/events, `DATABASE.md` for schema, `ARCHITECTURE.md` for structure.
- [ ] `CHANGELOG.md` entry added under `Unreleased`.
- [ ] `PRD.json` status updated; `AGENT_STATE.md` and `TASKS.md` reflect reality.
- [ ] Commits reference the story ID.

## 5. Coding conventions

**Language and types**

- TypeScript everywhere (`strict: true`). No `any` in application code; use `unknown` and narrow.
- Shared types and schemas live in `packages/shared` — never duplicate a type in two apps.
- Runtime validation with Zod at every boundary (HTTP, socket, storage, AI provider output).

**Structure**

- Small functions with a single purpose; prefer pure functions for logic and thin adapters for I/O.
- One exported concept per file where practical. Co-locate tests next to source (`foo.ts`, `foo.test.ts`).
- No business logic in UI components; no vendor SDK types outside their adapter folder.
- Do not duplicate code — extract to `packages/shared` or a local module the second time you write it.

**Naming**

- Files: `kebab-case.ts` for modules; React components `PascalCase.tsx`.
- Variables and functions: `camelCase`, descriptive and unabbreviated (`extractedFields`, not `ef`).
- Database: `snake_case` tables (plural) and columns.
- Booleans read as predicates: `isPaired`, `hasLowConfidence`.

**Errors and logging**

- Never swallow errors. Wrap at boundaries and return typed results or throw typed errors.
- Error messages must be actionable and safe for users (no stack traces, no internal IDs).
- Log with structure and a request ID; never log document contents, tokens or personal data.

**UI**

- Every user-facing string comes from the i18n catalogue — no hardcoded copy.
- Every interactive element needs a label, focus state and keyboard path (desktop) or accessible label (mobile).
- Loading, empty, error and offline states are part of the component, not an afterthought.

**Git**

- Conventional Commits: `feat(mobile): add QR scan screen (PAIR-002)`.
- One story per branch/PR. Keep diffs reviewable.
- Never force-push shared branches. Never rewrite published migrations.

## 6. Security non-negotiables

- Authorise every request server-side, and scope every query to the caller's organisation.
- Store device credentials in secure storage; store connector credentials encrypted.
- Validate and sniff uploads; enforce size limits.
- Rate limit authentication, pairing, upload and export endpoints.
- Audit every privileged action.
- When in doubt, refuse and ask.

## 7. Documentation duties

| When you…                                 | Update                                   |
| ----------------------------------------- | ---------------------------------------- |
| add or change an endpoint or socket event | `API.md`                                 |
| change the schema or a migration          | `DATABASE.md`                            |
| add a service, package or data flow       | `ARCHITECTURE.md`                        |
| make a technical choice with alternatives | `DECISIONS.md`                           |
| ship anything                             | `CHANGELOG.md` (Unreleased)              |
| change story state                        | `PRD.json`, `TASKS.md`, `AGENT_STATE.md` |
| add configuration                         | `.env.example`, `DEPLOYMENT.md`          |
| add a test procedure                      | `TESTING.md`                             |

## 8. Stop conditions — stop and ask a human

- A story's acceptance criteria conflict with an existing decision.
- A requirement is ambiguous enough that two implementations are plausible.
- Work requires a paid account, credential or provider approval.
- The change would break backwards compatibility of the API, data model or connector contract.
- You would need to modify `LICENSE`, billing or legal text.
- You find a security issue (report it per `SECURITY.md`, do not exploit it further).

## 9. Tone for reports

When reporting back, be concrete: story ID, files changed, commands run with results, what is verified, what is not, and the next action. Never claim something works that you did not run.
