import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { activationPlan, changedRows, compareEntries, endProblems, entryKey, entryProblems, listPriceText, PRICE_LIST_LIMITS, validityProblems, type EntryInput } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_MANAGE } from '@nexus/factory-domain/sales/pricelists/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../quotes/store'
import { assertMayChangeList, claimVersion, dayText, dayValue, ENTRY_COLUMNS, entriesViewOf, lockList, priceOf, readListFor, VERSION_COLUMNS, versionFactsOf, versionsOf, versionViewOf, type ListRow } from './store'

/**
 * A price list's versions and prices (B-W2a-19; SAL-165; design record "Price list": Prices — autosave per cell, draft
 * only; Versions — Make next version, Activate, Compare two versions; pop-up "Activate version"). Every write is ONE
 * command that locks the list's row first, then compares and sets the version's own version (sent by the caller), so a
 * write to a list never interleaves with another and two writers never deadlock.
 *
 *   next version   a new DRAFT (revision + 1) with the prices of a version of the list (the newest by default); one
 *                  draft at a time
 *   edit           a draft's planned days and note; an active version's end (validTo) and note only
 *   delete         a draft and its prices (an active version is kept for good)
 *   prices         set or remove a draft's prices, one row per style and colourway (a colourway's own price, or the
 *                  style's for every colourway); prices above 0
 *   activate       the draft from a day (today or later; its planned days by default) to a day or open: the version in
 *                  force then ends the day before, in the same command, then the draft goes ACTIVE (the database guard
 *                  refuses an overlap). A draft with no price is not activated.
 *   compare        two versions' prices row by row
 */

const invalid = (issues: readonly Issue[], what = 'The price list version is not valid.'): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : what, issues.map((issue) => ({ path: issue.path.startsWith('body') ? issue.path : `body/${issue.path}`, message: issue.message })))

/** The version and the list after a write, in the command. */
async function versionAnswer(tools: CommandTools, list: ListRow, versionId: string) {
  const row = await tools.tx.priceListVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_COLUMNS })
  const entries = await entriesViewOf(tools.tx, tools.context, list, versionId, tools.now)
  return { version: versionViewOf(row, entries.length), entries }
}

async function assertListWritable(caller: CommandCaller, listId: string): Promise<ListRow> {
  const context = officeContextOf(caller)
  const list = await readListFor(caller, listId)
  assertMayChangeList(context, PRICE_LISTS_MANAGE, list.companyId)
  return list
}

const activeList = (list: ListRow): void => {
  if (list.status === 'ARCHIVED') throw new InvalidStateError(`${list.code} is archived: reactivate it before changing its versions.`)
}

// ---- reads -------------------------------------------------------------------------------------------------------------

/** GET /sales/price-lists/:listId/versions/:versionId: one version with its prices (and cost and margin by grain). */
export async function getVersion(caller: CommandCaller, listId: string, versionId: string) {
  const context = officeContextOf(caller)
  const list = await readListFor(caller, listId)
  return caller.withClient(async (client) => {
    const row = isUuid(versionId) ? await client.priceListVersion.findUnique({ where: { id: versionId }, select: VERSION_COLUMNS }) : null
    if (!row || row.listId !== listId) throw new NotFoundError('Price list version not found.')
    const entries = await entriesViewOf(client, context, list, row.id, serverClock.now())
    return { version: versionViewOf(row, entries.length), entries }
  })
}

/** GET …/versions/:versionId/compare?with=: the prices of `with` (before) against this version (after), row by row. */
export async function compareVersions(caller: CommandCaller, listId: string, versionId: string, withId: string) {
  await readListFor(caller, listId)
  return caller.withClient(async (client) => {
    const rows = await client.priceListVersion.findMany({ where: { id: { in: [versionId, withId].filter(isUuid) }, listId }, select: VERSION_COLUMNS })
    const after = rows.find((row) => row.id === versionId)
    const before = rows.find((row) => row.id === withId)
    if (!after || !before) throw new NotFoundError('Price list version not found.')
    const entries = await client.priceListEntry.findMany({ where: { versionId: { in: [after.id, before.id] } }, select: ENTRY_COLUMNS })
    const of = (id: string): EntryInput[] => entries.filter((entry) => entry.versionId === id).map((entry) => ({ styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: priceOf(entry.unitPrice) }))
    const compared = compareEntries(of(before.id), of(after.id))
    const styles = new Map((await client.style.findMany({ where: { id: { in: [...new Set(compared.map((row) => row.styleId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const colourways = new Map((await client.colourway.findMany({ where: { id: { in: [...new Set(compared.flatMap((row) => (row.colourwayId ? [row.colourwayId] : [])))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    return {
      before: { id: before.id, revision: before.revision },
      after: { id: after.id, revision: after.revision },
      changed: changedRows(compared),
      rows: compared
        .map((row) => ({ ...row, before: asMoney('price', row.before), after: asMoney('price', row.after), changePct: asMoney('price', row.changePct), style: styles.get(row.styleId) ?? { id: row.styleId, code: '', name: '' }, colourway: row.colourwayId ? (colourways.get(row.colourwayId) ?? null) : null }))
        .sort((a, b) => (a.style.code < b.style.code ? -1 : a.style.code > b.style.code ? 1 : (a.colourway?.code ?? '') < (b.colourway?.code ?? '') ? -1 : 1)),
    }
  })
}

// ---- writes -------------------------------------------------------------------------------------------------------------

export interface NextVersionBody {
  /** The version whose prices it starts with; default the newest. */
  readonly fromVersionId?: string | null | undefined
  readonly validFrom?: BusinessDate | null | undefined
  readonly validTo?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/** POST /sales/price-lists/:listId/versions ("Make next version"): a DRAFT with the prices copied; one draft at a time. */
export async function nextVersion(caller: CommandCaller, listId: string, body: NextVersionBody, idempotencyKey?: string) {
  await assertListWritable(caller, listId)
  const issues = validityProblems(body.validFrom ?? null, body.validTo ?? null)
  if (issues.length > 0) throw invalid(issues)
  const { result } = await command(caller, { name: 'priceLists.nextVersion', idempotencyKey, input: { listId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const list = await lockList(tx, listId)
    activeList(list)
    const versions = await versionsOf(tx, [listId])
    const draft = versions.find((row) => row.status === 'DRAFT')
    if (draft) throw new ConflictError(`Version ${draft.revision} is a draft already: edit its prices, or delete it first.`)
    const from = body.fromVersionId ? versions.find((row) => row.id === body.fromVersionId) : versions.at(-1)
    if (body.fromVersionId && !from) throw new ValidationError('Not a version of this list.', [{ path: 'body/fromVersionId', message: 'Not a version of this list.' }])
    const id = newId()
    const revision = Math.max(0, ...versions.map((row) => row.revision)) + 1
    const stamp = { createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }
    const note = body.note?.trim() ? body.note.trim().slice(0, PRICE_LIST_LIMITS.note) : null
    await tx.priceListVersion.create({ data: { id, listId, revision, validFrom: body.validFrom ? dayValue(body.validFrom) : null, validTo: body.validTo ? dayValue(body.validTo) : null, note, ...stamp }, select: { id: true } })
    const copied = from ? await tx.priceListEntry.findMany({ where: { versionId: from.id }, select: ENTRY_COLUMNS }) : []
    if (copied.length > 0) await tx.priceListEntry.createMany({ data: copied.map((entry) => ({ id: newId(), versionId: id, styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: entry.unitPrice, ...stamp })) })
    tools.audit({ action: 'priceLists.nextVersion', recordType: 'PriceList', recordId: listId, companyId: list.companyId, after: { versionId: id, revision, fromVersionId: from?.id ?? null, rows: copied.length, validFrom: body.validFrom ?? null, validTo: body.validTo ?? null, note } })
    tools.emit({ type: 'price_list.version_changed', subject: listId, companyId: list.companyId, payload: { listId, versionId: id, revision, change: 'CREATED' } })
    return versionAnswer(tools, list, id)
  })
  return result
}

export interface EditVersionBody {
  readonly version: number
  readonly validFrom?: BusinessDate | null | undefined
  readonly validTo?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/**
 * PATCH /sales/price-lists/:listId/versions/:versionId: a draft's planned days and note; an active version's end and note
 * (ending it: from yesterday on, never before its start, never into the next version).
 */
export async function editVersion(caller: CommandCaller, listId: string, versionId: string, body: EditVersionBody, idempotencyKey?: string) {
  await assertListWritable(caller, listId)
  if (body.validFrom === undefined && body.validTo === undefined && body.note === undefined) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
  const { result } = await command(caller, { name: 'priceLists.editVersion', idempotencyKey, input: { listId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const list = await lockList(tx, listId)
    activeList(list)
    const row = await claimVersion(tx, listId, versionId, body.version, now)
    const today = businessDate(now)
    const note = body.note === undefined ? row.note : body.note?.trim() ? body.note.trim().slice(0, PRICE_LIST_LIMITS.note) : null
    let validFrom = dayText(row.validFrom)
    let validTo = dayText(row.validTo)
    if (row.status === 'ACTIVE') {
      if (body.validFrom !== undefined && body.validFrom !== validFrom) throw new InvalidStateError(`Version ${row.revision} is active from ${validFrom}: its start is fixed; end it, or make the next version.`)
      if (body.validTo !== undefined) {
        const versions = (await versionsOf(tx, [listId])).map(versionFactsOf)
        const issues = endProblems(versionFactsOf(row), body.validTo, today, versions)
        if (issues.length > 0) throw invalid(issues)
        validTo = body.validTo
      }
    } else {
      if (body.validFrom !== undefined) validFrom = body.validFrom
      if (body.validTo !== undefined) validTo = body.validTo
      const issues = validityProblems(validFrom, validTo)
      if (issues.length > 0) throw invalid(issues)
    }
    await tx.priceListVersion.update({ where: { id: versionId }, data: { validFrom: validFrom === null ? null : dayValue(validFrom), validTo: validTo === null ? null : dayValue(validTo), note }, select: { id: true } })
    tools.audit({ action: 'priceLists.editVersion', recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { versionId, revision: row.revision, validFrom: dayText(row.validFrom), validTo: dayText(row.validTo), note: row.note }, after: { versionId, revision: row.revision, validFrom, validTo, note } })
    const ended = row.status === 'ACTIVE' && body.validTo !== undefined && validTo !== dayText(row.validTo)
    tools.emit({ type: 'price_list.version_changed', subject: listId, companyId: list.companyId, payload: { listId, versionId, revision: row.revision, change: ended ? 'ENDED' : 'UPDATED' } })
    return versionAnswer(tools, list, versionId)
  })
  return result
}

/** DELETE /sales/price-lists/:listId/versions/:versionId?version=: a draft and its prices. */
export async function deleteVersion(caller: CommandCaller, listId: string, versionId: string, query: { version: number }, idempotencyKey?: string) {
  await assertListWritable(caller, listId)
  const { result } = await command(caller, { name: 'priceLists.deleteVersion', idempotencyKey, input: { listId, versionId, ...query } }, async (tools) => {
    const { tx, now } = tools
    const list = await lockList(tx, listId)
    activeList(list)
    const row = await claimVersion(tx, listId, versionId, query.version, now)
    if (row.status !== 'DRAFT') throw new InvalidStateError(`Version ${row.revision} is active: it is kept for good (end it instead).`)
    const versions = await versionsOf(tx, [listId])
    if (versions.length === 1) throw new ConflictError(`Version ${row.revision} is the list's only version: archive the list instead.`)
    const quotes = await tx.quoteVersion.count({ where: { priceListVersionId: versionId } })
    if (quotes > 0) throw new ConflictError(`${quotes} quote ${quotes === 1 ? 'version keeps' : 'versions keep'} version ${row.revision}: it cannot be deleted.`)
    const { count } = await tx.priceListEntry.deleteMany({ where: { versionId } })
    await tx.priceListVersion.delete({ where: { id: versionId }, select: { id: true } })
    tools.audit({ action: 'priceLists.deleteVersion', recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { versionId, revision: row.revision, rows: count, validFrom: dayText(row.validFrom), validTo: dayText(row.validTo) } })
    tools.emit({ type: 'price_list.version_changed', subject: listId, companyId: list.companyId, payload: { listId, versionId, revision: row.revision, change: 'DELETED' } })
    return { deleted: { id: versionId, revision: row.revision } }
  })
  return result
}

export interface SetPricesBody {
  readonly version: number
  /** unitPrice is required in each row (a price, or null to remove it): a row without one is refused, never a removal. */
  readonly entries: readonly { readonly styleId: string; readonly colourwayId: string | null; readonly unitPrice?: string | null | undefined }[]
}

/**
 * PUT /sales/price-lists/:listId/versions/:versionId/entries: a draft's prices, set (a new or another price) or removed
 * (unitPrice null), one row per style and colourway; only styles of the list's company (or every company) in their
 * active colourways. Autosave per cell sends one row; "Raise by %" and "fill down" send many (factory-domain
 * sales/pricelists raiseByPct is the arithmetic the screen shows before it sends).
 */
export async function setPrices(caller: CommandCaller, listId: string, versionId: string, body: SetPricesBody, idempotencyKey?: string) {
  await assertListWritable(caller, listId)
  const missing = body.entries.flatMap((entry, index) => (entry.unitPrice === undefined ? [{ path: `entries/${index}/unitPrice`, message: 'Send the price (null removes the row).' }] : []))
  if (missing.length > 0) throw invalid(missing, 'The prices are not valid.')
  const entries: EntryInput[] = body.entries.map((entry) => ({ styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: entry.unitPrice ?? null }))
  const problems = entryProblems(entries)
  if (problems.length > 0) throw invalid(problems, 'The prices are not valid.')
  const { result } = await command(caller, { name: 'priceLists.setPrices', idempotencyKey, input: { listId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const list = await lockList(tx, listId)
    activeList(list)
    const row = await claimVersion(tx, listId, versionId, body.version, now)
    if (row.status !== 'DRAFT') throw new InvalidStateError(`Version ${row.revision} is active: its prices are fixed. Make the next version to change them.`)
    await checkTargets(tx, list, entries)
    const existing = await tx.priceListEntry.findMany({ where: { versionId }, select: ENTRY_COLUMNS })
    const byKey = new Map(existing.map((entry) => [entryKey(entry.styleId, entry.colourwayId), entry]))
    const before: { styleId: string; colourwayId: string | null; unitPrice: string | null }[] = []
    const after: { styleId: string; colourwayId: string | null; unitPrice: string | null }[] = []
    const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
    for (const entry of entries) {
      const current = byKey.get(entryKey(entry.styleId, entry.colourwayId))
      const price = entry.unitPrice === null ? null : listPriceText(entry.unitPrice)
      const was = current ? priceOf(current.unitPrice) : null
      if (was === price) continue
      before.push({ styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: was })
      after.push({ styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: price })
      if (price === null) await tx.priceListEntry.delete({ where: { id: current!.id }, select: { id: true } })
      else if (current) await tx.priceListEntry.update({ where: { id: current.id }, data: { unitPrice: price, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      else await tx.priceListEntry.create({ data: { id: newId(), versionId, styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: price, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
    }
    const count = await tx.priceListEntry.count({ where: { versionId } })
    if (count > PRICE_LIST_LIMITS.entries) throw new ConflictError(`A version holds at most ${PRICE_LIST_LIMITS.entries} prices.`)
    tools.audit({ action: 'priceLists.setPrices', recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { versionId, revision: row.revision, entries: markMoney('price', before) }, after: { versionId, revision: row.revision, entries: markMoney('price', after) } })
    if (after.length > 0) tools.emit({ type: 'price_list.version_changed', subject: listId, companyId: list.companyId, payload: { listId, versionId, revision: row.revision, change: 'PRICES' } })
    return versionAnswer(tools, list, versionId)
  })
  return result
}

/** The styles and colourways a list's prices name: the list's company's (or every company's), not archived, active colourways. */
async function checkTargets(tx: CommandTx, list: ListRow, entries: readonly EntryInput[]): Promise<void> {
  const styles = new Map((await tx.style.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.styleId))].filter(isUuid) } }, select: { id: true, code: true, companyId: true, status: true } })).map((row) => [row.id, row]))
  const colourwayIds = [...new Set(entries.flatMap((entry) => (entry.colourwayId ? [entry.colourwayId] : [])))].filter(isUuid)
  const colourways = new Map((await tx.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, styleId: true, status: true } })).map((row) => [row.id, row]))
  const issues: Issue[] = []
  for (const [index, entry] of entries.entries()) {
    const style = styles.get(entry.styleId)
    const at = `body/entries/${index}`
    if (!style || (style.companyId !== null && list.companyId !== null && style.companyId !== list.companyId) || (list.companyId === null && style.companyId !== null)) {
      issues.push({ path: `${at}/styleId`, message: list.companyId === null ? 'A list of every company prices styles of every company.' : "Not a style of the list's company." })
      continue
    }
    if (entry.unitPrice !== null && style.status === 'ARCHIVED') issues.push({ path: `${at}/styleId`, message: `${style.code} is archived: it is not priced.` })
    if (entry.colourwayId !== null) {
      const colourway = colourways.get(entry.colourwayId)
      if (!colourway || colourway.styleId !== style.id) issues.push({ path: `${at}/colourwayId`, message: `Not a colourway of ${style.code}.` })
      else if (entry.unitPrice !== null && colourway.status !== 'ACTIVE') issues.push({ path: `${at}/colourwayId`, message: `Not an active colourway of ${style.code}.` })
    }
  }
  if (issues.length > 0) throw invalid(issues, 'Some prices cannot be saved.')
}

export interface ActivateBody {
  readonly version: number
  readonly validFrom?: BusinessDate | undefined
  readonly validTo?: BusinessDate | null | undefined
}

/**
 * POST /sales/price-lists/:listId/versions/:versionId/activate ("Activate version"): in ONE command, the version in force
 * at its start ends the day before, then the draft goes ACTIVE from its start (the body's, else its planned one, else
 * today) to its end (the body's, else its planned one, or open). Its prices are fixed from here on; an open quote keeps
 * the version it was priced with.
 */
export async function activateVersion(caller: CommandCaller, listId: string, versionId: string, body: ActivateBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  await assertListWritable(caller, listId)
  const { result } = await command(caller, { name: 'priceLists.activate', idempotencyKey, input: { listId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    const list = await lockList(tx, listId)
    activeList(list)
    const row = await claimVersion(tx, listId, versionId, body.version, now)
    if (row.status !== 'DRAFT') throw new InvalidStateError(`Version ${row.revision} is active already.`)
    const prices = await tx.priceListEntry.count({ where: { versionId } })
    if (prices === 0) throw new ConflictError(`Version ${row.revision} has no prices yet: add styles before activating it.`)
    const validFrom = body.validFrom ?? dayText(row.validFrom) ?? today
    const validTo = body.validTo === undefined ? dayText(row.validTo) : body.validTo
    const versions = (await versionsOf(tx, [listId])).map(versionFactsOf)
    const planned = activationPlan(versions, versionId, validFrom, validTo, today)
    if (!planned.ok) throw invalid(planned.issues, 'The version cannot be activated.')
    const ended = planned.plan.end
    if (ended) await tx.priceListVersion.update({ where: { id: ended.id }, data: { validTo: dayValue(ended.validTo), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    await tx.priceListVersion.update({ where: { id: versionId }, data: { status: 'ACTIVE', validFrom: dayValue(validFrom), validTo: validTo === null ? null : dayValue(validTo), activatedAt: now, activatedById: context.actorId }, select: { id: true } })
    tools.audit({
      action: 'priceLists.activate',
      recordType: 'PriceList',
      recordId: listId,
      companyId: list.companyId,
      before: { versionId, revision: row.revision, status: 'DRAFT', ...(ended ? { endedVersionId: ended.id, endedValidTo: versions.find((version) => version.id === ended.id)?.validTo ?? null } : {}) },
      after: { versionId, revision: row.revision, status: 'ACTIVE', validFrom, validTo, rows: prices, ...(ended ? { endedVersionId: ended.id, endedValidTo: ended.validTo } : {}) },
    })
    tools.emit({ type: 'price_list.version_activated', subject: listId, companyId: list.companyId, payload: { listId, versionId, revision: row.revision, validFrom, validTo, endedVersionId: ended?.id ?? null } })
    return { ...(await versionAnswer(tools, list, versionId)), ended: ended ? { id: ended.id, revision: ended.revision, validTo: ended.validTo } : null }
  })
  return result
}

