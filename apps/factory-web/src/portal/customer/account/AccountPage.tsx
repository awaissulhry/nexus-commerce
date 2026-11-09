'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useTheme } from '../../../lib/theme/use-theme'
import { usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { localeOfPerson } from '../../shell/model'
import { loading, usePortalPeople, type Load } from '../../shared/account/usePortalPeople'
import { failedWords } from '../../shared/account/words'
import { addAddress, archiveAddress, defaultAddress, fetchAddresses, fetchCompany, saveProfile, type CompanyData, type DeliveryAddresses } from './api'
import { addressBody, addressProblems, addressRows, addressTyped, companyRows, EMPTY_ADDRESS, profileBody, profileChanges, profileProblem, type AddressDraft, type AddressRow, type ProfileDraft } from './model'
import type { AccountDialog } from './view/AccountDialogs'
import { AccountView, type AccountViewModel } from './view/AccountView'

/**
 * The live Account page (B-W2b-196, SCR-188): reads each section on its own (one failing never empties another), keeps the
 * profile's draft (⌘S saves; leaving with changes asks — the frame's guard), delivery addresses with our check, the
 * company data. The colleagues, the admin's acts behind a fresh e-mail code, the e-mail settings and the person's sessions
 * are the shared account work (usePortalPeople, lifted by B-W2b-193 for the supplier's Profile). Live: our check of an
 * address reads the addresses again. The frame's band: the title, the save status, Invite a colleague (the admin's; held
 * for others with who can), ⋯ Ask a question (the account's conversation).
 */

type OwnDialog = Extract<AccountDialog, { kind: 'address' | 'remove' }>

export function AccountPage() {
  const frame = usePortalFrame()
  const { api, me } = frame
  const t = useT('portal-account')
  const locale = useLocale()
  const router = useRouter()
  const search = useSearchParams()
  const { mode: theme, setTheme } = useTheme()
  const readOnly = me.preview
  const can = useMemo(() => new Set(me.permissions), [me.permissions])

  const [receipt, setReceipt] = useState<AccountViewModel['receipt']>(null)
  const people = usePortalPeople({ onReceipt: setReceipt, unsavedId: 'account-emails' })

  // ── loads ──
  const [addresses, setAddresses] = useState<Load<DeliveryAddresses>>(loading)
  const [company, setCompany] = useState<Load<CompanyData>>(loading)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [])

  const readAddresses = useCallback(async () => {
    if (!can.has('portal.addresses.view')) return setAddresses({ state: 'ready', value: { addresses: [], canManage: false } })
    try {
      setAddresses({ state: 'ready', value: await fetchAddresses(api) })
    } catch {
      setAddresses((current) => (current.value ? current : { state: 'error', value: null }))
    }
  }, [api, can])
  const readCompany = useCallback(async () => {
    try {
      setCompany({ state: 'ready', value: (await fetchCompany(api)).company })
    } catch {
      setCompany({ state: 'error', value: null })
    }
  }, [api])

  useEffect(() => {
    void readAddresses()
    void readCompany()
  }, [readAddresses, readCompany])

  usePortalLive({
    onChange: (change) => {
      if (change.type === 'delivery_address.checked') void readAddresses()
    },
    onReconnect: () => void readAddresses(),
  })

  // ── my profile ──
  const saved: ProfileDraft = useMemo(() => ({ displayName: me.user.displayName, locale: localeOfPerson(me.user.locale) }), [me.user.displayName, me.user.locale])
  const [draft, setDraft] = useState<ProfileDraft>(saved)
  const [profile, setProfile] = useState<{ saving: boolean; failed: string | null; savedAt: number | null }>({ saving: false, failed: null, savedAt: null })
  // The frame's person changed (a refresh after the language): the draft follows what is saved.
  useEffect(() => setDraft(saved), [saved])
  const profileCount = profileChanges(saved, draft)
  const saveProfileNow = useCallback(async (): Promise<boolean> => {
    if (profileProblem(draft) || profileChanges(saved, draft) === 0) return profileChanges(saved, draft) === 0
    setProfile((current) => ({ ...current, saving: true, failed: null }))
    try {
      const answer = await saveProfile(api, profileBody(saved, draft))
      setProfile({ saving: false, failed: null, savedAt: Date.now() })
      // The frame reads the person again: the name in the top bar, the language of every page and of our mails.
      if (answer.changed) router.refresh()
      return true
    } catch (error) {
      setProfile((current) => ({ ...current, saving: false, failed: failedWords(error, t) }))
      return false
    }
  }, [api, draft, saved, router, t])

  // ⌘S: each card's EditModeBar saves its own (`saveShortcut`), both when both changed.
  usePortalUnsaved('account-profile', { dirty: profileCount > 0, what: t('unsaved.profile'), save: saveProfileNow })

  // ── the customer's own dialogs (a delivery address, removing addresses) ──
  const [dialog, setDialog] = useState<OwnDialog | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  usePortalUnsaved('account-address', { dirty: dialog?.kind === 'address' && addressTyped(dialog.draft), what: t('unsaved.address') })

  // ── delivery addresses ──
  const addressAnswer = addresses.value
  const canManageAddresses = !readOnly && addressAnswer?.canManage === true
  const [addressSelected, setAddressSelected] = useState<string[]>([])
  const addressKey = useRef(newIdempotencyKey())
  const rowsOfAddresses = useMemo(() => (addressAnswer ? addressRows(addressAnswer.addresses) : []), [addressAnswer])

  const openAddress = () => {
    addressKey.current = newIdempotencyKey()
    setDialog({ kind: 'address', draft: EMPTY_ADDRESS, problems: addressProblems(EMPTY_ADDRESS), showProblems: false, busy: false, failed: null })
  }
  const saveAddress = async () => {
    const current = dialogRef.current
    if (current?.kind !== 'address') return
    const problems = addressProblems(current.draft)
    if (Object.keys(problems).length > 0) return setDialog({ ...current, problems, showProblems: true })
    setDialog({ ...current, busy: true, failed: null })
    try {
      const made = await addAddress(api, addressBody(current.draft), addressKey.current)
      setDialog(null)
      setReceipt({ tone: 'success', text: t('receipt.addressAdded', { address: made.address.name ?? made.address.line1 }) })
      void readAddresses()
    } catch (error) {
      setDialog((open) => (open?.kind === 'address' ? { ...open, busy: false, failed: isApiError(error) && error.kind === 'invalid' ? t('address.failed.invalid') : failedWords(error, t) } : open))
    }
  }
  const makeDefault = async (row: AddressRow) => {
    try {
      setAddresses({ state: 'ready', value: await defaultAddress(api, row) })
      setReceipt({ tone: 'success', text: t('receipt.addressDefault', { address: row.name ?? row.line }) })
    } catch (error) {
      setReceipt({ tone: 'warning', text: failedWords(error, t) })
      void readAddresses()
    }
  }
  const removing = useRef<AddressRow[]>([])
  const openRemove = (rows: readonly AddressRow[]) => {
    removing.current = rows.filter((row) => row.state !== 'REFUSED' && row.state !== 'REMOVED')
    if (removing.current.length > 0) setDialog({ kind: 'remove', lines: removing.current.map((row) => [row.name, row.line].filter(Boolean).join(' — ')), busy: false, failed: null })
  }
  const remove = async () => {
    setDialog((open) => (open?.kind === 'remove' ? { ...open, busy: true, failed: null } : open))
    try {
      let last: DeliveryAddresses | null = null
      for (const row of removing.current) last = await archiveAddress(api, row)
      if (last) setAddresses({ state: 'ready', value: last })
      setDialog(null)
      setAddressSelected([])
      setReceipt({ tone: 'success', text: t('receipt.addressRemoved', { count: removing.current.length }) })
    } catch (error) {
      void readAddresses()
      setDialog((open) => (open?.kind === 'remove' ? { ...open, busy: false, failed: failedWords(error, t) } : open))
    }
  }

  // ── the band ──
  const saving = profile.saving || people.emailSaving
  const dirty = profileCount > 0 || people.emailDirty
  const savedAt = Math.max(profile.savedAt ?? 0, people.emailSavedAt ?? 0)
  usePortalBand({
    title: t('title'),
    status: saving ? { label: t('status.saving'), tone: 'info' } : dirty ? { label: t('status.unsaved'), tone: 'warning' } : savedAt > 0 ? { label: t('status.saved'), tone: 'success' } : null,
    actions: [{ id: 'invite', label: t('users.invite'), variant: 'primary', onClick: people.openInvite, heldReason: people.inviteHeld }],
    keys: [
      { keys: ['⌘', 'S'], words: t('keys.save') },
      { keys: ['Esc'], words: t('keys.cancel') },
    ],
  })

  // An address opened from a notification (`/open/PartyAddress/<id>` → `?address=<id>#addresses`): its row has the focus.
  const focusId = search?.get('address') ?? null

  const model: AccountViewModel = {
    slow,
    profile: {
      state: 'ready',
      email: me.user.email,
      emailBy: people.answer?.canManage ? { kind: 'us' } : { kind: 'admin', names: people.admins },
      draft,
      theme,
      changes: profileCount,
      problem: profileCount > 0 ? profileProblem(draft) : null,
      saving: profile.saving,
      failed: profile.failed,
      readOnly,
    },
    emails: people.emails,
    colleagues: people.colleagues,
    addresses: {
      state: addresses.state,
      rows: rowsOfAddresses.map((row) => ({
        ...row,
        addedWords: row.addedBy.kind === 'FACTORY' ? t('addresses.addedByUs') : row.addedBy.you ? t('addresses.addedByYou') : t('addresses.addedBy', { name: row.addedBy.name ?? '—' }),
        checkedWords: row.state === 'WAITING' && row.requestedAt ? t('addresses.askedOn', { date: formatDate(row.requestedAt, { locale }) }) : row.state === 'APPROVED' && row.decidedAt ? t('addresses.checkedOn', { date: formatDate(row.decidedAt, { locale }) }) : null,
      })),
      canManage: canManageAddresses,
      selected: addressSelected,
      readOnly,
      focusId,
    },
    company: { state: company.state, rows: company.value ? companyRows(company.value, locale) : [] },
    security: people.security,
    inviteHeld: people.inviteHeld,
    receipt,
    dialog: dialog ?? people.dialog,
  }

  return (
    <AccountView
      model={model}
      actions={{
        profile: {
          onName: (value) => setDraft((current) => ({ ...current, displayName: value })),
          onLocale: (value) => setDraft((current) => ({ ...current, locale: value })),
          onTheme: setTheme,
          onSave: () => void saveProfileNow(),
          onDiscard: () => {
            setDraft(saved)
            setProfile((current) => ({ ...current, failed: null }))
          },
        },
        emails: people.emailActions,
        colleagues: people.colleaguesActions,
        addresses: {
          onSelected: setAddressSelected,
          onAdd: openAddress,
          onDefault: (row) => void makeDefault(row),
          onRemove: openRemove,
          onRetry: () => {
            setAddresses(loading)
            void readAddresses()
          },
        },
        dialogs: {
          ...people.dialogActions,
          onClose: () => (dialog ? setDialog(null) : people.dialogActions.onClose?.()),
          onAddressField: (field, value) =>
            setDialog((open) => {
              if (open?.kind !== 'address') return open
              const next = { ...open.draft, [field]: value } as AddressDraft
              return { ...open, draft: next, problems: addressProblems(next), failed: null }
            }),
          onAddressSave: () => void saveAddress(),
          onRemoveConfirm: () => void remove(),
        },
        onAskCompany: () => frame.ask(null),
        onRetryCompany: () => {
          setCompany(loading)
          void readCompany()
        },
        onEndOthers: people.onEndOthers,
        onRetrySessions: people.onRetrySessions,
        onHideReceipt: () => setReceipt(null),
      }}
    />
  )
}
