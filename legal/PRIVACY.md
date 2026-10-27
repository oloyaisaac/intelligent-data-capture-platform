# Privacy Policy

**Effective date:** [EFFECTIVE DATE]
**Controller:** [COMPANY NAME], [ADDRESS] (registration no. [REGISTRATION NO.]) — "we", "us".
**Contact:** [PRIVACY EMAIL] · Data protection contact: [DPO NAME]

This policy explains what the AI Universal Data Capture Platform ("the Service") does with personal
data. It is written to meet the **Uganda Data Protection and Privacy Act, 2019** and the Data
Protection and Privacy Regulations, 2021, and to satisfy the **EU/UK GDPR** where those laws apply to
a customer.

---

## 1. Roles

- **Your organisation is the controller** for the documents it captures and the records it creates.
  We process that data on its instructions, under the Data Processing Agreement in `DPA.md`.
- **We are the controller** for the account data of the people who sign in (name, email, credentials,
  device and session records, audit trail), and for our own business records.

If you are an employee or contractor using the Service through your organisation, the organisation is
the party to contact first: it decides what is captured, how long it is kept and who may see it.

## 2. What we process

| Category            | Examples                                                                                                 | Why                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Account details     | Name, email address, chosen language, role in the organisation                                           | Sign-in, access control, support          |
| Authentication data | Password (stored only as an Argon2id hash), session records, device name and platform, hashed IP address | Security, fraud prevention, audit         |
| Captured documents  | Photographs and PDFs you upload, page images, file type, size, checksum                                  | The core feature: turning paper into data |
| Extracted data      | Field values and tables produced by OCR, confidence scores, source page, corrections                     | Extraction, review, export                |
| Review records      | Who approved or corrected what, before and after values                                                  | Accountability, quality                   |
| Destination data    | The rows written to a spreadsheet or database you configured                                             | Delivering the export you asked for       |
| Audit trail         | Actor, action, target, timestamp, hashed IP                                                              | Security and legal accountability         |
| Optional cloud AI   | Document content sent to a provider **only if your organisation turns it on**                            | Higher-accuracy extraction                |

We do **not** use cookies or advertising trackers in the API, do not sell personal data, and do not
use customer documents to train models unless the organisation explicitly enables that option and
can revoke it at any time.

## 3. Legal bases

| Basis                     | Used for                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Performance of a contract | Providing the Service, storing documents, running exports                                            |
| Legitimate interests      | Security, abuse prevention, audit trail, service reliability — balanced against your rights          |
| Consent                   | Voice commands on the mobile app, cloud AI processing, model-training opt-in, optional product email |
| Legal obligation          | Retention of records we must keep, responding to lawful requests                                     |

Voice commands are **off by default**, need the microphone permission, and audio is never stored or
transmitted: the device converts speech to text and sends nothing unless you submit it.

## 4. Where data is stored and who else sees it

Documents and records live in the database and file store of the deployment your organisation
chose — by default a single server with the database and files on its own disk. Sub-processors are
listed in `SUBPROCESSORS.md`; the list is short by design, and adding one requires notice to
customers.

- **Local OCR is the default.** With the local engine, document images never leave the server.
- **Cloud AI is opt-in per organisation** and off unless configured. When it is on, the page image
  or its text is sent to the named provider under their data-processing terms.

## 5. How long data is kept

| Data                                  | Default                                                 | Notes                                                                                                |
| ------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Captured documents and extracted data | **90 days** after upload                                | Set per organisation (0 = keep until deleted). A daily job purges expired documents and their files. |
| Generated exports                     | **7 days**                                              | The file is deleted at expiry; the record stays in history marked expired.                           |
| Audit trail                           | **24 months** minimum                                   | Append-only; cannot be edited or deleted through the product.                                        |
| Sessions                              | 30 days after expiry (refresh tokens expire in 30 days) | Removed by the daily housekeeping job.                                                               |
| Password-reset links                  | 1 hour, then single-use                                 | Spent tokens are removed after 7 days.                                                               |
| Invitations                           | 7 days                                                  | Only a hash of the token is stored.                                                                  |

Deleting a document removes the file from storage and the rows from the database. Records already
approved and exported to your own systems are outside our control.

## 6. Security

- Encryption in transit (TLS); tokens are stored as hashes, never in clear.
- Connector credentials are encrypted at rest with AES-256-GCM.
- Tenant isolation in the data layer: every query is scoped to the organisation.
- Role-based access control, rate limiting on sign-in and uploads, and an append-only audit trail.
- The full public summary is in `SECURITY.md`.

No system is perfectly secure. If a breach affects your personal data we notify the Personal Data
Protection Office where the law requires it, and the affected customers without undue delay, with
what we know, what we are doing and what they should do.

## 7. Your rights

You can exercise these from the desktop app (**Settings → Privacy**) or by writing to
[PRIVACY EMAIL]:

| Right              | How                                                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Know what we hold  | **Download my data** returns a JSON file: account, organisations, documents, reviews, audit entries.                                                                                                                                                                                                                        |
| Correct it         | Edit your name and organisation details in Settings; correct extracted values in review.                                                                                                                                                                                                                                    |
| Erase it           | **Erase my account** anonymises the account and revokes its sessions and devices. Records your organisation must keep (approved documents, audit trail) stay, without your identity attached. A sole owner erases the organisation's identity with them; an owner who is not the only owner must hand over ownership first. |
| Portability        | The same export file is machine-readable JSON.                                                                                                                                                                                                                                                                              |
| Object or restrict | Write to [PRIVACY EMAIL]; we stop processing while we review, unless the law requires otherwise.                                                                                                                                                                                                                            |
| Withdraw consent   | Turn off cloud AI, model training or voice in Settings.                                                                                                                                                                                                                                                                     |
| Complain           | The Personal Data Protection Office (Uganda): https://www.pdpo.go.ug. If you are in the EU/EEA you may also complain to your local supervisory authority.                                                                                                                                                                   |

We answer within **30 days**. Erasure requests that conflict with a legal retention duty are
explained, not silently refused.

## 8. Children

The Service is a business tool and is not intended for anyone under 18. We do not knowingly create
accounts for children.

## 9. International transfers

If a deployment or a sub-processor processes data outside Uganda, we rely on appropriate safeguards
(standard contractual clauses or an adequacy decision) and record them in `SUBPROCESSORS.md`. The
hosting region is a customer choice; where it has not been fixed, this policy says so rather than
implying a location.

## 10. Changes

We publish changes here with a new effective date. A change that expands what we collect or who we
share it with is notified to organisation administrators before it takes effect.

---

_Template prepared from the product's actual behaviour. Have a Ugandan advocate review before
publishing commercially — see `legal/README.md`._
