/**
 * ADS AUTONOMY W4-7 — what the budget schedules' and the budget pools' crons do now, in one sentence, read as their runs
 * read it (as budgetEnforceMode does for the budget engine): whether the Amazon ads crons are scheduled on this server,
 * the account ads dial a run honours (readEnginePosture, its own read), and whether Amazon ads writes are live or in
 * sandbox. Claude's set-budget-schedule and set-budget-pool name it, so a preview never says "at Amazon" when nothing
 * would reach it. Read only.
 */
import { envEnabled } from '../../utils/env-flag.js'
import { adsMode } from './ads-api-client.js'
import { readEnginePosture } from './ads-engine-guard.js'

export type BudgetEngine = 'budget-schedules' | 'budget-pools'

/** What each engine still does under the dial (ads-automation-adapters.ts GUARDED_WORDS, the same words). */
const UNDER_DIAL: Record<BudgetEngine, { suggest: string; stopped: string }> = {
  'budget-schedules': {
    suggest: 'it enters no window and writes nothing new, but still gives back a budget it set when that window closes.',
    stopped: 'it writes nothing; windows and give-backs wait for Resume.',
  },
  'budget-pools': {
    suggest: 'each due rebalance is recorded as a dry run; nothing is written.',
    stopped: 'it writes nothing; rebalances wait for Resume.',
  },
}

export interface BudgetEngineMode {
  /** Off · Stopped · Suggest only · Sandbox · Live. */
  label: string
  /** True when a run now writes budgets to Amazon. */
  live: boolean
  sentence: string
}

export async function budgetEngineMode(engine: BudgetEngine): Promise<BudgetEngineMode> {
  const what = engine === 'budget-schedules' ? 'the budget schedules' : 'the budget pools'
  const cadence = engine === 'budget-schedules' ? 'every 15 minutes' : 'on its cron (every 15 minutes by default), after each pool\'s cool-down'
  if (!envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')) {
    return { label: 'Off', live: false, sentence: `Off: the Amazon ads crons are not scheduled on this server (NEXUS_ENABLE_AMAZON_ADS_CRON), so ${what} write nothing.` }
  }
  const { posture, why } = await readEnginePosture()
  if (posture === 'stopped') return { label: 'Stopped', live: false, sentence: `Stopped (${why}): ${UNDER_DIAL[engine].stopped}` }
  if (posture === 'suggest') return { label: 'Suggest only', live: false, sentence: `Suggest only (${why}): ${UNDER_DIAL[engine].suggest}` }
  if (adsMode() === 'sandbox') {
    return { label: 'Sandbox', live: false, sentence: `Runs ${cadence}, but Amazon ads writes are in sandbox (NEXUS_AMAZON_ADS_MODE): its budgets stay in Nexus and never reach Amazon.` }
  }
  return { label: 'Live', live: true, sentence: `Live: it writes budgets at Amazon ${cadence}.` }
}
