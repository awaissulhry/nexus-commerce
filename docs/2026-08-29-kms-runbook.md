# Turning on KMS for stored credentials — the Owner's steps, and how to check them

> ## ✅ DONE — KMS is ON in production since 2026-09-26
>
> The Owner reversed the 2026-09-21 "not proceeding" decision on 2026-09-26, after
> reviewing the cost (~$1/month per key, cents in requests, +$1/month for each of the
> first two yearly rotations). The steps below were followed; every result was read
> back, not inferred.
>
> **A prerequisite was found first: the API ran on the AWS ROOT account's access key.**
> `aws iam get-access-key-last-used` returned no `UserName` for the production
> `AWS_ACCESS_KEY_ID`; the only IAM user (`sp-api-user`) did not own it. Granting KMS to
> root would have been meaningless (root can do anything), so the principal was fixed
> before step 1. That also answers "Open decision 3" below in part: KMS now has its own
> principal. It is still a static key pair in the Railway config, so the "a config leak
> is not survivable" caveat at the top still holds.
>
> What was done, 2026-09-26 (UTC):
> - **06:05:35** IAM user `nexus-api-production` created. Inline policy `nexus-api-sqs`
>   allows only `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes`
>   on `nexus-sp-api-notifications` and `nexus-sp-api-notifications-dlq` (us-east-1) and
>   `nexus-ams` (eu-west-1). Measured before the swap: the API uses no other AWS service
>   in production (`STORAGE_PROVIDER` unset → both stores are LOCAL, the account has no
>   S3 buckets; `amazon-sp-api` ^1.2 does not sign with AWS keys). The new key was
>   proven to read all three queues and to be denied S3, IAM and `sqs:ListQueues`.
> - **06:11:57** Railway `@nexus/api` `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
>   replaced. The new key was first used for SQS at 06:17; the root key was last used
>   at 06:16 (the old deployment); 0 auth errors in the logs.
> - **06:22:42** Root access key set to **Inactive** (reversible). Delete it after two
>   quiet days: `aws iam delete-access-key --access-key-id <root key id>` as root.
> - **Step 1** Key `alias/nexus-credentials-production` →
>   `arn:aws:kms:us-east-1:084164016829:key/50d6fb4a-8ecb-4a04-8a57-e7771f0186f2`,
>   automatic yearly rotation on.
> - **Step 2** Inline policy `nexus-api-kms` on `nexus-api-production`:
>   `kms:GenerateDataKey` + `kms:Decrypt` on that key only, and only with
>   `kms:EncryptionContext:app=nexus` and `kms:EncryptionContext:purpose=credentials`
>   (the context `lib/crypto.ts` sends). The IAM simulator shows both allowed with the
>   context, `kms:Decrypt` denied without it, `kms:Encrypt`/`ScheduleKeyDeletion` denied.
> - **Step 3** `NEXUS_KMS_KEY_ID=alias/nexus-credentials-production` at 06:23:54.
> - **Steps 3b–5**, run per business profile, because `ChannelConnection` is
>   workspace-owned (`ChannelApp` is global):
>
>   | profile | before | preflight | rotate | after |
>   |---|---|---|---|---|
>   | Motovento | onEnvKey=2 appOnEnvKey=6 | `ok mode=kms` | rotated=2 appRotated=6 failed=0 | onKms=2 onEnvKey=0 appOnKms=6 appOnEnvKey=0 unreadable=0 |
>   | Xavia Racing | onEnvKey=4 | `ok mode=kms` | rotated=5 (incl. 1 inactive) failed=0 | onKms=4 onEnvKey=0 appOnKms=6 appOnEnvKey=0 unreadable=0 |
>
>   Heartbeats after rotation: eBay `xaviaracing` and eBay `motovento` both `ok:true`.
>   CloudTrail since 06:20: 10 × `Decrypt` and 17 × `GenerateDataKey`, all by
>   `nexus-api-production`.
>
> **The jobs are run per profile.** "How to run these jobs" below says to use the hub's
> Sync Logs screen; the trigger button runs the job in the profile you are in, so run
> rotate/status once in every active profile. A profile added later starts on the env
> key until its first token refresh or a rotate run in that profile.
>
> **Rolling back** is unchanged (section at the end): unset `NEXUS_KMS_KEY_ID`, run
> `cx-credentials-rotate` in every profile, and do not touch the key until status reads
> `onKms=0` and `appOnKms=0` everywhere.

> **Revised 2026-09-21.** The first version of this runbook was checked against the code
> line by line. Five things in it were wrong or missing; the corrections are inline below
> and the reasoning is kept, because each one is a way this can silently half-work.

Everything on the code side is ready and has been since CX.1: `lib/crypto.ts` encrypts with a KMS-wrapped data key when `NEXUS_KMS_KEY_ID` is set, falls back to the environment key when it is not, and raises `CONNECTION_HEALTH` with `reason: "NEXUS_KMS_KEY_ID is not set"` every time it falls back. That alert has been firing since CX.1 shipped.

Confirmed 2026-09-21 against Railway `@nexus/api` production: `NEXUS_KMS_KEY_ID` is **not set**. Nothing is half-migrated. This starts from a clean state.

## What this buys, and what it does not — read this before spending the afternoon

The original framing was that the environment key "sits in the Railway config next to everything else", implying KMS moves the secret somewhere a config leak cannot reach. It does not. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` sit in that same Railway config, `lib/crypto.ts` builds its KMS client from the default credential chain, and that principal is the one granted `kms:Decrypt`. Whoever reads the Railway config can decrypt under either scheme.

What actually changes:

- **Every decrypt is recorded.** CloudTrail gets a `Decrypt` entry per unwrap, with the caller. Today a stolen env key leaves no trace at all.
- **Access is revocable in one action.** Disabling the key stops every unwrap immediately, everywhere, without redeploying or re-consenting. Rotating an env key means rewriting every envelope first.
- **The master key rotates itself** annually, and never leaves KMS.
- **The secret stops being a pasteable string.** This is not hypothetical here — a Neon password is already in this repository's git history. An env key is exactly the shape of value that ends up in a screenshot, a log line, or a commit.

That is a real improvement and it is worth ~$1/month. It is an *audit and revocation* improvement, not a secrecy one. If the goal is to make a Railway config leak survivable, the change that does that is giving KMS its own AWS principal — see "Open decisions" at the end. That is not part of this runbook.

**Why it matters more now than it did.** The Amazon Ads credential used to exist in ten places — nine duplicate row copies plus the envelope. CX.3b removed the nine. Consolidating was right, but it concentrated the risk: that single envelope is now the only copy of the credential authorising spend on four live Amazon marketplaces.

## 0. Establish two facts first — both are cheap, both can invalidate a later step

**0a. Which region will the KMS client actually call?** — **MEASURED: `us-east-1`.**

`lib/crypto.ts:253` builds the client as `new KMSClient({ region: process.env.AWS_REGION ?? 'eu-west-1' })`. The `eu-west-1` in that line is a fallback that is **never used**: `AWS_REGION` is set on the production API service, and on 2026-09-21 it reads

```
AWS_REGION=us-east-1
```

**The first version of this runbook told you to create the key in `eu-west-1`. That would have failed, and it would have failed quietly.** A KMS key id or alias resolves against the client's own region only — the SDK does not follow a key to another region, it answers `NotFoundException`, `encryptCredentials` catches that, falls back to the environment key, and the only symptom is the same `CONNECTION_HEALTH` alert that is already firing. You would have set the variable, seen no error, and been no safer.

**Create the key in `us-east-1`.** Every region in the commands below now says `us-east-1`.

Do **not** "fix" this by changing `AWS_REGION` instead. That variable also steers S3, SQS and the SP-API clients (`services/storage.service.ts:81`, `services/amazon-sqs.service.ts:223`, `services/flat-file/artifact-store.ts:127`). Moving it to chase a KMS key would move all of those with it.

If the key must live in Europe for a compliance reason, that is a code change — `lib/crypto.ts` would need its own `NEXUS_KMS_REGION` override rather than reading `AWS_REGION`. Not built; decide before step 1, not after.

**0b. Take a baseline reading now, before anything is configured.**

Run `cx-credentials-status` (see "How to run these jobs") and keep the line. With `NEXUS_KMS_KEY_ID` unset, the honest answer is `onKms=0 appOnKms=0`. Anything else means something is wrong before you have started. It also tells you how many secrets step 4 has to move, which is the number step 5 has to account for.

## 1. Create the key — in `us-east-1`

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

The API already authenticates to AWS for SP-API (`AWS_ACCESS_KEY_ID` / `AWS_ROLE_ARN`). `lib/crypto.ts` uses the default credential chain, so it is that same principal. It needs exactly two actions, and nothing that would let it delete or re-policy the key:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
    "Resource": "arn:aws:kms:us-east-1:<account>:key/<KeyId>"
  }]
}
```

`kms:GenerateDataKey` to wrap a new data key on write, `kms:Decrypt` to unwrap on read. **Both are required, and they are the single most common way this goes wrong** — see step 3b.

> **Correction.** The first version also granted `kms:DescribeKey`, on the stated grounds that it makes "a misconfigured key id fail loudly at startup rather than at the first refresh". There is no such startup check: `DescribeKey` is never called anywhere in `apps/api/src`, and `lib/crypto.ts` imports only `GenerateDataKey` and `Decrypt`. Granting it is harmless and you may keep it if you want to run `aws kms describe-key` under the API's own identity to prove the grant works. It buys nothing automatic. The preflight in step 3b is the only real check.

## 3. Set it on Railway

```
NEXUS_KMS_KEY_ID=alias/nexus-credentials-production
```

The service restarts. **New** encryptions are KMS-wrapped from that moment.

## 3b. Prove the key works BEFORE anything real is wrapped in it

Run `cx-credentials-preflight`. It wraps and unwraps a throwaway marker — no real credential is touched — and records one of three things:

- `ok mode=kms keyId=…` — wrap and unwrap both work. Proceed.
- `WARNING kmsConfigured=true but encryption used mode=env` — **the key is set and is not being used.** A wrong key id, a wrong region (step 0a), or a missing `kms:GenerateDataKey` all fall back silently, so this is the state that looks fine and is not.
- `FAILED … do NOT rotate` — the key cannot round-trip.

**Why this step exists.** `encryptCredentials` degrades safely when KMS cannot *wrap*, but it never checked that what it wrote can be *read back* — and those are different IAM permissions. A policy granting `kms:GenerateDataKey` without `kms:Decrypt` stores envelopes perfectly and can never open them. Since CX.1 nulled the plaintext columns, an unreadable envelope means re-consenting that channel.

`cx-credentials-rotate` runs this check itself and **refuses** if it fails, because it rewrites every channel's credential — a wrap-only key would take out all of them at once. The refusal changes nothing.

## 4. Migrate what already exists — this is the step that is easy to skip

Existing envelopes stay on the environment key until something rewrites them. `writeCredentials` runs on every token refresh, so eBay and Ads would migrate on their own within an hour or two — but "probably, eventually" is not a security posture, and a connection that has stopped refreshing (revoked, degraded, needs re-auth) would keep its env-keyed envelope indefinitely.

Run `cx-credentials-rotate`. It is idempotent, and it leaves an existing envelope untouched if the new one cannot be produced.

> **The app secrets are covered too — as of 2026-09-21.**
>
> The same `encryptCredentials` also writes `ChannelApp.clientSecretEnc` and
> `ChannelApp.signingKeyEnc` (`services/cx/apps.service.ts:94,201,243`) — the eBay and
> Amazon **application** client secrets and the eBay Key Management signing key. Until
> 2026-09-21 this job queried `channelConnection` only, and `cx-credentials-status`
> counted only those, so the finished state it reported was true and incomplete at the
> same time.
>
> That mattered more than the half it did cover. A client secret mints new tokens
> indefinitely; a refresh token is one grant. And an app secret is not refreshed on a
> timer, so unlike a connection it would never have migrated on its own.
>
> The job now walks both tables under the same preflight guard, and counts app secrets
> **per field**, not per row — one `ChannelApp` can hold both a client secret and a
> signing key, and "one app rotated" would hide a field that failed beside one that
> moved. A field that cannot be re-encrypted leaves its column unwritten; the other
> field on the same row still migrates.

## 5. Verify — do not infer

Run `cx-credentials-status`. It reads back, e.g.:

```
active=4 withEnvelope=3 onKms=3 onEnvKey=0 unreadable=0 noEnvelope=1 appSecrets=2 appOnKms=2 appOnEnvKey=0 appUnreadable=0 kmsConfigured=true
```

**The finished state is `onEnvKey=0` AND `appOnEnvKey=0`, with `kmsConfigured=true`.** Both halves, or the migration is not done. (`noEnvelope=1` is the Amazon environment-managed row, which holds no grant of ours — that one is expected.)

`unreadable` / `appUnreadable` must be `0`. Anything else is a stored value the job could not classify as either key. It is reported separately on purpose: a value that has not been shown to be on either key must not be quietly added to one of the counts.

> **Where these counts come from.** Every one is derived from the stored blob's own
> prefix — `v1` is the environment key, `v2` is a KMS envelope — never from the
> `credentialsKeyId` column. That column is nullable, and `ChannelApp` has no such
> column at all, so a `credentialsKeyId === 'env'` test counted a row whose key id was
> never written as KMS-protected. That is the one direction a miscount must never go:
> it reports the migration finished while an env-keyed envelope is still in the table.
> Fixed 2026-09-21; a test drives the null-column row specifically.

Then confirm the alert has stopped: no new `CONNECTION_HEALTH` with `"NEXUS_KMS_KEY_ID is not set"`, and a heartbeat still passes — `POST /api/cx/connections/<id>/heartbeat` returning `ok:true` proves the credential is still readable *through* KMS, which is the thing that actually matters.

## How to run these jobs — the original instructions did not work

The first version gave each step as `POST /api/sync-logs/cron/<name>/trigger` and described what the call "reports". It does not report it. Two things are in the way:

1. **The route answers immediately and runs in the background.** It returns `202 {"jobName":…,"status":"started"}` and fires the handler fire-and-forget (`routes/sync-logs.routes.ts:512`). The summary line quoted in every step above lands in a `CronRun` row, not in the HTTP response.
2. **The route is authenticated.** `/api/sync-logs` is gated by the permissions manifest — `adminView` to read, `syncManage` to write. A bare `curl` with no session gets nothing.

So: **run these from the hub's sync-logs screen**, which has a trigger button per registry entry and polls `CronRun` every 30 seconds. Press the button, wait, read the row. The three job names are `cx-credentials-preflight`, `cx-credentials-rotate`, `cx-credentials-status`; `GET /api/sync-logs/cron/registry` lists everything triggerable.

## If the key is wrong

The failure is designed to be safe: `encryptCredentials` falls back to the environment key and raises the alert rather than throwing, so a bad key id, a wrong region, or a missing IAM permission degrades to today's behaviour instead of breaking authentication. You will see it in `cx-credentials-status` as `onEnvKey` staying above zero with `kmsConfigured=true` — the one combination that means "configured but not working".

## Rolling back

Unset `NEXUS_KMS_KEY_ID` and run `cx-credentials-rotate` again; it re-encrypts everything under the environment key. Do not delete the KMS key until that reports `onKms=0` **and** `appOnKms=0` — a deleted key makes every envelope still wrapped by it permanently unreadable, and AWS's 7–30 day deletion window is the only chance to undo that.

## Open decisions — named here so they are not mistaken for done

1. ~~**Cover the `ChannelApp` secrets.**~~ **Built 2026-09-21** —
   `cx-credentials-rotate` and `cx-credentials-status` both walk `clientSecretEnc` and
   `signingKeyEnc`. Not deployed yet.
2. ~~**Read key state from the blob, not the column.**~~ **Built 2026-09-21** — applies
   to connections and app secrets alike, with `unreadable` reported separately. Not
   deployed yet.
3. **Give KMS its own AWS principal.** Today the credential that can `Decrypt` lives in the
   same Railway config as the data it protects, which is why the top of this document does not
   claim KMS defends against a config leak. A separate role — ideally one the API assumes
   rather than a static key pair — is the change that would make that claim true. Larger than
   this runbook; decide separately.
