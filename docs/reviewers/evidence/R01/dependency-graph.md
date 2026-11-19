# R01 dependency graph — interim evidence

**Status: incomplete; not a G1 approval or reviewer sign-off.** This records an inspection of the
working tree based on `de7bc574860cd31f97991729aa2ba88d228fd858`, including the uncommitted
composition and connector-test changes. Further boundary checks and the rest of the R01 evidence
are still required.

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

## Import-cycle scan

Node v22.22.3 and npm 10.9.8:

```text
$ npx --yes madge@8 --circular --extensions ts,tsx --ts-config tsconfig.base.json --warning apps packages
Processed 217 files (3.2s)
✔ No circular dependency found!
```

No skipped-file warnings were emitted. A JSON graph inspection confirmed that the edge from
`apps/backend/src/repositories/system-repo.ts` to `packages/shared/src/ids.ts` resolves; this was
skipped in the earlier scan without `--ts-config`. Madge's static graph is not proof about all
runtime or dynamic dependencies, external package internals, or deployment-time resolution. This
result is not a substitute for the remaining R01 cross-workspace boundary review.
