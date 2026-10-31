import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SelectableCard, SelectableCardGroup } from './SelectableCard'
import { cardMove, cardTabStop, cardToggle } from './selectableCardModel'

/** B-W2b-09 — SelectableCard: a card that is one control; picked by frame, tick and word; held with its reason. */
const OPTIONS = [{ id: 'L1' }, { id: 'L2', held: 'Closed today' }, { id: 'L3' }]

describe('selectableCardModel', () => {
  it('puts the one Tab stop on the picked card, else the first that may be picked', () => {
    expect(cardTabStop(OPTIONS, 'L3')).toBe('L3')
    expect(cardTabStop(OPTIONS, null)).toBe('L1')
    expect(cardTabStop([{ id: 'A', held: 'x' }, { id: 'B' }], null)).toBe('B')
  })
  it('moves with the arrows, skipping held cards, wrapping, mirrored right to left', () => {
    expect(cardMove(OPTIONS, 'L1', 'ArrowRight')).toBe('L3')
    expect(cardMove(OPTIONS, 'L3', 'ArrowDown')).toBe('L1')
    expect(cardMove(OPTIONS, 'L1', 'ArrowUp')).toBe('L3')
    expect(cardMove(OPTIONS, 'L1', 'ArrowLeft', true)).toBe('L3')
    expect(cardMove(OPTIONS, 'L3', 'Home')).toBe('L1')
    expect(cardMove(OPTIONS, 'L1', 'End')).toBe('L3')
    expect(cardMove([{ id: 'A', held: 'x' }], 'A', 'ArrowDown')).toBeNull()
  })
  it('toggles in a multiple group, never a held card', () => {
    expect(cardToggle(['L1'], 'L3', OPTIONS)).toEqual(['L1', 'L3'])
    expect(cardToggle(['L1', 'L3'], 'L1', OPTIONS)).toEqual(['L3'])
    expect(cardToggle(['L1'], 'L2', OPTIONS)).toEqual(['L1'])
  })
})

describe('SelectableCard', () => {
  it('is a toggle button that says it is picked in words', () => {
    const html = render(h(SelectableCard, { title: 'L1 · Jackets', selected: true, onSelect: () => {} }, 'Running · 120 / 180'))
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('>Selected<')
    expect(html).toContain('Running · 120 / 180')
  })
  it('stays focusable when held and says why', () => {
    const html = render(h(SelectableCard, { title: 'L2', selected: false, onSelect: () => {}, heldReason: 'Closed today', labels: { selected: 'Scelta' } }))
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('aria-description="Closed today"')
    expect(html).not.toContain('disabled=""')
  })
  it('is a radio group with one Tab stop in single mode, toggles in multiple mode', () => {
    const single = render(h(SelectableCardGroup, { label: 'Lines', mode: 'single', value: 'L3', onChange: () => {}, options: OPTIONS.map((o) => ({ ...o, title: o.id })) }))
    expect(single).toContain('role="radiogroup" aria-label="Lines"')
    expect(single.match(/role="radio"/g)).toHaveLength(3)
    expect(single.match(/tabindex="0"/g)).toHaveLength(1)
    expect(single).toContain('aria-checked="true"')
    const multiple = render(h(SelectableCardGroup, { label: 'Lines', mode: 'multiple', value: ['L1'], onChange: () => {}, options: OPTIONS.map((o) => ({ ...o, title: o.id })) }))
    expect(multiple).toContain('role="group"')
    expect(multiple.match(/aria-pressed="true"/g)).toHaveLength(1)
  })
})
