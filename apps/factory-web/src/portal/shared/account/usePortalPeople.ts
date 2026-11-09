'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Translate } from '../../../lib/i18n/messages'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { fetchEmailSettings, saveEmailSettings, type EmailFrequency, type EmailSettings } from '../../shell/api'
import { usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { allNonEssentialOff, emailChanges, emailDraftOf, withNonEssential, type EmailDraft } from '../../shell/model'
import {
  assignTask,
  changeColleague,
  deactivateColleague,
  endOtherSessions,
  fetchColleagues,
  fetchHandover,
  fetchOpenTasks,
  fetchSessions,
  inviteColleague,
  proveStepUp,
  startStepUp,
  type Colleagues,
  type PortalSessionRow,
} from './api'
import { adminNames, colleagueRows, handoverSummary, inviteProblems, maskedEmail, raisesToAdmin, roleChoices, seatsHeld, sessionRows, stepUpFresh, tasksToMove, type ColleagueRow, type InviteDraft } from './model'
import type { CardState } from './view/AccountCard'
import type { ColleaguesActions, ColleaguesModel } from './view/ColleaguesSection'
import type { PeopleDialog, PeopleDialogActions, RoleChoice } from './view/PeopleDialogs'
import type { EmailCardActions, EmailCardModel, SecurityCardModel } from './view/SettingsCards'
import { failedWords, inviteFailed, roleChoiceOf, stepUpWords } from './words'

/**
 * The account work every partner kind's page shares (lifted from the customer's Account container, B-W2b-196, by B-W2b-193
 * for the supplier's Profile): the organisation's colleagues (read; the admin invites, changes a role, deactivates — the
 * requests handed to a leaver move to a chosen colleague first, F14), every admin act behind a fresh e-mail code (asked
 * first when the session has none fresh, and again when the API says so), the person's e-mail settings (⌘S; leaving with
 * changes asks — the frame's guard) and their sessions (Sign out the others). Each part reads on its own (one failing never
 * empties another). Live: a colleague invited or changed reads the list again; a reconnect too. What just happened goes to
 * the page's receipt (`onReceipt`).
 */

export type Load<T> = { state: CardState; value: T | null }
export const loading = <T,>(): Load<T> => ({ state: 'loading', value: null })
export type Receipt = { tone: 'success' | 'warning'; text: string }

export interface PortalPeopleOptions {
  /** What just happened, in words, for the page's receipt banner. */
  onReceipt: (receipt: Receipt) => void
  /** The host's words for what each role covers (`role.sees.<key>`); default the `portal-account` ones. */
  sees?: Translate
  /** The frame's unsaved-guard id of the e-mail settings card. */
  unsavedId: string
}

export interface PortalPeople {
  colleagues: ColleaguesModel
  colleaguesActions: ColleaguesActions
  /** The read colleagues (the admins for "Your admin is …"; null before the first read). */
  answer: Colleagues | null
  admins: string[]
  canManage: boolean
  /** Why "Invite a colleague" waits, or null. */
  inviteHeld: string | null
  openInvite: () => void
  emails: EmailCardModel
  emailActions: EmailCardActions
  /** When the e-mail settings were last saved in this visit (the band's "Saved"). */
  emailSavedAt: number | null
  emailDirty: boolean
  emailSaving: boolean
  security: SecurityCardModel
  onEndOthers: () => void
  onRetrySessions: () => void
  dialog: PeopleDialog | null
  dialogActions: PeopleDialogActions
}

export function usePortalPeople({ onReceipt, sees, unsavedId }: PortalPeopleOptions): PortalPeople {
  const { api, me } = usePortalFrame()
  const t = useT('portal-account')
  const roleWords = useT('portal')
  const locale = useLocale()
  const readOnly = me.preview
  const receiptRef = useRef(onReceipt)
  receiptRef.current = onReceipt
  const say = useCallback((receipt: Receipt) => receiptRef.current(receipt), [])

  // ── loads ──
  const [colleagues, setColleagues] = useState<Load<Colleagues>>(loading)
  const [sessions, setSessions] = useState<Load<PortalSessionRow[]>>(loading)
  const [email, setEmail] = useState<{ state: CardState; settings: EmailSettings | null; draft: EmailDraft; saving: boolean; failed: string | null; savedAt: number | null }>({ state: 'loading', settings: null, draft: {}, saving: false, failed: null, savedAt: null })

  const readColleagues = useCallback(async () => {
    try {
      setColleagues({ state: 'ready', value: await fetchColleagues(api) })
    } catch {
      setColleagues((current) => (current.value ? current : { state: 'error', value: null }))
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
      setEmail((current) => ({ ...current, state: 'ready', settings, draft: emailDraftOf(settings), saving: false, failed: null }))
    } catch {
      setEmail((current) => ({ ...current, state: 'error' }))
    }
  }, [api, readOnly])

  useEffect(() => {
    void readColleagues()
    void readSessions()
    void readEmail()
  }, [readColleagues, readSessions, readEmail])

  usePortalLive({
    onChange: (change) => {
      if (change.type === 'partner_user.invited' || change.type === 'partner_user.changed') void readColleagues()
    },
    onReconnect: () => void readColleagues(),
  })

  // ── e-mail settings ──
  const emailChanged = email.settings ? emailChanges(email.settings, email.draft) : []
  const saveEmailNow = useCallback(async (): Promise<boolean> => {
    if (!email.settings) return true
    const changes = emailChanges(email.settings, email.draft)
    if (changes.length === 0) return true
    setEmail((current) => ({ ...current, saving: true, failed: null }))
    try {
      const settings = await saveEmailSettings(api, { topics: changes })
      setEmail({ state: 'ready', settings, draft: emailDraftOf(settings), saving: false, failed: null, savedAt: Date.now() })
      return true
    } catch (error) {
      setEmail((current) => ({ ...current, saving: false, failed: isApiError(error) && error.kind === 'invalid' ? t('emails.refused') : failedWords(error, t) }))
      return false
    }
  }, [api, email.settings, email.draft, t])
  usePortalUnsaved(unsavedId, { dirty: emailChanged.length > 0, what: t('unsaved.emails'), save: saveEmailNow })

  // ── dialogs and the step-up ──
  const [dialog, setDialog] = useState<PeopleDialog | null>(null)
  const [stepUpUntil, setStepUpUntil] = useState<string | null>(me.session.stepUpUntil)
  const pending = useRef<{ work: () => Promise<void>; back: PeopleDialog | null } | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog

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
  const roles = useMemo<RoleChoice[]>(() => roleChoices(answer?.roles ?? []).map((role) => roleChoiceOf(role, roleWords, t, sees)), [answer?.roles, roleWords, t, sees])
  const [selected, setSelected] = useState<string[]>([])
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
        say({ tone: 'success', text: t('receipt.invited', { name: body.displayName, email: sent.invitation.email, date: formatDate(sent.invitation.expiresAt, { locale }) }) })
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
        say({ tone: 'success', text: t('receipt.roleChanged', { name: person.name, role: roleWords(`role.${roleKey}`) }) })
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

  const roleChoice = useRef<string>('')
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

  const readHandover = async (people: readonly { id: string; name: string }[]) => {
    setDialog({ kind: 'deactivate', people, state: 'loading', summary: null, choice: '', busy: false, failed: null })
    try {
      const reads = await Promise.all(people.map(async (person) => ({ userId: person.id, handover: await fetchHandover(api, person.id) })))
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
        setSelected([])
        const names = people.map((person) => person.name).join(', ')
        say(notMoved > 0 ? { tone: 'warning', text: t('receipt.deactivatedNotMoved', { names, count: notMoved }) } : { tone: 'success', text: t('receipt.deactivated', { names, count: people.length }) })
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

  // ── sessions ──
  const sessionList = sessions.value ?? []
  const others = sessionList.filter((row) => !row.current).length
  const endOthers = async () => {
    setDialog((open) => (open?.kind === 'endOthers' ? { ...open, busy: true, failed: null } : open))
    try {
      const ended = await endOtherSessions(api)
      setDialog(null)
      say({ tone: 'success', text: t('receipt.endedOthers', { count: ended.ended }) })
      void readSessions()
    } catch (error) {
      setDialog((open) => (open?.kind === 'endOthers' ? { ...open, busy: false, failed: failedWords(error, t) } : open))
    }
  }

  return {
    colleagues: {
      state: colleagues.state,
      rows: answer ? colleagueRows(answer).map((row) => ({ ...row, lastSignIn: row.lastSignInAt ? formatDateTime(row.lastSignInAt, { locale }) : null, invitationEnds: row.invitationExpiresAt ? formatDate(row.invitationExpiresAt, { locale }) : null })) : [],
      canManage,
      admins,
      seats: canManage ? (answer?.seats ?? null) : null,
      selected,
      readOnly,
    },
    colleaguesActions: {
      onSelected: setSelected,
      onInvite: openInvite,
      onChangeRole: openRole,
      onDeactivate: openDeactivate,
      onRetry: () => {
        setColleagues(loading)
        void readColleagues()
      },
    },
    answer,
    admins,
    canManage,
    inviteHeld,
    openInvite,
    emails: {
      state: email.state,
      topics: (email.settings?.topics ?? []).map((topic) => ({ topic: topic.topic, name: topic.words[locale], frequency: (email.draft[topic.topic] ?? topic.frequency) as EmailFrequency, locked: topic.locked, reason: topic.reason ? topic.reason[locale] : null })),
      allOff: email.settings ? allNonEssentialOff(email.settings, email.draft) : false,
      changes: emailChanged.length,
      saving: email.saving,
      failed: email.failed,
      readOnly,
    },
    emailActions: {
      onChange: (topic, frequency) => setEmail((current) => ({ ...current, draft: { ...current.draft, [topic]: frequency } })),
      onAllOff: (off) => setEmail((current) => (current.settings ? { ...current, draft: withNonEssential(current.settings, current.draft, off) } : current)),
      onSave: () => void saveEmailNow(),
      onDiscard: () => setEmail((current) => (current.settings ? { ...current, draft: emailDraftOf(current.settings), failed: null } : current)),
      onRetry: () => void readEmail(),
    },
    emailSavedAt: email.savedAt,
    emailDirty: emailChanged.length > 0,
    emailSaving: email.saving,
    security: {
      state: readOnly ? 'ready' : sessions.state,
      sessions: sessionRows(sessionList).map((row) => ({ ...row, started: formatDateTime(row.startedAt, { locale }), lastSeen: formatDateTime(row.lastSeenAt, { locale }) })),
      others,
      readOnly,
    },
    onEndOthers: () => {
      if (others > 0 && !readOnly) setDialog({ kind: 'endOthers', count: others, busy: false, failed: null })
    },
    onRetrySessions: () => {
      setSessions(loading)
      void readSessions()
    },
    dialog,
    dialogActions: {
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
      onEndOthersConfirm: () => void endOthers(),
      onStepUpCode: (code) => void onStepUpCode(code),
    },
  }
}
