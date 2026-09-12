import { z } from 'zod'
import type { InformationField } from '@nexus/shared/shopify-information'

const prefix = 'NEXUS_SHOPIFY_VALUE_V1:'
const schema = z.object({ accountId: z.string().min(1), type: z.string(), kind: z.enum(['native', 'metafield']), value: z.string().nullable() }).strict()
export const acceptsTextTransfer = (f: InformationField) => f.cardinality === 'scalar' && ['single_line_text_field', 'multi_line_text_field', 'number_integer', 'number_decimal', 'boolean', 'inventory_policy', ...(!f.definition ? ['money'] : [])].includes(f.type)
export const transferableField = (f: InformationField) => !['media', 'inventory', 'salesChannels'].includes(f.id) && f.editor !== 'unavailable'
export function encodeInformationTransfer(field: InformationField, value: string | null, accountId: string): string {
  if (value !== null && acceptsTextTransfer(field)) return value
  return prefix + JSON.stringify({ accountId, type: field.type, kind: field.definition ? 'metafield' : 'native', value })
}
export function decodeInformationTransfer(raw: string, field: InformationField, accountId: string): { value: string | null; error?: string } {
  if (!transferableField(field)) return { value: null, error: 'Use this field’s editor to review its exact destination.' }
  if (raw.startsWith(prefix)) {
    try {
      const value = schema.parse(JSON.parse(raw.slice(prefix.length)))
      if (value.accountId !== accountId || value.type !== field.type || value.kind !== (field.definition ? 'metafield' : 'native')) return { value: null, error: 'The copied value belongs to another store or an incompatible field type.' }
      return { value: value.value }
    } catch { return { value: null, error: 'This copied Shopify value is incomplete. Copy it again.' } }
  }
  if (/^NEXUS_|^gid:\/\/shopify\//.test(raw) || !acceptsTextTransfer(field)) return { value: null, error: 'Paste a compatible typed value copied from a Shopify cell, or use its editor.' }
  return { value: raw === '' && ['money', 'number_integer', 'number_decimal', 'boolean'].includes(field.type) ? null : raw }
}
/** Excel/Sheets quoted TSV, including multiline cells and intentional final empty cells. */
export function informationClipboardMatrix(text: string): string[][] {
  const rows: string[][] = [[]]; let value = '', quoted = false, start = true
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' && (quoted || start)) {
      if (quoted && text[i + 1] === '"') { value += '"'; i++ } else quoted = !quoted
    } else if (!quoted && (c === '\t' || c === '\n' || c === '\r')) {
      rows[rows.length - 1].push(value); value = ''; start = true
      if (c !== '\t') { if (c === '\r' && text[i + 1] === '\n') i++; if (i < text.length - 1) rows.push([]) }
      continue
    } else value += c
    start = false
  }
  if (quoted) throw new Error('The pasted table has an unclosed quoted cell.')
  if (!/[\r\n]$/.test(text) || value || !rows[rows.length - 1].length) rows[rows.length - 1].push(value)
  return rows
}
