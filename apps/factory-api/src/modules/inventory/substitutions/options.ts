import { askersOf, chooseRules } from '@nexus/factory-domain/approvals/rules'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_ISSUE } from '@nexus/factory-domain/inventory/permissions'
import { askAnswer, noApproverWords, replacesOwn, standingTotal, stillOpen, type SubstituteKind } from '@nexus/factory-domain/inventory/substitutions/rules'
import { NOT_COUNTED_WORDS, usabilityOf } from '@nexus/factory-domain/planning/usable'
import type { AlternateUse } from '@nexus/factory-domain/product/bom-lines/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { mayAt, stockContextOf, type StockContext } from '../ledger/access'
import { readLocations, readLots, readPickHeader, readSiteStock, type PickHeader, type Reader } from '../issue/store'
import { heldByQualityHolds } from '../../quality/holds/stock'
import { certificateCovering } from '../../quality/lab/store'
import { asTenantSystem } from '../../production/bundles/codes'
import { SUBSTITUTION_FIELDS, substitutionFacts } from './facts'
import { lineFactsOf, readItemsOf, revisionOf, substitutionViews, unitsOf, type LineFacts, type SubstituteItemRow, type SubstitutionRow, SUBSTITUTION_COLUMNS } from './store'

/**
 * "Use a substitute" (B-W2b-298; MES-139; design warehouse.picking pop:pk-sub, production.workorders Materials "Substitute…"):
 * what may stand in for one BOM line's own material on a work order, read for the dialog. Office and the floor of the work
 * order's site (inventory.issue). For the line: its need, what is issued, still to issue, what nothing covers (short), what
 * standing substitutes stand for, and what is still open. For each choice (every alternate of the line, first choice first,
 * then another lot of the own material): the alternate rule's answer with the work order's facts (B-W2b-228 `alternateUse`),
 * the certificate that covers it today (or none), the stock at the site lot by lot with its quality in words (a lot without a
 * valid chromium VI test is said, and cannot be named), how much at most, and who would approve it (the switched-on approval
 * rules of kind MATERIAL_SUBSTITUTION, run on the facts as the request would carry them: a dry run, nothing written).
 */

const unique = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string'))]

export interface Loaded {
  readonly header: PickHeader
  readonly revisionId: string
  readonly site: { readonly id: string; readonly code: string }
  readonly line: LineFacts
  readonly own: SubstituteItemRow
  readonly alternates: readonly { readonly id: string; readonly priority: number; readonly itemId: string; readonly itemColourId: string | null; readonly qty: string | null; readonly allowedWhen: AlternateUse; readonly certificateCheck: boolean; readonly note: string | null }[]
  readonly items: ReadonlyMap<string, SubstituteItemRow>
  readonly standing: readonly SubstitutionRow[]
}

/** The work order, its line, the line's alternates and materials, the substitutions standing on the line. */
export async function loadLine(db: Reader, context: StockContext, workOrderId: string, bomLineId: string): Promise<Loaded> {
  const header = await readPickHeader(db, workOrderId)
  if (!header || !mayAt(context, INVENTORY_ISSUE, header)) throw new NotFoundError('Work order not found.')
  const revisionId = (await revisionOf(db, header.id))!
  const line = await lineFactsOf(db, context, header, revisionId, bomLineId)
  if (!line) throw new NotFoundError('BOM line not found on this work order.')
  const site = (await db.site.findUnique({ where: { id: header.siteId }, select: { id: true, code: true } }))!
  const alternates = (
    await db.bomLineAlternate.findMany({
      where: { revisionId, bomLineId: line.bomLineId },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      select: { id: true, priority: true, itemId: true, itemColourId: true, qty: true, allowedWhen: true, certificateCheck: true, note: true },
    })
  ).map((row) => ({ ...row, qty: row.qty === null ? null : row.qty.toString(), allowedWhen: row.allowedWhen as AlternateUse }))
  const items = await readItemsOf(db, [line.itemId, ...alternates.map((row) => row.itemId)])
  const standing = await db.materialSubstitution.findMany({
    where: { workOrderId: header.id, bomLineId: line.bomLineId, status: { in: ['WAITING', 'APPROVED', 'ISSUED'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: SUBSTITUTION_COLUMNS,
  })
  return { header, revisionId, site, line, own: items.get(line.itemId)!, alternates, items, standing }
}

/** How much of the line's own material a substitute stands for, per base unit of it (null: the units do not convert). */
export function ratioOf(loaded: Pick<Loaded, 'line' | 'own'>, kind: SubstituteKind, substitute: SubstituteItemRow, alternateQty: string | null): Decimal | null {
  const ratio = replacesOwn({ kind, lineQty: loaded.line.qty, lineUom: loaded.line.uom, ownUnits: unitsOf(loaded.own), alternateQty, substituteUnits: unitsOf(substitute) }, '1')
  return ratio === null ? null : new Dec(ratio)
}

/** What standing substitutions of the line stand for, of its own material (base unit). */
export async function standingOf(db: Reader, loaded: Pick<Loaded, 'standing'>): Promise<Decimal> {
  const views = await substitutionViews(db, loaded.standing)
  return new Dec(standingTotal(views.map((view) => ({ status: view.status, replaces: view.replaces?.quantity ?? null }))))
}

/** Who would approve a request with these facts: the first switched-on rule that holds (a dry run of the engine's choice). */
export async function approvalRouteFor(db: Reader, input: { readonly companyId: string; readonly facts: ReturnType<typeof substitutionFacts>; readonly askers: readonly string[] }) {
  const rules = await db.approvalRule.findMany({
    where: { kind: 'MATERIAL_SUBSTITUTION', active: true, OR: [{ companyId: null }, { companyId: input.companyId }] },
    select: { id: true, companyId: true, sequence: true, createdAt: true, active: true, effectiveFrom: true, condition: true, approverRoleId: true, approverUserId: true, signatureMeaning: true, requireStepUp: true, dueHours: true, name: true },
  })
  const choice = chooseRules(rules, { companyId: input.companyId, facts: input.facts, askers: input.askers }, SUBSTITUTION_FIELDS, serverClock.now())
  const rule = choice.deciding
  if (!rule) return { asks: false, active: rules.length, rule: null, approver: null, namedSelf: choice.matched.length > 0 }
  const role = rule.approverRoleId ? await db.role.findUnique({ where: { id: rule.approverRoleId }, select: { id: true, name: true } }) : null
  const user = rule.approverUserId ? await db.user.findUnique({ where: { id: rule.approverUserId }, select: { id: true, displayName: true } }) : null
  return {
    asks: true,
    active: rules.length,
    rule: { id: rule.id, name: rule.name, signatureMeaning: rule.signatureMeaning, requireStepUp: rule.requireStepUp, dueHours: rule.dueHours },
    approver: role ? { kind: 'ROLE' as const, id: role.id, name: role.name } : user ? { kind: 'PERSON' as const, id: user.id, name: user.displayName } : null,
    namedSelf: false,
  }
}

/** The site's stock of one material lot by lot (free of quality holds or not), with where it lies and its quality in words. */
async function stockOf(db: Reader, siteId: string, itemId: string, itemColourId: string | null | undefined) {
  const balances = await readSiteStock(db, siteId, { itemIds: [itemId], ...(itemColourId !== undefined ? { itemColourId } : {}) })
  const lots = await readLots(db, unique(balances.map((row) => row.lotId)))
  const places = await readLocations(db, unique(balances.map((row) => row.locationId)))
  const holds = await heldByQualityHolds(db, { lotIds: balances.map((row) => row.lotId), hideIds: balances.map((row) => row.hideId) })
  const byLot = new Map<string, { lotId: string | null; colourId: string | null; onHand: Decimal; held: Decimal; hides: Set<string>; places: Set<string> }>()
  for (const row of balances) {
    const key = `${row.lotId ?? '-'}|${row.itemColourId ?? '-'}`
    const entry = byLot.get(key) ?? { lotId: row.lotId, colourId: row.itemColourId, onHand: new Dec(0), held: new Dec(0), hides: new Set<string>(), places: new Set<string>() }
    entry.onHand = entry.onHand.plus(row.onHand)
    if (holds.holds(row)) entry.held = entry.held.plus(row.onHand)
    if (row.hideId) entry.hides.add(row.hideId)
    entry.places.add(places.get(row.locationId)?.code ?? '?')
    byLot.set(key, entry)
  }
  const colours = new Map((await db.itemColour.findMany({ where: { id: { in: unique([...byLot.values()].map((entry) => entry.colourId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const rows = [...byLot.values()].map((entry) => {
    const lot = entry.lotId ? lots.get(entry.lotId) : undefined
    const usability = usabilityOf(lot ?? null)
    const onHold = entry.held.gt(0)
    const usable = usability.usable && !onHold
    const words = !usability.usable ? `Lot ${lot?.code ?? '?'}: ${NOT_COUNTED_WORDS[usability.reason]}; it is not used until quality releases it.` : onHold ? `Lot ${lot?.code ?? '?'} is on a quality hold: it is not used until quality releases it.` : null
    return {
      lot: lot ? { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus, crViStatus: lot.crViStatus, requiresCrViTest: lot.requiresCrViTest } : null,
      colour: entry.colourId ? (colours.get(entry.colourId) ?? null) : null,
      onHand: quantityText(entry.onHand),
      hides: entry.hides.size,
      places: [...entry.places].sort(),
      usable,
      words,
      receivedAt: lot?.receivedAt ? lot.receivedAt.toISOString() : null,
    }
  })
  rows.sort((a, b) => Number(b.usable) - Number(a.usable) || ((a.receivedAt ?? '') < (b.receivedAt ?? '') ? -1 : 1) || ((a.lot?.code ?? '') < (b.lot?.code ?? '') ? -1 : 1))
  const usableOnHand = rows.filter((row) => row.usable).reduce((sum, row) => sum.plus(row.onHand), new Dec(0))
  return { onHand: quantityText(usableOnHand), lots: rows.map(({ receivedAt: _received, ...row }) => row) }
}

const itemRef = (item: SubstituteItemRow) => ({ id: item.id, code: item.code, name: item.name, kind: item.kind, tracking: item.tracking, baseUom: item.baseUom, isPpeComponent: item.isPpeComponent })

/** GET /inventory/substitutions/options?workOrderId=&bomLineId=: the dialog's read. */
export async function substituteOptions(caller: CommandCaller, query: { readonly workOrderId: string; readonly bomLineId: string }) {
  const context = stockContextOf(caller)
  const actorId = context.audience === 'system' ? null : context.actorId
  // A tablet reads its own site's work order, then the rest as the tenant's system caller (the approval rules, as the ask does).
  let reader: CommandCaller = caller
  if (context.audience === 'floor') {
    const header = await caller.withClient((db) => readPickHeader(db, query.workOrderId))
    if (!header || !mayAt(context, INVENTORY_ISSUE, header)) throw new NotFoundError('Work order not found.')
    reader = asTenantSystem(caller, context)
  }
  return reader.withClient(async (client) => {
    const db: Reader = client
    const loaded = await loadLine(db, context, query.workOrderId, query.bomLineId)
    const { header, line, own, site } = loaded
    const today = businessDate(serverClock.now())
    const standing = await standingOf(db, loaded)
    const ownShort = new Dec(line.short).gt(ZERO)
    const worker = context.audience === 'floor' ? await db.worker.findUnique({ where: { id: context.actorId }, select: { userId: true } }) : null
    const askers = context.audience === 'office' ? askersOf({ requestedById: actorId, createdById: actorId }) : askersOf({ requestedById: null, createdById: null }, worker?.userId ?? null)
    const choice = async (kind: SubstituteKind, item: SubstituteItemRow, alternate: Loaded['alternates'][number] | null) => {
      const certificateRequired = alternate ? alternate.certificateCheck || own.isPpeComponent || item.isPpeComponent : false
      const certificate = alternate && certificateRequired ? await certificateCovering(db, { itemId: item.id, companyId: header.companyId }, today) : null
      const answer = askAnswer({
        kind,
        line: { seq: line.seq, materialCode: own.code },
        alternate: alternate ? { priority: alternate.priority, code: item.code, allowedWhen: alternate.allowedWhen, certificateCheck: alternate.certificateCheck } : null,
        certificateRequired,
        certificate: certificate ? { number: certificate.number, validTo: certificate.validTo } : null,
        ownShort,
      })
      const onlyShort = alternate?.allowedWhen === 'WHEN_SHORT'
      const openOwn = stillOpen({ toIssue: line.toIssue, short: line.short, standing: quantityText(standing), onlyShort })
      const ratio = ratioOf(loaded, kind, item, alternate?.qty ?? null)
      const maxSubstitute = ratio && ratio.gt(ZERO) ? openOwn.div(ratio) : null
      const facts = substitutionFacts({ kind, allowedWhen: alternate?.allowedWhen ?? null, ppe: own.isPpeComponent || item.isPpeComponent, materialKind: item.kind, itemCode: item.code, lineMaterialCode: own.code, quantity: quantityText(maxSubstitute ?? ZERO), siteCode: site.code, reasonCode: null, askedOnFloor: context.audience === 'floor' })
      const route = await approvalRouteFor(db, { companyId: header.companyId, facts, askers })
      const stock = await stockOf(db, header.siteId, item.id, alternate ? (alternate.itemColourId ?? undefined) : undefined)
      const held =
        answer.refusal?.message ??
        (openOwn.lte(ZERO) ? `Nothing of ${own.code} is left to replace on line ${line.seq}.` : null) ??
        (answer.needsPerson && !route.asks ? noApproverWords(alternate ? `Alternate ${alternate.priority} (${item.code})` : `Another lot of ${own.code}`) : null) ??
        (stock.lots.every((lot) => !lot.usable) ? `No usable stock of ${item.code} lies at ${site.code}.` : null)
      return {
        kind,
        alternate: alternate ? { id: alternate.id, priority: alternate.priority, allowedWhen: alternate.allowedWhen, certificateCheck: alternate.certificateCheck, qty: alternate.qty, note: alternate.note, colourId: alternate.itemColourId } : null,
        item: itemRef(item),
        answer: answer.ruleAnswer,
        needsPerson: answer.needsPerson,
        refusal: answer.refusal,
        certificateRequired,
        certificate,
        /** At most this much of it (its base unit) may be asked for now; null: its units do not convert. */
        max: maxSubstitute === null ? null : quantityText(maxSubstitute),
        stock,
        approval: route,
        mayAsk: held === null,
        held,
      }
    }
    const choices = []
    for (const alternate of loaded.alternates) {
      const item = loaded.items.get(alternate.itemId)
      if (item) choices.push(await choice('ALTERNATE', item, alternate))
    }
    choices.push(await choice('OWN_MATERIAL', own, null))
    return {
      asOf: serverClock.now().toISOString(),
      workOrder: { id: header.id, number: header.number, status: header.status, siteId: header.siteId, companyId: header.companyId },
      line: {
        id: line.bomLineId,
        seq: line.seq,
        placement: line.placement,
        material: itemRef(own),
        qty: quantityText(line.qty),
        uom: line.uom,
        planned: line.planned,
        issued: line.issued,
        toIssue: line.toIssue,
        short: line.short,
        ownShort,
        standing: quantityText(standing),
        open: quantityText(Dec.max(ZERO, new Dec(line.toIssue).minus(standing))),
      },
      substitutions: await substitutionViews(db, loaded.standing),
      choices,
    }
  })
}
