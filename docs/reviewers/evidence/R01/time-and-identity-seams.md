# R01 time and identity seams — targeted inventory

Source baseline `9ec567c988888024a32d6e820b0c9f0ec262076b`. ARC-AC-15 asks whether clocks,
IDs and randomness are injectable or centralized and to list exceptions. A literal source search
for `Date.now(`, `new Date(`, `randomUUID(`, `Math.random(` and `randomBytes(` in backend services
and `packages/shared/src/ids.ts` was inspected; it is not a whole-program data-flow proof and misses
aliases, wrappers, repositories, auth modules, platform code and other APIs.

- `packages/shared/src/ids.ts:10-22,45-46` centralizes `newId`, `newSortableId` and `newToken` on
  `node:crypto`. `newSortableId` accepts a timestamp, but randomness is still read from `randomBytes`;
  `newId` and `newToken` do not accept a generator. A secure random source remains required in
  production; this observation does not recommend replacing it with predictable randomness.
- `services/maintenance-service.ts:74` accepts an explicit `Date` for `runOnce`, and
  `services/organisation-service.ts:286,326` has explicit time parameters for date calculations.
  Mobile `state/uploadQueue.ts:43-51,75-77` has an optional clock. These are seams, not proof all
  time-dependent behavior is deterministic.
- Direct service clocks include pairing-token expiry (`pairing-service.ts:71-72`), auth refresh,
  reset and invite expiry (`auth-service.ts:168-169,600-601,830-831`), API-key creation and
  verification (`api-key-service.ts:110,188`), export expiry (`export-service.ts:131,179,199`),
  and connector duration (`connector-service.ts:331,489,518`). These are not universally routed
  through a shared injected clock. Clock skew and expiry policy remain relevant to R05/R18/R19.
- Direct cryptographic randomness/UUID use includes `document-service.ts:146`,
  `privacy-service.ts:176`, `crypto.ts:43`, and `auth-service.ts:550`. These bypass the shared
  helper or call crypto directly. Their presence does not imply weak randomness or an incident.

The literal universal condition is not met; narrower explicit seams and test fake timers can still
exercise selected cases. R02/R16 should assess where additional deterministic seams are worthwhile;
R05/R07 must preserve cryptographic strength, and R18/R19 should review clock synchronization and
operational expiry behavior. Further runtime, database and client inventory remains outside this
bounded search.
