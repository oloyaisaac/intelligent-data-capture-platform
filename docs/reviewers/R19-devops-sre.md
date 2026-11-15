# REVIEWER 19 — DEVOPS / SITE RELIABILITY ENGINEER

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Reviewer ID**    | R19                                                                |
| **Title**          | DevOps / Site Reliability Engineer                                 |
| **Board**          | F — Operations & delivery                                          |
| **Wave**           | 5 (weeks 9–13)                                                     |
| **Effort**         | 12 person-days                                                     |
| **Gate chaired**   | **G10 — Deployment & operational readiness**                       |
| **Co-signs**       | G4                                                                 |
| **Finding prefix** | `OPS-###`                                                          |
| **Upstream**       | R03 (DB), R10 (desktop packaging), R18 (metrics spec)              |
| **Downstream**     | G10; R22 cannot pilot without a deployment                         |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Answer one question with evidence: **can this system be deployed, operated, upgraded and recovered from this
repository alone?** Today the answer is no — and it is not a code-quality problem, it is a **missing release
layer**.

**Measured starting condition:**

| Element                  | State                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`             | **absent**                                                                                                            |
| Image publish / registry | **absent**                                                                                                            |
| CI jobs                  | **2**: `verify` (typecheck, lint, format, PRD/API/legal contracts, tests, renderer build) and `secrets` (secret scan) |
| CI deploy/package job    | **absent**                                                                                                            |
| `/metrics` endpoint      | **absent**                                                                                                            |
| Alerting                 | **absent**                                                                                                            |
| `db:backup` script       | **absent**                                                                                                            |
| Migration strategy       | applied **at application boot** (`createDatabase` → `applyMigrations`)                                                |
| Migrations               | **forward-only**, no down-migrations, no separate deploy gate                                                         |
| `.env.example`           | 5.6 KB, contract-tested by `apps/backend/test/config.test.ts`                                                         |
| `TRUST_PROXY`            | default **true** (correct only behind the documented proxy)                                                           |
| Desktop publish URL      | `https://updates.example.invalid/idcp` (**non-existent**)                                                             |

`DEPLOYMENT.md` §11 is the repository's own gap table. Your job is to execute it, not to read it.

---

## 2. Required expertise

- Containerisation (multi-stage builds, non-root, distroless/minimal base, `.dockerignore`)
- CI/CD pipeline design, artefact provenance, caching, matrix builds
- Secret management and configuration hygiene
- Reverse proxy, TLS termination, HSTS, proxy-aware rate limiting (`X-Forwarded-For`)
- Database migration strategy for zero-downtime and rollback
- Observability plumbing (metrics scraping, log shipping)
- Backup scheduling, restore drills, incident response
- Release engineering for desktop (signing, notarisation) and mobile (store submission)

---

## 3. Repository context (self-contained)

**Product.** One Node 22 process serving a Fastify API + an in-process worker, with SQLite or PostgreSQL and
filesystem object storage. A separate Electron desktop app and a React Native mobile app complete the product.

**Build surface:**

| Script                | Command                                                                                                                   | Assessment needed                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`       | `npm run build --workspaces --if-present`                                                                                 | Does it produce a runnable server?                                                                                                 |
| `npm run dev:backend` | `tsx watch src/index.ts`                                                                                                  | Dev only                                                                                                                           |
| backend `build`       | `esbuild src/index.ts --bundle --platform=node --format=cjs --target=node22 --packages=external --outfile=dist/server.js` | `--packages=external` means workspace packages (`@idcp/shared`, `@idcp/connectors`) are **not bundled** — verify the artefact runs |
| backend `start`       | `node dist/server.js`                                                                                                     | Verify                                                                                                                             |
| `npm run db:migrate`  | `tsx src/db/migrate-cli.ts`                                                                                               | Needs `tsx` at runtime — check production story                                                                                    |
| `npm run db:seed`     | `tsx src/db/seed-cli.ts`                                                                                                  | Demo data only                                                                                                                     |
| `npm run verify`      | the CI gate                                                                                                               | 406 tests                                                                                                                          |

**Environment contract (`config.ts`, 30+ keys):** `NODE_ENV`, `PORT`, `API_BASE_URL`, `LOG_LEVEL`,
`DB_DRIVER`, `SQLITE_PATH`, `DATABASE_URL`, `DATABASE_POOL_SIZE`, `JWT_SECRET`, `ACCESS_TOKEN_TTL_SECONDS`,
`REFRESH_TOKEN_TTL_SECONDS`, `PAIRING_TOKEN_TTL_SECONDS`, `PASSWORD_RESET_TTL_SECONDS`, `STORAGE_DRIVER`,
`STORAGE_PATH`, `AI_PROVIDER`, `AI_LOCAL_ENGINE`, `TESSERACT_BIN`, `AI_CLOUD_*`, `AI_MAX_COST_MICROS_PER_DOC`,
`AI_REVIEW_CONFIDENCE_THRESHOLD`, `MAX_UPLOAD_MB`, `MAX_REQUEST_MB`, `RATE_LIMIT_*`, `APP_ORIGIN`,
`LEGAL_DIR`, `CORS_ORIGINS`, `EXPORTS_TTL_SECONDS`, `INVITATION_TTL_SECONDS`, `WORKER_ENABLED`,
`WORKER_POLL_INTERVAL_MS`, `MAINTENANCE_ENABLED`, `MAINTENANCE_INTERVAL_MS`, `TRUST_PROXY`.

**Production refusals already implemented (verify each):** dev `JWT_SECRET` rejected; `JWT_SECRET` <32 chars
rejected; empty `CORS_ORIGINS` rejected; `DB_DRIVER=postgres` without `DATABASE_URL` rejected;
`STORAGE_DRIVER=s3` rejected (no adapter); cloud AI without endpoint/key/spend-cap rejected.

**External runtime dependency:** the `tesseract` **binary** must be present in the image, or the default AI
provider cannot function.

---

## 4. Exact files and components to examine

### 4.1 Must read in full

`.github/workflows/ci.yml` · `DEPLOYMENT.md` (all of it, especially §11) · `ENVIRONMENT.md` ·
`.env.example` · `apps/backend/src/config.ts` · `apps/backend/src/index.ts` ·
`apps/backend/src/db/{index.ts, migrate-cli.ts, seed-cli.ts}` · `apps/backend/package.json` ·
`apps/desktop/electron-builder.json` · `apps/mobile/package.json` · `.gitignore` · `.nvmrc` ·
`scripts/validate-packaging.mjs` · `README.md` (Getting started) · `test/config.test.ts`

### 4.2 Must cross-check

- `apps/backend/src/http/app.ts` — CORS, `trustProxy`, headers, HSTS absence.
- `apps/backend/src/http/guards.ts` + `auth/tokens.ts` — the `TRUST_PROXY` consequence for rate limits.
- `apps/backend/src/services/maintenance-service.ts` — the in-process scheduler (multi-replica risk).
- `apps/backend/src/services/worker.ts` — `WORKER_ENABLED` and multi-replica behaviour.
- `packages/shared/` and `packages/connectors/` `package.json` — how workspace deps resolve at runtime.

### 4.3 Explicit non-goals

Application correctness → owning reviewers · database schema portability → R03 · metrics/alert _content_ →
R18 (you implement and operate them) · desktop signing mechanics → R10 (you own the pipeline).

---

## 5. Upstream artefacts required

| From | Artefact                                           | Why                                        |
| ---- | -------------------------------------------------- | ------------------------------------------ |
| R03  | `evidence/R03/postgres-migrate.log`                | Determines which DB the deployment targets |
| R18  | `evidence/R18/metrics-spec.md`, `alerting-spec.md` | What you must wire up                      |
| R10  | installer artefacts                                | What you publish for desktop               |

---

## 6. Checklist

### 6.1 Build reproducibility

| ID     | Item                                                                 | How to verify                               | Expected                                  | Type        |
| ------ | -------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------- | ----------- |
| OPS-01 | `npm ci` from the lockfile reproduces on a clean machine             | Fresh container                             | Byte-identical dependency tree            | **RUNTIME** |
| OPS-02 | Node version is pinned and honoured                                  | `.nvmrc` (22), `engines`                    | Enforced in CI and image                  | STATIC      |
| OPS-03 | `npm run build --workspaces` succeeds                                | Run                                         | Exit 0                                    | **RUNTIME** |
| OPS-04 | **The built backend actually starts**                                | `node apps/backend/dist/server.js`          | Serves `/api/v1/health`                   | **RUNTIME** |
| OPS-05 | `--packages=external` is safe: workspace packages resolve at runtime | Inspect `dist/` and `node_modules` at start | Works, or the build must change           | **RUNTIME** |
| OPS-06 | The build is deterministic                                           | Build twice, diff                           | Identical (or documented non-determinism) | **RUNTIME** |
| OPS-07 | There is a single documented build entry point                       | `README`/`DEPLOYMENT`                       | Present                                   | STATIC      |

### 6.2 Containerisation (does not exist — build it)

| ID     | Item                                                                     | How to verify                 | Expected                | Type        |
| ------ | ------------------------------------------------------------------------ | ----------------------------- | ----------------------- | ----------- |
| OPS-08 | A `Dockerfile` exists                                                    | `ls Dockerfile`               | **Absent — create one** | **WRITE**   |
| OPS-09 | Multi-stage build (build deps not in the runtime image)                  | Review the Dockerfile         | Two stages              | **WRITE**   |
| OPS-10 | Runtime image is minimal and runs as **non-root**                        | `docker run --user`           | UID ≠ 0                 | **WRITE**   |
| OPS-11 | **`tesseract` is installed in the image**                                | Build + run a document        | OCR works               | **RUNTIME** |
| OPS-12 | `HEALTHCHECK` targets `/api/v1/health`                                   | Dockerfile                    | Present                 | **WRITE**   |
| OPS-13 | `.dockerignore` excludes `node_modules`, `local-storage`, `*.db`, `.env` | Add it                        | Present                 | **WRITE**   |
| OPS-14 | No secrets baked into layers                                             | `docker history` review       | Zero                    | **RUNTIME** |
| OPS-15 | Image size is reasonable and justified                                   | `docker images`               | Recorded                | **RUNTIME** |
| OPS-16 | `STORAGE_PATH` is a documented volume                                    | Dockerfile `VOLUME` + compose | Present                 | **WRITE**   |
| OPS-17 | A `docker-compose` or equivalent local stack exists (app + Postgres)     | Add                           | Present                 | **WRITE**   |

### 6.3 CI/CD pipeline

| ID     | Item                                                                | How to verify        | Expected                                                 | Type        |
| ------ | ------------------------------------------------------------------- | -------------------- | -------------------------------------------------------- | ----------- |
| OPS-18 | CI runs on push and PR                                              | `ci.yml`             | Both                                                     | STATIC      |
| OPS-19 | CI enforces typecheck, lint, format, all contract validators, tests | Read                 | Present                                                  | STATIC      |
| OPS-20 | **CI does not build the deployable server**                         | Read                 | Only the desktop renderer — record (R-10)                | STATIC      |
| OPS-21 | **No dependency-audit gate**                                        | Read                 | Absent — add after the zod v4 migration                  | STATIC      |
| OPS-22 | **No coverage threshold gate**                                      | Read                 | Absent — coordinate with R16                             | STATIC      |
| OPS-23 | **No Postgres service container**                                   | Read                 | Absent — add one (R03 needs it)                          | STATIC      |
| OPS-24 | **No e2e job**                                                      | Read                 | Absent — coordinate with R16                             | STATIC      |
| OPS-25 | No artefact archival                                                | Read                 | Absent                                                   | STATIC      |
| OPS-26 | Node matrix is a single version                                     | `['22.x']`           | Acceptable; documented                                   | STATIC      |
| OPS-27 | Runner is only `ubuntu-latest`                                      | Read                 | No Windows/macOS → desktop packaging cannot happen in CI | STATIC      |
| OPS-28 | GitHub Actions are pinned to commit SHAs                            | Read                 | Currently tags (`@v4`) — harden                          | STATIC      |
| OPS-29 | CI time budget is reasonable                                        | Time it              | Recorded (~2 min currently)                              | **RUNTIME** |
| OPS-30 | A release workflow exists                                           | `.github/workflows/` | Only `ci.yml` — create one                               | **WRITE**   |
| OPS-31 | Deployment is reproducible from CI, not a laptop                    | Design               | A documented pipeline                                    | **WRITE**   |

### 6.4 Configuration and secrets

| ID     | Item                                                              | How to verify                                 | Expected                                                                                     | Type        |
| ------ | ----------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------- |
| OPS-32 | `.env.example` matches `config.ts` exactly                        | `npm run verify` (`config.test.ts`)           | Enforced by a test                                                                           | **RUNTIME** |
| OPS-33 | Every key has a safe default or fails fast                        | Read `config.ts`                              | Correct                                                                                      | STATIC      |
| OPS-34 | Production refuses dev defaults                                   | Start with `NODE_ENV=production` and defaults | Fails with an actionable message                                                             | **RUNTIME** |
| OPS-35 | Secrets are never in the image, repo or logs                      | `docker history`, `gitleaks`, log scan        | Clean                                                                                        | **RUNTIME** |
| OPS-36 | A secret-manager path is documented                               | Search                                        | Present or recommended (env from vault/KMS)                                                  | STATIC      |
| OPS-37 | `CORS_ORIGINS` is required in production                          | `config.ts`                                   | Enforced                                                                                     | STATIC      |
| OPS-38 | `TRUST_PROXY` default is safe for direct exposure                 | `TRUST_PROXY` default **true**                | **Unsafe by default for a direct-exposed API** — recommend `false` default or a boot warning | STATIC      |
| OPS-39 | **`TRUST_PROXY=true` + direct exposure allows rate-limit bypass** | Send forged `X-Forwarded-For`                 | Demonstrated; documented as a deployment rule                                                | **RUNTIME** |
| OPS-40 | Config is validated once at boot, not per request                 | Read                                          | Correct                                                                                      | STATIC      |

### 6.5 Database operations

| ID     | Item                                                   | How to verify                    | Expected                                            | Type        |
| ------ | ------------------------------------------------------ | -------------------------------- | --------------------------------------------------- | ----------- |
| OPS-41 | Migrations run at **application start**                | `db/index.ts`                    | Confirmed — a deploy-time risk                      | STATIC      |
| OPS-42 | Multi-replica migration race                           | Start 2 instances on an empty PG | No corruption; one migrates                         | **RUNTIME** |
| OPS-43 | A failed migration leaves a half-started process       | Break a migration                | Documented failure mode                             | **RUNTIME** |
| OPS-44 | Migrations are forward-only                            | Inspect                          | No down-migrations — record (R-10)                  | STATIC      |
| OPS-45 | Rollback strategy                                      | Design                           | Restore-from-backup is the only rollback — state it | **WRITE**   |
| OPS-46 | Migration is gated separately from start (recommended) | Design                           | `npm run db:migrate` as a deploy step               | **WRITE**   |
| OPS-47 | **`db:backup` does not exist**                         | `grep`                           | Absent — create it (`VACUUM INTO` / `pg_dump`)      | **WRITE**   |
| OPS-48 | A restore procedure exists and is rehearsed            | Coordinate with R03/R18          | Documented + timed                                  | **WRITE**   |
| OPS-49 | Backup schedule and retention are defined              | Design                           | Present                                             | **WRITE**   |
| OPS-50 | DB and `STORAGE_PATH` are backed up **together**       | Design                           | Present                                             | **WRITE**   |

### 6.6 Network, TLS and proxy

| ID     | Item                                                            | How to verify        | Expected                                           | Type        |
| ------ | --------------------------------------------------------------- | -------------------- | -------------------------------------------------- | ----------- |
| OPS-51 | TLS terminates at a documented proxy                            | `DEPLOYMENT.md`      | Documented                                         | STATIC      |
| OPS-52 | HSTS is set at the proxy                                        | Configure and verify | Present                                            | **RUNTIME** |
| OPS-53 | The proxy overwrites (not appends) `X-Forwarded-For`            | Verify config        | Correct, so `TRUST_PROXY` is safe                  | **RUNTIME** |
| OPS-54 | The proxy does not log the SSE `access_token` query parameter   | Check proxy config   | Redacted, or a stream-ticket mechanism recommended | STATIC      |
| OPS-55 | Upload body limits are enforced at both proxy and app           | Send 60 MB           | Rejected by both                                   | **RUNTIME** |
| OPS-56 | SSE survives proxy idle timeouts                                | Run behind the proxy | Heartbeat present or configured                    | **RUNTIME** |
| OPS-57 | CORS is restrictive in the deployed configuration               | Verify               | Correct                                            | **RUNTIME** |
| OPS-58 | Health endpoint is the only unauthenticated operational surface | Enumerate            | Correct                                            | STATIC      |

### 6.7 Observability wiring (content specified by R18)

| ID     | Item                                                    | How to verify                    | Expected                                    | Type      |
| ------ | ------------------------------------------------------- | -------------------------------- | ------------------------------------------- | --------- |
| OPS-59 | **No `/metrics` endpoint exists**                       | `grep`                           | Absent — implement per R18's spec or record | STATIC    |
| OPS-60 | Logs are shipped somewhere durable                      | Design                           | Present or specified                        | **WRITE** |
| OPS-61 | Log retention is defined and matches the privacy policy | Design                           | Consistent with R08                         | WRITE     |
| OPS-62 | An alert channel exists and is tested                   | Drill                            | Delivered to a human                        | **WRITE** |
| OPS-63 | Uptime check on `/api/v1/health`                        | Configure                        | Present                                     | **WRITE** |
| OPS-64 | Disk-space alert                                        | Configure                        | Present                                     | **WRITE** |
| OPS-65 | Queue-depth alert                                       | Configure (needs a metric first) | Present or blocked                          | **WRITE** |

### 6.8 Release, upgrade and rollback

| ID     | Item                                                 | How to verify        | Expected                                     | Type      |
| ------ | ---------------------------------------------------- | -------------------- | -------------------------------------------- | --------- |
| OPS-66 | A versioning scheme exists                           | `package.json` 0.1.0 | Semver documented                            | STATIC    |
| OPS-67 | A release checklist exists and is used               | `DEPLOYMENT.md` §11  | Present; executed                            | **WRITE** |
| OPS-68 | A zero-downtime upgrade path exists                  | Design               | Blue/green or rolling, with a migration gate | **WRITE** |
| OPS-69 | Rollback is defined and rehearsed once               | Execute              | Documented with timing                       | **WRITE** |
| OPS-70 | Desktop release artefacts are published              | Coordinate with R10  | Present                                      | **WRITE** |
| OPS-71 | Mobile release path (store submission) is documented | Design               | Present or recorded                          | WRITE     |
| OPS-72 | A changelog is maintained per release                | `CHANGELOG.md`       | Current                                      | STATIC    |

### 6.9 The go-live checklist

| ID     | Item                                                              | How to verify       | Expected             | Type        |
| ------ | ----------------------------------------------------------------- | ------------------- | -------------------- | ----------- |
| OPS-73 | **Execute `DEPLOYMENT.md` §11 end to end**                        | Do it               | Every line pass/fail | **RUNTIME** |
| OPS-74 | Health returns `ok` with `dependencies.db: "ok"`                  | Call it             | Confirmed            | **RUNTIME** |
| OPS-75 | A login succeeds on the deployed system                           | Do it               | Confirmed            | **RUNTIME** |
| OPS-76 | A document uploads, extracts and downloads on the deployed system | Do it               | Confirmed            | **RUNTIME** |
| OPS-77 | A desktop client signs in against the deployed backend            | Requires R-01 fixed | Confirmed            | **RUNTIME** |
| OPS-78 | A mobile device pairs and uploads against the deployed backend    | Do it               | Confirmed            | **RUNTIME** |

---

## 7. Known operational risks to confirm or refute

| Risk               | Statement                                                                                   | Severity |
| ------------------ | ------------------------------------------------------------------------------------------- | -------- |
| **R-10 (MEDIUM)**  | No Dockerfile, no publish, CI stops at the renderer build; migrations at boot; forward-only | MEDIUM   |
| **R-09 (MEDIUM)**  | No backup/restore                                                                           | MEDIUM   |
| **R-11 (MEDIUM)**  | No `/metrics`, no alerting                                                                  | MEDIUM   |
| **R-24 (LOW/MED)** | `node:sqlite` experimental                                                                  | LOW/MED  |
| R-18               | `TRUST_PROXY` defaults to true                                                              | MEDIUM   |
| R-05               | No dependency gate in CI                                                                    | HIGH     |

---

## 8. Questions you must answer

1. **Can this be deployed from the repository alone today?** If not, what exactly is missing?
2. Does the built artefact (`dist/server.js`) actually run, given `--packages=external`?
3. What happens if two replicas start simultaneously against an empty database?
4. What is the rollback procedure for a bad migration, and has it been run?
5. Is the default `TRUST_PROXY=true` safe in the documented topology? Prove it.
6. Where do logs go, who reads them, and after how long?
7. What wakes a human at 2 a.m., and what does that person do?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
git clone . /tmp/clean && cd /tmp/clean && npm ci --no-audit --no-fund && npm run build --workspaces
node apps/backend/dist/server.js &     # does the artefact run?
curl -s http://127.0.0.1:4000/api/v1/health

# ---------- what exists today ----------
ls -la | grep -iE "dockerfile|compose|k8s|helm|terraform"
cat .github/workflows/ci.yml
grep -n "db:backup\|metrics" package.json apps/backend/package.json
grep -rn "prom-client\|/metrics" apps/backend/src

# ---------- production refusal paths ----------
NODE_ENV=production node apps/backend/dist/server.js          # expect failure: JWT_SECRET
NODE_ENV=production JWT_SECRET=$(openssl rand -hex 32) node apps/backend/dist/server.js  # expect: CORS
NODE_ENV=production JWT_SECRET=$(openssl rand -hex 32) CORS_ORIGINS=https://a.test \
  DB_DRIVER=postgres node apps/backend/dist/server.js          # expect: DATABASE_URL

# ---------- write the image ----------
cat > Dockerfile <<'DOCKER'
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./
RUN npm ci --no-audit --no-fund && npm run build --workspace @idcp/backend

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=4000 STORAGE_PATH=/data/documents SQLITE_PATH=/data/idcp.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/backend/dist ./dist
COPY package.json ./
RUN useradd -r -u 10001 idcp && mkdir -p /data && chown -R idcp /data
USER idcp
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/server.js"]
DOCKER
docker build -t idcp:review .
docker run -d --name idcp -p 4000:4000 -v idcpdata:/data \
  -e JWT_SECRET=$(openssl rand -hex 32) -e CORS_ORIGINS=https://app.test idcp:review
curl -s http://127.0.0.1:4000/api/v1/health

# ---------- migration race ----------
docker run -d --name pg -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:16
for i in 1 2; do
  docker run -d --name idcp$i -e DB_DRIVER=postgres -e DATABASE_URL=postgres://postgres:pg@pg:5432/idcp \
    -e JWT_SECRET=$(openssl rand -hex 32) -e CORS_ORIGINS=https://app.test idcp:review
done
docker logs idcp1 | tail -20 ; docker logs idcp2 | tail -20

# ---------- backup ----------
sqlite3 /data/idcp.db "VACUUM INTO '/data/backup.db'"
pg_dump "$DATABASE_URL" > backup.sql
```

---

## 10. Tests to perform

| #    | Test                          | Procedure                                  | Pass criterion              |
| ---- | ----------------------------- | ------------------------------------------ | --------------------------- |
| T-01 | Clean-machine build           | Fresh container, `npm ci && npm run build` | Success                     |
| T-02 | Artefact runs                 | `node dist/server.js`                      | Health OK                   |
| T-03 | Image build + run as non-root | Docker                                     | Works, UID ≠ 0              |
| T-04 | OCR in the image              | Upload a document                          | Extraction runs             |
| T-05 | Production refusals           | 3 misconfigurations                        | Each fails actionably       |
| T-06 | Migration race                | 2 replicas, empty PG                       | No corruption               |
| T-07 | TRUST_PROXY bypass            | Forged header, direct exposure             | Demonstrated and documented |
| T-08 | Proxy header overwrite        | Behind the proxy                           | Forged header ignored       |
| T-09 | SSE through the proxy         | 10-minute idle                             | Stream survives             |
| T-10 | Backup + restore              | `VACUUM INTO` / `pg_dump` → restore        | Data intact, app works      |
| T-11 | Rollback rehearsal            | Deploy a bad version, roll back            | Restored and timed          |
| T-12 | **Go-live checklist**         | `DEPLOYMENT.md` §11                        | Every line pass/fail        |
| T-13 | Alert drill                   | Trigger a condition                        | A human is notified         |

---

## 11. Evidence required

```
docs/reviewers/evidence/R19/
├── Dockerfile                   # the artefact you created
├── .dockerignore
├── compose.yaml                 # app + postgres local stack
├── build-proof.md               # T-01, T-02, T-03 with output
├── config-refusal.md            # T-05
├── migration-strategy.md        # gate, race, rollback
├── proxy-config.md              # T-08, T-09, TLS/HSTS
├── backup-restore.md            # T-10, T-11 with timings
├── alerts.md                    # T-13
├── go-live-checklist.md         # T-12 executed, line by line
├── commands.log
└── findings.md                  # OPS-### register
```

---

## 12. Passing conditions (chairs G10; co-signs G4)

- [ ] **P1** A clean-machine build succeeds and the built server actually runs (OPS-01 … OPS-07, T-01, T-02).
- [ ] **P2** A `Dockerfile` exists: multi-stage, non-root, `tesseract` installed, healthcheck, volume, no secrets (OPS-08 … OPS-17, T-03, T-04).
- [ ] **P3** CI builds, tests and **packages** the deployable server, and includes an audit gate (OPS-20, OPS-21, OPS-30, OPS-31).
- [ ] **P4** Migrations are gated as a deploy step and are multi-replica safe, or the race is documented with a mitigation (OPS-41 … OPS-46, T-06).
- [ ] **P5** `db:backup` exists, a restore is rehearsed and timed, and DB + storage are backed up together (OPS-47 … OPS-50, T-10).
- [ ] **P6** TLS/HSTS at the proxy, `X-Forwarded-For` overwritten, SSE survives proxy idle timeouts (OPS-51 … OPS-58, T-08, T-09).
- [ ] **P7** `TRUST_PROXY` cannot be used to bypass rate limits in the documented topology (OPS-38, OPS-39, T-07, T-08).
- [ ] **P8** Metrics and at least one alert are wired per R18's spec, and a drill notifies a human (OPS-59 … OPS-65, T-13).
- [ ] **P9** A rollback procedure exists and has been exercised once (OPS-69, T-11).
- [ ] **P10** `DEPLOYMENT.md` §11 is executed end to end with every line resolved, and a real upload + login succeeds on the deployed system (OPS-73 … OPS-78, T-12).

---

## 13. Blocked items

| Item ID | Blocker                                             | What unblocks it  | Owner |
| ------- | --------------------------------------------------- | ----------------- | ----- |
| OPS-70  | Desktop signing credentials                         | Owner/procurement | Owner |
| OPS-71  | Mobile store accounts                               | Owner/procurement | Owner |
| OPS-77  | R-01 must be fixed for a packaged client to sign in | R09/R10           | R10   |
| OPS-62  | No notification channel chosen (no mail transport)  | Owner decision    | Owner |

---

## 14. Findings register

| ID      | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| ------- | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| OPS-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off

| Field                      | Value                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer name              |                                                                                                                                                                |
| Date started               |                                                                                                                                                                |
| Date completed             |                                                                                                                                                                |
| **Gate G10 result**        | ☐ Pass ☐ Fail                                                                                                                                                  |
| **G4 co-sign result**      | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                                        |
| Deployable from repo alone | ☐ Yes ☐ No                                                                                                                                                     |
| Restore rehearsed          | ☐ Yes ☐ No — RTO                                                                                                                                               |
| Conditions failed (IDs)    |                                                                                                                                                                |
| Reviewed commit            | `43d384b`                                                                                                                                                      |
| Statement                  | _I built a container, ran the artefact, raced two replicas against an empty database, and executed the go-live checklist line by line rather than reading it._ |
| Signature                  |                                                                                                                                                                |
