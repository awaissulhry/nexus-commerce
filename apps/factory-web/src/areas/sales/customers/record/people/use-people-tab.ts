'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import type { Party } from '../../../../parties/_shared/api'
import { blankContact, problemKey, type ContactDraft, type PartyRecordModel } from '../../../../parties/_shared/model'
import type { PartyRecordActions } from '../../../../parties/_shared/view/PartyRecordView'
import { getProductionLimits } from '../../../../admin/users/partners/api'
import { partnerCan, personReach, type RowAction } from '../../../../admin/users/partners/model'
import { usePortalAccess } from '../../portal/PortalAccess'
import type { PortalAccessActions, PortalAccessModel } from '../../portal/model'
import type { Glance, Privacy } from '../../depth/api'
import type { Read as DepthRead } from '../../depth/model'
import { readProblem } from '../../../orders/model'
import { approveDeliveryAddress, readPartyUsage, refuseDeliveryAddress, type PartyUsage } from './api'
import type { PeopleChip } from './answer'
import { addressShort, addressText, type AddressAct, type AddressRow } from './addresses'
import { addressAnchor, failedRead, peopleCan, personAnchor, READING, readyRead, said, type Read } from './model'
import type { PersonAct, PersonRow } from './people'
import { PEOPLE_TAB_START, peopleTabModel, type PeopleNotice, type PeopleNotices, type PeopleTabActions, type PeopleTabModel, type PeopleTabState } from './tab'

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
  /** The customer at a glance (the depth provider's; the riders' count, a rider's team). */
  readonly glance: DepthRead<Glance> | null
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
}

const LIVE = /^(party\.|quote\.|shipment\.|sample_shipment\.|return\.|complaint\.|service_case\.|portal_order_request\.|order_change_request\.)/

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
  useEffect(() => {
    if (!on) return
    setUsage((current) => current ?? READING)
    void loadUsage()
    void loadApprover()
  }, [on, loadUsage, loadApprover])
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLiveBus({
    onChange: (change) => {
      if (!on || !LIVE.test(change.type)) return
      const about = change.fields.partyId ?? change.fields.customerId
      if (typeof about === 'string' && about !== partyId) return
      if (pending.current) clearTimeout(pending.current)
      pending.current = setTimeout(() => void loadUsage(), 400)
    },
    onReconnect: () => {
      if (on) void loadUsage()
    },
  })
  useEffect(() => () => (pending.current ? clearTimeout(pending.current) : undefined), [])

  // ---- the arrival: `#<section or row>` once, `&add=contact|address` once (then the address leaves it)
  const search = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const arrived = useRef(false)
  const editable = can.manage && party?.status !== 'ARCHIVED'
  useEffect(() => {
    if (!on) {
      arrived.current = false
      return
    }
    if (arrived.current) return
    arrived.current = true
    const add = search?.get('add')
    if (add) {
      if (editable && (add === 'contact' || add === 'address')) recordActions.onDialog?.(add === 'contact' ? { kind: 'contact' } : { kind: 'address' })
      const next = new URLSearchParams(search?.toString() ?? '')
      next.delete('add')
      router.replace(`${pathname}?${next.toString()}${typeof window === 'undefined' ? '' : window.location.hash}`, { scroll: false })
    }
    const hash = typeof window === 'undefined' ? '' : window.location.hash.slice(1)
    if (hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(hash))?.scrollIntoView({ block: 'start' }))
    // Once per visit of the tab, after the party is read.
  }, [on])

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
    else if (act === 'archive' && contact) recordActions.onContactStatus?.(contact.id, 'ARCHIVED')
    else if (act === 'restore' && contact) recordActions.onContactStatus?.(contact.id, 'ACTIVE')
    else if (act === 'link') copy(linkTo(personAnchor(row.id)))
  }
  const onAddressAct = (act: AddressAct, row: AddressRow) => {
    if (act === 'edit') recordActions.onDialog?.({ kind: 'address', addressId: row.id })
    else if (act === 'billTo' || act === 'shipTo') recordActions.onDefault?.(act, row.id)
    else if (act === 'copy') copy(addressText(row.address))
    else if (act === 'archive') recordActions.onAddressStatus?.(row.id, 'ARCHIVED')
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
    onMore: (section, more) => patch(section === 'people' ? { morePeople: more } : { moreAddresses: more }),
    onRetryPortal: () => portalActions.onRetry?.(),
    onRefuseDraft: (reason) => setState((current) => (current.refuse ? { ...current, refuse: { ...current.refuse, reason } } : current)),
    onRefuseConfirm: () => void confirmRefuse(),
    onRefuseClose: () => {
      refuseKey.current = null
      patch({ refuse: null })
    },
  }

  const model = on && party ? peopleTabModel({ party, prefix: record.prefix, can, now, portal: can.portal ? portal.model : null, privacy: input.privacy, usage, approverId, glance: input.glance }, state) : null
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
  }
}
