/**
 * Meta step 21 — set-meta-labels as a draft (pure): a label made, renamed, deleted only on explicit ask (what carries it
 * listed); a campaign's labels added by Meta's add edge, an ad set's (and every removal) as the whole new list; only the
 * chosen account's own labels; Meta's 50-per-object limit; every request judged by the gateway's exact rule; nothing spends.
 * Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { labelEntries, labelsDraft, labelsReadBack, type LabelsLive, type LabelsRequest } from './change-labels.js'
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import { readBackMismatch } from './write-client.js'
import { metaWriteVerdict } from '../../gateway/meta-calls.js'
import { META_DEFAULT_GRAPH_API_VERSION } from '../../meta/api-version.js'

const C = '120000000000001'
const S = '120000000000002'
const L1 = '120000000000070'
const L2 = '120000000000071'
const LIVE: LabelsLive = {
  adAccountId: '1234567890',
  accountLabels: [{ id: L1, name: 'Spring' }, { id: L2, name: 'Summer' }],
  accountLabelsMore: false,
  objects: [
    { kind: 'campaign', id: C, name: 'Campaign A', status: 'ACTIVE', labels: [{ id: L1, name: 'Spring' }] },
    { kind: 'adset', id: S, name: 'Ad set B', status: 'PAUSED', labels: [{ id: L1, name: 'Spring' }] },
  ],
}
const draft = (r: LabelsRequest, live: Partial<LabelsLive> = {}) => labelsDraft(r, { ...LIVE, ...live })
const ok = (r: LabelsRequest, live: Partial<LabelsLive> = {}) => { const d = draft(r, live); if ('refusal' in d) throw new Error(d.refusal); return d }
const no = (r: LabelsRequest, live: Partial<LabelsLive> = {}) => { const d = draft(r, live); return 'refusal' in d ? d.refusal : null }
const judged = (q: MetaChangeRequest) => metaWriteVerdict({
  method: q.method ?? 'POST', url: `https://graph.facebook.com/${META_DEFAULT_GRAPH_API_VERSION}/${q.objectId}${q.edge ? `/${q.edge}` : ''}`, kind: 'write',
  body: Object.keys(q.params).length ? new URLSearchParams(q.params).toString() : undefined, objectKind: q.objectKind ?? q.kind,
})
const rules = (d: MetaChangeDraft) => d.requests.map((q) => { const v = judged(q); return 'write' in v ? v.write.rule : v.problem })

describe('a label itself', () => {
  it('create: on the chosen account, read back by name, never a name the account has; nothing spends', () => {
    const d = ok({ action: 'create', name: 'Autumn' })
    expect(d.requests[0]).toMatchObject({ objectId: 'act_1234567890', objectKind: 'adaccount', edge: 'adlabels', params: { name: 'Autumn' }, check: 'none', raisesSpend: false, expect: { name: 'Autumn' } })
    expect(rules(d)).toEqual(['adlabel.create'])
    expect(d.spendsMoney).toEqual([])
    expect(no({ action: 'create', name: 'Spring' })).toMatch(/has a label named "Spring" already \(120000000000070\)/)
    expect(no({ action: 'create' })).toMatch(/needs its name/)
  })
  it('rename: only a label of the account, to a new name; the record keeps the old one', () => {
    const d = ok({ action: 'rename', labelId: L1, name: 'Spring sale' })
    expect(d.requests[0]).toMatchObject({ objectId: L1, objectKind: 'adlabel', params: { name: 'Spring sale' }, undoable: true })
    expect(rules(d)).toEqual(['adlabel.rename'])
    expect(d.before).toEqual({ op: 'rename', label: { id: L1, name: 'Spring' } })
    expect(no({ action: 'rename', labelId: '5555555555', name: 'x' })).toMatch(/not a label of the chosen ad account/)
    expect(no({ action: 'rename', labelId: L1, name: 'Spring' })).toMatch(/Nothing to change/)
  })
  it('delete: only on explicit ask; what carries it is listed; final', () => {
    expect(no({ action: 'delete', labelId: L1 })).toMatch(/only when the person explicitly asked to delete it \(confirmDelete: true\)/)
    const carriers = { campaigns: [{ id: C, name: 'Campaign A' }], adSets: [{ id: S, name: 'Ad set B' }], ads: [], creatives: [], more: false }
    const d = ok({ action: 'delete', labelId: L1, confirmDelete: true }, { carriers })
    expect(d.requests[0]).toMatchObject({ objectId: L1, objectKind: 'adlabel', method: 'DELETE', params: {}, undoable: false })
    expect(rules(d)).toEqual(['adlabel.delete'])
    expect(d.alsoDeleted).toEqual({ takenOff: carriers })
    expect(d.warnings.join(' ')).toMatch(/DELETING IS FINAL/)
    expect(d.summary).toMatch(/takes it off the 2 objects/)
    expect(ok({ action: 'delete', labelId: L1, confirmDelete: true }, { carriers: null }).warnings.join(' ')).toMatch(/could not read what carries the label/)
  })
})

describe('labels of campaigns and ad sets', () => {
  it('add: a campaign by Meta\'s add edge (only what it lacks), an ad set as its whole new list; read back as the whole list', () => {
    const d = ok({ action: 'add', objects: [{ kind: 'campaign', id: C }, { kind: 'adset', id: S }], labelIds: [L2] })
    expect(d.requests[0]).toMatchObject({ kind: 'campaign', objectId: C, edge: 'adlabels', readBackObject: true, params: { adlabels: JSON.stringify([{ id: L2 }]) }, check: 'not-yet', expect: { adlabels: JSON.stringify([{ id: L1 }, { id: L2 }]) } })
    expect(d.requests[1]).toMatchObject({ kind: 'adset', objectId: S, params: { adlabels: JSON.stringify([{ id: L1 }, { id: L2 }]) }, check: 'none' })
    expect(d.requests[1].edge).toBeUndefined()
    expect(rules(d)).toEqual(['campaign.adlabels.add', 'object.adlabels'])
    expect(d.spendsMoney).toEqual([])
    expect(d.before).toMatchObject({ op: 'objects', objects: [{ id: C, labels: [{ id: L1 }] }, { id: S, labels: [{ id: L1 }] }] })
  })
  it('add by name: an existing name is that label (by id); a new name is made by Meta in the same request', () => {
    const d = ok({ action: 'add', objects: [{ kind: 'adset', id: S }], labelNames: ['Summer', 'Winter'] })
    expect(d.requests[0].params.adlabels).toBe(JSON.stringify([{ id: L1 }, { id: L2 }, { name: 'Winter' }]))
    expect(d.warnings.join(' ')).toMatch(/Meta makes the new label "Winter"/)
    expect(rules(d)).toEqual(['object.adlabels'])
    expect(no({ action: 'add', objects: [{ kind: 'adset', id: S }], labelNames: ['Winter'] }, { accountLabelsMore: true })).toMatch(/first 500 labels/)
    expect(no({ action: 'add', objects: [{ kind: 'adset', id: S }], labelNames: ['Twin'] }, { accountLabels: [{ id: L1, name: 'Twin' }, { id: L2, name: 'Twin' }] })).toMatch(/2 labels named "Twin"/)
  })
  it('only the account\'s own labels; nothing to do is said; 50 per object at most', () => {
    expect(no({ action: 'add', objects: [{ kind: 'campaign', id: C }], labelIds: ['5555555555'] })).toMatch(/not a label of the chosen ad account/)
    // Nothing to send: the kit answers "Nothing to change" with what the draft skipped.
    expect(ok({ action: 'add', objects: [{ kind: 'campaign', id: C }], labelIds: [L1] })).toMatchObject({ requests: [], skipped: ['campaign "Campaign A" (120000000000001) carries it already.'] })
    const many = Array.from({ length: 50 }, (_, i) => ({ id: String(130000000000000 + i), name: `L${i}` }))
    const full = { ...LIVE, accountLabels: [...many, { id: L2, name: 'Summer' }], objects: [{ kind: 'adset' as const, id: S, name: 'Ad set B', status: 'PAUSED', labels: many }] }
    expect(no({ action: 'add', objects: [{ kind: 'adset', id: S }], labelIds: [L2] }, full)).toMatch(/would carry 51 labels: Meta allows 50/)
  })
  it('remove: the whole new list on POST /<object> (a campaign too); by id or by a name it carries', () => {
    const d = ok({ action: 'remove', objects: [{ kind: 'campaign', id: C }, { kind: 'adset', id: S }], labelNames: ['Spring'] })
    expect(d.requests.map((q) => [q.objectId, q.edge ?? null, q.params.adlabels])).toEqual([[C, null, '[]'], [S, null, '[]']])
    expect(rules(d)).toEqual(['object.adlabels', 'object.adlabels'])
    expect(ok({ action: 'remove', objects: [{ kind: 'adset', id: S }, { kind: 'campaign', id: C }], labelIds: [L2] }, { objects: [{ ...LIVE.objects[1], labels: [{ id: L1, name: 'Spring' }, { id: L2, name: 'Summer' }] }, LIVE.objects[0]] }).skipped)
      .toEqual(['campaign "Campaign A" (120000000000001) carries none of them.'])
  })
  it('replace (what undo sends): the list named; a label gone since is left out and said; the same list is skipped', () => {
    const d = ok({ action: 'replace', sets: [{ kind: 'adset', id: S, labelIds: [L2, '5555555555'] }, { kind: 'campaign', id: C, labelIds: [L1] }] })
    expect(d.requests).toHaveLength(1)
    expect(d.requests[0].params.adlabels).toBe(JSON.stringify([{ id: L2 }]))
    expect(d.warnings.join(' ')).toMatch(/5555555555 is no longer a label of the ad account/)
    expect(d.skipped).toEqual(['campaign "Campaign A" (120000000000001) carries exactly these labels already.'])
  })
})

describe('the read-back of a label list (write-client.ts)', () => {
  it('the same labels in any order match; one missing, one more or another id does not; a name asked matches by name', () => {
    const asked = labelEntries([{ id: L1, name: 'Spring' }, { id: null, name: 'Winter' }])
    expect(readBackMismatch({ adlabels: [{ id: '120000000000099', name: 'Winter' }, { id: L1, name: 'Spring' }] }, { adlabels: asked })).toEqual([])
    expect(readBackMismatch({ adlabels: { data: [{ id: L1, name: 'Spring' }, { id: '9', name: 'Winter' }] } }, { adlabels: asked })).toEqual([])
    expect(readBackMismatch({ adlabels: [{ id: L1, name: 'Spring' }] }, { adlabels: asked })).toEqual(['adlabels'])
    expect(readBackMismatch({ adlabels: [{ id: L2, name: 'Summer' }, { id: '9', name: 'Winter' }] }, { adlabels: asked })).toEqual(['adlabels'])
    // Meta leaves an empty list out: not judged (a field not sent back).
    expect(readBackMismatch({ id: S }, { adlabels: '[]' })).toEqual([])
    expect(labelsReadBack({ id: S })).toEqual([])
    expect(labelsReadBack({ success: true })).toBeNull()
    expect(labelsReadBack({ id: C, adlabels: [{ id: L1, name: 'Spring' }] })).toEqual([{ id: L1, name: 'Spring' }])
  })
})
