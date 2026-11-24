import { mailsOfContacts } from '@nexus/factory-domain/parties/contact-mails'
import type { Party } from '../../../../parties/_shared/api'
import type { PortalAccess } from '../../../../admin/users/partners/api'
import { inviteHeld, type RowAction } from '../../../../admin/users/partners/model'
import type { PortalAccessModel } from '../../portal/model'
import type { Privacy } from '../../depth/api'
import type { ProfilesView } from '../../../mtm/api' // F-CA-203
import type { Read as DepthRead } from '../../depth/model'
import type { PartyUsage, RidersView } from './api'
import { addressFilterOf, addressesSectionAnswer, peopleAnswer, peopleSectionAnswer, personFilterOf, type PeopleAnswer, type PeopleChip, type PeopleFacts } from './answer'
import { addressRows, archivedCount, shownAddresses, type AddressAct, type AddressMenuContext, type AddressRow } from './addresses'
import { ADDRESS_ROWS, kitProblemOf, PEOPLE_ROWS, RIDER_ROWS, said, valueOf, type PeopleCan, type Read, type Said } from './model'
import { hiddenCounts, peopleRows, shownPeople, tickable, type PersonAct, type PersonMenuContext, type PersonRow } from './people'
import { linkHeldOf, newMeasurementsHeld, profilesOf, riderRows, ridersAnswer, type RiderAct, type RiderMenuContext, type RiderRow } from './riders' // F-CA-203

/**
 * F-CA-106 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 13-backend §5.1) — the tab's ONE model, pure: the reads the container holds
 * (the party, the portal of THIS customer, its contacts' personal data, the usage read, the production approver, the riders) and the
 * tab's own state (the chip pressed, the toggles, the ticks, the windows) become what the view draws. The container builds it on the
 * page; a design case builds it from made-up reads — one rule for both.
 */

export interface PeopleTabState {
  readonly filter: PeopleChip | null
  readonly showArchivedContacts: boolean
  readonly showArchivedAddresses: boolean
  /** "Tick portal people to act on many…" is on (a tick on each portal row, the bulk bar). */
  readonly ticking: boolean
  readonly morePeople: boolean
  readonly moreAddresses: boolean
  readonly moreRiders: boolean // F-CA-203
  /** The address being approved (one click), else null. */
  readonly approving: string | null
  /** The Refuse… window (null: closed). */
  readonly refuse: RefuseDialog | null
}

export const PEOPLE_TAB_START: PeopleTabState = { filter: null, showArchivedContacts: false, showArchivedAddresses: false, ticking: false, morePeople: false, moreAddresses: false, moreRiders: false, approving: null, refuse: null }

/** The Refuse the delivery address window: the reason the customer reads (3–500 characters). */
export interface RefuseDialog {
  readonly addressId: string
  readonly reason: string
  readonly tried: boolean
  readonly busy: boolean
  /** The refusal failed (a `parties` problem key), else null. */
  readonly problem: string | null
}

export interface PeopleTabReads {
  readonly party: Party
  readonly prefix: string
  readonly can: PeopleCan
  /** ISO now (the ends of access, the refused addresses in view). */
  readonly now: string
  /** The portal container's model (People's part); null: the reader has no portal right. */
  readonly portal: PortalAccessModel | null
  /** The contacts' personal data (the depth provider's read on People); null: not handed. */
  readonly privacy: DepthRead<Privacy> | null
  /** The usage read (D3); null: not made. While it reads or when it failed, the usage lines are left out. */
  readonly usage: Read<PartyUsage> | null
  /** The portal user who approves production (the limits read; null: anyone, not read or failed). */
  readonly approverId: string | null
  // F-CA-203 (ca-w2 W2.1): Riders & measurements' two reads (the glance is no longer read on People).
  /** The profiles kept on THIS customer (the MTM list's read; null: not made — no measurements right). */
  readonly profiles: Read<ProfilesView> | null
  /** The riders of THIS customer, or its team (null: not made). */
  readonly riders: Read<RidersView> | null
}

/** F-CA-203: Riders & measurements (#riders), as the view draws it. */
export interface RidersSectionModel {
  readonly kind: Party['kind']
  readonly answer: readonly Said[]
  readonly all: readonly RiderRow[]
  readonly rows: readonly RiderRow[]
  readonly more: boolean
  /** The reader sees measurement profiles (else the riders' names only, said once). */
  readonly measurements: boolean
  /** The first reads are still out (the section's skeleton). */
  readonly reading: boolean
  /** The profiles read failed (a kit key), else null: the riders' names still draw. */
  readonly profilesProblem: string | null
  /** The riders read failed (a kit key), else null. */
  readonly ridersProblem: string | null
  /** How many profiles Made-to-measure holds for this customer (the read is a page of them); null: not read. */
  readonly matching: number | null
  /** A rider's own page: its team (a customer the reader may see). */
  readonly team: { readonly id: string; readonly code: string; readonly name: string } | null
  /** The head's acts, each with its own right; held only by state. */
  readonly head: { readonly newShown: boolean; readonly newHeld: Said | null; readonly linkShown: boolean; readonly linkHeld: Said | null; readonly addRider: boolean; readonly changeTeam: boolean; readonly held: Said | null }
  readonly menu: RiderMenuContext
}

export interface PeopleSectionModel {
  readonly answer: readonly Said[]
  /** Every person of the customer (the answer line's facts). */
  readonly all: readonly PersonRow[]
  /** The rows drawn (after the chip, the toggles and the "Show more" cap). */
  readonly rows: readonly PersonRow[]
  /** How many rows the list holds before the cap (the "Show N more people" door). */
  readonly listed: number
  /** How many rows "Show all" brings back (the list without the chip). */
  readonly unfiltered: number
  readonly hidden: { readonly archived: number; readonly left: number }
  readonly showArchived: boolean
  readonly showLeft: boolean
  readonly more: boolean
  /** The portal column and its acts: the right, the portal read in, the portal on. */
  readonly portalColumn: boolean
  /** The portal read failed: its own Try again (the contacts still draw). */
  readonly portalProblem: string | null
  /** The portal still reads (the column waits; the contacts draw). */
  readonly portalReading: boolean
  readonly ticking: boolean
  readonly ticked: readonly string[]
  /** The reader may tick (partners.invite or partners.manage) and the column shows. */
  readonly mayTick: boolean
  /** The head's Invite: shown (the right and the portal read in), held only by state. */
  readonly invite: { readonly shown: boolean; readonly held: Said | null }
  readonly access: PortalAccess | null
  readonly menu: PersonMenuContext
}

export interface AddressesSectionModel {
  readonly answer: readonly Said[]
  readonly all: readonly AddressRow[]
  readonly rows: readonly AddressRow[]
  readonly listed: number
  readonly unfiltered: number
  readonly archivedHidden: number
  readonly showArchived: boolean
  readonly more: boolean
  readonly approving: string | null
  /** The usage read is in (an address with nothing open then says "Not on open work"; while it reads or failed: nothing). */
  readonly usageIn: boolean
  readonly menu: AddressMenuContext
}

export interface PeopleTabModel {
  readonly partyId: string
  readonly name: string
  /** The customer's language (a contact without one writes in it). */
  readonly language: string
  readonly prefix: string
  readonly can: PeopleCan
  /** Changes are allowed (parties.manage and the customer not archived). */
  readonly editable: boolean
  readonly answer: PeopleAnswer
  readonly filter: PeopleChip | null
  readonly people: PeopleSectionModel
  readonly addresses: AddressesSectionModel
  readonly riders: RidersSectionModel // F-CA-203
  readonly refuse: RefuseDialog | null
}

/** The tab's model from its reads and its state. */
export function peopleTabModel(reads: PeopleTabReads, state: PeopleTabState): PeopleTabModel {
  const { party, can, now } = reads
  const archivedCustomer = party.status === 'ARCHIVED'
  const portalModel = reads.portal
  const access = can.portal ? (portalModel?.access ?? null) : null
  const portalOn = access?.settings.portalOn ?? false
  // The portal's people only where the column shows (a portal that is off shows no one: "the portal is off for this customer").
  const portalPeople = access && portalOn ? access.people : null
  const privacy = reads.privacy && reads.privacy.status === 'ready' ? reads.privacy.value : null
  const usage = valueOf(reads.usage)
  // F-CA-203: the riders of both kinds (the profiles only with the measurements right: body data).
  const profileRead = can.measurements ? reads.profiles : null
  const ridersRead = valueOf(reads.riders)
  const riderList = riderRows({ kind: party.kind, partyId: party.id, partyName: party.tradeName ?? party.legalName, contacts: party.contacts, profiles: valueOf(profileRead)?.rows ?? null, riders: ridersRead })
  const mails = mailsOfContacts(party.contacts.map((contact) => ({ id: contact.id, name: contact.name, email: contact.email, roles: contact.roles, status: contact.status, createdAt: contact.createdAt })))
  const all = peopleRows({ contacts: party.contacts, portal: portalPeople, privacy: privacy?.contacts ?? null, mails, usage: usage?.contacts ?? null, approverId: reads.approverId, now })
  const addresses = addressRows(party.addresses, usage?.addresses ?? null)
  const facts: PeopleFacts = {
    kind: party.kind,
    people: all,
    addresses,
    portal: access && portalOn ? { on: true, seats: access.seats } : access ? { on: false, seats: access.seats } : null,
    portalRight: can.portal,
    privacyIn: privacy !== null,
    // F-CA-203: the riders' count once a riders read is in (never 0 for "not read"); a rider's team from the riders read.
    riders: ridersRead !== null || valueOf(profileRead) !== null ? riderList.length : null,
    team: ridersRead?.team?.legalName ?? null,
  }
  const showLeft = portalModel?.showLeft ?? false
  // ---- People
  const personFilter = personFilterOf(state.filter)
  const listedPeople = shownPeople(all, { archived: state.showArchivedContacts, left: showLeft })
  const peopleList = personFilter ? all.filter(personFilter) : listedPeople
  const portalColumn = access !== null && portalOn
  const inviteWords = access ? inviteHeld(access, { view: can.portal, invite: can.invite, manage: can.portalManage, preview: false, requests: false }) : null
  const people: PeopleSectionModel = {
    answer: peopleSectionAnswer(facts),
    all,
    rows: personFilter || state.morePeople ? peopleList : peopleList.slice(0, PEOPLE_ROWS),
    listed: peopleList.length,
    unfiltered: listedPeople.length,
    hidden: hiddenCounts(all),
    showArchived: state.showArchivedContacts,
    showLeft,
    more: state.morePeople,
    portalColumn,
    portalProblem: can.portal && portalModel?.problem && !portalModel.access ? kitProblemOf(portalModel.problem) : null,
    portalReading: can.portal && portalModel !== null && !portalModel.access && !portalModel.problem,
    ticking: state.ticking && portalColumn,
    ticked: (portalModel?.selected ?? []).filter((id) => all.some((row) => row.portal?.id === id && tickable(row))),
    mayTick: portalColumn && (can.invite || can.portalManage),
    invite: { shown: can.invite && access !== null, held: inviteWords && inviteWords !== 'right.invite' ? said(`portal-access:${inviteWords}`) : null },
    access,
    menu: { can, access: portalColumn ? access : null, archivedCustomer, prefix: reads.prefix },
  }
  // ---- Addresses
  const addressFilter = addressFilterOf(state.filter)
  const listedAddresses = shownAddresses(addresses, { archived: state.showArchivedAddresses }, now)
  const addressList = addressFilter ? addresses.filter(addressFilter) : listedAddresses
  return {
    partyId: party.id,
    name: party.tradeName ?? party.legalName,
    language: party.language,
    prefix: reads.prefix,
    can,
    editable: can.manage && !archivedCustomer,
    answer: peopleAnswer(facts),
    filter: state.filter,
    people,
    addresses: {
      answer: addressesSectionAnswer(facts),
      all: addresses,
      rows: addressFilter || state.moreAddresses ? addressList : addressList.slice(0, ADDRESS_ROWS),
      listed: addressList.length,
      unfiltered: listedAddresses.length,
      archivedHidden: archivedCount(addresses, now),
      showArchived: state.showArchivedAddresses,
      more: state.moreAddresses,
      approving: state.approving,
      usageIn: usage !== null,
      menu: { can, archivedCustomer, prefix: reads.prefix },
    },
    riders: {
      kind: party.kind,
      answer: ridersAnswer({ kind: party.kind, rows: riderList, measurements: can.measurements, matching: valueOf(profileRead)?.matching ?? null }),
      all: riderList,
      rows: state.moreRiders ? riderList : riderList.slice(0, RIDER_ROWS),
      more: state.moreRiders,
      measurements: can.measurements,
      reading: (reads.riders === null || reads.riders.status === 'loading') && (profileRead === null || profileRead.status === 'loading'),
      profilesProblem: profileRead?.status === 'error' ? profileRead.problem : null,
      ridersProblem: reads.riders?.status === 'error' ? reads.riders.problem : null,
      matching: valueOf(profileRead)?.matching ?? null,
      team: ridersRead?.team ? { id: ridersRead.team.id, code: ridersRead.team.code, name: ridersRead.team.legalName } : null,
      head: {
        newShown: can.measurements && can.mtmRecord,
        newHeld: archivedCustomer ? said('parties:held.archived') : newMeasurementsHeld(party.status),
        linkShown: can.measurements && can.mtmLink,
        linkHeld: archivedCustomer ? said('parties:held.archived') : linkHeldOf(profilesOf(riderList)),
        addRider: party.kind === 'ORGANISATION' && can.manage,
        changeTeam: party.kind === 'PERSON' && can.manage,
        held: archivedCustomer ? said('parties:held.archived') : null,
      },
      menu: { can, prefix: reads.prefix, status: party.status },
    },
    refuse: state.refuse,
  }
}

/** A result of the tab's own acts (an address checked, a copy), for the record's ONE notice area. */
export interface PeopleNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly words: Said
}

/** What the view asks of its container (each act through the owner's own window or command). */
export interface PeopleTabActions {
  readonly onChip?: (chip: PeopleChip | null) => void
  readonly onPersonAct?: (act: PersonAct, row: PersonRow) => void
  readonly onAddressAct?: (act: AddressAct, row: AddressRow) => void
  readonly onAddContact?: () => void
  readonly onAddAddress?: () => void
  readonly onInvite?: () => void
  readonly onShowArchivedContacts?: (show: boolean) => void
  readonly onShowLeft?: (show: boolean) => void
  readonly onShowArchivedAddresses?: (show: boolean) => void
  readonly onTicking?: (ticking: boolean) => void
  readonly onTick?: (userId: string, ticked: boolean) => void
  readonly onBulk?: (action: RowAction) => void
  readonly onMore?: (section: 'people' | 'addresses' | 'riders', more: boolean) => void
  readonly onRetryPortal?: () => void
  readonly onRefuseDraft?: (reason: string) => void
  readonly onRefuseConfirm?: () => void
  readonly onRefuseClose?: () => void
  // ---- F-CA-203 (ca-w2): Riders & measurements
  readonly onRiderAct?: (act: RiderAct, row: RiderRow, profileId?: string) => void
  readonly onNewMeasurements?: () => void
  readonly onSendLink?: () => void
  readonly onRetryProfiles?: () => void
  readonly onRetryRiders?: () => void
}

/** The tab's notices for the record's ONE notice area (the portal container's own, and the tab's). */
export interface PeopleNotices {
  readonly portal: PortalAccessModel['notice']
  readonly own: PeopleNotice | null
  readonly onDismissPortal?: () => void
  readonly onDismissOwn?: () => void
}
