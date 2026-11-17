import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { REMINDERS } from './demo/fixtures'
import { designScreen } from './fixtures'

// The DS DetailModal opens only in a browser (after hydration, in a portal): here it draws in place — its title and its content — so
// the reminder's window itself is checked (as quality/holds/review-window.vitest does).
vi.mock('@nexus/ui/patterns', async (original) => {
  const actual = await original<typeof import('@nexus/ui/patterns')>()
  const DetailModal = ({ open, title, children }: { open: boolean; title?: unknown; children?: unknown }) => (open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), children as never) : null)
  return { ...actual, DetailModal }
})

/**
 * B-TH-271 (threads plan TH-6, PL6; O-FIN-REM.thread; picture 40): the payment reminder's own thread docked in its window, so a
 * customer's answer to a reminder is seen where it is approved — its customer's only ("Reply to <customer>"), never folded, no
 * thread column without threads.read; A (approve) stays quiet inside the thread.
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

describe('B-TH-271: the reminder’s thread docked in its window (PL6)', () => {
  it('ONE thread in the window’s right column, after the reminder, its "⋯" holding Activity’s tools (R-ACT)', () => {
    for (const id of ['reminder', 'reminder-thread', 'reminder-edit']) {
      const html = draw(id)
      expect(html.match(/class="fw-rw-thread"/g)?.length, id).toBe(1)
      expect(html.match(/class="fw-rt-column[ "]/g)?.length, id).toBe(1)
      expect(threadOf(html), id).toContain('aria-label="Thread tools"')
      expect(html, id).toContain('class="fw-rw has-thread"')
    }
    const html = draw('reminder-thread')
    expect(html.indexOf('class="fw-rw-body"')).toBeLessThan(html.indexOf('class="fw-rw-thread"'))
  })

  it('the brand wall: the thread names the reminder’s own customer only, never another (W08, W20, W21, W25, W34)', () => {
    const customer = REMINDERS[1]!.customer
    for (const locale of LOCALES) {
      const thread = textOf(threadOf(draw('reminder-thread', locale)))
      expect(thread, locale).toContain(customer.name)
      for (const other of REMINDERS.map((entry) => entry.customer.name).filter((name) => name !== customer.name)) expect(thread, `${locale} ${other}`).not.toContain(other)
      expect(thread, locale).not.toMatch(new RegExp(`${BRAND_ALPHA.tradeName}|${BRAND_BETA.tradeName}`))
    }
  })

  it('a customer’s thread never folds (its answer must be seen), and without threads.read the window is the reminder alone', () => {
    expect(draw('reminder-thread')).not.toContain('is-folded')
    const html = draw('reminder-no-thread')
    expect(html).toContain('class="fw-rw"')
    expect(html).not.toContain('fw-rw-thread')
  })

  it('the page mounts the reminder’s thread docked with its customer (partyRole customer), with threads.read; A stays quiet inside it', () => {
    const page = readFileSync(new URL('./ReceivablesPage.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/<OfficeRecordThread\s+key=\{openReminder\.id\}\s+docked/)
    expect(page).toContain("type: 'PaymentReminder'")
    expect(page).toContain('party={{ id: openReminder.customer.id, name: openReminder.customer.name }}')
    expect(page).toContain('partyRole="customer"')
    expect(page).toContain("session.permissions.includes('threads.read')")
    const dialog = readFileSync(new URL('./view/ReminderDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain('if (inWindowThread(target)) return')
    expect(dialog).toContain('<ReviewWindow')
  })
})
