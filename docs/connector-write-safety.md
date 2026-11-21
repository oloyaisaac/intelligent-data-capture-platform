# Connector duplicate and CSV write boundaries

A send using `skip`, `update` or `merge` now requires unique, non-empty duplicate keys, a lookup
method, and a mapped, non-empty value for every key. Missing prerequisites return a conflict rather
than silently creating a record. Duplicate preview also fails for incomplete non-append checks. An
`append` mapping still deliberately writes without a duplicate check. The mapping API currently
allows saving an incomplete policy; it may now fail at send time. Review existing mappings and the
API's default `skip` policy with empty keys before deployment. Failed sends are recorded as failed
connector runs, but run/audit persistence itself is not atomic with remote effects.

For a detected update or merge, multiple returned matches or differences between the original and
matched key values now fail closed. HubSpot and Odoo updates additionally require `id`, and
QuickBooks updates require `Id`, as the first key: these vendor APIs address an update by record ID,
not an arbitrary business key. Odoo IDs must be positive safe integers. This restricts existing
business-key update/merge mappings until a separately verified target-ID protocol exists. HubSpot
now preserves the top-level response ID when a property is also named `id`. Direct SDK connector
calls do not go through these backend policy checks.

**These checks do not guarantee no duplicates or correct target selection.** Candidate searches can
be bounded, unpaginated, fuzzy or limited by provider indexing and filters; concurrent writers may
change the destination after lookup. SQL updates can affect multiple rows if the destination key is
not unique or its collation equates different values. Provider behavior, identity semantics, old
binaries, direct SDK calls and out-of-band writers are not fenced. Use destination-enforced unique
constraints or provider idempotency where available, verify mappings and permissions, and inspect
the destination after uncertain failures before retrying. No historical destination data was
inspected or repaired, and no real CRM provider was tested.

CSV reads now reject observed nonregular files and propagate read errors instead of treating them as
empty. A missing path remains an empty destination, and observed symlinks are rejected. CSV writes
reject records containing columns missing from the destination header, including later records in a
batch; an empty batch is a no-op. These checks are not atomic with filesystem operations: symlink,
parent-path and replacement races, missing/wrong mounts, hardlinks and external writers remain.
The connector still rewrites the whole destination in place; concurrent writes, process death or
I/O failure can lose or corrupt data, and its permissive parser and reserialization can alter
existing content. Do not rely on it for concurrent or crash-safe writes; coordinate writers and
maintain verified backups. A sandbox, durable transactional CSV protocol, historical assessment and
reconciliation remain outstanding.
