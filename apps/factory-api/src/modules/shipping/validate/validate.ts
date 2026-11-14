import { DomainError } from '@nexus/factory-domain/core/errors'
import { isLabelled, parcelsToLabel, type LabelFacts, type LabelParcel } from '@nexus/factory-domain/shipping/labels/labels'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import { carrierRuleProblems, checkShipment, type CheckFacts, type CheckProblem } from '@nexus/factory-domain/shipping/validate/rules'
import type { CommandCaller } from '../../../core/command'
import { assertMay, shippingContextOf } from '../access'
import { labelParcelOf, readLabelParcels } from '../labels/store'
import { readShipment } from '../store'

/**
 * Check every parcel before printing (B-W2b-390; LOG-045; rules factory-domain shipping/validate): the check the bench and
 * the dispatch desk read before a label is bought, and the refusal of a buy that the carrier's rules would stop.
 *
 *   read    office and floor (shipping.pack): each parcel without a label checked against its carrier's rules (postal codes,
 *           the recipient's phone, weight, sizes) and the shipment's own fields (the addresses, the service); every
 *           problem with its code and words; `printable` when a label may be bought now
 *   buy     labels.ts calls assertCarrierRules after W1's field checks and before any carrier (or the TEST carrier): a
 *           parcel the carrier's rules refuse stops the whole buy with a 409 in words (`refusal/<CODE>` per problem):
 *           nothing is bought for a shipment that cannot leave complete
 */

const conflictOf = (problems: readonly CheckProblem[]): DomainError =>
  new DomainError(
    'conflict',
    problems.length === 1 ? problems[0]!.words : `The carrier would refuse these parcels: ${problems.map((problem) => problem.words).join(' ')}`,
    problems.map((problem) => ({ path: `refusal/${problem.code}`, message: problem.words })),
  )

/** The check's facts from the buy's facts (the parcels to label now). */
const checkFactsOf = (facts: LabelFacts, parcels: readonly LabelParcel[]): CheckFacts => ({
  carrierCode: facts.shipment.carrierCode,
  sender: facts.sender,
  recipient: facts.shipment.shipTo,
  serviceCode: facts.shipment.serviceCode,
  parcels,
})

/** B-W2b-390 (LOG-045): refuses a buy (409 in words) when the carrier's rules would refuse one of the parcels. */
export function assertCarrierRules(facts: LabelFacts, parcels: readonly LabelParcel[]): void {
  const problems = carrierRuleProblems(checkShipment(checkFactsOf(facts, parcels)))
  if (problems.length > 0) throw conflictOf(problems)
}

/** Why no carrier label applies to the shipment (null: one does). */
type NotApplying = 'OWN_VAN' | 'CUSTOMER_COLLECTS' | 'MANUAL_CARRIER' | null

/** shipping.pack (office and floor): the check of the shipment's parcels before printing. */
export async function checkLabels(caller: CommandCaller, shipmentId: string) {
  const context = shippingContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_PACK, SHIPPING_PACK, shipment)
  return caller.withClient(async (client) => {
    const settings = await client.shippingSettings.findUnique({ where: { id: shipment!.siteId }, select: { senderAddress: true, testMode: true } })
    const manual = await client.shipment.findUnique({ where: { id: shipment!.id }, select: { manualTrackingNumber: true } })
    const parcels = (await readLabelParcels(client, shipment!.id)).map(labelParcelOf)
    const notApplying: NotApplying =
      shipment!.transportBy === 'SENDER' ? 'OWN_VAN' : shipment!.transportBy === 'RECIPIENT' ? 'CUSTOMER_COLLECTS' : manual?.manualTrackingNumber ? 'MANUAL_CARRIER' : null
    // A ship-to with no name of its own prints the customer's name (labels/store.ts recipientOf): never missing on the label.
    const shipTo = (shipment!.shipTo ?? {}) as Record<string, unknown>
    const recipient = typeof shipTo.name === 'string' && shipTo.name.trim() !== '' ? shipTo : { ...shipTo, name: 'the customer' }
    const todo = parcelsToLabel(parcels)
    const outcome = checkShipment({ carrierCode: shipment!.carrierCode, sender: settings?.senderAddress ?? null, recipient, serviceCode: shipment!.serviceCode, parcels: todo })
    const problems = notApplying === null ? [...outcome.problems] : []
    return {
      shipment: {
        id: shipment!.id,
        number: shipment!.number,
        status: shipment!.status,
        transportBy: shipment!.transportBy,
        carrierCode: shipment!.carrierCode,
        carrierName: shipment!.carrierName,
        serviceCode: shipment!.serviceCode,
      },
      /** B-W2b-390 (LOG-035): the site's test mode (no settings: test mode). */
      testMode: settings?.testMode ?? true,
      applies: notApplying === null,
      notApplying,
      carrier: { code: outcome.carrier.code, name: outcome.carrier.name, ruleKept: outcome.carrier.ruleKept, verified: outcome.carrier.verified, limits: { ...outcome.carrier.rule, maxBoxCm: outcome.carrier.rule.maxBoxCm ? [...outcome.carrier.rule.maxBoxCm] : null } },
      printable: problems.length === 0 && todo.length > 0,
      problems,
      parcels: parcels.map((parcel) => {
        const own = problems.filter((problem) => problem.parcelSeq === parcel.seq)
        return { parcelId: parcel.id, seq: parcel.seq, labelled: isLabelled(parcel), ok: own.length === 0, problems: own }
      }),
    }
  })
}
