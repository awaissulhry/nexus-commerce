import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { renderView, textOf } from '../../../lib/record-thread/parts/testing'
import { BRAND_ALPHA, BRAND_BETA } from '../../../lib/testing/two-brands'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { demoStyle, PRIVATE_LABEL_BRAND, recordModel, StyleDesign } from './demo/fixtures'
import { isWideTab, issueHash, issueTab, MERGED_TABS, STYLE_TABS, tabOf, tabsFor, VARIANTS_ANCHOR, type StyleTab } from './model'
import type { StyleRecordViewModel } from './record/record-model'
import { designScreen } from './record/fixtures'

/**
 * B-TH-261 — the style on RecordFrame (O-PRD-STY; the rule of picture 38, the tabs of picture 39 / 08-tabs.tsv): the band in the area
 * row with ONE pill, ONE thread docked beside the nine tabs (Overview and Colourways & sizes merged, Files & patterns is Patterns,
 * Activity gone), Activity's tools in the thread's "⋯" (R-ACT), one notice, the old addresses (R-8), the page's keys in the band's
 * ONE Keyboard line, "Made from INQ-…", and the brand wall: a private-label style's thread is its brand's only, our own collection's
 * notes only.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const drawModel = (model: StyleRecordViewModel, locale: 'it' | 'en' = 'en') => renderView(StyleDesign, model, locale)
const dockOf = (html: string) => textOf(html.slice(html.indexOf('class="fw-rcf-dock"')))
// The band (not portaled on the server: in the frame's band row) up to the frame's grid (`fw-rcf` or `fw-rcf has-thread`).
const bandOf = (html: string) => html.slice(html.indexOf('fw-rcf-hdr'), html.search(/class="fw-rcf[ "]/))

describe('the style on RecordFrame', () => {
  it('the tabs 11 → 9: Overview & variants · Sizes & measurements · Materials (BOM) · Operations · Cost · Tech pack · Compliance · Patterns · Versions & changes', () => {
    expect(STYLE_TABS).toEqual(['overview', 'sizes', 'bom', 'routing', 'cost', 'techpack', 'compliance', 'patterns', 'versions'])
    const text = textOf(draw('thread-docked'))
    let at = -1
    for (const tab of ['Overview & variants', 'Sizes & measurements', 'Materials (BOM)', 'Operations', 'Cost', 'Tech pack', 'Compliance', 'Patterns', 'Versions & changes']) {
      const next = text.indexOf(tab, at + 1)
      expect(next, tab).toBeGreaterThan(at)
      at = next
    }
    const html = draw('thread-docked')
    for (const gone of ['tab=variants', 'tab=files', 'tab=activity']) expect(html, gone).not.toContain(gone)
    const body = textOf(html.slice(0, html.indexOf('class="fw-rcf-dock"')))
    for (const gone of ['Files & patterns', 'Activity']) expect(body, gone).not.toContain(gone)
  })

  it('every old ?tab= keeps working (R-8): variants → Overview & variants, files → Patterns, activity → the overview (the frame opens the thread)', () => {
    expect(MERGED_TABS).toEqual({ variants: 'overview', files: 'patterns', activity: 'overview' })
    expect(tabOf('variants')).toBe('overview')
    expect(tabOf('files')).toBe('patterns')
    expect(tabOf('activity')).toBe('overview')
    for (const tab of STYLE_TABS) expect(tabOf(tab)).toBe(tab)
    for (const odd of ['nope', 'constructor', 'toString', '', null, undefined]) expect(tabOf(odd as string | null | undefined)).toBe('overview')
  })

  it('a tab goes only with its replacement (R-9): Overview & variants holds the identity, the gallery, the range, the colourways and the SKU matrix', () => {
    const html = draw('variants-owner')
    expect(html).toContain(`id="${VARIANTS_ANCHOR}"`)
    const text = textOf(html)
    for (const part of ['Add colourway', 'Release check']) expect(text, part).toContain(part)
    // Patterns keeps the pattern files and the pieces (cutting data): it is a tab, not the thread's Files view.
    expect(tabsFor(recordModel('owner').can)).toContain('patterns')
    expect(tabsFor(recordModel('sales').can)).not.toContain('patterns')
  })

  it('a range or colourway problem’s Fix scrolls to the range and colourways on the same tab', () => {
    expect(issueTab({ code: 'NO_SIZE_RANGE' })).toBe('overview')
    expect(issueHash({ code: 'NO_ACTIVE_COLOURWAY' })).toBe(`#${VARIANTS_ANCHOR}`)
    expect(issueHash({ code: 'COLOUR_MISSING' })).toBe('')
    expect(issueTab({ code: 'COLOUR_MISSING' })).toBe('bom')
  })

  it('ONE thread on the page: the docked thread, no Activity tab, no record panels, no second dock', () => {
    const html = draw('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).not.toContain('fw-rp-tabs')
    expect(html).not.toContain('fw-st-dock')
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab (Activity’s tools moved there)', () => {
    for (const tab of STYLE_TABS) expect(drawModel(recordModel('owner', { tab })), tab).toContain('aria-label="Thread tools"')
  })

  it('the thread takes one third on the wide grids under 1600 px: Overview & variants (the SKU matrix), Sizes, BOM, Cost', () => {
    const wide: StyleTab[] = STYLE_TABS.filter(isWideTab)
    expect(wide).toEqual(['overview', 'sizes', 'bom', 'cost'])
  })

  it('the band sits in the frame: ONE pill (the lifecycle), the revision in view and the PPE tag beside it, the Thread button, no "?" overlay', () => {
    const html = draw('overview-owner')
    expect(html).toContain('fw-rcf-hdr')
    const band = bandOf(html)
    expect(band.match(/class="nds-pill /g)?.length).toBe(1)
    expect(textOf(band)).toContain('Viewing')
    expect(textOf(band)).toContain('Thread')
    expect(textOf(band)).toContain('Release revision 3')
    const source = readFileSync(new URL('./record/view/StyleRecordView.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain("event.key === '?'")
    expect(source).not.toContain('KeysDialog')
    expect(source).toContain('keys,')
  })

  it('PR-14: the page’s own keys join the band menu’s ONE Keyboard line, in it and en', () => {
    const source = readFileSync(new URL('./record/view/StyleRecordView.tsx', import.meta.url), 'utf8')
    for (const key of ['keys.release', 'keys.prevRevision', 'keys.nextRevision', 'keys.save', 'keys.add', 'keys.bomView', 'keys.skuCell', 'keys.skuRow', 'keys.moveUp', 'keys.moveDown']) {
      expect(source, key).toContain(`'${key}'`)
      for (const locale of ['it', 'en'] as const) expect(CATALOGUE[locale].products![key], `${locale} ${key}`).toBeTruthy()
    }
  })

  it('"Start a project…" in the band menu opens a new project with this style linked — a private-label style’s with its brand, held without projects.manage', () => {
    const source = readFileSync(new URL('./record/view/StyleRecordView.tsx', import.meta.url), 'utf8')
    expect(source).toContain("t('action.startProject')")
    expect(source).toContain('/products/projects?new=1&link=${encodeURIComponent(`Style:${style.id}`)}&linkLabel=${encodeURIComponent(style.code)}')
    expect(source).toContain('&party=${encodeURIComponent(style.brand.id)}')
    expect(source).toContain("t('held.noProjects', { right: rightRef('projects.manage') })")
    for (const locale of ['it', 'en'] as const) for (const key of ['action.startProject', 'held.noProjects']) expect(CATALOGUE[locale].products![key], `${locale} ${key}`).toBeTruthy()
    expect(recordModel('owner').projects).toEqual({ view: true, manage: true })
    expect(recordModel('sales').projects).toEqual({ view: true, manage: false })
  })

  it('one notice: the most serious shows, the rest wait behind "N more notices" (never above the thread)', () => {
    const html = draw('notices')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    const body = html.slice(html.indexOf('class="fw-rcf-body"'), dockAt)
    expect(body).toContain('fw-rcf-notices-list')
    expect((body.match(/class="nds-banner /g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(html.slice(dockAt)).not.toContain('fw-rcf-notices')
  })

  it('"Made from INQ-… — Open" on a draft a request made: a link to the request in Sales › Incoming, in the band', () => {
    const html = draw('thread-made-from')
    const band = bandOf(html)
    expect(textOf(band)).toContain('Made from INQ-2026-0007 — Open')
    expect(band).toContain('/sales/incoming/0190f0e2-7777-7000-8000-000000000007')
    expect(textOf(bandOf(draw('overview-owner')))).not.toContain('Made from')
    expect(textOf(bandOf(draw('thread-made-from', 'it')))).toContain('Creato da INQ-2026-0007 — Apri')
  })

  it('the brand wall: our own collection’s thread holds notes only (no customer, no mail); a private-label style names only its own brand', () => {
    const own = dockOf(draw('thread-docked'))
    expect(own).not.toContain(PRIVATE_LABEL_BRAND.name)
    expect(own).not.toContain(BRAND_ALPHA.contact.email)
    expect(own).not.toContain(BRAND_ALPHA.contact.name)
    const label = dockOf(draw('thread-private-label'))
    expect(label).toContain(PRIVATE_LABEL_BRAND.name)
    for (const other of [BRAND_ALPHA.tradeName, BRAND_BETA.tradeName]) expect(label).not.toContain(other)
  })

  it('without threads.read there is no thread here: no dock, no Thread button', () => {
    const html = draw('thread-no-right')
    expect(html).not.toContain('class="fw-rcf-dock"')
    expect(html).not.toContain('aria-keyshortcuts="Meta+J Control+J"')
    // The loading and refused states sit in the frame with the way back and no thread.
    for (const id of ['loading', 'error', 'not-found', 'no-permission']) {
      const state = draw(id)
      expect(state, id).toContain('fw-rcf-hdr')
      expect(state, id).not.toContain('class="fw-rcf-dock"')
    }
  })

  it('"Thread and history" on the overview shows the docked thread (no link to the gone Activity tab)', () => {
    const html = draw('thread-docked')
    expect(html).not.toContain('tab=activity')
    expect(textOf(html)).toContain('Show the thread and history')
    const overview = readFileSync(new URL('./record/view/OverviewTab.tsx', import.meta.url), 'utf8')
    expect(overview).toContain('frame.showThread?.()')
    expect(overview).not.toContain("'activity'")
  })

  it('the page mounts the office thread docked with the style’s own brand only; the print view keeps the panels’ print form', () => {
    const container = readFileSync(new URL('./record/StyleRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain("partyRole=\"customer\"")
    expect(container).toContain('value?.brand ? { id: value.brand.id, name: value.brand.name } : null')
    expect(container).toContain('can.thread')
    expect(container).toContain('printThread')
    expect(container).not.toContain('DOCK_KEY')
    expect(container).not.toContain("hrefFor('activity')")
    // "Made from" is read only with sales.inquiries.view (the route asks it).
    expect(container).toContain("session.permissions.includes('sales.inquiries.view')")
    const view = readFileSync(new URL('./record/view/StyleRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<RecordFrame')
    expect(view).not.toContain('RecordPanelsView')
    expect(view).not.toContain('DetailHeader')
  })

  it('every design case draws the studio on the frame, in it and en, with no key left on screen', () => {
    for (const item of designScreen.cases) {
      for (const locale of ['it', 'en'] as const) {
        const text = textOf(renderView(view, item.model, locale))
        expect(text, `${locale} ${item.id}`).not.toMatch(/\b(?:record|tab|keys|side)\.[a-zA-Z]+\b/)
      }
    }
    // The private-label demo style is the design data's own (made-up) brand, never a two-brands fixture.
    expect(demoStyle().brand).toBeNull()
  })
})
