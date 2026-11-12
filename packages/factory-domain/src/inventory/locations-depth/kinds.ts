import type { Issue } from '../../core/errors'
import { COUNT_ITEM_KINDS, type CountItemKind } from '../counts/rules'
import { LOCATION_KINDS, type LocationKind } from '../locations/rules'

/**
 * Location types in depth (B-W2b-289; SCM-177; design warehouse.locations), pure: what each kind of location is for and
 * what it may hold. Read by the locations' commands (create, retype, move in the tree, the import), by the default
 * locations (SCM-179: a default place must hold the kind of material it is the default for) and by every stock move
 * (apps/factory-api modules/inventory/ledger postMoves: a move INTO a place of a kind that does not hold the item's kind
 * is refused in words). The database holds the parts it can (…_warehouse_depth_w2b_guards): a SUBCONTRACTOR or CUSTOMER
 * place names its party, a TRANSIT place moves only with a transfer, a default is no outside or transit place.
 *
 *   group      STORE (racks, bins, zones: where stock is kept), DOCK (goods-in, the quality shelf, shipping), LINE (a
 *              line-side rack), OUTSIDE (our stock at a workshop's or a customer's), TRANSIT (between two sites)
 *   holds      ANY, MATERIALS (every kind of material and part; never a finished garment) or FINISHED (finished garments)
 *   party      the party's roles an outside place names (its workshop, its customer or brand); null: none
 *   transferOnly  only a transfer moves its stock (the database refuses every other move)
 *   purposes   what it may be the default place for (receiving, quality, issue, return, put-away)
 *   labelled   a place on the floor that carries a bin label and is scanned (an outside or transit place has none)
 *   blockable  may be blocked (an outside or transit place is not ours to block: its moves are its orders' own)
 *   atTop      sits at the top of the site's tree (no parent)
 *   container  other locations may sit inside it
 *   fixed      never turns into another kind, nor another kind into it (its party or its transfers depend on it)
 */

export const LOCATION_GROUPS = ['STORE', 'DOCK', 'LINE', 'OUTSIDE', 'TRANSIT'] as const
export type LocationGroup = (typeof LOCATION_GROUPS)[number]

export const LOCATION_HOLDS = ['ANY', 'MATERIALS', 'FINISHED'] as const
export type LocationHolds = (typeof LOCATION_HOLDS)[number]

/** What a default location is for (factory-db DefaultLocationPurpose). */
export const DEFAULT_PURPOSES = ['RECEIVING', 'QUALITY', 'ISSUE', 'RETURN', 'PUT_AWAY'] as const
export type DefaultPurpose = (typeof DEFAULT_PURPOSES)[number]

/** The kinds of item a place may hold: the materials' kinds and FINISHED (a finished garment). */
export const HELD_ITEM_KINDS = COUNT_ITEM_KINDS
export type HeldItemKind = CountItemKind

export interface LocationKindProfile {
  readonly kind: LocationKind
  readonly group: LocationGroup
  readonly holds: LocationHolds
  readonly party: readonly ('SUBCONTRACTOR' | 'CUSTOMER' | 'BRAND')[] | null
  readonly transferOnly: boolean
  readonly purposes: readonly DefaultPurpose[]
  readonly labelled: boolean
  readonly blockable: boolean
  readonly atTop: boolean
  readonly container: boolean
  readonly fixed: boolean
}

const STOREY: readonly DefaultPurpose[] = ['RECEIVING', 'ISSUE', 'RETURN', 'PUT_AWAY']

const profile = (kind: LocationKind, group: LocationGroup, holds: LocationHolds, purposes: readonly DefaultPurpose[], extra: Partial<LocationKindProfile> = {}): LocationKindProfile =>
  Object.freeze({ kind, group, holds, party: null, transferOnly: false, purposes, labelled: true, blockable: true, atTop: false, container: true, fixed: false, ...extra })

const OUTSIDE = { labelled: false, blockable: false, container: false, fixed: true } as const

/** Every kind's profile, in LOCATION_KINDS order. */
export const LOCATION_KIND_PROFILES: Readonly<Record<LocationKind, LocationKindProfile>> = Object.freeze({
  WAREHOUSE: profile('WAREHOUSE', 'STORE', 'ANY', STOREY),
  ZONE: profile('ZONE', 'STORE', 'ANY', STOREY),
  BIN: profile('BIN', 'STORE', 'ANY', STOREY),
  // The goods-in dock receives everything; the quality shelf holds what waits for a decision.
  RECEIVING: profile('RECEIVING', 'DOCK', 'ANY', ['RECEIVING']),
  QUARANTINE: profile('QUARANTINE', 'DOCK', 'ANY', ['QUALITY']),
  // A line-side rack: materials taken for work orders and what comes back from them.
  PRODUCTION: profile('PRODUCTION', 'LINE', 'MATERIALS', ['ISSUE', 'RETURN']),
  // The packing bench: garments and the cartons they leave in.
  SHIPPING: profile('SHIPPING', 'DOCK', 'ANY', []),
  SUBCONTRACTOR: profile('SUBCONTRACTOR', 'OUTSIDE', 'MATERIALS', [], { ...OUTSIDE, party: ['SUBCONTRACTOR'] }),
  // Finished garments: a production receipt puts them there; a customer's return comes back there.
  FINISHED_GOODS: profile('FINISHED_GOODS', 'STORE', 'FINISHED', ['RECEIVING', 'RETURN', 'PUT_AWAY']),
  // Our garments at a customer's (a fitting stock, consignment).
  CUSTOMER: profile('CUSTOMER', 'OUTSIDE', 'FINISHED', [], { ...OUTSIDE, party: ['CUSTOMER', 'BRAND'], atTop: true }),
  TRANSIT: profile('TRANSIT', 'TRANSIT', 'ANY', [], { ...OUTSIDE, transferOnly: true, atTop: true }),
  // The face a picker takes materials from, refilled from the bulk rack.
  PICK_FACE: profile('PICK_FACE', 'STORE', 'MATERIALS', ['ISSUE', 'PUT_AWAY'], { container: false }),
  BULK: profile('BULK', 'STORE', 'ANY', STOREY),
})

export const kindProfile = (kind: LocationKind): LocationKindProfile => LOCATION_KIND_PROFILES[kind]

/** True when a place of `kind` may hold an item of `itemKind`. */
export function mayHold(kind: LocationKind, itemKind: HeldItemKind): boolean {
  const holds = LOCATION_KIND_PROFILES[kind].holds
  return holds === 'ANY' || (holds === 'FINISHED') === (itemKind === 'FINISHED')
}

const HOLDS_WORDS: Readonly<Record<LocationHolds, string>> = Object.freeze({ ANY: 'any goods', MATERIALS: 'materials only', FINISHED: 'finished garments only' })
const KIND_WORDS: Readonly<Record<LocationKind, string>> = Object.freeze({
  WAREHOUSE: 'warehouse',
  ZONE: 'zone',
  BIN: 'bin',
  RECEIVING: 'goods-in dock',
  QUARANTINE: 'quarantine place',
  PRODUCTION: 'line-side place',
  SHIPPING: 'shipping place',
  SUBCONTRACTOR: "workshop's place",
  FINISHED_GOODS: 'finished-goods place',
  CUSTOMER: "customer's place",
  TRANSIT: 'transit place',
  PICK_FACE: 'pick face',
  BULK: 'bulk rack',
})

/** "a finished-goods place" in English (the API's words; the screens have their own). */
export const kindWords = (kind: LocationKind): string => KIND_WORDS[kind]
export const holdsWords = (holds: LocationHolds): string => HOLDS_WORDS[holds]

/** Why a move cannot put an item of `itemKind` into `place`, or null. */
export function holdRefusal(place: { readonly code: string; readonly kind: LocationKind }, itemKind: HeldItemKind, what: string): string | null {
  if (mayHold(place.kind, itemKind)) return null
  return `Location ${place.code} is a ${KIND_WORDS[place.kind]}: it holds ${HOLDS_WORDS[LOCATION_KIND_PROFILES[place.kind].holds]}, not ${what}.`
}

/**
 * The problems of a new location's kind and place in the tree (paths `kind`, `parentId`): a customer's or transit place
 * sits at the top of the site's tree; nothing sits inside an outside or transit place, nor inside a pick face.
 */
export function placementProblems(kind: LocationKind, parent: { readonly code: string; readonly kind: LocationKind } | null): Issue[] {
  const problems: Issue[] = []
  if (parent !== null && LOCATION_KIND_PROFILES[kind].atTop) problems.push({ path: 'parentId', message: `A ${KIND_WORDS[kind]} sits at the top of the site's tree: leave the parent empty.` })
  if (parent !== null && !LOCATION_KIND_PROFILES[parent.kind].container) problems.push({ path: 'parentId', message: `Nothing sits inside ${parent.code} (a ${KIND_WORDS[parent.kind]}).` })
  return problems
}

/**
 * The problems of a kind change (path `kind`): an outside or transit place stays what it is (its party, its transfers),
 * and no place turns into one; a place with locations inside it does not become one that holds none; a place inside
 * another does not become one that sits at the top.
 */
export function retypeProblems(from: LocationKind, to: LocationKind, facts: { readonly hasParent: boolean; readonly children: number }): Issue[] {
  if (from === to) return []
  const before = LOCATION_KIND_PROFILES[from]
  const after = LOCATION_KIND_PROFILES[to]
  if (before.fixed || after.fixed) {
    return [{ path: 'kind', message: `A ${KIND_WORDS[before.fixed ? from : to]} stays one (its party or its transfers depend on it): make a new location instead.` }]
  }
  if (!after.container && facts.children > 0) return [{ path: 'kind', message: `${facts.children} location(s) sit inside it; a ${KIND_WORDS[to]} holds none. Move them first.` }]
  if (after.atTop && facts.hasParent) return [{ path: 'kind', message: `A ${KIND_WORDS[to]} sits at the top of the site's tree; move it there first.` }]
  return []
}

/** The party an outside place names (a workshop's or a customer's), as the create and the import read it. */
export interface PlaceParty {
  readonly roles: readonly string[]
  readonly status: string
  readonly companyId: string | null
}

/**
 * The problems of a CUSTOMER place's party (path `partyId`): our stock at a customer's names that customer, a party with
 * the CUSTOMER or BRAND role, not archived, of the site's company or every company. The database checks the roles too.
 * (A SUBCONTRACTOR place's workshop: purchasing/subcontracting workshopLocationProblems.)
 */
export function customerPlaceProblems(partyId: string | null, party: PlaceParty | null, siteCompanyId: string): Issue[] {
  if (partyId === null) return [{ path: 'partyId', message: "A customer's place is our stock at one customer or brand: name it." }]
  if (!party) return [{ path: 'partyId', message: 'Not a customer or brand of this company.' }]
  if (!party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')) return [{ path: 'partyId', message: 'The party is no customer or brand: give it the CUSTOMER or BRAND role first.' }]
  if (party.status === 'ARCHIVED') return [{ path: 'partyId', message: 'The customer is archived.' }]
  if (party.companyId !== null && party.companyId !== siteCompanyId) return [{ path: 'partyId', message: 'The customer belongs to another company.' }]
  return []
}

/** Every kind's profile as the kinds route answers it, in LOCATION_KINDS order. */
export const kindProfiles = (): readonly LocationKindProfile[] => LOCATION_KINDS.map((kind) => LOCATION_KIND_PROFILES[kind])
