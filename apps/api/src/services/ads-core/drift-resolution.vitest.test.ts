/**
 * S2 (2026-09-26) — when the structural reconcile may close a drift row: the rules as a matrix.
 *
 * A row closes only on evidence from a clean run: the entity was compared, the row's field was compared (both
 * sides read), and no difference was observed for that key. Measured on production: no child-entity row had
 * ever closed, because the old pass selected only CAMPAIGN rows — 242 rows that agree again sat open for weeks —
 * while the same pass closed CAMPAIGN rows for fields it never compares.
 *
 * Entity results come from the real `verifyEntity`, so the shapes are the ones the reconcile sees.
 */
import { describe, expect, it } from 'vitest'
import { verifyEntity, type EntityPair, type LaunchEntityResult } from './launch-verify.js'
import { assessEntities, emptyEvidence, neverSent, rowsToClose, type OpenDriftRow } from './drift-resolution.js'

const keyword = (id: string, over: Partial<EntityPair> = {}) => verifyEntity({
  entityType: 'KEYWORD', localId: id, externalId: `${id}-ext`, label: id,
  intended: { keywordText: 'boots', matchType: 'EXACT', state: 'ENABLED', bid: 0.5 },
  observed: { keywordText: 'boots', matchType: 'EXACT', state: 'enabled', bid: 0.5 },
  ...over,
})
const campaign = (id: string, over: Partial<EntityPair> = {}) => verifyEntity({
  entityType: 'CAMPAIGN', localId: id, externalId: `${id}-ext`, label: id,
  intended: { name: 'Boots', state: 'ENABLED', dailyBudget: 10 },
  observed: { name: 'Boots', state: 'enabled', dailyBudget: 10 },
  ...over,
}, ['portfolioId'])
const row = (entityId: string, field: string, entityType = 'AD_TARGET'): OpenDriftRow => ({ id: `${entityType}:${entityId}:${field}`, entityType, entityId, field })

/** One clean (or not) run over these results: what it records, and which of `open` it closes. */
function run(entities: LaunchEntityResult[], open: OpenDriftRow[], runOk = true) {
  const evidence = emptyEvidence()
  const assessed = assessEntities(entities, evidence)
  return { ...assessed, evidence, closed: rowsToClose(runOk, evidence, open) }
}

describe('S2 — a drift row closes only on evidence', () => {
  it('a child row closes when its field was compared and agrees (the 236 SD target state rows)', () => {
    expect(run([keyword('k1')], [row('k1', 'state')]).closed).toEqual(['AD_TARGET:k1:state'])
  })

  it('nothing closes after a run that could not read everything', () => {
    expect(run([keyword('k1')], [row('k1', 'state')], false).closed).toEqual([])
  })

  it('an entity the run did not compare keeps its rows', () => {
    expect(run([keyword('k1')], [row('k2', 'state')]).closed).toEqual([])
  })

  it('a field Amazon did not report keeps its row; the fields it did report close', () => {
    const r = run([keyword('k1', { observed: { keywordText: 'boots', matchType: 'EXACT', bid: 0.5 } })], [row('k1', 'state'), row('k1', 'keywordText')])
    expect(r.closed).toEqual(['AD_TARGET:k1:keywordText'])
  })

  it('a field we never specified keeps its row', () => {
    const r = run([keyword('k1', { intended: { keywordText: 'boots', matchType: 'EXACT', state: null, bid: 0.5 } })], [row('k1', 'state')])
    expect(r.closed).toEqual([])
  })

  it('a difference seen again keeps its row and is recorded', () => {
    const r = run([keyword('k1', { observed: { keywordText: 'boots', matchType: 'EXACT', state: 'paused', bid: 0.5 } })], [row('k1', 'state')])
    expect(r.closed).toEqual([])
    expect(r.record.map((d) => [d.entityType, d.entity.localId, d.field, d.intended, d.observed])).toEqual([['AD_TARGET', 'k1', 'state', 'enabled', 'paused']])
  })

  it('a bid difference is counted, never recorded, and still keeps a bid row open', () => {
    const r = run([keyword('k1', { observed: { keywordText: 'boots', matchType: 'EXACT', state: 'enabled', bid: 2 } })], [row('k1', 'bid'), row('k1', 'state')])
    expect(r.bidDeltas).toBe(1)
    expect(r.record).toEqual([])
    expect(r.closed).toEqual(['AD_TARGET:k1:state'])
  })

  it('a difference is evidence before any row is written, so a failed save cannot close its row', () => {
    const evidence = emptyEvidence()
    const { record } = assessEntities([keyword('k1', { observed: { keywordText: 'boots', matchType: 'EXACT', state: 'paused', bid: 0.5 } })], evidence)
    expect(record).toHaveLength(1)
    // Nothing was saved: the upsert for `record` could have thrown. The row stays open all the same.
    expect(rowsToClose(true, evidence, [row('k1', 'state')])).toEqual([])
  })
})

describe('S2 — existence', () => {
  it('closes when Amazon returned the entity under our id, even if another field differs', () => {
    const r = run([keyword('k1'), keyword('k2', { observed: { keywordText: 'boots', matchType: 'EXACT', state: 'paused', bid: 0.5 } })],
      [row('k1', 'existence'), row('k2', 'existence'), row('k2', 'state')])
    expect(r.closed).toEqual(['AD_TARGET:k1:existence', 'AD_TARGET:k2:existence'])
  })

  it('stays open and is recorded when we never sent the entity', () => {
    const r = run([keyword('k1', { externalId: null })], [row('k1', 'existence'), row('k1', 'state')])
    expect(r.closed).toEqual([])
    expect(r.record.map((d) => [d.field, d.intended, d.observed])).toEqual([['existence', 'on Amazon', 'never sent']])
  })

  it('existence counts as compared only when Amazon returned the entity — rule 3 on its own, not only through rule 4', () => {
    const { evidence } = run([keyword('sent'), keyword('never', { externalId: null }), keyword('gone', { observed: undefined })], [])
    const compared = evidence.compared.get('AD_TARGET')!
    expect(compared.get('sent')?.has('existence')).toBe(true)
    expect(compared.get('never')?.has('existence')).toBe(false)
    expect(compared.get('gone')?.has('existence')).toBe(false)
  })

  it('an entity Amazon did not return vouches for none of its fields', () => {
    const r = run([keyword('k1', { observed: undefined })], [row('k1', 'existence'), row('k1', 'state')])
    expect(r.closed).toEqual([])
    expect(r.record.map((d) => [d.field, d.observed])).toEqual([['existence', 'not returned']])
  })
})

describe('S2 — rows the reconcile does not own', () => {
  it('a campaign field the reconcile never compares keeps its row; one it compared closes', () => {
    // `status` is the settings sync's field; the reconcile compares `state`.
    const r = run([campaign('c1')], [row('c1', 'status', 'CAMPAIGN'), row('c1', 'name', 'CAMPAIGN')])
    expect(r.closed).toEqual(['CAMPAIGN:c1:name'])
  })

  it('keys are per drift entity type: keywords and targets are AD_TARGET rows, nothing else', () => {
    const target = verifyEntity({ entityType: 'TARGET', localId: 't1', externalId: 't1-ext', label: 't1', intended: { state: 'ENABLED' }, observed: { state: 'enabled' } })
    const r = run([keyword('k1'), target], [row('k1', 'state'), row('t1', 'state'), row('k1', 'state', 'AD_GROUP'), row('k1', 'state', 'KEYWORD')])
    expect(r.closed).toEqual(['AD_TARGET:k1:state', 'AD_TARGET:t1:state'])
  })
})

/**
 * S3 (2026-09-26) — an entity archived here that never reached Amazon: we want nothing live, Amazon holds nothing,
 * so the two agree. Its `existence` row closes and is not recorded again. Measured on production: 206 SP keywords
 * in that state were re-opened as drift on every run. The rule lives only here, in the reconcile's closing logic;
 * verifyEntity still calls them NOT_PUSHED for launch receipts.
 */
describe('S3 — archived and never sent is agreement; live and never sent is a write that never landed', () => {
  const archived = (id: string) => keyword(id, { externalId: null, intended: { keywordText: 'boots', matchType: 'EXACT', state: 'ARCHIVED', bid: 0.5 } })

  it('archived and never sent: the existence row closes, nothing is recorded, and the count is reported', () => {
    const r = run([archived('k1')], [row('k1', 'existence')])
    expect(r.closed).toEqual(['AD_TARGET:k1:existence'])
    expect(r.record).toEqual([])
    expect(r.archivedNeverSent).toBe(1)
  })

  it('only existence: the other rows of an archived, never-sent entity stay open (nothing was compared)', () => {
    expect(run([archived('k1')], [row('k1', 'state'), row('k1', 'keywordText')]).closed).toEqual([])
  })

  it('live and never sent, enabled or paused, stays a finding', () => {
    const paused = keyword('k2', { externalId: null, intended: { keywordText: 'boots', matchType: 'EXACT', state: 'PAUSED', bid: 0.5 } })
    const r = run([keyword('k1', { externalId: null }), paused], [row('k1', 'existence'), row('k2', 'existence')])
    expect(r.closed).toEqual([])
    expect(r.record.map((d) => [d.entity.localId, d.field, d.observed])).toEqual([['k1', 'existence', 'never sent'], ['k2', 'existence', 'never sent']])
    expect(r.archivedNeverSent).toBe(0)
  })

  it('archived but holding an id Amazon does not return is still a finding', () => {
    const gone = keyword('k1', { observed: undefined, intended: { keywordText: 'boots', matchType: 'EXACT', state: 'ARCHIVED', bid: 0.5 } })
    const r = run([gone], [row('k1', 'existence')])
    expect(r.closed).toEqual([])
    expect(r.record.map((d) => d.observed)).toEqual(['not returned'])
  })

  it('a live entity we never sent is ours to explain: the finding is classed WRITE_FAILED, nothing else is', () => {
    const r = run([keyword('k1', { externalId: null }), keyword('k2', { observed: undefined }), keyword('k3', { observed: { keywordText: 'boots', matchType: 'EXACT', state: 'paused', bid: 0.5 } })], [])
    expect(r.record.map((d) => [d.entity.localId, neverSent(d)])).toEqual([['k1', true], ['k2', false], ['k3', false]])
  })
})
