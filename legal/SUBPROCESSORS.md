# Sub-processors

**Effective date:** [EFFECTIVE DATE]
**Processor:** [COMPANY NAME]

This list is the authoritative record of third parties that may process customer personal data. It is
kept short on purpose: with the default configuration, documents never leave the customer's own
deployment.

| #   | Sub-processor                                                 | Purpose                                                  | Data                                                           | Location                                          | Required?                               |
| --- | ------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------- |
| 1   | The customer's chosen hosting provider (`[HOSTING PROVIDER]`) | Runs the deployment: compute, disk, backups              | Everything the customer stores                                 | Chosen per deployment; recorded in the order form | Yes                                     |
| 2   | `[CLOUD AI PROVIDER]` (configured by the customer)            | OCR/extraction for organisations that switch on cloud AI | Page images or extracted text, for the duration of the request | Provider's region                                 | **No — off by default**                 |
| 3   | `[EMAIL PROVIDER]` (when transactional email is enabled)      | Invitations, password resets, security notices           | Name, email address, message content                           | Provider's region                                 | No — the current release sends no email |
| 4   | `[ERROR TRACKING]` (when enabled)                             | Crash and error reporting                                | Diagnostic data, with secrets and document content redacted    | Provider's region                                 | No                                      |

Deliberately **not** used: advertising or analytics trackers, data brokers, model-training services
(unless a customer enables the opt-in, in which case the destination is named here before the switch
is turned on).

## Notes

- **Local OCR is the default.** With the local engine, document images are processed inside the
  deployment and are not sent anywhere.
- **No email is sent by the product itself.** Invitation and password-reset links are produced by the
  API and delivered by the operator; if a mail provider is added, row 3 is completed first and
  customers are notified 30 days in advance.
- A **deployment operated by the customer** (self-hosted) makes the customer the operator: rows 1–4
  may then be services the customer already runs, and this list is informational.
- We give **30 days' notice** before adding or replacing a sub-processor (`DPA.md` §4).

## Change log

| Date             | Change                                         |
| ---------------- | ---------------------------------------------- |
| [EFFECTIVE DATE] | Initial list published with the first release. |
