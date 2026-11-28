import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { windowBody, windowHeld } from '../../../../../lib/record-thread/files-view/asks/asks'
import { ORDER_FLOW_NS } from '../flow-words'

/**
 * owb-of6 step 4 — the Files tab, office face only (design plan § 5o, § 5p point 1; L5): a file's download button shows on hover (always
 * on touch); Download all calls the zip ONCE (of1's `POST /sales/orders/:id/files/zip`) and says the files it left out
 * (`x-left-out`); Ask again asks why and sends it. The portal's Files body stays as it is. Written, not run (Owner rule).
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('owb-of6 step 4: Download all calls the zip once', () => {
  it('one POST to the zip route, reading x-left-out; the head\'s ONE button (the ⋯ keeps file-by-file only without a zip door)', () => {
    const api = read('../band/api.ts')
    expect(api).toContain("api.bytes(`/sales/orders/${encodeURIComponent(orderId)}/files/zip`, {")
    expect(api).toContain("headers.get('x-left-out')")
    expect(api.match(/files\/zip/g)?.length).toBe(1)
    const flow = read('../band/use-order-flow.ts')
    expect(flow).toContain('if (!orderId || zip.busy) return') // one zip at a time
    const tab = read('./FilesTab.tsx')
    expect(tab).toContain('<Button key="zip" size="sm" variant="quiet"')
    expect(tab).toContain("if (choosable.length > 1 && !zipping) items.push({ id: 'download-all'")
    expect(tab).toContain("f('zip.leftOut', { count: zip.leftOut })")
  })
})

describe('owb-of6 step 4: the download button on hover, office face only', () => {
  it('the office card\'s Download carries fw-of-dl; it hides only on a pointer screen until hover or focus; the portal card has none', () => {
    const view = read('../../../../../lib/record-thread/files-view/view/FilesView.tsx')
    expect(view).toContain('className="fw-of-dl" aria-label={t(\'card.downloadOf\'')
    const css = read('../../../../../lib/record-thread/files-view/view/files-tab.css')
    expect(css).toContain('@media (hover: hover) {')
    expect(css).toContain('.fw-of-card:focus-within .fw-of-dl')
  })
})

describe('owb-of6 step 4: Ask again asks why and sends it', () => {
  it('the why is asked (today\'s server needs 3–500 letters) and goes in the body', () => {
    expect(windowHeld({ kind: 'again', askId: 'a-1', reason: '', dueOn: '2026-12-01' }, null)).not.toBeNull()
    expect(windowBody({ kind: 'again', askId: 'a-1', reason: ' Wrong size on page 2 ', dueOn: '2026-12-01' }, { version: 3 } as unknown as Parameters<typeof windowBody>[1])).toMatchObject({ version: 3, reason: 'Wrong size on page 2' })
  })
  it('every new word in English and Italian', () => {
    for (const locale of LOCALES) for (const key of ['zip.all', 'zip.busy', 'zip.failed', 'zip.leftOut_one', 'zip.leftOut_other']) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
