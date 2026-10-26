# Development Environment

Exact tooling needed to work on this project, and how to verify your machine matches.

> Last verified against this checkout on 2026-10-26.

---

## 1. Required tooling

| Tool                 | Version                       | Required for                             | Verified in this checkout |
| -------------------- | ----------------------------- | ---------------------------------------- | ------------------------- |
| Node.js              | 22 LTS (`.nvmrc` target `22`) | Everything                               | `v22.22.3`                |
| npm                  | 10+                           | Everything                               | `10.9.8`                  |
| Git                  | 2.39+                         | Everything                               | `2.39.5`                  |
| JDK                  | 17                            | Android builds                           | not checked               |
| Android Studio + SDK | API 34+, emulator             | Mobile (Android)                         | not installed             |
| Xcode                | 16+ (macOS only)              | Mobile (iOS)                             | n/a (Linux)               |
| Docker + Compose     | 24+                           | PostgreSQL, Redis, MinIO for the backend | not checked               |
| Python               | 3.11+                         | Optional: local OCR tooling              | `3.11.2`                  |

Recommended editor: VS Code with ESLint, Prettier and TypeScript extensions. Editor settings: format on save, no tabs in TS/JS.

## 2. Node version

The project targets Node 22. Use a version manager so `node -v` matches everywhere:

```bash
# with nvm
nvm install 22
nvm use 22
node -v   # expect v22.x
```

The repo should pin this with `.nvmrc` (to be added in `FOUND-003`) and `engines` in `package.json`.

## 3. First-time setup

```bash
git clone <repository-url>
cd intelligent-data-capture-platform

# install dependencies (workspace-aware once FOUND-003 lands)
npm install

# create your local configuration from the documented example
cp .env.example .env
# then edit .env with LOCAL values only — never commit it
```

### Backend services (after `DB-001`)

```bash
docker compose up -d db redis minio   # PostgreSQL 16, Redis 7, MinIO
npm run db:migrate                    # apply migrations
npm run db:seed                       # demo organisation + admin user
```

Local ports: PostgreSQL `5432`, Redis `6379`, MinIO `9000` (console `9001`), API `4000`, Metro `8081`.

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

### Desktop (Electron, after `DESK-001`)

```bash
npm run dev:desktop
```

## 4. Environment variables

All keys are documented in `.env.example`. Rules:

- `.env` is for local values only and is gitignored.
- Never reuse staging or production credentials locally.
- If you add a new key, add it to `.env.example` **with a placeholder** in the same commit.
- Missing or invalid configuration must fail fast at startup with a clear message (`BACK-001`).

## 5. Standard scripts (target surface)

These are the commands the project will standardise on (`FOUND-003`, `FOUND-004`). Only `npm install` works today.

```bash
npm install               # install all workspace dependencies
npm run dev               # start everything available
npm run dev:mobile        # Metro bundler
npm run dev:desktop       # Electron app
npm run dev:backend       # API + worker

npm run build             # build all packages/apps
npm run typecheck         # tsc --noEmit across workspaces
npm run lint              # ESLint
npm run format            # Prettier write
npm run format:check      # Prettier check (CI)
npm test                  # unit + integration tests
npm run test:coverage
```

## 6. Verify your setup

```bash
node -v && npm -v && git --version
npm ci                     # reproducible install from the lockfile
node -e "JSON.parse(require('fs').readFileSync('PRD.json','utf8')); console.log('PRD.json OK')"
npm run typecheck && npm run lint && npm test   # once FOUND-004 exists
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
