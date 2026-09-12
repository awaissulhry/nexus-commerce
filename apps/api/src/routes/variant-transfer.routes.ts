import type { FastifyInstance, FastifyRequest } from 'fastify'
import { parse } from 'csv-parse/sync'
import { getFamilyRead, getProjectionRead, writeProjectionInclusion, type ProjectionRead } from '../services/pim/family-projection.service.js'
import { getInformationSheet } from '../services/pim/information-sheet.js'
import { canonicalVariantAxis } from '../services/pim/variant-attribute-keys.js'
import { applyProductBulkEdits, type ProductBulkInput } from '../services/products/bulk-edit.service.js'
import { countDiff, canonical, type DiffCell } from '../services/pim/import-diff.service.js'
import { storePreview, readJob, applyStoredJob, revertStoredJob, toWireState, type StoredCell } from '../services/pim/import-jobs.service.js'

interface Scope { productId: string; market: string; locale?: string; channel?: string; accountId?: string; aliasKey?: string }
type Route = { sharedValue?: unknown; storedOverride?: boolean; field: string; version: number; kind: 'master' | 'channel'; coordinate?: { channel: string; marketplace: string; accountId: string; aliasKey: string } }
interface Column { key: string; label: string; kind: string; writeTarget: 'master' | 'channelListing'; writeField: string; editable: boolean }
interface Row { id: string; sku: string; values: Record<string, unknown>; routes: Record<string, Route> }

const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const scopeOf = (id: string, raw: Record<string, unknown>): Scope => {
  const market = String(raw.market ?? '').trim().toUpperCase()
  if (!market) throw failure('Choose a market before importing variants.')
  const channel = raw.channel ? String(raw.channel).toUpperCase() : undefined
  const accountId = raw.accountId ? String(raw.accountId) : undefined
  if (channel && !accountId) throw failure('Choose an account before importing channel variants.')
  return { productId: id, market, locale: raw.locale ? String(raw.locale) : undefined, channel, accountId, aliasKey: String(raw.aliasKey ?? '') }
}

/** Template keys bind every channel column to its account, market and alias. */
async function snapshot(scope: Scope) {
  const selected = scope.channel ? await getProjectionRead({ productId: scope.productId, channel: scope.channel, market: scope.market, accountId: scope.accountId, aliasKey: scope.aliasKey, locale: scope.locale, includeOrder: false }) : null
  const family = selected ? null : await getFamilyRead(scope.productId, scope.market, scope.locale)
  const shared = selected ? null : await getInformationSheet({ productId: scope.productId, market: scope.market, locale: scope.locale, scope: 'master', includeMapping: false })
  const rows: Row[] = (selected?.children ?? family!.children).map(child => ({ id: child.id, sku: child.sku, values: {}, routes: {} }))
  const columns: Column[] = []
  const projections: ProjectionRead[] = selected
    ? [selected]
    : await Promise.all(family!.channels.filter(channel => channel.connected && channel.accountId).map(channel =>
      getProjectionRead({ productId: scope.productId, channel: channel.channel, market: channel.market, accountId: channel.accountId!, locale: scope.locale, includeOrder: false })))
  if (family && shared) for (const axis of family.axes) {
    const column = shared.columns.find(col => canonicalVariantAxis(col.key) === canonicalVariantAxis(axis.storedKey))
    if (!column) continue
    const key = `axis:${axis.key}`
    columns.push({ key, label: axis.label, kind: 'text', writeTarget: 'master', writeField: column.writeField ?? column.key, editable: true })
    for (const row of rows) {
      const source = shared.rows.find(child => child.id === row.id)
      const cell = source?.values[column.key]
      row.values[key] = cell?.value ?? null
      if (cell?.writable && cell.writeTarget === 'master' && source) row.routes[key] = { field: cell.writeField, version: source.version, kind: 'master' }
    }
  }
  for (const page of projections) {
    const { channel, market: marketplace, accountId, aliasKey } = page.coordinate
    if (!accountId) continue
    const coordinate = { channel, marketplace, accountId, aliasKey }
    const suffix = `@${channel}:${marketplace}:${accountId}:${encodeURIComponent(aliasKey)}`
    const included = `included${suffix}`
    columns.push({ key: included, label: `${page.coordinate.label} · Included`, kind: 'boolean', writeTarget: 'channelListing', writeField: included, editable: true })
    if (scope.channel) for (const axis of page.axes) columns.push({ key: `axis:${axis.key}${suffix}`, label: `${axis.label} · ${page.coordinate.label}`, kind: 'text', writeTarget: 'channelListing', writeField: `axis:${axis.key}${suffix}`, editable: true })
    for (const row of rows) {
      const child = page.children.find(child => child.id === row.id)
      if (!child) continue
      row.values[included] = child.included
      row.routes[included] = { field: included, kind: 'channel', coordinate, version: page.version }
      if (scope.channel) for (const axis of page.axes) {
        const key = `axis:${axis.key}${suffix}`, cell = child.values[axis.key]
        row.values[key] = cell?.value ?? null
        if (cell?.write?.target === 'channelListing' && cell.write.version !== null) row.routes[key] = { field: cell.write.field, kind: 'channel', coordinate, version: cell.write.version, sharedValue: cell.inheritedValue, storedOverride: cell.storedOverride }
      }
    }
  }
  return { rows, columns, scope: { kind: scope.channel ? 'channel' as const : 'master' as const, channel: scope.channel ?? null,
    marketplace: scope.market, locale: shared?.schema.locale ?? scope.locale, label: scope.channel ? `${scope.channel} · ${scope.market}` : 'Shared product', template: 'variants', ...scope } }
}

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
const actor = (request: FastifyRequest) => ({ formulaCascade: false, logger: request.log,
  userId: (request as FastifyRequest & { authUser?: { id: string } }).authUser?.id, ip: request.ip })

/** Uses the sheet's stored preview, before-value checks, outcomes and revert machinery. */
export async function registerVariantTransfer(fastify: FastifyInstance) {
  const base = '/products/:id/studio/variants/import'
  fastify.get(`${base}/template`, async (request, reply) => {
    const state = await snapshot(scopeOf((request.params as { id: string }).id, request.query as Record<string, unknown>))
    const keys = state.columns.map(column => column.key)
    const lines = [['SKU', ...state.columns.map(column => column.label)], ['sku', ...keys], ...state.rows.map(row => [row.sku, ...keys.map(key => row.values[key])])]
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="variants.csv"').send(lines.map(line => line.map(csvCell).join(',')).join('\r\n'))
  })
  fastify.post(`${base}/diff`, async (request, reply) => {
    const fields: Record<string, string> = {}
    let csv = '', filename = 'variants.csv'
    for await (const part of request.parts()) {
      if (part.type === 'file') { csv = (await part.toBuffer()).toString('utf8'); filename = part.filename }
      else fields[part.fieldname] = String(part.value)
    }
    if (!csv.trim()) throw failure('Choose a variants CSV file.')
    if (fields.blankCells !== 'ignore' && fields.blankCells !== 'clear') throw failure('Choose whether blank cells are ignored or cleared.')
    const id = (request.params as { id: string }).id
    const state = await snapshot(scopeOf(id, fields))
    let grid: string[][]
    try { grid = parse(csv, { skip_empty_lines: true, relax_column_count: false }) as string[][] }
    catch (error) { throw failure(`The CSV could not be read: ${error instanceof Error ? error.message : String(error)}`) }
    const keyIndex = grid[1]?.[0] === 'sku' ? 1 : 0
    const keys = grid[keyIndex]
    if (!keys || keys[0] !== 'sku' || new Set(keys).size !== keys.length) throw failure('Use the variants template with one unique key per column and SKU first.')
    const columns = new Map(state.columns.map(column => [column.key, column]))
    const unmatchedColumns = keys.slice(1).filter(key => !columns.has(key)).map(header => ({ header, key: header, reason: 'This column does not belong to the selected family and coordinate.' }))
    const unmatchedRows: Array<{ line: number; sku: string; reason: string }> = []
    const cells: DiffCell[] = []
    const seen = new Set<string>()
    for (const [index, line] of grid.slice(keyIndex + 1).entries()) {
      const row = state.rows.find(row => row.sku === line[0])
      if (!row || seen.has(line[0])) { unmatchedRows.push({ line: index + keyIndex + 2, sku: line[0], reason: row ? 'Duplicate SKU in this file.' : 'This SKU is not a variant in this family.' }); continue }
      seen.add(row.sku)
      for (const [at, key] of keys.entries()) {
        const column = columns.get(key)
        if (!column) continue
        const route = row.routes[key], raw = line[at] ?? '', before = row.values[key] ?? null
        let after: unknown = raw === '' && fields.blankCells === 'ignore' ? before : raw || null
        let reason: string | undefined
        if (column.kind === 'boolean' && after !== before) {
          if (/^(true|yes|1)$/i.test(raw)) after = true
          else if (/^(false|no|0)$/i.test(raw)) after = false
          else reason = 'Inclusion must be true or false.'
        }
        if (!route) reason = 'This value cannot be changed on the selected coordinate.'
        if (route && !key.startsWith('included@') && canonical(before) !== canonical(after)) {
          try {
            const result = await applyProductBulkEdits({ dryRun: true, changes: [{ id: row.id, field: route.field, value: after, target: route.kind === 'channel' ? 'channel' : 'master' }],
              marketplaceContexts: [route.coordinate ?? { marketplace: state.scope.marketplace }] as ProductBulkInput['marketplaceContexts'] }, actor(request))
            reason = 'errors' in result ? result.errors?.[0]?.error : undefined
          } catch (err) { reason = err instanceof Error ? err.message : String(err) }
        }
        cells.push({ rowId: row.id, aliasKey: route?.coordinate?.aliasKey ?? '', aliasResolved: true, fieldKey: key, writeField: route?.field ?? key,
          scope: { kind: route?.kind ?? 'master', channel: route?.coordinate?.channel ?? null, marketplace: route?.coordinate?.marketplace ?? state.scope.marketplace, locale: state.scope.locale },
          before, after, verdict: reason ? 'refused' : canonical(before) === canonical(after) ? 'unchanged' : 'changed', restoreIntent: route?.kind === 'channel' && route.storedOverride === false ? 'reset' : 'set',
          pins: route?.kind === 'channel' && !key.startsWith('included@') && canonical(before) === canonical(route.sharedValue) && canonical(after) !== canonical(route.sharedValue), ...(reason ? { reason } : {}) })
      }
    }
    const counts = countDiff(cells)
    const stored = await storePreview({ cells, counts, productId: id, filename, userId: actor(request).userId, blankPolicy: fields.blankCells, scope: state.scope, market: state.scope.marketplace })
    return { ...stored, file: { name: filename, rows: grid.length - keyIndex - 1, columns: keys.length }, scope: state.scope,
      blankCells: fields.blankCells, counts, columns: state.columns, unmatchedRows, unmatchedColumns,
      coverageNote: 'Only the shown variant values and inclusion coordinates can change. No listing is published.',
      rows: state.rows.filter(row => seen.has(row.sku)).map(row => ({ productId: row.id, aliasKey: state.scope.aliasKey, aliasResolved: true, sku: row.sku,
        cells: Object.fromEntries(cells.filter(cell => cell.rowId === row.id).map(cell => [cell.fieldKey, cell])) })) }
  })
  const load = async (id: string, jobId: string) => {
    const loaded = await readJob(jobId)
    const stored = loaded?.scope as unknown as (Scope & { template?: string }) | undefined
    if (!loaded || stored?.template !== 'variants' || stored.productId !== id) throw failure('This preview does not belong to this family.', 404)
    return { loaded, scope: stored }
  }
  fastify.get(`${base}/jobs/:jobId`, async request => {
    const { id, jobId } = request.params as { id: string; jobId: string }, { loaded } = await load(id, jobId)
    return { jobId, state: toWireState(loaded.job.status), phase: loaded.phase, processed: loaded.job.processed, total: loaded.cells.length,
      outcomes: loaded.outcomes, expiresAt: loaded.job.expiresAt?.toISOString() }
  })
  for (const verb of ['apply', 'revert'] as const) fastify.post(`${base}/jobs/:jobId/${verb}`, async request => {
    const { id, jobId } = request.params as { id: string; jobId: string }, { scope } = await load(id, jobId)
    const current = await snapshot(scope)
    const currentOf = async (cell: StoredCell) => current.rows.find(row => row.id === cell.productId)?.values[cell.fieldKey] ?? null
    const writeCells = async (cells: StoredCell[]) => {
      let applied = 0
      const errors: Array<{ productId: string; fieldKey: string; error: string }> = []
      // Re-read between writes for fresh product/listing versions. Each writer performs its own CAS.
      for (const cell of cells) {
        try {
          const fresh = await snapshot(scope), row = fresh.rows.find(row => row.id === cell.productId), route = row?.routes[cell.fieldKey]
          if (!row || !route) throw failure('The variant or write route changed since preview.')
          if (canonical(row.values[cell.fieldKey]) !== canonical(await currentOf(cell))) throw failure('changed since the preview')
          if (cell.fieldKey.startsWith('included@')) {
            if (!route.coordinate || typeof cell.after !== 'boolean') throw failure('Inclusion needs an explicit coordinate and boolean value.')
            await writeProjectionInclusion({ productId: id, channel: route.coordinate.channel, market: route.coordinate.marketplace,
              accountId: route.coordinate.accountId, aliasKey: route.coordinate.aliasKey, expectedVersion: route.version, changes: [{ id: cell.productId, included: cell.after }] })
          } else {
            const result = await applyProductBulkEdits({ changes: [{ id: cell.productId, field: route.field, value: verb === 'revert' && cell.restoreIntent === 'reset' ? null : cell.after, intent: verb === 'revert' && cell.restoreIntent === 'reset' ? 'reset' : 'set', target: route.kind === 'channel' ? 'channel' : 'master' }], expectedVersion: route.version,
              marketplaceContexts: [route.coordinate ?? { marketplace: scope.market }] as ProductBulkInput['marketplaceContexts'] }, actor(request))
            if ('errors' in result && result.errors?.length) throw failure(result.errors.map(error => error.error).join('; '))
          }
          applied++
        } catch (err) { errors.push({ productId: cell.productId, fieldKey: cell.fieldKey, error: err instanceof Error ? err.message : String(err) }) }
      }
      return { applied, errors }
    }
    const result = verb === 'apply' ? await applyStoredJob({ jobId, currentOf, writeCells }) : await revertStoredJob({ jobId, currentOf, writeCells })
    return { ...result, state: toWireState(result.state) }
  })
}
