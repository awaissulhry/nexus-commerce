'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath, type ApiError } from '../../../lib/api/errors'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Translate } from '../../../lib/i18n/messages'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useTheme } from '../../../lib/theme/use-theme'
import { fetchEmailSettings, saveEmailSettings, type EmailFrequency, type EmailSettings } from '../../shell/api'
import { usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { allNonEssentialOff, emailChanges, emailDraftOf, localeOfPerson, withNonEssential, type EmailDraft } from '../../shell/model'
import {
  addAddress,
  archiveAddress,
  assignTask,
  changeColleague,
  deactivateColleague,
  defaultAddress,
  endOtherSessions,
  fetchAddresses,
  fetchColleagues,
  fetchCompany,
  fetchHandover,
  fetchOpenTasks,
  fetchSessions,
  inviteColleague,
  proveStepUp,
  saveProfile,
  startStepUp,
  type Colleagues,
  type CompanyData,
  type DeliveryAddresses,
  type OfferedRole,
  type PortalSessionRow,
} from './api'
import {
  addressBody,
  addressProblems,
  addressRows,
  addressTyped,
  adminNames,
  colleagueRows,
  companyRows,
  EMPTY_ADDRESS,
  handoverSummary,
  inviteProblems,
  maskedEmail,
  profileBody,
  profileChanges,
  profileProblem,
  raisesToAdmin,
  roleChoices,
  seatsHeld,
  sessionRows,
  stepUpFresh,
  tasksToMove,
  type AddressDraft,
  type AddressRow,
  type ColleagueRow,
  type InviteDraft,
  type ProfileDraft,
} from './model'
import type { CardState } from './view/AccountCards'
import type { AccountDialog, RoleChoice } from './view/AccountDialogs'
import { AccountView, type AccountViewModel } from './view/AccountView'

/**
 * The live Account page (B-W2b-196, SCR-188): reads each section on its own (one failing never empties another), keeps the
 * profile's and the e-mail settings' drafts (⌘S saves; leaving with changes asks — the frame's guard), the admin's acts on
 * colleagues behind a fresh e-mail code (the step-up, asked first when the session has none fresh, and again when the API
 * says so), the open requests of a colleague who leaves (handed to a chosen colleague first, F14), delivery addresses with
 * our check, the company data, the person's sessions. Live: our check of an address and a colleague invited or changed read
 * their section again. The frame's band: the title, the save status, Invite a colleague (the admin's; held for others with
 * who can), ⋯ Ask a question (the account's conversation).
 */

type Load<T> = { state: CardState; value: T | null }
const loading = <T,>(): Load<T> => ({ state: 'loading', value: null })

export function AccountPage() {
  const frame = usePortalFrame()
  const { api, me } = frame
  const t = useT('portal-account')
  const roleWords = useT('portal')
  const locale = useLocale()
  const router = useRouter()
  const search = useSearchParams()
  const { mode: theme, setTheme } = useTheme()
  const readOnly = me.preview
  const can = useMemo(() => new Set(me.permissions), [me.permissions])

  // ── loads ──
  const [colleagues, setColleagues] = useState<Load<Colleagues>>(loading)
  const [addresses, setAddresses] = useState<Load<DeliveryAddresses>>(loading)
  const [company, setCompany] = useState<Load<CompanyData>>(loading)
  const [sessions, setSessions] = useState<Load<PortalSessionRow[]>>(loading)
  const [email, setEmail] = useState<{ state: CardState; settings: EmailSettings | null; draft: EmailDraft; saving: boolean; failed: string | null }>({ state: 'loading', settings: null, draft: {}, saving: false, failed: null })
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [])

  const readColleagues = useCallback(async () => {
    try {
      setColleagues({ state: 'ready', value: await fetchColleagues(api) })
    } catch {
      setColleagues((current) => (current.value ? current : { state: 'error', value: null }))
    }
  }, [api])
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
  const readSessions = useCallback(async () => {
    try {
      setSessions({ state: 'ready', value: (await fetchSessions(api)).sessions })
    } catch {
      setSessions((current) => (current.value ? current : { state: 'error', value: null }))
    }
  }, [api])
  const readEmail = useCallback(async () => {
    if (readOnly) return setEmail((current) => ({ ...current, state: 'ready' }))
    setEmail((current) => ({ ...current, state: 'loading', failed: null }))
    try {
      const settings = await fetchEmailSettings(api)
      setEmail({ state: 'ready', settings, draft: emailDraftOf(settings), saving: false, failed: null })
    } catch {
      setEmail((current) => ({ ...current, state: 'error' }))
    }
  }, [api, readOnly])

  useEffect(() => {
    void readColleagues()
    void readAddresses()
    void readCompany()
    void readSessions()
    void readEmail()
  }, [readColleagues, readAddresses, readCompany, readSessions, readEmail])

  usePortalLive({
    onChange: (change) => {
      if (change.type === 'delivery_address.checked') void readAddresses()
      if (change.type === 'partner_user.invited' || change.type === 'partner_user.changed') void readColleagues()
    },
    onReconnect: () => {
      void readColleagues()
      void readAddresses()
    },
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

  // ── e-mail settings ──
  const emailChanged = email.settings ? emailChanges(email.settings, email.draft) : []
  const saveEmailNow = useCallback(async (): Promise<boolean> => {
    if (!email.settings) return true
    const changes = emailChanges(email.settings, email.draft)
    if (changes.length === 0) return true
    setEmail((current) => ({ ...current, saving: true, failed: null }))
    try {
      const settings = await saveEmailSettings(api, { topics: changes })
      setEmail({ state: 'ready', settings, draft: emailDraftOf(settings), saving: false, failed: null })
      setProfile((current) => ({ ...current, savedAt: Date.now() }))
      return true
    } catch (error) {
      setEmail((current) => ({ ...current, saving: false, failed: isApiError(error) && error.kind === 'invalid' ? t('emails.refused') : failedWords(error, t) }))
      return false
    }
  }, [api, email.settings, email.draft, t])

  // ⌘S: each card's EditModeBar saves its own (`saveShortcut`), both when both changed.
  usePortalUnsaved('account-profile', { dirty: profileCount > 0, what: t('unsaved.profile'), save: saveProfileNow })
  usePortalUnsaved('account-emails', { dirty: emailChanged.length > 0, what: t('unsaved.emails'), save: saveEmailNow })

  // ── dialogs, the step-up and the receipt ──
  const [dialog, setDialog] = useState<AccountDialog | null>(null)
  const [receipt, setReceipt] = useState<AccountViewModel['receipt']>(null)
  const [stepUpUntil, setStepUpUntil] = useState<string | null>(me.session.stepUpUntil)
  const pending = useRef<{ work: () => Promise<void>; back: AccountDialog | null } | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  usePortalUnsaved('account-address', { dirty: dialog?.kind === 'address' && addressTyped(dialog.draft), what: t('unsaved.address') })

  const askStepUp = useCallback(
    async (work: () => Promise<void>) => {
      pending.current = { work, back: dialogRef.current }
      setDialog({ kind: 'stepUp', to: maskedEmail(me.user.email), busy: true, error: null })
      try {
        await startStepUp(api)
        setDialog({ kind: 'stepUp', to: maskedEmail(me.user.email), busy: false, error: null })
      } catch (error) {
        setDialog({ kind: 'stepUp', to: maskedEmail(me.user.email), busy: false, error: isApiError(error) && error.kind === 'rate_limited' ? t('stepUp.wait') : t('stepUp.sendFailed') })
      }
    },
    [api, me.user.email, t],
  )

  /** An admin act: a fresh step-up first (5 minutes), asked again when the API says so. */
  const withStepUp = useCallback(
    async (work: () => Promise<void>) => {
      if (!stepUpFresh(stepUpUntil, Date.now())) return askStepUp(work)
      try {
        await work()
      } catch (error) {
        if (isApiError(error) && error.kind === 'step_up') return askStepUp(work)
        throw error
      }
    },
    [stepUpUntil, askStepUp],
  )

  const onStepUpCode = async (code: string) => {
    setDialog((current) => (current?.kind === 'stepUp' ? { ...current, busy: true, error: null } : current))
    try {
      const proved = await proveStepUp(api, code)
      setStepUpUntil(proved.stepUpUntil)
      const next = pending.current
      pending.current = null
      setDialog(next?.back ?? null)
      if (next) {
        try {
          await next.work()
        } catch {
          // The work says its own failure in its dialog.
        }
      }
    } catch (error) {
      setDialog((current) => (current?.kind === 'stepUp' ? { ...current, busy: false, error: stepUpWords(error, t) } : current))
    }
  }

  const close = () => {
    if (dialog?.kind === 'stepUp') pending.current = null
    setDialog(null)
  }

  // ── colleagues ──
  const answer = colleagues.value
  const canManage = !readOnly && answer?.canManage === true
  const admins = answer ? adminNames(answer) : []
  const roles = useMemo<RoleChoice[]>(() => roleChoices(answer?.roles ?? []).map((role) => roleChoiceOf(role, roleWords, t)), [answer?.roles, roleWords, t])
  const [peopleSelected, setPeopleSelected] = useState<string[]>([])
  const inviteHeld = readOnly
    ? t('held.preview')
    : !answer
      ? t('held.loading')
      : !canManage
        ? admins.length > 0
          ? t('held.adminInvites', { names: admins.join(', ') })
          : t('held.adminInvitesNone')
        : seatsHeld(answer.seats)
          ? t('held.seats', { max: answer.seats?.max ?? 0 })
          : roles.length === 0
            ? t('held.noRoles')
            : null
  const inviteKey = useRef(newIdempotencyKey())

  const openInvite = () => {
    if (inviteHeld) return
    inviteKey.current = newIdempotencyKey()
    const first = roles.find((role) => !role.admin)?.key ?? roles[0]?.key ?? ''
    const draft: InviteDraft = { displayName: '', email: '', locale, roleKey: first }
    setDialog({ kind: 'invite', draft, roles, problems: inviteProblems(draft), showProblems: false, busy: false, failed: null })
  }

  const sendInvite = async () => {
    const current = dialogRef.current
    if (current?.kind !== 'invite') return
    const problems = inviteProblems(current.draft)
    if (Object.keys(problems).length > 0) return setDialog({ ...current, problems, showProblems: true })
    const body = { displayName: current.draft.displayName.trim(), email: current.draft.email.trim(), locale: current.draft.locale, roleKey: current.draft.roleKey }
    await withStepUp(async () => {
      setDialog((open) => (open?.kind === 'invite' ? { ...open, busy: true, failed: null } : open))
      try {
        const sent = await inviteColleague(api, body, inviteKey.current)
        setDialog(null)
        setReceipt({ tone: 'success', text: t('receipt.invited', { name: body.displayName, email: sent.invitation.email, date: formatDate(sent.invitation.expiresAt, { locale }) }) })
        void readColleagues()
      } catch (error) {
        if (isApiError(error) && error.kind === 'step_up') {
          setDialog((open) => (open?.kind === 'invite' ? { ...open, busy: false } : open))
          throw error
        }
        setDialog((open) => (open?.kind === 'invite' ? { ...open, busy: false, failed: inviteFailed(error, t) } : open))
      }
    })
  }

  const openRole = (row: ColleagueRow) => setDialog({ kind: 'role', person: { id: row.id, name: row.name }, current: row.roleKey, choice: row.roleKey ?? '', roles, busy: false, failed: null })

  const changeRole = async (person: { id: string; name: string }, roleKey: string) => {
    const row = answer?.people.find((entry) => entry.id === person.id)
    if (!row) return
    await withStepUp(async () => {
      setDialog((open) => (open?.kind === 'role' || open?.kind === 'raise' ? { ...open, busy: true, failed: null } : open))
      try {
        await changeColleague(api, person.id, { roleKey, version: row.version })
        setDialog(null)
        setReceipt({ tone: 'success', text: t('receipt.roleChanged', { name: person.name, role: roleWords(`role.${roleKey}`) }) })
        void readColleagues()
      } catch (error) {
        if (isApiError(error) && error.kind === 'step_up') {
          setDialog((open) => (open?.kind === 'role' || open?.kind === 'raise' ? { ...open, busy: false } : open))
          throw error
        }
        if (isApiError(error) && error.kind === 'conflict') void readColleagues()
        setDialog((open) => (open?.kind === 'role' || open?.kind === 'raise' ? { ...open, busy: false, failed: failedWords(error, t) } : open))
      }
    })
  }

  const saveRole = () => {
    const current = dialogRef.current
    if (current?.kind !== 'role' || current.choice === current.current || current.choice === '') return
    // pop:role-raise — making someone the admin asks first.
    if (raisesToAdmin(answer?.roles ?? [], current.current, current.choice)) {
      roleChoice.current = current.choice
      return setDialog({ kind: 'raise', person: current.person, busy: false, failed: null })
    }
    void changeRole(current.person, current.choice)
  }
  const roleChoice = useRef<string>('')

  const handoverReads = useRef<{ userId: string; handover: Awaited<ReturnType<typeof fetchHandover>> }[]>([])
  const readHandover = async (people: readonly { id: string; name: string }[]) => {
    setDialog({ kind: 'deactivate', people, state: 'loading', summary: null, choice: '', busy: false, failed: null })
    try {
      const reads = await Promise.all(people.map(async (person) => ({ userId: person.id, handover: await fetchHandover(api, person.id) })))
      handoverReads.current = reads
      setDialog((open) => (open?.kind === 'deactivate' ? { ...open, state: 'ready', summary: handoverSummary(reads, locale) } : open))
    } catch (error) {
      // The hand-over read needs the admin's permission: a step-up is not needed to read it.
      setDialog((open) => (open?.kind === 'deactivate' ? { ...open, state: 'error', failed: isApiError(error) && error.kind === 'forbidden' ? t('failed.forbidden') : null } : open))
    }
  }

  const openDeactivate = (rows: readonly ColleagueRow[]) => {
    const people = rows.filter((row) => !row.you && row.status !== 'DEACTIVATED').map((row) => ({ id: row.id, name: row.name }))
    if (people.length > 0) void readHandover(people)
  }

  const deactivate = async () => {
    const current = dialogRef.current
    if (current?.kind !== 'deactivate' || current.state !== 'ready') return
    const people = current.people
    const choice = current.choice
    await withStepUp(async () => {
      setDialog((open) => (open?.kind === 'deactivate' ? { ...open, busy: true, failed: null } : open))
      try {
        // The requests handed to them go to the chosen colleague first; deactivating gives any left back to everyone (F14).
        let notMoved = 0
        if (choice !== '') {
          const tasks = tasksToMove((await fetchOpenTasks(api)).items, people.map((person) => person.id))
          for (const task of tasks) {
            try {
              await assignTask(api, task, choice)
            } catch (error) {
              if (isApiError(error) && error.kind === 'step_up') throw error
              notMoved += 1
            }
          }
        }
        const fresh = await fetchColleagues(api)
        for (const person of people) {
          const row = fresh.people.find((entry) => entry.id === person.id)
          if (row && row.status !== 'DEACTIVATED') await deactivateColleague(api, person.id, row.version)
        }
        setDialog(null)
        setPeopleSelected([])
        const names = people.map((person) => person.name).join(', ')
        setReceipt(notMoved > 0 ? { tone: 'warning', text: t('receipt.deactivatedNotMoved', { names, count: notMoved }) } : { tone: 'success', text: t('receipt.deactivated', { names, count: people.length }) })
        void readColleagues()
      } catch (error) {
        if (isApiError(error) && error.kind === 'step_up') {
          setDialog((open) => (open?.kind === 'deactivate' ? { ...open, busy: false } : open))
          throw error
        }
        void readColleagues()
        setDialog((open) => (open?.kind === 'deactivate' ? { ...open, busy: false, failed: failedWords(error, t) } : open))
      }
    })
  }

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

  // ── sessions ──
  const sessionList = sessions.value ?? []
  const others = sessionList.filter((row) => !row.current).length
  const endOthers = async () => {
    setDialog((open) => (open?.kind === 'endOthers' ? { ...open, busy: true, failed: null } : open))
    try {
      const ended = await endOtherSessions(api)
      setDialog(null)
      setReceipt({ tone: 'success', text: t('receipt.endedOthers', { count: ended.ended }) })
      void readSessions()
    } catch (error) {
      setDialog((open) => (open?.kind === 'endOthers' ? { ...open, busy: false, failed: failedWords(error, t) } : open))
    }
  }

  // ── the band ──
  const saving = profile.saving || email.saving
  const dirty = profileCount > 0 || emailChanged.length > 0
  usePortalBand({
    title: t('title'),
    status: saving ? { label: t('status.saving'), tone: 'info' } : dirty ? { label: t('status.unsaved'), tone: 'warning' } : profile.savedAt ? { label: t('status.saved'), tone: 'success' } : null,
    actions: [{ id: 'invite', label: t('users.invite'), variant: 'primary', onClick: openInvite, heldReason: inviteHeld }],
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
      emailBy: answer?.canManage ? { kind: 'us' } : { kind: 'admin', names: admins },
      draft,
      theme,
      changes: profileCount,
      problem: profileCount > 0 ? profileProblem(draft) : null,
      saving: profile.saving,
      failed: profile.failed,
      readOnly,
    },
    emails: {
      state: email.state,
      topics: (email.settings?.topics ?? []).map((topic) => ({ topic: topic.topic, name: topic.words[locale], frequency: (email.draft[topic.topic] ?? topic.frequency) as EmailFrequency, locked: topic.locked, reason: topic.reason ? topic.reason[locale] : null })),
      allOff: email.settings ? allNonEssentialOff(email.settings, email.draft) : false,
      changes: emailChanged.length,
      saving: email.saving,
      failed: email.failed,
      readOnly,
    },
    colleagues: {
      state: colleagues.state,
      rows: answer ? colleagueRows(answer).map((row) => ({ ...row, lastSignIn: row.lastSignInAt ? formatDateTime(row.lastSignInAt, { locale }) : null, invitationEnds: row.invitationExpiresAt ? formatDate(row.invitationExpiresAt, { locale }) : null })) : [],
      canManage,
      admins,
      seats: canManage ? (answer?.seats ?? null) : null,
      selected: peopleSelected,
      readOnly,
    },
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
    security: {
      state: readOnly ? 'ready' : sessions.state,
      sessions: sessionRows(sessionList).map((row) => ({ ...row, started: formatDateTime(row.startedAt, { locale }), lastSeen: formatDateTime(row.lastSeenAt, { locale }) })),
      others,
      readOnly,
    },
    inviteHeld,
    receipt,
    dialog,
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
        emails: {
          onChange: (topic, frequency) => setEmail((current) => ({ ...current, draft: { ...current.draft, [topic]: frequency } })),
          onAllOff: (off) => setEmail((current) => (current.settings ? { ...current, draft: withNonEssential(current.settings, current.draft, off) } : current)),
          onSave: () => void saveEmailNow(),
          onDiscard: () => setEmail((current) => (current.settings ? { ...current, draft: emailDraftOf(current.settings), failed: null } : current)),
          onRetry: () => void readEmail(),
        },
        colleagues: {
          onSelected: setPeopleSelected,
          onInvite: openInvite,
          onChangeRole: openRole,
          onDeactivate: openDeactivate,
          onRetry: () => {
            setColleagues(loading)
            void readColleagues()
          },
        },
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
          onClose: close,
          onInviteField: (field, value) =>
            setDialog((open) => {
              if (open?.kind !== 'invite') return open
              const next = { ...open.draft, [field]: value } as InviteDraft
              return { ...open, draft: next, problems: inviteProblems(next), failed: null }
            }),
          onInviteSend: () => void sendInvite(),
          onRoleChoice: (key) => setDialog((open) => (open?.kind === 'role' ? { ...open, choice: key, failed: null } : open)),
          onRoleSave: saveRole,
          onRaiseConfirm: () => {
            const current = dialogRef.current
            if (current?.kind === 'raise') void changeRole(current.person, roleChoice.current)
          },
          onHandoverChoice: (id) => setDialog((open) => (open?.kind === 'deactivate' ? { ...open, choice: id } : open)),
          onDeactivateConfirm: () => void deactivate(),
          onHandoverRetry: () => {
            const current = dialogRef.current
            if (current?.kind === 'deactivate') void readHandover(current.people)
          },
          onAddressField: (field, value) =>
            setDialog((open) => {
              if (open?.kind !== 'address') return open
              const next = { ...open.draft, [field]: value } as AddressDraft
              return { ...open, draft: next, problems: addressProblems(next), failed: null }
            }),
          onAddressSave: () => void saveAddress(),
          onRemoveConfirm: () => void remove(),
          onEndOthersConfirm: () => void endOthers(),
          onStepUpCode: (code) => void onStepUpCode(code),
        },
        onAskCompany: () => frame.ask(null),
        onRetryCompany: () => {
          setCompany(loading)
          void readCompany()
        },
        onEndOthers: () => others > 0 && !readOnly && setDialog({ kind: 'endOthers', count: others, busy: false, failed: null }),
        onRetrySessions: () => {
          setSessions(loading)
          void readSessions()
        },
        onHideReceipt: () => setReceipt(null),
      }}
    />
  )
}

type Words = Translate

/** A role as the invite and the role change offer it: its name, and what it sees in our words. */
function roleChoiceOf(role: OfferedRole, roleWords: Words, t: Words): RoleChoice {
  const sees = `role.sees.${role.key}`
  const known = t(sees) !== sees
  return { key: role.key, name: roleWords(`role.${role.key}`), sees: known ? t(sees) : t(role.seesPrices ? 'role.sees.withPrices' : 'role.sees.noPrices'), seesPrices: role.seesPrices, admin: role.admin }
}

/** A failure in our words (never the API's English). */
function failedWords(error: unknown, t: Words): string {
  if (!isApiError(error)) return t('failed.network')
  const kind: ApiError['kind'] = error.kind
  if (kind === 'conflict') return t('failed.conflict')
  if (kind === 'forbidden' || kind === 'step_up') return t('failed.forbidden')
  if (kind === 'not_found') return t('failed.gone')
  if (kind === 'invalid') return t('failed.invalid')
  if (kind === 'rate_limited') return t('failed.wait')
  if (kind === 'signed_out') return t('failed.signedOut')
  return t('failed.network')
}

function inviteFailed(error: unknown, t: Words): string {
  if (isApiError(error) && error.kind === 'conflict') return error.issues.some((issue) => issuePath(issue) === 'email') ? t('invite.failed.address') : t('invite.failed.seats')
  if (isApiError(error) && error.kind === 'invalid') return t('invite.failed.invalid')
  return failedWords(error, t)
}

function stepUpWords(error: unknown, t: Words): string {
  if (!isApiError(error)) return t('failed.network')
  if (error.kind === 'rate_limited') return t('stepUp.wait')
  const path = error.issues.map(issuePath).find((value) => value.startsWith('code')) ?? ''
  if (path === 'code/TRIED_OUT') return t('stepUp.triedOut')
  if (path === 'code/EXPIRED' || path === 'code/USED' || path === 'code/NONE') return t('stepUp.expired')
  return t('stepUp.wrong')
}
