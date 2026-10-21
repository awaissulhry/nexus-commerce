/**
 * Meta step 28 — create-meta-experiment, set-meta-experiment and end-meta-experiment as pure drafts: Nexus's pre-check
 * (EX-011: Meta has none by API), the study shapes Meta documents (A/B test, creative test, conversion lift, Page video
 * test), a creative test's own budget SPENDS MONEY, what Meta allows once a study runs (start and split fixed, nothing
 * removed, only a later end, objectives fixed), ending early at a named time soon (never "now", so the approved plan does
 * not move with the clock), the records undo reads. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { createExperimentDraft, endExperimentDraft, setExperimentDraft, studyFields, creativeTestBudgetParam, type CreateExperimentLive, type ExperimentRecord, type SetExperimentLive, type StudyObject } from './change-experiments.js'
import type { LiveStudy } from './live-optimize-changes.js'
import type { MetaChangeDraft } from './change-draft.js'

const NOW = 4_102_444_800 // 2100-01-01T00:00:00Z
const iso = (unix: number) => new Date(unix * 1000).toISOString()
const S1 = '120000000000201'
const S2 = '120000000000202'
const A1 = '120000000000301'
const A2 = '120000000000302'
const C1 = '120000000000101'
const obj = (kind: StudyObject['kind'], id: string, on = true): [string, StudyObject] => [id, { kind, id, name: `Shop A ${kind} ${id.slice(-3)}`, on }]
const createLive = (extra: Partial<CreateExperimentLive> = {}): CreateExperimentLive => ({
  now: NOW, adAccountId: '1234567890', currency: 'EUR', businessId: '120000000000090', pageId: '120000000000010',
  objects: new Map([obj('adset', S1), obj('adset', S2, false), obj('ad', A1), obj('ad', A2), obj('campaign', C1)]), objectStudies: new Map(), openStudies: 3,
  pixels: new Set(['120000000000050']), customConversions: new Set(['120000000000055']), videos: [], ...extra,
})
const ok = (d: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)
const ab = { kind: 'ab-test' as const, name: 'Audience test', startTime: iso(NOW + 86400), endTime: iso(NOW + 15 * 86400), cells: [{ name: 'A', percent: 50, adSetIds: [S1] }, { name: 'B', percent: 50, adSetIds: [S2] }] }

describe('create-meta-experiment', () => {
  it('an A/B test: ONE POST on the account\'s portfolio, no budget of its own, no undo (Meta cannot delete a study)', () => {
    const d = ok(createExperimentDraft(ab, createLive()))
    expect(d.requests[0]).toMatchObject({ objectId: '120000000000090', objectKind: 'business', edge: 'ad_studies', operation: 'study.create', check: 'none', raisesSpend: false, undoable: false, expect: { name: 'Audience test' } })
    expect(d.requests[0].params).toEqual({
      name: 'Audience test', type: 'SPLIT_TEST', start_time: String(NOW + 86400), end_time: String(NOW + 15 * 86400),
      cells: JSON.stringify([{ name: 'A', treatment_percentage: 50, adsets: [S1] }, { name: 'B', treatment_percentage: 50, adsets: [S2] }]),
    })
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/adds no budget.*1 on, 1 not on/)
    expect(d.warnings.join(' ')).toMatch(/No undo: Meta cannot delete a study/)
  })
  it('Nexus\'s pre-check: the account\'s objects, in no other open test, ≤ 100 open studies, a future start, shares 10–100', () => {
    expect(refusal(createExperimentDraft({ ...ab, cells: [{ name: 'A', percent: 50, adSetIds: ['120000000000299'] }, { name: 'B', percent: 50, adSetIds: [S2] }] }, createLive()))).toMatch(/not an ad set of the chosen ad account/)
    expect(refusal(createExperimentDraft(ab, createLive({ objectStudies: new Map([[S1, [{ studyId: '120000000000041', name: 'Old test', state: 'running', endTime: NOW + 3600 }]]]) })))).toMatch(/already in study "Old test"/)
    expect(refusal(createExperimentDraft(ab, createLive({ openStudies: 100 })))).toMatch(/at most 100 at once/)
    expect(refusal(createExperimentDraft({ ...ab, startTime: iso(NOW - 60) }, createLive()))).toMatch(/starts in the future/)
    expect(refusal(createExperimentDraft({ ...ab, cells: [{ name: 'A', percent: 5, adSetIds: [S1] }, { name: 'B', percent: 50, adSetIds: [S2] }] }, createLive()))).toMatch(/at least 10/)
    expect(refusal(createExperimentDraft({ ...ab, cells: [{ name: 'A', percent: 60, adSetIds: [S1] }, { name: 'B', percent: 50, adSetIds: [S2] }] }, createLive()))).toMatch(/at most 100/)
    expect(refusal(createExperimentDraft({ ...ab, cells: [{ name: 'A', percent: 50, adSetIds: [S1] }] }, createLive()))).toMatch(/at least 2 cells/)
    expect(refusal(createExperimentDraft({ ...ab, cells: [{ name: 'A', percent: 50, adSetIds: [S1] }, { name: 'B', percent: 50, campaignIds: [C1] }] }, createLive()))).toMatch(/one level/)
    expect(refusal(createExperimentDraft(ab, createLive({ businessId: null })))).toMatch(/business portfolio/)
  })
  it('a creative test: one ad per cell, whole shares summing to 100, cooldown = start and observation = end, its budget SPENDS MONEY', () => {
    const v2 = { kind: 'creative-test' as const, name: 'Creative', startTime: iso(NOW + 3600), endTime: iso(NOW + 8 * 86400), cells: [{ name: 'a', percent: 50, adIds: [A1] }, { name: 'b', percent: 50, adIds: [A2] }], creativeTestBudget: { dailyBudgetCents: 15000 } }
    const d = ok(createExperimentDraft(v2, createLive()))
    expect(d.requests[0].params).toMatchObject({ type: 'SPLIT_TEST_V2', cooldown_start_time: String(NOW + 3600), observation_end_time: String(NOW + 8 * 86400), creative_test_config: '{"daily_budget":15000}' })
    expect(d.requests[0].raisesSpend).toBe(true)
    expect(d.spendsMoney.join(' ')).toMatch(/150.00 EUR a day.*2 ads are on/)
    expect(d.warnings.join(' ')).toMatch(/LIVE-PROBES EX-015/)
    expect(refusal(createExperimentDraft({ ...v2, creativeTestBudget: undefined }, createLive()))).toMatch(/its own test budget/)
    expect(refusal(createExperimentDraft({ ...v2, cells: [{ name: 'a', percent: 40, adIds: [A1] }, { name: 'b', percent: 50, adIds: [A2] }] }, createLive()))).toMatch(/sum to exactly 100/)
    expect(refusal(createExperimentDraft({ ...v2, cells: [{ name: 'a', percent: 50, adSetIds: [S1] }, { name: 'b', percent: 50, adIds: [A2] }] }, createLive()))).toMatch(/compares ads/)
    expect(creativeTestBudgetParam(15000, 'EUR')).toBe(15000)
    expect(creativeTestBudgetParam(1500, 'JPY')).toBe(1500)
  })
  it('a lift study: holdouts, the account\'s own pixel or custom conversions, one primary objective, Meta\'s grant said', () => {
    const lift = { kind: 'lift' as const, name: 'Lift', startTime: iso(NOW + 86400), endTime: iso(NOW + 29 * 86400), cells: [{ name: 'test', percent: 90, controlPercent: 10, wholeAdAccount: true }], objectives: [{ name: 'Purchases', pixelId: '120000000000050', pixelEvents: ['fb_pixel_purchase' as const] }] }
    const d = ok(createExperimentDraft(lift, createLive()))
    expect(JSON.parse(d.requests[0].params.cells)).toEqual([{ name: 'test', treatment_percentage: 90, control_percentage: 10, adaccounts: ['1234567890'] }])
    expect(JSON.parse(d.requests[0].params.objectives)).toEqual([{ name: 'Purchases', is_primary: true, type: 'CONVERSIONS', adspixels: [{ id: '120000000000050', event_names: ['fb_pixel_purchase'] }] }])
    expect(d.requests[0].params.observation_end_time).toBe(String(NOW + 29 * 86400))
    expect(d.warnings.join(' ')).toMatch(/Meta's grant/)
    expect(refusal(createExperimentDraft({ ...lift, objectives: [{ name: 'P', pixelId: '120000000000059', pixelEvents: ['fb_pixel_purchase' as const] }] }, createLive()))).toMatch(/not one of the chosen ad account's own pixels/)
    expect(refusal(createExperimentDraft({ ...lift, objectives: [] }, createLive()))).toMatch(/at least one objective/)
    expect(refusal(createExperimentDraft({ ...lift, cells: [{ name: 'test', percent: 95, controlPercent: 10, wholeAdAccount: true }] }, createLive()))).toMatch(/at most 100/)
    // Review B3 — a holdout in every lift cell; one cell makes 100 with it; a pixel names the events it counts.
    expect(refusal(createExperimentDraft({ ...lift, cells: [{ name: 'test', percent: 90, wholeAdAccount: true }] }, createLive()))).toMatch(/has a holdout/)
    expect(refusal(createExperimentDraft({ ...lift, cells: [{ name: 'test', percent: 80, controlPercent: 10, wholeAdAccount: true }] }, createLive()))).toMatch(/sum to exactly 100/)
    expect(refusal(createExperimentDraft({ ...lift, objectives: [{ name: 'P', pixelId: '120000000000050' }] }, createLive()))).toMatch(/name the pixel events/)
    // Review B5 — the whole account is measured by a lift study still going: Nexus's own rule, said as such.
    expect(refusal(createExperimentDraft(lift, createLive({ openLifts: [{ studyId: '120000000000049', name: 'Old lift', state: 'measuring', endTime: NOW - 3600 }] })))).toMatch(/already measured by study "Old lift".*Nexus's own rule \(Meta documents none\)/)
    expect(refusal(createExperimentDraft(ab, createLive({ objectStudies: new Map([[S1, [{ studyId: '120000000000049', name: 'Old lift', state: 'measuring', endTime: NOW - 3600 }]]]) })))).toMatch(/Nexus's own rule/)
    expect(refusal(createExperimentDraft({ ...ab, cells: [{ name: 'A', percent: 50, controlPercent: 5, adSetIds: [S1] }, { name: 'B', percent: 45, adSetIds: [S2] }] }, createLive()))).toMatch(/lift study's only/)
  })
  it('a Page video test: 2–4 of the chosen Page\'s unpublished videos, the control among them, organic', () => {
    const videos = [{ id: '120000000000071', title: null, published: false }, { id: '120000000000072', title: null, published: false }]
    const vt = { kind: 'page-video-test' as const, name: 'Reels', description: 'Two cuts', videoIds: ['120000000000071', '120000000000072'], goal: 'REELS_PLAYS' as const, durationMinutes: 60 }
    const d = ok(createExperimentDraft(vt, createLive({ videos })))
    expect(d.requests[0]).toMatchObject({ objectId: '120000000000010', objectKind: 'page', edge: 'ab_tests', operation: 'pageVideoTest.create', raisesSpend: false })
    expect(d.requests[0].params).toEqual({ name: 'Reels', description: 'Two cuts', optimization_goal: 'REELS_PLAYS', control_video_id: '120000000000071', experiment_video_ids: '["120000000000071","120000000000072"]', duration: '3600' })
    expect(refusal(createExperimentDraft(vt, createLive({ videos: [{ ...videos[0], published: true }, videos[1]] })))).toMatch(/published already/)
    expect(refusal(createExperimentDraft({ ...vt, description: undefined }, createLive({ videos })))).toMatch(/description/)
    expect(refusal(createExperimentDraft(vt, createLive({ videos, pageId: null })))).toMatch(/No Facebook Page/)
  })
})

const study = (o: Partial<LiveStudy> = {}): LiveStudy => ({
  id: '120000000000041', name: 'Audience test', description: 'Two audiences', type: 'SPLIT_TEST', businessId: '120000000000090',
  startTime: NOW + 86400, endTime: NOW + 15 * 86400, observationEndTime: null, cooldownStartTime: null, canceled: false, state: 'planned',
  cells: [{ id: '120000000000061', name: 'A', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: [S1], ads: [] }, { id: '120000000000062', name: 'B', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: [S2], ads: [] }],
  cellsNote: null, objectives: [], viewers: ['100000000000001'], ...o,
})
const setLive = (s: LiveStudy | null, extra: Partial<SetExperimentLive> = {}): SetExperimentLive => ({
  now: NOW, adAccountId: '1234567890', study: s, objects: new Map([obj('adset', '120000000000203')]), objectStudies: new Map(), pixels: null, customConversions: null,
  people: new Set(['100000000000001', '100000000000002']), videoTest: null, ...extra,
})
const running = study({ state: 'running', startTime: NOW - 86400, endTime: NOW + 6 * 86400 })

describe('set-meta-experiment', () => {
  it('rename and extend: ONE POST of the study; undo puts the old name back (a running study\'s old end: end-meta-experiment)', () => {
    const d = ok(setExperimentDraft({ action: 'update', studyId: running.id, name: 'Audience test 2', endTime: iso(NOW + 10 * 86400) }, setLive(running)))
    expect(d.requests[0]).toMatchObject({ objectId: running.id, objectKind: 'adstudy', operation: 'study.update', params: { name: 'Audience test 2', end_time: String(NOW + 10 * 86400) }, expect: { name: 'Audience test 2', end_time: String(NOW + 10 * 86400) } })
    expect((d.before as ExperimentRecord).undo).toEqual({ action: 'update', studyId: running.id, name: 'Audience test' })
    expect((d.before as ExperimentRecord).noUndo!.join(' ')).toMatch(/running study's end only moves later; end-meta-experiment/)
    // Before it starts, the old end goes back too.
    const planned = ok(setExperimentDraft({ action: 'update', studyId: running.id, endTime: iso(NOW + 20 * 86400) }, setLive(study())))
    expect((planned.before as ExperimentRecord).undo).toEqual({ action: 'update', studyId: running.id, endTime: iso(NOW + 15 * 86400).replace('.000Z', 'Z') })
    expect(d.warnings.join(' ')).toMatch(/adds no budget/)
  })
  it('once it runs: no new start, no split, nothing removed, an end only later (sooner is end-meta-experiment), no objectives', () => {
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, startTime: iso(NOW + 3600) }, setLive(running)))).toMatch(/has started/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, splits: [{ cellId: '120000000000061', percent: 60 }, { cellId: '120000000000062', percent: 40 }] }, setLive(running)))).toMatch(/split/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, removeCellIds: ['120000000000062'] }, setLive(running)))).toMatch(/removed/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, endTime: iso(NOW + 86400) }, setLive(running)))).toMatch(/end-meta-experiment/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, objectives: [{ name: 'P', pixelId: '1' }] }, setLive(running)))).toMatch(/lift study's/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, endTime: iso(NOW + 9 * 86400) }, setLive({ ...running, state: 'finished' })))).toMatch(/has ended/)
  })
  it('add objects to a running cell: every cell sent by id, the changed one with its full list; they stay (no undo)', () => {
    const d = ok(setExperimentDraft({ action: 'update', studyId: running.id, addObjects: [{ cellId: '120000000000061', adSetIds: ['120000000000203'] }] }, setLive(running)))
    expect(JSON.parse(d.requests[0].params.cells)).toEqual([{ id: '120000000000061', adsets: [S1, '120000000000203'] }, { id: '120000000000062' }])
    expect((d.before as ExperimentRecord).undo).toBeNull()
    expect((d.before as ExperimentRecord).noUndo!.join(' ')).toMatch(/nothing be removed from a running study/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, addObjects: [{ cellId: '120000000000061', adIds: [A1] }] }, setLive(running, { objects: new Map([obj('ad', A1)]) })))).toMatch(/add only ad sets/)
  })
  it('before it starts: a new split names every cell (Meta: they are correlated), and undo puts the old split back', () => {
    const planned = study()
    expect(refusal(setExperimentDraft({ action: 'update', studyId: planned.id, splits: [{ cellId: '120000000000061', percent: 60 }] }, setLive(planned)))).toMatch(/every remaining cell/)
    const d = ok(setExperimentDraft({ action: 'update', studyId: planned.id, splits: [{ cellId: '120000000000061', percent: 60 }, { cellId: '120000000000062', percent: 40 }] }, setLive(planned)))
    expect(JSON.parse(d.requests[0].params.cells)).toEqual([{ id: '120000000000061', treatment_percentage: 60 }, { id: '120000000000062', treatment_percentage: 40 }])
    expect((d.before as ExperimentRecord).undo).toEqual({ action: 'update', studyId: planned.id, splits: [{ cellId: '120000000000061', percent: 50 }, { cellId: '120000000000062', percent: 50 }] })
  })
  it('a creative test that runs longer or starts sooner SPENDS MONEY (its own test budget runs with it)', () => {
    const v2 = study({ type: 'SPLIT_TEST_V2', cells: [{ id: '120000000000061', name: 'a', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: [], ads: [A1] }, { id: '120000000000062', name: 'b', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: [], ads: [A2] }] })
    const sooner = ok(setExperimentDraft({ action: 'update', studyId: v2.id, startTime: iso(NOW + 3600) }, setLive(v2)))
    expect(sooner.requests[0].params).toEqual({ start_time: String(NOW + 3600), cooldown_start_time: String(NOW + 3600) })
    expect(sooner.spendsMoney.join(' ')).toMatch(/starts sooner/)
    const longer = ok(setExperimentDraft({ action: 'update', studyId: v2.id, endTime: iso(NOW + 20 * 86400) }, setLive(v2)))
    expect(longer.requests[0].params).toEqual({ end_time: String(NOW + 20 * 86400), observation_end_time: String(NOW + 20 * 86400) })
    expect(longer.requests[0].raisesSpend).toBe(true)
  })
  it('review B6 / B1 — a new start against the end it keeps; a creative test\'s shares sum to 100 on a change; a lift end past its observation end', () => {
    expect(refusal(setExperimentDraft({ action: 'update', studyId: study().id, startTime: iso(NOW + 16 * 86400) }, setLive(study())))).toMatch(/at or after its end.*endTime too/)
    const v2 = study({ type: 'SPLIT_TEST_V2', cells: [{ id: '120000000000061', name: 'a', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: [], ads: [A1] }, { id: '120000000000062', name: 'b', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: [], ads: [A2] }] })
    expect(refusal(setExperimentDraft({ action: 'update', studyId: v2.id, splits: [{ cellId: '120000000000061', percent: 40 }, { cellId: '120000000000062', percent: 50 }] }, setLive(v2)))).toMatch(/sum to exactly 100/)
    const lift = study({ type: 'LIFT', state: 'running', startTime: NOW - 86400, endTime: NOW + 6 * 86400, observationEndTime: NOW + 8 * 86400, cells: [{ id: '120000000000061', name: 'test', treatment: 90, control: 10, adAccounts: ['1234567890'], campaigns: [], adSets: [], ads: [] }] })
    expect(refusal(setExperimentDraft({ action: 'update', studyId: lift.id, endTime: iso(NOW + 10 * 86400) }, setLive(lift)))).toMatch(/passes its observation end.*name observationEndTime too/)
    expect(ok(setExperimentDraft({ action: 'update', studyId: lift.id, endTime: iso(NOW + 7 * 86400) }, setLive(lift))).requests[0].params).toEqual({ end_time: String(NOW + 7 * 86400) })
    const same = study({ ...lift, observationEndTime: NOW + 6 * 86400 })
    expect(ok(setExperimentDraft({ action: 'update', studyId: lift.id, endTime: iso(NOW + 10 * 86400) }, setLive(same))).requests[0].params).toEqual({ end_time: String(NOW + 10 * 86400), observation_end_time: String(NOW + 10 * 86400) })
  })
  it('review A9 — undo arguments pass the tool\'s own input: a long old name, more than 50 viewers → said, not recorded', () => {
    const longName = study({ state: 'running', startTime: NOW - 86400, name: 'x'.repeat(201) })
    const d = ok(setExperimentDraft({ action: 'update', studyId: longName.id, name: 'Short' }, setLive(longName)))
    expect((d.before as ExperimentRecord).undo).toBeNull()
    expect((d.before as ExperimentRecord).noUndo!.join(' ')).toMatch(/old name is not one Nexus can send back/)
    const many = study({ state: 'running', startTime: NOW - 86400, viewers: Array.from({ length: 60 }, (_, i) => String(100000000000100 + i)) })
    const v = ok(setExperimentDraft({ action: 'update', studyId: many.id, viewers: [] }, setLive(many)))
    expect((v.before as ExperimentRecord).undo).toBeNull()
    expect((v.before as ExperimentRecord).noUndo!.join(' ')).toMatch(/shared with 60 people/)
  })
  it('round 2 NEW-1 — a lift change never sends a holdout Meta did not answer; a split holdout above 0; every kept cell named', () => {
    const lift = study({ type: 'LIFT', cells: [
      { id: '120000000000061', name: 'A', treatment: 35, control: null, adAccounts: [], campaigns: [C1], adSets: [], ads: [] },
      { id: '120000000000062', name: 'B', treatment: 35, control: 10, adAccounts: [], campaigns: [], adSets: [S1], ads: [] },
    ] })
    const addC = [{ name: 'C', percent: 10, controlPercent: 5, adSetIds: ['120000000000203'] }]
    expect(refusal(setExperimentDraft({ action: 'update', studyId: lift.id, addCells: addC }, setLive(lift)))).toMatch(/could not read the holdout of cell "A".*name it in splits/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: lift.id, splits: [{ cellId: '120000000000061', percent: 40, controlPercent: 0 }, { cellId: '120000000000062', percent: 40, controlPercent: 5 }] }, setLive(lift)))).toMatch(/a lift holdout is above 0/)
    const read = study({ ...lift, cells: [{ ...lift.cells![0], control: 5 }, lift.cells![1]] })
    const d = ok(setExperimentDraft({ action: 'update', studyId: lift.id, addCells: addC }, setLive(read)))
    expect(JSON.parse(d.requests[0].params.cells)).toEqual([
      { id: '120000000000061', treatment_percentage: 35, control_percentage: 5 }, { id: '120000000000062', treatment_percentage: 35, control_percentage: 10 },
      { name: 'C', treatment_percentage: 10, control_percentage: 5, adsets: ['120000000000203'] },
    ])
    expect(d.changes).toMatchObject({ 'Cell "A" share (sent as it is)': { from: '35 % (+ 5 % holdout)', to: '35 % (+ 5 % holdout)' }, 'Cell "B" share (sent as it is)': { from: '35 % (+ 10 % holdout)', to: '35 % (+ 10 % holdout)' } })
  })
  it('round 2 NEW-2 — an end that moved the observation end too: the old observation end is in the undo (a lift study before it starts)', () => {
    const lift = study({ type: 'LIFT', observationEndTime: NOW + 15 * 86400, cells: [{ id: '120000000000061', name: 'test', treatment: 90, control: 10, adAccounts: ['1234567890'], campaigns: [], adSets: [], ads: [] }] })
    const d = ok(setExperimentDraft({ action: 'update', studyId: lift.id, endTime: iso(NOW + 20 * 86400) }, setLive(lift)))
    expect(d.requests[0].params).toEqual({ end_time: String(NOW + 20 * 86400), observation_end_time: String(NOW + 20 * 86400) })
    expect((d.before as ExperimentRecord).undo).toEqual({ action: 'update', studyId: lift.id, endTime: iso(NOW + 15 * 86400).replace('.000Z', 'Z'), observationEndTime: iso(NOW + 15 * 86400).replace('.000Z', 'Z') })
    const ab = study({ observationEndTime: NOW + 15 * 86400 })
    const a = ok(setExperimentDraft({ action: 'update', studyId: ab.id, endTime: iso(NOW + 20 * 86400) }, setLive(ab)))
    expect((a.before as ExperimentRecord).noUndo!.join(' ')).toMatch(/old observation end .* not put back by undo: Nexus moves an observation end only for a lift study/)
  })
  it('follow-ups 2–6 — splits say only what is sent; a running lift with an unread holdout waits; objects added alone to a lift are said; B5 on a change', () => {
    const planned = study()
    // 3 — an A/B split with a holdout is refused (nothing of it would be sent); 6 — a lift holdout has at most two decimals.
    expect(refusal(setExperimentDraft({ action: 'update', studyId: planned.id, splits: [{ cellId: '120000000000061', percent: 60, controlPercent: 5 }, { cellId: '120000000000062', percent: 40 }] }, setLive(planned)))).toMatch(/lift study's only/)
    const lift = study({ type: 'LIFT', cells: [
      { id: '120000000000061', name: 'A', treatment: 45, control: 5, adAccounts: [], campaigns: [C1], adSets: [], ads: [] },
      { id: '120000000000062', name: 'B', treatment: 40, control: 10, adAccounts: [], campaigns: [], adSets: [S1], ads: [] },
    ] })
    expect(refusal(setExperimentDraft({ action: 'update', studyId: lift.id, splits: [{ cellId: '120000000000061', percent: 45, controlPercent: 5.555 }, { cellId: '120000000000062', percent: 40 }] }, setLive(lift)))).toMatch(/at most two decimals/)
    // 3 — a lift split without a holdout shows the holdout that IS sent (the one read).
    const d = ok(setExperimentDraft({ action: 'update', studyId: lift.id, splits: [{ cellId: '120000000000061', percent: 50 }, { cellId: '120000000000062', percent: 35 }] }, setLive(lift)))
    expect(d.changes).toMatchObject({ 'Cell "A" share': { from: '45 % (+ 5 % holdout)', to: '50 % (+ 5 % holdout)' } })
    expect(JSON.parse(d.requests[0].params.cells)[0]).toEqual({ id: '120000000000061', treatment_percentage: 50, control_percentage: 5 })
    // 4 — running, a holdout not read: no "name it in splits" (splits are fixed once it runs).
    const runningLift = study({ ...lift, state: 'running', startTime: NOW - 86400, cells: [{ ...lift.cells![0], control: null }, lift.cells![1]] })
    const waits = refusal(setExperimentDraft({ action: 'update', studyId: lift.id, addCells: [{ name: 'C', percent: 5, controlPercent: 5, adSetIds: ['120000000000203'] }] }, setLive(runningLift, { openLifts: [] })))
    expect(waits).toMatch(/cannot make this change safely now/)
    expect(waits).not.toMatch(/name it in splits/)
    // 5 — objects added alone to a lift's cell: sent by id without share or holdout, said with its probe.
    const running2 = study({ ...lift, state: 'running', startTime: NOW - 86400 })
    const added = ok(setExperimentDraft({ action: 'update', studyId: lift.id, addObjects: [{ cellId: '120000000000062', adSetIds: ['120000000000203'] }] }, setLive(running2, { openLifts: [] })))
    expect(JSON.parse(added.requests[0].params.cells)).toEqual([{ id: '120000000000061' }, { id: '120000000000062', adsets: [S1, '120000000000203'] }])
    expect(added.warnings.join(' ')).toMatch(/no share and no holdout.*LIVE-PROBES EX-020-lift/)
    // 2 — B5 on a change: other open lifts unread, a whole-account cell next to another lift, objects under a whole-account lift.
    const other = { studyId: '120000000000049', name: 'Other lift', state: 'running', endTime: NOW + 3600, wholeAccount: false }
    expect(refusal(setExperimentDraft({ action: 'update', studyId: lift.id, addObjects: [{ cellId: '120000000000062', adSetIds: ['120000000000203'] }] }, setLive(running2, { openLifts: null })))).toMatch(/could not read the other lift studies/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: lift.id, addCells: [{ name: 'All', percent: 5, controlPercent: 5, wholeAdAccount: true }] }, setLive(lift, { openLifts: [other] })))).toMatch(/already measured by study "Other lift"/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: lift.id, addObjects: [{ cellId: '120000000000062', adSetIds: ['120000000000203'] }] }, setLive(running2, { openLifts: [{ ...other, wholeAccount: true }] })))).toMatch(/measured by study "Other lift".*Nexus's own rule/)
    expect(refusal(setExperimentDraft({ action: 'update', studyId: lift.id, addObjects: [{ cellId: '120000000000062', adSetIds: ['120000000000203'] }] }, setLive(running2, { openLifts: [other] })))).toBeNull()
  })
  it('follow-up — an old description longer in UTF-16 than the tool takes is said, not recorded', () => {
    const long = study({ state: 'running', startTime: NOW - 86400, description: '🏍'.repeat(600) })
    const d = ok(setExperimentDraft({ action: 'update', studyId: long.id, description: 'Short' }, setLive(long)))
    expect((d.before as ExperimentRecord).undo).toBeNull()
    expect((d.before as ExperimentRecord).noUndo!.join(' ')).toMatch(/old description is not one Nexus can send back/)
  })
  it('round 2 A9 / B5 / B6 — a name longer in UTF-16 than the tool takes; no object test while a whole-account lift runs; a removal checks the 100 %', () => {
    const emoji = study({ state: 'running', startTime: NOW - 86400, name: '🏍'.repeat(150) })
    expect((ok(setExperimentDraft({ action: 'update', studyId: emoji.id, name: 'Short' }, setLive(emoji))).before as ExperimentRecord).undo).toBeNull()
    const whole = { studyId: '120000000000049', name: 'Account lift', state: 'running', endTime: NOW + 3600, wholeAccount: true }
    expect(refusal(createExperimentDraft(ab, createLive({ openLifts: [whole] })))).toMatch(/whole ad account is measured by study "Account lift".*Nexus's own rule/)
    expect(refusal(createExperimentDraft(ab, createLive({ openLifts: [{ ...whole, wholeAccount: null }] })))).toMatch(/could not read its cells/)
    expect(refusal(createExperimentDraft(ab, createLive({ openLifts: [{ ...whole, wholeAccount: false }] })))).toBeNull()
    const v2 = study({ type: 'SPLIT_TEST_V2', cells: [
      { id: '120000000000061', name: 'a', treatment: 50, control: null, adAccounts: [], campaigns: [], adSets: [], ads: [A1] },
      { id: '120000000000062', name: 'b', treatment: 25, control: null, adAccounts: [], campaigns: [], adSets: [], ads: [A2] },
      { id: '120000000000063', name: 'c', treatment: 25, control: null, adAccounts: [], campaigns: [], adSets: [], ads: ['120000000000303'] },
    ] })
    expect(refusal(setExperimentDraft({ action: 'update', studyId: v2.id, removeCellIds: ['120000000000063'] }, setLive(v2)))).toMatch(/sum to exactly 100 % \(now 75\)/)
    const removed = ok(setExperimentDraft({ action: 'update', studyId: v2.id, removeCellIds: ['120000000000063'], splits: [{ cellId: '120000000000061', percent: 50 }, { cellId: '120000000000062', percent: 50 }] }, setLive(v2)))
    expect(JSON.parse(removed.requests[0].params.cells)).toEqual([{ id: '120000000000061', treatment_percentage: 50 }, { id: '120000000000062', treatment_percentage: 50 }])
  })
  it('share: only people with a role on the ad account; the old list is the undo', () => {
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, viewers: ['100000000000001', '100000000000009'] }, setLive(running)))).toMatch(/100000000000009 has no role/)
    const d = ok(setExperimentDraft({ action: 'update', studyId: running.id, viewers: ['100000000000001', '100000000000002'] }, setLive(running)))
    expect(d.requests[0].params.viewers).toBe('["100000000000001","100000000000002"]')
    expect((d.before as ExperimentRecord).undo).toEqual({ action: 'update', studyId: running.id, viewers: ['100000000000001'] })
    expect((d.after as ExperimentRecord).fields.viewers).toBe('100000000000001,100000000000002')
    // Removing someone needs no read of the account's people.
    expect(refusal(setExperimentDraft({ action: 'update', studyId: running.id, viewers: [] }, setLive(running, { people: null })))).toBeNull()
  })
  it('a Page video test is deleted only once it concluded (for good)', () => {
    expect(refusal(setExperimentDraft({ action: 'delete-page-video-test', testId: '120000000000081' }, setLive(null, { videoTest: { id: '120000000000081', name: 'Reels', publishStatus: 'LIVE', concluded: false } })))).toMatch(/still runs/)
    const d = ok(setExperimentDraft({ action: 'delete-page-video-test', testId: '120000000000081' }, setLive(null, { videoTest: { id: '120000000000081', name: 'Reels', publishStatus: null, concluded: null } })))
    expect(d.requests[0]).toMatchObject({ objectKind: 'pagevideotest', method: 'DELETE', operation: 'pageVideoTest.delete', params: {} })
  })
  it('the record views a study the way undo reads it again', () => {
    expect(studyFields(running)).toEqual({
      name: 'Audience test', description: 'Two audiences', start_time: String(NOW - 86400), end_time: String(NOW + 6 * 86400), observation_end_time: null,
      viewers: '100000000000001', splits: '120000000000061:50/,120000000000062:50/',
    })
  })
})

describe('end-meta-experiment', () => {
  it('moves a running test\'s end to the time named (a creative test\'s observation end too); no undo once it passed', () => {
    const d = ok(endExperimentDraft(running, NOW, iso(NOW + 900)))
    expect(d.requests[0]).toMatchObject({ objectId: running.id, objectKind: 'adstudy', operation: 'study.end', params: { end_time: String(NOW + 900) }, expect: { end_time: String(NOW + 900) }, raisesSpend: false })
    expect(d.warnings.join(' ')).toMatch(/LIVE-PROBES EX-023/)
    expect(d.warnings.join(' ')).toMatch(/keep running as they are set/)
    const v2 = ok(endExperimentDraft({ ...running, type: 'SPLIT_TEST_V2' }, NOW, iso(NOW + 900)))
    expect(v2.requests[0].params).toEqual({ end_time: String(NOW + 900), observation_end_time: String(NOW + 900) })
  })
  it('the same args give the same plan at any later moment while it runs (the end is named, never "now")', () => {
    const a = ok(endExperimentDraft(running, NOW, iso(NOW + 900)))
    const b = ok(endExperimentDraft(running, NOW + 300, iso(NOW + 900)))
    expect(b.requests[0].params).toEqual(a.requests[0].params)
  })
  it('refuses a test that has not started or has ended, an end too soon, too late or not earlier', () => {
    expect(refusal(endExperimentDraft(study(), NOW, iso(NOW + 900)))).toMatch(/has not started.*set-meta-experiment/)
    expect(refusal(endExperimentDraft({ ...running, state: 'finished' }, NOW, iso(NOW + 900)))).toMatch(/has ended already/)
    expect(refusal(endExperimentDraft(running, NOW, iso(NOW + 30)))).toMatch(/at least 2 minutes from now/)
    expect(refusal(endExperimentDraft(running, NOW, iso(NOW + 2 * 86400)))).toMatch(/within a day/)
    expect(refusal(endExperimentDraft({ ...running, endTime: NOW + 600 }, NOW, iso(NOW + 900)))).toMatch(/earlier than that/)
    expect(refusal(endExperimentDraft({ ...running, type: 'GEO_LIFT' }, NOW, iso(NOW + 900)))).toMatch(/run by Meta/)
  })
})
