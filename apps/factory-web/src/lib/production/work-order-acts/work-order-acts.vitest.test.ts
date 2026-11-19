import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, textOf } from '../../record-thread/parts/testing'
import { designScreen } from '../../../areas/sales/orders/record/fixtures'
import type { WorkOrderActsModel } from './use-work-order-acts'
import { WorkOrderActsDialogs } from './view/WorkOrderActsDialogs'

// The DS Modal draws only after it mounts in a browser: here a plain section, so a dialog's words are read on the server too (as the
// daily page's dialog tests do).
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-OP-114 / F-OP-115 (10-order-page §5.2; review R-16) — the dialogs a work-order row's ⋯ opens on the order page, drawn from the
 * order record's design cases (made-up data). Cancel… with pieces cut says the API's own words and offers nothing to pick; Hold…
 * and Release… are the lib's one copy.
 */
const actsOf = (id: string): WorkOrderActsModel => (designScreen.cases.find((item) => item.id === id)!.model as { record: { workOrderActs: WorkOrderActsModel } }).record.workOrderActs
const draw = (id: string, locale: 'en' | 'it' = 'en') => render(createElement(WorkOrderActsDialogs, { model: actsOf(id) }), locale)

describe('F-OP-115: Cancel… from a work-order row (R-16)', () => {
  it('pieces cut: the API’s words that name the way out, no outcome picker and no reason to type; Cancel held with the same words', () => {
    const html = draw('wo-cancel-cut')
    const text = textOf(html)
    expect(text).toContain('8 pieces are cut: lower the work order to the cut instead')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('<textarea')
    expect(text).toContain('Cancel work order')
    // What stays with it: the stock issued to it (until returned by hand).
    expect(text).toContain('Issued to it (it stays on it until returned by hand): DEMO-LEATHER-BLK 96.0 dm2')
    expect(textOf(draw('wo-cancel-cut', 'it'))).toContain("8 pezzi sono già tagliati: riduci l'ordine di lavoro al tagliato")
  })

  it('nothing cut: the reason is asked, then Cancel work order', () => {
    const html = draw('wo-cancel-draft')
    expect(html).toContain('<textarea')
    expect(textOf(html)).toContain('The draft stops; its pieces go back to the order lines.')
    expect(textOf(html)).not.toContain('pieces are cut')
  })
})

describe('F-OP-114: Hold… and Release… from a work-order row — the lib’s one copy', () => {
  it('Hold…: both reason lists as groups, the floor’s words, how it is lifted', () => {
    const html = draw('wo-hold-dialog')
    expect(html).toContain('<optgroup')
    const text = textOf(html)
    expect(text).toContain('Floor tablets refuse to start it and show the reason.')
    expect(textOf(draw('wo-hold-dialog', 'it'))).toContain('I tablet del reparto rifiutano di avviarlo e mostrano il motivo.')
  })

  it('Release…: the release check in the dialog, each condition in words, the open ones holding it', () => {
    const text = textOf(draw('wo-release-dialog'))
    for (const words of ['Release check', 'Style revision', 'Bill of materials', 'Sizes', 'Deposit']) expect(text, words).toContain(words)
    expect(text).toContain('Taking it back: cancel it with a reason; a different spec is a new work order.')
  })

  it('no key is left in either language', () => {
    for (const id of ['wo-cancel-cut', 'wo-cancel-draft', 'wo-hold-dialog', 'wo-release-dialog'])
      for (const locale of ['en', 'it'] as const) expect(textOf(draw(id, locale)), `${id} ${locale}`).not.toMatch(/\b(wo|hold|release|cancel|check|held|production)\.[a-zA-Z]+/)
  })
})
