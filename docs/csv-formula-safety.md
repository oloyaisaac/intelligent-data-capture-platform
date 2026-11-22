# Spreadsheet formula safety: CSV and exports

The shared CSV writer prefixes an apostrophe to text cells **and headers** beginning with a tab,
carriage return, newline, or optional whitespace followed by `=`, `+`, `-` or `@`. This applies to
new CSV exports, audit CSV and batch-results CSV; dashboard CSV uses the same text check. Real
numeric cells are not treated as text. CSV quoting remains separate from formula handling. Tests
cover API-selected export columns, uploaded batch filenames, whitespace, quoting and newlines.

Escaping changes the serialized text. If two _distinct_ headers would become the same protected
name, the shared writer rejects the CSV instead of silently conflating columns. The export API
currently reports a generic failure in that case. The CSV destination connector instead rejects
formula-like headers, for both reads and writes, so it does not silently change destination column
identities or append to an already unsafe header. Existing connector mappings or destinations with
such headers require authorized review and migration. An apostrophe already present in a header
remains part of that header; mappings must match the actual destination header exactly.

This mitigation is **not a guarantee** that CSV will be safe in all spreadsheet products, import
settings, locales, character encodings or after save/reopen. Spreadsheet applications may remove or
interpret an apostrophe differently. Test the actual supported tools and workflows, treat untrusted
files as data, and avoid opening them with unnecessary privileges or external data connections.
The explicit `escapeFormulas: false` library option disables the protection and is not suitable for
production spreadsheet exports. Other export or connector implementations need independent review.
ExcelJS writes tested formula-looking XLSX column names as string cells; this is not a complete
review of all XLSX content or consumer behavior.

No existing CSV files, destination data, logs, copies or backups are changed by these fixes. In
particular, the CSV connector intentionally preserves existing data rows, including historical
formula-like values; it does not sanitize previously written files. Assess affected historical batch
filenames, export columns and destinations and choose any remediation with an authorized owner.
This is partial evidence for R01, not independent security or architect sign-off.
