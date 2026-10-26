/**
 * 6a (2026-10-26) — an hourly bid plan holds Sponsored Products campaigns only. A save's success line counts what the
 * plan really holds, names what was left out, and says on or off from the answer — not from what was sent.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { addRefusedMessage, campaignsAddedMessage, notSponsoredSentence, planSavedMessage, readSaveAnswer, saveRefusedMessage } from './planSave'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const body = read('./RankPlanBody.tsx')
const coverage = read('../dayparting/CoveragePanel.tsx')

const sb = (i: number) => ({ id: `sb${i}`, name: `Brand ${i}` })

describe('readSaveAnswer — the save answer, read without trusting its shape', () => {
  it('reads id, members, enabled, added and the left-out campaigns', () => {
    expect(readSaveAnswer({ id: 'g1', members: 3, moved: 0, enabled: true, added: 2, notSponsoredProducts: [sb(1)] }))
      .toEqual({ ok: true, id: 'g1', members: 3, enabled: true, added: 2, leftOut: [sb(1)] })
  })
  it('an answer without the new fields (an older API) leaves them unknown', () => {
    expect(readSaveAnswer({ id: 'g1', members: 3, moved: 0 })).toEqual({ ok: true, id: 'g1', members: 3, enabled: undefined, added: undefined, leftOut: [] })
  })
  it('no id is not a save; junk is ignored', () => {
    expect(readSaveAnswer(null).ok).toBe(false)
    expect(readSaveAnswer({ error: 'boom' }).ok).toBe(false)
    expect(readSaveAnswer({ id: 'g', enabled: 'true', members: '3', notSponsoredProducts: [null, { name: 'x' }, { id: 7 }] }))
      .toEqual({ ok: true, id: 'g', members: undefined, enabled: undefined, added: undefined, leftOut: [{ id: '7', name: '7' }] })
  })
})

describe('a refused save says why, in the API\'s own words', () => {
  const none = 'None of the 2 campaigns is Sponsored Products: an hourly plan holds those only. Delete the plan instead.'
  it('readSaveAnswer carries the error text; a refusal is not a save', () => {
    expect(readSaveAnswer({ error: none })).toMatchObject({ ok: false, error: none })
    expect(readSaveAnswer({ error: '' }).error).toBeUndefined()
    expect(readSaveAnswer({ error: { code: 1 } }).error).toBeUndefined()
    expect(readSaveAnswer({ id: 'g' }).error).toBeUndefined()
  })
  it('🔴 the builder and the coverage strip show it; the generic line only when the API gave none', () => {
    expect(saveRefusedMessage(readSaveAnswer({ error: none }))).toBe(`Not saved. ${none}`)
    expect(saveRefusedMessage(readSaveAnswer(null))).toBe('Save failed — please retry.')
    expect(addRefusedMessage(readSaveAnswer({ error: none }))).toBe(`Not added. ${none}`)
    expect(addRefusedMessage(readSaveAnswer(null))).toBe('Could not add those campaigns — please retry.')
  })
})

describe('notSponsoredSentence — what was left out, named', () => {
  it('says nothing when nothing was left out', () => {
    expect(notSponsoredSentence([])).toBe('')
  })
  it('one, two or three are named', () => {
    expect(notSponsoredSentence([sb(1)])).toBe('"Brand 1" is not a Sponsored Products campaign, so it was left out: hourly bids change Sponsored Products only.')
    expect(notSponsoredSentence([sb(1), sb(2)])).toBe('"Brand 1" and "Brand 2" are not Sponsored Products campaigns, so they were left out: hourly bids change Sponsored Products only.')
    expect(notSponsoredSentence([sb(1), sb(2), sb(3)])).toMatch(/^"Brand 1", "Brand 2" and "Brand 3" are not Sponsored Products campaigns, so they were left out/)
  })
  it('more than three: three names and "and N more"', () => {
    expect(notSponsoredSentence([sb(1), sb(2), sb(3), sb(4), sb(5)])).toMatch(/^"Brand 1", "Brand 2", "Brand 3" and 2 more are not Sponsored Products campaigns/)
  })
})

describe('planSavedMessage — the builder\'s success line', () => {
  it('🔴 counts what the plan holds and says on or off from the answer', () => {
    expect(planSavedMessage({ name: 'IT', members: 2, enabled: true, leftOut: [] })).toMatch(/^Saved \+ armed — one schedule "IT" holding 2 campaigns on its cadence/)
    expect(planSavedMessage({ name: 'IT', members: 1, enabled: false, leftOut: [] })).toBe('Saved — one schedule "IT" over 1 campaign. Manual, so nothing runs yet; set Control to Automate to hold it.')
  })
  it('on or off unknown (kept, and an older API did not say) claims neither', () => {
    expect(planSavedMessage({ name: 'IT', members: 2, enabled: undefined, leftOut: [] })).toBe('Saved — one schedule "IT" over 2 campaigns. Whether it runs was left as it was.')
  })
  it('names what was left out', () => {
    expect(planSavedMessage({ name: 'IT', members: 2, enabled: false, leftOut: [sb(1)] })).toMatch(/hold it\. "Brand 1" is not a Sponsored Products campaign, so it was left out/)
  })
})

describe('campaignsAddedMessage — the coverage strip\'s "Add to schedule"', () => {
  it('🔴 the real count, and what was left out', () => {
    expect(campaignsAddedMessage({ added: 2, scheduleName: 'IT', leftOut: [sb(1)] }))
      .toBe('Added 2 campaigns to IT. They inherit its windows and baseline, and its enabled state — so a paused schedule still runs nothing. "Brand 1" is not a Sponsored Products campaign, so it was left out: hourly bids change Sponsored Products only.')
  })
  it('nothing added says so', () => {
    expect(campaignsAddedMessage({ added: 0, scheduleName: 'IT', leftOut: [sb(1)] })).toMatch(/^No campaign was added to IT\. "Brand 1"/)
  })
})

describe('the screens use them', () => {
  it('🔴 RankPlanBody: a refused save shows the API\'s text, reports nothing up, and the message survives the stub and the loading state', () => {
    expect(body).not.toContain("setMsg('Save failed — please retry.')")
    expect(body).toMatch(/setMsg\(saveRefusedMessage\(r\)\)\s*return undefined/)
    // onLeftOut and the resulting on/off only on the success branch
    const ok = body.indexOf('if (r.ok) {'), left = body.indexOf('onLeftOut?.('), back = body.indexOf('return on'), refused = body.indexOf('setMsg(saveRefusedMessage(r))')
    expect(ok).toBeGreaterThan(-1)
    expect(left).toBeGreaterThan(ok)
    expect(back).toBeGreaterThan(left)
    expect(refused).toBeGreaterThan(back)
    expect(body).toContain('const msgLine = msg ? <div className="h10-rp-msg">{msg}</div> : null')
    expect(body).toMatch(/<div className="h10-rgd-stub">[\s\S]*?<\/div>\{msgLine\}<\/>/)
    expect(body).toContain('<div className="h10-rp-load">Loading hourly bid plan…</div>{msgLine}')
  })
  it('RankPlanBody: members and on/off from the answer, the request only as a fallback', () => {
    expect(body).not.toContain('const n = campaigns.length')
    expect(body).toContain('const on = r.enabled ?? enabled')
    expect(body).toContain('planSavedMessage({ name: name.trim(), members: r.members ?? campaigns.length, enabled: on, leftOut: r.leftOut })')
    expect(body).toContain('readSaveAnswer(r)')
  })
  it('CoveragePanel: the answer\'s added count, not the selection size, and its list says it is Sponsored Products only', () => {
    expect(coverage).not.toMatch(/Added \$\{sel\.size\} campaign/)
    expect(coverage).toContain('campaignsAddedMessage({ added: a.added ?? sel.size, scheduleName: name, leftOut: a.leftOut })')
    expect(coverage).toContain('These Sponsored Products campaigns hold no rank schedule')
  })
  it('CoveragePanel: a refused add shows the API\'s text', () => {
    expect(coverage).toContain('if (!r.ok) { setMsg(addRefusedMessage(a)); return }')
    expect(coverage).not.toContain("setMsg('Could not add those campaigns — please retry.')")
  })
})
