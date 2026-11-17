import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'

// The DS DetailModal opens only in a browser (after hydration, in a portal): here it draws in place — its title and its content — so
// the request's detail window itself is checked (as quality/holds/review-window.vitest does).
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const DetailModal = ({ open, title, children }: { open: boolean; title?: unknown; children?: unknown }) => (open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never) : null)
  return { ...actual, DetailModal }
})

/**
 * B-TH-271 (threads plan TH-6, PL6; O-PLT-REQ.thread; picture 40): the maintenance request's own thread docked in its detail window —
 * office notes only (no party), once, beside the content; an empty thread folds to a slim "Add a note" column; no thread column
 * without threads.read; the window's keys stay quiet inside the thread.
 */

const View = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
  const found = designScreen.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return render(createElement(View, { model: found.model }), locale)
}
const threadOf = (html: string) => {
  const at = html.indexOf('class="fw-rw-thread"')
  return at < 0 ? '' : html.slice(at)
}

describe('B-TH-271: the request’s notes docked in its detail window (PL6)', () => {
  it('ONE thread in the window’s right column, after the content, its "⋯" holding Activity’s tools (R-ACT)', () => {
    for (const id of ['detail-thread', 'detail-unsafe', 'detail-duplicate', 'detail-fixed']) {
      const html = draw(id)
      expect(html.match(/class="fw-rw-thread"/g)?.length, id).toBe(1)
      expect(html.match(/class="fw-rt-column[ "]/g)?.length, id).toBe(1)
      expect(threadOf(html), id).toContain('aria-label="Thread tools"')
      expect(html, id).toContain('class="fw-rw has-thread"')
    }
    const html = draw('detail-thread')
    expect(html.indexOf('class="fw-rw-body"')).toBeLessThan(html.indexOf('class="fw-rw-thread"'))
    expect(html).toContain('aria-label="Notes on the')
  })

  it('a maintenance request has no party: office notes only — no "Reply to", no e-mail, no customer (W08, W25)', () => {
    for (const locale of LOCALES) {
      const thread = textOf(threadOf(draw('detail-thread', locale)))
      expect(thread.length, locale).toBeGreaterThan(20)
      expect(thread, locale).not.toMatch(/Reply to (?!the customer)|Rispondi a /)
      expect(thread, locale).not.toMatch(/@[a-z0-9-]+\.example/)
      expect(thread, locale).not.toMatch(/Brand Alpha|Brand Beta/)
    }
  })

  it('no notes yet: the thread folds to a slim "Add a note" column (the thread stays mounted, hidden, to say when it fills)', () => {
    const html = draw('detail-thread-empty')
    expect(html).toContain('class="fw-rw has-thread is-folded"')
    expect(textOf(threadOf(html))).toContain('Add a note')
    expect(html).toMatch(/class="fw-rw-thread-inner" hidden=""/)
    expect(textOf(threadOf(draw('detail-thread-empty', 'it')))).toContain('Aggiungi una nota')
  })

  it('without threads.read there is no thread column: the window is its content alone', () => {
    const html = draw('detail-no-thread')
    expect(html).toContain('class="fw-rw"')
    expect(html).not.toContain('fw-rw-thread')
    expect(html).not.toContain('aria-label="Thread tools"')
  })

  it('the page mounts the request’s thread docked, notes only, with threads.read; the window’s keys stay quiet inside it', () => {
    const page = readFileSync(new URL('./RequestsPage.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/<OfficeRecordThread\s+key=\{opened\.id\}\s+docked/)
    expect(page).toContain("type: 'MaintenanceRequest'")
    expect(page).toContain('party={null}')
    expect(page).toContain("session.permissions.includes('threads.read')")
    expect(page).toContain('onEmpty={setThreadEmpty}')
    const detail = readFileSync(new URL('./view/RequestDetail.tsx', import.meta.url), 'utf8')
    expect(detail).toContain('if (inWindowThread(target)) return')
    expect(detail).toContain('<ReviewWindow')
  })
})
