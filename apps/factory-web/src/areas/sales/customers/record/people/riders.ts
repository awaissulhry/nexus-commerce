import type { Contact, PartyKind } from '../../../../parties/_shared/api'
import type { ProfileRow } from '../../../mtm/api'
import { recordHref } from '../../../mtm/model'
import type { RiderParty, RidersView } from './api'
import { said, type PeopleCan, type Said } from './model'

/**
 * F-CA-202 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-w2 W2.1; 10-design §5.3; 18-lead-settles R-B10, R-B23) — Riders &
 * measurements, pure. BOTH kinds of rider, honestly:
 *   kept here   a rider measured on THIS customer — a contact with the role Rider, or only a name on its profiles (grouped by the
 *               profile's contact, else by the rider's name); each with its newest profile per garment (the MTM list's own read, with
 *               the measurements right only)
 *   own page    a rider who is a customer of its own (a person under this team: the riders read); its profiles are its own — counted
 *               there (null without the measurements right: never 0)
 *   self        a rider's own page (a person customer): its own profiles as ONE row, and its team on top
 * Without the measurements right no profile, review or size is drawn: the riders' names only, said once in the answer. Pure.
 */

export type RiderKind = 'here' | 'own' | 'self'

export interface RiderRow {
  /** `k-c:<contact id>` / `k-n:<name>` (kept here), `o-<party id>` (own page), `s-<party id>` (this customer itself). */
  readonly id: string
  readonly kind: RiderKind
  readonly name: string
  /** A rider kept here who is a contact of this customer. */
  readonly contact: Contact | null
  /** A rider with its own page. */
  readonly party: RiderParty | null
  /** Its newest profile per garment kept here (empty without the measurements right). */
  readonly profiles: readonly ProfileRow[]
}

export interface RidersInput {
  readonly kind: PartyKind
  readonly partyId: string
  readonly partyName: string
  readonly contacts: readonly Contact[]
  /** The profiles kept on THIS customer (null: not read — no right, reading, or failed). */
  readonly profiles: readonly ProfileRow[] | null
  /** The riders read (null: not read yet, or failed). */
  readonly riders: RidersView | null
}

const byName = (a: { readonly name: string }, b: { readonly name: string }): number => a.name.localeCompare(b.name)
const keyOf = (profile: ProfileRow): string => (profile.contactId ? `c:${profile.contactId}` : `n:${profile.riderName.trim().toLocaleLowerCase()}`)

/** Every rider of the customer, kept here first (by name), then those with their own page (by name). */
export function riderRows(input: RidersInput): RiderRow[] {
  const profiles = input.profiles ?? []
  if (input.kind === 'PERSON') return profiles.length > 0 ? [{ id: `s-${input.partyId}`, kind: 'self', name: input.partyName, contact: null, party: null, profiles }] : []
  const contactOf = new Map(input.contacts.map((contact) => [contact.id, contact]))
  const groups = new Map<string, ProfileRow[]>()
  for (const profile of profiles) groups.set(keyOf(profile), [...(groups.get(keyOf(profile)) ?? []), profile])
  const here: RiderRow[] = [...groups.entries()].map(([key, rows]) => {
    const contact = rows[0]!.contactId ? (contactOf.get(rows[0]!.contactId) ?? null) : null
    return { id: `k-${key}`, kind: 'here', name: contact && contact.name.trim() !== '' ? contact.name : rows[0]!.riderName.trim(), contact, party: null, profiles: [...rows].sort((a, b) => a.garmentType.localeCompare(b.garmentType)) }
  })
  // A contact with the role Rider and no profile yet is a rider too ("No measurements yet").
  for (const contact of input.contacts) {
    if (contact.status !== 'ACTIVE' || contact.name.trim() === '' || !contact.roles.includes('RIDER') || groups.has(`c:${contact.id}`)) continue
    here.push({ id: `k-c:${contact.id}`, kind: 'here', name: contact.name, contact, party: null, profiles: [] })
  }
  const own: RiderRow[] = (input.riders?.riders ?? []).map((party) => ({ id: `o-${party.id}`, kind: 'own', name: party.tradeName ?? party.legalName, contact: null, party, profiles: [] }))
  return [...here.sort(byName), ...own.sort(byName)]
}

/** The rows' profiles (the answer's counts). */
export const profilesOf = (rows: readonly RiderRow[]): ProfileRow[] => rows.flatMap((row) => row.profiles)

/** The earliest next fitting among the rows' profiles, with its rider. */
export function nextFittingOf(rows: readonly RiderRow[]): { readonly at: string; readonly rider: string } | null {
  let best: { at: string; rider: string } | null = null
  for (const row of rows) for (const profile of row.profiles) if (profile.nextFittingAt && (!best || profile.nextFittingAt < best.at)) best = { at: profile.nextFittingAt, rider: row.name }
  return best
}

export interface RidersFacts {
  readonly kind: PartyKind
  readonly rows: readonly RiderRow[]
  /** The reader sees measurement profiles. */
  readonly measurements: boolean
  /** How many profiles the MTM read matches for this customer (null: not read). */
  readonly matching: number | null
  /**
   * F-CA-fx4 (walk W-04, W-02): every rider read is in (the riders read, and the profiles read when the reader may make it). false: a
   * read failed — the riders are not counted and "No rider yet" is not said (a failed read is never a number, never "nobody").
   */
  readonly complete?: boolean
}

/** Riders & measurements' answer (10-design §5.3): the riders of both kinds, the profiles' review state, the next fitting; said once. */
export function ridersAnswer(facts: RidersFacts): Said[] {
  const organisation = facts.kind === 'ORGANISATION'
  const out: Said[] = []
  const complete = facts.complete ?? true
  if (complete && facts.rows.length === 0) return [said(organisation ? 'riders.answer.none' : 'riders.answer.noneSelf')]
  if (organisation && complete) {
    const own = facts.rows.filter((row) => row.kind === 'own').length
    out.push(own > 0 ? said('riders.answer.ridersBoth', { words: { riders: said('answer.riders', { params: { count: facts.rows.length } }) }, params: { here: facts.rows.length - own, own } }) : said('answer.riders', { params: { count: facts.rows.length } }))
  }
  const profiles = profilesOf(facts.rows)
  if (facts.measurements && profiles.length > 0) {
    const waiting = profiles.filter((profile) => profile.review.status === 'WAITING').length
    const more = profiles.filter((profile) => profile.review.status === 'NEED_MORE').length
    const old = profiles.filter((profile) => profile.old).length
    const states = [waiting > 0 ? said('riders.answer.waiting', { params: { count: waiting } }) : null, more > 0 ? said('riders.answer.needMore', { params: { count: more } }) : null, old > 0 ? said('riders.answer.old', { params: { count: old } }) : null].filter((part): part is Said => part !== null)
    out.push(states.length > 0 ? said('riders.answer.profilesWith', { params: { count: profiles.length }, words: { states: joinSaid(states) } }) : said('riders.answer.profiles', { params: { count: profiles.length } }))
    const next = nextFittingOf(facts.rows)
    if (next) out.push(organisation ? said('riders.answer.nextFitting', { days: { date: next.at }, params: { rider: next.rider } }) : said('riders.answer.nextFittingSelf', { days: { date: next.at } }))
  }
  if (!facts.measurements) out.push(said('riders.answer.hidden'))
  return out
}

/** Several words joined by commas ("1 waiting for review, 1 need more"): the first said, each next one after ", ". */
function joinSaid(parts: readonly Said[]): Said {
  return parts.slice(1).reduce<Said>((joined, part) => said('riders.answer.and', { words: { a: joined, b: part } }), parts[0]!)
}

// ---- the rider's ⋯ and the section's head --------------------------------------------------------------------------------------

export type RiderAct = 'newFor' | 'link' | 'editContact' | 'team' | 'copyLink'

export interface RiderItem {
  readonly id: string
  readonly label: Said
  readonly act?: RiderAct
  /** The profile an act is about (Send a measurement link…). */
  readonly profile?: ProfileRow
  readonly href?: string
  readonly held?: Said
  readonly separator?: true
}

export interface RiderMenuContext {
  readonly can: PeopleCan
  readonly prefix: string
  /** The customer's status: New measurements need an ACTIVE customer (the picker lists ACTIVE ones only). */
  readonly status: string
}

const sep = (id: string): RiderItem => ({ id, label: said(''), separator: true })
const enc = encodeURIComponent

/** Why New measurements is held by state (null: it may open). */
export const newMeasurementsHeld = (status: string): Said | null => (status === 'ACTIVE' ? null : said('riders.held.notActive'))

/** Why Send a measurement link is held by state: a link needs a profile first (P10). */
export const linkHeldOf = (profiles: readonly ProfileRow[]): Said | null => (profiles.length > 0 ? null : said('riders.held.noProfile'))

/** The acts of one rider's ⋯ (each with its own right; held only by state); a garment named when the rider has several profiles. */
export function riderMenu(row: RiderRow, context: RiderMenuContext): RiderItem[] {
  const { can, prefix } = context
  const groups: RiderItem[][] = []
  if (row.kind === 'own' && row.party) {
    groups.push([{ id: 'open', label: said('riders.row.open', { params: { name: row.name } }), href: `${prefix}/sales/customers/${enc(row.party.id)}?tab=people#riders` }, ...(can.ordersView ? [{ id: 'orders', label: said('riders.row.orders', { params: { name: row.name } }), href: `${prefix}/sales/orders?party=${enc(row.party.id)}` }] : [])])
    if (can.manage) groups.push([{ id: 'team', label: said('riders.row.team'), act: 'team' }])
  } else {
    // One profile: the catalogue's own word (Made-to-measure's); several: the garment named ("Send a measurement link · JACKET…").
    const many = row.profiles.length > 1
    const named = (single: string, several: string, profile: ProfileRow, params: Record<string, string> = {}): Said => (many ? said(several, { params: { ...params, garment: profile.garmentType } }) : said(single, { params }))
    const measure: RiderItem[] = []
    if (can.measurements && can.mtmRecord && row.kind === 'here') {
      const held = newMeasurementsHeld(context.status)
      measure.push({ id: 'newFor', label: said('riders.row.newFor', { params: { name: row.name } }), act: 'newFor', ...(held ? { held } : {}) })
    }
    if (can.measurements)
      for (const profile of row.profiles) {
        if (can.mtmLink) measure.push({ id: `link-${profile.id}`, label: named('sales-mtm:list.sendLink', 'riders.row.linkOf', profile), act: 'link', profile })
        if (can.mtmReview) measure.push({ id: `review-${profile.id}`, label: named('sales-mtm:band.review', 'riders.row.reviewOf', profile), href: recordHref(prefix, profile.id, null, 'review') })
        if (can.fittings) measure.push({ id: `fitting-${profile.id}`, label: named('sales-mtm:band.fitting', 'riders.row.fittingOf', profile), href: recordHref(prefix, profile.id, null, 'fitting') })
        if (can.ordersView) measure.push({ id: `orders-${profile.id}`, label: named('riders.row.orders', 'riders.row.ordersOf', profile, { name: row.name }), href: `${prefix}/sales/orders?profile=${enc(profile.id)}` })
      }
    groups.push(measure)
    if (row.contact && can.manage) groups.push([{ id: 'editContact', label: said('riders.row.editContact'), act: 'editContact' }])
  }
  groups.push([{ id: 'copyLink', label: said('row.copyLink'), act: 'copyLink' }])
  const items: RiderItem[] = []
  groups
    .filter((group) => group.length > 0)
    .forEach((group, index) => {
      if (index > 0) items.push(sep(`sep-${index}`))
      items.push(...group)
    })
  return items
}

/** A rider row's own address (a link to it, the scroll that marks it). */
export const riderAnchor = (rowId: string): string => `rider-${rowId.replace(/[^A-Za-z0-9_-]/g, '_')}`
