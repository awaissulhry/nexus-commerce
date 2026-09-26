# Price read-back review closure — 2026-09-25

Implemented locally on `fix/cx-ebay-price-readback`; not integrated, deployed or enabled.

The old `r6-readback-unbounded` result was a Vitest timeout, not an assertion kill.
The test now observes completion independently within its existing three-second bound,
then releases and awaits the pending mock request in `finally`. The original elapsed-time,
result, one-GET/one-PUT and aborted-signal assertions remain. Vitest's ten-second timeout
and production code are unchanged.

Applied the exact two-part unbounded mutation: remove the service deadline and extend the
transport timeout to 120 seconds. It now fails the explicit completion assertion, with no
test timeout. Restored the service byte-for-byte and verified it against the committed blob.

- Red: `price-readback-review-20260925/unbounded-red.log`.
- Applied/restored proof and full SHA-256: `price-readback-review-20260925/unbounded-proof.json`.
- Reproduction harness: `price-readback-review-20260925/unbounded-proof.py`.
- Green: 51/51 targeted tests; API typecheck exit 0.
- Evidence directory: this worktree's `docs/channel-connections/build/evidence/`.
- Independent review: APPROVE (`review_finances`, read-only).
- Prior 84 assertion kills remain historical evidence; this closes the one timeout-only result.
- No production, vendor, migration, credential, flag or application-code changes.

Integration must still preserve published main's parent/shared-listing selection, Trading
rejection/drift reporting and every PostgreSQL suite. No automatic price healing or FX exists.
The census must be fresh before publication, and any non-IT master-price follower needs the
Owner's separate decision under the structured plan.
