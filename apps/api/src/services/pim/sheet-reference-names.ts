import prisma from '../../db.js'
import { cachedCategoryLabelsMany } from '../categories/reference-labels.service.js'

export interface SheetReferenceNames {
  channel: string
  market: string
  lookups: Array<{ field: 'descriptionThemeId' | 'categoryId'; ids: string[]; labels: Record<string, string> }>
}
interface NameSheet {
  scope: { channel?: string | null }
  schema?: { marketplace?: string }
  columns: readonly { key: string }[]
  rows: readonly { values?: Readonly<Record<string, { value?: unknown } | undefined>> }[]
  meta: object
}

/** HTTP display metadata only. Call AFTER the sheet's read transaction, never from a writer or readiness producer. */
export async function withSelectedReferenceNames<T extends NameSheet>(sheet: T): Promise<T & { meta: T['meta'] & { referenceNames?: SheetReferenceNames } }> {
  const channel = sheet.scope.channel ?? 'MASTER', market = sheet.schema?.marketplace
  if (!market) return sheet
  const columns = new Set(sheet.columns.map(column => column.key))
  const idsFor = (field: string) => columns.has(field) ? [...new Set(sheet.rows.flatMap(row => {
    const value = row.values?.[field]?.value
    return (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) && String(value).trim() ? [String(value)] : []
  }))].sort() : []
  const themes = idsFor('descriptionThemeId').filter(id => id !== 'none' && id.length <= 500)
  const categories = channel === 'EBAY' ? idsFor('categoryId').filter(id => /^[A-Z0-9_]{1,100}$/i.test(id)) : []
  if (!themes.length && !categories.length) return sheet
  const reads: Array<{ field: SheetReferenceNames['lookups'][number]['field']; ids: string[]; read: () => Promise<Record<string, string>> }> = []
  if (themes.length && themes.length <= 1000) reads.push({ field: 'descriptionThemeId', ids: themes, read: async () => {
    const rows = await prisma.ebayDescriptionTheme.findMany({ where: { id: { in: themes } }, select: { id: true, name: true } })
    if (rows.some(row => typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim())) throw new Error('Theme names are incomplete')
    const names = new Map(rows.map(row => [row.id, row.name]))
    return Object.fromEntries(themes.flatMap(id => names.has(id) ? [[id, names.get(id)!]] : []))
  } })
  if (categories.length && categories.length <= 1000) reads.push({ field: 'categoryId', ids: categories, read: async () =>
    (await cachedCategoryLabelsMany('EBAY', market, categories.map(id => id.toUpperCase()))).categoryId ?? {},
  })
  if (!reads.length) return sheet
  const started = Date.now()
  // Independent, bounded reads run outside the sheet transaction. Failed reads claim no coverage.
  const results = await Promise.allSettled(reads.map(async ({ field, ids, read }) => ({ field, ids, labels: await read() })))
  const lookups = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const elapsed = Date.now() - started
  const meta = sheet.meta as { tookMs?: unknown; phases?: Record<string, number> }
  return { ...sheet, meta: { ...sheet.meta,
    ...(typeof meta.tookMs === 'number' ? { tookMs: meta.tookMs + elapsed } : {}),
    phases: { ...meta.phases, referenceNames: elapsed }, ...(lookups.length ? { referenceNames: { channel, market, lookups } } : {}) } }
}
