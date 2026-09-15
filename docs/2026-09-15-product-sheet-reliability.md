# Product sheet loading and connection failures

## Findings

The production GALE-JACKET eBay · IT sheet repeatedly exceeded the browser's
30-second deadline. Railway recorded HTTP 499 responses at 07:18:49 and 07:19:28
UTC on 15 September, with no response body. The UI presented that timeout as a
possible internet connection or product access problem.

Profiling the sheet exposed 43 separate database transactions on a warm read.
Each query configured workspace ownership and committed independently, producing
215 database commands. Latency and competition with background jobs amplified
that overhead. The editor also made an unauthenticated server-side startup pass
before repeating its product, marketplace and connection reads in the browser.

## Changes

- Build each studio sheet inside one bounded, read-only, repeatable-read
  transaction. Related tables share a consistent snapshot and workspace context.
- Reuse an existing write transaction when its writer needs to inspect a sheet,
  preserving visibility of uncommitted edits and the existing save path.
- Allow only the exact SQL statement `SET TRANSACTION READ ONLY` through the
  raw-SQL guard. Role changes, transaction termination and `READ WRITE` remain
  prohibited. Generated database runtime code is updated with its source.
- Include transaction acquisition and completion in the reported sheet timing;
  send `Cache-Control: no-store` with the authenticated sheet response.
- Start editor loading in the authenticated browser, with an immediate existing
  Nexus skeleton, and cancel startup reads when navigating away.
- Give sheet, frame and destination reads a shared 30-second transport deadline.
  Retry a dropped connection or HTTP 502/503/504 once, within that same deadline.
  Do not retry access refusals, validation errors, rate limits or expired reads.
- Show distinct timeout, connectivity, session, access and unavailable-product
  messages. Add a retry action to destination failures as well as sheet failures.

## Measured results

The direct production-database probe ran from this machine using the application
read pipeline, an unpooled database connection with writes disabled, and disabled
workers. These figures isolate the code improvement; they are **not timings from
a deployed replacement API**.

| eBay · IT probe | Before | After |
| --- | ---: | ---: |
| First read | 11,112 ms | 2,544 ms |
| Warm read | 9,832 ms | 1,963 ms |
| Warm database commands | 215 | 49 |
| Warm transactions | 43 | 1 |
| Returned rows / columns | 21 / 52 | 21 / 52 |

Mapping resolution completed in all four probes; no mapping fallback was used.
The warm measurement improved by about 80% and removed 77% of database commands.

Nine authenticated HTTP reads against the updated local API, in three concurrent
Shared product / eBay / Amazon batches, all returned HTTP 200 with 21 rows and
complete mapping results. Warm durations were 71–387 ms. The disposable local
test user and role were removed and their removal verified.

## Verification

- API and web TypeScript checks passed.
- 95 distinct API regressions passed across transaction, account isolation,
  language, provenance, information editing and formula save/undo suites.
- 63 frontend regressions passed across read recovery, frame discovery, sheet
  states, channel writes and missing-product handling.
- The database-backed regression confirmed that a write attempted inside the
  read snapshot is rejected by PostgreSQL and leaves the product unchanged.
- Token generation, token guard, design conformance and whitespace checks passed.
- The local browser rendered all 21 eBay rows, supported keyboard switching to
  Amazon and back, and rendered in light/dark mode and at 768 pixels wide.
  No browser error logs were reported in the final verification tab.
- A separately stalled local Next.js development process was restarted; its
  replacement is serving port 3000 with the existing isolated build setting.

No shared design-system files were changed by this patch. It composes the existing
Skeleton, EmptyState, Banner and Button components. Screenshots and detailed probe
receipts are in `/private/tmp/nexus-sheet-performance/`.

## Rollout

The owner authorized committing, pushing and deploying all pending work on
15 September. The combined release includes these API and web changes, the eBay
workbook importer, and the recorded listing-alias index migration. The loading
fix itself needs no schema or product-data change. Verify API readiness and the
frontend production deployment against the release commit, then repeat the
authenticated eBay · IT read on the live site. Deployment receipts are kept with
the probe artifacts. These checks cover the reported loading path and its save
regressions, not a platform-wide accessibility certification.
