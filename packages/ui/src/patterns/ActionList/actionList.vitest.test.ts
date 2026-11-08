import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ActionList, type ActionGroup, type ActionItem } from './ActionList'
import { ACTION_LIST_LABELS } from './ActionListLabels'
import { actionDueView, actionListCounts, sortActionItems } from './actionListModel'

const NOW = Date.parse('2026-11-07T09:00:00Z')
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()
const noop = () => {}

const item = (id: string, state: 'overdue' | 'today' | 'soon' | 'later' | 'none', hours: number, extra: Partial<ActionItem> = {}): ActionItem => ({
  id,
  title: `Request ${id}`,
  due: state === 'none' ? null : { at: at(hours), state, text: state === 'later' ? '12 Nov' : state === 'overdue' ? '3 Nov' : undefined },
  verb: { label: 'Confirm', kind: 'inline', onRun: noop },
  ...extra,
})

describe('sortActionItems', () => {
  it('puts overdue first, then today, soon, later and none; earlier due first; ties keep their order', () => {
    const items = [item('n', 'none', 0), item('l', 'later', 200), item('s2', 'soon', 30), item('o', 'overdue', -50), item('s1', 'soon', 20), item('t', 'today', 3), item('n2', 'none', 0)]
    expect(sortActionItems(items).map((i) => i.id)).toEqual(['o', 't', 's1', 's2', 'l', 'n', 'n2'])
    expect(items[0].id).toBe('n') // input untouched
  })
})

describe('actionListCounts — the one model for the list and the rail badges', () => {
  it('counts what still waits, overdue and due soon, per group; a done row no longer counts', () => {
    const groups = [
      { id: 'orders', items: [item('a', 'overdue', -5), item('b', 'today', 2), item('c', 'later', 100, { done: { words: 'Confirmed.' } })] },
      { id: 'docs', items: [item('d', 'soon', 30), item('e', 'none', 0)] },
      { id: 'empty', items: [] },
    ]
    expect(actionListCounts(groups)).toEqual({ open: 4, overdue: 1, dueSoon: 2, byGroup: { orders: 2, docs: 2, empty: 0 } })
  })
})

describe('actionDueView', () => {
  it('overdue → the danger word; today / soon → a countdown; later → the date (a countdown without one); none → nothing', () => {
    expect(actionDueView({ at: at(-5), state: 'overdue', text: '3 Nov' })).toEqual({ kind: 'overdue', text: '3 Nov' })
    expect(actionDueView({ at: at(2), state: 'today' })).toEqual({ kind: 'countdown', at: at(2), tone: 'warning' })
    expect(actionDueView({ at: at(30), state: 'soon' })).toEqual({ kind: 'countdown', at: at(30), tone: 'info' })
    expect(actionDueView({ at: at(200), state: 'later', text: '12 Nov' })).toEqual({ kind: 'date', text: '12 Nov' })
    expect(actionDueView({ at: at(200), state: 'later' })).toEqual({ kind: 'countdown', at: at(200), tone: 'info' })
    expect(actionDueView({ at: at(0), state: 'none' })).toEqual({ kind: 'none' })
    expect(actionDueView(null)).toEqual({ kind: 'none' })
  })
})

describe('ActionList markup', () => {
  const groups: ActionGroup[] = [
    {
      id: 'orders',
      label: 'Orders to confirm',
      items: [
        item('later', 'later', 200, { meta: 'Asked by Anna Rossi' }),
        item('late', 'overdue', -50),
        item('soon', 'today', 5, { verb: { label: 'Sign', kind: 'dialog', onRun: noop } }),
        item('link', 'none', 0, { verb: { label: 'Open', kind: 'link', href: '/p/x/open/PurchaseOrder/1' } }),
        item('held', 'none', 0, { verb: { label: 'Upload', kind: 'inline', onRun: noop, heldReason: 'Only your quality team can upload this.' } }),
        item('done', 'none', 0, { done: { words: 'Confirmed. The office is told.', onUndo: noop } }),
      ],
    },
    { id: 'empty', label: 'Never shown', items: [] },
  ]
  const html = renderToStaticMarkup(createElement(ActionList, { groups, now: NOW }))

  it('a section per group with items, its heading and how many still wait', () => {
    expect(html).toMatch(/<section class="nds-actions-group" aria-labelledby="([^"]+)"><div class="nds-actions-head"><h3 id="\1" class="nds-actions-heading">Orders to confirm<\/h3><span class="nds-actions-count">5 to do<\/span>/)
    expect(html).not.toContain('Never shown')
  })

  it('rows are sorted overdue first and say the due in words', () => {
    const titles = [...html.matchAll(/class="nds-actions-title">([^<]+)</g)].map((m) => m[1])
    expect(titles[0]).toBe('Request late')
    expect(titles[1]).toBe('Request soon')
    expect(html).toContain('Overdue since 3 Nov')
    expect(html).toContain('Due 12 Nov')
    expect(html).toContain('Due in 5 h')
    expect(html).toContain('Asked by Anna Rossi')
  })

  it('a dialog verb says it opens a dialog; a link verb is a real link; a held verb says why', () => {
    expect(html).toMatch(/<button type="button" class="nds-btn" aria-haspopup="dialog">Sign<\/button>/)
    expect(html).toMatch(/<a href="\/p\/x\/open\/PurchaseOrder\/1" class="nds-btn">Open<\/a>/)
    expect(html).toMatch(/aria-disabled="true" aria-description="Only your quality team can upload this."/)
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it('a done row shows the words and Undo instead of the verb, and announces the words', () => {
    expect(html).toContain('<span class="nds-actions-done">Confirmed. The office is told.</span>')
    expect(html).toMatch(/<span class="nds-vh" aria-live="polite" aria-atomic="true">Confirmed. The office is told.<\/span>/)
    expect(html).toContain('>Undo</button>')
  })

  it('says so when nothing waits, and takes the host words', () => {
    expect(renderToStaticMarkup(createElement(ActionList, { groups: [] }))).toContain(`<p class="nds-actions-empty">${ACTION_LIST_LABELS.empty}</p>`)
    const it2 = renderToStaticMarkup(
      createElement(ActionList, {
        groups: [{ id: 'g', label: 'Ordini', items: [item('x', 'overdue', -10)] }],
        labels: { groupCount: (n: number) => `${n} da fare`, overdue: (d?: string) => `In ritardo dal ${d}` },
      }),
    )
    expect(it2).toContain('1 da fare')
    expect(it2).toContain('In ritardo dal 3 Nov')
  })
})
