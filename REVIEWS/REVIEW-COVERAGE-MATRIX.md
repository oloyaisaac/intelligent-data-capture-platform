# REVIEW COVERAGE MATRIX

**Programme:** Independent Software Quality Review of `intelligent-data-capture-platform`
**Reviewed commit:** `fb57508` (merge of PR #11)
**Review date:** 2026-11-15
**Total reviewers:** 22 · **Completed:** 21 · **Blocked:** 1

---

## 1. Reviewer summary

| # | Reviewer | Assigned domains | Examined | Items | Tests run | Not run | C | H | M | L | Status |
|---|----------|------------------|----------|-------|-----------|---------|---|---|---|---|--------|
| R01 | Software Architect | Layering, imports, config, workspace graph | All 9 artefacts | 42 | 8 | 1 | 0 | 0 | 2 | 2 | ✅ Complete |
| R02 | Backend Engineer | 101 routes, 18 services, error envelope | 8 files sampled across all domains | 38 | 7 | 0 | 0 | 2 | 2 | 0 | ✅ Complete |
| R03 | Database Engineer | 32 tables, 29 indexes, 2 drivers | All DDL + both drivers | 50 | 8 | **1 (PostgreSQL)** | 1 | 1 | 2 | 1 | ✅ Complete |
| R04 | API & Contract Engineer | OpenAPI, 101 ops, validators | Spec + validator + mutation tests | 37 | 7 | 0 | 0 | 1 | 1 | 2 | ✅ Complete |
| R05 | Authentication Engineer | Passwords, tokens, MFA, reset | 5 files + 5 suites | 60 | 10 | 1 | 0 | 2 | 2 | 1 | ✅ Complete |
| R06 | Authorisation & Tenancy | 5 roles, 143 predicates | Guards + all repositories | 42 | 7 | 1 | 0 | 0 | 3 | 1 | ✅ Complete |
| R07 | Application Security | Deps, Electron, CSP, SSRF, uploads | 8 surfaces | 80 | 11 | 1 (pen test) | 0 | 4 | 2 | 0 | ✅ Complete |
| R08 | Privacy / DPO | DSAR, erasure, retention, egress | 6 files + legal | 62 | 9 | 0 | 0 | 2 | 3 | 0 | ✅ Complete |
| R09 | Desktop Renderer | 14 pages, client, realtime | All pages + built bundle | 52 | 9 | 3 | 1 | 2 | 1 | 1 | ✅ Complete |
| R10 | Electron Packaging | Shell, preload, builder, signing | 5 artefacts | 65 | 10 | 1 | 0 | 5 | 1 | 0 | ✅ Complete |
| R11 | Mobile Engineer | 5 screens, capture, queue | All modules | 55 | 10 | 4 (device) | 1 | 1 | 3 | 0 | ✅ Complete |
| R12 | UX / Product Design | 14 pages, 65 controls | All pages | 55 | 8 | 2 (usability) | 0 | 1 | 3 | 1 | ✅ Complete |
| R13 | Accessibility & i18n | 647 keys ×3, ARIA, RTL | All components + CSS | 60 | 12 | 2 (AT, contrast) | 0 | 2 | 3 | 1 | ✅ Complete |
| R14 | AI / Document Intelligence | Pipeline, extraction, providers | 7 files | 54 | 9 | 3 (no binary) | 0 | 2 | 3 | 0 | ✅ Complete |
| R15 | Integration / Connectors | 8 connectors, registry, signing | All connectors + tests | 56 | 10 | 6 (live) | 0 | 2 | 3 | 0 | ✅ Complete |
| R16 | QA / Test Architecture | 30 suites, 406 tests, validators | Full suite + validators | 60 | 11 | 2 | 1 | 3 | 2 | 0 | ✅ Complete |
| R17 | Performance & Scalability | Upload, batch, DB, dashboard | Hot paths | 46 | 9 | 5 (no PG/load) | 1 | 1 | 4 | 0 | ✅ Complete |
| R18 | Reliability & Observability | Jobs, sweeps, logs, backups | Worker + maintenance | 63 | 11 | 3 | 0 | 4 | 2 | 0 | ✅ Complete |
| R19 | DevOps / SRE | CI, deploy, runbooks | CI + deployment docs | 78 | 13 | 1 | 1 | 3 | 2 | 1 | ✅ Complete |
| R20 | Documentation | 24 docs, 34 DECs, 45 stories | All documents | 49 | 10 | 1 | 0 | 0 | 5 | 1 | ✅ Complete |
| R21 | Compliance & Legal | 6 legal docs, DSAR, licence | All legal + code | 52 | 10 | 1 | 0 | 5 | 3 | 0 | ✅ Complete |
| R22 | UAT & Commercial | 9 preconditions, 10 journeys | **Blocked at preconditions** | 50 | **9 precondition audits** | **ALL journeys** | 2 | 2 | 2 | 0 | ⛔ **BLOCKED** |

**Totals: 1,206 checklist items assigned · 8 CRITICAL · 45 HIGH · 54 MEDIUM · 12 LOW = 119 findings**

---

## 2. Coverage by feature area

Every product feature was assigned to at least one reviewer; most to two or more from different disciplines.

| Feature area | Primary | Secondary | Examined? | Evidence quality |
|---|---|---|---|---|
| HTTP API (101 routes) | R02 | R04, R06 | ✅ Yes | **Strong** — read + suite |
| Database schema (32 tables) | R03 | R17 | ✅ Yes | **Strong static, ⛔ no PG run** |
| SQLite driver | R03 | R02 | ✅ Yes | **Strong** — executed |
| PostgreSQL driver | R03 | R19 | ⚠️ Static only | ⛔ **Never executed** |
| Authentication | R05 | R07 | ✅ Yes | **Strong** |
| Multi-tenancy | R06 | R07 | ✅ Yes | **Strong** — 143 predicates, 5 negative tests |
| Password reset | R05 | R19 | ✅ Yes | ⛔ **Verified broken in prod** |
| MFA | R05 | R12 | ✅ Yes | **Strong**, not enforceable |
| API keys | R06 | R04 | ✅ Yes | **Partial** — scoping inconsistent |
| Desktop renderer | R09 | R12, R13 | ✅ Yes | **Strong** — read + bundle grep |
| Desktop packaging | R10 | R19 | ✅ Yes | ⛔ **No installer ever built** |
| Electron shell security | R07 | R10 | ✅ Yes | **Strong** — full read |
| Mobile app | R11 | R12 | ⚠️ Source only | ⛔ **Cannot build** |
| Capture / edge detection | R11 | R14 | ✅ Yes | ⛔ **Non-functional** (no worklets) |
| Offline queue | R11 | R18 | ✅ Yes | **Unit only** |
| AI extraction | R14 | R16 | ✅ Yes | ⛔ **Accuracy unmeasured** |
| Document classification | R14 | — | ✅ Yes | ⛔ **Unmeasured** |
| OCR providers | R14 | R19 | ✅ Yes | ⛔ **Binary absent** |
| Cloud AI | R14 | R08 | ✅ Yes | **Strong** — gated, audited |
| Connectors (8) | R15 | R04 | ✅ Yes | ⛔ **6/8 never live** |
| Google Sheets | R15 | — | ✅ Yes | ⛔ **Breaks after ~1 h** |
| Marketplace | R15 | R07 | ✅ Yes | **Partial** — first-party only |
| Export (Excel/CSV) | R02 | R17 | ✅ Yes | **Strong** |
| Retention / purge | R08 | R18, R03 | ✅ Yes | **Partial** — residue untracked |
| Erasure (DSAR) | R08 | R21 | ✅ Yes | ⛔ **Incomplete + silent failure** |
| Audit log | R08 | R18 | ✅ Yes | **Partial** — reads not logged |
| Realtime / SSE | R09 | R02 | ✅ Yes | **Partial** — no live region |
| i18n (3 locales) | R13 | R12 | ✅ Yes | **Excellent** — 647×3 parity |
| RTL | R13 | R12 | ✅ Yes | **Strong** — 13 languages |
| Accessibility | R13 | R12 | ✅ Yes | **Partial** — no axe, no live region |
| Performance | R17 | R18 | ⚠️ Reasoning only | ⛔ **No measurement possible** |
| Reliability | R18 | R02 | ✅ Yes | **Strong** — job machine verified |
| Observability | R18 | R19 | ✅ Yes | ⛔ **No metrics, no alerts** |
| CI pipeline | R19 | R16 | ✅ Yes | **Strong** |
| Deployment | R19 | R10 | ✅ Yes | ⛔ **No artefact exists** |
| Documentation | R20 | — | ✅ Yes | **Strong** — 34/34 DECs resolve |
| Legal pack | R21 | R08 | ✅ Yes | **Partial** — 13 placeholders |
| Compliance posture | R21 | R08 | ✅ Yes | ⛔ **No pen test, no licence** |
| Billing | R22 | — | ✅ Yes | ⛔ **Not implemented** |
| User acceptance | R22 | R12 | ⛔ **Blocked** | ⛔ **0/9 preconditions** |

---

## 3. What could NOT be verified, and why

This is the most important table in the matrix. Every entry is a limitation of the review, not a claim of absence.

| Unverified item | Reviewer | Why it could not be verified | What would unblock it |
|---|---|---|---|
| **PostgreSQL migrations** | R03, R17, R19 | No `psql`, no Docker, no PG service in review environment | `postgres:16` CI service container |
| **Packaged desktop sign-in** | R09, R10 | No display, no packaged artefact, no signed installer | `electron-builder --dir` + xvfb |
| **Mobile app on device** | R11 | No Android SDK, no Xcode, no `android/` or `ios/` | Native project scaffolding |
| **6 of 8 connectors** | R15 | No MySQL/PG servers, no Sheets OAuth, no CRM sandboxes | Sandbox accounts + service containers |
| **OCR execution** | R14 | `tesseract` binary absent | Install in image (needs OPS-001) |
| **Extraction accuracy** | R14, R22 | No labelled corpus exists | Build corpus of ~200/type |
| **All performance numbers** | R17 | No load tool, no dataset, no PG | k6 + seeded data + PG |
| **Accessibility with AT** | R13 | No display, no NVDA/VoiceOver | Manual session with AT |
| **Contrast ratios** | R13 | No rendering environment | axe + manual |
| **Usability / SUS / value** | R12, R22 | No participants; product unrunnable | Runnable product + pilot |
| **Restore drill** | R18 | No backup tooling, no backup | Backup script + rehearsal |
| **Alert delivery** | R18 | No metrics, no notification channel | `/metrics` + Alertmanager |
| **Penetration test** | R07, R21 | No vendor engaged | Commission external test |
| **Legal sufficiency** | R21 | Requires licensed Ugandan counsel | Advocate review |
| **Mutation score** | R16 | No Stryker installed | `npm i -D @stryker-mutator/core` |
| **Multi-replica behaviour** | R01, R02 | Single-process constraint prohibits it | Out of scope by DEC-029 |

---

## 4. Tests completed vs remaining

| Category | Completed | Remaining |
|---|---|---|
| Full suite execution | ✅ 406/406, 30 suites | — |
| Coverage measurement | ✅ 74.47 % stmts / 58.75 % branches | Mutation testing |
| Contract validators | ✅ 4/4 executed + 1 mutation seeded | Response-shape assertion |
| Config/schema validation | ✅ All parsed | — |
| Dependency audit | ✅ 8 prod advisories classified | Post-remediation re-audit |
| Git history scan | ✅ Clean | Entropy-based scan |
| SQL/logic inspection | ✅ 22 domains | — |
| Database execution (PG) | ⛔ None | Full migration + suite |
| End-to-end execution | ⛔ None | Packaged app, mobile, API smoke |
| Load testing | ⛔ None | All benchmarks |
| Security exploitation | ⛔ None | Pen test |
| User acceptance | ⛔ None | Pilot |

---

## 5. Completion statement

- **22 reviewers assigned.** All 22 executed their analysis.
- **21 produced complete findings.** 1 (R22) is correctly reported as **blocked** rather than fabricated — its preconditions failed 9/9.
- **1,206 checklist items** from the briefs were addressed or explicitly recorded as unverifiable.
- **119 findings** were recorded with reproducible evidence.
- **16 categories of verification were impossible** in this environment, each with a stated reason and a stated unblocking condition.

Neither this matrix nor the master report claims the repository is secure or reliable. It claims something narrower and checkable: **what was examined, what was found, and what could not be established.**
