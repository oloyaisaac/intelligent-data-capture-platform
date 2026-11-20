# R01 completion status — engineering inventory, not sign-off

R01 is **not complete**. All checkboxes and the named, dated independent architect's G1/G8
assessment in `docs/reviewers/R01-software-architect.md` remain unsigned. This is an engineering
inventory of known work, not an exhaustive independent review or an authorized exception. It must
be refreshed against the final reviewed commit; a blank or unchecked reviewer item is not a pass.

## Every R01 passing condition

| Condition                                  | Current evidence and remaining work                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — SQL boundaries                        | Literal scans and repository seams are interim evidence; review all hits, dynamic SQL and the final commit independently.                                                                                                                                               |
| P2 — environment boundaries                | Static scans/config centralization are interim evidence; examine all runtime and CLI entry points and justify exceptions.                                                                                                                                               |
| P3 — workspace import boundaries           | The workspace map and scans exist, but final import and dynamic dependency boundaries still need independent verification.                                                                                                                                              |
| P4 — acyclic graphs                        | A prior Madge scan found zero cycles; rerun on the final commit, review graph coverage and independently verify the workspace graph.                                                                                                                                    |
| P5 — single composition root               | **Unmet/unresolved.** Service composition improved, but database, HTTP and offline CLI entry points also construct adapters. Resolve the literal requirement or obtain a written, dated authorized exception.                                                           |
| P6 — no duplicate work                     | **Unmet.** Claims/publication are partially guarded and age-only recovery removed, but ownership, crash recovery, external OCR/billing and file effects are not fenced or exactly once. Design and test the supported protocol on both databases and real processes.    |
| P7 — process-local state                   | The inventory is explicitly incomplete; finish all application, library, timer, resource and OS state, limits and replica consequences, and replay T-04.                                                                                                                |
| P8 — connector cannot crash host           | **Unmet.** Same-privilege children can kill the host; injected registries can run in-process. POSIX process-group cleanup is best effort, not a sandbox. Implement and adversarially validate the enforced security/resource/network boundary on supported deployments. |
| P9 — architecture documentation            | Some drift and sandbox claims were corrected, but the entire shipped architecture and cross-document claims need a final, independent sweep and documentation replay.                                                                                                   |
| P10 — ADR citations                        | Earlier tracked-Markdown scan found no missing cited decisions; rerun at final commit and inspect coverage and ADR implementation assessments.                                                                                                                          |
| P11 — complete evidence and owners         | Required layer map, graph, ADR register, drift, state, commands and findings exist only as interim material. Complete them against the final commit, provide reproducible evidence and assign actual accountable owners.                                                |
| P12 — no unexcepted critical/high findings | **Unmet.** High findings listed below remain open and have no accepted, written, dated owner exceptions. Close them with evidence or obtain legitimate exceptions under the gate rules.                                                                                 |

## Every currently recorded open finding

| Finding        | Remaining issue                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ARC-013 HIGH   | Owned worker recovery, fencing, crash boundaries and external effects; offline operator assertions do not prove liveness or idempotence.                                                                                                   |
| ARC-014 HIGH   | Connector host/process security isolation and resource, filesystem and network restrictions.                                                                                                                                               |
| ARC-015 MEDIUM | Broader adapter composition and entry-point boundary, including the literal P5 requirement.                                                                                                                                                |
| ARC-016 HIGH   | Historical connector-run error leakage, retained copies and independent security assessment.                                                                                                                                               |
| ARC-017 HIGH   | Connector errors, successful outputs, logging and injected/same-privilege code boundaries.                                                                                                                                                 |
| ARC-018 HIGH   | Upload storage/database atomicity, ambiguous commits, orphan reconciliation and recovery effects.                                                                                                                                          |
| ARC-019 HIGH   | Workflow send/export/notification now fail closed, but actual dispatch and historical false-success review remain; coordinate the R02/product fix.                                                                                         |
| ARC-020 MEDIUM | Documentation/handoff and localization drift; finish cross-document and UI review.                                                                                                                                                         |
| ARC-021 HIGH   | Bounded shutdown, forced kill, ownership, effect fencing and maintenance across replicas.                                                                                                                                                  |
| ARC-022 HIGH   | Remote calls are now counted and limited per document on current-version workers, but the cost configuration is still only a warning, not a monetary budget; historical calls, provider pricing, bypasses and billing verification remain. |
| ARC-023 HIGH   | Existing connector secrets require authorized migration, production verification, historical-copy/rotation assessment and security review.                                                                                                 |
| ARC-024 HIGH   | Complete retention/erasure policy, old soft-deletes, page files, derived records, file/DB races, references, backups, reconciliation and proof of deletion.                                                                                |
| ARC-025 HIGH   | Historical worker error logs, records and events plus other application/provider logging require exposure assessment and remediation.                                                                                                      |
| ARC-026 HIGH   | Interrupted and historical export files, publication/audit races, writer fencing and authorized reconciliation; inventory is advisory only.                                                                                                |
| ARC-027 HIGH   | Current-version database-only deletion and approval are transactional; reviewed protocol-1 matched runs can be cancelled without replay. Historical records, mixed versions, repeated evaluation and external effects remain unresolved.   |
| ARC-028 HIGH   | Batch exception text was persisted and returned; current responses mask legacy values, but historical rows, exports, logs and backups need authorized exposure assessment and remediation. Other error boundaries remain unaudited.        |

These are the currently recorded findings, not a claim that no other defects exist. Owners and gate
chairs must determine whether fixes or permitted, written and dated exceptions satisfy P12.

## Required runtime and operational evidence

- T-01/T-02: rerun the complete boundary sweep and cycle checks on the final clean commit.
- T-03: demonstrate the required two-worker workload without duplicate work and include claim,
  live pause, crash, recovery, stale resume, publication and external-effect failure boundaries.
- T-04: finish the multi-replica state inventory and actual replica observation; current tests show
  selected process-local differences, not exhaustive coverage.
- T-05: test connector faults and adversarial isolation at every entry point in each supported
  deployment, including parent signalling, escaped descendants, resource limits and egress.
- T-06: independently verify the PostgreSQL placeholder test and real-driver CI on the reviewed commit.
- T-07: replay every documented architecture flow, including real mobile/desktop, OCR and
  representative destination paths; synthetic HTTP/fake OCR/CSV coverage is not the complete replay.
- T-08: rerun ADR citation integrity and reconcile ADR status against shipped behaviour.
- Authorized operators must execute and record production connector/encryption migrations,
  backup/restore, verification and rollback evidence, plus historical-data/credential decisions.
  No production access or migration is claimed here. Evaluate storage reconciliation, retention,
  backups and legal holds under approved policies before changing or deleting customer data.
- A qualified **independent** software architect must inspect the final reviewed commit and
  evidence, assess every passing condition and finding/exception, and personally record the named,
  dated G1/G8 decision and whether R01 is complete. No agent or author can pre-fill that approval.
