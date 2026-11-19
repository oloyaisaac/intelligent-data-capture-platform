# Development Environment

Exact tooling needed to work on this project, and how to verify your machine matches.

> Last verified against this checkout on 2026-10-26.

---

## 1. Required tooling

| Tool                 | Version                       | Required for                                                                  | Verified in this checkout |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------- | ------------------------- |
| Node.js              | 22 LTS (`.nvmrc` target `22`) | Everything                                                                    | `v22.22.3`                |
| npm                  | 10+                           | Everything                                                                    | `10.9.8`                  |
| Git                  | 2.39+                         | Everything                                                                    | `2.39.5`                  |
| JDK                  | 17                            | Android builds                                                                | not checked               |
| Android Studio + SDK | API 34+, emulator             | Mobile (Android)                                                              | not installed             |
| Xcode                | 16+ (macOS only)              | Mobile (iOS)                                                                  | n/a (Linux)               |
| Docker + Compose     | 24+                           | **Optional** — only to run PostgreSQL locally; the backend defaults to SQLite | not checked               |
| Python               | 3.11+                         | Optional: local OCR tooling                                                   | `3.11.2`                  |

Recommended editor: VS Code with ESLint, Prettier and TypeScript extensions. Editor settings: format on save, no tabs in TS/JS.

## 2. Node version

The project targets Node 22. Use a version manager so `node -v` matches everywhere:

```bash
# with nvm
nvm install 22
nvm use 22
node -v   # expect v22.x
```

The repo pins this with `.nvmrc` and `engines` in `package.json`, and CI runs the same major version.

## 3. First-time setup

```bash
git clone <repository-url>
cd intelligent-data-capture-platform
npm install
```

That is enough to run everything. The backend defaults to SQLite (`DB_DRIVER=sqlite`), the filesystem
for document storage and a local OCR engine, so **no database, object store or cache has to be
installed** (DEC-029). Copy the example only if you want to change something:

```bash
cp .env.example .env    # every key is documented there; .env is gitignored
```

### Backend and desktop

```bash
npm run db:migrate      # create ./local-storage/idcp.db and apply every migration
npm run db:seed         # demo organisation, owner account, sample connector and project
npm run dev:backend     # http://127.0.0.1:4000  (API + in-process worker)
npm run dev:desktop     # http://127.0.0.1:5173  (renderer; proxies /api to the API)
```

Sign in with the seeded account `owner@example.com` / `demo-password-change-me`. For synthetic
local data, the seed command accepts optional `SEED_EMAIL` and `SEED_PASSWORD` environment
variables. It prints the chosen password, so do not use a real secret or publish its output. Seeding
is refused when `NODE_ENV=production`.

Local ports: API `4000`, desktop dev server `5173`, Metro `8081`.

### Optional: PostgreSQL instead of SQLite

Only needed if you are working on the Postgres path or on Postgres-specific SQL. Start a server
locally (Docker or a native install) and set `DB_DRIVER=postgres` plus `DATABASE_URL` in `.env`; the
migrations are the same statements for both drivers (DEC-013).

### Android

1. Install Android Studio; install SDK Platform 34+ and an emulator image (API 34).
2. Set `ANDROID_HOME` (e.g. `~/Android/Sdk`) and add `platform-tools` to `PATH`.
3. Verify: `adb devices` lists your emulator.
4. Run: `npm run dev:mobile` then `npm run android`.

### iOS (macOS only)

1. Install Xcode 16+ and Command Line Tools.
2. `sudo xcodebuild -runFirstLaunch` and accept the licence.
3. Install CocoaPods (`brew install cocoapods`) — required by React Native native modules.
4. Run: `npm run dev:mobile` then `npm run ios`.

### Desktop (Electron shell)

```bash
npm run dev:desktop                       # renderer in the browser (Vite)
npm run build --workspace @idcp/desktop   # renderer bundle + Electron main process
npm run package --workspace @idcp/desktop # installers; needs electron-builder, not run in CI
```

The renderer is the primary surface and runs in a browser on its own. The Electron shell adds the
keychain-backed token store and the allow-listed IPC bridge (`DESK-001`, DEC-022).

## 4. Environment variables

The single source of truth is `apps/backend/src/config.ts`; `.env.example` documents every key it
reads, with the default in parentheses, and a test (`apps/backend/test/config.test.ts`) fails if the
two lists diverge or if the example does not start the server when copied verbatim.

| Group         | Keys                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | `NODE_ENV`, `PORT`, `API_BASE_URL`, `LOG_LEVEL`, `APP_ORIGIN`, `CORS_ORIGINS`                                                                                                |
| Database      | `DB_DRIVER`, `SQLITE_PATH`, `DATABASE_URL`, `DATABASE_POOL_SIZE`                                                                                                             |
| Auth          | `JWT_SECRET`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `PAIRING_TOKEN_TTL_SECONDS`, `INVITATION_TTL_SECONDS`, `PASSWORD_RESET_TTL_SECONDS`                   |
| Storage       | `STORAGE_DRIVER`, `STORAGE_PATH`                                                                                                                                             |
| AI            | `AI_PROVIDER`, `AI_LOCAL_ENGINE`, `TESSERACT_BIN`, `AI_CLOUD_MODEL`, `AI_CLOUD_ENDPOINT`, `AI_CLOUD_API_KEY`, `AI_MAX_COST_MICROS_PER_DOC`, `AI_REVIEW_CONFIDENCE_THRESHOLD` |
| Limits        | `MAX_UPLOAD_MB`, `MAX_REQUEST_MB`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_AUTH_PER_15_MIN`, `RATE_LIMIT_UPLOAD_PER_MIN`, `TRUST_PROXY` (DEC-033)                                  |
| Exports, jobs | `EXPORTS_TTL_SECONDS`, `WORKER_ENABLED`, `WORKER_POLL_INTERVAL_MS`                                                                                                           |
| Housekeeping  | `MAINTENANCE_ENABLED`, `MAINTENANCE_INTERVAL_MS` (DEC-031)                                                                                                                   |
| Legal         | `LEGAL_DIR` (where `legal/*.md` is read from; default `./legal`)                                                                                                             |
| Client builds | `IDCP_API_URL` (mobile), `IDCP_API_PROXY`, `IDCP_DEV_SERVER`, `IDCP_AUTO_UPDATE` (desktop)                                                                                   |

Rules:

- `.env` is for local values only and is gitignored; the defaults are a working local setup.
- Never reuse staging or production credentials locally.
- If you add a key, add it to `ConfigSchema` **and** `.env.example` in the same commit — the drift test
  enforces it.
- Invalid configuration fails fast at startup with an actionable message (`BACK-001`); for example
  `STORAGE_DRIVER=s3` is refused until the object-store adapter exists.

`TRUST_PROXY` (default `true`) decides whether `X-Forwarded-For` sets the client IP. Keep it true
behind the reverse proxy in `DEPLOYMENT.md`, which overwrites the header; set it to `false` if the API
is reachable directly, or a client can forge the header and dodge per-IP rate limits (DEC-033).

`MAINTENANCE_INTERVAL_MS` (default 24 hours, minimum 60 s) is how often the in-process sweep runs —
first 10 s after boot, then on that interval; set
`MAINTENANCE_ENABLED=false` to turn it off (a test run or a read-only replica). Nothing is emailed by
this build, so `POST /auth/password/forgot` returns the reset link in its response **outside
production only** — in production the operator delivers it, and `PASSWORD_RESET_TTL_SECONDS`
(default 1 hour) is how long the link lives.

Invitation links are built from `APP_ORIGIN` (`<APP_ORIGIN>/#/accept-invite?token=…`), so set it to
the URL people actually open, not the API's own address. `INVITATION_TTL_SECONDS` (default 7 days)
is how long such a link stays usable; there is no email delivery, so the link is returned by
`POST /users/invite` exactly once.

## 5. Standard scripts

```bash
npm install               # install all workspace dependencies
npm run dev               # alias of dev:backend
npm run dev:backend       # API + in-process worker (tsx watch)
npm run dev:desktop       # renderer dev server (Vite, proxies /api)
npm run dev:mobile        # Metro bundler
npm run db:migrate        # apply pending migrations
npm run db:seed           # demo organisation + owner account

npm run verify            # typecheck + lint + PRD + OpenAPI + UDM schema + packaging + all tests
npm run typecheck         # tsc --noEmit across workspaces
npm run lint              # ESLint
npm run format            # Prettier write
npm run format:check      # Prettier check (CI)
npm test                  # every Jest project
npm run test:unit         # shared + connectors + backend only
npm run test:coverage
npm run test:prd          # PRD.json contract
npm run test:api          # OpenAPI + generated UDM schema are current
npm run test:packaging    # electron-builder contract (DESK-001)
npm run schema:udm        # regenerate docs/udm-1.0.schema.json
npm run build             # build every workspace that has a build
```

`npm test` accepts the usual Jest flags through `--`, e.g.
`npm test -- --selectProjects backend -t "AGENT-001"`.

## 6. Verify your setup

```bash
node -v && npm -v && git --version
npm ci                     # reproducible install from the lockfile
node -e "JSON.parse(require('fs').readFileSync('PRD.json','utf8')); console.log('PRD.json OK')"
npm run verify            # typecheck + lint + contracts + packaging + all tests
```

If all of the above pass, your machine matches the documented baseline.

## 7. Troubleshooting

| Symptom                                     | Cause                                                           | Fix                                           |
| ------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| `EBADENGINE` / unsupported Node warnings    | Wrong Node version                                              | `nvm use 22`, reinstall                       |
| `Cannot find module 'react-native'`         | Dependencies not installed, or running from the wrong directory | Run `npm install` at the repository root      |
| Metro "Unable to resolve module"            | Stale cache                                                     | `npm start -- --reset-cache`                  |
| Android build fails on JDK                  | Wrong JDK version                                               | Use JDK 17 (`java -version` to check)         |
| iOS pod install fails                       | Stale pods                                                      | `cd ios && pod deintegrate && pod install`    |
| Port already in use                         | Another dev server running                                      | Kill the process or change `PORT`             |
| Backend exits on start                      | Missing/invalid `.env`                                          | Compare with `.env.example`, fix values       |
| `npm ci` fails after editing `package.json` | Lockfile out of sync                                            | `npm install` and commit the updated lockfile |
| `PRD.json` will not parse                   | Trailing comma or bad edit                                      | Validate with the `node -e` command above     |

## 8. Keeping the environment documented

If you install something new (a native SDK, a CLI, a database extension), add it to §1 and to `package.json`/`docs` in the same change. An undocumented requirement is how "it works on my machine" starts.
