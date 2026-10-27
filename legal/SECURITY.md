# Security overview

**Audience:** customers and their security reviewers. This is the public summary; the internal
rulebook is `/SECURITY.md` in the repository.

**Effective date:** [EFFECTIVE DATE] · **Contact:** [SUPPORT EMAIL]

## What protects your data

| Control           | What it means in practice                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in           | Argon2id password hashing, 15-minute access tokens, rotating refresh tokens, per-IP and per-account rate limits on sign-in and reset |
| Session control   | Every sign-in is a session you can see and revoke; "sign out everywhere" ends all of them; password changes revoke the others        |
| Authorisation     | Five roles, enforced server-side and re-checked on every request; a role change takes effect on the next request                     |
| Tenant isolation  | Every query is scoped to your organisation; another tenant's identifier returns "not found", never a hint that it exists             |
| Encryption        | TLS in transit; connector credentials encrypted with AES-256-GCM; device and API-key credentials stored only as hashes               |
| Audit             | Append-only trail of privileged actions, enforced by database triggers; searchable by actor, action and date                         |
| Retention         | Configurable per organisation, enforced by a daily job that deletes both rows and files                                              |
| Uploads           | Content is sniffed rather than trusted, size-capped, served with `nosniff`, never from a public URL                                  |
| Logging           | Structured JSON with passwords, tokens, document text and field values redacted                                                      |
| Failure isolation | A misbehaving connector reports an error and cannot take the API down                                                                |

## Your data-subject rights, self-service

**Settings → Privacy** in the desktop app: download everything held about you as JSON, or erase your
account (anonymised, credentials revoked, drafts deleted; records your organisation must keep remain
without your identity attached).

## Where your data lives

By default a single deployment: the database (SQLite, or PostgreSQL where configured) and the
documents on the host's disk, in the region you chose. Local OCR is the default, so documents are not
sent to a third party. Cloud AI is opt-in per organisation. Sub-processors are listed in
`SUBPROCESSORS.md`.

## What we do not claim

- We are not certified to ISO 27001 or SOC 2, and this page does not imply an independent audit.
- A single-server deployment is recovered from backup, not by automatic failover.
- No system is perfectly secure. We tell affected customers about a breach without undue delay, and
  the Personal Data Protection Office where the law requires it.

## Reporting a vulnerability

Email [SUPPORT EMAIL] with steps to reproduce. Please do not open a public issue or test against
another customer's data. We acknowledge within two business days and will not pursue good-faith
research that respects these limits.

## Known limits, stated plainly

Rate limiting is per process (it resets on restart), there is no multi-factor sign-in yet, and the
product sends no email of its own — invitation and reset links are delivered by the operator.
