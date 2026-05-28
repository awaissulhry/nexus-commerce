/**
 * OL.D.2 — Listing-automation cron entry point.
 *
 * Thin wrapper around runListingAutomationOnce so the cron registry can
 * fire it on a schedule and the manual-trigger endpoint
 * (POST /api/sync-logs/cron/listing-automation-evaluator/trigger) can run
 * it on demand. Honours each rule's own dryRun flag (no force here).
 */

import { runListingAutomationOnce } from '../services/listing-automation/evaluator.js'

export async function runListingAutomationCron(): Promise<void> {
  await runListingAutomationOnce()
}
