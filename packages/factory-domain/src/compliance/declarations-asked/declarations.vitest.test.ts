import { describe, expect, it } from 'vitest'
import { SUPPLIER_DECLARATIONS_ADDS, SUPPLIER_DECLARATIONS_MANAGE } from './permissions'
import { addDays, askProblems, lineAnswer, overdueDays, planAsk, reminderDue, requestOfSourceKey, shownStatus, taskLabelOf, taskSourceKey, type AskParty, type OpenRequest } from './rules'

/** B-W2b-256: declarations asked of suppliers (pure). Every id, code and answer is made up. */

const today = '2026-11-10'
const party = (over: Partial<AskParty> = {}): AskParty => ({ id: 'p-1', code: 'SUP-1', name: 'Tannery One', portalOn: true, refusal: null, ...over })
const material = (itemId: string, suppliers: { partyId: string; articleCode: string | null }[]) => ({ itemId, code: `MAT-${itemId}`, name: `Material ${itemId}`, suppliers })

describe('asking for declarations', () => {
  it('checks the kinds, the due day, the cadence and the channel (link not offered yet)', () => {
    expect(askProblems({ kinds: ['REACH_SVHC', 'NICKEL'], dueOn: '2026-12-01', reminderEveryDays: 7 }, today)).toEqual([])
    const problems = askProblems({ kinds: [], dueOn: '2026-11-09', reminderEveryDays: 0, channel: 'LINK' }, today)
    expect(problems.map((problem) => problem.path)).toEqual(['body/kinds', 'body/dueOn', 'body/reminderEveryDays', 'body/channel'])
    expect(askProblems({ kinds: ['RSL', 'RSL'], dueOn: addDays(today, 181) }, today).map((problem) => problem.path)).toEqual(['body/kinds/1', 'body/dueOn'])
  })

  it('makes one request per supplier and kind, adds to an open one that waits, skips an answered one, a portal that is off and no list version', () => {
    const parties = new Map([
      ['p-1', party()],
      ['p-2', party({ id: 'p-2', code: 'SUP-2', portalOn: false })],
      ['p-3', party({ id: 'p-3', code: 'SUP-3', refusal: 'SUP-3 is blocked: only an active supplier is asked.' })],
    ])
    const open: OpenRequest[] = [
      { requestId: 'r-1', number: 'SD-2026-0001', partyId: 'p-1', kind: 'NICKEL', status: 'SENT', svhcListVersionId: null, itemIds: ['a'], lines: 1 },
      { requestId: 'r-2', number: 'SD-2026-0002', partyId: 'p-2', kind: 'RSL', status: 'ANSWERED', svhcListVersionId: null, itemIds: ['a'], lines: 1 },
    ]
    const groups = planAsk({
      materials: [material('a', [{ partyId: 'p-1', articleCode: 'T-100' }, { partyId: 'p-2', articleCode: null }]), material('b', [{ partyId: 'p-1', articleCode: null }, { partyId: 'p-3', articleCode: null }])],
      parties,
      kinds: ['NICKEL', 'RSL'],
      open,
      channel: null,
      svhcListVersionId: 'v-2',
    })
    const by = (partyId: string, kind: string) => groups.find((group) => group.partyId === partyId && group.kind === kind)!
    expect(by('p-1', 'NICKEL')).toMatchObject({ outcome: 'ADD', openRequest: { number: 'SD-2026-0001' }, lines: [{ itemId: 'b' }] })
    expect(by('p-1', 'RSL')).toMatchObject({ outcome: 'SEND', channel: 'PORTAL', lines: [{ itemId: 'a', articleLabel: 'T-100 · Material a' }, { itemId: 'b', articleLabel: 'MAT-b · Material b' }] })
    expect(by('p-2', 'NICKEL')).toMatchObject({ outcome: 'SEND', channel: 'OFFICE' })
    expect(by('p-2', 'RSL')).toMatchObject({ outcome: 'SKIP', why: 'SUP-2 answered SD-2026-0002 already: decide it, then ask again.' })
    expect(by('p-3', 'RSL')).toMatchObject({ outcome: 'SKIP', why: 'SUP-3 is blocked: only an active supplier is asked.' })
    // The portal asked of a supplier whose portal is off; an SVHC declaration with no Candidate List version.
    const portal = planAsk({ materials: [material('a', [{ partyId: 'p-2', articleCode: null }])], parties, kinds: ['REACH_SVHC'], open: [], channel: 'PORTAL', svhcListVersionId: null })
    expect(portal[0]).toMatchObject({ outcome: 'SKIP', why: 'No Candidate List version is recorded: record the ECHA list it asks about first.' })
    const off = planAsk({ materials: [material('a', [{ partyId: 'p-2', articleCode: null }])], parties, kinds: ['PFAS'], open: [], channel: 'PORTAL', svhcListVersionId: null })
    expect(off[0]).toMatchObject({ outcome: 'SKIP', why: "SUP-2's portal is off: ask by e-mail (OFFICE), or switch its portal on first." })
  })

  it('an open SVHC request of an older Candidate List does not take the new materials', () => {
    const groups = planAsk({
      materials: [material('a', [{ partyId: 'p-1', articleCode: null }])],
      parties: new Map([['p-1', party()]]),
      kinds: ['REACH_SVHC'],
      open: [{ requestId: 'r-1', number: 'SD-2026-0001', partyId: 'p-1', kind: 'REACH_SVHC', status: 'SENT', svhcListVersionId: 'v-1', itemIds: [], lines: 1 }],
      channel: null,
      svhcListVersionId: 'v-2',
    })
    expect(groups[0]).toMatchObject({ outcome: 'SEND' })
  })

  it('names the partner task and its source key', () => {
    expect(taskSourceKey('r-1')).toBe('SupplierDeclaration:r-1')
    expect(requestOfSourceKey('SupplierDeclaration:r-1')).toBe('r-1')
    expect(requestOfSourceKey('Ask:r-1')).toBeNull()
    expect(taskLabelOf('SD-2026-0001', 'NICKEL', ['Z-1 · Zip', 'Z-2 · Snap'])).toBe('SD-2026-0001 · Nickel release · Z-1 · Zip; Z-2 · Snap')
    expect(taskLabelOf('SD-2026-0001', 'RSL', ['x'.repeat(300)])).toHaveLength(200)
  })
})

describe('the answer per material', () => {
  it('no or not yet: nothing more; yes: the substance, above the threshold, its concentration', () => {
    expect(lineAnswer({ contains: false }, 'RSL', 'body/lines/0')).toEqual({ answer: { contains: false, aboveThreshold: null, substanceId: null, substanceName: null, concentration: null, concentrationUnit: null, note: null }, problems: [] })
    expect(lineAnswer({ contains: false, substanceName: 'DEHP' }, 'RSL', 'body/lines/0').problems.map((problem) => problem.path)).toEqual(['body/lines/0/substanceId'])
    expect(lineAnswer({ contains: true }, 'RSL', 'at').problems.map((problem) => problem.path)).toEqual(['at/substanceName', 'at/aboveThreshold'])
    expect(lineAnswer({ contains: true, substanceName: 'Nickel', aboveThreshold: false, concentration: '0.1' }, 'NICKEL', 'at').problems.map((problem) => problem.path)).toEqual(['at/concentration'])
  })

  it('an SVHC in % w/w is above the threshold exactly when over 0.1 % (REACH art. 33)', () => {
    expect(lineAnswer({ contains: true, substanceName: 'DEHP', concentration: '0.15', concentrationUnit: 'PERCENT_WW' }, 'REACH_SVHC', 'at').answer.aboveThreshold).toBe(true)
    expect(lineAnswer({ contains: true, substanceName: 'DEHP', concentration: '0.1', concentrationUnit: 'PERCENT_WW' }, 'REACH_SVHC', 'at').answer.aboveThreshold).toBe(false)
    expect(lineAnswer({ contains: true, substanceName: 'DEHP', concentration: '0.15', concentrationUnit: 'PERCENT_WW', aboveThreshold: false }, 'REACH_SVHC', 'at').problems[0]?.message).toBe('0.15 % w/w is over the 0.1 % threshold of REACH art. 33.')
  })
})

describe('reminders and the shown status', () => {
  const sentAt = new Date('2026-11-01T09:00:00Z')
  it('a reminder is due every N days from the last one or from when it went out, only while it waits', () => {
    expect(reminderDue({ status: 'SENT', reminderEveryDays: 7, sentAt, lastRemindedAt: null }, new Date('2026-11-08T08:59:59Z'))).toBe(false)
    expect(reminderDue({ status: 'SENT', reminderEveryDays: 7, sentAt, lastRemindedAt: null }, new Date('2026-11-08T09:00:00Z'))).toBe(true)
    expect(reminderDue({ status: 'OVERDUE', reminderEveryDays: 7, sentAt, lastRemindedAt: new Date('2026-11-08T09:00:00Z') }, new Date('2026-11-10T09:00:00Z'))).toBe(false)
    expect(reminderDue({ status: 'ANSWERED', reminderEveryDays: 1, sentAt, lastRemindedAt: null }, new Date('2026-11-10T09:00:00Z'))).toBe(false)
    expect(reminderDue({ status: 'SENT', reminderEveryDays: null, sentAt, lastRemindedAt: null }, new Date('2026-12-10T09:00:00Z'))).toBe(false)
  })

  it('says expired, re-request needed (the Candidate List grew) or accepted', () => {
    const accepted = { status: 'ACCEPTED', kind: 'REACH_SVHC', validTo: null, svhcListVersionId: 'v-1', answeredListVersionId: 'v-1' }
    expect(shownStatus(accepted, 'v-1', today)).toBe('ACCEPTED')
    expect(shownStatus(accepted, 'v-2', today)).toBe('REREQUEST_NEEDED')
    expect(shownStatus({ ...accepted, kind: 'NICKEL', svhcListVersionId: null, answeredListVersionId: null, validTo: '2026-11-09' }, 'v-2', today)).toBe('EXPIRED')
    expect(shownStatus({ ...accepted, status: 'REFUSED' }, 'v-2', today)).toBe('REJECTED')
    expect(shownStatus({ ...accepted, status: 'SENT' }, 'v-2', today)).toBe('REQUESTED')
    expect(overdueDays('2026-11-05', today)).toBe(5)
    expect(overdueDays('2026-11-15', today)).toBe(0)
  })

  it('the quality inspector asks and decides', () => {
    expect(SUPPLIER_DECLARATIONS_MANAGE).toBe('compliance.supplierDeclarations.manage')
    expect(SUPPLIER_DECLARATIONS_ADDS).toEqual({ quality_inspector: ['compliance.supplierDeclarations.manage'] })
  })
})
