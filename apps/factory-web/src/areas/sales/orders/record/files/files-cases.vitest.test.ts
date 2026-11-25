import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { leftKeys, renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { designScreen } from '../fixtures'

/**
 * T.1 (order FILES tab, 15-steps) — the Files tab's gallery cases the seed lacks, each drawn in both languages: no message key left on
 * screen, and what each case is there to show (made-up data only).
 */

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so a window's words are checked.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const words = (locale: 'it' | 'en', ns: string) => createTranslator(locale, messagesFor(locale, [ns])[ns]!)
const KEYS = ['order', 'acts', 'bulk', 'card', 'keep', 'upload', 'band', 'row', 'ask', 'state', 'held', 'counted', 'files', 'priced', 'audience', 'version', 'versions']

describe('F-OF T.1 — the Files tab’s gallery cases', () => {
  const ids = designScreen.cases.map((item) => item.id).filter((id) => id.startsWith('of-'))

  it('every T.1 case is listed once and draws in both languages with no key on screen', () => {
    for (const id of ['of-empty-owner', 'of-full', 'of-chosen-owner', 'of-sales', 'of-manager', 'of-designer', 'of-readonly', 'of-closed', 'of-failed', 'of-viewer-failed', 'of-failed-picks', 'of-ask-designer', 'of-who', 'of-rename', 'of-delete', 'of-delete-refused', 'of-version', 'of-priced', 'of-notice']) expect(ids, id).toContain(id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) for (const locale of LOCALES) expect(leftKeys(draw(id, locale), KEYS), `${id} ${locale}`).toEqual([])
  })

  it('a working order: every group, a DDT inside its shipment (the annulled one folded), the replaced XML folded, a held upload, 3 asks', () => {
    for (const locale of LOCALES) {
      const t = words(locale, 'record-thread-files-view')
      const text = textOf(draw('of-full', locale))
      for (const shown of ['Size spec SEED-JKT-02.pdf', 'Logo embroidery.pdf', 'Tech pack SEED-JKT-02.pdf', 'Collar seam front.jpg', 'Inspection report QC-0007.pdf', 'DDT 12-2026.pdf', 'Proof of delivery SH-2026-0012.pdf', 'Return label RA-0002.pdf', 'Pattern size 54.pdf']) expect(text, `${locale} ${shown}`).toContain(shown)
      // The annulled DDT and the replaced XML fold under their block ("Show 1 older"): not drawn until opened.
      expect(text).not.toContain('DDT 11-2026.pdf')
      expect(text).not.toContain('IT01234567890_FT45_old.xml')
      expect(text).toContain(t('order.older.show', { count: 1 }))
      expect(text).toContain(words(locale, 'file-asks')('band.title'))
    }
  })

  it('Sales, the production manager and the designer read without prices: the priced papers counted, never named; no Who can see…, no Delete…', () => {
    for (const id of ['of-sales', 'of-manager', 'of-designer']) {
      const text = textOf(draw(id))
      expect(text, id).not.toContain('Order confirmation v2.pdf')
      expect(text, id).not.toContain('Customer PO 7781.pdf')
      expect(text, id).toContain('Size spec SEED-JKT-02.pdf')
      expect(draw(id), id).not.toContain('More actions for the chosen files')
    }
    // The Owner reads them by name.
    expect(textOf(draw('of-full'))).toContain('Order confirmation v2.pdf')
  })

  it('the Owner’s choice: Download 3 · Who can see 3… · the bar’s ⋯ (Delete 3…) · one Clear', () => {
    for (const locale of LOCALES) {
      const t = words(locale, 'record-thread-files-view')
      const html = draw('of-chosen-owner', locale)
      expect(textOf(html)).toContain(t('bulk.download', { count: 3 }))
      expect(textOf(html)).toContain(t('acts.bulk.who', { count: 3 }))
      expect(html).toContain(`aria-label="${t('acts.bulk.more')}"`)
      expect(html.split(`>${t('bulk.clear')}<`).length - 1).toBe(1)
    }
  })

  it('a closed order holds a new ask with words; Read-only has no Add and no Ask', () => {
    // "Ask for a file…" is held with the words (the DS Button says them as its description and tooltip).
    const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')
    for (const locale of LOCALES) expect(draw('of-closed', locale)).toContain(`aria-description="${attr(words(locale, 'file-asks')('band.closed'))}"`)
    expect(draw('of-full')).not.toContain(`aria-description="${attr(words('en', 'file-asks')('band.closed'))}"`)
    const t = words('en', 'record-thread-files-view')
    expect(textOf(draw('of-readonly'))).not.toContain(t('files.add'))
  })

  it('the windows: Who can see 3 files, Rename, Delete “…” and its 5 versions, New version → Add as v6, Mark as priced?, a refusal in the server’s words, one notice', () => {
    for (const locale of LOCALES) {
      const t = words(locale, 'record-thread-files-view')
      expect(textOf(draw('of-who', locale))).toContain(t('acts.who.titleBulk', { count: 3 }))
      expect(textOf(draw('of-who', locale))).toContain(t('acts.who.floor'))
      expect(textOf(draw('of-rename', locale))).toContain(t('acts.rename.title', { name: 'Size spec SEED-JKT-02.pdf' }))
      expect(textOf(draw('of-delete', locale))).toContain(t('acts.delete.titleVersions', { name: 'Size spec SEED-JKT-02.pdf', count: 5 }))
      expect(textOf(draw('of-delete', locale))).toContain(t('acts.delete.warn'))
      expect(textOf(draw('of-version', locale))).toContain(t('acts.version.go', { n: 6 }))
      expect(textOf(draw('of-priced', locale))).toContain(t('acts.priced.title', { name: 'Office notes.pdf' }))
      expect(textOf(draw('of-delete-refused', locale))).toContain('A legal hold keeps this document: nothing was deleted.')
      expect(textOf(draw('of-notice', locale))).toContain(t('acts.done.deleted', { count: 1 }))
    }
  })

  it('the parts fail on their own lines: the read (Try again), the viewer’s file (Try again), the ask’s pickers (Try again; a cut-short list said)', () => {
    for (const locale of LOCALES) {
      const t = words(locale, 'record-thread-files-view')
      expect(textOf(draw('of-failed', locale))).toContain(t('problem.read'))
      expect(textOf(draw('of-viewer-failed', locale))).toContain(words(locale, 'record-thread-popups')('viewer.failed'))
      expect(textOf(draw('of-failed-picks', locale))).toContain(words(locale, 'file-asks')('ask.truncated'))
    }
  })

  it('the Factory designer may be asked (S3: tasks.manage) and asks for a file', () => {
    expect(textOf(draw('of-ask-designer'))).toContain('Paola Disegno (Factory designer)')
    expect(textOf(draw('of-designer'))).toContain(words('en', 'file-asks')('band.title'))
  })
})

// ---- T.2 (order FILES tab): th9's step 16 walks the tab at the end, after the Shipments tab's 15; step 7 (the viewer walk) unchanged ----
describe('F-OF T.2 — th9 walks the Files tab at the end (step 16)', () => {
  it('step 16 follows step 15 and walks Add files…, the ask (upload, ask again, accept and share), Rename…, Versions… (Restore v1), Delete…, Sales and Read-only', async () => {
    const { readFileSync } = await import('node:fs')
    const flow = readFileSync(new URL('../../../../../../tests/golden-flow/th9-order-page.ts', import.meta.url), 'utf8')
    const at = (text: string) => flow.indexOf(text)
    expect(at("await flow.step('16 · the Files tab")).toBeGreaterThan(at("await flow.step('15 · the Shipments tab"))
    expect(flow).toContain("await flow.step('7 · the files viewer walk by keys")
    for (const path of ['/^\\/files\\/[^/]+\\/complete$/', '/^\\/sales\\/orders\\/[^/]+\\/file-asks$/', '/answer$/', '/ask-again$/', '/accept$/', '/^\\/files\\/[^/]+\\/rename$/', '/^\\/files\\/[^/]+\\/restore$/', '/^\\/files\\/[^/]+\\/delete-document$/']) expect(flow, path).toContain(path)
    expect(flow).toContain("alpha.go(`/orders/${world.so2.id}?tab=files`)") // pp-t: the portal order's Files tab by its own name
    expect(flow).toContain("FA('band.counted.priced', { count: 1 })")
    expect(flow).toContain("roles.some((role) => role.key === 'designer' && !role.archivedAt)")
    const harness = readFileSync(new URL('../../../../../../tests/golden-flow/_harness/flow.ts', import.meta.url), 'utf8')
    expect(harness).toContain("export const MORE_ROLES = { owner: 'owner', reader: 'read_only', designer: 'designer' } as const")
  })
})
