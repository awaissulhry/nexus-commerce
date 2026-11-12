import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { ageingOf, bucketOf, layersOf, lineDaysOut } from './ageing'
import { adjustmentProblems, declarationProblems, lineBalanceOf, movesOf, shareBackOf, suggestionOf, sumsOf, unscrapPlan, type LineFacts } from './balance'
import { backTotal, bundleBackProblems, bundleStateOf } from './bundles'
import { bookablePieces, bookedPiecesOf, bookProblems, bridgeOf, entryAmount, reverseProblems, type EntryFacts } from './cost'
import { SUBCONTRACT_DEPTH_PERMISSIONS } from './permissions'
import { coversUntil, daysBetween, expiresInDays, inForceOn, nextRevision, signProblems, terminateProblems, termsWords, type AgreementFacts } from './terms'

const at = (iso: string) => new Date(iso)

describe('the written terms (SCM-049)', () => {
  const rev1: AgreementFacts = { id: 'a1', revision: 1, status: 'SUPERSEDED', title: 'Terms 2026', validFrom: '2026-01-01', validUntil: '2026-12-31', signedAt: at('2026-01-10T10:00:00Z'), endedAt: at('2026-11-04T10:00:00Z'), termsFileId: 'f1' }
  const rev2: AgreementFacts = { id: 'a2', revision: 2, status: 'SIGNED', title: 'Terms 2026-2027', validFrom: '2026-11-04', validUntil: null, signedAt: at('2026-11-04T10:00:00Z'), endedAt: null, termsFileId: 'f2' }
  const draft: AgreementFacts = { id: 'a3', revision: 3, status: 'DRAFT', title: 'Terms 2027', validFrom: '2027-01-01', validUntil: null, signedAt: null, endedAt: null, termsFileId: null }

  it('links an order to the revision that covered its date: the superseded one before its end, the newer one from the day it ended', () => {
    expect(inForceOn([rev1, rev2, draft], '2026-06-01')?.id).toBe('a1')
    expect(inForceOn([rev1, rev2, draft], '2026-11-04')?.id).toBe('a2')
    expect(inForceOn([rev1, rev2, draft], '2027-03-01')?.id).toBe('a2')
    expect(inForceOn([draft], '2027-03-01')).toBeNull()
    expect(inForceOn([rev1], '2025-12-31')).toBeNull()
    // A revision signed in advance: the one it superseded stays in force until the day before it starts.
    const later: AgreementFacts = { ...draft, status: 'SIGNED', signedAt: at('2026-11-12T10:00:00Z') }
    const replaced: AgreementFacts = { ...rev2, status: 'SUPERSEDED', endedAt: at('2026-11-12T10:00:00Z') }
    expect(inForceOn([rev1, replaced, later], '2026-11-12')?.id).toBe('a2')
    expect(inForceOn([rev1, replaced, later], '2026-12-31')?.id).toBe('a2')
    expect(inForceOn([rev1, replaced, later], '2027-01-01')?.id).toBe('a3')
    expect(coversUntil(replaced, [rev1, replaced, later])).toBe('2026-12-31')
    // Ended on a day: that day is no longer covered.
    expect(inForceOn([{ ...rev2, status: 'TERMINATED', endedAt: at('2026-11-20T10:00:00Z') }], '2026-11-20')).toBeNull()
    expect(inForceOn([{ ...rev2, status: 'TERMINATED', endedAt: at('2026-11-20T10:00:00Z') }], '2026-11-19')?.id).toBe('a2')
  })

  it('says in words why an order has no written terms, naming the law', () => {
    expect(termsWords([rev1, rev2], '2026-06-01', 'Workshop P2')).toBeNull()
    expect(termsWords([], '2026-06-01', 'Workshop P2')).toContain('L. 192/1998 art. 2')
    expect(termsWords([draft], '2026-06-01', 'Workshop P2')).toContain('Revision 3 is written and waits for its signature')
    expect(termsWords([rev1], '2027-02-01', 'Workshop P2')).toContain('cover other days')
  })

  it('numbers the next revision, counts days and flags terms that expire within 30 days', () => {
    expect(nextRevision([rev1, rev2, draft])).toBe(4)
    expect(nextRevision([])).toBe(1)
    expect(daysBetween('2026-11-30', '2026-12-31')).toBe(31)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(expiresInDays({ ...rev2, validUntil: '2026-12-01' }, '2026-11-12')).toBe(19)
    expect(expiresInDays({ ...rev2, validUntil: '2027-06-01' }, '2026-11-12')).toBeNull()
    expect(expiresInDays(rev2, '2026-11-12')).toBeNull()
  })

  it('signs only a draft, with an available file of the revision or of its workshop, not in the future', () => {
    const now = at('2026-11-12T10:00:00Z')
    const facts = { companyId: 'c', partyId: 'p', file: { status: 'AVAILABLE', companyId: 'c', recordType: 'SubcontractAgreement', recordId: 'a3' } }
    expect(signProblems(draft, at('2026-11-12T09:00:00Z'), facts, now)).toEqual([])
    expect(signProblems(draft, at('2026-11-12T09:00:00Z'), { ...facts, file: { ...facts.file, recordType: 'Party', recordId: 'p' } }, now)).toEqual([])
    expect(signProblems(rev2, now, facts, now)[0]!.message).toContain('fixed')
    expect(signProblems(draft, at('2026-11-13T09:00:00Z'), facts, now).map((p) => p.path)).toEqual(['body/signedAt'])
    expect(signProblems(draft, now, { ...facts, file: null }, now).map((p) => p.path)).toEqual(['body/termsFileId'])
    expect(signProblems(draft, now, { ...facts, file: { ...facts.file, status: 'PENDING' } }, now)[0]!.message).toContain('upload')
    expect(signProblems(draft, now, { ...facts, file: { ...facts.file, recordId: 'other' } }, now)[0]!.message).toContain('file of this revision or of its workshop')
    expect(signProblems(draft, now, { ...facts, file: { ...facts.file, companyId: 'other' } }, now)[0]!.message).toContain('another company')
  })

  it('ends only the signed revision, with why, after its signature and not in the future', () => {
    const now = at('2026-11-12T10:00:00Z')
    expect(terminateProblems(rev2, now, 'The workshop closed.', now)).toEqual([])
    expect(terminateProblems(rev1, now, 'x', now)[0]!.message).toContain('only the signed revision')
    expect(terminateProblems(rev2, now, '  ', now).map((p) => p.path)).toEqual(['body/reason'])
    expect(terminateProblems(rev2, at('2026-11-01T00:00:00Z'), 'why', now).map((p) => p.path)).toEqual(['body/endedAt'])
  })
})

describe('the material balance per job (SCM-144, SCM-143, TZ1:01)', () => {
  const line = (rows: LineFacts['rows'], extra: Partial<LineFacts> = {}): LineFacts => ({ sent: '12.6000', uom: 'M', checked: null, back: '0.0000', rows, ...extra })
  const declared = { kind: 'DECLARED' as const, used: '9.0000', returned: '2.0000', scrapped: '0.5000' }

  it('reads sent = used + returned + scrapped + open, with the workshop’s kit check and what came back', () => {
    const balance = lineBalanceOf(line([declared], { checked: '12.4000', back: '2.0000' }), { allBack: true, someBack: true })
    expect(balance).toMatchObject({ sent: '12.6000', used: '9.0000', returned: '2.0000', scrapped: '0.5000', open: '1.1000', short: '-0.2000' })
    expect(balance.flags.map((flag) => flag.flag)).toEqual(['SHORT_AT_WORKSHOP', 'OPEN_AFTER_BACK'])
    expect(balance.flags[1]!.words).toContain('1.1000 M is still out')
  })

  it('flags goods back without a declaration, and returns declared but not back (or back but not declared)', () => {
    expect(lineBalanceOf(line([]), { allBack: false, someBack: true }).flags.map((flag) => flag.flag)).toEqual(['NOT_DECLARED'])
    expect(lineBalanceOf(line([declared], { back: '1.0000' }), { allBack: false, someBack: true }).flags.map((flag) => flag.flag)).toEqual(['RETURN_NOT_BACK'])
    expect(lineBalanceOf(line([declared], { back: '3.0000' }), { allBack: false, someBack: true }).flags.map((flag) => flag.flag)).toEqual(['BACK_NOT_DECLARED'])
    expect(lineBalanceOf(line([]), { allBack: false, someBack: false }).flags).toEqual([])
  })

  it('sums adjustments signed', () => {
    const sums = sumsOf([declared, { kind: 'ADJUSTMENT', used: '-0.1000', returned: '0', scrapped: '0.1000' }])
    expect([sums.used.toFixed(4), sums.returned.toFixed(4), sums.scrapped.toFixed(4)]).toEqual(['8.9000', '2.0000', '0.6000'])
  })

  it('refuses a declaration that is empty, negative or more than is open', () => {
    expect(declarationProblems('body/lines/0', line([]), { used: '10', returned: '2', scrapped: '0.6' })).toEqual([])
    expect(declarationProblems('body/lines/0', line([]), { used: '0', returned: '0', scrapped: '0' }).map((p) => p.path)).toEqual(['body/lines/0/used'])
    expect(declarationProblems('body/lines/0', line([]), { used: '-1', returned: '0', scrapped: '1' }).map((p) => p.path)).toEqual(['body/lines/0/used'])
    expect(declarationProblems('body/lines/0', line([declared]), { used: '2', returned: '0', scrapped: '0' })[0]!.message).toContain('Only 1.1000 M')
    expect(declarationProblems('body/lines/0', line([]), { used: '1', returned: '0', scrapped: '0', reasonCode: 'STAIN' }).map((p) => p.path)).toEqual(['body/lines/0/reason'])
  })

  it('takes an adjustment only after a declaration, with its reason, within what was sent and never below 0', () => {
    expect(adjustmentProblems('body', line([declared]), { used: '-0.1', returned: '0', scrapped: '0.1', reason: 'Re-cut a sleeve' })).toEqual([])
    expect(adjustmentProblems('body', line([]), { used: '0.1', returned: '0', scrapped: '0', reason: 'More used' }).map((p) => p.path)).toEqual(['body/kitLineId'])
    expect(adjustmentProblems('body', line([declared]), { used: '0.1', returned: '0', scrapped: '0' }).map((p) => p.path)).toEqual(['body/reason'])
    expect(adjustmentProblems('body', line([declared]), { used: '0', returned: '0', scrapped: '0', reason: 'x' }).map((p) => p.path)).toEqual(['body/used'])
    expect(adjustmentProblems('body', line([declared]), { used: '-9.5', returned: '0', scrapped: '0', reason: 'x' })[0]!.message).toContain('below 0')
    expect(adjustmentProblems('body', line([declared]), { used: '1.2', returned: '0', scrapped: '0', reason: 'x' })[0]!.message).toContain('would pass the 12.6000 M sent')
  })

  it('books stock where the material went: issue for more used, back from the work order for less, scrap and its taking back', () => {
    expect(movesOf({ used: '9', scrapped: '0.5' })).toEqual({ issue: '9.0000', giveBack: '0.0000', scrap: '0.5000', unscrap: '0.0000' })
    expect(movesOf({ used: '-0.1', scrapped: '0.1' })).toEqual({ issue: '0.0000', giveBack: '0.1000', scrap: '0.1000', unscrap: '0.0000' })
    expect(movesOf({ used: '0.2', scrapped: '-0.2' })).toEqual({ issue: '0.2000', giveBack: '0.0000', scrap: '0.0000', unscrap: '0.2000' })
    const standing = [
      { id: 's1', quantity: '0.5000' },
      { id: 's2', quantity: '0.1000' },
    ]
    expect(unscrapPlan(standing, '0.1')).toEqual({ reverse: ['s2'], scrapAgain: '0.0000' })
    expect(unscrapPlan(standing, '0.3')).toEqual({ reverse: ['s2', 's1'], scrapAgain: '0.3000' })
    expect(unscrapPlan(standing, '0.7')).toBeNull()
  })

  it('suggests the declaration from the pieces back and the material that came back', () => {
    const share = shareBackOf([{ piecesSent: 7, piecesBackGood: 6, piecesBackDefective: 1, piecesScrapped: 0 }])
    expect(share.toFixed(4)).toBe('1.0000')
    expect(suggestionOf({ line: line([], { back: '2.0000' }), shareBack: share })).toEqual({ used: '10.6000', returned: '2.0000', scrapped: '0.0000' })
    const half = shareBackOf([{ piecesSent: 4, piecesBackGood: 2, piecesBackDefective: 0, piecesScrapped: 0 }, { piecesSent: 4, piecesBackGood: 4, piecesBackDefective: 0, piecesScrapped: 0 }])
    expect(suggestionOf({ line: line([]), shareBack: half })).toEqual({ used: '6.3000', returned: '0.0000', scrapped: '0.0000' })
    expect(suggestionOf({ line: line([declared], { back: '2.0000' }), shareBack: share })).toEqual({ used: '1.1000', returned: '0.0000', scrapped: '0.0000' })
  })
})

describe('partial returns by bundle (SCM-145)', () => {
  it('reads a bundle out, partly back or back over every operation it goes through', () => {
    expect(bundleStateOf(5, [])).toBe('OUT')
    expect(bundleStateOf(5, [{ good: 0, defective: 0, scrapped: 0 }])).toBe('OUT')
    expect(bundleStateOf(5, [{ good: 3, defective: 1, scrapped: 0 }])).toBe('PARTLY_BACK')
    expect(bundleStateOf(5, [{ good: 4, defective: 0, scrapped: 1 }, { good: 2, defective: 0, scrapped: 0 }])).toBe('PARTLY_BACK')
    expect(bundleStateOf(5, [{ good: 4, defective: 0, scrapped: 1 }])).toBe('BACK')
    expect(backTotal({ good: 1, defective: 2, scrapped: 3 })).toBe(6)
  })

  it('refuses a bundle the order never sent (once its bundles are on record) and more back than it carried', () => {
    const bundle = { code: 'BN-1', garments: 4 }
    expect(bundleBackProblems('body/lines/0', bundle, { onRecord: true, sent: true, earlier: 1, now: 3, operationSeq: 10 })).toEqual([])
    expect(bundleBackProblems('body/lines/0', bundle, { onRecord: true, sent: false, earlier: 0, now: 1, operationSeq: 10 })[0]!.path).toBe('body/lines/0/bundleId')
    expect(bundleBackProblems('body/lines/0', bundle, { onRecord: false, sent: false, earlier: 0, now: 1, operationSeq: 10 })).toEqual([])
    const over = bundleBackProblems('body/lines/0', bundle, { onRecord: true, sent: true, earlier: 3, now: 2, operationSeq: 10 })
    expect(over[0]).toMatchObject({ path: 'body/lines/0/good' })
    expect(over[0]!.message).toContain('at most 1 more')
  })
})

describe('the cost on the work order (SCM-146)', () => {
  const entries: EntryFacts[] = [
    { id: 'e1', kind: 'FEE', subcontractOperationId: 'op1', quantity: '3.0000', amount: 1350, reversalOfId: null },
    { id: 'e2', kind: 'FEE', subcontractOperationId: 'op1', quantity: '1.0000', amount: 450, reversalOfId: null },
    { id: 'e3', kind: 'FEE', subcontractOperationId: 'op1', quantity: '1.0000', amount: -450, reversalOfId: 'e2' },
    { id: 'e4', kind: 'TRANSPORT', subcontractOperationId: null, quantity: '1.0000', amount: 3500, reversalOfId: null },
  ]

  it('rounds quantity × price once, counts the pieces FEE entries book and what is still bookable', () => {
    expect(entryAmount('120', '4.50', 'EUR')).toBe(54_000)
    expect(entryAmount('1.5', '0.333333', 'EUR')).toBe(50)
    expect(bookedPiecesOf(entries)).toEqual(new Map([['op1', 3]]))
    expect(bookablePieces({ piecesBackGood: 6, held: 1, booked: 3 })).toBe(2)
    expect(bookablePieces({ piecesBackGood: 2, held: 1, booked: 3 })).toBe(0)
  })

  it('books a fee only for whole pieces back good not booked yet, another charge without an operation, OTHER with words', () => {
    const facts = { status: 'RECEIVED' as const, now: at('2026-11-12T10:00:00Z'), operations: [{ id: 'op1', seq: 10, bookable: 2 }] }
    const base = { quantity: '1', unitPrice: '4.50', occurredAt: at('2026-11-12T09:00:00Z') }
    expect(bookProblems({ ...base, kind: 'FEE', subcontractOperationId: 'op1', quantity: '2' }, facts)).toEqual([])
    expect(bookProblems({ ...base, kind: 'FEE', subcontractOperationId: 'op1', quantity: '3' }, facts)[0]!.message).toContain('2 piece(s) back good')
    expect(bookProblems({ ...base, kind: 'FEE', subcontractOperationId: 'op1', quantity: '1.5' }, facts)[0]!.message).toContain('whole pieces')
    expect(bookProblems({ ...base, kind: 'FEE' }, facts).map((p) => p.path)).toEqual(['body/subcontractOperationId'])
    expect(bookProblems({ ...base, kind: 'TRANSPORT', subcontractOperationId: 'op1' }, facts).map((p) => p.path)).toEqual(['body/subcontractOperationId'])
    expect(bookProblems({ ...base, kind: 'OTHER' }, facts).map((p) => p.path)).toEqual(['body/reason'])
    expect(bookProblems({ ...base, kind: 'TRANSPORT', quantity: '0' }, facts).map((p) => p.path)).toEqual(['body/quantity'])
    expect(bookProblems({ ...base, kind: 'TRANSPORT', unitPrice: '-1' }, facts).map((p) => p.path)).toEqual(['body/unitPrice'])
    expect(bookProblems({ ...base, kind: 'TRANSPORT', occurredAt: at('2026-11-13T09:00:00Z') }, facts).map((p) => p.path)).toEqual(['body/occurredAt'])
    expect(bookProblems({ ...base, kind: 'TRANSPORT' }, { ...facts, status: 'DRAFT' })[0]!.message).toContain('costs nothing')
  })

  it('takes an entry back once, never a reversal, always with why', () => {
    const reversed = new Set(['e2'])
    expect(reverseProblems(entries[0]!, reversed, 'Charged twice')).toEqual([])
    expect(reverseProblems(entries[1]!, reversed, 'x')[0]!.message).toContain('already')
    expect(reverseProblems(entries[2]!, reversed, 'x')[0]!.message).toContain('not taken back in turn')
    expect(reverseProblems(null, reversed, 'x')[0]!.path).toBe('params/entryId')
    expect(reverseProblems(entries[0]!, reversed, ' ')[0]!.path).toBe('body/reason')
  })

  it('bridges the earned fee and the charges to the whole cost', () => {
    expect(bridgeOf(2700, entries)).toEqual({ earnedFee: 2700, fee: 1350, transport: 3500, material: 0, other: 0, sum: 7550 })
  })
})

describe('days out at the workshop (SCM-150)', () => {
  it('leaves the newest layers after the moves out took the oldest first', () => {
    const layers = layersOf(
      [
        { at: at('2026-09-01T08:00:00Z'), quantity: '10' },
        { at: at('2026-10-20T08:00:00Z'), quantity: '5' },
        { at: at('2026-11-10T08:00:00Z'), quantity: '2' },
      ],
      '12',
    )
    expect(layers.map((layer) => [layer.since.toISOString().slice(0, 10), layer.quantity.toFixed(4)])).toEqual([
      ['2026-10-20', '3.0000'],
      ['2026-11-10', '2.0000'],
    ])
    expect(layersOf([{ at: at('2026-09-01T08:00:00Z'), quantity: '10' }], '10')).toEqual([])
  })

  it('buckets the layers and gives the oldest one’s days out', () => {
    const ageing = ageingOf(
      [
        { since: at('2026-07-01T08:00:00Z'), quantity: layersOf([{ at: at('2026-07-01T08:00:00Z'), quantity: '4' }], '0')[0]!.quantity },
        { since: at('2026-11-01T08:00:00Z'), quantity: layersOf([{ at: at('2026-11-01T08:00:00Z'), quantity: '1.5' }], '0')[0]!.quantity },
      ],
      '2026-11-12',
    )
    expect(ageing).toEqual({ since: '2026-07-01', daysOut: 134, buckets: { upTo30: '1.5000', upTo60: '0.0000', upTo90: '0.0000', over90: '4.0000' }, longOut: true })
    expect(ageingOf([], '2026-11-12')).toEqual({ since: null, daysOut: null, buckets: { upTo30: '0.0000', upTo60: '0.0000', upTo90: '0.0000', over90: '0.0000' }, longOut: false })
    expect([bucketOf(0), bucketOf(30), bucketOf(31), bucketOf(61), bucketOf(91)]).toEqual(['upTo30', 'upTo30', 'upTo60', 'upTo90', 'over90'])
    expect(lineDaysOut(at('2026-11-02T08:00:00Z'), '0.5000', '2026-11-12')).toBe(10)
    expect(lineDaysOut(at('2026-11-02T08:00:00Z'), '0.0000', '2026-11-12')).toBeNull()
  })
})

describe('the catalogues', () => {
  it('declares the three permissions and gives them to the buyer (all) and the warehouse (the balance)', () => {
    for (const name of SUBCONTRACT_DEPTH_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    const of = (key: string) => templateOf(key)!.permissions
    expect(of('buyer')).toEqual(expect.arrayContaining(['purchasing.subcontract.terms', 'purchasing.subcontract.balance', 'purchasing.subcontract.cost']))
    expect(of('warehouse')).toContain('purchasing.subcontract.balance')
    expect(of('warehouse')).not.toContain('purchasing.subcontract.cost')
    expect(of('planner')).not.toContain('purchasing.subcontract.balance')
  })

  it('declares the three events, none with money', () => {
    for (const type of ['subcontract_agreement.changed', 'subcontract_order.balance_booked', 'subcontract_order.cost_booked']) expect(EVENT_CATALOGUE.get(type, 1)).toBeDefined()
  })
})
