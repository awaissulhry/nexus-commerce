import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CreateSwatchBody, DecisionBody, SwatchListQuery, SwatchView, UpdateSwatchBody } from '@nexus/factory-domain/sales/sample-decisions/contracts'
import { SALES_SAMPLES_DECIDE } from '@nexus/factory-domain/sales/sample-decisions/permissions'
import {
  decisionProblems,
  leatherOnlyRefusal,
  swatchDecisionRefusal,
  swatchRoundRefusal,
  swatchSentOnceRefusal,
  swatchSentRefusal,
  type SwatchKind,
} from '@nexus/factory-domain/sales/sample-decisions/rules'
import { SALES_SAMPLES_MANAGE, SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import type { SampleDecision, SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { databaseRefusal, officeOf, readRoundRow, type Reader } from '../samples/store'
import { mayOn, officeSwatch, readSwatchRow, refuse, requireOn, SWATCH_COLUMNS, swatchCompanyOf, swatchFacts, swatchViewsOf, waitingRequest, type SwatchData } from './store'

/**
 * Leather and colour swatches (B-W2b-252; SAL-314 "leather swatch and colour approval"; design products.samples › the round's
 * Approval tab, "Leather swatch and colour approvals": Swatch, Sent, Decision): a swatch of a material (its colour and/or one
 * of its lots) sent to a brand, for a style or one of its rounds, decided once — in the office, or by the brand answering its
 * approval request (COLOUR or LEATHER: ./approvals.ts).
 *
 *   GET    /sales/samples/swatches                    sales.samples.view: by style, round or brand (one of them), kind, state
 *   POST   /sales/samples/swatches                    sales.samples.manage: recorded (sent already, or later)
 *   PATCH  /sales/samples/swatches/:swatchId          its colour and lot until sent, its note at any time, sent once
 *   DELETE /sales/samples/swatches/:swatchId          only before it is sent
 *   POST   /sales/samples/swatches/:swatchId/decision sales.samples.decide: the office records the brand's word, once sent
 */

const LIST_LIMIT = 100

/** The brand a swatch goes to: a CUSTOMER or BRAND party of the company (or tenant-wide), not archived. */
async function assertBrand(db: Reader, partyId: string, companyId: string | null): Promise<void> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { companyId: true, roles: true, status: true } })
  const bad = (message: string): never => {
    throw new ValidationError(message, [{ path: 'body/partyId', message }])
  }
  if (!party || (party.companyId !== null && companyId !== null && party.companyId !== companyId)) bad('No such brand or customer for this company.')
  if (!party!.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')) bad('This party is not a customer or a brand.')
  if (party!.status === 'ARCHIVED') bad('This customer is archived.')
}

/** What was sent: a colour of the material and/or one of its lots (the lot with its site). */
async function materialOf(db: Reader, itemId: string, colourId: string | null, lotId: string | null): Promise<{ lotSiteId: string | null }> {
  const issues = []
  if (colourId) {
    const colour = await db.itemColour.findUnique({ where: { id: colourId }, select: { itemId: true } })
    if (!colour || colour.itemId !== itemId) issues.push({ path: 'body/itemColourId', message: 'Not a colour of this material.' })
  }
  let lotSiteId: string | null = null
  if (lotId) {
    const lot = await db.lot.findUnique({ where: { id: lotId }, select: { itemId: true, siteId: true } })
    if (!lot || lot.itemId !== itemId) issues.push({ path: 'body/lotId', message: 'Not a lot of this material.' })
    else lotSiteId = lot.siteId
  }
  if (!colourId && !lotId) issues.push({ path: 'body/itemColourId', message: 'Name the colour and/or the lot that is sent.' })
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  return { lotSiteId }
}

/** A time a person types for "sent": not in the future. */
function sentTime(value: string): Date {
  const when = parseInstant(value)!
  if (when.getTime() > serverClock.now().getTime() + 60_000) throw new ValidationError('Sent is not in the future.', [{ path: 'body/sentAt', message: 'Sent is not in the future.' }])
  return when
}

const swatchOne = async (caller: CommandCaller, swatchId: string): Promise<SwatchView> => {
  const context = officeOf(caller)
  const [view] = await caller.withClient(async (db) => swatchViewsOf(db, context, [(await readSwatchRow(db, swatchId))!]))
  return view!
}

function emitSwatch(tools: CommandTools, row: Pick<SwatchData, 'id' | 'styleId' | 'roundId' | 'partyId' | 'kind'>, companyId: string | null, change: 'ADDED' | 'UPDATED' | 'SENT' | 'REMOVED' | 'DECIDED', decision: SampleDecision | null = null) {
  tools.emit({
    type: 'sample_swatch.changed',
    subject: row.id,
    companyId,
    payload: { sampleSwatchId: row.id, styleId: row.styleId, roundId: row.roundId, partyId: row.partyId, kind: row.kind as SwatchKind, change, decision, via: decision ? 'OFFICE' : null },
  })
}

/** GET /sales/samples/swatches: newest first. */
export async function listSwatches(caller: CommandCaller, query: SwatchListQuery) {
  const context = officeOf(caller)
  if (!query.styleId && !query.roundId && !query.partyId) throw new ValidationError('Say the style, the round or the brand.', [{ path: 'query/styleId', message: 'Say the style, the round or the brand.' }])
  const limit = query.limit ?? LIST_LIMIT
  return caller.withClient(async (db) => {
    const where: Prisma.SampleSwatchWhereInput = {
      AND: [
        scopeWhere(actorOf(context), SALES_SAMPLES_VIEW, { party: 'partyId' }) as Prisma.SampleSwatchWhereInput,
        query.styleId ? { styleId: query.styleId } : {},
        query.roundId ? { roundId: query.roundId } : {},
        query.partyId ? { partyId: query.partyId } : {},
        query.kind ? { kind: query.kind } : {},
        query.state === 'OPEN' ? { decision: null } : query.state === 'DECIDED' ? { decision: { not: null } } : {},
      ],
    }
    const rows = await db.sampleSwatch.findMany({ where, select: SWATCH_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    // The company of each (its round's or its style's) is checked here: the swatch has no company column.
    const seen: SwatchData[] = []
    for (const row of rows.slice(0, limit)) if (mayOn(context, SALES_SAMPLES_VIEW, { companyId: await swatchCompanyOf(db, row), partyId: row.partyId })) seen.push(row)
    return { rows: await swatchViewsOf(db, context, seen), complete: rows.length <= limit }
  })
}

/** POST /sales/samples/swatches */
export async function createSwatch(caller: CommandCaller, body: CreateSwatchBody, idempotencyKey?: string): Promise<SwatchView> {
  const context = officeOf(caller)
  const checked = await caller.withClient(async (db) => {
    const style = await db.style.findUnique({ where: { id: body.styleId }, select: { id: true, code: true, companyId: true, brandPartyId: true } })
    if (!style || (style.companyId !== null && !mayOn(context, SALES_SAMPLES_VIEW, { companyId: style.companyId, partyId: null }))) throw new NotFoundError('Style not found.')
    const round = body.roundId ? await readRoundRow(db, body.roundId) : null
    if (body.roundId && (!round || round.styleId !== style.id || !mayOn(context, SALES_SAMPLES_VIEW, { companyId: round.companyId, partyId: round.partyId }))) {
      throw new ValidationError('No such sample round of this style.', [{ path: 'body/roundId', message: 'No such sample round of this style.' }])
    }
    const partyId = body.partyId ?? round?.partyId ?? style.brandPartyId
    if (!partyId) throw new ValidationError('Say which brand the swatch goes to.', [{ path: 'body/partyId', message: 'Say which brand the swatch goes to.' }])
    if (round) refuse(swatchRoundRefusal({ number: round.number, stage: round.stage as SampleStage, partyId: round.partyId }, partyId))
    const companyId = round?.companyId ?? style.companyId
    await assertBrand(db, partyId, companyId)
    const item = await db.item.findUnique({ where: { id: body.itemId }, select: { id: true, code: true, kind: true } })
    if (!item) throw new ValidationError('No such material.', [{ path: 'body/itemId', message: 'No such material.' }])
    if (body.kind === 'LEATHER' && item.kind !== 'LEATHER') refuse(leatherOnlyRefusal(item.code, item.kind))
    const { lotSiteId } = await materialOf(db, item.id, body.itemColourId ?? null, body.lotId ?? null)
    return { partyId, companyId, lotSiteId }
  })
  requireOn(context, SALES_SAMPLES_MANAGE, { companyId: checked.companyId, partyId: checked.partyId }, 'Your role does not keep swatches for this company or customer')
  const sentAt = body.sentAt ? sentTime(body.sentAt) : null
  const id = newId()
  await command(caller, { name: 'sales.samples.swatch', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const data = {
      id,
      styleId: body.styleId,
      roundId: body.roundId ?? null,
      partyId: checked.partyId,
      kind: body.kind,
      itemId: body.itemId,
      itemColourId: body.itemColourId ?? null,
      lotSiteId: checked.lotSiteId,
      lotId: body.lotId ?? null,
      note: body.note ?? null,
      sentAt,
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
    }
    await tx.sampleSwatch.create({ data, select: { id: true } })
    tools.audit({ action: 'sales.samples.swatch', recordType: 'SampleSwatch', recordId: id, companyId: checked.companyId, after: { ...data, sentAt: sentAt ? toUtcIso(sentAt) : null, createdAt: toUtcIso(now), updatedAt: undefined } })
    emitSwatch(tools, data, checked.companyId, 'ADDED')
    return null
  }).catch(databaseRefusal)
  return swatchOne(caller, id)
}

/** PATCH /sales/samples/swatches/:swatchId */
export async function updateSwatch(caller: CommandCaller, swatchId: string, body: UpdateSwatchBody, idempotencyKey?: string): Promise<SwatchView> {
  const { context, swatch, scope } = await officeSwatch(caller, swatchId)
  requireOn(context, SALES_SAMPLES_MANAGE, scope, 'Your role does not keep swatches for this company or customer')
  const facts = swatchFacts(swatch)
  const material = body.itemColourId !== undefined || body.lotId !== undefined
  if (!material && body.note === undefined && body.sentAt === undefined) throw new ValidationError('Say what changes.', [{ path: 'body/version', message: 'Say what changes.' }])
  if (material) refuse(swatchSentRefusal(facts, 'change'))
  const sentAt = body.sentAt !== undefined ? sentTime(body.sentAt) : undefined
  if (sentAt) refuse(swatchSentOnceRefusal(facts, sentAt))
  const colourId = body.itemColourId !== undefined ? body.itemColourId : swatch.itemColourId
  const lotId = body.lotId !== undefined ? body.lotId : swatch.lotId
  const { lotSiteId } = material ? await caller.withClient((db) => materialOf(db, swatch.itemId, colourId, lotId)) : { lotSiteId: swatch.lotSiteId }
  await command(caller, { name: 'sales.samples.swatch', idempotencyKey, input: { swatchId, ...body }, record: { type: 'SampleSwatch', id: swatchId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = (await readSwatchRow(tx, swatchId))!
    if (material) refuse(swatchSentRefusal(swatchFacts(current), 'change'))
    if (sentAt) refuse(swatchSentOnceRefusal(swatchFacts(current), sentAt))
    const sending = sentAt !== undefined && current.sentAt === null
    const data = {
      ...(material ? { itemColourId: colourId, lotId, lotSiteId } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(sending ? { sentAt } : {}),
    }
    await tx.sampleSwatch.update({ where: { id: swatchId }, data: { ...data, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: 'sales.samples.swatch',
      recordType: 'SampleSwatch',
      recordId: swatchId,
      companyId: scope.companyId,
      before: { itemColourId: current.itemColourId, lotId: current.lotId, note: current.note, sentAt: current.sentAt ? toUtcIso(current.sentAt) : null },
      after: { ...data, ...(sending ? { sentAt: toUtcIso(sentAt!) } : {}) },
    })
    emitSwatch(tools, current, scope.companyId, sending ? 'SENT' : 'UPDATED')
    return null
  }).catch(databaseRefusal)
  return swatchOne(caller, swatchId)
}

/** DELETE /sales/samples/swatches/:swatchId?version=: only a swatch not sent yet. */
export async function removeSwatch(caller: CommandCaller, swatchId: string, version: number, idempotencyKey?: string): Promise<{ id: string; removed: true }> {
  const { context, swatch, scope } = await officeSwatch(caller, swatchId)
  requireOn(context, SALES_SAMPLES_MANAGE, scope, 'Your role does not keep swatches for this company or customer')
  refuse(swatchSentRefusal(swatchFacts(swatch), 'remove'))
  await command(caller, { name: 'sales.samples.swatchRemove', idempotencyKey, input: { swatchId, version }, record: { type: 'SampleSwatch', id: swatchId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const current = (await readSwatchRow(tx, swatchId))!
    refuse(swatchSentRefusal(swatchFacts(current), 'remove'))
    await tx.sampleSwatch.delete({ where: { id: swatchId }, select: { id: true } })
    tools.audit({ action: 'sales.samples.swatchRemove', recordType: 'SampleSwatch', recordId: swatchId, companyId: scope.companyId, before: { styleId: current.styleId, roundId: current.roundId, partyId: current.partyId, kind: current.kind, itemId: current.itemId, itemColourId: current.itemColourId, lotId: current.lotId } })
    emitSwatch(tools, current, scope.companyId, 'REMOVED')
    return null
  }).catch(databaseRefusal)
  return { id: swatchId, removed: true }
}

/** POST /sales/samples/swatches/:swatchId/decision: the office records the brand's word, once the swatch is sent. */
export async function decideSwatch(caller: CommandCaller, swatchId: string, body: DecisionBody, idempotencyKey?: string): Promise<SwatchView> {
  const { context, swatch, scope } = await officeSwatch(caller, swatchId)
  requireOn(context, SALES_SAMPLES_DECIDE, scope, 'Your role does not record swatch decisions for this company or customer')
  const problems = decisionProblems(body.decision, body.comments)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  refuse(swatchDecisionRefusal(swatchFacts(swatch), await caller.withClient((db) => waitingRequest(db, 'SampleSwatch', swatchId))))
  await command(caller, { name: 'sales.samples.swatchDecide', idempotencyKey, input: { swatchId, ...body }, record: { type: 'SampleSwatch', id: swatchId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = (await readSwatchRow(tx, swatchId))!
    refuse(swatchDecisionRefusal(swatchFacts(current), await waitingRequest(tx, 'SampleSwatch', swatchId)))
    const comments = body.comments ?? null
    await tx.sampleSwatch.update({ where: { id: swatchId }, data: { decision: body.decision, decisionComments: comments, decidedAt: now, decidedVia: 'OFFICE', decidedById: context.actorId, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'sales.samples.swatchDecide', recordType: 'SampleSwatch', recordId: swatchId, companyId: scope.companyId, before: { decision: null }, after: { decision: body.decision, decisionComments: comments, decidedAt: toUtcIso(now), decidedVia: 'OFFICE', decidedById: context.actorId } })
    emitSwatch(tools, current, scope.companyId, 'DECIDED', body.decision)
    return null
  }).catch(databaseRefusal)
  return swatchOne(caller, swatchId)
}
