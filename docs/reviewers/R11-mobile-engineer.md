# REVIEWER 11 — MOBILE ENGINEER (React Native)

| Field              | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| **Reviewer ID**    | R11                                                                |
| **Title**          | Mobile Engineer — React Native (Android + iOS)                     |
| **Board**          | C — Client platforms & experience                                  |
| **Wave**           | 3 (weeks 3–5)                                                      |
| **Effort**         | 12 person-days                                                     |
| **Gate chaired**   | none                                                               |
| **Co-signs**       | G2                                                                 |
| **Evidence to**    | G7 (contributes findings, not an approver)                         |
| **Finding prefix** | `MOB-###`                                                          |
| **Upstream**       | R04 (API contract), R05 (token lifecycle)                          |
| **Downstream**     | R22 (pilot on real devices), R12, R13                              |
| **Status**         | ☐ Not started ☐ In progress ☐ Blocked ☐ Complete ☐ Passed ☐ Failed |

---

## 1. Mission

Determine whether the mobile app — the **capture end** of the entire product — works on real hardware:
pairing by QR, camera capture with edge detection, offline queue durability, upload reliability, secure
credential storage. Every value in the product starts here; if capture fails, nothing downstream matters.

**Specific to this repository.** The mobile app has **1 054 lines of tests** and only JS-level verification.
Three native capabilities are declared but **not installed** in the checkout:

| Capability                               | Module                                          | Present?          | Consequence                                                                       |
| ---------------------------------------- | ----------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| Frame processor / edge-detection overlay | `react-native-worklets-core`                    | **No**            | The overlay is inert; `frameProcessor.tsx` only builds a processor when installed |
| Speech commands / TTS                    | `@react-native-voice/voice`, `react-native-tts` | **No**            | `speechPlatform.ts` reports unavailable; screens stay button-only                 |
| Camera, barcode, keychain, filesystem    | RN core modules                                 | Presumed prebuilt | **No native build has ever been produced**                                        |

`PRD.json` marks `MOB-001` with a `verification` block for exactly this reason. Your job is to produce the
first real device evidence.

---

## 2. Required expertise

- React Native 0.86 architecture (bridge/JSI, worklets, native modules)
- React Navigation 7 patterns
- `react-native-vision-camera` frame processors and worklets
- Native module linking on Android (Gradle) and iOS (CocoaPods)
- Offline-first sync design, durable queues, idempotent uploads
- Keychain/Keystore security on both platforms
- Mobile performance constraints (memory, battery, thermal, camera throughput)

---

## 3. Repository context (self-contained)

**Product.** A phone photographs a document; the app detects and enhances the page, queues it offline, and
uploads it to the backend where AI extracts fields and a human reviews them.

**Mobile structure (`apps/mobile`):**

| Area                                        | File                                                                                                  | LOC   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----- |
| App shell, navigation                       | `src/App.tsx`                                                                                         | 174   |
| API client (TLS enforcement)                | `src/api/client.ts`                                                                                   | 388   |
| Screens                                     | `screens/{CaptureScreen 279, ReviewScreen 277, PairingScreen 155, SignInScreen 157, QueueScreen 151}` | 1 019 |
| Edge detection (pure)                       | `capture/edgeDetection.ts`                                                                            | 417   |
| Image pipeline (EXIF, crop, compress)       | `capture/imagePipeline.ts`                                                                            | 281   |
| Frame processor (needs worklets)            | `capture/frameProcessor.tsx`                                                                          | 98    |
| Detector hook                               | `capture/useDocumentDetector.ts`                                                                      | 92    |
| QR scanner view                             | `capture/QrScannerView.tsx`                                                                           | 100   |
| Offline upload queue                        | `state/uploadQueue.ts`                                                                                | 226   |
| Queue persistence                           | `state/queueStorage.ts`                                                                               | 102   |
| Assist (commands, consent, guidance, voice) | `assist/*.ts`                                                                                         | 626   |
| Secure storage                              | `auth/{secureStore.ts 92, memoryStore.ts 51, keys.ts 5}`                                              | 148   |
| Pairing                                     | `pairing/pairing.ts`                                                                                  | 59    |
| UI locale/theme                             | `ui/{locale.ts 50, theme.ts 40}`                                                                      | 90    |
| Tests                                       | `test/mobile.test.ts`                                                                                 | 1 054 |
| Manifest                                    | `app.json`, `package.json`, `index.js`                                                                | 43    |

**Manifest facts:** `app.json` is 5 lines; `package.json` is 30 lines; entry `index.js` is 8 lines.
**There is no `android/` or `ios/` directory in the repository** — the native projects are not committed.
Confirm this and record what it means for buildability.

**Backend contract the app depends on:** `POST /pairing/sessions`, `POST /pairing/complete`,
`POST /documents` (with `Idempotency-Key`), `GET /documents/:id`, review endpoints, `X-Device-Credential`
header authentication.

---

## 4. Exact files and components to examine

### 4.1 Must read in full

Every file in `apps/mobile/src/` (26 files, listed above) plus `app.json`, `package.json`, `index.js`,
`tsconfig.json`, and `apps/mobile/test/mobile.test.ts` (1 054 lines).

### 4.2 Must cross-check against the backend

- `apps/backend/src/http/routes/pairing-routes.ts` — pairing token semantics (single-use, 120 s).
- `apps/backend/src/http/guards.ts` — how `X-Device-Credential` becomes an actor.
- `apps/backend/src/services/document-service.ts` — idempotency key semantics.
- `packages/shared/src/contracts.ts` — device/pairing request shapes.

### 4.3 Explicit non-goals

Backend correctness → R02 · token strength → R05 · full WCAG audit of mobile screens → R13 ·
server-side performance → R17.

---

## 5. Upstream artefacts required

| From | Artefact                               | Why                                             |
| ---- | -------------------------------------- | ----------------------------------------------- |
| R04  | `evidence/R04/coverage-diff.md`        | Confirm the app uses documented endpoints       |
| R05  | `evidence/R05/credential-lifecycle.md` | Token rotation behaviour the app must implement |

---

## 6. Checklist

### 6.1 Buildability (the `MOB-001` verification block)

| ID     | Item                                              | How to verify                                    | Expected                                                                                                                  | Type        |
| ------ | ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| MOB-01 | There is no `android/` project                    | `ls apps/mobile`                                 | Confirm absence; record the consequence (cannot build without `npx react-native init`-style scaffolding or Expo prebuild) | STATIC      |
| MOB-02 | There is no `ios/` project                        | Same                                             | Same                                                                                                                      | STATIC      |
| MOB-03 | `app.json` identifies the app correctly           | Read                                             | Name, slug, scheme defined                                                                                                | STATIC      |
| MOB-04 | Native dependencies are declared                  | Read `package.json`                              | Camera, barcode, keychain, filesystem listed                                                                              | STATIC      |
| MOB-05 | Worklets and speech modules are **not** installed | Read `package.json`; `grep`                      | Confirmed; the app must degrade                                                                                           | STATIC      |
| MOB-06 | An Android debug build succeeds                   | `npx react-native run-android` after scaffolding | Builds and installs                                                                                                       | **RUNTIME** |
| MOB-07 | An iOS build succeeds                             | `pod install` + `npx react-native run-ios`       | Builds and launches                                                                                                       | **RUNTIME** |
| MOB-08 | A release build succeeds for both platforms       | `assembleRelease` / archive                      | Signed artefacts                                                                                                          | **RUNTIME** |
| MOB-09 | Metro bundles without error                       | `npx react-native bundle`                        | Succeeds                                                                                                                  | **RUNTIME** |

### 6.2 Pairing

| ID     | Item                                                                               | How to verify                                                                                       | Expected                        | Type        |
| ------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------- | ----------- |
| MOB-10 | The QR scanner reads the desktop's pairing payload                                 | Real device scan                                                                                    | Completes pairing               | **RUNTIME** |
| MOB-11 | The payload is validated as a pairing token, **not** a URL                         | Feed the scanner `https://evil.test`                                                                | Rejected with a clear message   | **RUNTIME** |
| MOB-12 | An expired token (120 s) is rejected cleanly                                       | Wait and scan                                                                                       | Clear message                   | **RUNTIME** |
| MOB-13 | A replayed token is rejected                                                       | Scan the same QR twice                                                                              | Second rejected                 | **RUNTIME** |
| MOB-14 | The resulting device credential is stored in the keychain only                     | Read `secureStore.ts`                                                                               | Confirmed                       | STATIC      |
| MOB-15 | The app sends `X-Device-Credential`, never a user bearer token, for device actions | Read `api/client.ts`                                                                                | Confirmed                       | STATIC      |
| MOB-16 | Revocation is handled: a revoked device signs out with an explanation              | Revoke server-side, act in the app                                                                  | 401 → signed out with a message | **RUNTIME** |
| MOB-17 | The server address is validated as HTTPS                                           | Read `assertSecureEndpoint`                                                                         | Enforced                        | STATIC      |
| MOB-18 | **The loopback exception cannot be abused**                                        | Test `https://127.0.0.1.evil.test`, `https://evil.test/?x=127.0.0.1`, `https://evil.test/#10.0.2.2` | Anchored regex rejects all      | **RUNTIME** |

### 6.3 Camera and capture

| ID     | Item                                                          | How to verify                            | Expected                                             | Type        |
| ------ | ------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- | ----------- |
| MOB-19 | Camera permission is requested with a clear rationale         | Read `CaptureScreen.tsx`                 | Present                                              | STATIC      |
| MOB-20 | Denying permission leaves the app usable                      | Deny on device                           | Clear message, no crash                              | **RUNTIME** |
| MOB-21 | Capture produces a correctly oriented image                   | Capture a portrait and a landscape page  | No rotation bug (EXIF handled in `imagePipeline.ts`) | **RUNTIME** |
| MOB-22 | The edge detector is **pure** and unit-tested                 | Read `edgeDetection.ts` + tests          | No native dependency                                 | STATIC      |
| MOB-23 | The crop plan produces a usable page from a skewed photo      | Test with 10 real photos                 | Acceptable crop                                      | **RUNTIME** |
| MOB-24 | Enhancement and compression respect the 20 MB upload cap      | Capture a 48 MP photo                    | Result < 20 MB                                       | **RUNTIME** |
| MOB-25 | **The overlay is honest when worklets are absent**            | Run without `react-native-worklets-core` | No "detecting…" claim; the user is not misled        | **RUNTIME** |
| MOB-26 | Memory does not blow up on repeated captures                  | Capture 20 pages                         | No OOM, no thermal shutdown                          | **RUNTIME** |
| MOB-27 | Multi-page capture works or is explicitly unsupported         | Try 3 pages                              | Documented behaviour                                 | **RUNTIME** |
| MOB-28 | Screen capture of ID documents is blocked in the app switcher | Check for `FLAG_SECURE`/iOS equivalent   | Likely absent — record as a privacy finding for R08  | STATIC      |

### 6.4 Offline queue

| ID     | Item                                                              | How to verify                       | Expected                                     | Type        |
| ------ | ----------------------------------------------------------------- | ----------------------------------- | -------------------------------------------- | ----------- |
| MOB-29 | The queue survives an app kill                                    | Add 3 items, force-kill, reopen     | All 3 present                                | **RUNTIME** |
| MOB-30 | The queue survives a device reboot                                | Reboot                              | Present                                      | **RUNTIME** |
| MOB-31 | A queued item carries a **stable** idempotency key across retries | Read `uploadQueue.ts`               | Key generated once per item, not per attempt | STATIC      |
| MOB-32 | Retry uses bounded exponential backoff                            | Read                                | No tight loop                                | STATIC      |
| MOB-33 | Upload while offline waits and drains on reconnect                | Airplane mode → capture → reconnect | Uploads once, no duplicate                   | **RUNTIME** |
| MOB-34 | A duplicate is impossible after a failed-then-retried upload      | Force a timeout mid-upload, retry   | One document server-side                     | **RUNTIME** |
| MOB-35 | Queue state is visible to the user                                | `QueueScreen.tsx`                   | Pending/failed counts shown                  | STATIC      |
| MOB-36 | A permanently failed item is not silently dropped                 | Fail 6 times                        | Surfaced with an action                      | **RUNTIME** |
| MOB-37 | Storage growth is bounded                                         | Queue 200 items                     | Bounded or documented                        | **RUNTIME** |
| MOB-38 | The queue is encrypted at rest or its exposure is documented      | Read `queueStorage.ts`              | Document (images on disk unencrypted?)       | STATIC      |

### 6.5 Credential storage

| ID     | Item                                                    | How to verify                                   | Expected                              | Type        |
| ------ | ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------- | ----------- |
| MOB-39 | Keychain uses `WHEN_UNLOCKED_THIS_DEVICE_ONLY`          | `secureStore.ts`                                | Confirmed                             | STATIC      |
| MOB-40 | Read-modify-write is race-safe                          | `readAll → mutate → writeAll`                   | Concurrent writes cannot lose a token | STATIC      |
| MOB-41 | Nothing sensitive in AsyncStorage/preferences           | `grep -rn "AsyncStorage\|MMKV" apps/mobile/src` | Zero for credentials                  | STATIC      |
| MOB-42 | Sign-out clears the keychain and the queue's auth state | Read + test                                     | Confirmed                             | **RUNTIME** |
| MOB-43 | The device credential is not in logs or crash reports   | Grep                                            | Clean                                 | STATIC      |

### 6.6 Review and assist features

| ID     | Item                                                       | How to verify                        | Expected                   | Type        |
| ------ | ---------------------------------------------------------- | ------------------------------------ | -------------------------- | ----------- |
| MOB-44 | Simple field review works on a phone                       | `ReviewScreen.tsx` against real data | Approve/correct succeeds   | **RUNTIME** |
| MOB-45 | Voice consent is explicit and revocable                    | `assist/consent.ts`                  | Gate present               | STATIC      |
| MOB-46 | Speech absence is handled, not blocking                    | Run without speech modules           | Button-only; no error loop | **RUNTIME** |
| MOB-47 | Guidance logic is pure and tested                          | `assist/guidance.ts` + tests         | Confirmed                  | STATIC      |
| MOB-48 | Per-run confirmation exists for destructive voice commands | `assist/commands.ts`                 | Present                    | STATIC      |

### 6.7 UX-integrity and platform behaviour

| ID     | Item                                        | How to verify                | Expected                        | Type        |
| ------ | ------------------------------------------- | ---------------------------- | ------------------------------- | ----------- |
| MOB-49 | Backgrounding during capture/upload is safe | Background mid-upload        | Resumes correctly               | **RUNTIME** |
| MOB-50 | Rotation does not lose state                | Rotate during review         | State preserved                 | **RUNTIME** |
| MOB-51 | Low storage is handled                      | Fill the device              | Clear error, no corruption      | **RUNTIME** |
| MOB-52 | Dark mode / theme is consistent             | `ui/theme.ts`                | Consistent                      | STATIC      |
| MOB-53 | The app works in `sw` and `fr`              | Switch locale                | No overflow, no missing strings | **RUNTIME** |
| MOB-54 | No `WebView` loading remote content         | `grep -rn "WebView"`         | Zero                            | STATIC      |
| MOB-55 | Network errors produce actionable messages  | Airplane mode at each screen | Clear messages                  | **RUNTIME** |

---

## 7. Known mobile risks to confirm or refute

| Risk     | Statement                                                                           |
| -------- | ----------------------------------------------------------------------------------- |
| **R-08** | `MOB-001` has a `verification` block: no native build has ever been produced        |
| R-06     | No Detox/Maestro e2e; the mobile suite is JS-only                                   |
| R-22     | 19 `aria-*` attributes exist across desktop only; mobile a11y is unassessed         |
| —        | The native projects (`android/`, `ios/`) appear absent from the repository — verify |

---

## 8. Questions you must answer

1. **Can the app be built and run on a physical Android and iOS device today?** Demonstrate.
2. Is the offline queue truly durable and truly duplicate-free? Prove both.
3. What does the camera path do when the worklet runtime is missing — and does the UI tell the truth?
4. Can a malicious QR code redirect the app anywhere?
5. Where does the device credential live, and what happens if the OS keychain is unavailable?
6. What happens to a half-uploaded document if the phone dies mid-upload?

---

## 9. Commands to run

```bash
cd /home/user/intelligent-data-capture-platform
npm ci --no-audit --no-fund

# ---------- structure ----------
ls -la apps/mobile
cat apps/mobile/package.json apps/mobile/app.json apps/mobile/index.js
grep -n "vision-camera\|worklets\|keychain\|voice\|tts\|react-native-fs" apps/mobile/package.json

# ---------- JS-level checks ----------
npx jest --config jest.config.cjs --selectProjects mobile --runInBand --coverage
grep -rn "assertSecureEndpoint" -A8 apps/mobile/src/api/client.ts
grep -rn "AsyncStorage\|MMKV\|localStorage" apps/mobile/src
grep -rn "WebView\|FLAG_SECURE" apps/mobile/src

# ---------- native build (requires toolchains) ----------
cd apps/mobile
npx react-native doctor
npx react-native run-android --variant=debug        # Android SDK + JDK 17
cd ios && pod install && cd ..
npx react-native run-ios --simulator="iPhone 15"    # macOS + Xcode 16

# ---------- offline queue proof ----------
adb shell svc wifi disable && adb shell svc data disable    # or device airplane mode
# capture 3 documents → adb shell am force-stop <pkg> → reconnect → verify exactly 3 uploads
sqlite3 ./local-storage/idcp.db "SELECT id,status FROM documents ORDER BY created_at DESC LIMIT 5;"

# ---------- duplicate proof ----------
# throttle the network to force a timeout mid-upload, then retry and count documents server-side
```

---

## 10. Tests to perform

| #    | Test                    | Procedure                                               | Pass criterion                    |
| ---- | ----------------------- | ------------------------------------------------------- | --------------------------------- |
| T-01 | Android build + install | Debug and release                                       | Installs and launches             |
| T-02 | iOS build + install     | Simulator and device                                    | Installs and launches             |
| T-03 | Pairing happy path      | Scan desktop QR                                         | Paired                            |
| T-04 | Pairing adversarial     | Expired, replayed, malicious URL, `127.0.0.1.evil.test` | All rejected                      |
| T-05 | Capture fidelity        | 10 real documents                                       | Usable crops, correct orientation |
| T-06 | Offline durability      | Kill + reboot with queued items                         | No loss                           |
| T-07 | Duplicate prevention    | Force mid-upload failure, retry                         | One document                      |
| T-08 | Memory/thermal          | 20 consecutive captures                                 | No OOM, no throttle crash         |
| T-09 | Revocation              | Revoke server-side                                      | Signed out with explanation       |
| T-10 | Keychain absence        | Device without secure storage                           | Graceful, documented              |
| T-11 | Locale switch           | `en` → `sw` → `fr`                                      | No missing strings or overflow    |
| T-12 | Malicious content       | Capture a QR pointing at a URL                          | Rejected as pairing payload       |

---

## 11. Evidence required

```
docs/reviewers/evidence/R11/
├── build-matrix.md              # platform × variant × result, with toolchain versions
├── device-test-matrix.md        # device model, OS version, result per journey
├── offline-durability.md        # T-06 raw evidence
├── duplicate-prevention.md      # T-07 raw evidence (server-side document count)
├── pairing-adversarial.md       # T-04
├── native-gap-analysis.md       # which capabilities cannot be verified and why
├── commands.log
└── findings.md                  # MOB-### register
```

---

## 12. Passing conditions (co-signs G2)

- [ ] **P1** Android and iOS builds exist and launch on real devices — this closes the `MOB-001` verification block (MOB-06 … MOB-08, T-01, T-02).
- [ ] **P2** Pairing works against the real QR and rejects every adversarial payload (MOB-10 … MOB-18, T-03, T-04).
- [ ] **P3** HTTPS enforcement cannot be bypassed by URL construction (MOB-17, MOB-18, T-04).
- [ ] **P4** The offline queue is durable across kill and reboot, and upload is duplicate-free (MOB-29 … MOB-34, T-06, T-07).
- [ ] **P5** Credentials live only in the keychain, with race-safe writes (MOB-14, MOB-39 … MOB-43).
- [ ] **P6** Capture produces usable, correctly oriented, size-bounded images (MOB-21 … MOB-26, T-05, T-08).
- [ ] **P7** Missing native modules degrade honestly — no feature claims to work when it cannot (MOB-25, MOB-46).
- [ ] **P8** Revocation signs the device out with an explanation (MOB-16, T-09).
- [ ] **P9** The absence of `android/`/`ios/` scaffolding is either fixed or documented as a release prerequisite (MOB-01, MOB-02).

---

## 13. Blocked items

| Item ID         | Blocker                                    | What unblocks it                                     | Owner          |
| --------------- | ------------------------------------------ | ---------------------------------------------------- | -------------- |
| MOB-06 … MOB-08 | No Android SDK / Xcode in the sandbox      | CI macOS runner + Android runner, or a build machine | R19            |
| MOB-25          | `react-native-worklets-core` not installed | Add the dependency or accept the inert overlay       | Owner decision |
| MOB-46          | Speech modules not installed               | Add or accept button-only                            | Owner decision |

---

## 14. Findings register

| ID      | Severity | File:line | Finding | Why it matters | Reproduce | Suggested fix | Owner |
| ------- | -------- | --------- | ------- | -------------- | --------- | ------------- | ----- |
| MOB-001 |          |           |         |                |           |               |       |

---

## 15. Reviewer sign-off

| Field                   | Value                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer name           |                                                                                                                                                                   |
| Date started            |                                                                                                                                                                   |
| Date completed          |                                                                                                                                                                   |
| **G2 co-sign result**   | ☐ Pass ☐ Fail ☐ Abstain                                                                                                                                           |
| Co-sign G2 / G7         | ☐ ☐                                                                                                                                                               |
| Devices tested          |                                                                                                                                                                   |
| Conditions failed (IDs) |                                                                                                                                                                   |
| Reviewed commit         | `43d384b`                                                                                                                                                         |
| Statement               | _I read all 26 mobile source files, built and ran the app on Android and iOS, and proved offline durability and duplicate-free upload with server-side evidence._ |
| Signature               |                                                                                                                                                                   |
