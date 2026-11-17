import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { textOf } from '../../../lib/record-thread/parts/testing'
import { invoice } from '../_demo/fixtures'
import { designScreen as invoiceScreen } from './record/fixtures'
import { MERGED_TABS, RECORD_TABS, tabOf } from './record/record-model'

/**
 * B-TH-268 — the invoice on the record frame (O-FIN-INV; the rule of picture 38, the tabs of 08-tabs.tsv): the band in the area row,
 * ONE thread docked beside the three tabs (its customer's own: the API's thread party is the invoice's buyer), Activity's tools in the
 * thread's "⋯" (R-ACT), SDI status and Documents merged into "SDI & documents" (R-1: Make the files, the FatturaPA XML, the courtesy
 * PDF all stay), one notice in the body column, every old address (R-8).
 */

const screen = invoiceScreen as unknown as DesignScreen<unknown>
function render(id: string, locale: (typeof LOCALES)[number] = 'en'): string {
  const found = screen.cases.find((item) => item.id === id)
  if (!found) throw new Error(`no case ${id}`)
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: found.model })))
}
// The words a reader sees: renderToString writes `&` as `&amp;` ("Lines &amp; VAT"), so the entities come back (textOf).
const text = (html: string) => textOf(html)
const dockOf = (html: string) => html.slice(html.indexOf('class="fw-rcf-dock"'))

describe('B-TH-268: the invoice on RecordFrame — Lines & VAT · Deposits & payments · SDI & documents', () => {
  it('three tabs; every old ?tab= keeps working (R-8): Documents → SDI & documents, Activity → Lines & VAT with the thread opened', () => {
    expect(RECORD_TABS).toEqual(['lines', 'money', 'sdi'])
    expect(MERGED_TABS).toEqual({ documents: 'sdi', activity: 'lines' })
    expect(tabOf('documents')).toBe('sdi')
    expect(tabOf('sdi')).toBe('sdi')
    expect(tabOf('money')).toBe('money')
    expect(tabOf('activity')).toBe('lines')
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(tabOf(name)).toBe('lines')
    expect(tabOf(null)).toBe('lines')
    expect(tabOf('nope')).toBe('lines')
    const words = text(render('thread-docked'))
    for (const tab of ['Lines & VAT', 'Deposits & payments', 'SDI & documents']) expect(words).toContain(tab)
    expect(words).not.toMatch(/\bActivity\b/)
    expect(text(render('thread-docked', 'it'))).toContain('SDI e documenti')
  })

  it('SDI & documents keeps both tabs’ work: where it is at SDI, then the legal XML, the courtesy PDF, the DDT; Make the files when pending', () => {
    const delivered = text(render('documents'))
    expect(delivered).toContain('SDI & documents')
    for (const word of ['FatturaPA', 'courtesy copy']) expect(delivered).toContain(word)
    const pending = text(render('files-pending'))
    expect(pending).toContain('Make the files')
    // A draft: ONE card says it is not at SDI yet and its files are made at issue (no second, empty Documents card).
    const sdiTab = readFileSync(new URL('./record/view/SdiTab.tsx', import.meta.url), 'utf8')
    expect(sdiTab).toContain("description={`${t('sdi.draft.body')} ${t('docs.draft.body')}`}")
    expect(readFileSync(new URL('./record/view/DocumentsTab.tsx', import.meta.url), 'utf8')).not.toContain("t('docs.draft.title')")
    const view = readFileSync(new URL('./record/view/InvoiceRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toMatch(/model\.tab === 'sdi' && \(\s*<div className="fw-fin-stack">\s*<SdiTab[\s\S]*?\/>\s*<DocumentsTab/)
    expect(view).not.toMatch(/model\.tab === 'documents'/)
    // The XML, the PDF and Make the files stay in the band's ⋯ too (every action kept, R-6).
    expect(view).toContain("t('action.downloadXml')")
    expect(view).toContain("t('action.downloadPdf')")
    expect(view).toContain("t('action.makeFiles')")
    // The XML page's "back to the invoice" link (?tab=documents) lands on the merged tab.
    expect(tabOf('documents')).toBe('sdi')
  })

  it('ONE thread docked beside every tab, its "⋯" (R-ACT) on each; no Activity tab, no record panels, no dock hook', () => {
    for (const id of ['draft-ready', 'money', 'documents', 'rejected', 'thread-docked']) {
      const html = render(id)
      expect(html.match(/class="fw-rcf-dock"/g)?.length, id).toBe(1)
      expect(html, id).toContain('aria-label="Thread tools"')
      expect(html, id).not.toContain('fw-rp-tabs')
      expect(html, id).not.toContain('?tab=activity')
      expect(html, id).not.toContain('fw-fin-dock')
    }
    const container = readFileSync(new URL('./record/InvoiceRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain('party={{ id: value.buyerPartyId, name: value.party.legalName }} partyRole="customer"')
    expect(container).toContain("session.permissions.includes('threads.read')")
    expect(container).not.toContain('useThreadDock')
    const view = readFileSync(new URL('./record/view/InvoiceRecordView.tsx', import.meta.url), 'utf8')
    expect(view).not.toContain('RecordPanelsView')
    expect(view).not.toContain('onDock')
    const hooks = readFileSync(new URL('../_shared/hooks.ts', import.meta.url), 'utf8')
    expect(hooks).not.toContain('export function useThreadDock')
    expect(hooks).not.toContain('?tab=activity`')
  })

  it('no thread without threads.read, and none while the invoice is read or out of reach', () => {
    for (const id of ['thread-none', 'loading', 'error', 'not-found', 'no-permission']) {
      const html = render(id)
      expect(html, id).not.toContain('class="fw-rcf-dock"')
      expect(html, id).not.toContain('aria-keyshortcuts="Meta+J Control+J"')
    }
  })

  it('SDI could not deliver it: the ONE notice offers Send copy (the thread, to the customer), held without the e-mail right', () => {
    const html = render('thread-send-copy')
    const words = text(html)
    expect(words).toContain('SDI could not deliver this invoice: send the customer a copy with the courtesy PDF.')
    expect(words).toContain('Send copy')
    expect(html.indexOf('class="fw-rcf-notices"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="fw-rcf-notices"')).toBeLessThan(html.indexOf('class="fw-rcf-dock"'))
    expect(text(render('thread-docked'))).not.toContain('Send copy')
    // Send copy shows the thread through the frame's own door (no width remembered, no address built here).
    const view = readFileSync(new URL('./record/view/InvoiceRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const show = () => frame?.showThread?.()')
    expect(view).not.toContain('frame.choose(')
  })

  it('the band holds ONE pill (a draft’s state, else where it is at SDI); the pay state and the deadline travel as tags', () => {
    const view = readFileSync(new URL('./record/view/InvoiceRecordView.tsx', import.meta.url), 'utf8')
    const band = view.slice(view.indexOf('band={{', view.indexOf('function ReadyRecord')), view.indexOf('primary:', view.indexOf('function ReadyRecord')))
    expect(band.match(/<Pill /g)?.length).toBe(2) // the two arms of the one status pill
    expect(band).toContain('<Tag tone={PAY_TONE[pay.state]}>')
  })

  it('the wall (W08, W13, W25, W34): the docked thread speaks of this invoice’s own customer only', () => {
    const own = invoice('DELIVERED').party.legalName
    const dock = text(dockOf(render('thread-docked')))
    expect(dock).toContain(own)
    expect(dock).not.toMatch(/Brand Alpha|Brand Beta/)
  })

  it('the new words exist in both languages; the retired ones are gone', () => {
    for (const locale of LOCALES) {
      const words = messagesFor(locale, ['finance']).finance!
      const t = createTranslator(locale, words)
      for (const key of ['tab.sdiDocuments', 'record.sendCopyNotice', 'record.sendCopyHint', 'action.sendCopy', 'docs.draft.body', 'record.dockLabel']) expect(t(key), `${locale}: ${key}`).not.toBe(key)
      for (const gone of ['tab.activity', 'tab.documents', 'record.dock', 'record.dockHint', 'record.noPanels', 'docs.draft.title']) expect(t(gone), `${locale}: ${gone}`).toBe(gone)
    }
  })
})
