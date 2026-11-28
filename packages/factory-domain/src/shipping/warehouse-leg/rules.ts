import type { DdtReason } from '../../documents/model'
import type { OrderWarningKind } from '../../sales/warnings/kinds'
import type { ShipmentStatus } from '../shipments'

/**
 * Our warehouse first (owb- order workflow, S3 ss1; plan.md § 5 A, design plan § 5n + § 7 "three ways"; settles L2, L4, L5). A
 * shipment may go to one of OUR warehouses first (factory-db ShipmentWarehouseLeg, one per shipment, made with the DRAFT): it
 * travels there with a transfer DDT (TRANSFER: the goods stay ours), "It arrived at the warehouse" (while SHIPPED, once), the
 * customer may send its own shipping label (the portal, or the office for it), then "Send on to the customer" (once, after it
 * arrived): with the sale DDT to the customer's address, or as the shipment travels without a DDT; without the label is allowed
 * and logged as a warning. The shipment is DELIVERED only after Send on (the database's G9 trigger says it too). Pure: the API
 * (apps/factory-api modules/shipping/warehouse-leg) reads the facts under the shipment's lock and refuses in these words.
 *
 * Refusals are `refusal/<CODE>` (409) with words in English and Italian; the web shows its own words by the code.
 */

/** Where the goods of a leg are (the legs read): not arrived yet · at our warehouse · sent on to the customer. */
export const LEG_STATES = ['ON_THE_WAY', 'AT_OUR_WAREHOUSE', 'SENT_ON'] as const
export type LegState = (typeof LEG_STATES)[number]

/** The leg's state: SENT_ON once sent on, AT_OUR_WAREHOUSE once it arrived, else ON_THE_WAY (the shipment's status says whether it left). */
export function legStateOf(leg: { readonly arrivedAt: Date | null; readonly forwardedAt: Date | null }): LegState {
  if (leg.forwardedAt !== null) return 'SENT_ON'
  if (leg.arrivedAt !== null) return 'AT_OUR_WAREHOUSE'
  return 'ON_THE_WAY'
}

export const LEG_REFUSALS = [
  // planning (POST /shipping/shipments with destination OUR_WAREHOUSE, PATCH …/:id)
  'NOT_OUR_WAREHOUSE',
  'WAREHOUSE_NO_ADDRESS',
  'SAME_SITE',
  'ADDRESS_WITH_WAREHOUSE',
  'NO_CUSTOMER_ADDRESS',
  'LEG_ADDRESS',
  // the acts (arrived, forward, customer-label, the portal's label)
  'NO_LEG',
  'CANCELLED',
  'NOT_LEFT',
  'ARRIVED_ALREADY',
  'NOT_ARRIVED',
  'SENT_ON_ALREADY',
  'NO_SALE_DDT',
  'LABEL_FILE',
  'LABEL_AFTER_SEND_ON',
  // delivered by hand or by a carrier's tracking before Send on
  'DELIVERED_BEFORE_SEND_ON',
] as const
export type LegRefusalCode = (typeof LEG_REFUSALS)[number]

/** The issue path of a refusal (the web finds its words by the code). */
export const legRefusalPath = (code: LegRefusalCode): string => `refusal/${code}`

/** The words of each refusal, English and Italian (the portal's Italian is the same: these speak of the goods, not to "you"). */
export const LEG_WORDS: Readonly<Record<LegRefusalCode, { readonly en: string; readonly it: string }>> = Object.freeze({
  NOT_OUR_WAREHOUSE: {
    en: "Not one of our warehouses: pick an active warehouse site of the order's company.",
    it: "Non è uno dei nostri magazzini: scegli un magazzino attivo dell'azienda dell'ordine.",
  },
  WAREHOUSE_NO_ADDRESS: {
    en: 'Our warehouse has no complete address (street, postal code, city, country): an administrator adds it to the site first.',
    it: 'Il nostro magazzino non ha un indirizzo completo (via, CAP, città, paese): un amministratore lo aggiunge prima al sito.',
  },
  SAME_SITE: {
    en: 'The goods leave from that warehouse already: send them to the customer.',
    it: 'La merce parte già da quel magazzino: spediscila al cliente.',
  },
  ADDRESS_WITH_WAREHOUSE: {
    en: "A shipment to our warehouse goes to the warehouse's address: leave the delivery address out.",
    it: "Una spedizione al nostro magazzino va all'indirizzo del magazzino: lascia vuoto l'indirizzo di consegna.",
  },
  NO_CUSTOMER_ADDRESS: {
    en: "The order has no complete delivery address of the customer to send the goods on to: add it on the order first.",
    it: "L'ordine non ha un indirizzo di consegna completo del cliente a cui inoltrare la merce: aggiungilo prima sull'ordine.",
  },
  LEG_ADDRESS: {
    en: "This shipment goes to our warehouse first: its address is the warehouse's. Send it on from there, or cancel it and plan it again.",
    it: "Questa spedizione passa prima dal nostro magazzino: il suo indirizzo è quello del magazzino. Inoltrala da lì, oppure annullala e pianificala di nuovo.",
  },
  NO_LEG: {
    en: 'This shipment does not go through our warehouse.',
    it: 'Questa spedizione non passa dal nostro magazzino.',
  },
  CANCELLED: {
    en: 'The shipment is cancelled.',
    it: 'La spedizione è annullata.',
  },
  NOT_LEFT: {
    en: 'The goods have not left yet: they arrive at our warehouse only after they left (shipped).',
    it: 'La merce non è ancora partita: arriva al nostro magazzino solo dopo la spedizione.',
  },
  ARRIVED_ALREADY: {
    en: 'It arrived at our warehouse already.',
    it: 'È già arrivata al nostro magazzino.',
  },
  NOT_ARRIVED: {
    en: 'It has not arrived at our warehouse yet: say it arrived first.',
    it: "Non è ancora arrivata al nostro magazzino: segnala prima l'arrivo.",
  },
  SENT_ON_ALREADY: {
    en: 'It was sent on to the customer already.',
    it: 'È già stata inoltrata al cliente.',
  },
  NO_SALE_DDT: {
    en: 'Issue the sale DDT to the customer first: the goods travel on with it.',
    it: 'Emetti prima il DDT di vendita al cliente: la merce prosegue con quello.',
  },
  LABEL_FILE: {
    en: 'Not a label of this shipment: upload the label onto the shipment (a PDF or a picture), then send it.',
    it: "Non è un'etichetta di questa spedizione: carica l'etichetta sulla spedizione (un PDF o un'immagine), poi inviala.",
  },
  LABEL_AFTER_SEND_ON: {
    en: 'The goods were sent on already: the label no longer changes.',
    it: "La merce è già stata inoltrata: l'etichetta non cambia più.",
  },
  DELIVERED_BEFORE_SEND_ON: {
    en: 'This shipment goes through our warehouse: it is delivered only after the warehouse sent it on.',
    it: "Questa spedizione passa dal nostro magazzino: è consegnata solo dopo che il magazzino l'ha inoltrata.",
  },
})

/** The warning Send on logs when the customer's label has not come (allowed: the audit row says it; design `sendOn`). */
export const NO_LABEL_WARNING = Object.freeze({ code: 'NO_CUSTOMER_LABEL', en: 'No label from the customer yet', it: 'Nessuna etichetta dal cliente' })

/** A file named as the customer's label, as the API read it. */
export interface LabelFileFacts {
  readonly recordType: string
  readonly recordId: string
  readonly status: string
  readonly kind: string
  readonly contentType: string
  readonly category: string | null
  /** The party the file is shared with (null: the office's only). */
  readonly partyId: string | null
  /** An office person uploaded it (StoredFile.createdById set); the portal's uploads are written by the tenant's system. */
  readonly byOffice: boolean
}

/** The kinds a label may be (a PDF or a picture). */
export const LABEL_KINDS: readonly string[] = Object.freeze(['DOCUMENT', 'ATTACHMENT', 'PHOTO'])

export type LegAct = 'ARRIVED' | 'FORWARD' | 'LABEL'

/** What the acts read of the shipment and its leg, under the shipment's lock. */
export interface LegFacts {
  readonly shipmentStatus: ShipmentStatus
  readonly arrived: boolean
  readonly forwarded: boolean
  /** FORWARD: the shipment travels with a DDT (Shipment.ddtRequired). */
  readonly ddtRequired?: boolean
  /** FORWARD: the reason of the shipment's newest live DDT (null: none live). */
  readonly liveDdtReason?: DdtReason | null
  /** LABEL: the file named (null: not found in the reader's scope). */
  readonly label?: LabelFileFacts | null
  /** LABEL: the shipment and its customer the file must belong to, and who sends it (the portal: the customer's own upload only). */
  readonly target?: { readonly shipmentId: string; readonly partyId: string; readonly door: 'office' | 'portal' }
}

/** Is this file a label of the shipment the door may name? (pure part of LABEL) */
export function labelFileFits(file: LabelFileFacts | null | undefined, target: NonNullable<LegFacts['target']>): boolean {
  if (!file) return false
  if (file.recordType !== 'Shipment' || file.recordId !== target.shipmentId || file.status !== 'AVAILABLE') return false
  if (!LABEL_KINDS.includes(file.kind)) return false
  if (file.contentType !== 'application/pdf' && !file.contentType.startsWith('image/')) return false
  if (file.category !== null && file.category !== 'CUSTOMER_LABEL') return false
  // The brand wall: a file shared outside is shared with this shipment's customer only.
  if (file.partyId !== null && file.partyId !== target.partyId) return false
  // The portal names only the customer's own upload (shared with its party, not made by an office person).
  if (target.door === 'portal' && (file.byOffice || file.partyId !== target.partyId)) return false
  return true
}

/**
 * Why the act cannot be done now (empty: it can), the first refusal first. ARRIVED: only while SHIPPED, once. FORWARD: only after
 * it arrived, once, with a live sale DDT unless the shipment travels without one. LABEL: a label file of the shipment (and, from
 * the portal, the customer's own upload), until it was sent on, never on a cancelled shipment.
 */
export function legProblems(act: LegAct, facts: LegFacts): LegRefusalCode[] {
  if (facts.shipmentStatus === 'CANCELLED') return ['CANCELLED']
  switch (act) {
    case 'ARRIVED':
      if (facts.arrived) return ['ARRIVED_ALREADY']
      if (facts.shipmentStatus !== 'SHIPPED') return ['NOT_LEFT']
      return []
    case 'FORWARD':
      if (facts.forwarded) return ['SENT_ON_ALREADY']
      if (!facts.arrived) return ['NOT_ARRIVED']
      if (facts.ddtRequired !== false && facts.liveDdtReason !== 'SALE') return ['NO_SALE_DDT']
      return []
    case 'LABEL':
      if (facts.forwarded) return ['LABEL_AFTER_SEND_ON']
      if (!facts.target || !labelFileFits(facts.label, facts.target)) return ['LABEL_FILE']
      return []
  }
}

/** What the reader may do on a leg now (the legs read's `may`): arrived and Send on with shipping.manage; the label with plan OR manage. */
export function legMayOf(facts: Pick<LegFacts, 'shipmentStatus' | 'arrived' | 'forwarded'>, rights: { readonly manage: boolean; readonly plan: boolean }): { arrived: boolean; sendOn: boolean; label: boolean } {
  const open = facts.shipmentStatus !== 'CANCELLED'
  return {
    arrived: rights.manage && open && facts.shipmentStatus === 'SHIPPED' && !facts.arrived,
    sendOn: rights.manage && open && facts.arrived && !facts.forwarded,
    label: (rights.plan || rights.manage) && open && !facts.forwarded,
  }
}

/**
 * The warnings when goods leave (settle L2, R39 (a): a payment due is a warning, not a hold): an OPEN before-shipping payment step
 * of any order on the shipment → PAYMENT_DUE_AT_SHIP, but only when the goods leave TO THE CUSTOMER — a shipment going to our own
 * warehouse first leaves without it (the goods stay ours); its Send on asks it.
 */
export function leavingWarnings(facts: { readonly openBeforeShipping: number; readonly toOurWarehouse: boolean }): OrderWarningKind[] {
  if (facts.toOurWarehouse || facts.openBeforeShipping <= 0) return []
  return ['PAYMENT_DUE_AT_SHIP']
}

/** The snapshot of a warehouse site's address as a shipment's ship-to (SalesOrder.shipTo's shape), or null when it is not complete. */
export function warehouseShipTo(site: { readonly name: string; readonly address: unknown }): Record<string, string> | null {
  if (site.address === null || typeof site.address !== 'object') return null
  const address = site.address as Record<string, unknown>
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  const line1 = text(address.line1)
  const postalCode = text(address.postalCode)
  const city = text(address.city)
  const country = text(address.country)
  if (!line1 || !postalCode || !city || !country) return null
  const line2 = text(address.line2)
  const province = text(address.province)
  return { name: site.name, line1, ...(line2 ? { line2 } : {}), postalCode, city, ...(province ? { province } : {}), country }
}
