import type { SheetColumnSet } from '../sheet-columns.service.js'
import { projectCellValue } from '../sheet-values.js'

/** Apply the channel resolver's effective values, using the same field and slot projection as the sheet. */
export function overlayFormulaChannelValues(
  flat: Record<string, unknown>,
  columns: SheetColumnSet['columns'],
  label: string,
  cells: Record<string, { status: string; value: unknown }>,
): Record<string, unknown> {
  const out = { ...flat }
  for (const col of columns) {
    const facts = col.channels?.[label]
    const mapped = facts ? cells[facts.key ?? facts.attribute] : undefined
    if (mapped?.status === 'mapped') out[col.key] = projectCellValue(col, mapped.value)
  }
  return out
}

/** Preview and saving both read the channel values shown by the product sheet. */
export async function formulaChannelValues(input: {
  flat: Record<string, unknown>; columnSet: SheetColumnSet; productId: string;
  channelConnectionId?: string | null; aliasKey?: string | null;
  scope?: string; channel?: string | null; marketplace?: string | null; locale: string;
  onSource?: (key: string, cell: import('./resolve-batch.service.js').ResolvedCell) => void
}): Promise<Record<string, unknown>> {
  if (input.scope !== 'channel' || !input.channel || !input.marketplace) return input.flat
  const coordinate = input.columnSet.coordinates?.find(c => c.channel === input.channel?.toUpperCase() && c.marketplace === input.marketplace?.toUpperCase())
  if (!coordinate) return input.flat
  const fields = [...new Set(input.columnSet.columns.map(c => c.channels?.[coordinate.label]?.key).filter((key): key is string => !!key))]
  if (!fields.length) return input.flat
  const { resolveBatch } = await import('./resolve-batch.service.js')
  const result = await resolveBatch({ channel: input.channel, marketplace: input.marketplace,
    productIds: [input.productId], fieldKeys: fields, locale: input.locale, aliasKey: input.aliasKey ?? '', channelConnectionId: input.channelConnectionId, includeCatalogue: false })
  const product = result.products.find(p => p.productId === input.productId)
  if (!product) throw new Error('Could not load this product’s channel values for the formula.')
  for (const col of input.columnSet.columns) {
    const facts = col.channels?.[coordinate.label]
    const cell = facts ? product.cells[facts.key ?? facts.attribute] : undefined
    if (cell?.status === 'mapped') input.onSource?.(col.key, cell)
  }
  return overlayFormulaChannelValues(input.flat, input.columnSet.columns, coordinate.label, product.cells)
}

/** The same scope/category inputs as the sheet; `channels` alone does not narrow a column build. */
export async function getFormulaColumns(input: {
  product: Record<string, any>; parent?: Record<string, any> | null;
  channelConnectionId?: string | null; aliasKey?: string | null; locale?: string;
  scope?: string; channel?: string | null; marketplace?: string | null; market: string;
}): Promise<SheetColumnSet> {
  const { getStudioColumns } = await import('../studio-columns.js')
  const { savedAttributeFields } = await import('../family-sheet-schema.js')
  const family = [input.product, ...(input.parent ? [input.parent] : [])]
  const channel = input.scope === 'channel' ? input.channel?.toUpperCase() : null
  const { productCategoryContext } = await import('../product-category-context.js')
  const context = channel ? await productCategoryContext(family.map(p => p.id), channel, input.marketplace ?? input.market, input.channelConnectionId) : null
  const selectedCategory = context?.byRow.get(`${input.product.id}:${input.aliasKey ?? ''}`)?.channelCategoryId
  const categories = selectedCategory ? [selectedCategory] : []
  return getStudioColumns({
    market: input.market.toUpperCase(), accountId: input.channelConnectionId, locale: input.locale, scopeKind: channel ? 'channel' : 'master',
    productTypes: channel === 'AMAZON' ? categories : [...new Set(family.map(p => p.productType).filter(Boolean))],
    familyIds: [...new Set(family.map(p => p.familyId).filter(Boolean))],
    savedFields: savedAttributeFields(family.map(p => p.categoryAttributes)),
    variationAxes: [...new Set(family.flatMap(p => Array.isArray(p.variationAxes) ? p.variationAxes : []))],
    etsyCategoryIds: channel === 'ETSY' ? categories : [],
    ebayCategoryIds: channel === 'EBAY' ? categories : [],
    ...(channel ? { onlyChannels: [channel], includeEmptyChannels: true } : {}),
  })
}
