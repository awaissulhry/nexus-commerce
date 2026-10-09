# Data protection policy and incident response plan

Owner: Xavia Racing SRLS. Adopted: 2026-10-09. Next review: 2027-04-09 (every 6 months).

This policy covers all Amazon Information that Xavia Racing receives through the Amazon Selling Partner API
and the Amazon Advertising API, and the systems that process it: the Nexus back office (this repository),
its hosting, its database and the company's developer computer. It follows the Amazon Services API Data
Protection Policy (DPP), the Acceptable Use Policy (AUP) and the EU General Data Protection Regulation (GDPR).

## 1. Roles

| Role | Who |
|---|---|
| Data owner, security officer, Incident Management Point of Contact | the company owner (the primary contact in the Amazon Solution Provider profile) |
| Users of Nexus | the company owner only. Any new user gets the smallest Nexus role that fits the job |

The owner is the only person who can approve code changes, deploy, and change production settings.

## 2. Data classification

| Class | Examples | Rules |
|---|---|---|
| Restricted | Amazon buyer PII: ship-to name, address, phone | Section 4. Encrypted at rest, minimum access, deleted on schedule |
| Confidential | API credentials, tokens, keys; sales, prices, costs | Encrypted at rest, never in code, logs or repositories |
| Internal | Listings, stock, order status without PII | Access through Nexus roles only |
| Public | Published listing content | No restriction |

## 3. Record of processing (GDPR art. 30)

| Data | Source | Purpose | Stored in | Shared with | Kept |
|---|---|---|---|---|---|
| Ship-to name, address, phone of merchant-fulfilled (FBM) Amazon orders | SP-API with a Restricted Data Token (`shippingAddress` only) | Ship the order: label, packing slip, courier booking | Nexus database (Neon, EU), field-level encrypted | Sendcloud and the courier of that parcel, only to deliver it | 30 days after delivery, then deleted |
| City, region, postal code, country of all orders | SP-API (no token needed) | Shipping cost, VAT, reporting | Nexus database | No one | Life of the order record |
| Order, item, price, fee, stock and listing data | SP-API, Advertising API | Run the shop | Nexus database | No one | Life of the business |

Legal basis: performance of the sales contract (GDPR art. 6(1)(b)). Amazon is the only source of Amazon
Information. No PII is requested for orders that Amazon fulfils (FBA).

## 4. Rules for buyer PII

1. Request PII only for merchant-fulfilled orders that we must ship, only the `shippingAddress` element, only
   with a Restricted Data Token.
2. Use it only to ship that order. Never for marketing, profiling, reviews, or contact outside Amazon. The phone
   number is for the courier only.
3. Store PII fields encrypted with an AWS KMS data key (AES-256), on top of the database's own encryption.
4. Delete PII automatically 30 days after the order is delivered. Database backups expire within 7 days, so no
   copy lives longer than 37 days.
5. Keep PII out of logs, error reports, analytics, AI tools, exports and test data.
6. Never copy PII to personal devices, USB drives or personal accounts.

## 5. Security controls

- **Encryption in transit**: every connection uses TLS 1.2 or higher (HTTPS to users and to Amazon, TLS to the
  database).
- **Encryption at rest**: the Neon PostgreSQL storage is encrypted with AES-256. Credentials and buyer PII are
  also encrypted per field with AWS KMS envelope encryption; keys stay in AWS KMS.
- **Access control**: Nexus checks a role permission on every request (deny by default). Sign-in uses argon2id
  password hashes, a 12-character minimum with a strength check, and time-based two-factor codes.
- **Passwords**: every account that touches Amazon Information (Amazon Seller Central, Nexus, email, GitHub,
  Neon, Railway, AWS) uses a unique password of at least 12 characters including special characters, kept in a
  password manager, never shared, and multi-factor authentication. Passwords are changed at least every
  365 days, and at once after any suspected exposure.
- **Credentials**: kept only in the hosting provider's encrypted variables and in the encrypted developer
  computer. Never in code, never in a repository, never shared.
- **Network**: the application runs on Railway; only the web console and the API accept public traffic, over
  HTTPS. The database accepts only TLS connections with credentials. There are no file servers. The developer
  computer has full-disk encryption (FileVault), the system firewall and built-in anti-malware switched on.
- **Logging**: Nexus records an audit log of changes and a ledger of every marketplace API call (kept 90 days).
  The logger removes tokens, secrets and passwords before writing.
- **Change management**: every change is made on its own branch, built and tested in a local environment with
  its own local database (never production data, never real PII), reviewed in a pull request, and merged and
  deployed only by the owner.

## 6. Incident response plan

An incident is any loss, leak, or unauthorised access to Amazon Information, or a suspicion of it: a database
breach, a stolen credential, a lost device, a wrong recipient.

1. **Detect** — from provider alerts, Nexus alerts, the audit log, the API call ledger, or a report.
2. **Contain** (at once) — change the exposed passwords and keys, revoke the Amazon tokens, stop the affected
   service, block the access path.
3. **Notify Amazon** — e-mail **security@amazon.com within 24 hours of detection**, with what happened, which
   data, how many buyers, and what was done.
4. **Assess** — which data, which buyers, since when, how. Keep the evidence.
5. **Notify others** — the Italian data protection authority (Garante) within 72 hours when buyers' personal
   data is at risk (GDPR art. 33); the buyers when the risk is high (art. 34), in agreement with Amazon.
6. **Recover** — fix the cause, restore from backup if needed, check that the access path is closed.
7. **Review** — write what happened and what changes, within 14 days.

Playbooks:
- **Database breach**: rotate the database password and every credential in it; check the audit log and the
  provider's access logs; restore if data changed.
- **Unauthorised account access**: sign out all sessions, reset the password and 2FA, review the audit log for
  that account's actions.
- **Data leak** (export, e-mail, repository, device): remove the copy, rotate any credential in it, find every
  place it reached.

This plan is tested and reviewed every 6 months, together with this policy.
