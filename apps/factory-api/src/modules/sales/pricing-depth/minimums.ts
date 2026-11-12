import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { ProductType } from '@nexus/factory-domain/product/styles/rules'
import { listPriceText } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_MANAGE, PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { minimumProblems, type MinimumAction, type MinimumChange, type MinimumPer } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { StaleVersionError, command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertMayChangeList, mayOnList } from '../pricelists/store'
import { officeContextOf } from '../quotes/store'
import { invalid, MINIMUM_COLUMNS, minimumViewsOf, type MinimumRecord } from './store'

/**
 * Minimum order quantities (B-W2b-325; SAL-178; design record "Price list" › Breaks & surcharges, "MOQ action (warn /
 * block / small-run surcharge)"): a minimum of one style, one kind of garment or one material, counted per document,
 * colourway or line; for one company or every company, for one price list's customers or every customer. The quotes and
 * orders read them through sales/line-checks. pricelists.view to read, pricelists.manage over the rule's company to
 * change (a rule of every company: a grant over every company).
 *
 *   one per subject   one ACTIVE rule per company, price list, subject and count (per): a second is refused in words
 *                     (several rules of one subject, counted differently, stand side by side: 5 per colourway, 20 per order)
 *   subject fixed     the company and what the rule is about never change (another subject is another rule)
 *   archive           switches a rule off (kept); reactivate switches it on again; delete removes it
 */

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export interface MinimumsQuery {
  readonly companyId?: string | undefined
  readonly priceListId?: string | undefined
  readonly styleId?: string | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined
}

/** GET /sales/minimums: the rules the caller may see (pricelists.view over their company). */
export async function listMinimums(caller: CommandCaller, query: MinimumsQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.MoqRuleWhereInput = {
    ...(query.status === 'ALL' ? {} : { status: query.status ?? 'ACTIVE' }),
    ...(query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {}),
    ...(query.priceListId ? { priceListId: query.priceListId } : {}),
    ...(query.styleId ? { styleId: query.styleId } : {}),
  }
  return caller.withClient(async (client) => {
    const rows = (await client.moqRule.findMany({ where, select: MINIMUM_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1000 })).filter((row) => mayOnList(context, PRICE_LISTS_VIEW, row.companyId))
    return { minimums: await minimumViewsOf(client, rows) }
  })
}

async function readMinimumFor(caller: CommandCaller, ruleId: string): Promise<MinimumRecord> {
  const row = isUuid(ruleId) ? await caller.withClient((client) => client.moqRule.findUnique({ where: { id: ruleId }, select: MINIMUM_COLUMNS })) : null
  if (!row || !mayOnList(officeContextOf(caller), PRICE_LISTS_VIEW, row.companyId)) throw new NotFoundError('Minimum order quantity not found.')
  return row
}

/** GET /sales/minimums/:ruleId */
export async function getMinimum(caller: CommandCaller, ruleId: string) {
  const row = await readMinimumFor(caller, ruleId)
  return caller.withClient(async (client) => ({ minimum: (await minimumViewsOf(client, [row]))[0]! }))
}

export interface MinimumBody {
  readonly companyId?: string | null | undefined
  readonly priceListId?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly productType?: ProductType | null | undefined
  readonly itemId?: string | null | undefined
  readonly minQuantity: number
  readonly per: MinimumPer
  readonly action: MinimumAction
  readonly surchargeAmount?: string | null | undefined
  readonly currency?: string | null | undefined
  readonly surchargePct?: string | null | undefined
  readonly note?: string | null | undefined
}

const subjectKey = (row: Pick<MinimumRecord, 'companyId' | 'priceListId' | 'styleId' | 'productType' | 'itemId' | 'per'>): string => [row.companyId ?? '*', row.priceListId ?? '*', row.styleId ?? '', row.productType ?? '', row.itemId ?? '', row.per].join('|')

/** One writer per subject (the uniqueness of an ACTIVE rule is the module's: no unique key in the table). */
const lockSubject = async (tx: CommandTx, key: string): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.minimum-order', current_setting('factory.tenant_id', true), ${key}::text), 0))`
}

async function assertNoTwin(tx: CommandTx, row: Pick<MinimumRecord, 'companyId' | 'priceListId' | 'styleId' | 'productType' | 'itemId' | 'per'>, except: string | null): Promise<void> {
  await lockSubject(tx, subjectKey(row))
  const twin = await tx.moqRule.findFirst({ where: { status: 'ACTIVE', companyId: row.companyId, priceListId: row.priceListId, styleId: row.styleId, productType: row.productType, itemId: row.itemId, per: row.per, ...(except ? { id: { not: except } } : {}) }, select: { id: true, minQuantity: true } })
  if (twin) throw new ConflictError(`An active minimum of ${twin.minQuantity} already counts this subject the same way for the same customers: change that one, or archive it first.`)
}

/** What the rule names, checked against the database: the style or material (its company's or every company's), the list. */
async function subjectIssues(tx: CommandTx, companyId: string | null, body: Pick<MinimumBody, 'styleId' | 'itemId' | 'priceListId' | 'surchargeAmount' | 'currency'>, checkSubject: boolean): Promise<Issue[]> {
  const issues: Issue[] = []
  const ofCompany = (owner: string | null) => owner === null || owner === companyId
  if (checkSubject && body.styleId) {
    const style = isUuid(body.styleId) ? await tx.style.findUnique({ where: { id: body.styleId }, select: { companyId: true } }) : null
    if (!style || !ofCompany(style.companyId)) issues.push({ path: 'styleId', message: companyId === null ? 'A minimum of every company is about a style of every company.' : "Not a style of the rule's company." })
  }
  if (checkSubject && body.itemId) {
    const item = isUuid(body.itemId) ? await tx.item.findUnique({ where: { id: body.itemId }, select: { companyId: true, kind: true } }) : null
    if (!item || !ofCompany(item.companyId) || (item.kind as string) === 'FINISHED') issues.push({ path: 'itemId', message: companyId === null ? 'A minimum of every company is about a material of every company.' : "Not a material of the rule's company." })
  }
  if (body.priceListId) {
    const list = isUuid(body.priceListId) ? await tx.priceList.findUnique({ where: { id: body.priceListId }, select: { companyId: true, currency: true, status: true } }) : null
    if (!list || !ofCompany(list.companyId) || (companyId === null && list.companyId !== null)) issues.push({ path: 'priceListId', message: "Not a price list of the rule's company or of every company." })
    else if (body.surchargeAmount && body.currency && body.currency !== list.currency) issues.push({ path: 'currency', message: `The surcharge is in the list's currency (${list.currency}).` })
  }
  return issues
}

const auditOf = (row: Pick<MinimumRecord, 'minQuantity' | 'per' | 'action' | 'surchargeAmount' | 'currency' | 'surchargePct' | 'note' | 'priceListId' | 'status'>) => ({
  minQuantity: row.minQuantity,
  per: row.per,
  action: row.action,
  surchargeAmount: markMoney('price', row.surchargeAmount === null ? null : listPriceText(row.surchargeAmount.toString())),
  currency: row.currency,
  surchargePct: markMoney('price', row.surchargePct === null ? null : row.surchargePct.toString()),
  note: row.note,
  priceListId: row.priceListId,
  status: row.status,
})

const answer = async (tx: CommandTx, ruleId: string) => ({ minimum: (await minimumViewsOf(tx, [await tx.moqRule.findUniqueOrThrow({ where: { id: ruleId }, select: MINIMUM_COLUMNS })]))[0]! })

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** POST /sales/minimums */
export async function createMinimum(caller: CommandCaller, body: MinimumBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const companyId = body.companyId ?? null
  assertMayChangeList(context, PRICE_LISTS_MANAGE, companyId)
  const problems = minimumProblems(body)
  if (problems.length > 0) throw invalid(problems, 'The minimum order quantity is not valid.')
  const { result } = await command(caller, { name: 'minimums.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const issues = await subjectIssues(tx, companyId, body, true)
    if (issues.length > 0) throw invalid(issues, 'The minimum order quantity names what it cannot.')
    const id = newId()
    const data = {
      companyId,
      priceListId: body.priceListId ?? null,
      styleId: body.styleId ?? null,
      productType: body.productType ?? null,
      itemId: body.itemId ?? null,
      minQuantity: body.minQuantity,
      per: body.per,
      action: body.action,
      surchargeAmount: body.action === 'SURCHARGE' && body.surchargeAmount ? listPriceText(body.surchargeAmount) : null,
      currency: body.action === 'SURCHARGE' && body.surchargeAmount ? (body.currency ?? null) : null,
      surchargePct: body.action === 'SURCHARGE' ? (body.surchargePct ?? null) : null,
      note: blank(body.note),
    }
    await assertNoTwin(tx, data, null)
    const row = await tx.moqRule.create({ data: { id, ...data, createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }, select: MINIMUM_COLUMNS })
    tools.audit({ action: 'minimums.create', recordType: 'MoqRule', recordId: id, companyId, after: { subject: { styleId: data.styleId, productType: data.productType, itemId: data.itemId }, ...auditOf(row) } })
    emitChange(tools, row, 'CREATED', [])
    return answer(tx, id)
  })
  return result
}

const emitChange = (tools: CommandTools, row: Pick<MinimumRecord, 'id' | 'companyId' | 'priceListId'>, change: MinimumChange, fields: readonly string[]) =>
  tools.emit({ type: 'minimum_order.changed', subject: row.id, companyId: row.companyId, payload: { ruleId: row.id, companyId: row.companyId, listId: row.priceListId, change, fields: [...fields] } })

/** Inside a command: the rule locked and compared at the version the caller read. */
async function claim(tx: CommandTx, ruleId: string, expected: number): Promise<MinimumRecord> {
  await tx.$queryRaw`SELECT id FROM "MoqRule" WHERE id = ${ruleId}::uuid FOR UPDATE`
  const row = await tx.moqRule.findUnique({ where: { id: ruleId }, select: MINIMUM_COLUMNS })
  if (!row) throw new NotFoundError('Minimum order quantity not found.')
  if (row.version !== expected) throw new StaleVersionError('MoqRule', ruleId, row.version, expected)
  return row
}

export type MinimumEdit = { readonly version: number } & Partial<Pick<MinimumBody, 'minQuantity' | 'per' | 'action' | 'surchargeAmount' | 'currency' | 'surchargePct' | 'note' | 'priceListId'>>

/** PATCH /sales/minimums/:ruleId: its count, action, surcharge, note or price list (its company and subject are fixed). */
export async function updateMinimum(caller: CommandCaller, ruleId: string, body: MinimumEdit, idempotencyKey?: string) {
  const seen = await readMinimumFor(caller, ruleId)
  assertMayChangeList(officeContextOf(caller), PRICE_LISTS_MANAGE, seen.companyId)
  const { result } = await command(caller, { name: 'minimums.update', idempotencyKey, input: { ruleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await claim(tx, ruleId, body.version)
    if (row.status === 'ARCHIVED') throw new InvalidStateError('The minimum is archived: reactivate it before changing it.')
    const action = body.action ?? (row.action as MinimumAction)
    const keepsSurcharge = action === 'SURCHARGE' && body.surchargeAmount === undefined && body.surchargePct === undefined
    const next = {
      minQuantity: body.minQuantity ?? row.minQuantity,
      per: body.per ?? (row.per as MinimumPer),
      action,
      surchargeAmount: action !== 'SURCHARGE' ? null : keepsSurcharge ? (row.surchargeAmount === null ? null : listPriceText(row.surchargeAmount.toString())) : body.surchargeAmount ? listPriceText(body.surchargeAmount) : null,
      surchargePct: action !== 'SURCHARGE' ? null : keepsSurcharge ? (row.surchargePct === null ? null : row.surchargePct.toString()) : (body.surchargePct ?? null),
      currency: null as string | null,
      note: body.note === undefined ? row.note : blank(body.note),
      priceListId: body.priceListId === undefined ? row.priceListId : body.priceListId,
    }
    next.currency = next.surchargeAmount === null ? null : keepsSurcharge ? row.currency : (body.currency ?? row.currency)
    const problems = minimumProblems({ ...next, styleId: row.styleId, productType: row.productType as ProductType | null, itemId: row.itemId }, false)
    const issues = [...problems, ...(await subjectIssues(tx, row.companyId, { ...next, styleId: null, itemId: null }, false))]
    if (issues.length > 0) throw invalid(issues, 'The minimum order quantity is not valid.')
    if (next.per !== row.per || next.priceListId !== row.priceListId) await assertNoTwin(tx, { ...row, per: next.per, priceListId: next.priceListId }, ruleId)
    const fields = Object.keys(body).filter((key) => key !== 'version')
    const updated = await tx.moqRule.update({ where: { id: ruleId }, data: { ...next, version: { increment: 1 }, updatedAt: now }, select: MINIMUM_COLUMNS })
    tools.audit({ action: 'minimums.update', recordType: 'MoqRule', recordId: ruleId, companyId: row.companyId, before: auditOf(row), after: auditOf(updated) })
    emitChange(tools, row, 'UPDATED', fields)
    return answer(tx, ruleId)
  })
  return result
}

/** POST /sales/minimums/:ruleId/archive | reactivate */
export async function moveMinimum(caller: CommandCaller, ruleId: string, move: 'archive' | 'reactivate', body: { readonly version: number }, idempotencyKey?: string) {
  const seen = await readMinimumFor(caller, ruleId)
  assertMayChangeList(officeContextOf(caller), PRICE_LISTS_MANAGE, seen.companyId)
  const { result } = await command(caller, { name: `minimums.${move}`, idempotencyKey, input: { ruleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await claim(tx, ruleId, body.version)
    const status = move === 'archive' ? 'ARCHIVED' : 'ACTIVE'
    if (row.status === status) throw new InvalidStateError(move === 'archive' ? 'The minimum is archived already.' : 'The minimum is active already.')
    if (status === 'ACTIVE') await assertNoTwin(tx, row, ruleId)
    await tx.moqRule.update({ where: { id: ruleId }, data: { status, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: `minimums.${move}`, recordType: 'MoqRule', recordId: ruleId, companyId: row.companyId, before: { status: row.status }, after: { status } })
    emitChange(tools, row, move === 'archive' ? 'ARCHIVED' : 'REACTIVATED', ['status'])
    return answer(tx, ruleId)
  })
  return result
}

/** DELETE /sales/minimums/:ruleId?version= */
export async function deleteMinimum(caller: CommandCaller, ruleId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const seen = await readMinimumFor(caller, ruleId)
  assertMayChangeList(officeContextOf(caller), PRICE_LISTS_MANAGE, seen.companyId)
  const { result } = await command(caller, { name: 'minimums.delete', idempotencyKey, input: { ruleId, ...query } }, async (tools) => {
    const { tx } = tools
    const row = await claim(tx, ruleId, query.version)
    await tx.moqRule.delete({ where: { id: ruleId }, select: { id: true } })
    tools.audit({ action: 'minimums.delete', recordType: 'MoqRule', recordId: ruleId, companyId: row.companyId, before: { subject: { styleId: row.styleId, productType: row.productType, itemId: row.itemId }, ...auditOf(row) } })
    emitChange(tools, row, 'DELETED', [])
    return { deleted: { id: ruleId } }
  })
  return result
}
