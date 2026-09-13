# W1.9 — approved completion correction

Owner approved the recommendation on 2026-09-13. Verbatim approval and PR-OWNER W1.9 GO relay are in the ledger. M4 measured local/prod AMAZON STATUS_UPDATE all-time0 and30-day SUCCESS0; historical empty-patch incidence remains unmeasurable. The new stable queue code supplies a future durable marker.

An Amazon STATUS_UPDATE containing only status produces no supported Listing Items patches. Before: the adapter returned success:true/status:SKIPPED, then pending/retry and BullMQ writers recorded SUCCESS because dryRun was false/absent. After: all three use completedSyncQueueData, retain SKIPPED, syncedAt:null, AMAZON_EMPTY_PATCH_NOT_SENT and the operator sentence. No successful-send counter increment. Actual acknowledged and dry-run publisher controls preserve their distinct results.

The same completion rule handles explicit SKIPPED/NOT_SENT returns consistently. It clears stale retry scheduling and old errors only after a completed result; transport/refusal failure handling, normal worker routing, lifecycle dispatch and adapter targets remain unchanged. This intentionally supersedes the earlier PR.2 “ordinary worker suffix unchanged” receipt only at its success-recording block and SKIPPED completion counter.

No prod/channel writes, publishing-mode change, or commit. The real database rehearsal uses a permanently fixture-scoped table reader so processPendingSyncs cannot drain other work. Detailed final outcomes and cleanup are in w19-rehearsal.json after the successful run.
