# Excluded baseline

The authenticated baseline at 2026-09-12T21:10:42.444Z–2026-09-12T21:10:47.921Z used the existing all-scope readiness endpoint against local nexus_development. Its timings (2992.2 / 549.3 / 558.6 ms) are **excluded from the provider-free gate**. The returned Shopify result establishes that its schema path resolved, but its 30-second process cache was not instrumented; the run cannot establish whether a provider request occurred. No publish action was invoked. No outgoing transport trace was captured, so the number of possible provider requests is unknown.

The replacement baseline runs the same endpoint handler in the fixed local harness with provider gateways denied before credentials/rate-limiter/network work, external HTTP blocked, and a read-only transaction rolled back. Both before and after use that same harness. Original receipts remain in this folder.
