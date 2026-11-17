import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { CUSTOMERS, RMA_AUTHORISED } from './demo/fixtures'
import { designScreen } from './record/fixtures'
import { MERGED_REPAIR_TABS, MERGED_RMA_TABS, REPAIR_TABS, RMA_TABS, tabOfAddress } from './view-model'

/**
 * B-TH-259 — the return and the repair on RecordFrame (O-SAL-RMA, O-SAL-REP; the rule of picture 38, the tabs of picture 39 /
 * 08-tabs.tsv): the band in the area row with ONE pill, ONE thread docked beside the tabs (return 5 → 4, repair 6 → 5), Activity's
 * tools in the thread's "⋯" (R-ACT), one notice, the old addresses (R-8), and the wall: the thread names its own customer only (the
 * repair's thread is shared with that customer since B-TH-081).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const dockOf = (html: string) => textOf(html.slice(html.indexOf('class="fw-rcf-dock"')))
const bandOf = (html: string) => html.slice(html.indexOf('fw-rcf-hdr'), html.search(/class="fw-rcf[ "]/))

describe('the tabs and the old addresses (R-8)', () => {
  it('return 5 → 4 and repair 6 → 5; Activity → the first tab (the frame opens the thread); own keys only', () => {
    expect(RMA_TABS).toEqual(['lines', 'inspection', 'credit', 'shipments'])
    expect(REPAIR_TABS).toEqual(['intake', 'estimate', 'work', 'safety', 'return'])
    expect(MERGED_RMA_TABS).toEqual({ activity: 'lines' })
    expect(MERGED_REPAIR_TABS).toEqual({ activity: 'intake' })
    expect(tabOfAddress(RMA_TABS, MERGED_RMA_TABS, 'activity')).toBe('lines')
    expect(tabOfAddress(REPAIR_TABS, MERGED_REPAIR_TABS, 'activity')).toBe('intake')
    for (const tab of RMA_TABS) expect(tabOfAddress(RMA_TABS, MERGED_RMA_TABS, tab)).toBe(tab)
    for (const odd of ['nope', 'constructor', 'toString', null, undefined]) {
      expect(tabOfAddress(RMA_TABS, MERGED_RMA_TABS, odd as string | null)).toBe('lines')
      expect(tabOfAddress(REPAIR_TABS, MERGED_REPAIR_TABS, odd as string | null)).toBe('intake')
    }
  })
})

describe('the return on RecordFrame', () => {
  it('ONE thread on the page: docked, no Activity tab, no record panels; R-ACT on every tab', () => {
    const html = draw('rma-thread')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    expect(html).not.toContain('fw-rp-tabs')
    expect(textOf(html.slice(0, html.indexOf('class="fw-rcf-dock"')))).not.toMatch(/\bActivity\b/)
    for (const id of ['rma-lines', 'rma-inspection', 'rma-ddt']) expect(draw(id), id).toContain('aria-label="Thread tools"')
  })

  it('the band: ONE pill (the status), Receive goods as the primary, the Thread button, no key hint on the button', () => {
    const band = bandOf(draw('rma-lines'))
    expect(band.match(/class="nds-pill /g)?.length).toBe(1)
    expect(textOf(band)).toContain('Thread')
    // The one key hint is the record frame's own ⌘J on its Thread button (TH-1c, the frame's rule on every record page);
    // Receive goods, the primary, carries none — and nothing else in the band does.
    const receive = band.indexOf('Receive goods')
    expect(band.slice(band.lastIndexOf('<button', receive), band.indexOf('</button>', receive))).not.toContain('<kbd')
    expect(band.replace(/<span class="fw-rcf-keys"[^>]*>(?:<kbd[^>]*>[^<]*<\/kbd>)+<\/span>/g, '')).not.toContain('<kbd')
  })

  it('the wall: the return’s thread names its own customer only (W08, W14, W20, W25, W34)', () => {
    const own = RMA_AUTHORISED.party!.legalName
    const dock = dockOf(draw('rma-thread'))
    expect(dock).toContain(own)
    for (const other of CUSTOMERS.filter((entry) => entry.id !== RMA_AUTHORISED.party!.id)) expect(dock, other.legalName).not.toContain(other.legalName)
    for (const brand of [BRAND_ALPHA.tradeName, BRAND_BETA.tradeName]) expect(dock).not.toContain(brand)
  })

  it('without threads.read there is no thread here', () => {
    const html = draw('rma-no-thread')
    expect(html).not.toContain('class="fw-rcf-dock"')
    expect(html).not.toContain('aria-keyshortcuts="Meta+J Control+J"')
  })
})

describe('the repair on RecordFrame', () => {
  it('ONE thread docked, shared with its customer (B-TH-081); R-ACT on every tab; ONE pill in the band', () => {
    const html = draw('repair-thread')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    for (const id of ['repair-intake', 'repair-work', 'repair-send']) expect(draw(id), id).toContain('aria-label="Thread tools"')
    expect(bandOf(draw('repair-intake')).match(/class="nds-pill /g)?.length).toBe(1)
    expect(draw('repair-no-thread')).not.toContain('class="fw-rcf-dock"')
  })
})

describe('the containers', () => {
  it('each page mounts the office thread docked with its own customer, with threads.read; the states before the read sit in the frame', () => {
    for (const [file, type] of [['./record/RmaRecord.tsx', 'ReturnAuthorisation'], ['./repair/RepairRecord.tsx', 'RepairOrder']] as const) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).toMatch(/<OfficeRecordThread\s+docked/)
      expect(source, file).toContain(`type: '${type}'`)
      expect(source, file).toContain('partyRole="customer"')
      expect(source, file).toContain('can.threadsRead')
      expect(source, file).toContain(`<RecordFrame recordType="${type}"`)
      expect(source, file).not.toContain('DOCK_KEY')
      expect(source, file).not.toContain("'?tab=activity'")
    }
    for (const file of ['./record/view/RmaRecordView.tsx', './repair/view/RepairRecordView.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source, file).toContain("from '../../../../_shared/record-frame/RecordFrame'")
      expect(source, file).toContain('<RecordNotices>')
      expect(source, file).not.toContain("tab === 'activity'")
    }
  })
})
