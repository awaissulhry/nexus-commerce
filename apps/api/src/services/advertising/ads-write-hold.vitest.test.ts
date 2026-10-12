/**
 * Owner decided 2026-10-12 — an Amazon ad write a PERSON approved goes to Amazon at once; every automatic write keeps
 * the 5-minute cancel window. Pure checks of the one decision (ads-mutation.service.ts holdUntilFor and
 * isPersonApprovedWrite) and of the words that say it (ads-change-kit.ts queuedNote, approval.tools.ts adMeaning).
 * The whole path through the approval door is checked on PGlite in approval.tools.vitest.test.ts. Ids are made up.
 */
import { describe, expect, it } from 'vitest'
// The registry first, as the door loads it: approval.tools.ts alone would start the registry's import cycle midway.
import '../agents/tool-registry.js'
import { holdUntilFor, isPersonApprovedWrite } from './ads-mutation.service.js'
import { runAsPersonApproved, runAsRuleApproved } from '../agents/tool-types.js'
import { queuedNote } from '../agents/tools/ads-change-kit.js'
import { adMeaning } from '../agents/tools/approval.tools.js'

const NOW = new Date('2026-01-05T10:00:00.000Z')
const FIVE_MIN = 5 * 60 * 1000

describe('holdUntilFor — when a queued ad write may leave for Amazon', () => {
  it('a write a person approved: now (the drain sends it on its next tick)', () => {
    expect(holdUntilFor({ applyImmediately: false, personApproved: true }, NOW)).toEqual(NOW)
  })

  it('an automatic write: now + 5 minutes, as before', () => {
    expect(holdUntilFor({ applyImmediately: false, personApproved: false }, NOW).getTime()).toBe(NOW.getTime() + FIVE_MIN)
  })

  it('a caller that sends at once still does, whoever wrote it', () => {
    expect(holdUntilFor({ applyImmediately: true, personApproved: false }, NOW)).toEqual(NOW)
    expect(holdUntilFor({ applyImmediately: true, personApproved: true }, NOW)).toEqual(NOW)
  })
})

describe('isPersonApprovedWrite — whose write it is', () => {
  it('his own write inside a run a person approved', async () => {
    expect(await runAsPersonApproved(async () => isPersonApprovedWrite(true, 'user:u-approver-1'))).toBe(true)
  })

  it('an engine or a rule writing inside that run is not his: it keeps the window', async () => {
    expect(await runAsPersonApproved(async () => isPersonApprovedWrite(false, 'automation:test-engine'))).toBe(false)
    expect(await runAsPersonApproved(async () => isPersonApprovedWrite(true, 'automation:test-rule'))).toBe(false)
    expect(await runAsPersonApproved(async () => isPersonApprovedWrite(false, 'user:u-approver-1'))).toBe(false)
  })

  it('a run the business\'s rule approved keeps the window, even nested in a person\'s', async () => {
    expect(await runAsRuleApproved(async () => isPersonApprovedWrite(true, 'user:u-asker-1'))).toBe(false)
    expect(await runAsPersonApproved(() => runAsRuleApproved(async () => isPersonApprovedWrite(true, 'user:u-asker-1')))).toBe(false)
  })

  it('a write with no approval keeps the window, even a person\'s own mark', () => {
    expect(isPersonApprovedWrite(true, 'user:u-person-1')).toBe(false)
    expect(isPersonApprovedWrite(false, 'automation:test-engine')).toBe(false)
  })

  it('the mark ends with the run', async () => {
    await runAsPersonApproved(async () => undefined)
    expect(isPersonApprovedWrite(true, 'user:u-approver-1')).toBe(false)
  })
})

describe('the words say the same', () => {
  it('a run\'s result: at once for a person\'s approval, after the window for a run by rule', () => {
    expect(queuedNote({ manual: true }, 'each bid')).toBe(
      'Queued for Amazon: each bid is sent at once (within a minute), with no cancel window — a person approved it. approval-status follows them.',
    )
    expect(queuedNote({ manual: false }, 'it', 'it')).toBe(
      'Queued for Amazon: it is sent after the 5-minute cancel window — the business\'s rule ran it. approval-status follows it.',
    )
  })

  it('approval-status: a waiting write says when it goes, by who decided', () => {
    const waiting = { reach: 'live' as const, writes: 2, waiting: 2, sent: 0, refusedByGate: 0, failed: 0, notSent: 0 }
    expect(adMeaning(waiting)).toBe(
      'Approved and written in Nexus. Amazon: 2 waiting to be sent (a person approved it, so it goes within a minute, with no cancel window) (of 2 writes).',
    )
    expect(adMeaning(waiting, { byRule: true })).toBe(
      'Approved and written in Nexus. Amazon: 2 waiting to be sent (run by the business\'s rule, a write waits out a 5-minute cancel window) (of 2 writes).',
    )
  })
})
