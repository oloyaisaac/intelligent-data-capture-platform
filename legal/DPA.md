# Data Processing Agreement

**Effective date:** [EFFECTIVE DATE]
**Processor:** [COMPANY NAME], [ADDRESS] (registration no. [REGISTRATION NO.])
**Controller:** the customer organisation named in the order form or, where none is signed, the
organisation that created the account.

This agreement is the Annex to the Terms of Service and applies whenever we process personal data on
the customer's behalf. In case of conflict, this agreement prevails for the processing it covers.

---

## 1. Roles and instructions

1. The customer is the **controller**; we are the **processor**.
2. We process personal data only on documented instructions from the customer — the settings, roles,
   connectors, retention periods and requests made through the product — and for the purposes in
   §2. We tell the customer if an instruction appears to breach data-protection law.
3. We do not sell personal data, use it for advertising, or disclose it except as set out here.

## 2. Subject matter

| Item                        | Description                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Duration                    | While the account is active, plus the deletion period in §9                                                                                    |
| Nature and purpose          | Capture, OCR/extraction, human review, storage, export and connector delivery                                                                  |
| Categories of data subjects | The customer's staff and any person whose data appears in a captured document                                                                  |
| Categories of personal data | Names, contact details, identifiers, financial and transaction data, images of documents — whatever the customer chooses to capture            |
| Special-category data       | Not required by the Service. If the customer captures it, the customer is responsible for the lawful basis and for instructing us accordingly. |

## 3. Our obligations

1. Process only on instructions, and ensure people we authorise are bound by confidentiality.
2. Apply the technical and organisational measures in Annex A.
3. Assist the customer in answering data-subject requests. The product provides self-service export
   and erasure (Settings → Privacy); we assist with anything beyond that.
4. Assist with security assessments, breach notification and prior consultations with a supervisory
   authority, taking into account the nature of the processing.
5. Notify the customer **without undue delay** and in any event within **72 hours** of becoming aware
   of a personal-data breach, with the information in §7.
6. At the customer's choice, delete or return personal data at the end of the service (§9).

## 4. Sub-processors

1. The current sub-processors are listed in `SUBPROCESSORS.md`.
2. We give the customer **30 days' notice** (email to organisation owners) before adding or replacing
   a sub-processor, with the opportunity to object. If the customer objects on reasonable
   data-protection grounds and no alternative is workable, the customer may terminate the affected
   service without penalty.
3. We impose the same data-protection obligations on every sub-processor by written contract and
   remain liable for their performance.

## 5. International transfers

Where personal data is transferred outside Uganda, we rely on appropriate safeguards — standard
contractual clauses or an adequacy decision — and name the mechanism in `SUBPROCESSORS.md`. The
customer chooses the hosting region where the deployment offers one.

## 6. Security

Annex A lists the measures. We may update them provided the overall level of protection is not
reduced. The customer is responsible for its own devices, its role assignments, the credentials it
stores for connectors, and its own networks.

## 7. Breach notification

A notification states, as far as known: what happened and when; the categories and approximate
number of data subjects and records affected; the likely consequences; the measures taken or
proposed; and a contact point. Where not all information is available at once, we send it in phases
without further delay.

## 8. Audits

Once a year, on 30 days' written notice, a customer may review our security documentation and ask
written questions; where that is not enough, the parties agree a scope for an on-site or remote
audit at the customer's cost, subject to confidentiality and to not compromising other customers.
Certifications and penetration-test summaries, where they exist, satisfy this clause.

## 9. Deletion and return

On termination, and within 30 days of a written request, we delete or return all customer personal
data and delete existing copies, except where law requires retention (for example, audit records
kept for accountability, or records in backups that age out on the documented schedule). The customer
can export everything it needs before erasure from Settings → Privacy.

## 10. Liability

Liability under this agreement is subject to the limitation in the Terms of Service.

---

## Annex A — Technical and organisational measures

| Area                 | Measure                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access control       | Unique accounts, Argon2id password hashing, role-based authorisation re-checked server-side, API keys scoped and revocable, session and device revocation |
| Tenant isolation     | Every query scoped to the organisation in the data layer; 404 rather than 403 for other tenants' identifiers                                              |
| Encryption           | TLS in transit; connector credentials encrypted at rest with AES-256-GCM; tokens and credentials stored only as hashes                                    |
| Audit                | Append-only audit trail (database triggers prevent update/delete) covering privileged actions                                                             |
| Retention            | Configurable per organisation; daily purge of documents, exports and dead sessions                                                                        |
| Input handling       | Schema validation at every boundary, content sniffing on uploads, size and type limits, rate limiting                                                     |
| Isolation of failure | A failing connector reports an error and cannot take down the API                                                                                         |
| Logging              | Structured logs with tokens, document text and field values redacted                                                                                      |
| Backups              | Documented in `DEPLOYMENT.md`; restore tested before commercial go-live                                                                                   |
| Personnel            | Access limited to named administrators who need it; confidentiality obligations                                                                           |

---

_Template prepared from the product's actual behaviour. Have a Ugandan advocate review before
signing with customers — see `legal/README.md`._
