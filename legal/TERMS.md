# Terms of Service

**Effective date:** [EFFECTIVE DATE]
**Provider:** [COMPANY NAME], [ADDRESS] (registration no. [REGISTRATION NO.]) — "we", "us".
**Contact:** [SUPPORT EMAIL]

These terms govern use of the AI Universal Data Capture Platform ("the Service"). By creating an
organisation, signing in or using the Service you accept them on behalf of the organisation you
represent, and you confirm you may do so.

**How acceptance is recorded.** Creating an account requires ticking the acceptance box; the Service
stores the date, the account and the version of these terms that was accepted, and records it in the
organisation's audit trail. When these terms are revised, the version changes and every account is
asked to accept the current version before continuing. That record is our evidence of the contract;
the version accepted is shown to the account holder in **Account → Terms and privacy**.

---

## 1. The Service

The Service captures documents with a phone or desktop, extracts their contents with OCR and
AI-assisted extraction, gives people a review screen to confirm uncertain values, and sends the
finished records to destinations you configure (spreadsheets, SQL databases, CSV/XLSX files, CRM,
ERP or accounting systems).

Extraction is **assisted**, not guaranteed. You are responsible for reviewing anything the Service
marks as uncertain before relying on it, and for the accuracy of records you export or send onward.

## 2. Accounts and access

- You must give accurate account details and keep credentials confidential.
- Roles are enforced server-side: `owner` > `admin` > `reviewer` > `operator` > `viewer`.
- An owner is accountable for who is invited and what roles they hold.
- Tell us immediately at [SUPPORT EMAIL] if you believe a credential has been compromised. You can
  revoke sessions and devices yourself in Settings.
- We may suspend an account that is being used to attack the Service or another customer, or where
  the law requires it, and will say why unless prohibited.

## 3. Acceptable use

Do not use the Service to:

- upload content you have no right to process, or personal data you are not lawfully permitted to
  process;
- break data-protection, tax, anti-money-laundering or sector rules that apply to you;
- attempt to access another organisation's data, probe the API for vulnerabilities without our
  written permission, or circumvent rate limits;
- upload malware, or content that is unlawful, defamatory or infringing;
- resell the Service as a general-purpose capture API without a separate agreement.

We may remove content that breaches these rules and will tell you if we do.

## 4. Customer data and ownership

- **You own your documents and the data extracted from them.** We claim no licence to them beyond
  what is needed to run the Service — store, process, extract, export and back them up.
- You are the controller; we process on your instructions under `DPA.md`.
- We may produce aggregated, de-identified statistics (for example, counts of documents processed)
  to operate and improve the Service. These never identify a person or an organisation.
- Model training on your corrections happens only if you switch it on, and can be switched off at
  any time.

## 5. Our intellectual property

The software, its documentation and the extraction models are ours or our licensors'. These terms
grant you a right to use the Service, not ownership of it. Feedback you send may be used to improve
the Service without obligation.

## 6. Fees

Paid plans, billing cycles and taxes are agreed in an order form or on the pricing page. Where no
order form exists, the Service is provided under the evaluation terms of your organisation's pilot
agreement. Unpaid invoices may lead to suspension after written notice. Fees are exclusive of
taxes, which are added where required.

## 7. Availability and support

- We aim for high availability but do not promise a specific uptime percentage unless an order form
  says so.
- Planned maintenance is announced where practical; emergency maintenance may be unannounced.
- Support is by email at [SUPPORT EMAIL] during business hours, in English.
- Backups, disaster recovery and the deployment model are described in `DEPLOYMENT.md`; where a
  deployment runs on a single server, you accept that a host failure is recovered from backup rather
  than by automatic failover.

## 8. Security

We apply the controls in `SECURITY.md` and the `DPA.md`. You are responsible for your own devices,
your network, the roles you assign, the destinations you configure and the credentials you store in
connectors.

## 9. Liability

To the extent the law allows:

- we are not liable for indirect or consequential loss, loss of profit, loss of goodwill, or loss
  arising from data you failed to review or from a destination you configured;
- our total liability in any 12-month period is limited to the fees you paid in that period, or, for
  a free evaluation, to a nominal amount;
- nothing limits liability for fraud, wilful misconduct, death or personal injury, or anything else
  that cannot lawfully be limited.

You indemnify us against third-party claims arising from content you upload in breach of §3.

## 10. Term and termination

- These terms run while your organisation has an active account.
- You may stop at any time; an owner can export data and erase the account from Settings, and we
  delete customer data within 30 days of a written termination request, except records the law
  requires us to keep.
- We may terminate for material breach uncured 30 days after notice, or immediately for serious
  abuse.
- Clauses that by their nature survive (ownership, liability, governing law) survive termination.

## 11. Changes

We may update these terms. Material changes are notified to organisation owners at least 30 days
before they take effect; continuing to use the Service after that means you accept them.

## 12. Governing law and disputes

These terms are governed by the laws of [GOVERNING LAW] (suggested: Uganda). The parties will try to
resolve a dispute in good faith within 30 days; failing that, the courts of [GOVERNING LAW] have
exclusive jurisdiction.

---

_Template prepared from the product's actual behaviour. Have a Ugandan advocate review before
publishing commercially — see `legal/README.md`._
