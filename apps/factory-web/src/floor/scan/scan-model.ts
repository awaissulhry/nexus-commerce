import { parseScanId, type ScanType } from '@nexus/factory-domain/numbering/scan-id'
import { isBadgeCode } from '../model'

/**
 * Scan anything (SCR-024; PLT-126, PLT-155, PLT-243; design floor.scan): one field for every label of the factory. A
 * code's prefix says its type (factory-domain numbering/scan-id: `HD-7K-0003RJ-M`); its tenant tag says whether it is
 * this factory's. What the floor can open today, with the permission its route needs:
 *
 *   hide         GET /production/cutting/hides?code=          production.cut          the hide card
 *   work order   GET /production/cutting/work-orders?number=  production.cut          the work order card
 *   location     GET /inventory/locations?siteId=             inventory.locations.view the location card (by its code)
 *   machine      GET /plant/floor/machines?code=               plant.report            the machine card (B-W2a-73: its QR
 *                                                                                      tag holds the asset number)
 *   bundle, lot, batch, serial, carton                                                  named, "not on this tablet yet"
 *   cut ticket   (B-W2b-112's number: Fabric cutting opens it at the cutting table)      named, where it is used
 *
 * A code that is no label code (an office number such as a work order's, a tag printed before label codes, a location
 * code, a machine's asset number) is looked up in that order by what it is: hide tag, work order number, location code,
 * machine tag. A badge's code switches
 * the person instead (floor.signin "Switch person on a busy station"). Pure: the screen asks, this decides.
 */

export const LABEL_TYPES = ['hide', 'bundle', 'lot', 'batch', 'serial', 'carton', 'location', 'workOrder', 'roll', 'remnant'] as const
export type LabelType = (typeof LABEL_TYPES)[number]

const TYPE_OF: Readonly<Record<ScanType, LabelType>> = {
  HIDE: 'hide',
  BUNDLE: 'bundle',
  LOT: 'lot',
  BATCH: 'batch',
  SERIAL: 'serial',
  CARTON: 'carton',
  LOCATION: 'location',
  WORK_ORDER: 'workOrder',
  // A coupon is a bundle's, for one operation (CP-…).
  COUPON: 'bundle',
  // W2b-2 (wave 12/16): a fabric roll's tag (RL-…) and a remnant's (RM-…).
  ROLL: 'roll',
  REMNANT: 'remnant',
}

export type ScanRead =
  /** A label code of this factory. */
  | { readonly kind: 'label'; readonly type: LabelType; readonly code: string }
  /** A label code of another factory (its tenant tag). */
  | { readonly kind: 'otherFactory'; readonly code: string }
  /** A label code with a wrong check symbol: misread or mistyped. */
  | { readonly kind: 'typo'; readonly code: string }
  /** A worker's badge. */
  | { readonly kind: 'badge'; readonly code: string }
  /**
   * Anything else: a tag, a number or a code as the office prints it. `cutTicket`: a cut ticket's number (B-W2b-112), which
   * only Fabric cutting opens; every other screen takes it as the free code it is.
   */
  | { readonly kind: 'free'; readonly code: string; readonly cutTicket?: true }

/**
 * A cut ticket's number (B-W2b-112: the CUT_TICKET series, whose number is the ticket's scan code): `CT-2026-00001` (the
 * kind's default pattern) or `CTA-2026-00001` (a company's own prefix, as the seed's). It starts with CT, the carton label's
 * type code, so it is read BEFORE the label rule, by its own shape — CT and up to four more capitals or digits, the year,
 * the counter — which no label code has (`CT-<tag>-<reference>-<check>`, four parts). A ticket series set up with a pattern
 * of another shape is not recognised (it reads as before).
 */
const CUT_TICKET_NUMBER = /^CT[A-Z0-9]{0,4}-2\d{3}-\d{1,10}$/

/** Is this code a cut ticket's number (any case, spaces around it dropped)? */
export const isCutTicketNumber = (raw: string): boolean => CUT_TICKET_NUMBER.test(raw.trim().toUpperCase())

/** What a scanned or typed code is, before anything is asked. */
export function readScan(raw: string, scanTag: string | null): ScanRead {
  const code = raw.trim()
  // B-W2b-F16: a cut ticket's number shares the carton label's CT: read it first, or it reads as a misread carton.
  if (isCutTicketNumber(code)) return { kind: 'free', code: code.toUpperCase(), cutTicket: true }
  const parsed = parseScanId(code, scanTag ? { tenantTag: scanTag } : {})
  if (parsed.ok) return { kind: 'label', type: TYPE_OF[parsed.type], code: parsed.text }
  if (parsed.problem === 'tenant') return { kind: 'otherFactory', code: code.toUpperCase() }
  if (parsed.problem === 'check') return { kind: 'typo', code: code.toUpperCase() }
  if (isBadgeCode(code)) return { kind: 'badge', code }
  return { kind: 'free', code }
}

/** The lookups the floor has, each with the permission its route needs. */
export const LOOKUPS = {
  hide: 'production.cut',
  workOrder: 'production.cut',
  location: 'inventory.locations.view',
  machine: 'plant.report',
} as const
export type Lookup = keyof typeof LOOKUPS

export type ScanPlan =
  /** Ask these, in order; the first that finds it answers. `denied`: the lookups the person may not run. */
  | { readonly kind: 'ask'; readonly lookups: readonly Lookup[]; readonly denied: readonly Lookup[] }
  /** Known type, no floor route yet. */
  | { readonly kind: 'notOnFloor'; readonly type: LabelType }
  /** The person may not open this type here (fail closed). */
  | { readonly kind: 'noPermission'; readonly type: LabelType }
  /** A cut ticket's number: no lookup here; the card says where it is used (Fabric cutting, at the cutting table). */
  | { readonly kind: 'cutTicket' }
  | { readonly kind: 'unknown'; readonly reason: 'otherFactory' | 'typo' }
  | { readonly kind: 'badge' }

/** What to ask for a read code, given the person's permissions. */
export function planScan(read: ScanRead, permissions: readonly string[]): ScanPlan {
  const held = new Set(permissions)
  const may = (lookup: Lookup) => held.has(LOOKUPS[lookup])
  switch (read.kind) {
    case 'otherFactory':
    case 'typo':
      return { kind: 'unknown', reason: read.kind }
    case 'badge':
      return { kind: 'badge' }
    case 'label': {
      if (read.type === 'hide' || read.type === 'workOrder' || read.type === 'location') {
        return may(read.type) ? { kind: 'ask', lookups: [read.type], denied: [] } : { kind: 'noPermission', type: read.type }
      }
      return { kind: 'notOnFloor', type: read.type }
    }
    case 'free': {
      if (read.cutTicket) return { kind: 'cutTicket' }
      const all: Lookup[] = ['hide', 'workOrder', 'location', 'machine']
      return { kind: 'ask', lookups: all.filter(may), denied: all.filter((lookup) => !may(lookup)) }
    }
  }
}

// ---- the result card (design floor.scan "result-card": the facts a floor person needs, big, no money) ----

export interface HideCard {
  readonly kind: 'hide'
  readonly code: string
  readonly item: string
  readonly colour: string | null
  /** As measured, with its unit (`52.3 ft²`): the API's decimal string. */
  readonly area: string
  readonly areaUom: string
  readonly grade: string | null
  readonly thicknessMm: string | null
  readonly shade: string | null
  readonly state: string
  readonly lot: { readonly code: string; readonly qualityStatus: string; readonly crViStatus: string; readonly usable: boolean; readonly words: string | null }
  /** Where it is, with how much (base unit). */
  readonly onHand: readonly { readonly location: string; readonly quantity: string }[]
  /** Work orders it can be cut for here. */
  readonly workOrders: readonly string[]
}

export interface WorkOrderCard {
  readonly kind: 'workOrder'
  readonly number: string
  readonly batchNumber: string | null
  readonly status: string
  readonly style: string
  readonly dueDate: string | null
  readonly pieces: number
  readonly toCut: number
  readonly sizesLeft: readonly string[]
  readonly colourways: readonly string[]
}

export interface LocationCard {
  readonly kind: 'location'
  readonly code: string
  readonly name: string
  readonly locationKind: string
  readonly path: readonly string[]
}

/** A machine's card (B-W2a-73; design floor.scan "Machine (W2a): status and open job"): never a cost, a supplier or a name. */
export interface MachineCard {
  readonly kind: 'machine'
  readonly id: string
  readonly code: string
  /** Its class in both languages (the card speaks the screen's). */
  readonly type: { readonly labelIt: string; readonly labelEn: string; readonly icon: string | null }
  readonly makeModel: string | null
  readonly station: string | null
  readonly line: string | null
  readonly status: 'RUNNING' | 'DOWN' | 'UNDER_MAINTENANCE' | 'DO_NOT_USE' | 'RETIRED'
  readonly statusSince: string
  /** An unsafe report waits for a technician's sign-safe (Owner answer H1). */
  readonly locked: boolean
  readonly openJob: { readonly number: string; readonly status: string } | null
  readonly openRequests: number
}

export type ScanResult =
  | HideCard
  | WorkOrderCard
  | LocationCard
  | MachineCard
  /** A label the floor names but cannot open yet. */
  | { readonly kind: 'notOnFloor'; readonly type: LabelType; readonly code: string }
  | { readonly kind: 'noPermission'; readonly type: LabelType; readonly code: string }
  /** A cut ticket scanned away from Fabric cutting: what it is and where it is used. */
  | { readonly kind: 'cutTicket'; readonly code: string }
  /** Nothing of this factory answers to it (`badge`: a badge that does not open this tablet; its code is not shown). */
  | { readonly kind: 'unknown'; readonly code: string; readonly reason: 'otherFactory' | 'typo' | 'notFound' | 'badge' }
  /** The server did not answer. */
  | { readonly kind: 'unavailable'; readonly code: string }

/** A card's code, for the recent scans. */
export function resultCode(result: ScanResult): string {
  switch (result.kind) {
    case 'workOrder':
      return result.number
    default:
      return result.code
  }
}

/** What a card is: a label type, a machine (its tag is a free code, no label type) or a cut ticket (an office number). */
export type CardType = LabelType | 'machine' | 'cutTicket'

/** The type a result stands for (the icon and the word in the recent list); null when nothing was found. */
export function resultType(result: ScanResult): CardType | null {
  switch (result.kind) {
    case 'hide':
    case 'workOrder':
    case 'location':
    case 'machine':
    case 'cutTicket':
      return result.kind
    case 'notOnFloor':
    case 'noPermission':
      return result.type
    default:
      return null
  }
}
