# PR.5 measurements — 2026-09-13

Current status (2026-09-13T18:48:20.075463+00:00): **Presence migration staged, LOCAL APPLIED and verified68/68; PRODUCTION NOT APPLIED.** [Migration record](migration-record.md). M5 and the newly measured broader production-prerequisite scope answer remain pending. Repository declaration/generate/API tsc for Presence await the required both-DB verification. The original measurement snapshots below retain their dates and controls.

Read-only Wave 0; no repo source edits or database/channel writes. Scripts live only in `/private/tmp/nexus-pr5-presence/`. All times UTC. M1–M4/M6–M7: 2026-09-13T16:51:14.134Z local; 2026-09-13T16:51:14.488Z prod; API 2026-09-13T16:51:22.954Z; supplementary times in each file; M8 2026-09-13T16:49:07.541Z. All four probe commands exited 0.

| Measurement | Local: 127.0.0.1:55439/nexus_development | Prod: ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech/neondb |
| --- | --- | --- |
| M1 | GALE 59 = API 59; RLS on for core tables | GALE 51; RLS off; workspace substrate absent |
| M2 | 0 Offer / 731 Amazon listings | 0 Offer / 725 Amazon listings |
| M3 | 1012 listings; account nonnull/alias empty; duplicate groups 0 | 977 listings; account nonnull/alias empty; duplicate groups 0 |
| M4 | STATUS_UPDATE ever 0; empty-patch marker unavailable | STATUS_UPDATE ever 0; empty-patch marker unavailable |
| M5 | PENDING-OWNER (Seller Hub) | PENDING-OWNER (Seller Hub) |
| M6 | 2 ETSY rows; 0 Etsy ids found | 0 ETSY rows; 0 Etsy ids found |
| M7 | 0 / 1012 history key | 0 / 977 history key |
| M8 | all requested flags unset in apps/api/.env | RBAC enforce; Amazon true/live; Shopify flags unset |

Each M<n>.md contains the question, exact SQL/script, host, result, positive controls, time and decision. [Migration folders/prerequisites](migration-folders.md) records every folder. [evidence.json](evidence.json) holds all sanitized query text/results.

Session initialization:

```javascript
const { Client } = require('pg');
const client = new Client({ connectionString: explicitlyResolvedUrl });
await client.connect();
await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
// Local only: after measuring bare identity/RLS and discovering Workspace:
await client.query('SET LOCAL ROLE nexus_workspace_runtime');
await client.query("SELECT set_config('nexus.workspace_id',$1,true)", ['nexus_legacy_workspace']);
// Run the exact SQL in each M<n>.md; on prod, RLS is off and no SET ROLE is attempted.
await client.query('ROLLBACK');
await client.end();
```

Script SHA256 (scratch files contain no credentials):

| Script | SHA256 |
| --- | --- |
| discover.mjs | a9a8619ddea187939196f7245ca79e35b482a06764f47c6d072838dbd5a20ddd |
| measure.mjs | b7087b8901f20f397b0653436ed529c8baf877afc062fb7dfa128d058459e115 |
| railway-read.mjs | 4fcd693b4fb08c03cea2c11ca7d73b2f9db5a6dd39ea85b595cfcac245bf2e75 |
| supplement.mjs | 87b5e66f44ab90bc932dc67c50227cedcca7ac2ec80a512f9d18635c8720dd4c |

Status: M5 awaits Owner account/setting. W1.4 and W1.6-OFFER have now passed. Wave 2 is blocked by the later W1.5-PUSH REOPENED state; the earlier scoped DONE is superseded. PR.1 has published the wire and product-coordinate read-index request; PR.5 accepted it in the ledger at 17:05Z. Production is **NOT APPLIED**, local **NOT APPLIED**, schema **NOT DECLARED**; no W2 or AT-WAVE-4 completion claimed. The production workspace/RLS prerequisite must be resolved before a standard ListingIdentity policy can apply. No new presence event/Etsy/SaleStop table, SyncChannel change, snapshot nullability change, queue FK change, or variationExcluded declaration. No generate/tsc was required by these documentation-only results.

M3 follow-up at 2026-09-13T16:58Z distinguishes aliasId (NULL) from aliasKey (empty string) and records both DBs’ unique-index definitions. Local *_akey_key indexes include workspaceId and have NULLs distinct; production omits workspaceId and uses NULLS NOT DISTINCT. `alias-index.mjs` exit 0.

Latest ledger check 2026-09-13T17:22:17.901081+00:00: missing W1.4, W1.6-OFFER. Migration still unstaged/unapplied; no AT-WAVE-4 claim. Scratch verification/apply scripts are prepared but have not executed DDL.

Status rechecked 2026-09-13T18:00:57.290067+00:00: W1.4/W1.6-OFFER DONE; W1.5-PUSH REOPENED. The scratch apply guard requires each gate’s **latest** status to be DONE. M5 and migration/schema completion remain outstanding.

Resumed 2026-09-13T18:41:52.965821+00:00: additive Presence approval accepted. Newly measured prerequisite scope and separate clarification: [prerequisite-review.md](prerequisite-review.md). Focused in-memory SQL rehearsal passed28 checks ([receipt](rehearse-presence.json)); no application database was written. W1.5-PUSH latest status remains REOPENED while PR.4 completes its expanded sweep.
