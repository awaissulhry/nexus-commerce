# Step 5 boundaries

`ReadinessIndex` preserves the design §3 coordinate (channel, market, account, alias) and language. Its canonical JSON tuple key distinguishes NULL Shared/primary coordinates without PostgreSQL NULL-distinct duplicates. Workspace ownership and relation traversal are registered with the existing workspace client. No custom database trigger or function enforces content behavior.

| Boundary | Producer / consumer |
| --- | --- |
| Source and shared-language edits | `master-content.service.ts` schedules the family producer after the same-language cascade. All translation-write create/update/review/reset callers reach that cascade. |
| Channel pins and pin resets | `content-write.ts` schedules the same producer after the addressed pin and audit write. |
| Sheet paste, fill, mixed edits and fact edits | `bulk-edit.service.ts` binds the outer transaction before constructing mutations and schedules the affected families. Content bulk and formula writers reuse that transaction. |
| Transaction | `database-context.ts` deduplicates producers by family and awaits them before commit. A producer failure rolls back values, versions, audit and cascade together; existing post-commit effects remain after commit. |
| Materializer | `readiness-index.service.ts` calls the existing studio row validators with cache-only schema access. Completed schema cache entries are usable; missing schemas remain unscorable. It replaces derived index rows only. It never creates translations or changes legacy content. |
| Language requirement | The existing LX.5 `resolved.language !== requested` rule in `readiness.service.ts` / `sheet-rows.service.ts` remains the sole filled/missing decision. No duplicated validator. |
| Reconcile | Clustered, workspace-scoped nightly job at `17 2 * * *` in the runtime timezone. Root families are paged in batches of 100; each family is atomic. It continues after a failed family and records the overall run as failed. Protected legacy creation paths are repaired by this backstop; protected runtime files remain untouched. |
| API | `scope-readiness.service.ts` reads the index plus product/market/account identity only. Full-sheet reads per channel are removed. Family percentages sum filled/total counts, preserve NULL, and retain the scope state vocabulary. Selected account/alias behavior is preserved. |
| Wire | `types.ts`, `readiness.ts` and `contracts.tsx` carry and parse the matrix and per-scope language summaries in the same change. Matrix percentages use the same strict parser as scope chips. |
| Screen | `StudioBar.tsx` shows the pressed language and other-language states in its tooltip. `ReadinessPanel.tsx` feeds the matrix and Needs attention from the same response, using Nexus Card, DataGrid, Pill and the shared readiness vocabulary. Shared is first; language order is the ordered Marketplace union, source first. |

The screen is the new Product Edit Studio at `/products/:id/edit/studio`, Needs attention (`tab=errors`). The legacy edit route is still present; its retirement belongs to Step 6. No shared design-system component changed in Step 5, so no Factory mirror or DS gap was required.

The screen harness admits only reviewed database GET endpoints. Notification/sidebar counters and `/listings/publish-readiness` are refused before dispatch; their unrelated panels are outside this gate. No publish action is invoked. The original uncontrolled timing baseline is excluded for the uncertainty described in `baseline-limitation.md`; it is not evidence of zero provider calls.
