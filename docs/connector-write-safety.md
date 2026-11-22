# Connector duplicate and CSV write boundaries

Required mapping values are checked after transformation and again after all fields are assigned.
An unparseable required number, date or boolean, or an empty result of `trim`, now blocks sends and
duplicate previews before contacting the destination. Defaults apply to missing input before the
transform, not as a fallback for an invalid transformed value. Numeric zero and boolean false remain
valid. Source lookup ignores inherited properties, and a required destination must actually be an
own property.

New mapping profiles reject exact duplicate destination field names and names that are own properties
of JavaScript's `Object.prototype` (including `__proto__`, `constructor`, and `toString`). The mapper
also rejects them, and sends and previews fail closed when they encounter such a stored profile.
This intentionally restricts even legitimate external fields with those names until all downstream
record, filter and merge paths can safely support them. The mapping API currently has no update
endpoint; create and select a corrected profile after authorized review. Invalid saved profiles are not
changed automatically. These checks happen before a connector run is created. They do not establish
destination-schema validity or detect case, collation, Unicode or other vendor-specific equivalences.
Direct connector calls bypass backend mapping checks, and historical writes are not repaired. See R01
ARC-037/ARC-038.

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

CSV reads and writes reject observed nonregular or multiply linked destination files and propagate
read errors instead of treating them as empty. A missing path remains an empty destination; creating
it now uses exclusive creation so a file appearing after that observation is not overwritten. An
existing zero-byte or BOM-only file is no longer treated as a new destination for writes. Existing
files must be valid UTF-8 with well-formed quoting, distinct non-empty headers and consistent row
widths. Reads also fail on malformed or ambiguous data. Only comma, semicolon, tab and pipe
delimiters and boolean BOM options are accepted. These are compatibility changes: investigate and
repair affected files with an authorized backup and review process, not automatic truncation.

For an existing valid file, the connector preserves its bytes and appends the new rows, adding a line
separator if needed; it no longer parses and reserializes old rows. It checks the observed file
identity and metadata again before append and refuses some stale snapshots. New row values still use
the shared spreadsheet-formula escaping. Formula-like headers are now rejected rather than renamed,
for both reads and writes; existing mappings and files may require review. Pre-existing formulas and
headers are **not sanitized** by this append and may remain dangerous when opened in spreadsheet
software. See `csv-formula-safety.md` for compatibility and limitations. An empty batch is a no-op,
and every incoming record must fit the existing header.

These checks are not a transactional or security boundary. Filesystem parent paths, mounts and
symlink changes can race checks; hard links can be created later; metadata can fail to expose a
change; a file may be replaced after the final check; and external or concurrent writers are not
locked. Appends can be partial, interleaved or committed despite a failed acknowledgement, so retry
can duplicate or corrupt rows. Format-valid does not mean ownership is correct or data is safe. The
whole file is still read and parsed in memory. Coordinate writers, inspect uncertain outcomes and
maintain verified backups. A sandbox, durable coordinated CSV protocol, historical assessment and
reconciliation remain outstanding.
