# R01 dependency graph — interim evidence

**Status: interim; not a G1 approval or reviewer sign-off.** The declared-workspace and static
import scan was refreshed against base commit `9ec567c988888024a32d6e820b0c9f0ec262076b`;
the earlier observations below remain historical. Further boundary checks and the rest of the R01
evidence are still required.

## Declared workspace edges

From `dependencies`, `devDependencies` and `peerDependencies` in the five workspace manifests:

| Workspace          | Declared internal dependencies     |
| ------------------ | ---------------------------------- |
| `@idcp/backend`    | `@idcp/connectors`, `@idcp/shared` |
| `@idcp/desktop`    | `@idcp/shared`                     |
| `@idcp/mobile`     | `@idcp/shared`                     |
| `@idcp/connectors` | `@idcp/shared`                     |
| `@idcp/shared`     | none                               |

These declared internal edges are acyclic. They do not by themselves prove that imports follow
the manifest boundaries; undeclared paths and other dependency categories still need examination.

`workspace-alias-scan.cjs` checks all seven workspace TypeScript configurations: desktop (including
its Electron and test configs), mobile, and shared inherit the `@idcp/connectors` source alias
without declaring the connector package. Across 195 tracked source files, the same script resolved
114 cross-workspace literal occurrences and found none targeting an undeclared workspace. This
means the mapping permits an undeclared edge but this bounded scan did not find one in current
source. The alternative desktop configs are checked for aliases, not separately used to resolve
all source imports; dynamic imports and runtime/native bundling remain out of scope. See ARC-047 and
`workspace-alias-scan-9ec567c.txt`.

## Source import boundary scan

`node docs/reviewers/evidence/R01/import-scan.cjs` analyzed 195 tracked workspace source files at
`9ec567c`, using the TypeScript parser and base tsconfig resolution. Among resolved literal imports
it found no package-to-app or cross-app edges, and no Node/electron imports in desktop
`pages/components/lib`. It could not resolve the desktop CSS import as a TypeScript module; the
CSS file exists. Two nonliteral `require(name)` calls occur in the mobile speech and camera shims;
their visible callers name optional native dependencies, but the scan cannot resolve arbitrary
runtime values or validate Metro/native packaging. See `import-scan-9ec567c.txt` and hand the native
boundary to R11/R16. Test/config files, project-specific resolution, external internals and runtime
imports remain outside this evidence.

## Import-cycle scan

At `9ec567c`, `npx --yes madge@8 --circular --extensions ts,tsx --ts-config tsconfig.base.json
--warning apps packages` processed 355 files and reported no circular dependency, with no skipped-file
warning emitted. See `baseline-9ec567c.txt`. This includes the tool's discovered test files and is a
static import analysis, not proof of runtime/dynamic dependencies or deployment behavior.

Earlier scan on Node v22.22.3 and npm 10.9.8:

```text
$ npx --yes madge@8 --circular --extensions ts,tsx --ts-config tsconfig.base.json --warning apps packages
Processed 221 files (2.9s)
✔ No circular dependency found!
```

This scan was repeated at `7dc278c` after a clean `npm ci`; see the partial `commands.log`.
No skipped-file warnings were emitted. An earlier JSON graph inspection confirmed that the edge from
`apps/backend/src/repositories/system-repo.ts` to `packages/shared/src/ids.ts` resolves; this was
skipped in the earlier scan without `--ts-config`. Madge's static graph is not proof about all
runtime or dynamic dependencies, external package internals, or deployment-time resolution. This
result is not a substitute for the remaining R01 cross-workspace boundary review.

Subsequent worktree scans processed 235 files without `--warning`, then 237 files after adding the
fatal-connector subprocess test using `npx --yes madge@8 --circular --extensions ts,tsx --ts-config
tsconfig.base.json --warning apps packages`. Both reported no cycles; the latter emitted no skipped-file
warnings. See `commands.log` for commands and scope. Static scans do not prove dynamic dependencies
or runtime isolation.
