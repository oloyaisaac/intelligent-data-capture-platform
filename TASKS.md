# Tasks

Short-term work queue. `PRD.json` is the complete project; this file is what we are doing **now**.
Story IDs refer to `PRD.json`. Keep this list short and honest.

**Last updated:** 2026-10-26

---

## Now

- [ ] **FOUND-003 — Monorepo restructuring and TypeScript baseline**
  - [ ] Add npm workspaces to root `package.json` (`apps/*`, `packages/*`), plus `private`, `engines`, `scripts`
  - [ ] Create `apps/mobile` and move React Native / React Navigation / Socket.IO dependencies there
  - [ ] Scaffold the React Native project files (`android/`, `ios/`, `babel.config.js`, `metro.config.js`, `index.js`)
  - [ ] Add `tsconfig.base.json` and per-workspace `tsconfig.json`
  - [ ] Create placeholder `apps/backend`, `apps/desktop`, `packages/shared`, `packages/connectors` with `package.json` + `src/index.ts`
  - [ ] Verify `npm install` from a clean clone and `npm run typecheck` passes
- [ ] **FOUND-004 — Linting, formatting and test harness**
  - [ ] ESLint flat config + Prettier
  - [ ] Jest for backend/shared; React Native Testing Library for mobile
  - [ ] Standard scripts: `dev`, `dev:mobile`, `dev:desktop`, `dev:backend`, `typecheck`, `lint`, `format`, `test`

## Next

- [ ] **FOUND-005 — CI pipeline** (`.github/workflows/ci.yml`: install, typecheck, lint, test, `PRD.json` validation)
- [ ] **BACK-001 — Backend API skeleton** (health endpoint, config validation, logging, error envelope)
- [ ] **DB-001 — Database schema and migrations** (implement `DATABASE.md`; seed demo organisation)
- [ ] **AUTH-001 — Authentication** (Argon2id, short-lived access tokens, rotating refresh tokens)
- [ ] **AUTH-002 — RBAC and tenant scoping**
- [ ] **UDM-001 — Universal Data Model schema** (Zod + published JSON Schema)
- [ ] **PAIR-001 — QR pairing code generation**
- [ ] **MOB-001 — Mobile app shell and navigation**

## Later (M1 remainder)

- [ ] `PAIR-002` mobile QR scan and device authentication
- [ ] `PAIR-003` encrypted realtime channel
- [ ] `PAIR-004` device management and revocation
- [ ] `MOB-002` camera capture with edge detection
- [ ] `DOC-001` document upload API and storage
- [ ] `MOB-003` offline-first upload queue
- [ ] `AI-001` OCR pipeline · `AI-002` classification · `AI-003` field/table extraction
- [ ] `REV-001` review interface
- [ ] `DESK-001` desktop shell · `DESK-002` review dashboard
- [ ] `EXPORT-001` xlsx · `EXPORT-002` csv
- [ ] `AUDIT-001` audit trail · `SEC-001` retention and deletion

## Blocked / waiting on a human

- [ ] **Q-001** Approve AI/OCR providers and per-document budget → unblocks `AI-001`, `AI-004`
- [ ] **Q-002** Confirm licensing model → finalises `LICENSE`
- [ ] **Q-003** Confirm hosting region and data-residency rules → unblocks `SEC-001` production settings and `DEPLOYMENT.md`
- [ ] **Q-004** Decide whether the desktop app must run standalone → affects `DESK-001`, `AI-004`

## Recently done

- [x] `FOUND-001` Repository and dependency baseline
- [x] `FOUND-002` Project documentation pack (PRD.json, REQUIREMENTS, AI.md, AGENT_STATE, TASKS, CHANGELOG, DECISIONS, ARCHITECTURE, DATABASE, API, TESTING, SECURITY, DEPLOYMENT, ENVIRONMENT, CONTRIBUTING, LICENSE, .env.example, .gitignore)
