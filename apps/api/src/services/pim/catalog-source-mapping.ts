import type { TransferRow, TransferIssue, TransferMode } from '@nexus/shared/catalog-transfer'
import { parseTransferRecords, TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'

/** Incoming columns describe writes. They never define outgoing channel resolution rules. */
export type SourceReference = { column: string } | { value: string }
export interface SourceBinding {
  source: string
  entity: TransferRow['entity']
  field: string
  format: 'text' | 'json'
  action?: TransferRow['action']
  actionColumn?: string
  versionColumn?: string
  channel?: SourceReference
  accountId?: SourceReference
  marketplace?: SourceReference
  aliasKey?: SourceReference
  locale?: SourceReference
}
export interface SourceMapping {
  kind: 'catalog-source-v1'
  skuColumn: string
  market: string
  mode: TransferMode
  bindings: SourceBinding[]
  policy: { shared: 'replace' | 'fill-empty' | 'exclude'; overrides: 'replace' | 'preserve' | 'exclude' }
  execution?: 'review' | 'automatic'
}
export interface SourceExclusion extends TransferIssue { identity?: TransferRow }
export interface SourceTable { headers: string[]; records: Record<string, string>[] }

const key = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 250 && !/(^|[.\[\]])(__proto__|prototype|constructor)($|[.\[\]])/.test(v)
export function validateSourceMapping(value: unknown): SourceMapping {
  const m = value as SourceMapping
  if (m?.kind !== 'catalog-source-v1' || !key(m.skuColumn) || !/^(?:[A-Z]{2}|GLOBAL)$/.test(m.market) || !['create', 'update', 'upsert'].includes(m.mode)) throw new Error('Choose a SKU column, marketplace and import mode')
  if (!['replace', 'fill-empty', 'exclude'].includes(m.policy?.shared) || !['replace', 'preserve', 'exclude'].includes(m.policy?.overrides)) throw new Error('Declare the source policy for shared facts and existing overrides')
  if (m.execution && !['review', 'automatic'].includes(m.execution)) throw new Error('Choose reviewed or automatic scheduled execution')
  if (!Array.isArray(m.bindings) || !m.bindings.length || m.bindings.length > 200) throw new Error('Map between 1 and 200 incoming columns')
  for (const b of m.bindings) {
    if (!key(b.source) || !key(b.field) || !['Products', 'Listings', 'Overrides'].includes(b.entity) || !['text', 'json'].includes(b.format)) throw new Error('Each mapping needs a source column, valid destination field and value format')
    if (b.action && !['SET', 'CLEAR', 'INHERIT'].includes(b.action) || b.actionColumn && !key(b.actionColumn) || b.versionColumn && !key(b.versionColumn)) throw new Error('Invalid action or version column')
    for (const name of ['channel', 'accountId', 'marketplace', 'aliasKey', 'locale'] as const) {
      const ref = b[name]
      if (ref && (typeof ref !== 'object' || ('column' in ref ? !key(ref.column) || 'value' in ref : typeof ref.value !== 'string' || ref.value.length > 250))) throw new Error(`Invalid ${name} source`)
    }
    if (b.entity !== 'Products' && (!b.channel || !b.accountId || !b.marketplace)) throw new Error('Every channel mapping must explicitly select its channel, account and marketplace')
  }
  return JSON.parse(JSON.stringify(m))
}

export function mapSourceTable(table: SourceTable, mapping: SourceMapping) {
  validateSourceMapping(mapping)
  if (!table.headers.includes(mapping.skuColumn)) throw new Error(`The file is missing SKU column "${mapping.skuColumn}"`)
  const used = new Set([mapping.skuColumn])
  const rows: TransferRow[] = [], issues: TransferIssue[] = [], exclusions: SourceExclusion[] = []
  const read = (ref: SourceReference | undefined, r: Record<string, string>) => !ref ? '' : 'column' in ref ? r[ref.column] ?? '' : ref.value
  for (const b of mapping.bindings) {
    used.add(b.source)
    for (const header of [b.actionColumn, b.versionColumn, ...[b.channel, b.accountId, b.marketplace, b.aliasKey, b.locale].map(r => r && 'column' in r ? r.column : undefined)].filter(Boolean) as string[]) {
      used.add(header)
      if (!table.headers.includes(header)) throw new Error(`The file is missing coordinate/action/version column "${header}"`)
    }
  }
  if (table.records.length * mapping.bindings.length > TRANSFER_MAX_ROWS) throw new Error('The mapped file exceeds 50,000 attribute outcomes')
  for (const [i, record] of table.records.entries()) {
    const sku = (record[mapping.skuColumn] ?? '').trim(), row = i + 2
    if (!sku) { issues.push({ row, sku, field: 'sku', message: 'A stable SKU is required; no row-number or name matching is used' }); continue }
    for (const b of mapping.bindings) {
      const value = record[b.source] ?? ''
      const action = (b.actionColumn ? record[b.actionColumn]?.trim().toUpperCase() : b.action ?? 'SET') || 'SET'
      const raw = { entity: b.entity, sku, field: b.field, value, format: b.format, action,
        channel: read(b.channel, record), accountId: read(b.accountId, record), marketplace: read(b.marketplace, record), aliasKey: read(b.aliasKey, record), locale: read(b.locale, record), version: b.versionColumn ? record[b.versionColumn] ?? '' : '' }
      const excluded = !table.headers.includes(b.source) ? 'Source column omitted; existing value preserved'
        : action === 'SET' && !value.trim() ? 'Blank source cell; existing value preserved'
        : (b.entity === 'Products' ? mapping.policy.shared : mapping.policy.overrides) === 'exclude' ? 'Excluded by the declared source ownership policy' : null
      if (excluded) { exclusions.push({ row, sku, field: b.field, message: excluded, identity: { ...raw, row, action: 'SET', version: undefined } as TransferRow }); continue }
      const parsed = parseTransferRecords([raw])
      const column = table.headers.indexOf(b.source)
      const source = { column: `${column >= 26 ? String.fromCharCode(64 + Math.floor(column / 26)) : ''}${String.fromCharCode(65 + column % 26)}` }
      rows.push(...parsed.rows.map(r => ({ ...r, row, source })))
      issues.push(...parsed.issues.map(r => ({ ...r, row, source })))
    }
  }
  return { rows, issues, exclusions, unmappedColumns: table.headers.filter(h => !used.has(h)) }
}
