import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FloorChecklist, type FloorChecklistAnswer, type FloorChecklistGroup } from './FloorChecklist'
import { FLOOR_CHECKLIST_LABELS } from './FloorChecklistLabels'
import { checklistHeld, checklistProgress, groupPassIds, groupState, nextOpenGroup, withGroupPassed } from './floorChecklistModel'

/** B-W2b-78 — FloorChecklist. Made-up checks. */
const GROUPS: FloorChecklistGroup[] = [
  {
    id: 'labels',
    label: 'Labels',
    items: [
      { id: 'ce', label: 'CE mark' },
      { id: 'care', label: 'Care label', hint: 'Inside the collar' },
      { id: 'origin', label: 'Origin claim', required: false },
    ],
  },
  { id: 'armour', label: 'Armour', items: [{ id: 'fit', label: 'Protectors fitted' }, { id: 'size', label: 'Right size', heldReason: 'Scan the protector first' }] },
]
type Answers = Record<string, FloorChecklistAnswer | undefined>
const W = FLOOR_CHECKLIST_LABELS
const noop = () => {}

describe('checklist rules', () => {
  it('group states: open, partly, passed (every required check), failed', () => {
    expect(groupState(GROUPS[0]!, {})).toBe('open')
    expect(groupState(GROUPS[0]!, { ce: { result: 'pass' } })).toBe('partly')
    expect(groupState(GROUPS[0]!, { ce: { result: 'pass' }, care: { result: 'pass' } })).toBe('passed')
    expect(groupState(GROUPS[0]!, { ce: { result: 'fail' } })).toBe('failed')
  })
  it('Group passes passes only what is not answered and not held; a failed check stays failed', () => {
    const answers: Answers = { ce: { result: 'fail' } }
    expect(groupPassIds(GROUPS[0]!, answers)).toEqual(['care', 'origin'])
    expect(groupPassIds(GROUPS[1]!, {})).toEqual(['fit'])
    const after = withGroupPassed(GROUPS[0]!, answers, () => ({ result: 'pass' as const }))
    expect(after.ce?.result).toBe('fail')
    expect(after.care?.result).toBe('pass')
  })
  it('the main action is held until every required check is answered, naming what is left; nothing listed holds', () => {
    expect(checklistHeld(GROUPS, {}, W)).toBe('4 required checks left: CE mark, Care label, Protectors fitted, Right size')
    const all: Answers = { ce: { result: 'pass' }, care: { result: 'fail' }, fit: { result: 'pass' }, size: { result: 'pass' } }
    expect(checklistHeld(GROUPS, all, W)).toBeNull()
    expect(checklistHeld([], {}, W)).toBe('No checks are listed')
    expect(checklistProgress(GROUPS, all)).toMatchObject({ groups: 2, groupsDone: 2, failed: 1, passed: 3, answered: 4, total: 5 })
  })
  it('the next group not done, wrapping', () => {
    expect(nextOpenGroup(GROUPS, { ce: { result: 'pass' }, care: { result: 'pass' } }, 'labels')).toBe('armour')
    expect(nextOpenGroup(GROUPS, { fit: { result: 'pass' }, size: { result: 'pass' } }, 'armour')).toBe('labels')
    expect(nextOpenGroup(GROUPS, { ce: { result: 'pass' }, care: { result: 'pass' }, fit: { result: 'pass' }, size: { result: 'pass' } }, 'labels')).toBeNull()
  })
})

describe('FloorChecklist', () => {
  const base = { groups: GROUPS, onPass: noop, onFail: noop, onPassGroup: noop }
  it('the group strip with states in words, one group’s checks with Pass and Fail, the answer in words with who and when', () => {
    const html = render(
      h(FloorChecklist, { ...base, answers: { ce: { result: 'pass', by: 'Marta Demo', at: '10:42' }, care: { result: 'fail', reasonLabel: 'Label missing', photo: true } } }),
    )
    for (const word of ['Labels', 'Armour', 'Failed', 'Not started', 'CE mark', 'Inside the collar', 'Passed · Marta Demo · 10:42', 'Failed: Label missing · with photo', 'Not checked · Optional', 'Group passes', '1 failed', '1 of 2 groups done']) expect(html).toContain(word)
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('role="group"')
    expect(html).toContain('role="status"')
  })
  it('the main action is held with what is left on screen; a held check says why and holds only itself', () => {
    const html = render(h(FloorChecklist, { ...base, answers: {}, group: 'armour', action: { label: 'Sign the result', onClick: noop } }))
    expect(html).toContain('class="nds-fcl-held">4 required checks left: CE mark, Care label, Protectors fitted, Right size')
    expect(html).toContain('Scan the protector first')
    expect(html).not.toContain(' disabled=""')
    const done = render(h(FloorChecklist, { ...base, answers: { ce: { result: 'pass' }, care: { result: 'pass' }, fit: { result: 'pass' }, size: { result: 'pass' } }, action: { label: 'Sign the result', onClick: noop } }))
    expect(done).not.toContain('required checks left')
  })
  it('the whole list held: every button held with the reason on screen; Group passes held when nothing is left', () => {
    const held = render(h(FloorChecklist, { ...base, answers: {}, heldReason: 'Waiting for the work order' }))
    expect(held).toContain('class="nds-fcl-held">Waiting for the work order')
    expect((held.match(/aria-disabled="true"/g) ?? []).length).toBeGreaterThanOrEqual(7)
    const answered = render(h(FloorChecklist, { ...base, answers: { ce: { result: 'pass' }, care: { result: 'pass' }, origin: { result: 'pass' } } }))
    expect(answered).toContain('aria-description="Every check in this group is answered"')
  })
  it('one group: no strip; speaks the host’s language', () => {
    const one = render(h(FloorChecklist, { ...base, groups: [GROUPS[0]!], answers: {}, labels: { pass: 'Conforme', fail: 'Non conforme', groupPasses: 'Gruppo conforme' } }))
    expect(one).not.toContain('role="group"')
    expect(one).toContain('Conforme')
    expect(one).toContain('Gruppo conforme')
  })
})
