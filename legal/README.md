# Legal documents

Published from `/api/v1/legal/*` (public, no sign-in) and linked from the desktop app.

| Document                  | File               | Audience                                                  |
| ------------------------- | ------------------ | --------------------------------------------------------- |
| Privacy Policy            | `PRIVACY.md`       | everyone whose data is processed                          |
| Terms of Service          | `TERMS.md`         | the organisation that contracts for the service           |
| Data Processing Agreement | `DPA.md`           | customers who are controllers (signed annex to the terms) |
| Sub-processors            | `SUBPROCESSORS.md` | customers reviewing where data goes                       |
| Security overview         | `SECURITY.md`      | customer security reviews (public summary)                |

**Status: draft for counsel review.** These documents are written from what the software
actually does — the tables, retention defaults and sub-processors match the code and
`DEPLOYMENT.md`. They are not legal advice, and a Ugandan advocate should review them before
they are relied on commercially.

**Placeholders to replace before publishing** (grep for `[`):

| Placeholder          | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `[COMPANY NAME]`     | registered name of the operating company             |
| `[REGISTRATION NO.]` | company registration number                          |
| `[ADDRESS]`          | registered physical address                          |
| `[SUPPORT EMAIL]`    | support contact (suggest `support@`)                 |
| `[PRIVACY EMAIL]`    | privacy/data-protection contact (suggest `privacy@`) |
| `[DPO NAME]`         | data protection contact person                       |
| `[GOVERNING LAW]`    | governing law (suggested: Uganda)                    |
| `[EFFECTIVE DATE]`   | date the documents go live                           |

**Versions.** `LEGAL_VERSION` in `packages/shared/src/constants.ts` is the version stamped against
every acceptance record (DEC-032). Bump it in the same commit as any material change to `TERMS.md`,
`PRIVACY.md` or `DPA.md`: accounts then show as "not current" in the app and are asked to accept the
new pack. A cosmetic edit (a typo, a link) does not need a bump; a change to what is collected, why,
for how long, or who receives it does.

`npm run test:legal` fails if a document is missing, if a placeholder is missing from a document that
should carry it, if `PRIVACY.md` and `apps/backend/src/config.ts` disagree about how long an export is
kept, or if `DPA.md` names a provider the sub-processor list does not — so the pack cannot silently
drift from the deployment. It runs in CI.
