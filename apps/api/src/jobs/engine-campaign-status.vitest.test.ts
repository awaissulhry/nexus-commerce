/**
 * SYNC.1 — the scheduling engines may not write `Campaign.status`.
 *
 * Measured on prod 2026-08-21: the operator paused campaigns in Seller Central, the settings sync
 * pulled PAUSED down correctly at 19:20, and at 19:30 `ad-rank-defend` pushed ENABLED back up on 20
 * of them (`AD_ENTITY_STATE_UPDATE`, actor `automation:rank-defend-*`, amz=SUCCESS). Both engines
 * carried the same block:
 *
 *     // Resume only if something ELSE left it paused (we never pause).
 *     if (camp.status === 'PAUSED') → patch { status: 'ENABLED' }, applyImmediately: true
 *
 * "Something ELSE" included the human. Since the no-pause policy the engines suppress with a bid
 * floor and never pause a campaign, so those blocks had nothing legitimate left to resume.
 *
 * Two layers are pinned here:
 *   1. the runtime predicate that refuses the write inside `updateCampaignWithSync`, and
 *   2. the call sites, so the four deleted lines cannot quietly return.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAutomatedPause, isSchedulingEngineActor } from '../services/advertising/ads-mutation.service.js'

describe('SYNC.1 — which actors may set Campaign.status', () => {
  // The exact actor strings from the incident's AdvertisingActionLog rows.
  it('REFUSES the two engine crons', () => {
    expect(isSchedulingEngineActor('automation:rank-defend-cmr2699uy02njp7018u2mndsz')).toBe(true)
    expect(isSchedulingEngineActor('automation:rank-defend-cms9l7ymv0dkfo401iaawnl8z')).toBe(true)
    expect(isSchedulingEngineActor('automation:dayparting-cmq0xape100aio201urf5utiz')).toBe(true)
  })

  // The false-POSITIVE direction is the dangerous one: wrongly refusing here would break an
  // operator's Pause button on a live ad account, which is worse than the bug being fixed.
  it('ALLOWS a human, including the anonymous operator the Ad Manager writes', () => {
    expect(isSchedulingEngineActor('user:anonymous')).toBe(false)
    expect(isSchedulingEngineActor('user:awais')).toBe(false)
    expect(isSchedulingEngineActor('user:neg3b-probe')).toBe(false)
  })

  it('is not the SYNC.1 ban for an operator-authored rule — RULE_ACTOR is a bare automation:<cuid>', () => {
    // automation-action-handlers.ts: `const RULE_ACTOR = (ruleId) => \`automation:${ruleId}\``
    // enable_campaign / resume_campaign keep working. A rule's PAUSE is refused by 1f below, not here.
    expect(isSchedulingEngineActor('automation:cms450kg9002rqt019f1outpu')).toBe(false)
    expect(isSchedulingEngineActor('automation:budget-manager-cron')).toBe(false)
  })

  it('does not match on a substring — the prefix must be the actor kind', () => {
    expect(isSchedulingEngineActor('user:rank-defend-impersonator')).toBe(false)
    expect(isSchedulingEngineActor('automation:my-rank-defend-rule')).toBe(false)
  })

  // 2a (review 3.3) — these were exempt one-shot resumes when a person switched a schedule off or deleted it, gated on
  // `lastApplied === 'PAUSED'`. Since no-pause the dayparting cron records PAUSED for a closed window it only floored, so
  // the resume re-enabled campaigns a person had paused. The schedule paths now give bids back and write no status.
  it('REFUSES the old schedule disable/delete resume actors too — there is no exemption', () => {
    expect(isSchedulingEngineActor('automation:dayparting-disable')).toBe(true)
    expect(isSchedulingEngineActor('automation:dayparting-delete')).toBe(true)
    expect(isSchedulingEngineActor('automation:dayparting-disabled-cms450kg9002rqt019f1outpu')).toBe(true)
  })
})

/**
 * 1f — no automation pauses a campaign or an ad group (Owner rule; decision S5). SYNC.1 let an
 * operator-authored rule through, so `pause_campaign`, `pause_all_campaigns`, `dayparting_apply` and
 * `liquidate_aged_stock` could still pause on Amazon. `isAutomatedPause` is the backstop in
 * `updateCampaignWithSync` / `updateAdGroupWithSync`; the write itself is pinned in
 * services/advertising/no-automated-pause.vitest.test.ts.
 */
describe('1f — which actors may PAUSE a campaign or an ad group', () => {
  it('REFUSES a pause from every automation actor — a rule, an engine, a one-shot handler', () => {
    expect(isAutomatedPause('automation:cms450kg9002rqt019f1outpu', 'PAUSED')).toBe(true)
    expect(isAutomatedPause('automation:budget-manager-cron', 'PAUSED')).toBe(true)
    expect(isAutomatedPause('automation:rank-defend-cmr2699uy02njp7018u2mndsz', 'PAUSED')).toBe(true)
    expect(isAutomatedPause('automation:dayparting-delete', 'PAUSED')).toBe(true)
  })

  // The dangerous direction again: a person's Pause button must keep working.
  it('ALLOWS a person to pause', () => {
    expect(isAutomatedPause('user:anonymous', 'PAUSED')).toBe(false)
    expect(isAutomatedPause('user:awais', 'PAUSED')).toBe(false)
  })

  it('ALLOWS a rule to enable — enable_campaign and resume_campaign stay', () => {
    expect(isAutomatedPause('automation:cms450kg9002rqt019f1outpu', 'ENABLED')).toBe(false)
    expect(isAutomatedPause('automation:dayparting-delete', 'ENABLED')).toBe(false)
    expect(isAutomatedPause('automation:cms450kg9002rqt019f1outpu', undefined)).toBe(false)
  })

  it('matches the actor kind, not a substring', () => {
    expect(isAutomatedPause('user:automation:impersonator', 'PAUSED')).toBe(false)
  })
})

/** Drop `//` and block comments, so a comment can never satisfy — or trip — the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function codeOnly(relPath: string): string {
  return stripComments(readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8'))
}

/**
 * A campaign-status write is `updateCampaignWithSync(...)` whose argument object carries a `status`
 * key. Both jobs explain the removal in prose that names the function and the field, so a raw grep
 * would flag its own fix — the comments come out first.
 */
function campaignStatusWrites(code: string): string[] {
  const hits: string[] = []
  const re = /updateCampaignWithSync\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    // Walk to the matching close paren so we test the real argument list, not a fixed window.
    let depth = 0, i = m.index + m[0].length - 1
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) break
    }
    const args = code.slice(m.index, i + 1)
    if (/\bstatus\s*:/.test(args)) hits.push(args.replace(/\s+/g, ' ').slice(0, 120))
  }
  return hits
}

describe('SYNC.1 — the engine crons contain no campaign-status write', () => {
  it('ad-rank-defend.job.ts', () => {
    expect(campaignStatusWrites(codeOnly('./ad-rank-defend.job.ts'))).toEqual([])
  })

  it('ad-dayparting.job.ts', () => {
    expect(campaignStatusWrites(codeOnly('./ad-dayparting.job.ts'))).toEqual([])
  })

  // 2a (review 3.3) — switching a schedule off or deleting it gives bids back; neither path writes a campaign status.
  it('the schedule disable / delete paths and the release they call', () => {
    expect(campaignStatusWrites(codeOnly('../services/advertising/ads-schedule.service.ts'))).toEqual([])
    expect(campaignStatusWrites(codeOnly('../services/advertising/rank-release.service.ts'))).toEqual([])
  })

  // A guard that cannot fail proves nothing. This is the exact line deleted from ad-rank-defend.
  it('the scan CATCHES the deleted line if it comes back', () => {
    const regression = `
      if (ctx.write && camp.status === 'PAUSED') {
        await updateCampaignWithSync({ campaignId: camp.id, patch: { status: 'ENABLED' },
          actor: ctx.actor as AdsActor, reason: 'rank defend — resume', applyImmediately: true } as never)
      }`
    expect(campaignStatusWrites(regression)).toHaveLength(1)
  })

  it('the scan does NOT flag a budget write on the same function', () => {
    const budgetWrite = `await updateCampaignWithSync({ campaignId: id, patch: { dailyBudget: 12 }, actor })`
    expect(campaignStatusWrites(budgetWrite)).toEqual([])
  })

  // Both files now explain the removal in prose naming the function AND the field. Without the
  // comment strip the fix would fail its own ratchet — the trap that makes grep-shaped guards lie.
  it('a comment describing the removed write is not mistaken for the write', () => {
    const prose = `// updateCampaignWithSync({ patch: { status: 'ENABLED' } }) used to live here`
    expect(campaignStatusWrites(prose)).toHaveLength(1)      // raw text: a false positive
    expect(campaignStatusWrites(stripComments(prose))).toEqual([]) // stripped: clean
  })
})
