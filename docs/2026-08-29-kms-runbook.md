# Turning on KMS for stored credentials — the Owner's steps, and how to check them

Everything on the code side is ready and has been since CX.1: `lib/crypto.ts` encrypts with a KMS-wrapped data key when `NEXUS_KMS_KEY_ID` is set, falls back to the environment key when it is not, and raises `CONNECTION_HEALTH` with `reason: "NEXUS_KMS_KEY_ID is not set"` every time it falls back. That alert has been firing since CX.1 shipped.

**Why it matters more now than this morning.** The Amazon Ads credential used to exist in ten places — nine duplicate row copies plus the envelope. CX.3b removed the nine. Consolidating was right, but it concentrated the risk: that single envelope is now the only copy of the credential authorising spend on four live Amazon marketplaces, and today it is protected by an environment variable that sits in the Railway config next to everything else.

## 1. Create the key (AWS, eu-west-1)

```bash
aws kms create-key \
  --description "Nexus — channel credential envelopes (production)" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --tags TagKey=app,TagValue=nexus TagKey=env,TagValue=production

# Give it a stable name so the id can be rotated without touching config:
aws kms create-alias \
  --alias-name alias/nexus-credentials-production \
  --target-key-id <KeyId from above>
```

A symmetric key is ~$1/month plus per-request charges that will be invisible at this volume (a handful of `GenerateDataKey`/`Decrypt` calls per refresh).

## 2. Allow the API's identity to use it — and only to use it

The API already authenticates to AWS for SP-API (`AWS_ACCESS_KEY_ID` / `AWS_ROLE_ARN`). That principal needs exactly three actions, and nothing that would let it delete or re-policy the key:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"],
    "Resource": "arn:aws:kms:eu-west-1:<account>:key/<KeyId>"
  }]
}
```

`kms:GenerateDataKey` to wrap a new data key on write, `kms:Decrypt` to unwrap on read, `kms:DescribeKey` so a misconfigured key id fails loudly at startup rather than at the first refresh.

## 3. Set it on Railway

```
NEXUS_KMS_KEY_ID=alias/nexus-credentials-production
```

The service restarts. **New** encryptions are KMS-wrapped from that moment.

## 4. Migrate what already exists — this is the step that is easy to skip

Existing envelopes stay on the environment key until something rewrites them. `writeCredentials` runs on every token refresh, so eBay and Ads would migrate on their own within an hour or two — but "probably, eventually" is not a security posture, and a connection that has stopped refreshing (revoked, degraded, needs re-auth) would keep its env-keyed envelope indefinitely.

Trigger the rotation instead:

```
POST /api/sync-logs/cron/cx-credentials-rotate/trigger
```

Idempotent, and it leaves an existing envelope untouched if the new one cannot be produced.

## 5. Verify — do not infer

```
POST /api/sync-logs/cron/cx-credentials-status/trigger
```

Reads back, e.g.:

```
active=4 withEnvelope=3 onKms=3 onEnvKey=0 noEnvelope=1 kmsConfigured=true
```

**`onEnvKey=0` and `kmsConfigured=true` is the finished state.** (`noEnvelope=1` is the Amazon environment-managed row, which holds no grant of ours — that one is expected.)

Then confirm the alert has stopped: no new `CONNECTION_HEALTH` with `"NEXUS_KMS_KEY_ID is not set"`, and a heartbeat still passes — `POST /api/cx/connections/<id>/heartbeat` returning `ok:true` proves the credential is still readable *through* KMS, which is the thing that actually matters.

## If the key is wrong

The failure is designed to be safe: `encryptCredentials` falls back to the environment key and raises the alert rather than throwing, so a bad key id or a missing IAM permission degrades to today's behaviour instead of breaking authentication. You will see it in `cx-credentials-status` as `onEnvKey` staying above zero with `kmsConfigured=true` — the one combination that means "configured but not working".

## Rolling back

Unset `NEXUS_KMS_KEY_ID` and run `cx-credentials-rotate` again; it re-encrypts everything under the environment key. Do not delete the KMS key until that reports `onKms=0` — a deleted key makes every envelope still wrapped by it permanently unreadable, and AWS's 7–30 day deletion window is the only chance to undo that.
