# Dependency security

Run `npm audit --omit=dev` for the workspace production dependency tree and `npm audit` for the
full tree, including developer and release tools. CI gates the former at moderate severity or
higher. Audit results depend on the registry's current advisory data and are not proof of security;
review the full audit regularly as well, especially before producing installers.

As of 2026-11-17, the production audit reports zero findings. The full audit reports six moderate
entries in the Electron packaging chain, all stemming from `minimatch` GHSA-g3hv-75wg-m249. The
registry suggests a major downgrade of `electron-builder`, not a validated compatible fix; this
has not been applied. Avoid untrusted packaging glob patterns, run builds in controlled environments,
and reassess upstream fixes. This does not validate signed installers or packaged desktop runtime.

The lockfile uses Metro 0.84.6 (within React Native's plugin's declared range), whose asset parser no
longer depends on vulnerable `image-size` 1.x. Its three plugin-facing Metro packages are pinned
together through overrides to avoid resolving incompatible versions during lockfile maintenance.
The ExcelJS-only override uses CommonJS-compatible `uuid` 11.1.1: ExcelJS 4.4 uses `uuid.v4()` for
extended conditional formatting, while the advisory affects other UUID generation methods. Normal
XLSX exports and that formatting path have regression tests. The override crosses ExcelJS's declared
major version range, so recheck compatibility and remove it when an upstream fix is available.
The backend's direct esbuild dependency was updated to 0.25.12 or later within 0.25 to address its
development-server advisory. Keep overrides under review on dependency updates and rerun the tests,
production and full audits, mobile bundling/native builds, and desktop packaging as applicable.
