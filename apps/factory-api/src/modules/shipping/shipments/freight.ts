import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { SHIPPING_SETTINGS_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { freightByRule, freightChargeProblems, freightRuleProblems, type FreightByRule, type FreightRule } from '@nexus/factory-domain/shipping/shipments/freight'
import { SHIPPING_FREIGHT_MANAGE } from '@nexus/factory-domain/shipping/shipments/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertMay, officeContextOf } from '../access'
import { readShipment, type ShipmentHeader } from '../store'
import { officeShipment } from './shipments'

/**
 * The freight charged to the customer (B-W2a-48; LOG-105; design warehouse.shipments "Freight charged (price, W2a)",
 * Invoice tab "W2a freight line by rule"): a site's freight rule, a shipment's charge (factory-domain shipping/
 * shipments/freight). Office only; every figure is money.price (the warehouse sees none, the floor never reads the
 * columns at all).
 *
 *   GET|PUT /shipping/sites/:siteId/freight-rule        the site's rule (read: shipping.settings.view; save:
 *                                                        shipping.freight.manage), on its ShippingSettings row (its
 *                                                        version is the edit guard; the settings must exist)
 *   PUT /shipping/shipments/:shipmentId/freight         the office's charge (shipping.freight.manage), until the shipment
 *                                                        is cancelled; null puts it back to the rule (applied at once
 *                                                        when the goods already left)
 *   when the goods leave (`applyFreightInCommand`)      a shipment with no charge typed gets the rule's
 *
 * Whether a charge was typed is the last freight audit row of the shipment (`shipping.setFreight` byHand, or
 * `shipping.freightByRule`): no column says it.
 */

const SET_FREIGHT = 'shipping.setFreight'
const FREIGHT_BY_RULE = 'shipping.freightByRule'

const RULE_SELECT = { id: true, companyId: true, siteId: true, freightRule: true, freightAmount: true, freightFreeFrom: true, version: true, updatedAt: true } as const

async function siteFor(caller: CommandCaller, siteId: string, permission: typeof SHIPPING_SETTINGS_VIEW | typeof SHIPPING_FREIGHT_MANAGE) {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, code: true, name: true } })) : null
  assertMay(context, SHIPPING_SETTINGS_VIEW, permission, site ? { companyId: site.companyId, siteId: site.id } : null, 'Site')
  return site!
}

async function ruleOf(db: CommandTx, siteId: string) {
  const row = await db.shippingSettings.findUnique({ where: { id: siteId }, select: RULE_SELECT })
  if (!row) return null
  const company = await db.company.findUnique({ where: { id: row.companyId }, select: { currency: true } })
  return {
    rule: row.freightRule as FreightRule,
    amount: asMoney('price', row.freightAmount),
    freeFrom: asMoney('price', row.freightFreeFrom),
    currency: company?.currency ?? 'EUR',
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** GET /shipping/sites/:siteId/freight-rule */
export async function getFreightRule(caller: CommandCaller, siteId: string) {
  const site = await siteFor(caller, siteId, SHIPPING_SETTINGS_VIEW)
  return { site, freight: await caller.withClient((client) => ruleOf(client, site.id)) }
}

export interface FreightRuleBody {
  readonly version?: number | undefined
  readonly rule: FreightRule
  readonly amount?: number | null | undefined
  readonly freeFrom?: number | null | undefined
}

/** PUT /shipping/sites/:siteId/freight-rule: the site's rule, on its shipping settings (which must exist). */
export async function saveFreightRule(caller: CommandCaller, siteId: string, body: FreightRuleBody, idempotencyKey?: string) {
  const site = await siteFor(caller, siteId, SHIPPING_FREIGHT_MANAGE)
  const problems = freightRuleProblems(body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The freight rule is not valid.', problems)
  const existing = await caller.withClient((client) => client.shippingSettings.findUnique({ where: { id: site.id }, select: { id: true } }))
  if (!existing) throw new InvalidStateError(`Site ${site.code} has no shipping settings yet: save them first (the sender address), then its freight rule.`)
  const amount = body.rule === 'NONE' ? null : (body.amount ?? null)
  const freeFrom = body.rule === 'NONE' ? null : (body.freeFrom ?? null)
  const { result } = await command(caller, { name: 'shipping.saveFreightRule', idempotencyKey, input: { siteId, ...body }, record: { type: 'ShippingSettings', id: site.id, expectedVersion: body.version } }, async (tools) => {
    const before = await tools.tx.shippingSettings.findUnique({ where: { id: site.id }, select: RULE_SELECT })
    await tools.tx.shippingSettings.update({ where: { id: site.id }, data: { freightRule: body.rule, freightAmount: amount, freightFreeFrom: freeFrom }, select: { id: true } })
    tools.audit({
      recordType: 'ShippingSettings',
      recordId: site.id,
      companyId: site.companyId,
      siteId: site.id,
      before: before ? { freightRule: before.freightRule, freightAmount: markMoney('price', before.freightAmount), freightFreeFrom: markMoney('price', before.freightFreeFrom) } : null,
      after: { freightRule: body.rule, freightAmount: markMoney('price', amount), freightFreeFrom: markMoney('price', freeFrom) },
    })
    tools.emit({ type: 'shipping.freight_rule_saved', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, rule: body.rule } })
    return { site, freight: await ruleOf(tools.tx, site.id) }
  })
  return result
}

// ---- a shipment's charge --------------------------------------------------------------------------------------------

/** What the site's rule gives this shipment now (the parcels it has now). */
async function byRuleOf(db: CommandTx, shipment: Pick<ShipmentHeader, 'id' | 'siteId' | 'salesOrderId' | 'partyId' | 'transportBy'>): Promise<FreightByRule> {
  const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { companyId: true, freightRule: true, freightAmount: true, freightFreeFrom: true } })
  const company = settings ? await db.company.findUnique({ where: { id: settings.companyId }, select: { currency: true } }) : null
  const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { currency: true, netAmount: true } })
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { incoterm: true } })
  const parcels = await db.parcel.count({ where: { shipmentId: shipment.id } })
  return freightByRule({
    settings: settings ? { rule: settings.freightRule as FreightRule, amount: settings.freightAmount, freeFrom: settings.freightFreeFrom, currency: company?.currency ?? 'EUR' } : null,
    transportBy: shipment.transportBy,
    incoterm: party?.incoterm ?? null,
    orderCurrency: order?.currency ?? 'EUR',
    orderNet: order?.netAmount ?? 0,
    parcels,
  })
}

/** The last freight audit row of the shipment says whether its charge was typed (true) or the rule's (false). */
async function typedByHand(db: CommandTx, shipmentId: string): Promise<boolean> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'Shipment', recordId: shipmentId, action: { in: [SET_FREIGHT, FREIGHT_BY_RULE] } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { action: true, after: true } })
  if (!row || row.action !== SET_FREIGHT) return false
  const after = row.after as { byHand?: unknown } | null
  return after?.byHand === true
}

/**
 * The office's view of a shipment's freight (the record's `freight`): the charge, whose it is, and the rule's now.
 * `byHand`: what a command that just set it knows (its own audit row is written at its end, so it cannot read it).
 */
export async function freightView(db: CommandTx, shipment: ShipmentHeader, byHand?: boolean) {
  const row = await db.shipment.findUnique({ where: { id: shipment.id }, select: { freightCharge: true } })
  const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { currency: true } })
  const byRule = await byRuleOf(db, shipment)
  return {
    charge: asMoney('price', row?.freightCharge ?? null),
    currency: order?.currency ?? 'EUR',
    byHand: (row?.freightCharge ?? null) !== null && (byHand ?? (await typedByHand(db, shipment.id))),
    byRule: { charge: asMoney('price', byRule.charge), basis: byRule.basis, words: byRule.words },
  }
}

export type FreightView = Awaited<ReturnType<typeof freightView>>

/**
 * Inside the leaving command (office): a shipment whose charge nobody typed gets the site's rule's, for the parcels
 * that leave. Answers the basis, or null when a typed charge stays.
 */
export async function applyFreightInCommand(tools: CommandTools, shipment: ShipmentHeader): Promise<FreightByRule | null> {
  const row = await tools.tx.shipment.findUnique({ where: { id: shipment.id }, select: { freightCharge: true } })
  if (row?.freightCharge !== null && row?.freightCharge !== undefined && (await typedByHand(tools.tx, shipment.id))) return null
  const byRule = await byRuleOf(tools.tx, shipment)
  await tools.tx.shipment.update({ where: { id: shipment.id }, data: { freightCharge: byRule.charge }, select: { id: true } })
  tools.audit({ action: FREIGHT_BY_RULE, recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { freightCharge: markMoney('price', row?.freightCharge ?? null) }, after: { freightCharge: markMoney('price', byRule.charge), byHand: false, basis: byRule.basis } })
  tools.emit({ type: 'shipment.freight_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, byHand: false, basis: byRule.basis } })
  return byRule
}

/** PUT /shipping/shipments/:shipmentId/freight: the office's charge, or null back to the rule. */
export async function setFreight(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; freightCharge: number | null }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_FREIGHT_MANAGE)
  const { result } = await command(caller, { name: SET_FREIGHT, idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
    const current = await readShipment(tools.tx, shipment.id)
    if (!current) throw new NotFoundError('Shipment not found.')
    const problems = freightChargeProblems(current.status, body.freightCharge)
    if (problems.length > 0) throw current.status === 'CANCELLED' ? new InvalidStateError(problems[0]!) : new ConflictError(problems[0]!)
    const before = await tools.tx.shipment.findUnique({ where: { id: current.id }, select: { freightCharge: true } })
    const left = current.status === 'SHIPPED' || current.status === 'DELIVERED' || current.status === 'RETURNED'
    // Back to the rule: applied now when the goods left, else when they leave.
    const byRule = body.freightCharge === null && left ? await byRuleOf(tools.tx, current) : null
    const charge = body.freightCharge ?? byRule?.charge ?? null
    await tools.tx.shipment.update({ where: { id: current.id }, data: { freightCharge: charge }, select: { id: true } })
    tools.audit({
      action: SET_FREIGHT,
      recordType: 'Shipment',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { freightCharge: markMoney('price', before?.freightCharge ?? null) },
      after: { freightCharge: markMoney('price', charge), byHand: body.freightCharge !== null, basis: byRule?.basis ?? null },
    })
    tools.emit({ type: 'shipment.freight_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, byHand: body.freightCharge !== null, basis: byRule?.basis ?? null } })
    return { shipmentId: current.id, number: current.number, status: current.status, version: (await readShipment(tools.tx, current.id))!.version, freight: await freightView(tools.tx, (await readShipment(tools.tx, current.id))!, body.freightCharge !== null) }
  })
  return result
}

/** The freight charged of these shipments (the list's column), by id. */
export async function freightCharges(db: CommandTx, shipmentIds: readonly string[]): Promise<Map<string, number | null>> {
  if (shipmentIds.length === 0) return new Map()
  const rows = await db.shipment.findMany({ where: { id: { in: [...shipmentIds] } }, select: { id: true, freightCharge: true } })
  return new Map(rows.map((row) => [row.id, row.freightCharge]))
}
