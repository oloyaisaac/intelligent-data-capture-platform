# REVIEWER NAME: Desktop Platform / Electron Packaging Engineer (R10)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R10-electron-platform-packaging.md` (65 checklist items)
**STATUS:** ☑ Complete — **installer build not executed** (no signing certificates, no OS runners)

---

## AREAS EXAMINED

`electron-main.ts` · `preload.ts` · `electron-builder.json` · build targets · code signing · auto-update · `validate-packaging.mjs`.

---

## 1. Summary of examination

I read the main process and preload in full, inspected the builder configuration, and ran `npm run test:packaging`. I then checked whether any installer has ever been produced.

**Verdict: no installer has ever been built, and the configuration is not ready to produce one.** Three concrete blockers: **only Windows targets are configured**, the **update feed points at a placeholder domain**, and there is **zero signing configuration**. Alongside that, the shell has the two security gaps R07 covers (`openExternal`, no `will-navigate`).

---

## 2. Files and components inspected

| File | LOC | Checked |
|---|---|---|
| `apps/desktop/src/main/electron-main.ts` | 157 | full read |
| `apps/desktop/src/preload.ts` | 62 | bridge surface |
| `apps/desktop/electron-builder.json` | 48 | targets, publish, files |
| `scripts/validate-packaging.mjs` | — | what it enforces |
| `apps/desktop/package.json` | — | build scripts |

---

## 3. Features examined

Window creation · protocol/navigation · external links · preload bridge · build targets · artefact naming · update feed · signing · packaging validation.

---

## 4. Tests performed

| # | Test | Result |
|---|---|---|
| T1 | `npm run test:packaging` | **PASS** |
| T2 | Build targets | **Windows only** — nsis (x64/arm64) + portable (x64) |
| T3 | macOS / Linux targets | **ABSENT** |
| T4 | Signing config | **ABSENT** — no `certificateFile`, no `notarize`, no `identity` |
| T5 | Update feed | **`https://updates.example.invalid/idcp`** — placeholder |
| T6 | Does a built installer exist? | **NO** — `apps/desktop/release/` does not exist |
| T7 | `openExternal` validation | **FAIL** (cross-ref SEC-001) |
| T8 | `will-navigate` handler | **ABSENT** (cross-ref SEC-002) |
| T9 | Preload surface minimality | **PASS** — narrow, explicit API |
| T10 | Installer on real hardware | **NOT RUN** |

---

## 5. Successful findings

1. **The preload bridge is minimal and explicit** — it exposes a small named API rather than `ipcRenderer` wholesale. This is the correct pattern and better than most Electron codebases.
2. **`validate-packaging.mjs` runs in CI** and is wired to `npm run test:packaging`, so packaging configuration cannot drift silently.
3. **`files` is explicit** (`dist/**/*`, `dist-electron/**/*`, `package.json`, excludes maps and tests) — the shipped artefact will not contain test code or source maps.
4. **Both x64 and arm64 are targeted for Windows** — the architecture matrix was considered.

---

## 6. Identified problems

### ELEC-001 — Only Windows targets are configured; no macOS or Linux build exists

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/electron-builder.json` |
| **Evidence** | The configuration declares `win` targets only (`nsis`, `portable`). No `mac`, no `linux` block. |
| **Expected** | At minimum a documented decision that the product is Windows-only |
| **Actual** | Silent absence. `DEPLOYMENT.md` and `PRD.json` do not state a platform restriction that matches this. |
| **Verification** | Read the builder JSON; `ls apps/desktop/release` → absent |

**Recommended correction:** Either add `mac` (dmg, universal) and `linux` (AppImage, deb) targets, **or** state "Windows only" in `README.md`, `DEPLOYMENT.md` and the Terms. Both are defensible; silence is not.

---

### ELEC-002 — The update feed points at a non-existent domain

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/electron-builder.json` — `publish` |
| **Evidence** | `publish: [{ "provider": "generic", "url": "https://updates.example.invalid/idcp" }]` |
| **Expected** | A real update endpoint, or no publish block at all |
| **Actual** | `example.invalid` is a reserved non-resolvable TLD. If `electron-updater` is wired to this, every installed copy will fail its update check; if it is not wired, the block is misleading. |
| **Verification** | Read the JSON |
| **Security angle** | An unsigned, unverified update channel is the classic Electron supply-chain vector. Shipping *any* auto-update without code signing is worse than shipping none. |

**Recommended correction:** Remove the `publish` block until there is a signed release pipeline, or point it at a real endpoint **with** signature verification (`verifyUpdateCodeSignature`).

---

### ELEC-003 — No code signing or notarisation configuration

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/electron-builder.json` |
| **Evidence** | No `certificateFile`, `certificatePassword`, `notarize`, `identity`, or `signAndEditExecutable` settings. |
| **Expected** | Windows Authenticode signing; macOS notarisation |
| **Actual** | Absent. An unsigned NSIS installer triggers SmartScreen "unrecognised app" warnings; macOS would refuse to launch an un-notarised app entirely. |
| **Verification** | Read the JSON; `grep -i "sign\|cert\|notar"` → zero |

**Recommended correction:** Wire signing from CI secrets. Until then, label builds "unsigned development builds" and do not distribute them to customers.

---

### ELEC-004 — `openExternal` is unvalidated (duplicate of SEC-001, shell owner)

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/src/main/electron-main.ts:129-130` |
| **Evidence** | `setWindowOpenHandler(({ url }) => { void api.shell.openExternal(url); ... })` |
| **Expected** | Scheme allow-list |
| **Actual** | Any scheme passed to the OS |
| **Verification** | Read lines 128-131 |
| **Note** | Same underlying defect as SEC-001. Recorded here because the shell owns the fix. |

---

### ELEC-005 — No `will-navigate` guard (duplicate of SEC-002, shell owner)

| Field | Value |
|---|---|
| **Severity** | **HIGH** |
| **Affected** | `apps/desktop/src/main/electron-main.ts` |
| **Evidence** | `grep -c "will-navigate"` → 0 |
| **Expected** | Navigation away from the app document prevented |
| **Actual** | Permitted; preload bridge persists into the new document |
| **Verification** | grep |

---

### ELEC-006 — `validate-packaging.mjs` validates structure, not buildability

| Field | Value |
|---|---|
| **Severity** | **MEDIUM** |
| **Affected** | `scripts/validate-packaging.mjs` |
| **Evidence** | The test passes while no buildable configuration exists (no signing, placeholder feed, one platform). It checks declared shape, not that `electron-builder` can produce an artefact. |
| **Expected** | Either a real build in CI (even unsigned) or an honest name for the check |
| **Actual** | "test:packaging" passing implies more than it delivers |
| **Verification** | Read the script; note it never invokes `electron-builder` |

**Recommended correction:** Add a CI job that runs `electron-builder --dir` (no signing) to prove the config builds, and rename the current check to `test:packaging-config`.

---

## 7. Missing functionality

| Item | Status |
|---|---|
| macOS target | **Not implemented** |
| Linux target | **Not implemented** |
| Code signing | **Not implemented** |
| Notarisation | **Not implemented** |
| Real update endpoint | **Not implemented** |
| Build in CI | **Not implemented** |
| Installer smoke test | **Not implemented** |

---

## 8. Security concerns

The shell is the weakest security surface in the product: `openExternal` unvalidated, no navigation guard, and a publish/update configuration pointing at a placeholder with no signing. Any future auto-update on this configuration would be exploitable.

---

## 9. Performance concerns

None specific. Bundle size is not measured; noted for R17.

---

## 10. Recommendations

1. **Decide the platform story** (ELEC-001) — Windows-only is a legitimate answer, but it must be written down.
2. **Remove the `publish` block** until signing exists (ELEC-002 + ELEC-003). Do not ship an update channel you cannot verify.
3. Fix the two shell vulnerabilities (ELEC-004/005) — shared with R07.
4. Add a build-only CI job so "it builds" becomes a fact (ELEC-006).

---

## EVIDENCE CLASSIFICATION

| Class | Items |
|---|---|
| **A. Verified working** | Minimal preload surface, explicit `files`, packaging config in CI, dual-arch Windows |
| **B. Verified failing** | ELEC-001 … ELEC-006 |
| **C. Not implemented** | mac/linux, signing, notarisation, update endpoint, CI build, smoke test |
| **D. Partially implemented** | Packaging validation (shape only) |
| **E. Unable to verify** | Actual installer behaviour, SmartScreen outcome, update flow |

---

## ISSUE SUMMARY

| ID | Severity | Title |
|---|---|---|
| ELEC-001 | **HIGH** | Windows-only targets, undocumented |
| ELEC-002 | **HIGH** | Update feed points at `example.invalid` |
| ELEC-003 | **HIGH** | No code signing or notarisation |
| ELEC-004 | **HIGH** | `openExternal` unvalidated (SEC-001) |
| ELEC-005 | **HIGH** | No navigation guard (SEC-002) |
| ELEC-006 | MEDIUM | Packaging test does not prove buildability |

**Totals: 0 CRITICAL · 5 HIGH · 1 MEDIUM · 0 LOW**
