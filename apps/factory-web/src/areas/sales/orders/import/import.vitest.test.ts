import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ImportJob } from '../../../admin/import/api'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { scanText } from '../../../../lib/testing/brand-scan'
import { BRAND_ALPHA, BRAND_BETA } from '../../../../lib/testing/two-brands'
import { NAMESPACE as DEPTH } from '../depth/model'
import { DEMO_MEMORY, designScreen } from './fixtures'
import { asksMemory, mappingOfJob, memoryOf, rememberedMapping, sameMapping, type Remembered } from './memory'

/**
 * B-TH-293 (threads plan TH-9, SHEET-G13; feature SHEET.brand-view-F09; wall W17): order import remembers a customer's columns —
 * on one customer's sheet, once the dry run read the headers, that customer's last import of the same headers is asked for (the
 * API B-TH-101) and said in one line: read the same way, or "Use them". Never asked without the sheet's customer, never for
 * another customer; the line names only the sheet's own customer.
 */

const job = (layout: unknown, status: ImportJob['status'] = 'PLANNED'): Pick<ImportJob, 'status' | 'layout'> => ({ status, layout })
const LAYOUT = { columns: [{ header: 'Art.', column: 'style' }, { header: 'Tg', column: 'size' }], ignored: [{ header: 'Note' }] }
const remembered = (mapping: Record<string, string | null>): Remembered => ({ mapping, fromImportId: 'b2b2b2b2-0000-4000-8000-000000000201', fileName: 'Brand Beta order sheet week 45.xlsx', appliedAt: '2026-11-10T09:00:00.000Z' })
const BETA = 'b2b2b2b2-0000-4000-8000-0000000000bb'

describe('the mapping a dry run used, and whether the remembered one reads the sheet the same way', () => {
  it('each header to its column, a header left out to null; not read yet: none', () => {
    expect(mappingOfJob(job(LAYOUT))).toEqual({ 'Art.': 'style', Tg: 'size', Note: null })
    expect(mappingOfJob(job(null))).toBeNull()
  })
  it('the same columns in any case of the headers are the same; one column more or other is not', () => {
    expect(sameMapping({ 'Art.': 'style', Tg: 'size' }, { 'art.': 'style', TG: 'size' })).toBe(true)
    expect(sameMapping({ 'Art.': 'style', Note: null }, { 'Art.': 'style' })).toBe(true)
    expect(sameMapping({ 'Art.': 'style', Tg: 'size' }, { 'Art.': 'style', Tg: 'colour' })).toBe(false)
    expect(sameMapping({ 'Art.': 'style' }, { 'Art.': 'style', Col: 'colour' })).toBe(false)
  })
})

describe('W17: asked only for the sheet’s own customer', () => {
  it('a planned dry run with its headers, the sheet’s customer known, the right to run imports: asked; else never', () => {
    expect(asksMemory(job(LAYOUT), BETA, true)).toBe(true)
    expect(asksMemory(job(LAYOUT), null, true)).toBe(false) // every customer's sheet: no customer to remember for
    expect(asksMemory(job(LAYOUT), BETA, false)).toBe(false)
    expect(asksMemory(job(LAYOUT, 'UPLOADED'), BETA, true)).toBe(false)
    expect(asksMemory(job(null), BETA, true)).toBe(false)
    expect(asksMemory(null, BETA, true)).toBe(false)
  })

  it('the read names that customer only (GET …/remembered-mapping?partyId=<the sheet’s customer>)', async () => {
    const calls: Array<{ path: string; query: Record<string, unknown> }> = []
    const api = { get: async (path: string, options?: { query?: Record<string, unknown> }) => (calls.push({ path, query: options?.query ?? {} }), { remembered: null }) } as unknown as Parameters<typeof rememberedMapping>[0]
    expect(await rememberedMapping(api, 'c3c3c3c3-0000-4000-8000-000000000301', BETA)).toBeNull()
    expect(calls).toEqual([{ path: '/sales/order-import/c3c3c3c3-0000-4000-8000-000000000301/remembered-mapping', query: { partyId: BETA } }])
  })

  it('nothing remembered: nothing said (never a hint that another customer has columns)', () => {
    expect(memoryOf(job(LAYOUT), null, BRAND_BETA.tradeName, false)).toBeNull()
    expect(memoryOf(job(LAYOUT), remembered({ 'Art.': 'style' }), null, false)).toBeNull()
  })

  it('remembered: the same columns (nothing to do) or other ones (Use them)', () => {
    expect(memoryOf(job(LAYOUT), remembered({ 'Art.': 'style', Tg: 'size', Note: null }), BRAND_BETA.tradeName, false)).toMatchObject({ same: true, customer: BRAND_BETA.tradeName })
    expect(memoryOf(job(LAYOUT), remembered({ 'Art.': 'style', Tg: 'size', Note: 'colour' }), BRAND_BETA.tradeName, false)).toMatchObject({ same: false, mapping: { Note: 'colour' } })
  })
})

describe('the one line on the import screen (SCR-429)', () => {
  it('its words exist in it and en and name the customer, the sheet and the day', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [DEPTH])[DEPTH]!)
      const params = { customer: BRAND_BETA.tradeName, file: DEMO_MEMORY.fileName, day: '10/11/2026' }
      for (const key of ['same', 'offer']) {
        const words = t(`import.memory.${key}`, params)
        expect(words, `${locale} ${key}`).toContain(BRAND_BETA.tradeName)
        expect(words).toContain(DEMO_MEMORY.fileName)
      }
      expect(t('import.memory.use')).not.toMatch(/^import\./)
      expect(t('import.memory.busy')).not.toMatch(/^import\./)
    }
  })

  it('Brand Beta’s sheet: the line offers Use them, or says the columns were read the same way; nothing of Brand Alpha', () => {
    for (const id of ['memory-offer', 'memory-same']) {
      const entry = designScreen.cases.find((item) => item.id === id)!
      for (const locale of LOCALES) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: entry.model })))
        const t = createTranslator(locale, messagesFor(locale, [DEPTH])[DEPTH]!)
        expect(html, `${id} ${locale}`).toContain(BRAND_BETA.tradeName)
        if (id === 'memory-offer') expect(html).toContain(t('import.memory.use'))
        else expect(html).not.toContain(t('import.memory.use'))
        expect(scanText(html.replace(/<[^>]+>/g, ' '), BRAND_ALPHA), `${id} ${locale}`).toEqual([])
      }
    }
  })
})
