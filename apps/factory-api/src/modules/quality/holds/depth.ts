import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { INVENTORY_TRANSFER } from '@nexus/factory-domain/inventory/permissions'
import type { HoldChangedField } from '@nexus/factory-domain/quality/holds/changes'
import {
  extendedCounts,
  genealogyPlan,
  genealogyProblems,
  genealogyWords,
  nextStepProblem,
  placeOfCode,
  quarantineTransfers,
  type GenealogyStartType,
  type HeldBalance,
  type HoldNextStep,
} from '@nexus/factory-domain/quality/holds/depth'
import { QUALITY_HOLDS_PLACE, QUALITY_HOLDS_VIEW } from '@nexus/factory-domain/quality/holds/permissions'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { STOCK_SUBJECTS, type HoldStatus, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { reasonFor } from '../../../platform/reasons/service'
import { readSiteStock } from '../../inventory/issue/store'
import { postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import { detailOf, emitHoldChanged, lockActiveHold, officeOf, placeHoldInCommand, refuse, visibleHold } from './holds'
import { genealogyStart, groupViewOf, impactOf } from './impact'
import { HOLD_COLUMNS, readHold, type HoldRow, type Reader } from './store'
// B-W2b-289 (SCM-179): the site's default quality place when none is named.
import { defaultPlaceFor } from '../../inventory/locations-depth/defaults'

/**
 * Holds in depth, the writes (B-W2b-114; QHS-075, QHS-077, QHS-078). Each is ONE command(); the refusals come first in
 * words, the database (…_quality_plant_w2a_guards, …_quality_problems_w2b_guards) holds the same for every login.
 *
 *   POST /quality/holds/genealogy              (quality.holds.place) a hold by genealogy: the forward trace read again
 *        inside the command, the ticks planned (factory-domain depth genealogyPlan), ONE QualityHoldGroup (or the extended
 *        hold's group, counts moved under its row lock; a hold without a group takes a new one naming it), then one hold
 *        per kind of record and site through placeHoldInCommand (numbered, work orders ON_HOLD, the group named at insert;
 *        the quarantine move asked where the site has exactly one quarantine place). A pick that cannot be held any more
 *        is a 409 at `picks/<key>`; one held meanwhile is left as it is and said.
 *   POST /quality/holds/:holdId/next-step      (quality.holds.place) the hold board's lane, while ACTIVE, at the version read.
 *   POST /quality/holds/:holdId/quarantine/ask (quality.holds.place) asks the move of a stock hold to a QUARANTINE place
 *        of its site (or another place while still asked).
 *   POST /quality/holds/:holdId/quarantine/confirm (inventory.transfer at the hold's site, the hold seen with holds.view)
 *        the place's code typed or scanned: every balance of the held lots and hides at the site, outside the place and
 *        not at an outside workshop, is transferred into it (postMoves, the ledger's one writer, in the same command), and
 *        the hold is MOVED with the time and the place. Until floor.move (W2b-5) the office confirms it (plan §12).
 * Events: quality.hold_changed (nextStep, quarantine, quarantineLocationId, groupId), quality.hold_placed per hold placed,
 * inventory.moved per transfer.
 */

/** A 409 whose issues name what clashes (`body/<field>`, `picks/<key>`). */
const conflict = (message: string, issues: readonly Issue[] = []): DomainError => new DomainError('conflict', message, issues)

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const context = tools.context
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a hold command needs a tenant context')
  return context.tenantId
}

// ---- where held stock lies (QHS-078) ------------------------------------------------------------------------------------------

interface LyingBalance extends HeldBalance {
  readonly code: string
  readonly name: string
  readonly uom: string
}

/** The balances of a stock hold's lots or hides at its site, each with its place and unit. */
async function heldBalancesOf(db: Reader, hold: Pick<HoldRow, 'siteId' | 'subjectType' | 'subjectIds'>): Promise<LyingBalance[]> {
  if (!STOCK_SUBJECTS.includes(hold.subjectType as HoldSubjectType)) return []
  const ids = [...hold.subjectIds].sort()
  const records =
    hold.subjectType === 'Lot'
      ? (await db.lot.findMany({ where: { id: { in: ids } }, select: { id: true, itemId: true } })).map((row) => ({ itemId: row.itemId, filter: { lotId: row.id } }))
      : (await db.hide.findMany({ where: { id: { in: ids } }, select: { id: true, itemId: true } })).map((row) => ({ itemId: row.itemId, filter: { hideId: row.id } }))
  const balances = []
  for (const record of records) balances.push(...(await readSiteStock(db, hold.siteId, { itemIds: [record.itemId], ...record.filter })))
  const places = new Map((await db.location.findMany({ where: { id: { in: [...new Set(balances.map((balance) => balance.locationId))] } }, select: { id: true, code: true, name: true, kind: true } })).map((row) => [row.id, row]))
  const units = new Map((await db.item.findMany({ where: { id: { in: [...new Set(balances.map((balance) => balance.itemId))] } }, select: { id: true, baseUom: true } })).map((row) => [row.id, row.baseUom as string]))
  return balances
    .map((balance) => {
      const place = places.get(balance.locationId)
      return {
        locationId: balance.locationId,
        locationKind: place?.kind ?? 'WAREHOUSE',
        code: place?.code ?? '',
        name: place?.name ?? '',
        itemId: balance.itemId,
        itemColourId: balance.itemColourId,
        lotId: balance.lotId,
        hideId: balance.hideId,
        onHand: balance.onHand.toString(),
        uom: units.get(balance.itemId) ?? '',
      }
    })
    .sort((a, b) => a.code.localeCompare(b.code) || (a.hideId ?? '').localeCompare(b.hideId ?? ''))
}

/** A stock hold's stock by place and the site's quarantine places (GET /quality/holds/:holdId's `stock`); null otherwise. */
export async function heldStockOf(db: Reader, hold: Pick<HoldRow, 'siteId' | 'subjectType' | 'subjectIds' | 'status' | 'quarantineLocationId'>) {
  if (hold.status !== 'ACTIVE' || !STOCK_SUBJECTS.includes(hold.subjectType as HoldSubjectType)) return null
  const places = await db.location.findMany({ where: { siteId: hold.siteId, kind: 'QUARANTINE', status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
  const balances = await heldBalancesOf(db, hold)
  const target = hold.quarantineLocationId
  const byPlace = new Map<string, { locationId: string; code: string; name: string; kind: string; onHand: Decimal; uom: string; moves: boolean }>()
  for (const balance of balances) {
    const key = `${balance.locationId}|${balance.uom}`
    const moves = target !== null && balance.locationId !== target && quarantineTransfers([balance], target).moves.length > 0
    const known = byPlace.get(key)
    if (known) known.onHand = known.onHand.plus(balance.onHand)
    else byPlace.set(key, { locationId: balance.locationId, code: balance.code, name: balance.name, kind: balance.locationKind, onHand: new Dec(balance.onHand), uom: balance.uom, moves })
  }
  return { places, lying: [...byPlace.values()].map((entry) => ({ ...entry, onHand: entry.onHand.toDecimalPlaces(4).toString() })) }
}

// ---- the hold board (QHS-077) ----------------------------------------------------------------------------------------------

/** POST /quality/holds/:holdId/next-step */
export async function moveNextStep(caller: CommandCaller, holdId: string, body: { readonly version: number; readonly nextStep: HoldNextStep }, idempotencyKey?: string) {
  const row = await visibleHold(caller, holdId, QUALITY_HOLDS_PLACE)
  const early = nextStepProblem({ status: row.status as HoldStatus, nextStep: row.nextStep as HoldNextStep }, body.nextStep)
  if (early && row.status !== 'ACTIVE') throw new InvalidStateError(early)
  const { result } = await command(caller, { name: 'quality.moveHoldNextStep', idempotencyKey, input: { holdId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockActiveHold(tools, row.id, body.version)
    const problem = nextStepProblem({ status: current.status as HoldStatus, nextStep: current.nextStep as HoldNextStep }, body.nextStep)
    if (problem) throw conflict(problem, [{ path: 'body/nextStep', message: problem }])
    const after = await tx.qualityHold.update({ where: { id: current.id }, data: { nextStep: body.nextStep, version: { increment: 1 }, updatedAt: now }, select: HOLD_COLUMNS })
    tools.audit({ action: 'quality.moveHoldNextStep', recordType: 'QualityHold', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { nextStep: current.nextStep }, after: { nextStep: after.nextStep } })
    emitHoldChanged(tools, current, ['nextStep'])
    return { hold: await detailOf(tx, after, now) }
  })
  return result
}

// ---- the quarantine move (QHS-078) -------------------------------------------------------------------------------------------

const quarantinePlaces = (db: Reader, siteId: string) =>
  db.location.findMany({ where: { siteId, kind: 'QUARANTINE', status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })

function stockOnly(row: Pick<HoldRow, 'subjectType' | 'status'>): void {
  if (row.status !== 'ACTIVE') throw new InvalidStateError(`This hold is ${row.status.toLowerCase()}: a released or closed hold never changes.`)
  if (!STOCK_SUBJECTS.includes(row.subjectType as HoldSubjectType)) throw new InvalidStateError('Only stock (lots, hides) moves to quarantine; a work order, a bundle, garments and shipments stay where they are.')
}

/** POST /quality/holds/:holdId/quarantine/ask */
export async function askQuarantine(caller: CommandCaller, holdId: string, body: { readonly version: number; readonly locationId?: string | null | undefined }, idempotencyKey?: string) {
  const row = await visibleHold(caller, holdId, QUALITY_HOLDS_PLACE)
  stockOnly(row)
  if (row.quarantine === 'MOVED') throw new InvalidStateError('The goods lie in quarantine already: the move was confirmed.')
  const { result } = await command(caller, { name: 'quality.askHoldQuarantine', idempotencyKey, input: { holdId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockActiveHold(tools, row.id, body.version)
    if (current.quarantine === 'MOVED') throw new InvalidStateError('The goods lie in quarantine already: the move was confirmed.')
    const places = await quarantinePlaces(tx, current.siteId)
    const placeId = body.locationId ?? (await defaultPlaceFor(tx, { siteId: current.siteId, purpose: 'QUALITY' }))?.id ?? (places.length === 1 ? places[0]!.id : null)
    if (!placeId || !places.some((place) => place.id === placeId)) {
      refuse([{ path: 'body/locationId', message: places.length === 0 ? 'The site has no quarantine place: add one in the warehouse first.' : 'Pick a quarantine place of the site.' }], 'The quarantine place is not one of the site.')
    }
    const fields: HoldChangedField[] = []
    if (current.quarantine !== 'ASKED') fields.push('quarantine')
    if (current.quarantineLocationId !== placeId) fields.push('quarantineLocationId')
    if (fields.length === 0) return { hold: await detailOf(tx, current, now) }
    const after = await tx.qualityHold.update({ where: { id: current.id }, data: { quarantine: 'ASKED', quarantineLocationId: placeId, version: { increment: 1 }, updatedAt: now }, select: HOLD_COLUMNS })
    tools.audit({ action: 'quality.askHoldQuarantine', recordType: 'QualityHold', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { quarantine: current.quarantine, quarantineLocationId: current.quarantineLocationId }, after: { quarantine: 'ASKED', quarantineLocationId: placeId } })
    emitHoldChanged(tools, current, fields)
    return { hold: await detailOf(tx, after, now) }
  })
  return result
}

/** POST /quality/holds/:holdId/quarantine/confirm */
export async function confirmQuarantine(caller: CommandCaller, holdId: string, body: { readonly version: number; readonly placeCode: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const row = await visibleHold(caller, holdId, QUALITY_HOLDS_VIEW)
  if (!can(actorOf(context), INVENTORY_TRANSFER, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError("Confirming a quarantine move moves the stock: it needs inventory.transfer at the hold's site.")
  stockOnly(row)
  if (row.quarantine === 'NOT_NEEDED') throw conflict('No move to quarantine was asked for this hold: ask it first.', [{ path: 'body/placeCode', message: 'No move was asked.' }])
  if (row.quarantine === 'MOVED') throw new InvalidStateError('The move to quarantine is confirmed already.')
  const { result } = await command(caller, { name: 'quality.confirmHoldQuarantine', idempotencyKey, input: { holdId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockActiveHold(tools, row.id, body.version)
    if (current.quarantine !== 'ASKED') throw new InvalidStateError(current.quarantine === 'MOVED' ? 'The move to quarantine is confirmed already.' : 'No move to quarantine was asked for this hold: ask it first.')
    const places = await quarantinePlaces(tx, current.siteId)
    const place = placeOfCode(body.placeCode, places)
    if (!place) {
      const asked = places.find((entry) => entry.id === current.quarantineLocationId)
      refuse([{ path: 'body/placeCode', message: `${body.placeCode.trim()} is not a quarantine place of this site: scan or type the code on the quarantine place's label${asked ? ` (${asked.code})` : ''}.` }], 'The code is not a quarantine place of the site.')
    }
    const balances = await heldBalancesOf(tx, current)
    const { moves, stays } = quarantineTransfers(balances, place!.id)
    const lying = new Map(balances.map((balance) => [`${balance.locationId}|${balance.lotId}|${balance.hideId}`, balance]))
    const drafts: MoveDraft[] = moves.map((balance) => ({
      siteId: current.siteId,
      reason: 'TRANSFER',
      itemId: balance.itemId,
      itemColourId: balance.itemColourId,
      lotId: balance.lotId,
      hideId: balance.hideId,
      fromLocationId: balance.locationId,
      toLocationId: place!.id,
      quantity: balance.onHand,
      note: `Quarantine move of hold ${current.number ?? current.id}`,
    }))
    if (drafts.length > 0) await postMoves(tools, drafts, { key: idempotencyKey ? `quality.confirmHoldQuarantine:${idempotencyKey}` : null, issuePath: () => 'body/placeCode' })
    const after = await tx.qualityHold.update({ where: { id: current.id }, data: { quarantine: 'MOVED', quarantineMovedAt: now, quarantineLocationId: place!.id, version: { increment: 1 }, updatedAt: now }, select: HOLD_COLUMNS })
    tools.audit({
      action: 'quality.confirmHoldQuarantine',
      recordType: 'QualityHold',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { quarantine: current.quarantine, quarantineLocationId: current.quarantineLocationId },
      after: { quarantine: 'MOVED', quarantineLocationId: place!.id, transfers: drafts.length, staysAt: stays.map((entry) => entry.locationId) },
    })
    emitHoldChanged(tools, current, current.quarantineLocationId === place!.id ? ['quarantine'] : ['quarantine', 'quarantineLocationId'])
    return {
      hold: await detailOf(tx, after, now),
      moved: moves.map((entry) => ({ fromCode: lying.get(`${entry.locationId}|${entry.lotId}|${entry.hideId}`)?.code ?? '', onHand: entry.onHand, uom: lying.get(`${entry.locationId}|${entry.lotId}|${entry.hideId}`)?.uom ?? '' })),
      stays: stays.map((entry) => ({ atCode: lying.get(`${entry.locationId}|${entry.lotId}|${entry.hideId}`)?.code ?? '', onHand: entry.onHand, uom: lying.get(`${entry.locationId}|${entry.lotId}|${entry.hideId}`)?.uom ?? '' })),
      stock: await heldStockOf(tx, after),
    }
  })
  return result
}

// ---- hold by genealogy (QHS-075) ----------------------------------------------------------------------------------------------

export interface GenealogyBody {
  readonly type: GenealogyStartType
  readonly id: string
  readonly picks: readonly string[]
  readonly reasonCode: string
  readonly reasonNote?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly expectedReleaseOn?: string | null | undefined
  readonly askQuarantine?: boolean | undefined
  readonly note?: string | null | undefined
  readonly holdId?: string | null | undefined
}

/** The group's row, locked (an extension moves its counts). */
async function lockGroup(tools: CommandTools, groupId: string): Promise<{ id: string; companyId: string; counts: Prisma.JsonValue; version: number }> {
  const [row] = await tools.tx.$queryRaw<{ id: string; companyId: string; counts: Prisma.JsonValue; version: number }[]>`SELECT "id", "companyId", "counts", "version" FROM "QualityHoldGroup" WHERE "id" = ${groupId}::uuid FOR UPDATE`
  if (!row) throw new NotFoundError('Hold group not found.')
  return row
}

/** POST /quality/holds/genealogy */
export async function holdByGenealogy(caller: CommandCaller, body: GenealogyBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor: Actor = actorOf(context)
  const { result } = await command(caller, { name: 'quality.holdByGenealogy', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    tenantOf(tools)
    const problems: Issue[] = genealogyProblems(body, businessDate(now))
    if (problems.length > 0) refuse(problems, 'The hold by genealogy is not valid.')
    const start = await genealogyStart(tx, actor, body.type, body.id)
    if (!can(actor, QUALITY_HOLDS_PLACE, start)) throw new ForbiddenError("A hold by genealogy needs quality.holds.place at the suspect record's site.")
    // Why (the HOLD list), before anything is written.
    const reason = await reasonFor(tx, 'HOLD', body.reasonCode)
    if (!reason || !reason.active) refuse([{ path: 'body/reasonCode', message: 'Pick an active reason of the hold list.' }], 'The reason is not an active hold reason.')
    const reasonNote = body.reasonNote?.trim() || null
    if (reason!.needsDetail && !reasonNote) refuse([{ path: 'body/reasonNote', message: `${reason!.labelEn} needs a note: say what is wrong.` }], 'The reason needs a note.')

    // Extending a hold: visible, ACTIVE, of the suspect record's company; its group locked.
    let extending: HoldRow | null = null
    let group: Awaited<ReturnType<typeof lockGroup>> | null = null
    if (body.holdId) {
      extending = isUuid(body.holdId) ? await readHold(tx, body.holdId) : null
      if (!extending || !can(actor, QUALITY_HOLDS_VIEW, { companyId: extending.companyId, siteId: extending.siteId })) throw new NotFoundError('Hold not found.')
      if (extending.status !== 'ACTIVE') throw new InvalidStateError(`This hold is ${extending.status.toLowerCase()}: only an active hold is extended.`)
      if (extending.companyId !== start.companyId) throw conflict('The suspect record is of another company than the hold: a hold group is one company\'s.', [{ path: 'body/id', message: 'Another company.' }])
      if (extending.groupId) group = await lockGroup(tools, extending.groupId)
    }

    // The trace read again inside the command: what may be held NOW.
    const impact = await impactOf(tx, actor, [start])
    const plan = genealogyPlan(impact.nodes, impact.edges, body.picks)
    if (plan.refused.length > 0) {
      throw conflict(
        plan.refused.length === 1 ? plan.refused[0]!.words : `${plan.refused.length} of the ticked records cannot be held now: read the trace again.`,
        plan.refused.map((entry) => ({ path: `picks/${entry.key}`, message: entry.words })),
      )
    }
    if (plan.holds.length === 0) throw new InvalidStateError(plan.alreadyHeld.length > 0 ? 'Everything ticked is on hold already.' : 'Nothing ticked can be held.')
    for (const planned of plan.holds) {
      if (!can(actor, QUALITY_HOLDS_PLACE, { companyId: planned.companyId, siteId: planned.siteId })) throw new ForbiddenError('You place holds only at the sites your role reaches: untick the records of the other sites.')
    }

    // The group: new, or the extended hold's (its counts moved), or a new one naming a hold that had none.
    const groupId = group?.id ?? newId()
    if (group) {
      const counts = extendedCounts((group.counts ?? {}) as Record<string, number>, plan.counts)
      const { count } = await tx.qualityHoldGroup.updateMany({ where: { id: group.id, version: group.version }, data: { counts, version: group.version + 1, updatedAt: now } })
      if (count !== 1) throw new StaleVersionError('QualityHoldGroup', group.id, group.version + 1, group.version)
    } else {
      const own = extending ? { [extending.subjectType]: extending.subjectIds.length } : {}
      await tx.qualityHoldGroup.create({
        data: { id: groupId, companyId: start.companyId, sourceType: body.type, sourceId: start.id, reasonCode: body.reasonCode, reasonNote, counts: extendedCounts(own, plan.counts), placedAt: now, placedById: context.actorId, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: { id: true },
      })
      if (extending) {
        const locked = await lockActiveHold(tools, extending.id, extending.version)
        await tx.qualityHold.update({ where: { id: locked.id }, data: { groupId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ action: 'quality.joinHoldGroup', recordType: 'QualityHold', recordId: locked.id, companyId: locked.companyId, siteId: locked.siteId, before: { groupId: null }, after: { groupId } })
        emitHoldChanged(tools, locked, ['groupId'])
      }
    }

    // One hold per kind of record and site; the move asked where the site has exactly one quarantine place.
    const placed: HoldRow[] = []
    const quarantineNotAsked: { siteId: string; places: number }[] = []
    const placesBySite = new Map<string, number>()
    for (const planned of plan.holds) {
      const stock = STOCK_SUBJECTS.includes(planned.subjectType)
      let ask = false
      if (body.askQuarantine && stock) {
        if (!placesBySite.has(planned.siteId)) placesBySite.set(planned.siteId, (await quarantinePlaces(tx, planned.siteId)).length)
        ask = placesBySite.get(planned.siteId) === 1
        if (!ask && !quarantineNotAsked.some((entry) => entry.siteId === planned.siteId)) quarantineNotAsked.push({ siteId: planned.siteId, places: placesBySite.get(planned.siteId)! })
      }
      const one = await placeHoldInCommand(tools, {
        subjectType: planned.subjectType,
        subjectIds: planned.ids,
        reasonCode: body.reasonCode,
        reasonNote,
        ownerId: body.ownerId ?? null,
        expectedReleaseOn: body.expectedReleaseOn ?? null,
        askQuarantine: ask,
        note: body.note ?? null,
        groupId,
      })
      placed.push(one.hold)
    }
    tools.audit({
      action: 'quality.holdByGenealogy',
      recordType: 'QualityHoldGroup',
      recordId: groupId,
      companyId: start.companyId,
      after: { sourceType: body.type, sourceId: start.id, extended: group !== null || extending !== null, holdIds: placed.map((hold) => hold.id), counts: plan.counts, alreadyHeld: plan.alreadyHeld.length, covered: plan.covered.length },
      reason: genealogyWords(plan.counts),
    })
    const codes = new Map(impact.nodes.map((node) => [node.key, node.code]))
    // One client, one read at a time.
    const views = []
    for (const hold of placed) views.push(await detailOf(tx, (await readHold(tx, hold.id))!, now))
    return {
      group: (await groupViewOf(tx, groupId))!,
      holds: views,
      alreadyHeld: plan.alreadyHeld.map((key) => ({ key, code: codes.get(key) ?? null })),
      covered: plan.covered.length,
      quarantineNotAsked,
    }
  })
  return result
}
