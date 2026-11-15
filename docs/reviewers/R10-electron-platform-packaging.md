# REVIEWER 10 — DESKTOP PLATFORM & ELECTRON PACKAGING ENGINEER

| Field | Value |
|-------|-------|
| **Reviewer ID** | R10 |
| **Title** | Desktop Platform & Electron Packaging Engineer |
| **Board** | C — Client platforms & experience |
| **Wave** | 3 (weeks 3–5) |
| **Effort** | 12 person-days |
| **Gate chaired** | none |
| **Co-signs** | none |
| **Evidence to** | G2, G3, G10 (contributes findings, not an approver) |
| **Finding prefix** | `ELEC-###` |
| **Upstream** | R09 (renderer), R07 (security findings R-03) |
| **Downstream** | R09 (needs your packaged build), R19 (release pipeline), R22 (pilot on real installers) |
| **Status** | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether the desktop product can be **built, signed, installed and launched** on Windows, macOS
and Linux, whether the Electron shell is correctly hardened, and whether the OS-integration surface (IPC,
keychain, external links, updates, file access) is safe.

**You are the reviewer who produces the first real installer in this project's history.** The repository
says plainly: *"Installers are not built here… producing and smoke-testing signed installers on
Windows/macOS/Linux is a release-checklist item, not a code gap"* (`AGENT_STATE.md` gap 1). Your finding
`DESK-001` in `PRD.json` carries a `verification` block because of this. Until an installer exists and a
human has launched it on each platform, the desktop product is **unproven**, not merely unreleased.

**Two defects you must fix or formally accept:**

| ID | Defect | Evidence |
|----|--------|----------|
| **R-03a** | `shell.openExternal(url)` is called with **no protocol allow-list**; any scheme (`file:`, `smb:`, custom) handed to `window.open` goes to the OS | `apps/desktop/src/main/electron-main.ts:129-131` |
| **R-03b** | There is **no `will-navigate` handler**; a renderer navigation to a remote origin would load inside the shell where the preload bridge is exposed | `grep -rn "will-navigate" apps/desktop/src` → 0 hits |
| **R-01 (shared with R09)** | The packaged app cannot reach the API because the base URL is relative | `App.tsx:134`, `client.ts:154` |

---

## 2. Required expertise

- Electron main/preload/renderer architecture and process isolation model
- `contextBridge`, `contextIsolation`, `sandbox`, preload constraints under sandbox
- `safeStorage` / OS keychain behaviour on all three platforms
- `electron-builder`: targets, ASAR, `files` globs, `extraResources`, entitlements
- Windows Authenticode signing + SmartScreen; macOS codesign/hardened runtime/notarisation/stapling; Linux AppImage/deb
- Auto-update design and signature verification
- OS-specific behaviour: single-instance, deep links, file associations, tray, permissions

---

## 3. Repository context (self-contained)

**Product.** IDCP's desktop app is the primary surface: pair a phone, watch jobs arrive, review documents,
configure connectors, export. It must run on Windows, macOS and Linux.

**Shell implementation:**

| Element | Path | LOC / size |
|---------|------|-----------|
| Main process (window, IPC, keychain, updates) | `apps/desktop/src/main/electron-main.ts` | 157 |
| Preload (4 allow-listed channels) | `apps/desktop/src/main/preload.ts` | 62 |
| Renderer entry | `apps/desktop/src/main.tsx` | 13 |
| Renderer HTML + CSP meta | `apps/desktop/index.html` | 16 |
| Vite config (dev proxy, build target) | `apps/desktop/vite.config.ts` | 27 |
| Electron TS config | `apps/desktop/tsconfig.electron.json` | 14 |
| Packaging contract | `apps/desktop/electron-builder.json` | 48 |
| Packaging validator (static) | `scripts/validate-packaging.mjs` | — |
| Shell tests (stand-in Electron) | `apps/desktop/test/shell.test.ts` | 213 |
| Desktop package manifest | `apps/desktop/package.json` | 34 |

**Declared packaging targets** (`electron-builder.json`):

| Platform | Targets | Arches |
|----------|---------|--------|
| Windows | `nsis` (oneClick: false, allowToChangeInstallationDirectory), `portable` | x64, arm64 / x64 |
| macOS | `dmg`, `zip`, `hardenedRuntime: true`, `gatekeeperAssess: false` | x64, arm64 |
| Linux | `AppImage`, `deb` | x64, arm64 / x64 |

**Publish config:** `{ "provider": "generic", "url": "https://updates.example.invalid/idcp" }` — a
**non-existent** update host. The update IPC handler returns a **hardcoded** `{ status: 'up_to_date' }`.

**IPC surface — exactly four channels** (`preload.ts` → `electron-main.ts`):

| Channel | Direction | Payload validation |
|---------|-----------|--------------------|
| `idcp:tokens:read` | renderer → main | none needed (no payload) |
| `idcp:tokens:write` | renderer → main | `sanitiseTokens()` clamps to strings ≤4 000 chars |
| `idcp:app:version` | renderer → main | none needed |
| `idcp:updates:check` | renderer → main | none; **returns a hardcoded result** |

**Token persistence:** AES via `safeStorage` into `session.bin` under `app.getPath('userData')`, mode `0o600`,
deleted on sign-out; **silently no-ops** when `safeStorage.isEncryptionAvailable()` is false (common on Linux
without a keyring).

---

## 4. Exact files and components to examine

### 4.1 Must read in full

`apps/desktop/src/main/electron-main.ts` · `apps/desktop/src/main/preload.ts` · `apps/desktop/index.html` ·
`apps/desktop/vite.config.ts` · `apps/desktop/electron-builder.json` · `apps/desktop/package.json` ·
`apps/desktop/tsconfig.electron.json` · `apps/desktop/tsconfig.json` · `scripts/validate-packaging.mjs` ·
`apps/desktop/test/shell.test.ts` · `apps/desktop/test/stubs/file.ts` · `apps/desktop/src/main.tsx` ·
`DECISIONS.md` DEC-022 · `DEPLOYMENT.md` (desktop sections) · `SECURITY.md` §6.3

### 4.2 Must cross-check

- `apps/desktop/src/App.tsx` and `src/api/client.ts` — how the renderer calls the bridge and resolves the API origin (R-01).
- `apps/desktop/src/lib/realtime.ts` — SSE inside the shell.
- `scripts/validate-packaging.mjs` — what it *actually* asserts.
- `.github/workflows/ci.yml` — the only build step is `npm run build --workspace @idcp/desktop`; no packaging job.

### 4.3 Explicit non-goals

Renderer component correctness and page behaviour → R09 · CSP content for the page → R07/R09 (you verify the
shell's header handling) · release pipeline for the **server** → R19 · visual design → R12.

---

## 5. Upstream artefacts required

| From | Artefact | Why |
|------|----------|-----|
| R09 | `evidence/R09/r01-fix-proposal.md` | You inject the runtime config the fix requires |
| R07 | `evidence/R07/electron-hardening.md` | Starting point for R-03 |

---

## 6. Checklist

### 6.1 Process isolation and window configuration

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| ELEC-01 | `contextIsolation: true` | `electron-main.ts` `webPreferences` | Set | STATIC |
| ELEC-02 | `nodeIntegration: false` | Same | Set | STATIC |
| ELEC-03 | `sandbox: true` | Same | Set | STATIC |
| ELEC-04 | A **sandboxed preload still loads** (sandboxed preloads cannot `require` arbitrary modules) | Launch a real build; check the bridge exists | Preload works under `sandbox: true` — verify `preload.ts` uses no disallowed require | **RUNTIME** |
| ELEC-05 | `webSecurity` is not disabled | `grep -rn "webSecurity"` | Zero | STATIC |
| ELEC-06 | `allowRunningInsecureContent` is not enabled | grep | Zero | STATIC |
| ELEC-07 | `enableRemoteModule` is not used | grep | Zero | STATIC |
| ELEC-08 | No `nodeOptions` / `additionalArguments` leaking secrets | grep | Zero | STATIC |
| ELEC-09 | A single-instance lock exists | `app.requestSingleInstanceLock` | Present, or recorded missing | STATIC |
| ELEC-10 | `window-all-closed` behaviour is platform-correct | macOS should typically keep the app alive | Documented decision | STATIC |

### 6.2 IPC surface

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| ELEC-11 | Exactly four channels exist, all registered in main | Compare `ipcMain.handle` with `buildBridge` | No extra channel | STATIC |
| ELEC-12 | No channel accepts a caller-supplied path | Read every handler | Zero path parameters | STATIC |
| ELEC-13 | No channel accepts a caller-supplied command or URL | Read every handler | Zero | STATIC |
| ELEC-14 | `idcp:tokens:write` validates the shape | `sanitiseTokens` | Type + length clamped | STATIC |
| ELEC-15 | A renderer cannot invoke an unregistered channel and get data | Attempt in a build | Rejected | **RUNTIME** |
| ELEC-16 | The preload exposes no `ipcRenderer` object itself | Read `preload.ts` | Only the 4 functions | STATIC |
| ELEC-17 | `idcp:updates:check` never returns a fake "available" state | Read | Returns `up_to_date` or `disabled` | STATIC |

### 6.3 External navigation and link handling (**R-03**)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| ELEC-18 | `setWindowOpenHandler` exists | `electron-main.ts` | Present | STATIC |
| ELEC-19 | **It allow-lists the protocol** | Read | **Fails today** — `openExternal` called with any scheme | STATIC |
| ELEC-20 | **A `will-navigate` handler blocks unexpected navigation** | `grep -rn "will-navigate"` | **Absent** — add it | STATIC |
| ELEC-21 | `file:///etc/passwd` via `window.open` is blocked | T-03 in a packaged build | Blocked after fix | **RUNTIME** |
| ELEC-22 | `smb://` / custom schemes are blocked | T-04 | Blocked after fix | **RUNTIME** |
| ELEC-23 | An `https://` link opens in the **system browser**, not in the shell | Read handler | Confirmed (correct today) | STATIC |
| ELEC-24 | `setPermissionRequestHandler` denies unneeded permissions | `grep` | Absent — add or justify | STATIC |
| ELEC-25 | Deep-link / protocol registration is absent or documented | grep for `setAsDefaultProtocolClient` | Absent or documented | STATIC |
| ELEC-26 | The renderer cannot open a `file://` URL that renders local content | T-03 | Blocked | **RUNTIME** |

### 6.4 Token storage and keychain

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| ELEC-27 | Tokens are encrypted with `safeStorage` | `writeTokens` | `encryptString` | STATIC |
| ELEC-28 | File mode is `0o600` | `writeFileSync(..., { mode: 0o600 })` | Set | STATIC |
| ELEC-29 | The token file is deleted when both tokens are null (sign-out) | Read `writeTokens` | Deleted | STATIC |
| ELEC-30 | A corrupt token file never blocks startup | `readTokens` try/catch | Returns empty | STATIC |
| ELEC-31 | `isEncryptionAvailable() === false` degrades safely | Read | No plaintext fallback — **verify and confirm the user is told** | STATIC |
| ELEC-32 | **Linux without a keyring**: verify behaviour | Run on a headless Linux without gnome-keyring | Documented behaviour; ideally the UI warns that the session will not persist | **RUNTIME** |
| ELEC-33 | The file is genuinely encrypted | `hexdump -C session.bin` after sign-in | Not readable JSON | **RUNTIME** |
| ELEC-34 | No token in `localStorage`, cookies or prefs | Grep renderer + inspect userData dir | Zero | **RUNTIME** |

### 6.5 Packaging and signing (the `DESK-001` verification block)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| ELEC-35 | The renderer builds | `npm run build --workspace @idcp/desktop` | `dist/` produced | **RUNTIME** |
| ELEC-36 | The main process compiles to `dist-electron/electron-main.js` | `tsc -p tsconfig.electron.json` (or the documented build) | Produced | **RUNTIME** |
| ELEC-37 | `extraMetadata.main` points at the built entry | `electron-builder.json` | `dist-electron/electron-main.js` | STATIC |
| ELEC-38 | `files` globs include everything needed at runtime | `["dist/**/*","dist-electron/**/*","package.json"]` | Node/Electron/`@idcp/shared` bundled or present — **verify a packaged app actually starts** | **RUNTIME** |
| ELEC-39 | A Windows installer is produced and installs | `npm run dist -- --win` (or electron-builder) on Windows | `.exe` installs, app launches, sign-in works | **RUNTIME** |
| ELEC-40 | A macOS app is produced and launches | `--mac` on macOS | `.dmg`/`.zip`, app launches | **RUNTIME** |
| ELEC-41 | A Linux package is produced and launches | `--linux` | AppImage/deb launches | **RUNTIME** |
| ELEC-42 | Windows code signing | Authenticode with a real certificate | Signed; SmartScreen does not warn | **RUNTIME** |
| ELEC-43 | macOS signing + hardened runtime | `codesign -dv` | Signed, hardened runtime enabled | **RUNTIME** |
| ELEC-44 | macOS notarisation | `xcrun notarytool` submit + `stapler validate` | Accepted and stapled | **RUNTIME** |
| ELEC-45 | macOS entitlements are correct for a sandboxed renderer | Check for JIT/`com.apple.security.cs.allow-jit` as required | Present as needed; documented | STATIC |
| ELEC-46 | ASAR is enabled and integrity-protected | `asar: true`; consider `asarIntegrity` | Enabled; integrity plan documented | STATIC |
| ELEC-47 | `validate-packaging.mjs` actually validates something meaningful | Read the script; break a target and see if it fails | It asserts the contract statically — state exactly what | STATIC |
| ELEC-48 | CI packages the app | `ci.yml` | **Absent** — the only step is the renderer build; record | STATIC |
| ELEC-49 | Installer artefacts are archived per release | Process doc | Present or recorded missing | STATIC |
| ELEC-50 | Uninstall leaves no plaintext tokens behind | Uninstall, inspect leftovers | Clean | **RUNTIME** |

### 6.6 Auto-update

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| ELEC-51 | Update checking is real | `idcp:updates:check` | **Hardcoded** — no feed is contacted | STATIC |
| ELEC-52 | The publish URL is a placeholder | `https://updates.example.invalid/idcp` | Invalid host | STATIC |
| ELEC-53 | The UI does not promise updates it cannot deliver | Read the Settings/About surface | No false promise | STATIC |
| ELEC-54 | If an updater is added: signature verification is mandatory | Design decision | Documented requirement | STATIC |
| ELEC-55 | `IDCP_AUTO_UPDATE=off` truly disables it | Read + run with the env var | `{status:'disabled'}` | **RUNTIME** |

### 6.7 Renderer ↔ main integration (R-01 fix site)

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| ELEC-56 | The main process can inject a runtime API origin | Design | Proposed mechanism (env var, `additionalArguments`, a custom protocol, or a preload-provided value) | STATIC |
| ELEC-57 | The chosen mechanism does not leak a secret into the renderer | Review | Only a non-secret API URL | STATIC |
| ELEC-58 | A custom protocol (e.g. `app://`) is used for the renderer instead of `file://` | Recommendation | This solves origin, CSP and relative-URL problems in one step | STATIC |
| ELEC-59 | The CSP is preserved under the chosen origin strategy | Test after R-01 fix | Enforced, not loosened to `*` | **RUNTIME** |
| ELEC-60 | Dev vs production origin resolution is explicit | Read `vite.config.ts` + fix | Documented | STATIC |

### 6.8 Crash, logging and privacy on the desktop

| ID | Item | How to verify | Expected | Type |
|----|------|---------------|----------|------|
| ELEC-61 | Renderer crashes are handled | `render-process-gone` / `unresponsive` handlers | Present or recorded | STATIC |
| ELEC-62 | No crash reporter sends PII | Grep for crashReporter | Absent or configured | STATIC |
| ELEC-63 | Main-process logs do not include tokens | Read logging | Clean | STATIC |
| ELEC-64 | The app works offline (shows a clear offline state) | Disconnect the network | Legible state | **RUNTIME** |
| ELEC-65 | High-DPI / multi-monitor rendering is acceptable | Manual check | No clipping | **RUNTIME** |

---

## 7. Known desktop-platform risks to confirm or refute

| Risk | Statement |
|------|-----------|
| **R-03 (HIGH)** | `openExternal` unguarded; no `will-navigate` |
| **R-01 (CRITICAL)** | Packaged app cannot reach the API |
| R-08 | `DESK-001` carries a `verification` block precisely because no installer has ever been built |
| R-15 | CSP is a meta tag only; no response-header CSP in the shell |
| R-21 | `AGENT_STATE.md` says installers are "not a code gap" — test that claim |

---

## 8. Questions you must answer

1. **Can a user install and sign in to this application on Windows, macOS and Linux today?** Demonstrate.
2. What exactly can renderer content do to the operating system via `window.open`?
3. What happens to the session on Linux when no keyring is available? Is the user told?
4. Is the packaging contract validator testing the artefact or only the JSON?
5. What is the update story, and does the UI tell the truth about it?
6. Where must the API origin be injected for R-01's fix, and what is the least invasive correct design?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- static shell review ----------
grep -n "contextIsolation\|nodeIntegration\|sandbox\|webSecurity\|preload" apps/desktop/src/main/electron-main.ts
grep -n "ipcMain.handle" apps/desktop/src/main/electron-main.ts
grep -n "exposeInMainWorld\|invoke(" apps/desktop/src/main/preload.ts
grep -rn "setWindowOpenHandler\|openExternal\|will-navigate\|setPermissionRequestHandler" apps/desktop/src
grep -rn "localStorage\|sessionStorage\|crashReporter\|setAsDefaultProtocolClient" apps/desktop/src

# ---------- build ----------
npm run build --workspace @idcp/desktop
npx tsc -p apps/desktop/tsconfig.electron.json --outDir apps/desktop/dist-electron
ls -la apps/desktop/dist apps/desktop/dist-electron

# ---------- packaging (per platform) ----------
cd apps/desktop
npx electron-builder --linux AppImage --x64      # on Linux
npx electron-builder --win nsis --x64            # on Windows
npx electron-builder --mac dmg --x64             # on macOS
ls -la release/

# ---------- signing verification ----------
# macOS
codesign -dv --verbose=4 "release/mac/IDCP.app"
xcrun notarytool submit release/IDCP.dmg --wait
xcrun stapler validate release/IDCP.dmg
# Windows
signtool verify /pa /v "release/IDCP Setup.exe"

# ---------- packaged app smoke ----------
./release/IDCP.AppImage --no-sandbox &   # or the installed binary
# then: sign in (this will FAIL until R-01 is fixed — that is the point)

# ---------- token file ----------
find ~/.config -name session.bin -exec ls -l {} \; -exec hexdump -C {} \; | head -20

# ---------- contract validator ----------
node scripts/validate-packaging.mjs ; echo "exit=$?"
# break a target in electron-builder.json, re-run, confirm it fails, then revert
```

---

## 10. Tests to perform

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| T-01 | **Build + install + launch on Windows** | Produce NSIS installer, install, launch | App opens, no console errors |
| T-02 | **Build + install + launch on macOS** | Produce dmg/zip, notarise, open | Gatekeeper passes; app opens |
| T-03 | **Build + install + launch on Linux** | Produce AppImage/deb | App opens |
| T-04 | Sign-in on a packaged build | Sign in as owner | **Fails today (R-01)** — after fix, succeeds |
| T-05 | `window.open('file:///etc/passwd')` | Packaged build | Blocked after R-03 fix |
| T-06 | `window.open('smb://evil/share')` | Packaged build | Blocked after fix |
| T-07 | In-page navigation to `https://example.com` | Packaged build | Blocked after fix |
| T-08 | IPC fuzz | Invoke all 4 channels with malformed payloads | No crash, no data leak |
| T-09 | Keychain absence | Run on Linux without a keyring | Graceful; user informed |
| T-10 | Sign-out | Sign out | `session.bin` removed |
| T-11 | Update check | Call `idcp:updates:check` | `up_to_date`/`disabled`, never a false `available` |
| T-12 | Uninstall | Remove the app | No tokens left in userData |
| T-13 | Offline launch | No network | Clear offline state, no crash |

---

## 11. Evidence required

```
docs/reviewers/evidence/R10/
├── security-checklist.md        # Electron security checklist, item by item
├── r03-fix.md                   # exact code change for openExternal allow-list + will-navigate
├── installers/                  # artefacts or SHA-256 + build logs per platform
├── signing-proof.md             # codesign/notarytool/signtool output
├── smoke-tests.md               # T-01 … T-13 per platform
├── runtime-config-design.md     # R-01 fix mechanism recommendation (with R09)
├── token-storage.md             # encryption proof + keyring-absent behaviour
├── commands.log
└── findings.md                  # ELEC-### register
```

---

## 12. Passing conditions (evidence only — no gate approval)

- [ ] **P1** `contextIsolation`, `nodeIntegration: false`, `sandbox: true` all set and a sandboxed preload is proven to load (ELEC-01 … ELEC-04).
- [ ] **P2** IPC is exactly four validated channels with no path/command parameters (ELEC-11 … ELEC-17).
- [ ] **P3** **`openExternal` allow-lists `https:` (and any other scheme) explicitly, and `will-navigate` blocks foreign origins** (ELEC-19, ELEC-20, T-05 … T-07).
- [ ] **P4** Tokens are encrypted, `0600`, removed on sign-out, and degrade safely without a keyring (ELEC-27 … ELEC-34, T-09, T-10).
- [ ] **P5** **Signed installers exist for Windows, macOS and Linux, and a human has launched each** — this closes the `DESK-001` verification block (ELEC-39 … ELEC-46, T-01 … T-03).
- [ ] **P6** The packaged app can sign in (requires the R-01 fix) (T-04).
- [ ] **P7** Update behaviour is honest — no fake update states in the UI (ELEC-51 … ELEC-55, T-11).
- [ ] **P8** CI packages the app, or the manual release process is written and reproducible (ELEC-48, ELEC-49).
- [ ] **P9** The R-01 runtime-configuration mechanism is designed, agreed with R09 and implemented without loosening the CSP (ELEC-56 … ELEC-60).

---

## 13. Blocked items

| Item ID | Blocker | What unblocks it | Owner |
|---------|---------|------------------|-------|
| ELEC-42 | No Windows code-signing certificate | Owner/procurement | R19 |
| ELEC-43, ELEC-44 | No Apple Developer ID + notary credentials | Owner/procurement | R19 |
| T-01 … T-03 | No macOS/Windows runners in this environment | CI OS matrix or manual machines | R19 |

---

## 14. Findings register

| ID | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
|----|----------|-----------|---------|----------------|-----------|---------------|-------|
| ELEC-001 | | | | | | | |

---

## 15. Reviewer sign-off

| Field | Value |
|-------|-------|
| Reviewer name | |
| Date started | |
| Date completed | |
| Co-sign G2 / G3 / G10 | ☐ ☐ ☐ |
| Installers built | ☐ Windows ☐ macOS ☐ Linux |
| Conditions failed (IDs) | |
| Reviewed commit | `43d384b` |
| Statement | *I built, signed where credentials allowed, installed and launched the application on every platform I could reach, and reproduced or refuted every Electron hardening claim in §6.* |
| Signature | |
