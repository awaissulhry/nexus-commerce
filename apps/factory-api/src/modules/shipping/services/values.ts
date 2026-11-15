import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { SHIPPING_MANAGE, SHIPPING_SETTINGS_MANAGE, SHIPPING_SETTINGS_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { servicesChangeRefusal } from '@nexus/factory-domain/shipping/services/booking'
import { insuranceRuleOf, insureAboveProblem, insuredAfterRule, parcelValueProblems } from '@nexus/factory-domain/shipping/services/insurance'
import { events as contractEvents } from '@nexus/factory-domain/shipping-contracts/events'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { assertMay, officeContextOf } from '../access'
import { refusedFor, refusingInWords } from '../carrier-accounts/refusals'
import { officeShipment } from '../shipments/shipments'
import { lockedStatus, readShipment, type ShipmentHeader } from '../store'
import { bookingView, holdsPrice, readBooking, ruleFor, type BookingRead } from './booking'

/**
 * Insurance and declared value (B-W2b-400; LOG-042 "insurance for high-value suits"; design warehouse.shipments "Carrier &
 * label" › "W2b insurance or declared value"; factory-db Parcel declaredValue, insuredValue, ShippingSettings.insureAbove).
 * Office only, and the price grain for every figure (403 without it; the floor never reads the columns).
 *
 *   PUT  /shipping/shipments/:shipmentId/parcels/:parcelId/value   shipping.manage: a parcel's declared value and its insured
 *                                                                  value (absent: by the site's rule, insuredAfterRule;
 *                                                                  null: not insured),
 *                                                                  at the shipment's version, before its label and while
 *                                                                  the goods have not left
 *   POST /shipping/shipments/:shipmentId/parcel-values/by-rule     shipping.manage: every parcel without a label declared at
 *                                                                  its goods value (when none is declared) and insured by
 *                                                                  the site's rule
 *   GET  /shipping/sites/:siteId/insurance                         shipping.settings.view: the value above which the site
 *                                                                  insures a parcel (company currency)
 *   PUT  /shipping/sites/:siteId/insurance                         shipping.settings.manage: that value set or removed, at
 *                                                                  the settings' version
 *
 * Events shipment.parcel_values_changed and shipping.insurance_rule_changed (no value travels); the audit rows keep the values
 * marked with their grain.
 */

const valuesChanged = contractEvents.find((event): event is Extract<(typeof contractEvents)[number], { type: 'shipment.parcel_values_changed' }> => event.type === 'shipment.parcel_values_changed')!
const ruleChanged = contractEvents.find((event): event is Extract<(typeof contractEvents)[number], { type: 'shipping.insurance_rule_changed' }> => event.type === 'shipping.insurance_rule_changed')!

function assertPrice(caller: CommandCaller, what: string): void {
  if (!holdsPrice(caller)) throw new ForbiddenError(`${what} is a price: it needs the price grain.`)
}

/** The parcels' state allows a value change (not left, not cancelled, the parcels concerned without a label). */
function assertChangeable(read: BookingRead, status: ShipmentHeader['status'], parcelIds: readonly string[]): void {
  const labelled = read.facts.parcels.filter((parcel) => parcelIds.includes(parcel.id) && parcel.labelled).length
  const refusal = servicesChangeRefusal(status, labelled)
  if (refusal) throw refusedFor(refusal.code, refusal.message)
}

export interface ParcelValueBody {
  readonly version?: number | undefined
  /** Absent: the declared value stays. */
  readonly declaredValue?: number | null | undefined
  /** Absent: by the site's rule; null: not insured. */
  readonly insuredValue?: number | null | undefined
}

/** The audit's view of a parcel's values (marked money). */
const valuesOf = (declared: number | null, insured: number | null) => ({ declaredValue: markMoney('price', declared), insuredValue: markMoney('price', insured) })

/** PUT /shipping/shipments/:shipmentId/parcels/:parcelId/value */
export async function setParcelValue(caller: CommandCaller, shipmentId: string, parcelId: string, body: ParcelValueBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  assertPrice(caller, "A parcel's declared or insured value")
  const first = await caller.withClient((client) => readBooking(client, shipment, { amounts: true }))
  if (!isUuid(parcelId) || !first.facts.parcels.some((parcel) => parcel.id === parcelId)) throw new NotFoundError('Parcel not found in this shipment.')
  assertChangeable(first, shipment.status, [parcelId])
  if (body.declaredValue === undefined && body.insuredValue === undefined) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send the declared value, the insured value, or both.' }])
  const present = first.facts.parcels.find((parcel) => parcel.id === parcelId)!
  const typed = parcelValueProblems(body.declaredValue === undefined ? present.declaredValue : body.declaredValue, body.insuredValue ?? null)
  if (typed.length > 0) throw new ValidationError(typed[0]!.message, typed)

  await refusingInWords(() =>
    command(caller, { name: 'shipping.setParcelValue', idempotencyKey, input: { shipmentId, parcelId, version: body.version, byRule: body.insuredValue === undefined }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const current = await lockedStatus(tools, shipment.id, ['DRAFT', 'PACKED'], "a parcel's values change")
      const read = await readBooking(tx, current, { amounts: true })
      assertChangeable(read, current.status, [parcelId])
      const parcel = read.facts.parcels.find((entry) => entry.id === parcelId)!
      const declared = body.declaredValue === undefined ? parcel.declaredValue : body.declaredValue
      const insured = body.insuredValue === undefined ? insuredAfterRule(declared, parcel.insuredValue, ruleFor(read, declared)) : body.insuredValue
      const problems = parcelValueProblems(declared, insured)
      if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
      await tx.parcel.update({ where: { id: parcelId }, data: { declaredValue: declared, insuredValue: insured, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ recordType: 'Parcel', recordId: parcelId, companyId: current.companyId, siteId: current.siteId, before: valuesOf(parcel.declaredValue, parcel.insuredValue), after: { ...valuesOf(declared, insured), byRule: body.insuredValue === undefined } })
      tools.emit(eventFor(valuesChanged, { subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, parcelIds: [parcelId], byRule: body.insuredValue === undefined } }))
      return { parcelId }
    }),
  )
  return afterChange(caller, shipment.id)
}

async function afterChange(caller: CommandCaller, shipmentId: string) {
  return caller.withClient(async (client) => {
    const after = (await readShipment(client, shipmentId))!
    return bookingView(after, await readBooking(client, after, { amounts: true }))
  })
}

/** POST /shipping/shipments/:shipmentId/parcel-values/by-rule */
export async function valuesByRule(caller: CommandCaller, shipmentId: string, body: { readonly version?: number | undefined }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  assertPrice(caller, "A parcel's declared or insured value")
  const first = await caller.withClient((client) => readBooking(client, shipment, { amounts: true }))
  if (first.facts.parcels.length === 0) throw new InvalidStateError('The shipment has no parcel yet: add its parcels first.')
  assertChangeable(first, shipment.status, [])
  await refusingInWords(() =>
    command(caller, { name: 'shipping.parcelValuesByRule', idempotencyKey, input: { shipmentId, version: body.version }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const current = await lockedStatus(tools, shipment.id, ['DRAFT', 'PACKED'], "the parcels' values change")
      const read = await readBooking(tx, current, { amounts: true })
      assertChangeable(read, current.status, [])
      const changed: string[] = []
      for (const parcel of read.facts.parcels.filter((entry) => !entry.labelled)) {
        const goods = read.goods.get(parcel.id) ?? 0
        const declared = parcel.declaredValue ?? (goods > 0 ? goods : null)
        const rule = ruleFor(read, declared)
        const insured = insuredAfterRule(declared, parcel.insuredValue, rule)
        if (declared === parcel.declaredValue && insured === parcel.insuredValue) continue
        await tx.parcel.update({ where: { id: parcel.id }, data: { declaredValue: declared, insuredValue: insured, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ recordType: 'Parcel', recordId: parcel.id, companyId: current.companyId, siteId: current.siteId, before: valuesOf(parcel.declaredValue, parcel.insuredValue), after: { ...valuesOf(declared, insured), byRule: true } })
        changed.push(parcel.id)
      }
      tools.audit({ action: 'shipping.parcelValuesByRule', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { parcelIds: changed } })
      if (changed.length > 0) tools.emit(eventFor(valuesChanged, { subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, parcelIds: changed, byRule: true } }))
      return { changed }
    }),
  )
  return afterChange(caller, shipment.id)
}

// ---- the site's rule ----------------------------------------------------------------------------------------------------

async function siteFor(caller: CommandCaller, siteId: string, permission: typeof SHIPPING_SETTINGS_VIEW | typeof SHIPPING_SETTINGS_MANAGE) {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, code: true } })) : null
  assertMay(context, SHIPPING_SETTINGS_VIEW, permission, site ? { companyId: site.companyId, siteId: site.id } : null, 'Site')
  return site!
}

async function ruleView(db: CommandTx, site: { id: string; companyId: string; code: string }) {
  const settings = await db.shippingSettings.findUnique({ where: { id: site.id }, select: { insureAbove: true, version: true, updatedAt: true } })
  const company = await db.company.findUnique({ where: { id: site.companyId }, select: { currency: true } })
  const currency = company?.currency ?? 'EUR'
  const insureAbove = settings?.insureAbove ?? null
  return {
    siteId: site.id,
    siteCode: site.code,
    hasSettings: settings !== null,
    insureAbove: asMoney('price', insureAbove),
    currency,
    words: insuranceRuleOf({ declared: null, declaredInCompany: null, insureAbove, companyCurrency: currency, orderCurrency: currency }, true).words,
    version: settings?.version ?? null,
    updatedAt: settings ? toUtcIso(settings.updatedAt) : null,
  }
}

/** GET /shipping/sites/:siteId/insurance */
export async function getInsuranceRule(caller: CommandCaller, siteId: string) {
  const site = await siteFor(caller, siteId, SHIPPING_SETTINGS_VIEW)
  assertPrice(caller, "The site's insurance value")
  return { rule: await caller.withClient((client) => ruleView(client, site)) }
}

/** PUT /shipping/sites/:siteId/insurance */
export async function setInsuranceRule(caller: CommandCaller, siteId: string, body: { readonly version?: number | undefined; readonly insureAbove?: number | null | undefined }, idempotencyKey?: string) {
  const site = await siteFor(caller, siteId, SHIPPING_SETTINGS_MANAGE)
  assertPrice(caller, "The site's insurance value")
  if (body.insureAbove === undefined) throw new ValidationError('Send the value above which parcels are insured, or null for no rule.', [{ path: 'body/insureAbove', message: 'Required (null: no rule).' }])
  const insureAbove = body.insureAbove
  const problem = insureAboveProblem(insureAbove)
  if (problem) throw new ValidationError(problem, [{ path: 'body/insureAbove', message: problem }])
  const exists = await caller.withClient((client) => client.shippingSettings.findUnique({ where: { id: site.id }, select: { id: true } }))
  if (!exists) throw new InvalidStateError('This site has no shipping settings yet: save its sender address first.')
  await refusingInWords(() =>
    command(caller, { name: 'shipping.setInsuranceRule', idempotencyKey, input: { siteId, ...body }, record: { type: 'ShippingSettings', id: site.id, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const before = await tx.shippingSettings.findUniqueOrThrow({ where: { id: site.id }, select: { insureAbove: true } })
      await tx.shippingSettings.update({ where: { id: site.id }, data: { insureAbove }, select: { id: true } })
      tools.audit({ recordType: 'ShippingSettings', recordId: site.id, companyId: site.companyId, siteId: site.id, before: { insureAbove: markMoney('price', before.insureAbove) }, after: { insureAbove: markMoney('price', insureAbove) } })
      tools.emit(eventFor(ruleChanged, { subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, ruleOn: insureAbove !== null } }))
      return { siteId: site.id }
    }),
  )
  return { rule: await caller.withClient((client) => ruleView(client, site)) }
}
