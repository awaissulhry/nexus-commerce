import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MilestoneTracker } from './MilestoneTracker'
import { MILESTONE_TRACKER_LABELS } from './MilestoneTrackerLabels'
import { milestoneCurrentIndex, milestoneViews, promiseMoves, type MilestoneStep } from './milestoneTrackerModel'

/** B-W2b-155 — MilestoneTracker: customer-word steps with dates, the current step, the promise and how it moved. */
const ORDER: MilestoneStep[] = [
  { id: 'REQUESTED', label: 'Requested', state: 'done', date: '1 Nov' },
  { id: 'CONFIRMED', label: 'Confirmed', state: 'done', date: '2 Nov' },
  { id: 'IN_PRODUCTION', label: 'In production', state: 'todo', current: true, expected: '12 Nov' },
  { id: 'READY', label: 'Ready', state: 'todo' },
  { id: 'SHIPPED', label: 'Shipped', state: 'partly', date: '5 Nov' },
  { id: 'DELIVERED', label: 'Delivered', state: 'skipped' },
]

describe('milestoneCurrentIndex', () => {
  it('the step marked current wins (the API\'s `current`, or state current)', () => {
    expect(milestoneCurrentIndex(ORDER)).toBe(2)
    expect(milestoneCurrentIndex([{ id: 'a', label: 'a', state: 'done' }, { id: 'b', label: 'b', state: 'current' }])).toBe(1)
  })
  it('else the first step to come after the last one reached; none when everything after it is done or skipped', () => {
    expect(milestoneCurrentIndex([{ id: 'a', label: 'a', state: 'done' }, { id: 'b', label: 'b', state: 'todo' }, { id: 'c', label: 'c', state: 'todo' }])).toBe(1)
    expect(milestoneCurrentIndex([{ id: 'a', label: 'a', state: 'done' }, { id: 'b', label: 'b', state: 'done' }])).toBe(-1)
    expect(milestoneCurrentIndex([{ id: 'a', label: 'a', state: 'todo' }])).toBe(0)
    expect(milestoneCurrentIndex([])).toBe(-1)
  })
})

describe('milestoneViews', () => {
  it('each step in words: done on a day, partly, now with an estimate (never a promise), skipped', () => {
    expect(milestoneViews(ORDER, MILESTONE_TRACKER_LABELS).map((v) => [v.shown, v.detail])).toEqual([
      ['done', 'Done · 1 Nov'],
      ['done', 'Done · 2 Nov'],
      ['current', 'Now · Usually by 12 Nov'],
      ['todo', 'To come'],
      ['partly', 'Partly · 5 Nov'],
      ['skipped', 'Skipped'],
    ])
  })
})

describe('promiseMoves', () => {
  it('counts moves, not the first date set', () => {
    expect(promiseMoves({ date: '14 Nov', history: [{ on: '1 Nov', to: '10 Nov' }, { on: '3 Nov', from: '10 Nov', to: '14 Nov', reason: 'Material delivery late' }] })).toBe(1)
    expect(promiseMoves({ date: '14 Nov' })).toBe(0)
    expect(promiseMoves(null)).toBe(0)
  })
})

describe('MilestoneTracker markup', () => {
  const html = renderToStaticMarkup(
    createElement(MilestoneTracker, {
      steps: ORDER,
      label: 'Avanzamento dell’ordine',
      promise: { date: '14 nov', history: [{ on: '1 nov', to: '10 nov' }, { on: '3 nov', from: '10 nov', to: '14 nov', reason: 'Consegna dei materiali in ritardo' }] },
      labels: { moved: (n: number) => `Data spostata ${n} volte`, promised: (d: string) => `Promessa per il ${d}` },
    }),
  )
  it('an ordered list named by the page; the current step is aria-current="step"', () => {
    expect(html).toContain('<ol class="nds-milestones-list" aria-label="Avanzamento dell’ordine">')
    expect(html).toMatch(/<li class="nds-milestone" data-state="current" aria-current="step">.*In production/)
    expect((html.match(/aria-current="step"/g) ?? []).length).toBe(1)
  })
  it('every state is a word as well as a mark', () => {
    for (const word of ['Done · 1 Nov', 'Now · Usually by 12 Nov', 'To come', 'Partly · 5 Nov', 'Skipped']) expect(html).toContain(word)
    expect(html).toMatch(/<span class="nds-milestone-mark" aria-hidden="true">/)
  })
  it('the promise with its history in a disclosure, the reason with each move', () => {
    expect(html).toContain('Promessa per il 14 nov')
    expect(html).toContain('<summary>Data spostata 1 volte</summary>')
    expect(html).toContain('1 nov: set to 10 nov')
    expect(html).toContain('3 nov: 10 nov → 14 nov')
    expect(html).toContain('Consegna dei materiali in ritardo')
  })
  it('compact: dots, the current step\'s name and its place, the full list for a screen reader', () => {
    const compact = renderToStaticMarkup(createElement(MilestoneTracker, { steps: ORDER, layout: 'compact' }))
    expect(compact).toContain('data-layout="compact"')
    expect((compact.match(/class="nds-milestones-dot"/g) ?? []).length).toBe(6)
    expect(compact).toContain('In production')
    expect(compact).toContain('Step 3 of 6')
    expect(compact).toContain('<ol class="nds-vh" aria-label="Progress">')
  })
  it('compact is no size container (in a row\'s flex line it would shrink to nothing)', () => {
    const css = readFileSync(fileURLToPath(new URL('./milestoneTracker.css', import.meta.url)), 'utf8')
    expect(css).toMatch(/\.nds-milestones\[data-layout='compact'\] \{\s*container-type: normal;/)
  })
  it('no steps: nothing', () => {
    expect(renderToStaticMarkup(createElement(MilestoneTracker, { steps: [] }))).toBe('')
  })
})
