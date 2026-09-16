# The studio import upload that took production down — 2026-09-16

An XLSX upload to the product editor's import drawer hung for five minutes, ended in
`Failed to fetch`, and left the production API unresponsive until it was restarted by
hand. This is what was measured, what was ruled out, and what the fix has to guarantee.

## What happened

| Time (UTC) | Evidence | Source |
| --- | --- | --- |
| 04:48:35.9 | `OPTIONS /api/catalog-transfer/products/cmokmy3a40078pm0p1fvnu523/inspect` → 204 | proxy log |
| 04:48:36.0 | `POST …/inspect` arrives, `reqId req-ai` | deploy log |
| 04:48:36.0 | **The last line the API ever logged.** No `request completed`, no error | deploy log |
| 04:48:39.9 | First `499` on an unrelated route — the API has stopped answering **everything** | proxy log |
| 04:55:52 | `GET /api/notifications` → `502 connection dial timeout` ×3 | proxy log |
| 05:06 | `/api/health` still `502` after 18 minutes. Production never self-healed | direct probe |

Throughout, container memory sat pinned at **3.751469056 GB — the same value to the
byte** for over twenty minutes, with CPU low but non-zero. That is not a spinning loop
and not a clean crash: it is V8 at its heap ceiling, collecting continuously and making
no progress. The process never died, so the platform never restarted it.

The operator's five minutes are Node's own `server.requestTimeout`, whose default is
300 s. `apps/api/src/index.ts` builds the server as `Fastify({ logger: true, trustProxy: 1 })`
and sets no timeout, so the default applied: at 300 s Node destroyed the socket and the
browser reported `Failed to fetch`. The drawer
(`apps/web/src/app/products/[id]/edit/_studio/import/ProductTransferDrawer.tsx:164`)
renders `Reading {file}…` with no timeout and no progress, which is the screen the
operator watched for the whole five minutes.

## What was ruled out, by measurement

Each of these was a plausible cause and each was tested rather than argued:

| Hypothesis | Measurement | Verdict |
| --- | --- | --- |
| Ordinary parsing is just slow | A Nexus editing export at its full 50,000-row limit parses in **0.35 s** | refuted |
| A dense workbook at the size cap | 500,000 cells (2.7 MB file, 28.9 MB expanded): 0.69 s, ~520 MB heap | bounded |
| `checkWorkbookSize` silently measures zero | Tested against four real-world Excel/eBay files — every entry reported its size, the guard measured all of them correctly, and refused a 2M-cell grid | refuted |
| The stored export baseline is huge | 13–30 MB for a maximum export | not GB-scale |

The heap cost tracks cell-bearing worksheet XML at roughly **1 KB per cell**
(250k cells → 250 MB, 500k cells → 520 MB).

**The exact runaway allocation was not pinned.** The handler has no internal
instrumentation, which is precisely why the logs go silent at the moment it matters —
the first thing the fix adds back.

## The defect that is confirmed, and is sufficient on its own

`POST /api/catalog-transfer/products/:productId/inspect` parses an untrusted
spreadsheet **inline, on the API's shared event loop and in its shared heap**, with no
deadline and no containment:

- `apps/api/src/routes/catalog-transfer.routes.ts` hands the upload straight to
  `inspectEditorTransfer`.
- `readEditorPart` (`catalog-editor-workbook.ts:33`) loads the workbook with ExcelJS on
  the main thread, and for any file that is not a Nexus or eBay workbook falls through
  to `readTransferFile`, which **calls `checkWorkbookSize` and `xlsx.load` on the same
  bytes a second time** while the first workbook is still referenced — doubling the peak
  for the worst case.
- The limits permit a large peak by design: 40 MB expanded per workbook (~700 MB heap at
  the measured ratio), 128 MB across a ZIP batch, 2,000,000 scanned cells, 250,000
  outcomes — and `readCatalogWorkbook`'s cell budget is checked *after* `xlsx.load` has
  already materialised everything, so it cannot prevent the allocation it is guarding.

The consequence is the part that matters and is independently confirmed by the logs:
**any runaway in that parse — this one or the next — takes all of production down
permanently, with no self-recovery.** One operator uploading one file is enough.

## What the fix has to guarantee

1. A spreadsheet parse must not be able to exhaust or block the API process.
2. A failed parse must produce a fast, honest error, not a five-minute silence.
3. The handler must say what it did and how long each stage took, so a recurrence is
   diagnosable from one log line instead of a forensic reconstruction.

Containment was verified before being built on: a worker thread given
`resourceLimits.maxOldGenerationSizeMb` and an unbounded allocation is killed in
**319 ms**, delivers a catchable `Worker terminated due to reaching memory limit` to the
host, and leaves the host process at 9.5 MB. That converts this incident from a
permanent outage into a sub-second refusal.
