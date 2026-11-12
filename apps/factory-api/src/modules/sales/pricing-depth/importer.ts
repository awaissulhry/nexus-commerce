import { newId } from '@nexus/factory-domain/core/ids'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import { markValues, type ExistingRecord, type RowIssue } from '@nexus/factory-domain/imports/importer'
import { listPriceText } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_MANAGE, PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { breaksOf as breaksOfCell, EVERY_COLOURWAY, OPEN, priceListImporter, priceRecordValues } from '@nexus/factory-domain/sales/pricing-depth/importer'
import { breakProblems, daysText, overlapProblems, type DatedEntry } from '@nexus/factory-domain/sales/pricing-depth/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter, ImportScope } from '../../../platform/imports/registry'
import { mayWrite } from '../../product/materials/store'
import { dayText, dayValue, ENTRY_COLUMNS, lockList, priceOf, type EntryRow } from '../pricelists/store'
import { BREAK_COLUMNS } from './store'

/**
 * The price list import's adapter (platform/imports; SAL-183; factory-domain sales/pricing-depth/importer). A row is a
 * price of its list's DRAFT version, found by list code, style, colourway (`*` every colourway) and first day (`-` from
 * the version's start):
 *
 *   authorize  a job for every company (a list of every company) needs pricelists.manage over every company (the engine
 *              checks pricelists.manage against the job's company, and pricelists.view to see the plans)
 *   load       the prices the keys name, in the list's draft, as the export writes them (`priceRecordValues`)
 *   check      every row against what it names, read again: the list (the job's company, active, with a draft), the
 *              style (the list's company or every company, not archived), its colourway (active), the days (never
 *              over another price of the style and colourway, in the draft or earlier in the sheet), the breaks (each
 *              lowering the price), so the review shows each problem in words before anything is written
 *   write      one price in the batch's command: the list's row FOR UPDATE (every price list write's first lock), the
 *              draft's version moved (an open screen then sees a newer version), the price and its breaks written, the
 *              days checked again, the audit row and `price_list.version_changed` (PRICES)
 */

const ACTION = 'priceLists.import'

class ImportRowRefused extends ApiError {
  constructor(what: string, detail: string) {
    super('conflict', `The import row for ${what} no longer fits: ${detail}. Run the dry run again.`)
  }
}

const keyText = (key: Readonly<Record<string, CellValue>>) => ({ list: String(key.list), style: String(key.style), colourway: String(key.colourway), validFrom: String(key.validFrom) })
const what = (key: Readonly<Record<string, CellValue>>): string => {
  const k = keyText(key)
  return `${k.list} ${k.style}${k.colourway === EVERY_COLOURWAY ? '' : ` ${k.colourway}`}${k.validFrom === OPEN ? '' : ` from ${k.validFrom}`}`
}

interface ListFacts {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
  readonly status: string
  readonly draft: { readonly id: string; readonly revision: number } | null
}
interface StyleFacts {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
  readonly status: string
  readonly colourways: ReadonlyMap<string, { readonly id: string; readonly status: string }>
}

async function factsOf(client: CommandTx, keys: readonly Readonly<Record<string, CellValue>>[]) {
  const listCodes = [...new Set(keys.map((key) => keyText(key).list))]
  const lists = listCodes.length === 0 ? [] : await client.priceList.findMany({ where: { code: { in: listCodes } }, select: { id: true, code: true, companyId: true, status: true } })
  const drafts = lists.length === 0 ? [] : await client.priceListVersion.findMany({ where: { listId: { in: lists.map((row) => row.id) }, status: 'DRAFT' }, select: { id: true, listId: true, revision: true } })
  const styleCodes = [...new Set(keys.map((key) => keyText(key).style))]
  const styles = styleCodes.length === 0 ? [] : await client.style.findMany({ where: { code: { in: styleCodes } }, select: { id: true, code: true, companyId: true, status: true } })
  const colourways = styles.length === 0 ? [] : await client.colourway.findMany({ where: { styleId: { in: styles.map((row) => row.id) } }, select: { id: true, styleId: true, code: true, status: true } })
  const entries = drafts.length === 0 ? [] : await client.priceListEntry.findMany({ where: { versionId: { in: drafts.map((row) => row.id) } }, select: ENTRY_COLUMNS, orderBy: [{ validFrom: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }] })
  const breaks = drafts.length === 0 ? [] : await client.priceBreak.findMany({ where: { versionId: { in: drafts.map((row) => row.id) }, entryId: { not: null } }, select: BREAK_COLUMNS })
  return {
    lists: new Map<string, ListFacts>(lists.map((row) => [row.code, { ...row, draft: drafts.find((draft) => draft.listId === row.id) ?? null }])),
    styles: new Map<string, StyleFacts>(styles.map((row) => [row.code, { ...row, colourways: new Map(colourways.filter((colourway) => colourway.styleId === row.id).map((colourway) => [colourway.code, { id: colourway.id, status: colourway.status }])) }])),
    entries,
    breaks,
  }
}
type Facts = Awaited<ReturnType<typeof factsOf>>

/** The price a key names in the draft, or null. */
function entryFor(facts: Facts, list: ListFacts, style: StyleFacts, colourwayId: string | null, validFrom: string | null): EntryRow | null {
  return facts.entries.find((entry) => entry.versionId === list.draft?.id && entry.styleId === style.id && entry.colourwayId === colourwayId && dayText(entry.validFrom) === validFrom) ?? null
}

const exportedOf = (facts: Facts, list: ListFacts, style: StyleFacts, colourway: string | null, entry: EntryRow) =>
  priceRecordValues({
    list: list.code,
    style: style.code,
    colourway,
    validFrom: dayText(entry.validFrom),
    validTo: dayText(entry.validTo),
    unitPrice: priceOf(entry.unitPrice),
    breaks: facts.breaks.filter((row) => row.entryId === entry.id).map((row) => ({ minQuantity: row.minQuantity, unitPrice: row.unitPrice === null ? null : priceOf(row.unitPrice), discountPct: row.discountPct === null ? null : row.discountPct.toString() })),
  })

type Resolution =
  | { readonly ok: true; readonly list: ListFacts & { readonly draft: { readonly id: string; readonly revision: number } }; readonly style: StyleFacts; readonly colourwayId: string | null; readonly validFrom: string | null; readonly current: EntryRow | null }
  | { readonly ok: false; readonly issues: RowIssue[] }

/** Resolves a row's key against the database (reads only). */
function resolve(facts: Facts, key: Readonly<Record<string, CellValue>>, scope: ImportScope): Resolution {
  const k = keyText(key)
  const list = facts.lists.get(k.list)
  if (!list) return { ok: false, issues: [{ column: 'list', message: `No price list ${k.list}.` }] }
  if (list.companyId !== scope.companyId) return { ok: false, issues: [{ column: 'list', message: list.companyId === null ? `${k.list} is a list of every company: import its prices with a job for every company.` : `${k.list} belongs to another company: import its prices with that company.` }] }
  if (list.status === 'ARCHIVED') return { ok: false, issues: [{ column: 'list', message: `${k.list} is archived: reactivate it before importing its prices.` }] }
  if (list.draft === null) return { ok: false, issues: [{ column: 'list', message: `${k.list} has no draft version (an active version's prices are fixed): make the next version, then import into it.` }] }
  const style = facts.styles.get(k.style)
  if (!style || (list.companyId === null ? style.companyId !== null : style.companyId !== null && style.companyId !== list.companyId)) return { ok: false, issues: [{ column: 'style', message: list.companyId === null ? `No style ${k.style} of every company.` : `No style ${k.style} of the list's company.` }] }
  let colourwayId: string | null = null
  if (k.colourway !== EVERY_COLOURWAY) {
    const colourway = style.colourways.get(k.colourway)
    if (!colourway) return { ok: false, issues: [{ column: 'colourway', message: `${k.style} has no colourway ${k.colourway}.` }] }
    colourwayId = colourway.id
  }
  const validFrom = k.validFrom === OPEN ? null : k.validFrom
  return { ok: true, list: { ...list, draft: list.draft }, style, colourwayId, validFrom, current: entryFor(facts, list, style, colourwayId, validFrom) }
}

/** The row's own problems once resolved: an archived style or colourway, breaks that do not lower the price. */
function rowIssues(resolved: Extract<Resolution, { ok: true }>, values: CheckRow['values']): RowIssue[] {
  const issues: RowIssue[] = []
  if (resolved.style.status === 'ARCHIVED') issues.push({ column: 'style', message: `${resolved.style.code} is archived: it is not priced.` })
  if (resolved.colourwayId !== null && [...resolved.style.colourways.values()].find((row) => row.id === resolved.colourwayId)?.status !== 'ACTIVE') issues.push({ column: 'colourway', message: `Not an active colourway of ${resolved.style.code}.` })
  const price = typeof values.unitPrice === 'string' ? values.unitPrice : resolved.current ? priceOf(resolved.current.unitPrice) : null
  if (price === null) issues.push({ column: 'unitPrice', message: 'A new price needs its unit price.' })
  if (typeof values.breaks === 'string' && price !== null) {
    const rows = breaksOfCell(values.breaks).map((row) => ({ ...row, entryId: 'row' }))
    if (rows.length > 0) for (const issue of breakProblems(rows, new Map([['row', price]]))) issues.push({ column: 'breaks', message: issue.message })
  }
  return issues
}

/** The days the row gives, against the draft's other prices of the style and colourway and the rows before it. */
function daysIssues(facts: Facts, resolved: Extract<Resolution, { ok: true }>, values: CheckRow['values'], earlier: readonly DatedEntry[]): { issues: RowIssue[]; entry: DatedEntry } {
  const validTo = typeof values.validTo === 'string' ? (values.validTo === OPEN ? null : values.validTo) : resolved.current ? dayText(resolved.current.validTo) : null
  const entry: DatedEntry = { id: resolved.current?.id ?? `row:${resolved.style.id}:${resolved.colourwayId ?? '*'}:${resolved.validFrom ?? '-'}`, styleId: resolved.style.id, colourwayId: resolved.colourwayId, validFrom: resolved.validFrom, validTo }
  if (validTo !== null && resolved.validFrom !== null && validTo < resolved.validFrom) return { issues: [{ column: 'validTo', message: 'The last day is on or after the first.' }], entry }
  const others: DatedEntry[] = [
    ...facts.entries.filter((row) => row.versionId === resolved.list.draft.id && row.id !== resolved.current?.id && row.styleId === resolved.style.id && row.colourwayId === resolved.colourwayId).map((row) => ({ id: row.id, styleId: row.styleId, colourwayId: row.colourwayId, validFrom: dayText(row.validFrom), validTo: dayText(row.validTo) })),
    ...earlier.filter((row) => row.styleId === resolved.style.id && row.colourwayId === resolved.colourwayId && row.id !== entry.id),
  ]
  const clash = others.find((other) => overlapProblems([other, entry], () => '').length > 0)
  return clash ? { issues: [{ column: 'validFrom', message: `The style has another price on these days (${daysText(clash)}): the days of one style's prices never overlap.` }], entry } : { issues: [], entry }
}

export const priceListImportAdapter = Object.freeze({
  importer: priceListImporter,
  permission: PRICE_LISTS_MANAGE,
  viewPermission: PRICE_LISTS_VIEW,

  authorize(actor, job) {
    if (job.companyId === null && !mayWrite(actor, PRICE_LISTS_MANAGE, null)) {
      return [{ path: 'companyId', message: 'A price import for every company (lists of every company) needs pricelists.manage over every company; import for one company instead.' }]
    }
    return []
  },

  async load(client, keys, scope) {
    const facts = await factsOf(client, keys)
    const records: ExistingRecord[] = []
    for (const key of keys) {
      const resolved = resolve(facts, key, scope)
      if (!resolved.ok || !resolved.current) continue
      records.push({ id: resolved.current.id, values: exportedOf(facts, resolved.list, resolved.style, resolved.colourwayId === null ? null : keyText(key).colourway, resolved.current) })
    }
    return records
  },

  async check(client, rows: readonly CheckRow[], scope) {
    const facts = await factsOf(client, rows.map((row) => row.key))
    const earlier: DatedEntry[] = []
    return rows.map((row) => {
      const resolved = resolve(facts, row.key, scope)
      if (!resolved.ok) return resolved.issues
      const own = rowIssues(resolved, row.values)
      const days = daysIssues(facts, resolved, row.values, earlier)
      if (own.length === 0 && days.issues.length === 0) earlier.push(days.entry)
      return [...own, ...days.issues]
    })
  },

  async write(tools: CommandTools, row, scope) {
    const { tx, now } = tools
    const named = what(row.key)
    const seen = await factsOf(tx, [row.key])
    const first = seen.lists.get(keyText(row.key).list)
    if (!first) throw new ImportRowRefused(named, 'the price list is gone')
    await lockList(tx, first.id)
    const facts = await factsOf(tx, [row.key])
    const resolved = resolve(facts, row.key, scope)
    if (!resolved.ok) throw new ImportRowRefused(named, resolved.issues.map((issue) => issue.message).join(' '))
    if ((row.action === 'UPDATE') !== (resolved.current !== null) || (resolved.current !== null && resolved.current.id !== row.recordId)) throw new ImportRowRefused(named, 'the price was added or removed')
    const issues = [...rowIssues(resolved, row.values), ...daysIssues(facts, resolved, row.values, []).issues]
    if (issues.length > 0) throw new ImportRowRefused(named, issues.map((issue) => issue.message).join(' '))
    const draft = await tx.priceListVersion.update({ where: { id: resolved.list.draft.id }, data: { version: { increment: 1 }, updatedAt: now }, select: { status: true, version: true } })
    if (draft.status !== 'DRAFT') throw new ImportRowRefused(named, `version ${resolved.list.draft.revision} is no longer a draft`)
    const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
    const values = row.values
    const validTo = typeof values.validTo === 'string' ? (values.validTo === OPEN ? null : dayValue(values.validTo)) : undefined
    const unitPrice = typeof values.unitPrice === 'string' ? listPriceText(values.unitPrice) : undefined
    let entryId: string
    if (resolved.current) {
      entryId = resolved.current.id
      if (unitPrice !== undefined || validTo !== undefined) await tx.priceListEntry.update({ where: { id: entryId }, data: { ...(unitPrice !== undefined ? { unitPrice } : {}), ...(validTo !== undefined ? { validTo } : {}), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    } else {
      entryId = newId()
      await tx.priceListEntry.create({ data: { id: entryId, versionId: resolved.list.draft.id, styleId: resolved.style.id, colourwayId: resolved.colourwayId, unitPrice: unitPrice!, validFrom: resolved.validFrom === null ? null : dayValue(resolved.validFrom), validTo: validTo ?? null, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
    }
    if (typeof values.breaks === 'string') {
      // The cell is the price's whole set of breaks.
      await tx.priceBreak.deleteMany({ where: { versionId: resolved.list.draft.id, entryId } })
      const breaks = breaksOfCell(values.breaks)
      if (breaks.length > 0) await tx.priceBreak.createMany({ data: breaks.map((entry) => ({ id: newId(), versionId: resolved.list.draft.id, entryId, minQuantity: entry.minQuantity, unitPrice: entry.unitPrice, discountPct: entry.discountPct, createdAt: now, updatedAt: now, createdById: actorId })) })
    }
    tools.audit({
      action: ACTION,
      recordType: 'PriceList',
      recordId: resolved.list.id,
      companyId: resolved.list.companyId,
      ...(resolved.current ? { before: { versionId: resolved.list.draft.id, entryId, values: markValues(priceListImporter, row.before) } } : {}),
      after: { versionId: resolved.list.draft.id, entryId, [resolved.current ? 'changed' : 'added']: markValues(priceListImporter, values) },
    })
    tools.emit({ type: 'price_list.version_changed', subject: resolved.list.id, companyId: resolved.list.companyId, payload: { listId: resolved.list.id, versionId: resolved.list.draft.id, revision: resolved.list.draft.revision, change: 'PRICES' } })
    return { recordId: entryId }
  },
} satisfies ImportAdapter)
