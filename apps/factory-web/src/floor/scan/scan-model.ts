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
 *   bundle, lot, batch, serial, carton                                                  named, "not on this tablet yet"
 *
 * A code that is no label code (an office number such as a work order's, a tag printed before label codes, a location
 * code) is looked up in that order by what it is: hide tag, work order number, location code. A badge's code switches
 * the person instead (floor.signin "Switch person on a busy station"). Pure: the screen asks, this decides.
 */

export const LABEL_TYPES = ['hide', 'bundle', 'lot', 'batch', 'serial', 'carton', 'location', 'workOrder'] as const
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
  /** Anything else: a tag, a number or a code as the office prints it. */
  | { readonly kind: 'free'; readonly code: string }

/** What a scanned or typed code is, before anything is asked. */
export function readScan(raw: string, scanTag: string | null): ScanRead {
  const code = raw.trim()
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
} as const
export type Lookup = keyof typeof LOOKUPS

export type ScanPlan =
  /** Ask these, in order; the first that finds it answers. `denied`: the lookups the person may not run. */
  | { readonly kind: 'ask'; readonly lookups: readonly Lookup[]; readonly denied: readonly Lookup[] }
  /** Known type, no floor route yet. */
  | { readonly kind: 'notOnFloor'; readonly type: LabelType }
  /** The person may not open this type here (fail closed). */
  | { readonly kind: 'noPermission'; readonly type: LabelType }
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
      const all: Lookup[] = ['hide', 'workOrder', 'location']
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

export type ScanResult =
  | HideCard
  | WorkOrderCard
  | LocationCard
  /** A label the floor names but cannot open yet. */
  | { readonly kind: 'notOnFloor'; readonly type: LabelType; readonly code: string }
  | { readonly kind: 'noPermission'; readonly type: LabelType; readonly code: string }
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

/** The label type a result stands for (the icon and the word in the recent list); null when nothing was found. */
export function resultType(result: ScanResult): LabelType | null {
  switch (result.kind) {
    case 'hide':
    case 'workOrder':
    case 'location':
      return result.kind
    case 'notOnFloor':
    case 'noPermission':
      return result.type
    default:
      return null
  }
}
