'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { listParties, type Party, type PartyRow } from '../../../../parties/_shared/api'
import { blankContact, partyName, problemKey, suggestCode, type ContactDraft, type PartyRecordModel } from '../../../../parties/_shared/model'
import type { PartyRecordActions } from '../../../../parties/_shared/view/PartyRecordView'
import { getProductionLimits } from '../../../../admin/users/partners/api'
import { partnerCan, personReach, type RowAction } from '../../../../admin/users/partners/model'
import { usePortalAccess } from '../../portal/PortalAccess'
import type { PortalAccessActions, PortalAccessModel } from '../../portal/model'
import { queryWithoutInvite } from '../../portal/model' // F-CA-fx5 (walk W-11)
import type { Privacy, PrivacyContact } from '../../depth/api'
import { listProfiles, listTemplates, type ProfilesView, type TemplateOption } from '../../../mtm/api' // F-CA-204
import { mtmCan, recordHref } from '../../../mtm/model' // F-CA-208
import { useMeasurementsDialog } from '../../../mtm/use-measurements' // F-CA-208: Made-to-measure's own windows, in place
import { useLinkDialog } from '../../../mtm/use-dialogs' // F-CA-208
import { useLocale } from '../../../../../lib/i18n/provider' // F-CA-208: a measurement link's language
import type { PrivacyDialog, Read as DepthRead } from '../../depth/model'
import { readProblem } from '../../../orders/model'
import { approveDeliveryAddress, createRider, readPartyUsage, readRiders, refuseDeliveryAddress, setRiderTeam, type PartyUsage, type RidersView } from './api'
import type { PeopleChip } from './answer'
import { addressShort, addressText, type AddressAct, type AddressRow } from './addresses'
import { addressAnchor, failedRead, peopleCan, personAnchor, READING, readyRead, readsSettled /* F-CA-fx5 */, said, valueOf, type Read } from './model'
import type { PersonAct, PersonRow } from './people'
import { riderAnchor, type RiderAct, type RiderRow } from './riders' // F-CA-208
import { addRiderProblem, PEOPLE_TAB_START, peopleTabModel, teamProblem, type AddRiderDialog, type FoundParty, type TeamDialog, type PeopleMtm, type PeopleNotice, type PeopleNotices, type PeopleTabActions, type PeopleTabModel, type PeopleTabState } from './tab'

/**
 * F-CA-107 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 13-backend §1, §3, §5.3, §5.7; 18-lead-settles Z13, Z15, Z16, Z17) — the
 * tab's container. Built by the record on every tab (like Work and Quotes), it reads ONLY while People & addresses is shown
 * (`enabled`): the portal of THIS customer (the portal container's own hook, moved out of PortalAccess.tsx — its windows open here in
 * place), the usage read (D3), the production approver (partners.view). The party and its contacts' personal data are the page's
 * reads (handed in). Acts: the record's own (Add / Edit / Archive / Restore a contact or an address, the defaults — the shared windows,
 * mounted as they are), the portal's (Invite, send again, change access, suspend, reactivate, deactivate — one or many), and the check
 * of an address the customer added in the portal (Approve: one click; Refuse…: the reason the customer reads) — each with the version
 * read and one Idempotency-Key per attempt; a 409 reads the party again. The arrival: `#<section>` scrolls once, `&add=contact|address`
 * opens the window once (then leaves the address), `?invite=` opens the invitation (the portal hook). Every result lands in the
 * record's ONE notice area (`notice`).
 */

export interface PeopleTabInput {
  readonly partyId: string
  readonly party: Party | null | undefined
  readonly model: PartyRecordModel
  readonly actions: PartyRecordActions
  /** Read the party again (after a check, on a 409). */
  readonly reload: () => void
  /** The contacts' personal data (the depth provider's read on People). */
  readonly privacy: DepthRead<Privacy> | null
  /** F-CA-222 (W2.4; Z14): the depth provider's own personal-data windows, opened from a person's ⋯ (absent: none offered). */
  readonly openPrivacy?: ((kind: PrivacyDialog['kind'], contact: PrivacyContact) => void) | undefined
  readonly retryPrivacy?: (() => void) | undefined
  /** People & addresses is the tab shown: only then does the tab read. */
  readonly enabled: boolean
}

export interface PeopleTabContainer {
  /** What the view draws; null until the party is read (or while another tab shows). */
  readonly model: PeopleTabModel | null
  readonly actions: PeopleTabActions
  /** The portal container's model and acts (its windows mount on the tab); null: no portal right. */
  readonly portal: { readonly model: PortalAccessModel; readonly actions: PortalAccessActions } | null
  /** The tab's notices for the record's ONE notice area. */
  readonly notices: PeopleNotices
  /** "Add as a contact…": the Add contact window starts with the portal person's name and e-mail (null: as always). */
  readonly contactDraft: ContactDraft | null
  /** F-CA-208: Made-to-measure's own windows (New measurements, Send a measurement link), mounted on the tab. */
  readonly mtm: PeopleMtm
}


const LIVE = /^(party\.|quote\.|shipment\.|sample_shipment\.|return\.|complaint\.|service_case\.|portal_order_request\.|order_change_request\.)/
/** F-CA-204 (13-backend §1.4): the made-to-measure events that move a profile of this customer or of one of its riders. */
const MTM_LIVE = /^(measurement_profile\.|measurements\.submitted$|appointment\.|fitting_result\.)/

export function usePeopleTab(input: PeopleTabInput): PeopleTabContainer {
  const { partyId, party, model: record, actions: recordActions, reload, enabled } = input
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => peopleCan(session.permissions), [session.permissions])
  const on = enabled && !!party
  const [now] = useState(() => new Date().toISOString())
  const [state, setState] = useState<PeopleTabState>(PEOPLE_TAB_START)
  const [notice, setNotice] = useState<PeopleNotice | null>(null)
  const [preset, setPreset] = useState<ContactDraft | null>(null)
  const patch = (next: Partial<PeopleTabState>) => setState((current) => ({ ...current, ...next }))

  // ---- the portal of THIS customer: the portal container's own state and windows (People's part; no requests read here)
  const portal = usePortalAccess({ side: 'customers', party: { id: partyId, name: party ? (party.tradeName ?? party.legalName) : '', companyId: party?.companyId ?? null }, parts: ['people'], enabled: on && can.portal })

  // ---- the usage read (D3) and the production approver, only on People
  const [usage, setUsage] = useState<Read<PartyUsage> | null>(null)
  const [approverId, setApproverId] = useState<string | null>(null)
  const loadUsage = useCallback(async () => {
    if (!on || !can.view) return
    try {
      setUsage(readyRead(await readPartyUsage(api, partyId)))
    } catch (error) {
      setUsage(failedRead(readProblem(error)))
    }
  }, [api, can.view, on, partyId])
  const loadApprover = useCallback(async () => {
    if (!on || !can.portal) return
    try {
      setApproverId((await getProductionLimits(api, partyId)).production.approver?.id ?? null)
    } catch {
      setApproverId(null) // the tag is left out; nothing else depends on it
    }
  }, [api, can.portal, on, partyId])
  // ---- F-CA-204 (ca-w2 W2.1): Riders & measurements — the profiles kept on THIS customer (the MTM list's own read, with the
  // measurements right only: body data) and its riders (both kinds; a rider's team). Each names this customer on the server.
  const [profiles, setProfiles] = useState<Read<ProfilesView> | null>(null)
  const [riders, setRiders] = useState<Read<RidersView> | null>(null)
  const loadProfiles = useCallback(async () => {
    if (!on || !can.measurements) return
    try {
      setProfiles(readyRead(await listProfiles(api, { partyId })))
    } catch (error) {
      setProfiles(failedRead(readProblem(error)))
    }
  }, [api, can.measurements, on, partyId])
  const loadRiders = useCallback(async () => {
    if (!on || !can.view) return
    try {
      setRiders(readyRead(await readRiders(api, partyId)))
    } catch (error) {
      setRiders(failedRead(readProblem(error)))
    }
  }, [api, can.view, on, partyId])
  useEffect(() => {
    if (!on) return
    setUsage((current) => current ?? READING)
    setRiders((current) => current ?? READING)
    if (can.measurements) setProfiles((current) => current ?? READING)
    void loadUsage()
    void loadApprover()
    void loadRiders()
    void loadProfiles()
  }, [on, can.measurements, loadUsage, loadApprover, loadRiders, loadProfiles])
  // Live: each read again on its own events, a burst once (400 ms). A made-to-measure event names the party measured — this customer
  // or one of its riders; a team change names the rider and both teams.
  const riderIds = useRef<ReadonlySet<string>>(new Set())
  riderIds.current = new Set(valueOf(riders)?.riders.map((rider) => rider.id) ?? [])
  const pending = useRef<Partial<Record<'usage' | 'profiles' | 'riders', ReturnType<typeof setTimeout>>>>({})
  const later = (what: 'usage' | 'profiles' | 'riders', run: () => Promise<void>) => {
    const timers = pending.current
    if (timers[what]) clearTimeout(timers[what])
    timers[what] = setTimeout(() => void run(), 400)
  }
  const live = useLiveBus({
    onChange: (change) => {
      if (!on) return
      const about = change.fields.partyId ?? change.fields.customerId
      const ours = typeof about !== 'string' || about === partyId
      if (LIVE.test(change.type) && ours) later('usage', loadUsage)
      if (MTM_LIVE.test(change.type) && typeof about === 'string' && (about === partyId || riderIds.current.has(about))) {
        if (about === partyId) later('profiles', loadProfiles)
        else later('riders', loadRiders) // a rider's own profiles: its count on the riders read
      }
      if (change.type === 'party.team_changed' && [change.fields.partyId, change.fields.teamPartyId, change.fields.previousTeamPartyId].includes(partyId)) later('riders', loadRiders)
    },
    onReconnect: () => {
      if (!on) return
      void loadUsage()
      void loadRiders()
      void loadProfiles()
    },
  })
  useEffect(
    () => () => {
      for (const timer of Object.values(pending.current)) if (timer) clearTimeout(timer)
    },
    [],
  )

  // ---- the arrival: `#<section or row>` once, `&add=contact|address` once (then the address leaves it)
  const search = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const arrived = useRef(false)
  const landing = useRef<string | null>(null) // F-CA-fx5 (walk W-03; Z26): the anchor a door asked for, until the tab's reads settle
  const editable = can.manage && party?.status !== 'ARCHIVED'
  useEffect(() => {
    if (!on) {
      arrived.current = false
      landing.current = null // F-CA-fx5
      return
    }
    if (arrived.current) return
    arrived.current = true
    const add = search?.get('add')
    // F-CA-fx5 (walk W-11): a reader who reads no portal here (no partners.view) never reads `?invite=`: it leaves the address now, with
    // `&add=`; for every other reader the portal hook reads it once the people are read, then drops it (with or without the right).
    const left = can.portal ? null : queryWithoutInvite(search?.toString() ?? '')
    if (add || left !== null) {
      if (add && editable && (add === 'contact' || add === 'address')) recordActions.onDialog?.(add === 'contact' ? { kind: 'contact' } : { kind: 'address' })
      const next = new URLSearchParams(left ?? search?.toString() ?? '')
      next.delete('add')
      const query = next.toString()
      router.replace(`${pathname}${query ? `?${query}` : ''}${typeof window === 'undefined' ? '' : window.location.hash}`, { scroll: false })
    }
    const hash = typeof window === 'undefined' ? '' : window.location.hash.slice(1)
    if (hash) {
      const target = decodeURIComponent(hash)
      landing.current = target // F-CA-fx5: lands again once the reads settle (below)
      requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }))
    }
    // Once per visit of the tab, after the party is read.
  }, [on])
  // ---- F-CA-fx5 (walk W-03; 18-lead-settles Z26): the parts above a section grow while their reads land (the portal's rows, the usage
  // lines, the riders), so the door lands ONCE more when every read the tab started has answered (ready or failed) — unless the reader
  // moved first (a wheel, a touch, a key, a press): then their place wins and nothing scrolls.
  const settled = readsSettled([usage ?? READING, riders ?? READING, can.measurements ? (profiles ?? READING) : null, input.privacy ?? READING, can.portal && !portal.model.access && !portal.model.problem ? READING : null])
  useEffect(() => {
    if (!on) return
    const moved = () => {
      landing.current = null
    }
    const kinds = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    for (const kind of kinds) window.addEventListener(kind, moved, { capture: true, passive: true })
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, moved, { capture: true })
    }
  }, [on])
  useEffect(() => {
    const target = landing.current
    if (!on || !settled || !target) return
    landing.current = null
    requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }))
  }, [on, settled])
  // ---- end F-CA-fx5

  // ---- the check of an address added in the portal (orders.manage)
  const failedWrite = (error: unknown) => {
    const conflict = isApiError(error) && error.kind === 'conflict'
    setNotice({ tone: conflict ? 'warning' : 'danger', words: said(`parties:${problemKey(error)}`) })
    if (conflict) reload()
  }
  const approve = async (row: AddressRow) => {
    if (state.approving) return
    patch({ approving: row.id })
    try {
      await approveDeliveryAddress(api, row.id, { version: row.address.version }, newIdempotencyKey())
      setNotice({ tone: 'success', words: said('done.approved', { params: { name: addressShort(row.address) } }) })
      reload()
    } catch (error) {
      failedWrite(error)
    } finally {
      patch({ approving: null })
    }
  }
  const refuseKey = useRef<string | null>(null)
  const confirmRefuse = async () => {
    const dialog = state.refuse
    const row = party?.addresses.find((address) => address.id === dialog?.addressId)
    if (!dialog || !row || dialog.busy) return
    const reason = dialog.reason.trim()
    if (reason.length < 3 || reason.length > 500) {
      patch({ refuse: { ...dialog, tried: true } })
      return
    }
    const key = (refuseKey.current ??= newIdempotencyKey()) // one key while the window is open: a retry never refuses twice
    patch({ refuse: { ...dialog, tried: true, busy: true, problem: null } })
    try {
      await refuseDeliveryAddress(api, row.id, { version: row.version, reason }, key)
      refuseKey.current = null
      patch({ refuse: null })
      setNotice({ tone: 'success', words: said('done.refused', { params: { name: addressShort(row) } }) })
      reload()
    } catch (error) {
      const conflict = isApiError(error) && error.kind === 'conflict'
      patch({ refuse: { ...dialog, tried: true, busy: false, problem: problemKey(error) } })
      if (conflict) {
        refuseKey.current = null
        reload()
      }
    }
  }

  // ---- copies (an e-mail, an address, a link to a row): to the clipboard, said in the notice area
  const copy = (text: string) => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard) {
      setNotice({ tone: 'warning', words: said('done.copyFailed') })
      return
    }
    void clipboard.writeText(text).then(
      () => setNotice({ tone: 'success', words: said('done.copied') }),
      () => setNotice({ tone: 'warning', words: said('done.copyFailed') }),
    )
  }
  // ---- F-CA-208 (ca-w2 W2.2; 13-backend §3): Made-to-measure's New measurements and Send a measurement link, IN PLACE — its own hooks,
  // "for both containers"; New measurements starts with THIS customer chosen (an additive preset; absent = as on its page). The garment
  // types are read once, the first time a link is asked (a link says how many points it asks).
  const mtm = useMemo(() => mtmCan(session.permissions), [session.permissions])
  const locale = useLocale()
  const offline = live === 'offline'
  const me = useMemo(() => ({ id: session.user.id, name: session.user.displayName }), [session.user.id, session.user.displayName])
  const companyId = session.company?.id ?? null
  const measurements = useMeasurementsDialog({
    api,
    can: mtm,
    me,
    companyId,
    offline,
    onSaved: (answer) => {
      void loadProfiles()
      setNotice({ tone: 'success', words: said('done.measured', { params: { revision: answer.profile.revision } }), link: { href: recordHref(record.prefix, answer.profile.id), label: said('done.openProfile') } })
    },
  })
  const [templates, setTemplates] = useState<readonly TemplateOption[] | null>(null)
  const pointsOf = useCallback((garment: string) => templates?.find((template) => template.code === garment)?.points ?? null, [templates])
  const link = useLinkDialog({ api, can: mtm, companyId, language: locale === 'en' ? 'en' : 'it', offline, pointsOf })
  const readTemplates = () => {
    if (templates !== null || !mtm.styles) return
    listTemplates(api, { status: 'ALL' })
      .then((answer) => setTemplates(answer.templates))
      .catch(() => setTemplates([]))
  }
  const customerQ = party ? (party.tradeName ?? party.legalName) : ''
  const onRiderAct = (act: RiderAct, row: RiderRow, profileId?: string) => {
    if (act === 'newFor') measurements.openNew({ partyId, customerQ, contactId: row.contact?.id ?? null, riderName: row.contact ? null : row.name })
    else if (act === 'link') {
      const profile = row.profiles.find((entry) => entry.id === profileId)
      if (!profile) return
      readTemplates()
      link.openFor({ profileId: profile.id, riderName: profile.riderName, garmentType: profile.garmentType, contactId: profile.contactId, pointCount: pointsOf(profile.garmentType) })
    } else if (act === 'editContact' && row.contact) recordActions.onDialog?.({ kind: 'contact', contactId: row.contact.id })
    else if (act === 'team') {
      teamKey.current = null
      openTeam(row)
    }
    else if (act === 'copyLink') copy(linkTo(riderAnchor(row.id)))
  }

  // ---- F-CA-214 (ca-w2 W2.3; 10-design §6 windows 4 and 5; Z10): Add rider… (an organisation's) and Change team…. Add rider = the two
  // existing commands (POST /parties, then PUT /parties/:rider/team), one Idempotency-Key each per attempt; when the second fails the
  // rider exists, not yet under the team: the window says so and Try again sends only the team change. A search names customers on the
  // server (the reader's own); a 409 reads the riders again.
  const patchAdd = (next: Partial<AddRiderDialog>) => setState((current) => (current.addRider ? { ...current, addRider: { ...current.addRider, ...next } } : current))
  const patchTeam = (next: Partial<TeamDialog>) => setState((current) => (current.team ? { ...current, team: { ...current.team, ...next } } : current))
  const foundOf = (row: PartyRow): FoundParty => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName, city: row.city, version: row.version })
  const searchKind = state.addRider?.kind === 'own' && !state.addRider.picked ? 'PERSON' : state.team?.choice === 'move' ? 'ORGANISATION' : null
  const searchText = (searchKind === 'PERSON' ? state.addRider?.search : state.team?.search) ?? ''
  useEffect(() => {
    if (!searchKind || searchText.trim().length < 2) return
    const controller = new AbortController()
    const put = (found: AddRiderDialog['found']) => (searchKind === 'PERSON' ? patchAdd({ found }) : patchTeam({ found }))
    put(READING)
    const timer = setTimeout(() => {
      listParties(api, { roles: ['CUSTOMER'], kind: searchKind, q: searchText, limit: 10 }, controller.signal)
        .then((page) => put(readyRead(page.parties.filter((row) => row.id !== partyId).map(foundOf))))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) put(failedRead(problemKey(error)))
        })
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // The search's words and kind are the dependency.
  }, [api, searchKind, searchText, partyId])
  const riderKeys = useRef<{ create: string | null; team: string | null }>({ create: null, team: null })
  const confirmAddRider = async () => {
    const dialog = state.addRider
    if (!dialog || dialog.busy || !party) return
    if (dialog.kind === 'kept') {
      // A rider kept on the team = a contact with the role Rider: the record's own Add contact window, Rider ticked.
      patch({ addRider: null })
      setPreset(blankContact(['RIDER']))
      recordActions.onDialog?.({ kind: 'contact' })
      return
    }
    if (addRiderProblem(dialog)) {
      patchAdd({ tried: true })
      return
    }
    patchAdd({ tried: true, busy: true, problem: null })
    let rider = dialog.made ?? (dialog.picked ? { id: dialog.picked.id, name: dialog.picked.name, version: dialog.picked.version } : null)
    if (!rider) {
      const name = dialog.name.trim()
      const email = dialog.email.trim()
      const phone = dialog.phone.trim()
      try {
        const createKey = (riderKeys.current.create ??= newIdempotencyKey())
        const made = await createRider(
          api,
          { companyId: party.companyId, code: suggestCode(name), kind: 'PERSON', legalName: name, roles: ['CUSTOMER'], country: party.country, currency: party.currency, language: dialog.language, status: 'ACTIVE', ...(email || phone ? { contacts: [{ name, email: email || null, phone: phone || null, roles: ['RIDER'], language: dialog.language }] } : {}) },
          createKey,
        )
        riderKeys.current.create = null
        rider = { id: made.id, name: partyName(made), version: made.version }
      } catch (error) {
        patchAdd({ busy: false, problem: problemKey(error) })
        return
      }
    }
    try {
      const teamKeyOf = (riderKeys.current.team ??= newIdempotencyKey())
      await setRiderTeam(api, rider.id, { version: rider.version, teamPartyId: partyId }, teamKeyOf)
      riderKeys.current = { create: null, team: null }
      patch({ addRider: null })
      setNotice({ tone: 'success', words: said('done.riderAdded', { params: { name: rider.name, team: customerQ } }), link: { href: `${record.prefix}/sales/customers/${encodeURIComponent(rider.id)}?tab=people#riders`, label: said('riders.row.open', { params: { name: rider.name } }) } })
      void loadRiders()
    } catch (error) {
      // The half-failure (a new rider): it exists, not yet under the team — the window keeps it; Try again sends only the team change.
      if (isApiError(error) && error.kind === 'conflict') riderKeys.current.team = null
      patchAdd({ busy: false, problem: problemKey(error), ...(dialog.picked ? {} : { made: rider }) })
    }
  }
  const openTeam = (row: RiderRow | null) => {
    const view = valueOf(riders)
    if (row?.party) {
      patch({ team: { riderId: row.party.id, riderName: row.name, version: row.party.version, current: { id: partyId, name: customerQ }, choice: 'move', search: '', found: null, picked: null, tried: false, busy: false, problem: null } })
    } else if (!row && party) {
      patch({ team: { riderId: partyId, riderName: customerQ, version: view?.version ?? party.version, current: view?.team ? { id: view.team.id, name: view.team.legalName } : null, choice: view?.team ? 'keep' : 'move', search: '', found: null, picked: null, tried: false, busy: false, problem: null } })
    }
  }
  const teamKey = useRef<string | null>(null)
  const confirmTeam = async () => {
    const dialog = state.team
    if (!dialog || dialog.busy) return
    if (dialog.choice === 'keep') {
      patch({ team: null })
      return
    }
    if (teamProblem(dialog)) {
      patchTeam({ tried: true })
      return
    }
    patchTeam({ tried: true, busy: true, problem: null })
    try {
      const key = (teamKey.current ??= newIdempotencyKey())
      await setRiderTeam(api, dialog.riderId, { version: dialog.version, teamPartyId: dialog.choice === 'off' ? null : dialog.picked!.id }, key)
      teamKey.current = null
      patch({ team: null })
      setNotice({ tone: 'success', words: dialog.choice === 'off' ? said('done.teamOff', { params: { name: dialog.riderName } }) : said('done.teamMoved', { params: { name: dialog.riderName, team: dialog.picked?.name ?? '' } }) })
      void loadRiders()
      if (dialog.riderId === partyId) reload() // this customer's own version moved
    } catch (error) {
      const conflict = isApiError(error) && error.kind === 'conflict'
      teamKey.current = null
      patchTeam({ busy: false, problem: problemKey(error) })
      if (conflict) void loadRiders()
    }
  }

  const linkTo = (anchor: string) => (typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}${window.location.search}#${anchor}`)

  const portalActions = portal.actions
  const onPersonAct = (act: PersonAct, row: PersonRow) => {
    const contact = row.contact
    const person = row.portal
    if (act === 'edit' && contact) recordActions.onDialog?.({ kind: 'contact', contactId: contact.id })
    else if (act === 'addContact' && person) {
      setPreset({ ...blankContact([]), name: person.displayName, email: person.email })
      recordActions.onDialog?.({ kind: 'contact' })
    } else if (act === 'copyEmail') copy(contact?.email ?? person?.email ?? '')
    else if (act === 'invite' && contact?.email) portalActions.onDialog?.({ kind: 'invite', email: contact.email, name: contact.name })
    else if (act === 'change' && person) portalActions.onDialog?.({ kind: 'person', userId: person.id })
    else if ((act === 'resend' || act === 'revoke' || act === 'suspend' || act === 'reactivate' || act === 'deactivate') && person) portalActions.onDialog?.({ kind: 'confirm', action: act, userIds: [person.id] })
    else if (act === 'archive' && contact) patch({ archive: { kind: 'contact', id: contact.id } }) // F-CA-222: the NEW window first
    else if ((act === 'basis' || act === 'objection' || act === 'copy' || act === 'erase') && row.privacy) input.openPrivacy?.(act, row.privacy) // F-CA-222
    else if (act === 'restore' && contact) recordActions.onContactStatus?.(contact.id, 'ACTIVE')
    else if (act === 'link') copy(linkTo(personAnchor(row.id)))
  }
  const onAddressAct = (act: AddressAct, row: AddressRow) => {
    if (act === 'edit') recordActions.onDialog?.({ kind: 'address', addressId: row.id })
    else if (act === 'billTo' || act === 'shipTo') recordActions.onDefault?.(act, row.id)
    else if (act === 'copy') copy(addressText(row.address))
    else if (act === 'archive') patch({ archive: { kind: 'address', id: row.id } }) // F-CA-222: the NEW window first
    else if (act === 'restore') recordActions.onAddressStatus?.(row.id, 'ACTIVE')
    else if (act === 'approve') void approve(row)
    else if (act === 'refuse') {
      refuseKey.current = null
      patch({ refuse: { addressId: row.id, reason: '', tried: false, busy: false, problem: null } })
    } else if (act === 'link') copy(linkTo(addressAnchor(row.id)))
  }
  const onBulk = (action: RowAction) => {
    const access = portal.model.access
    if (!access) return
    const ticked = access.people.filter((person) => portal.model.selected.includes(person.id))
    const reach = personReach(action, ticked, partnerCan(session.permissions))
    if (reach.items.length > 0) portalActions.onDialog?.({ kind: 'confirm', action, userIds: reach.items.map((person) => person.id) })
  }

  const actions: PeopleTabActions = {
    onRiderAct, // F-CA-208
    // ---- F-CA-214: Add rider… and Change team…
    onAddRider: () => {
      riderKeys.current = { create: null, team: null }
      patch({ addRider: { kind: 'own', name: '', email: '', phone: '', language: party?.language ?? 'it', search: '', found: null, picked: null, tried: false, busy: false, problem: null, made: null } })
    },
    onAddRiderDraft: (next) => patchAdd(next),
    onAddRiderConfirm: () => void confirmAddRider(),
    onAddRiderClose: () => patch({ addRider: null }),
    onChangeTeam: (row) => {
      teamKey.current = null
      openTeam(row)
    },
    onTeamDraft: (next) => patchTeam(next),
    onTeamConfirm: () => void confirmTeam(),
    onTeamClose: () => patch({ team: null }),
    // ---- F-CA-222: the Archive window sends the record's own change (it warns, never refuses)
    onArchiveConfirm: () => {
      const archive = state.archive
      if (archive?.kind === 'contact') recordActions.onContactStatus?.(archive.id, 'ARCHIVED')
      else if (archive?.kind === 'address') recordActions.onAddressStatus?.(archive.id, 'ARCHIVED')
      patch({ archive: null })
    },
    onArchiveClose: () => patch({ archive: null }),
    onRetryPrivacy: () => input.retryPrivacy?.(),
    onNewMeasurements: () => measurements.openNew({ partyId, customerQ }),
    onSendLink: () => {
      readTemplates()
      link.openFromBand(valueOf(profiles)?.rows ?? [])
    },
    onChip: (chip: PeopleChip | null) => patch({ filter: chip }),
    onPersonAct,
    onAddressAct,
    onAddContact: () => recordActions.onDialog?.({ kind: 'contact' }),
    onAddAddress: () => recordActions.onDialog?.({ kind: 'address' }),
    onInvite: () => portalActions.onDialog?.({ kind: 'invite' }),
    onShowArchivedContacts: (show) => patch({ showArchivedContacts: show }),
    onShowLeft: (show) => portalActions.onShowLeft?.(show),
    onShowArchivedAddresses: (show) => patch({ showArchivedAddresses: show }),
    onTicking: (ticking) => {
      patch({ ticking })
      if (!ticking) portalActions.onSelected?.([])
    },
    onTick: (userId, ticked) => portalActions.onSelected?.(ticked ? [...new Set([...portal.model.selected, userId])] : portal.model.selected.filter((id) => id !== userId)),
    onBulk,
    onMore: (section, more) => patch(section === 'people' ? { morePeople: more } : section === 'riders' ? { moreRiders: more } : { moreAddresses: more }),
    onRetryProfiles: () => {
      setProfiles(READING)
      void loadProfiles()
    },
    onRetryRiders: () => {
      setRiders(READING)
      void loadRiders()
    },
    onRetryPortal: () => portalActions.onRetry?.(),
    onRefuseDraft: (reason) => setState((current) => (current.refuse ? { ...current, refuse: { ...current.refuse, reason } } : current)),
    onRefuseConfirm: () => void confirmRefuse(),
    onRefuseClose: () => {
      refuseKey.current = null
      patch({ refuse: null })
    },
  }

  const model = on && party ? peopleTabModel({ party, prefix: record.prefix, can, now, portal: can.portal ? portal.model : null, privacy: input.privacy, usage, approverId, profiles: can.measurements ? profiles : null, riders }, state) : null
  // "Add as a contact…" only while the Add contact window it opened is open (any other window: as always).
  const dialog = record.dialog
  const contactDraft = preset && dialog?.kind === 'contact' && !dialog.contactId ? preset : null
  useEffect(() => {
    if (preset && !(dialog?.kind === 'contact' && !dialog.contactId)) setPreset(null)
  }, [dialog, preset])
  return {
    model,
    actions,
    portal: can.portal ? { model: portal.model, actions: portalActions } : null,
    notices: { portal: on && can.portal ? portal.model.notice : null, own: on ? notice : null, onDismissPortal: () => portalActions.onDismissNotice?.(), onDismissOwn: () => setNotice(null) },
    contactDraft,
    mtm: { can: mtm, measurements: measurements.model, measurementsActions: measurements.actions, link: link.model, linkActions: link.actions },
  }
}
