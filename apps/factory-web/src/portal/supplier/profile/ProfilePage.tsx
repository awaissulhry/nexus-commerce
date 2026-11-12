'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { loading, usePortalPeople, type Load, type Receipt } from '../../shared/account/usePortalPeople'
import { NotInAccessHere, useOffline } from '../orders/parts'
import { fetchSupplierProfile, sendChanges, withdrawChanges, type ChangeRequest, type SupplierProfile } from './api'
import { profileBandOf } from './band'
import {
  addressLines,
  addressProblems,
  changeHeld,
  changeLines,
  changesBody,
  contactLines,
  contactProblems,
  EMPTY_ADDRESS,
  EMPTY_CONTACT,
  editCount,
  NO_EDITS,
  NS,
  sameEmails,
  sendHeld,
  websiteProblemKey,
  withAddressEdit,
  withContactEdit,
  withoutEdit,
  type AddressLine,
  type ContactLine,
  type ProfileEdits,
} from './model'
import type { ProfileDialog } from './view/ProfileDialogs'
import { ProfileView } from './view/ProfileView'
// B-W2b-334: Profile › Bank details (SCM-007).
import { SupplierBank } from './bank/SupplierBank'

/**
 * `/p/<party>/profile` for a supplier or a workshop (B-W2b-193, SCR-191; design portal.supplier.profile): reads GET
 * /portal/supplier-profile (B-W2b-189 / F13a) and again on its live events (our check approved or refused a change: the
 * pill and the values move) and on a reconnect. Changes of the website, the addresses and the contacts are typed on the
 * page (a pop-up per address or contact; Remove and Undo in place) and sent together with "Send changes for our check"
 * (⌘S; one Idempotency-Key per send; each row at the version the supplier saw); leaving with typed changes asks first. A
 * request waiting for our check can be withdrawn. The portal users, the admin's acts behind a fresh e-mail code, the
 * e-mail settings and the sessions are the shared account work (usePortalPeople). The Admin changes; anyone else reads.
 */
export function SupplierProfileRoute() {
  return (
    <WithMessages namespaces={[NS, 'portal', 'portal-account', 'lists', 'ds-words', 'purchasing-suppliers-depth']}>
      <Gate />
    </WithMessages>
  )
}

function Gate() {
  const frame = usePortalFrame()
  const t = useT(NS)
  const opens = (frame.kinds.includes('SUPPLIER') || frame.kinds.includes('SUBCONTRACTOR')) && frame.me.permissions.includes('portal.supplierProfile.view')
  if (!opens) return <Closed title={t('profile.title')} />
  return <ProfileContainer />
}

function Closed({ title }: { title: string }) {
  usePortalBand({ title })
  return <NotInAccessHere />
}

let made = 0
const newKey = () => `new-${Date.now().toString(36)}-${(made += 1)}`

function ProfileContainer() {
  const frame = usePortalFrame()
  const { api, me } = frame
  const t = useT(NS)
  const offline = useOffline()
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const people = usePortalPeople({ onReceipt: setReceipt, sees: t, unsavedId: 'profile-emails' })

  const [profile, setProfile] = useState<Load<SupplierProfile>>(loading)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [])

  const read = useCallback(async () => {
    try {
      setProfile({ state: 'ready', value: await fetchSupplierProfile(api) })
    } catch (error) {
      if (isApiError(error) && error.kind === 'forbidden') return setProfile({ state: 'error', value: null })
      setProfile((current) => (current.value ? current : { state: 'error', value: null }))
    }
  }, [api])
  useEffect(() => {
    void read()
  }, [read])
  // Our check approved or refused a change (or the office changed an address or a contact): the page reads again.
  usePortalLive({ onChange: (change) => (profile.value?.live.events.includes(change.type) ? void read() : undefined), onReconnect: () => void read() })

  const value = profile.value
  const facts = { preview: me.preview, offline, mayChange: value?.mayChange ?? false }
  const held = changeHeld(facts)
  const admins = people.admins.length > 0 ? people.admins : (frame.access?.admins ?? []).map((admin) => admin.displayName)

  // ── the changes typed here ──
  const [edits, setEdits] = useState<ProfileEdits>(NO_EDITS)
  const [addressSelected, setAddressSelected] = useState<string[]>([])
  const [contactSelected, setContactSelected] = useState<string[]>([])
  const [send, setSend] = useState<{ sending: boolean; failed: string | null }>({ sending: false, failed: null })
  const sendKey = useRef<string | null>(null)
  const addresses = useMemo(() => (value ? addressLines(value, edits, held) : []), [value, edits, held])
  const contacts = useMemo(() => (value ? contactLines(value, edits, held) : []), [value, edits, held])
  const count = editCount(edits)
  const sendWaits = sendHeld(edits, contacts, facts, send.sending)

  const sendNow = useCallback(async (): Promise<boolean> => {
    if (!value || count === 0) return true
    if (sendWaits) return false
    sendKey.current ??= newIdempotencyKey()
    setSend({ sending: true, failed: null })
    try {
      await sendChanges(api, changesBody(edits, value, ''), sendKey.current)
      sendKey.current = null
      setEdits(NO_EDITS)
      setAddressSelected([])
      setContactSelected([])
      setSend({ sending: false, failed: null })
      setReceipt({ tone: 'success', text: t('receipt.changesSent', { count }) })
      void read()
      return true
    } catch (error) {
      const kind = isApiError(error) ? error.kind : null
      if (kind && kind !== 'rate_limited') sendKey.current = null
      setSend({ sending: false, failed: kind === 'conflict' ? 'profile.failed.clash' : kind === 'invalid' ? 'profile.failed.invalid' : kind === 'forbidden' ? 'profile.failed.forbidden' : kind === 'rate_limited' ? 'profile.failed.wait' : 'profile.failed.network' })
      if (kind === 'conflict') void read()
      return false
    }
  }, [api, value, edits, count, sendWaits, t, read])

  usePortalUnsaved('profile-changes', { dirty: count > 0, what: t('unsaved.changes'), save: sendNow })

  // ── the page's own pop-ups (an address, a contact, withdraw) ──
  const [dialog, setDialog] = useState<Extract<ProfileDialog, { kind: 'address' | 'contact' | 'withdraw' }> | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  usePortalUnsaved('profile-dialog', { dirty: dialog?.kind === 'address' || dialog?.kind === 'contact', what: t('unsaved.dialog') })

  const editAddress = (row: AddressLine | null) => {
    if (held || (row && row.editHeld)) return
    const draft = row ? row.draft : EMPTY_ADDRESS
    setDialog({ kind: 'address', id: row?.id ?? null, draft, adding: row === null || row.saved === null, problems: addressProblems(draft, row === null || row.saved === null), showProblems: false })
  }
  const keepAddress = () => {
    const current = dialogRef.current
    if (current?.kind !== 'address') return
    const problems = addressProblems(current.draft, current.adding)
    if (Object.keys(problems).length > 0) return setDialog({ ...current, problems, showProblems: true })
    const saved = current.id ? value?.addresses.find((row) => row.id === current.id) : undefined
    setEdits((now) => withAddressEdit(now, saved ? { op: 'CHANGE', id: saved.id, version: saved.version, draft: current.draft } : { op: 'ADD', key: current.id ?? newKey(), draft: current.draft }, saved))
    setDialog(null)
  }
  const editContact = (row: ContactLine | null) => {
    if (held || (row && row.editHeld)) return
    const draft = row ? row.draft : EMPTY_CONTACT
    setDialog({ kind: 'contact', id: row?.id ?? null, draft, adding: row === null || row.saved === null, problems: contactProblems(draft), showProblems: false })
  }
  const keepContact = () => {
    const current = dialogRef.current
    if (current?.kind !== 'contact') return
    const problems = contactProblems(current.draft)
    if (Object.keys(problems).length > 0) return setDialog({ ...current, problems, showProblems: true })
    const saved = current.id ? value?.contacts.find((row) => row.id === current.id) : undefined
    setEdits((now) => withContactEdit(now, saved ? { op: 'CHANGE', id: saved.id, version: saved.version, draft: current.draft } : { op: 'ADD', key: current.id ?? newKey(), draft: current.draft }, saved))
    setDialog(null)
  }
  const removeAddresses = (rows: readonly AddressLine[]) => {
    setEdits((now) => rows.reduce((next, row) => (row.saved && !row.removeHeld ? withAddressEdit(next, { op: 'REMOVE', id: row.saved.id, version: row.saved.version }) : next), now))
    setAddressSelected([])
  }
  const removeContacts = (rows: readonly ContactLine[]) => {
    setEdits((now) => rows.reduce((next, row) => (row.saved && !row.removeHeld ? withContactEdit(next, { op: 'REMOVE', id: row.saved.id, version: row.saved.version }) : next), now))
    setContactSelected([])
  }

  const withdrawing = useRef<ChangeRequest | null>(null)
  const openWithdraw = (request: ChangeRequest) => {
    if (held) return
    withdrawing.current = request
    setDialog({ kind: 'withdraw', requestId: request.requestId, lines: changeLines(request.changes).map((line) => t(line.words.key, line.words.params)), busy: false, failed: null })
  }
  const withdraw = async () => {
    const current = dialogRef.current
    if (current?.kind !== 'withdraw') return
    setDialog({ ...current, busy: true, failed: null })
    try {
      await withdrawChanges(api, current.requestId, newIdempotencyKey())
      setDialog(null)
      setReceipt({ tone: 'success', text: t('receipt.withdrawn') })
      void read()
    } catch (error) {
      const kind = isApiError(error) ? error.kind : null
      setDialog((open) => (open?.kind === 'withdraw' ? { ...open, busy: false, failed: t(kind === 'conflict' ? 'profile.failed.decided' : kind === 'forbidden' ? 'profile.failed.forbidden' : 'profile.failed.network') } : open))
      if (kind === 'conflict') void read()
    }
  }

  // ── the band ──
  usePortalBand(
    profileBandOf({
      t,
      sending: send.sending || people.emailSaving,
      unsaved: count > 0 || people.emailDirty,
      waiting: (value?.pending.length ?? 0) > 0,
      saved: people.emailSavedAt !== null,
      inviteHeld: people.inviteHeld,
      onInvite: people.openInvite,
    }),
  )

  const websiteSaved = value?.company.website ?? ''
  const website = edits.website ?? websiteSaved
  return (
    <ProfileView
      bank={me.permissions.includes('portal.supplierBank.view') ? <SupplierBank /> : null}
      model={{
        slow,
        company: { state: profile.state, company: value?.company ?? null, website, websiteChanged: edits.website !== null, websiteProblem: edits.website !== null ? websiteProblemKey(edits.website) : null, addresses, selected: addressSelected, held, admins },
        contacts: { state: profile.state, rows: contacts, selected: contactSelected, held, admins, sameEmails: sameEmails(contacts) },
        changes: { pending: value?.pending ?? [], decided: value?.decided ?? [], held, admins },
        colleagues: people.colleagues,
        inviteHeld: people.inviteHeld,
        emails: people.emails,
        security: people.security,
        edit: { count, sending: send.sending, held: sendWaits, failed: send.failed },
        receipt,
        dialog: dialog ?? people.dialog,
      }}
      actions={{
        company: {
          onWebsite: (next) => setEdits((now) => ({ ...now, website: next.trim() === websiteSaved ? null : next })),
          onAdd: () => editAddress(null),
          onEdit: editAddress,
          onRemove: removeAddresses,
          onUndo: (row) => setEdits((now) => withoutEdit(now, 'addresses', row.id)),
          onSelected: setAddressSelected,
          onRetry: () => {
            setProfile(loading)
            void read()
          },
          onAsk: () => frame.ask(null),
        },
        contacts: {
          onAdd: () => editContact(null),
          onEdit: editContact,
          onRemove: removeContacts,
          onUndo: (row) => setEdits((now) => withoutEdit(now, 'contacts', row.id)),
          onSelected: setContactSelected,
          onRetry: () => {
            setProfile(loading)
            void read()
          },
        },
        onWithdraw: openWithdraw,
        colleagues: people.colleaguesActions,
        emails: people.emailActions,
        onSend: () => void sendNow(),
        onDiscard: () => {
          setEdits(NO_EDITS)
          setSend({ sending: false, failed: null })
        },
        onEndOthers: people.onEndOthers,
        onRetrySessions: people.onRetrySessions,
        onHideReceipt: () => setReceipt(null),
        dialogs: {
          ...people.dialogActions,
          onClose: () => (dialog ? setDialog((open) => (open?.kind === 'withdraw' && open.busy ? open : null)) : people.dialogActions.onClose?.()),
          onAddressText: (field, next) =>
            setDialog((open) => {
              if (open?.kind !== 'address') return open
              const draft = { ...open.draft, [field]: next }
              return { ...open, draft, problems: addressProblems(draft, open.adding) }
            }),
          onAddressKind: (kind, on) =>
            setDialog((open) => {
              if (open?.kind !== 'address') return open
              const draft = { ...open.draft, kinds: on ? [...new Set([...open.draft.kinds, kind])] : open.draft.kinds.filter((entry) => entry !== kind) }
              return { ...open, draft, problems: addressProblems(draft, open.adding) }
            }),
          onAddressKeep: keepAddress,
          onContactText: (field, next) =>
            setDialog((open) => {
              if (open?.kind !== 'contact') return open
              const draft = { ...open.draft, [field]: next }
              return { ...open, draft, problems: contactProblems(draft) }
            }),
          onContactRole: (role, on) =>
            setDialog((open) => {
              if (open?.kind !== 'contact') return open
              const draft = { ...open.draft, roles: on ? [...new Set([...open.draft.roles, role])] : open.draft.roles.filter((entry) => entry !== role) }
              return { ...open, draft, problems: contactProblems(draft) }
            }),
          onContactKeep: keepContact,
          onWithdrawConfirm: () => void withdraw(),
        },
      }}
    />
  )
}
