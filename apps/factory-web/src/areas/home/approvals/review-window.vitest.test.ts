import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'
import { DEPTH_CASES } from './depth/fixtures'
import { InboxView } from './view/InboxView'

// The DS DetailModal opens only in a browser (after hydration, in a portal): here it draws in place — its title, its tab row's
// labels and its content — so the review window itself is checked.
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
 * B-TH-270 (threads plan TH-6, PL6; 08-tabs O-HOME-APV; picture 40): the review window of Home › Approvals drawn — two tabs (Change ·
 * Context & history), Context & history holding the approval history with its signature meanings (R1-G05: its own read), and the
 * request's thread docked in the window's right column, once, beside both tabs, office notes only (an approval has no party).
 */

const View = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
  const found = designScreen.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return render(createElement(View, { model: found.model }), locale)
}
const threadOf = (html: string) => {
  const at = html.indexOf('class="fw-apv-window-thread"')
  return at < 0 ? '' : html.slice(at)
}
const tabsOf = (html: string) => [...html.matchAll(/data-tab="([a-z]+)"/g)].map((match) => match[1])

describe('B-TH-270: the review window — Change · Context & history, the request’s thread docked in it (PL6)', () => {
  it('two tabs in the window: Change and Context & history (no Conversation, no History)', () => {
    for (const id of ['w2b-307-review', 'w2b-307-review-context', 'th-270-review-thread']) expect(tabsOf(draw(id)), id).toEqual(['change', 'context'])
    const html = draw('w2b-307-review')
    // The window (the dialog) up to its thread column: its title, its tab row, the tab's content.
    const shown = textOf(html.slice(html.indexOf('role="dialog"'), html.indexOf('class="fw-apv-window-thread"')))
    expect(shown).toContain('Context & history')
    expect(shown).not.toMatch(/\bConversation\b|\bHistory\b/)
    expect(textOf(draw('w2b-307-review', 'it'))).toContain('Contesto e cronologia')
  })

  it('Context & history keeps the facts and Open full page, then the approval history with each signature’s meaning (R1-G05)', () => {
    const text = textOf(draw('w2b-307-review-context'))
    expect(text).toContain('Approval history')
    expect(text).toContain("Marco Demo approved as 'Reviewed'")
    expect(text).toContain('Prices checked against the tannery list.')
    const it_ = textOf(draw('w2b-307-review-context', 'it'))
    expect(it_).toContain('Cronologia delle approvazioni')
    // The history is its own read (the approval history), never the thread's Changes view.
    const html = draw('w2b-307-review-context')
    expect(html.indexOf('Approval history')).toBeLessThan(html.indexOf('class="fw-apv-window-thread"'))
  })

  it('ONE thread docked in the window’s right column beside both tabs, its "⋯" holding Activity’s tools (R-ACT); no record panels', () => {
    for (const id of ['w2b-307-review', 'w2b-307-review-context', 'th-270-review-thread']) {
      const html = draw(id)
      expect(html.match(/class="fw-apv-window-thread"/g)?.length, id).toBe(1)
      expect(html.match(/class="fw-rt-column[ "]/g)?.length, id).toBe(1)
      expect(threadOf(html), id).toContain('aria-label="Thread tools"')
      expect(html, id).not.toContain('fw-rp-tabs')
    }
    // The thread follows the tab's content (the right column), never above it.
    const html = draw('th-270-review-thread')
    expect(html.indexOf('class="fw-apv-window-body"')).toBeLessThan(html.indexOf('class="fw-apv-window-thread"'))
  })

  it('an approval is internal: office notes only — no "Reply to", no e-mail, no customer in its thread (W08, W25)', () => {
    for (const locale of LOCALES) {
      const thread = textOf(threadOf(draw('th-270-review-thread', locale)))
      expect(thread.length, locale).toBeGreaterThan(20)
      expect(thread, locale).not.toMatch(/Reply to (?!the customer)|Rispondi a /)
      expect(thread, locale).not.toMatch(/@[a-z0-9-]+\.example/)
      expect(thread, locale).not.toMatch(/Brand Alpha|Brand Beta/)
    }
  })

  it('without threads.read the page passes no thread: the window is the tabs alone, no empty column, no locked box', () => {
    const found = DEPTH_CASES.find((entry) => entry.id === 'th-270-review-thread')!
    const html = render(createElement(InboxView, { model: found.model }))
    expect(textOf(html)).toContain('Context & history')
    expect(html).not.toContain('fw-apv-window')
    expect(html).not.toContain('aria-label="Thread tools"')
  })
})
