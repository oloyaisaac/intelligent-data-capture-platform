# Contributing

Thanks for helping build IDCP. This guide covers how to propose, build and land a change.
If you are an AI agent, read `AI.md` as well — it is binding.

---

## 1. Before you start

1. Read `README.md` for the product and `PRD.json` for the plan.
2. Find or request a story ID. Work is tracked by story, not by vague intent.
3. Check `AGENT_STATE.md` so you do not duplicate work.
4. Confirm the story's dependencies are `done` and no open question blocks it (`PRD.json.openQuestions`).

## 2. Branch naming

```
<type>/<story-id>-<short-slug>
```

Examples: `feat/PAIR-001-qr-pairing-session`, `fix/EXPORT-002-csv-quoting`, `docs/FOUND-002-doc-pack`.

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`.

Rules: one story per branch; never commit directly to `main`; keep branches short-lived; rebase rather than merge `main` into your branch where practical.

## 3. Commit messages

Conventional Commits, with the story ID:

```
feat(pairing): generate single-use QR pairing session (PAIR-001)

- pairing_sessions table + migration
- POST /api/v1/pairing/sessions with 2-minute expiry
- tests for expiry and reuse
```

- Subject in the imperative mood, ≤ 72 characters, no trailing period.
- Body explains **why**, not just what.
- One logical change per commit; tests with the code they cover.
- Never commit secrets, `.env`, generated files or large binaries.

## 4. Coding standards (summary — details in `AI.md` §5)

- TypeScript `strict`; no `any` in application code.
- Shared types live in `packages/shared`; never duplicate a type across apps.
- Validate every boundary with Zod.
- Small, single-purpose functions; no business logic in UI components; no vendor SDK types outside adapters.
- All user-facing strings from the i18n catalogue.
- Structure code where `ARCHITECTURE.md` §6 says it goes; never import across `apps/*`.

## 5. Tests

- New behaviour needs tests. Bug fixes need a regression test that fails before the fix.
- Run before pushing: `npm run typecheck && npm run lint && npm test`.
- Add or update manual cases in `TESTING.md` when you add a user-visible flow.
- Never commit real customer documents or personal data in fixtures.

## 6. Pull requests

**Title:** `feat(pairing): single-use QR pairing session (PAIR-001)`

**Description must include:**

- Story ID and a link to it in `PRD.json`.
- What changed and why.
- How it was tested — commands run and results, plus manual checks.
- Screenshots or a short recording for UI changes.
- Anything not done, and any follow-up stories needed.
- Confirmation that docs were updated (`API.md`, `DATABASE.md`, `ARCHITECTURE.md`, `CHANGELOG.md` as applicable).

**Checklist (all required):**

- [ ] Acceptance criteria in `PRD.json` are satisfied and referenced.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass.
- [ ] New behaviour has tests; bug fix has a regression test.
- [ ] No secrets, credentials or personal data in the diff.
- [ ] `.env.example` updated if configuration was added.
- [ ] Docs updated; `CHANGELOG.md` entry under `Unreleased`.
- [ ] `PRD.json` status and `AGENT_STATE.md` / `TASKS.md` updated.
- [ ] Diff is focused — no unrelated formatting churn.

## 7. Review process

- At least one review approval is required; two for security-sensitive areas (`auth`, `authz`, `pairing`, connectors, crypto, uploads).
- Reviewers check: correctness against acceptance criteria, security implications, tests, naming and docs — not just style (the linter handles style).
- Review comments are resolved or explicitly deferred with a follow-up story.
- Squash-merge into `main` with the PR title as the commit subject.
- The author marks the story `done` in `PRD.json` after merge, and updates `AGENT_STATE.md`.

## 8. Security and data

- Report vulnerabilities privately to the owner, not in an issue.
- Follow `SECURITY.md`; never lower a security control for convenience. If a control must change, record a decision in `DECISIONS.md`.
- Any change to authentication, authorisation, pairing, connector credentials or upload handling requires a second review.

## 9. Documentation duties

| If you…                                | update                         |
| -------------------------------------- | ------------------------------ |
| add/change an endpoint or socket event | `API.md`                       |
| change schema or migrations            | `DATABASE.md`                  |
| add a service, package or data flow    | `ARCHITECTURE.md`              |
| choose between alternatives            | `DECISIONS.md`                 |
| change a requirement or story          | `REQUIREMENTS.md` / `PRD.json` |
| change tooling or setup steps          | `ENVIRONMENT.md`               |
| change the release process             | `DEPLOYMENT.md`                |

## 10. Getting unblocked

- Ambiguous requirement → ask the owner; do not guess silently.
- Blocked by a decision → mark the story `blocked` in `PRD.json` with the reason and the question ID.
- Contradictory docs → fix the docs and say so in the PR.

## 11. License

Contributions are made under the project licence (`LICENSE`). Unless stated otherwise, you confirm you have the right to submit the work.
