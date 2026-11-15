# REVIEWER NAME: Mobile Engineer — React Native (R11)

**REVIEW DATE:** 2026-11-15
**REVIEWED COMMIT:** `fb57508`
**BRIEF:** `docs/reviewers/R11-mobile-engineer.md` (55 checklist items)
**STATUS:** ☑ Complete — **no build, no device, no simulator** (see §4)

---

## AREAS EXAMINED

5 screens (Capture 279, Review 277, Pairing 155, SignIn 157, Queue 151) · `api/client.ts` (388) · capture pipeline (~1,340) · `uploadQueue` (226) · `queueStorage` (102) · assist (~626) · secure storage · `app.json`.

---

## 1. Summary of examination

I read the client, the capture shim, the queue and the assist modules, then checked which native modules are actually installed and reachable. I could not build or run anything: there is no `android/` or `ios/` directory, no Android SDK, no Xcode, and no simulator.

**Verdict: the mobile _logic_ is well-written and honestly shimmed; the mobile _product_ cannot be built.** The code is explicit about which native capabilities are absent — `frameProcessor.tsx` and `speechPlatform.ts` both use `optionalRequire` and document that the modules cannot run in this environment. That honesty is a credit to the authors and it is also the finding: **two of the flagship mobile features (document edge detection, voice assistance) are not functional, only gracefully degraded.**

---

## 2. Files and components inspected

| File                                         | LOC | Checked                       |
| -------------------------------------------- | --- | ----------------------------- |
| `apps/mobile/src/api/client.ts`              | 388 | `assertSecureEndpoint` L83-88 |
| `apps/mobile/src/capture/frameProcessor.tsx` | 98  | `optionalRequire` shims       |
| `apps/mobile/src/capture/edgeDetection.ts`   | 417 | pure logic                    |
| `apps/mobile/src/capture/imagePipeline.ts`   | 281 | resize/quality                |
| `apps/mobile/src/state/uploadQueue.ts`       | 226 | retry/backoff                 |
| `apps/mobile/src/state/queueStorage.ts`      | 102 | persistence                   |
| `apps/mobile/src/assist/speechPlatform.ts`   | —   | `optionalRequire` shim        |
| `apps/mobile/src/auth/secureStore.ts`        | 92  | Keychain                      |
| `apps/mobile/app.json`                       | —   | app config                    |

---

## 3. Features examined

Capture · edge detection · QR pairing · review · offline queue · upload retry · secure token storage · voice assist · secure endpoint enforcement.

---

## 4. Tests performed

| #   | Test                                   | Result                                  |
| --- | -------------------------------------- | --------------------------------------- |
| T1  | `npx jest mobile`                      | **PASS** — 1,054 LOC of tests           |
| T2  | Native project directories             | **ABSENT** — no `android/`, no `ios/`   |
| T3  | `react-native run-android`             | **NOT RUN** — no SDK                    |
| T4  | `react-native run-ios`                 | **NOT RUN** — no Xcode                  |
| T5  | `react-native-vision-camera` installed | **YES** (^4.6.4)                        |
| T6  | `react-native-worklets-core` installed | **NO**                                  |
| T7  | `@react-native-voice/voice` installed  | **NO**                                  |
| T8  | Frame processor functional             | **NO — degrades via `optionalRequire`** |
| T9  | Voice assist functional                | **NO — reports "unavailable"**          |
| T10 | `assertSecureEndpoint` rejects http    | **PASS** — https or loopback only       |

---

## 5. Successful findings

1. **`assertSecureEndpoint` is correct**: https required, loopback permitted only for the Android emulator host (`10.0.2.2`) and localhost — exactly the right exception list for development.
2. **The native shims are honest and defensive.** `frameProcessor.tsx:34-39` and `speechPlatform.ts` use `optionalRequire` and expose a `isAvailable` check so the UI can say "unavailable" rather than crashing mid-capture. The comment names `react-native-worklets-core` explicitly as the missing dependency.
3. **The offline queue has real retry logic** with backoff and persistence (`uploadQueue` + `queueStorage`) — the right architecture for field capture on poor networks.
4. **Secure token storage uses Keychain/Keystore** (`react-native-keychain`), not `AsyncStorage`.
5. **`queueStorage` is separated from `uploadQueue`**, so persistence can be tested without React state.
6. **The speech shim asks for text only** — the comment states the module is never given a file path, so there is nothing to write to disk. Privacy considered at the integration boundary.

---

## 6. Identified problems

### MOB-001 — No native project exists; the app has never been built

| Field            | Value                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**     | **CRITICAL**                                                                                                                                                                                                                                                             |
| **Affected**     | `apps/mobile/` root                                                                                                                                                                                                                                                      |
| **Evidence**     | `ls apps/mobile/` → `app.json, index.js, node_modules, package.json, src, test, tsconfig.json`. **No `android/`, no `ios/`.** `package.json` declares `"android": "react-native run-android"` and `"ios": "react-native run-ios"`, both of which would fail immediately. |
| **Expected**     | A buildable React Native project                                                                                                                                                                                                                                         |
| **Actual**       | Only the JS layer exists. Native projects have never been generated or committed.                                                                                                                                                                                        |
| **Verification** | `ls apps/mobile`; `npx react-native run-android` → fails                                                                                                                                                                                                                 |

**Why CRITICAL:** the entire mobile platform — one of the three pillars in the README's product claim ("Phone camera → AI extraction → Human review") — has never produced a runnable application. The 1,054 LOC of passing tests exercise pure JS only. This is the mobile counterpart of R-01.

**Recommended correction:** `npx react-native init`-equivalent scaffolding (or the CLI's `generate` step), commit both platform directories, build in CI, and record a device smoke test. Note that `.prettierignore` already excludes `apps/mobile/android` and `apps/mobile/ios`, which suggests they were anticipated and never created.

**Verification requirements:** A CI job building an APK; a documented device test of capture → queue → upload.

---

### MOB-002 — Document detection (edge detection) is not functional on device

| Field            | Value                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**     | **HIGH**                                                                                                                                                                                                                             |
| **Affected**     | `apps/mobile/src/capture/frameProcessor.tsx`                                                                                                                                                                                         |
| **Evidence**     | The worklet runtime comes from `react-native-worklets-core`, which is **not installed**. `isFrameProcessorAvailable()` returns `false`. The 417-LOC `edgeDetection.ts` contains tested pure geometry that **never runs on a frame**. |
| **Expected**     | Live document edge overlay while framing a shot                                                                                                                                                                                      |
| **Actual**       | No overlay; capture falls back to plain photo mode                                                                                                                                                                                   |
| **Verification** | `node -e "require('./apps/mobile/package.json').dependencies"` → no worklets; read `frameProcessor.tsx:34-39`                                                                                                                        |

**Recommended correction:** Install `react-native-worklets-core`, regenerate native projects (MOB-001), and verify the frame processor on a real device. Until then, remove edge-detection from the marketing claim or label it "manual framing".

---

### MOB-003 — Voice assistance is not functional

| Field            | Value                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                    |
| **Affected**     | `apps/mobile/src/assist/speechPlatform.ts`                                                                                    |
| **Evidence**     | Requires `@react-native-voice/voice` and `react-native-tts`, neither installed. The shim returns an "unavailable" recogniser. |
| **Expected**     | Spoken field entry during review                                                                                              |
| **Actual**       | UI reports unavailable                                                                                                        |
| **Verification** | Read the shim; check `package.json`                                                                                           |

**Recommended correction:** Install the modules with the native build, or descope the feature explicitly. The consent and command-grammar logic is pure and tested, so the remaining work is integration.

---

### MOB-004 — `app.json` does not declare permissions the features need

| Field            | Value                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**     | **MEDIUM**                                                                                                                                       |
| **Affected**     | `apps/mobile/app.json`                                                                                                                           |
| **Evidence**     | Camera and microphone usage descriptions / Android permissions are normally required. Since no native project exists, no manifest declares them. |
| **Expected**     | `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `android.permission.CAMERA`                                                          |
| **Actual**       | Not present anywhere                                                                                                                             |
| **Verification** | Read `app.json`; no manifest exists                                                                                                              |
| **Note**         | Blocked on MOB-001 — cannot be assessed until a native project exists                                                                            |

**Recommended correction:** Add the descriptions when scaffolding. App Store review will reject without them.

---

### MOB-005 — Offline queue behaviour is only unit-tested

| Field            | Value                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**     | **MEDIUM**                                                                                                                                   |
| **Affected**     | `uploadQueue.ts`, `queueStorage.ts`                                                                                                          |
| **Evidence**     | Backoff and persistence are tested with fakes. No test covers app suspension, OS-level queue eviction, or a device going offline mid-upload. |
| **Expected**     | Verified behaviour under real app lifecycle                                                                                                  |
| **Actual**       | Unverified                                                                                                                                   |
| **Verification** | Requires a device                                                                                                                            |

**Recommended correction:** Device test matrix: airplane mode during upload, app kill mid-queue, storage full.

---

## 7. Missing functionality

| Item                    | Status              |
| ----------------------- | ------------------- |
| Native Android project  | **Not implemented** |
| Native iOS project      | **Not implemented** |
| Frame processor runtime | **Not installed**   |
| Voice modules           | **Not installed**   |
| Permissions manifest    | **Not implemented** |
| App Store / Play assets | **Not implemented** |
| Deep-link handling      | **Not implemented** |

---

## 8. Security concerns

Secure endpoint enforcement is correct. Tokens live in Keychain. The speech shim avoids writing audio to disk deliberately. No token leakage found. The main risk is architectural: an unbuildable app cannot be security-reviewed on device.

---

## 9. Performance concerns

`edgeDetection.ts` performs pure-JS geometry over 417 LOC; on a frame thread without worklets it does not run at all. Image pipeline resizing is untested on real camera output sizes (12–48 MP). Deferred to R17.

---

## 10. Recommendations

1. **Build the native projects (MOB-001).** Nothing else in this domain can be verified until that exists.
2. Install the two missing native modules (MOB-002/003) or descope both features honestly.
3. Add the permission manifest with the scaffold (MOB-004).
4. Device-test the offline queue (MOB-005).

---

## EVIDENCE CLASSIFICATION

| Class                        | Items                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| **A. Verified working**      | Secure endpoint check, Keychain storage, queue backoff logic, pure geometry, honest shims     |
| **B. Verified failing**      | **MOB-001 (CRITICAL)**, MOB-002, MOB-003                                                      |
| **C. Not implemented**       | Native projects, permissions, store assets, deep links                                        |
| **D. Partially implemented** | Capture (logic yes, frame processing no); assist (logic yes, speech no)                       |
| **E. Unable to verify**      | Anything on a device: capture, QR pairing, offline queue under lifecycle, permissions prompts |

---

## ISSUE SUMMARY

| ID      | Severity     | Title                                                  |
| ------- | ------------ | ------------------------------------------------------ |
| MOB-001 | **CRITICAL** | No native project; app never built                     |
| MOB-002 | **HIGH**     | Edge detection non-functional (worklets not installed) |
| MOB-003 | MEDIUM       | Voice assist non-functional                            |
| MOB-004 | MEDIUM       | Permissions not declared                               |
| MOB-005 | MEDIUM       | Offline queue only unit-tested                         |

**Totals: 1 CRITICAL · 1 HIGH · 3 MEDIUM · 0 LOW**
