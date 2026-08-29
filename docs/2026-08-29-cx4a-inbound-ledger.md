# CX.4a — the inbound ledger, and eBay's real signature (exact change)

Programme: `docs/2026-08-29-cx-channel-connections.md` §4 row **CX.4**, first slice. Owner, 2026-08-29: *"Go ahead, proceed with the next."*
Depends on CX.1 (`ebayAppToken`, `ChannelApp`) — both live.

## 0. What the measurement changed about the plan

CX.4 was scoped as ingress + verifiers + processor + DLQ + reconciler + UI tab. Measuring prod first moved two of those and deleted the need for a third:

| Measured on prod, 2026-08-29 | Consequence for the plan |
|---|---|
| `WebhookEvent` = **5,158 rows, every one `AMAZON`** | eBay/Shopify/Etsy have never delivered a single inbound event. The ingress work is eBay-shaped, not generic-shaped. |
| **`unprocessed = 0`, `errored = 0`** | There is no existing backlog for a DLQ to inherit. Retry/DLQ is real work but it is not urgent work — it moves to CX.4c. |
| **`signature IS NULL` on all 5,158** | Not one inbound event on this system has ever retained evidence of how it was trusted. |
| `ORDER_STATUS_CHANGE` last arrived **2026-07-29 11:03**, `ORDER_CHANGE` still arriving (**2026-08-28 22:22**) | Decision 12 confirmed exactly. Orders are still covered by `ORDER_CHANGE`; the loss is a dead subscription, not a data gap. Cleanup, not an incident. |

So this slice is the ledger plus the one verifier that is provably wrong, and the processor/reconciler/UI follow.

## 1. The defect this closes

`ebay-notification.routes.ts` verified inbound notifications with `HMAC-SHA256(rawBody, EBAY_NOTIFICATION_VERIFICATION_TOKEN)`.

eBay does not sign that way. The verification token exists **only** to compute the challenge response when eBay probes endpoint ownership. Real notifications carry an ECC signature over the payload, verified with a public key fetched by the key id inside the header. The audit recorded the mismatch on 2026-08-29 (`cx-audit.md` §eBay/Notifications: *"not eBay's ECDSA + `getPublicKey(kid)` scheme"*); this is the fix.

**What made it costly is not the wrong algorithm — it is that the wrong algorithm was unobservable.** A rejected notification returned `204` (with a comment asserting eBay requires 204 to stop retries) and wrote nothing. So "eBay has never sent us anything" and "eBay's notifications have all been silently discarded" produce byte-identical evidence. I cannot tell you which happened, and neither could anyone else — that is the actual bug.

Three separate errors, each fixed:

| | Was | Is |
|---|---|---|
| Algorithm | HMAC-SHA256 over the raw body, keyed by the verification token | ECC signature verified against `getPublicKey(kid)` |
| Reject status | `204` — which tells eBay the notification was **accepted** | `412`, which is what eBay's own SDK answers |
| Reject record | a `logger.warn`, nothing durable | a ledger row with `signatureOk=false` and the reason |

## 2. The protocol, and where it came from

I did not implement this from memory. `developer.ebay.com` timed out and the session's web-search budget was spent, so the protocol was read verbatim out of eBay's own Apache-2.0 SDK (`eBay/event-notification-nodejs-sdk`, `lib/validator.js` + `lib/constants.js`) and **re-implemented** here — read the design, never vendor the code, per the standing rule.

That mattered: a summarised read of the same files reported the algorithm as `RSA-SHA256`; the constants file says `ALGORITHM: 'ssl3-sha1'`. Fetching the exact bytes rather than a paraphrase is the only reason this is right.

1. `x-ebay-signature` → base64-decode → ASCII → JSON → `{ kid, signature }`.
2. `GET /commerce/notification/v1/public_key/{kid}` with an **application** (client-credentials) token. `ebayAppToken` already existed from CX.1 — its docblock even says "and Notification public keys".
3. The returned `key` carries PEM markers but no line breaks; insert them.
4. Verify the base64 signature with an SHA-1 digest (`ssl3-sha1` is OpenSSL's alias; the key being EC is what makes it ECDSA). Proven against a real EC key pair on this runtime's OpenSSL 3.6.3 **before** any of it was written.

Signed bytes: eBay's SDK signs `JSON.stringify(payload)` — the re-serialised object, not the wire bytes. This implementation checks that form first because it is the one that interoperates, then the raw bytes as well. Accepting either cannot weaken the check: a signature valid over either still requires eBay's private key, and it removes a class of false rejection caused by whitespace we did not choose.

## 3. The ledger

`WebhookEvent` becomes the programme's `InboundEvent` (§3.4.3) by extension, not replacement — 5,158 rows already hold the payloads and provider timestamps, and a parallel table would have split the history.

New columns: `connectionId`, `status`, `attempts`, `nextAttemptAt`, `signatureOk`, `verifiedBy`, `payloadDigest`, `lastError`, `archivedAt`, `archiveUri` (the last two declared now, used by the CX.4c archiver — decision 9, archive never delete).

**`signatureOk` is tri-state on purpose.** `true` = checked and passed; `false` = checked and failed; `null` = this transport carries no signature to check. Amazon's SP-API notifications are unsigned JSON on a queue we own, authenticated by its IAM policy (research R1) — `false` would claim a check failed and `true` would claim one happened. `verifiedBy` names what actually established trust (`sqs_iam`, `ebay_ecdsa`), so the null is explained rather than merely empty.

The rule the writer enforces: **arrival creates the row, not acceptance.** That is what makes the next silent rejection findable.

## 4. Verified

- **Migration, dry-run against prod inside `BEGIN`/`ROLLBACK`, applied the way `migrate deploy` applies it (whole file, not split):** 10/10 columns; applied twice with no error (idempotent); all 5,158 rows backfilled to `status=done · verifiedBy=sqs_iam · signatureOk=null`; `isProcessed` and `status` agree on every row; 3 indexes created; rolled back with prod unchanged.
- **Verifier, 15 tests against real EC key pairs, no mocked crypto:** valid signature over the canonical JSON passes; valid signature over differing wire bytes passes; **tampered body rejected**; **wrong key rejected**; unfetchable key rejected (`public_key_unavailable` — an unverifiable event is not an accepted one); non-JSON body rejected; keys cached and fetched once.
- **The suite can fail:** mutating `signature_mismatch` → `ok` fails exactly the two tests that must catch it. Restored and re-run green.
- **Regression:** 430 files / 5,694 tests pass. `tsc --noEmit` clean.
- **Challenge endpoint still answers on prod** — `GET /api/webhooks/ebay-notification?challenge_code=…` → `200` with a hash, before and after.

## 5. What is NOT verified, and cannot be yet

**No eBay notification has been verified end to end, because nothing is subscribed.** No code creates a Notification API destination or topic subscription (audit: `grep commerce/notification` → 0). Until CX.4b creates one, eBay sends nothing and the new verifier has nothing real to check. The honest statement is: the algorithm is right, proven against real keys; whether eBay accepts our destination is untested.

Creating that subscription is an outward-facing write that makes eBay start pushing live traffic, so it is a decision to take deliberately rather than a side effect of this commit.

## 6. Deliberately not done

- **`MARKETPLACE_ACCOUNT_DELETION` is acknowledged and recorded, and the erasure is NOT automated.** Acknowledging is mandatory and now happens (200 + ledger row + an error-level log). Carrying out the erasure deletes real customer data; doing that as a side effect of an inbound message would be the most destructive path in this codebase, and it needs the Owner's decision and its own unit.
- **Retry / DLQ / replay** — no backlog exists to justify it ahead of the reconciler. CX.4c.
- **The Ingress tab** — CX.4d, once there is inbound traffic worth rendering.
- **The dead `ORDER_STATUS_CHANGE` subscription** — cleanup, folded into CX.4b with the reconciler that owns subscriptions.
