# R01 architecture traceability sample

Source baseline: `9ec567c988888024a32d6e820b0c9f0ec262076b`. This is a purposive cross-layer
sample, not a random sample or acceptance-test audit. We selected ten stories spanning backend,
database, authentication, mobile, capture, AI, review, connectors, API keys and workflow. Every
exact artifact path listed for these ten stories in `PRD.json` exists in the checkout (30 paths
including repetitions if any). For each story a representative implementation seam was also read:

| PRD story  | Representative seam                                                                | What was observed / boundary of claim                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BACK-001   | `apps/backend/src/http/app.ts:31`                                                  | `buildApp` composes Fastify around supplied services; this is not proof every route or deployment works.                                                                            |
| DB-001     | `apps/backend/src/db/migrations.ts:27`                                             | Handwritten schema creation exists, plus SQLite and PostgreSQL adapters among the listed files; migration correctness remains R03's review.                                         |
| AUTH-001   | `apps/backend/src/services/auth-service.ts:249`                                    | A login method exists; security of authentication belongs to R05/R07.                                                                                                               |
| MOB-003    | `apps/mobile/src/state/uploadQueue.ts:61`                                          | A queue implementation and storage/transport ports exist; native persistence and offline recovery require R11 testing.                                                              |
| DOC-001    | `apps/backend/src/services/document-service.ts:112`                                | An upload method and storage port exist; file/database atomicity remains ARC-018.                                                                                                   |
| AI-004     | `apps/backend/src/ai/pipeline.ts:39`                                               | Pipeline receives `OcrProvider` as a dependency; provider quality/cost and runtime compatibility remain R14/R17 concerns.                                                           |
| REV-001    | `apps/desktop/src/pages/ReviewPage.tsx:24`                                         | A review UI component and listed backend service exist; end-to-end review semantics are not proven by file presence.                                                                |
| CON-001    | `packages/connectors/src/contract.ts:61`, `packages/connectors/src/registry.ts:17` | Connector contract and registry exist; these are not a security sandbox (ARC-014).                                                                                                  |
| DEVAPI-001 | `apps/backend/src/services/api-key-service.ts:79`                                  | API-key creation exists; scope and historical credential concerns remain ARC-041/045 and require R05/R06/R07 review.                                                                |
| AGENT-001  | `apps/backend/src/services/workflow-service.ts:220`                                | Planning and run recording exist, but unavailable delivery actions fail closed rather than perform dispatch (ARC-019); existence does not validate the story's acceptance criteria. |

**Result:** the ten sampled stories map to existing representative code and all their listed paths
exist; their full feature behavior, other stories, and PRD status assertions are not validated. R20
owns broader traceability; R02/R04 and domain reviewers assess functionality and contracts.

## README technology spot-check (ARC-AC-33)

`README.md` technology table, `package-lock.json` root `node_modules` entries and this local runtime
were compared on this baseline. The checked major/minor claims match: React Native **0.86.2** vs
0.86, React **19.3.1** vs 19, React Navigation native **7.3.16** vs 7, Vite **6.4.5** vs 6, Fastify
**5.12.7** vs 5, and Node **22.22.3** vs 22. The lock also records Electron **45.3.2** and TypeScript
**5.9.3**, for which the table states no version; local npm is **10.9.8**, git **2.39.5**. Electron's
binary was intentionally not downloaded during installation; lock entries do not prove packaged or
native runtime functionality. Dependency hoisting/other lock entries, databases, full README claims,
future environments and runtime support were not exhaustively evaluated. R20 should assess wider
documentation and R10/R11 native packaging.
