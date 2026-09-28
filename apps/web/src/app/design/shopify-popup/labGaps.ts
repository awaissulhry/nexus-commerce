/**
 * The known gaps per type, from docs/shopify-metafields/PLAN-2026-09-28.md §3 — shown on the lab's rows so what is not
 * right yet is on screen, never hidden. A slice that closes a gap removes its line here in the same change.
 */
import { SHOPIFY_MEASUREMENT_KINDS, shopifyBaseType } from '@nexus/shared/shopify-type-catalog'

export interface LabGap { id: string; text: string; slice: string }

const RAW_JSON = new Set(SHOPIFY_MEASUREMENT_KINDS.filter(kind => !['dimension', 'weight', 'volume'].includes(kind)))

export function labGapsFor(type: string): LabGap[] {
  const base = shopifyBaseType(type), list = type.startsWith('list.')
  const gaps: LabGap[] = []
  if (!list && RAW_JSON.has(base)) gaps.push({ id: 'G13', text: 'The cell shows raw JSON.', slice: 'B3' })
  if (RAW_JSON.has(base)) gaps.push({ id: 'G14', text: 'A limit in another unit cannot be checked.', slice: 'B3' })
  if (base === 'rating') gaps.push({ id: 'G2', text: 'The editor lets you type the scale.', slice: 'B1' })
  if (base === 'boolean') gaps.push({ id: 'G3', text: 'The cell says Yes/No; the editor says True/False.', slice: 'B1' })
  if (list && !base.endsWith('_reference')) gaps.push({ id: 'G4', text: '"Add value" stays active at the list limit.', slice: 'B1' })
  if (base === 'multi_line_text_field') gaps.push({ id: 'G5', text: 'Enter adds a line, but the key line says "Enter saves".', slice: 'B1' })
  if (base === 'file_reference') gaps.push({ id: 'G8', text: 'The file list shows every kind; a pasted wrong kind passes the draft.', slice: 'B1' })
  if (base === 'date_time') gaps.push({ id: 'G15', text: 'Plain text box; a loose date check.', slice: 'B3' })
  if (base === 'json' || base === 'jurisdiction') gaps.push({ id: 'G16', text: 'A text box with a wrong hint.', slice: 'B3' })
  if (base === 'link') gaps.push({ id: 'G17', text: 'The allowed sites are not checked.', slice: 'B3' })
  if (base === 'product_taxonomy_value_reference') gaps.push({ id: 'G12', text: 'Found only by a typed raw id; its attribute is not checked.', slice: 'B2' })
  if (base === 'mixed_reference' || base === 'disclosure_reference') gaps.push({ id: 'G18', text: 'The older picker (choose a kind first).', slice: 'B3' })
  return gaps
}
