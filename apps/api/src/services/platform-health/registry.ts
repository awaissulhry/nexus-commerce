/**
 * Platform health — every check the daily watchdog runs, in the order it reports them.
 *
 * To add a check: write it (gather + a pure judge, see types.ts) in checks/, give it a new stable id, add it here, and a
 * test of its judge with healthy and failing facts. Its alert rule ("Platform health: <title>") is created on the next
 * run; nothing else needs registering.
 */
import type { AnyHealthCheck } from './types.js'
import { cronRunsCheck, processesCheck } from './checks/scheduler.checks.js'
import { dailyReportsCheck, economicsFeedCheck, keywordRankFeedCheck, reportFeedsCheck, sqpFeedCheck } from './checks/feeds.checks.js'
import { adWritesCheck, queueDrainCheck } from './checks/writes.checks.js'
import { enginesIdleCheck, planStepsCheck, ruleGatesCheck } from './checks/automation.checks.js'
// Meta ads step 5 (2026-10-21): the Meta connection, from Nexus's own records (no Meta call).
import { metaAdsCheck } from './checks/meta.checks.js'

export const HEALTH_CHECKS: readonly AnyHealthCheck[] = [
  cronRunsCheck,
  processesCheck,
  dailyReportsCheck,
  reportFeedsCheck,
  sqpFeedCheck,
  economicsFeedCheck,
  keywordRankFeedCheck,
  adWritesCheck,
  queueDrainCheck,
  planStepsCheck,
  ruleGatesCheck,
  enginesIdleCheck,
  metaAdsCheck,
]
