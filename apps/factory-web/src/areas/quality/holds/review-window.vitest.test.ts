import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'

// The DS DetailModal opens only in a browser (after hydration, in a portal): here it draws in place — its title, its tab row's
// labels and its content — so the hold's review window itself is checked.
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const DetailModal = ({ open, title, tabs, children }: { open: boolean; title?: unknown; tabs?: readonly { id: string; label: string }[]; children?: unknown }) =>
    open
      ? createElement(
          'section',
          { role: 'dialog' },
          createElement('h2', null, title as never),
          createElement('nav', { 'data-tabs': '' }, ...(tabs ?? []).map((tab) => createElement('span', { key: tab.id, 'data-tab': tab.id }, tab.label))),
          children as never,
        )
      : null
  return { ...actual, DetailModal }
})

/**
 * B-TH-270 (threads plan TH-6, PL6; 08-tabs O-QA-HOLD; picture 40): the hold's review window drawn — three tabs (Hold · Affected ·
 * Decision), the hold's thread docked in the window's right column, once, beside every tab, office notes only (a hold is never
 * shared), and no thread column without threads.read.
 */

const View = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
  const found = designScreen.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return render(createElement(View, { model: found.model }), locale)
}
const threadOf = (html: string) => {
  const at = html.indexOf('class="fw-hd-window-thread"')
  return at < 0 ? '' : html.slice(at)
}
const tabsOf = (html: string) => [...html.matchAll(/data-tab="([a-z]+)"/g)].map((match) => match[1])

describe('B-TH-270: the hold’s review window — Hold · Affected · Decision, the thread docked in it (PL6)', () => {
  it('three tabs in the window, no Activity', () => {
    for (const id of ['detail-hold', 'detail-decision', 'detail-thread']) expect(tabsOf(draw(id)), id).toEqual(['hold', 'affected', 'decision'])
    expect(textOf(draw('detail-hold', 'it'))).toContain('Coinvolti')
  })

  it('ONE thread docked in the window’s right column beside every tab, its "⋯" holding Activity’s tools (R-ACT); no record panels', () => {
    for (const id of ['detail-hold', 'detail-work-order', 'detail-decision', 'detail-thread', 'detail-released']) {
      const html = draw(id)
      expect(html.match(/class="fw-hd-window-thread"/g)?.length, id).toBe(1)
      expect(html.match(/class="fw-rt-column[ "]/g)?.length, id).toBe(1)
      expect(threadOf(html), id).toContain('aria-label="Thread tools"')
      expect(html, id).not.toContain('fw-rp-tabs')
      expect(html, id).toContain('class="fw-hd-window has-thread"')
    }
    // The tab's content comes first (the body column), the thread to its right.
    const html = draw('detail-thread')
    expect(html.indexOf('fw-hd-window-body')).toBeLessThan(html.indexOf('class="fw-hd-window-thread"'))
  })

  it('a hold is never shared: office notes only — no "Reply to", no e-mail, no customer in its thread (W08, W25)', () => {
    for (const locale of LOCALES) {
      const thread = textOf(threadOf(draw('detail-thread', locale)))
      expect(thread.length, locale).toBeGreaterThan(20)
      expect(thread, locale).not.toMatch(/Reply to (?!the customer)|Rispondi a /)
      expect(thread, locale).not.toMatch(/@[a-z0-9-]+\.example/)
      expect(thread, locale).not.toMatch(/Brand Alpha|Brand Beta/)
    }
  })

  it('without threads.read there is no thread column: the window is the tabs alone, no locked box', () => {
    const html = draw('detail-no-thread')
    expect(html).toContain('class="fw-hd-window"')
    expect(html).not.toContain('fw-hd-window-thread')
    expect(html).not.toContain('aria-label="Thread tools"')
  })
})
