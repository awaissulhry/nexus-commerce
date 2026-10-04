import { describe, expect, it } from 'vitest'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import { validateImpact } from '@/design-system/grid/actions/registry'
import { bidText, giveBackImpact, giveBackOutcome, liveOrphanHeadline, liveOrphanLine, liveOrphanRows, liveOrphanWhy, type LiveOrphan } from './liveOrphans'

/** Owner 2026-10-04 — the live campaigns rank left bids changed on, in the words the banner, dialog and confirm show. */
const orphan = (o: Partial<LiveOrphan> = {}): LiveOrphan => ({
  campaignId: 'c1', name: 'IT GALE exact', marketplace: 'IT',
  reasons: ['stranded bid floor set by a rank schedule since 2026-09-20', 'leftover base-bid change on 1 bid'],
  floor: { by: 'automation:rank-defend-s1', byWords: 'a rank schedule', since: '2026-09-20T03:00:00.000Z', floorCents: 2 },
  deltaBids: 1, adGroups: 1, targets: 2,
  bids: [
    { kind: 'ad-group', id: 'g', label: 'GALE', adGroup: 'GALE', currentCents: 2, backCents: 40 },
    { kind: 'target', id: 't0', label: 'gale jacket (exact)', adGroup: 'GALE', currentCents: 2, backCents: 35 },
    { kind: 'target', id: 't1', label: 'B0TEST1234', adGroup: 'GALE', currentCents: 2, backCents: 150 },
  ],
  ...o,
})

describe('live orphans — the banner and the dialog', () => {
  it('the banner counts them and says why nothing gives them back by itself', () => {
    expect(liveOrphanHeadline(3)).toBe('3 live campaigns still carry bids rank changed.')
    expect(liveOrphanHeadline(1)).toBe('1 live campaign still carries bids rank changed.')
    expect(liveOrphanWhy(1)).toBe('No rank schedule or plan holds it any more, and the rank loop never changes a live campaign by itself. Review it and give the bids back one campaign at a time.')
  })

  it('under the name: the market and why it is listed', () => {
    expect(liveOrphanLine(orphan())).toBe('IT · Stranded bid floor set by a rank schedule since 2026-09-20 · Leftover base-bid change on 1 bid')
    expect(liveOrphanLine(orphan({ marketplace: null, reasons: ['leftover base-bid change on 2 bids'] }))).toBe('No market · Leftover base-bid change on 2 bids')
  })

  it('the short table: bid now and the bid it goes back to, then how many more', () => {
    expect(bidText(2)).toBe('0.02')
    expect(bidText(150)).toBe('1.50')
    expect(liveOrphanRows(orphan(), 2)).toEqual([
      { id: 'g', cells: ['GALE (ad group default bid)', '0.02', '0.40'] },
      { id: 't0', cells: ['gale jacket (exact) · GALE', '0.02', '0.35'] },
      { id: 'more', cells: ['and 1 more bid, every one shown before it changes', '', ''] },
    ])
    expect(liveOrphanRows(orphan())).toHaveLength(3)
  })
})

describe('live orphans — the confirmation', () => {
  it('lists every bid and asks for an acknowledgement; the design system accepts it', () => {
    const impact = giveBackImpact(orphan(), null)
    expect(validateImpact(impact)).toEqual([])
    expect(impact.title).toBe('Give back the bids on IT GALE exact?')
    expect(impact.consequences?.[0]).toBe('3 bids on this live campaign change on Amazon now (1 ad group default bid, 2 targets), to the values in the table below.')
    expect(impact.review?.rows).toEqual([
      { label: 'GALE (ad group default bid)', before: '0.02', after: '0.40' },
      { label: 'gale jacket (exact) · GALE', before: '0.02', after: '0.35' },
      { label: 'B0TEST1234 · GALE', before: '0.02', after: '1.50' },
    ])
    expect(canConfirmAction(impact, '', false)).toBe(false)
    expect(canConfirmAction(impact, '', true)).toBe(true)
  })

  it('while a give-back would wait, it says why and cannot be confirmed', () => {
    const impact = giveBackImpact(orphan(), 'ads automation is stopped (halted: spend spike)')
    expect(validateImpact(impact)).toEqual([])
    expect(impact.unavailable).toBe('Nothing can be given back right now because ads automation is stopped (halted: spend spike). Try again once that changes.')
    expect(canConfirmAction(impact, '', true)).toBe(false)
  })

  it('after the click: what came back, what did not, and what waits', () => {
    const r = { campaignId: 'c1', name: 'IT GALE exact', writes: 3, deferredWhy: null }
    expect(giveBackOutcome({ ...r, outcome: 'restored' })).toEqual({ tone: 'success', text: 'Gave back 3 bids on IT GALE exact.' })
    expect(giveBackOutcome({ ...r, outcome: 'failed', writes: 1 }).text).toBe('Gave back 1 bid on IT GALE exact, but not every one: the rest stay as they are and the campaign stays on this list, so try again.')
    expect(giveBackOutcome({ ...r, outcome: 'deferred', writes: 0, deferredWhy: 'Rank & Dayparting is switched off for this business' }))
      .toEqual({ tone: 'warning', text: 'Nothing changed on IT GALE exact: the give-back waits because Rank & Dayparting is switched off for this business. Try again once that changes.' })
  })
})
