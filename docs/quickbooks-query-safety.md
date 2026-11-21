# QuickBooks connector query boundaries

The QuickBooks query API uses SQL-like text rather than bind parameters. The connector validates the
entity on every operation and accepts filter fields only as simple or dot-separated ASCII identifiers.
Filter values are quoted using the vendor's documented apostrophe escape. Values containing a
backslash or ASCII control character are rejected rather than relying on unverified multi-escape
semantics. Numeric filters must be finite; booleans are sent as boolean literals. Searches and reads
send a positive limit capped at 100 (100 by default); schema sampling requests one record. A caller
that needs unsupported field names or values must resolve that incompatibility rather than bypassing
validation. A successful request to a noncompliant or compromised destination is not guaranteed to
respect the requested limit.

Earlier versions interpolated filter keys as query syntax, validated the entity only when explicitly
calling `validateConfig`, and did not reject backslash-containing values before escaping apostrophes.
Untrusted mapping keys or records could therefore affect the query sent to QuickBooks. Assess
historical mappings, queries and destination effects with the authorized data and security owners;
no production activity was inspected or repaired. This mitigation does not prove the full vendor
query grammar, escape behavior for every Unicode character or connector isolation. Tests use a fake
HTTP response, not a real QuickBooks account. Before rollout, verify representative queries and
filters with an authorized test account and evaluate compatibility, limits and duplicate handling.
Search is capped and not paginated, so a missing match is not proof no duplicate exists. Connector
writes remain subject to remote partial effects and ambiguous failures.

Vendor description of backslash-apostrophe escaping: https://blogs.a.intuit.com/2017/02/08/deep-dive-sql-queries/.
