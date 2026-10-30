'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { z } from 'zod'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { stepUpProblem } from '../shared/model'
import {
  archiveActivity,
  createActivity,
  createDpia,
  createNotice,
  deleteNotice,
  deleteText,
  fileAddress,
  getNotice,
  listActivities,
  listDpia,
  listNotices,
  noticeAcks,
  paperAck,
  patchActivity,
  pickedFile,
  privacyOverview,
  publishNotice,
  putText,
  storeDpia,
  uploadDpiaPdf,
  uploadTextPdf,
  type Activity,
  type CompanyOverview,
  type DpiaList,
  type Notice,
  type NoticeKind,
} from './api'
import {
  activityDraftOf,
  activityErrors,
  activityFields,
  activityPatch,
  companyOf,
  csvOf,
  draftDpiaOf,
  emptyActivity,
  languageName,
  languagesInOrder,
  LOADING,
  missingFromRefusal,
  newNoticeHeld,
  privacyCan,
  problemOf,
  reviewDefault,
  STEP_UP_SHUT,
  storeHeld,
  suggestedLabel,
  todayIn,
  viewOf,
  type DpiaForm,
  type PageNotice,
  type Phrase,
  type PrivacyDialog,
  type PrivacyViewModel,
  type PrivacyViewName,
  type Read,
  type RegisterFilter,
  type StepUpState,
} from './model'
import { PrivacyView } from './view/PrivacyView'

const TIME_ZONE = 'Europe/Rome'

/** The person closed the code dialog: the change was not made. */
class StepUpClosed extends Error {}

/**
 * `/w/<company>/admin/privacy` (SCR-086): the duties of the companies privacy.view reaches (`GET /privacy/overview`), and
 * for the company in the address (`?company=`, else the session's) its notices, DPIA and register; the list in the
 * address (`?view=notices|dpia|register`) and the notice open in its dialog (`?open=<noticeId>`). Publishing a notice and
 * storing a DPIA ask the API, which asks a fresh code (403 `stepUp`): the code dialog opens, the code goes to
 * `POST /auth/office/step-up`, and the action runs once more. Live privacy.* events read the counts again; a newer
 * version shows behind "N updates · Show".
 */
export function PrivacyPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => privacyCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const view = viewOf(params?.get('view'))
  const asked = params?.get('company') ?? null
  const openId = params?.get('open') ?? null
  const today = useMemo(() => todayIn(TIME_ZONE), [])

  const [overview, setOverview] = useState<Read<CompanyOverview[]>>(LOADING)
  const [notices, setNotices] = useState<Read<Notice[]>>(LOADING)
  const [dpia, setDpia] = useState<Read<DpiaList>>(LOADING)
  const [register, setRegister] = useState<Read<Activity[]>>(LOADING)
  const [registerFilter, setRegisterFilter] = useState<RegisterFilter>('ACTIVE')
  const [selectedNotices, setSelectedNotices] = useState<readonly string[]>([])
  const [selectedActivities, setSelectedActivities] = useState<readonly string[]>([])
  const [dpiaForm, setDpiaForm] = useState<DpiaForm>({ signedByName: '', signedOn: '', reviewDueOn: '' })
  const [uploading, setUploading] = useState(false)
  const [dpiaProblem, setDpiaProblem] = useState<PrivacyViewModel['dpiaProblem']>(null)
  const [dialog, setDialog] = useState<PrivacyDialog | null>(null)
  const [stepUp, setStepUp] = useState<StepUpState>(STEP_UP_SHUT)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  // The public address uses this web's origin, known only in the browser (set after the first paint: no hydration gap).
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])
  const waiting = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null)
  const keys = useRef<Record<string, string>>({})
  const keyFor = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const forget = (name: string) => delete keys.current[name]

  const companies = overview.value?.map((entry) => entry.company) ?? []
  const companyId = companyOf(companies, asked, session.company?.id ?? null)

  const go = useCallback(
    (change: { view?: PrivacyViewName; company?: string | null; open?: string | null }) => {
      const next = new URLSearchParams(params?.toString() ?? '')
      if (change.view !== undefined) (change.view === 'notices' ? next.delete('view') : next.set('view', change.view))
      if (change.company !== undefined) (change.company ? next.set('company', change.company) : next.delete('company'))
      if (change.open !== undefined) (change.open ? next.set('open', change.open) : next.delete('open'))
      const query = next.toString()
      router.replace(query ? `${pathname}?${query}` : (pathname ?? ''), { scroll: false })
    },
    [params, pathname, router],
  )

  // ---- reads ----
  const loadOverview = useCallback(async () => {
    if (!can.view) return
    try {
      setOverview({ value: await privacyOverview(api), problem: null })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setOverview({ value: null, problem: problemOf(error) })
    }
  }, [api, can.view])

  const loadCompany = useCallback(async () => {
    if (!can.view || !companyId) return
    const [n, d, r] = await Promise.allSettled([listNotices(api, companyId), listDpia(api, companyId), listActivities(api, companyId)])
    setNotices(n.status === 'fulfilled' ? { value: n.value, problem: null } : { value: null, problem: problemOf(n.reason) })
    setDpia(d.status === 'fulfilled' ? { value: d.value, problem: null } : { value: null, problem: problemOf(d.reason) })
    setRegister(r.status === 'fulfilled' ? { value: r.value, problem: null } : { value: null, problem: problemOf(r.reason) })
    setUpdates(0)
  }, [api, can.view, companyId])

  const loadAll = useCallback(async () => {
    await Promise.all([loadOverview(), loadCompany()])
  }, [loadOverview, loadCompany])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])
  useEffect(() => {
    setNotices(LOADING)
    setDpia(LOADING)
    setRegister(LOADING)
    void loadCompany()
  }, [loadCompany])

  // The DPIA form starts from the draft's own facts (a re-opened page keeps what is stored on it).
  const dpiaDraftId = draftDpiaOf(dpia.value)?.id ?? null
  useEffect(() => {
    const draft = draftDpiaOf(dpia.value)
    if (!draft) return
    setDpiaForm((current) => ({
      signedByName: current.signedByName || draft.signedByName || '',
      signedOn: current.signedOn || draft.signedOn || '',
      reviewDueOn: current.reviewDueOn || draft.reviewDueOn || '',
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dpiaDraftId])

  // ---- the notice open in its dialog (`?open=`) ----
  const readNotice = useCallback(
    async (noticeId: string, keep?: Partial<Extract<PrivacyDialog, { kind: 'notice' }>>) => {
      const base = { kind: 'notice' as const, noticeId, notice: LOADING, acks: LOADING, texts: {}, adding: null, paper: { workerId: '', locale: 'it' }, confirmDelete: false, busy: false, problem: null, done: null }
      setDialog((current) => (current?.kind === 'notice' && current.noticeId === noticeId ? { ...current, ...keep } : { ...base, ...keep }))
      try {
        const found = await getNotice(api, noticeId)
        const acks = found.status !== 'DRAFT' && found.kind !== 'PRIVACY_PUBLIC' ? await noticeAcks(api, noticeId).then((value) => ({ value, problem: null }), (error: unknown) => ({ value: null, problem: problemOf(error) })) : { value: null, problem: null }
        setDialog((current) =>
          current?.kind === 'notice' && current.noticeId === noticeId
            ? { ...current, notice: { value: found, problem: null }, acks, paper: { ...current.paper, locale: languagesInOrder(found.languages)[0] ?? 'it' } }
            : current,
        )
      } catch (error) {
        setDialog((current) => (current?.kind === 'notice' && current.noticeId === noticeId ? { ...current, notice: { value: null, problem: problemOf(error) } } : current))
      }
    },
    [api],
  )
  useEffect(() => {
    if (openId) void readNotice(openId)
    else setDialog((current) => (current?.kind === 'notice' ? null : current))
  }, [openId, readNotice])

  // ---- live ----
  const refresh = useCoalesced(() => {
    void loadOverview()
    void loadCompany()
  }, 800)
  const live = useLive(
    (change) => {
      if (!change.type.startsWith('privacy.')) return
      if (change.type === 'privacy.notice_acknowledged') refresh()
      else setUpdates((count) => count + 1)
    },
    () => void loadAll(),
    can.view,
  )

  // ---- the step-up (asked only when the API asks it) ----
  const withStepUp = useCallback(async <T,>(sentence: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'step_up') throw error
      await new Promise<void>((resolve, reject) => {
        waiting.current = { resolve, reject }
        setStepUp({ open: true, busy: false, sentence, problem: null })
      })
      return work()
    }
  }, [])
  const submitStepUp = useCallback(
    async (code: string) => {
      setStepUp((current) => ({ ...current, busy: true, problem: null }))
      try {
        await api.post('/auth/office/step-up', { body: { code }, schema: z.object({ stepUpUntil: z.string() }) })
        setStepUp(STEP_UP_SHUT)
        waiting.current?.resolve()
        waiting.current = null
      } catch (error) {
        setStepUp((current) => ({ ...current, busy: false, problem: stepUpProblem(error) }))
      }
    },
    [api],
  )
  const closeStepUp = useCallback(() => {
    setStepUp(STEP_UP_SHUT)
    waiting.current?.reject(new StepUpClosed())
    waiting.current = null
  }, [])

  // ---- notice dialog writes ----
  const noticeDialog = dialog?.kind === 'notice' ? dialog : null
  const patchNotice = (change: Partial<Extract<PrivacyDialog, { kind: 'notice' }>>) => setDialog((current) => (current?.kind === 'notice' ? { ...current, ...change } : current))
  const afterNotice = (found: Notice, done: Phrase | null) => {
    setDialog((current) => (current?.kind === 'notice' && current.noticeId === found.id ? { ...current, notice: { value: found, problem: null }, busy: false, problem: null, done } : current))
    void loadCompany()
  }

  const saveText = async (locale: string) => {
    const current = noticeDialog?.notice.value
    if (!noticeDialog || !current) return
    const text = noticeDialog.texts[locale] ?? ''
    patchNotice({ busy: true, problem: null, done: null })
    try {
      const found = await putText(api, current.id, locale, text, current.version)
      setDialog((now) => {
        if (now?.kind !== 'notice') return now
        const { [locale]: _saved, ...rest } = now.texts
        return { ...now, texts: rest, adding: now.adding?.locale === locale ? null : now.adding }
      })
      afterNotice(found, { key: 'pv.done.textSaved', params: { language: languageName(locale) } })
    } catch (error) {
      patchNotice({ busy: false, problem: { key: problemOf(error) } })
    }
  }

  const removeText = async (locale: string) => {
    const current = noticeDialog?.notice.value
    if (!noticeDialog || !current) return
    patchNotice({ busy: true, problem: null, done: null })
    try {
      afterNotice(await deleteText(api, current.id, locale, current.version), { key: 'pv.done.textRemoved', params: { language: languageName(locale) } })
    } catch (error) {
      patchNotice({ busy: false, problem: { key: problemOf(error) } })
    }
  }

  const uploadPdf = async (locale: string, file: File) => {
    const current = noticeDialog?.notice.value
    if (!noticeDialog || !current) return
    setUploading(true)
    patchNotice({ problem: null, done: null })
    try {
      const found = await uploadTextPdf(api, current.id, locale, await pickedFile(file))
      patchNotice({ adding: null })
      afterNotice(found, { key: 'pv.done.pdfAdded', params: { language: languageName(locale) } })
    } catch (error) {
      patchNotice({ problem: { key: problemOf(error) } })
    } finally {
      setUploading(false)
    }
  }

  const publish = async () => {
    const current = noticeDialog?.notice.value
    if (!noticeDialog || !current) return
    patchNotice({ busy: true, problem: null, done: null })
    const key = keyFor(`publish:${current.id}`)
    try {
      const answer = await withStepUp('pv.stepUp.publish', () => publishNotice(api, current.id, current.version, key))
      forget(`publish:${current.id}`)
      afterNotice(answer.notice, { key: `pv.done.published.${answer.notice.kind}`, params: { label: answer.notice.label } })
      void loadOverview()
    } catch (error) {
      if (error instanceof StepUpClosed) return patchNotice({ busy: false, problem: { key: 'pv.problem.stepUpClosed' } })
      const missing = missingFromRefusal(error)
      patchNotice({ busy: false, problem: missing ? { key: 'pv.notice.missing', params: { languages: missing.map(languageName).join(', ') } } : { key: problemOf(error) } })
    }
  }

  const removeDraft = async (confirm: boolean) => {
    const current = noticeDialog?.notice.value
    if (!noticeDialog || !current) return
    if (!confirm) return patchNotice({ confirmDelete: !noticeDialog.confirmDelete })
    patchNotice({ busy: true, problem: null })
    try {
      await deleteNotice(api, current.id, current.version)
      setDialog(null)
      go({ open: null })
      setNotice({ tone: 'success', words: { key: 'pv.done.draftDeleted', params: { label: current.label } } })
      void loadCompany()
    } catch (error) {
      patchNotice({ busy: false, problem: { key: problemOf(error) } })
    }
  }

  const recordPaper = async () => {
    const current = noticeDialog?.notice.value
    if (!noticeDialog || !current) return
    patchNotice({ busy: true, problem: null, done: null })
    try {
      const answer = await paperAck(api, current.id, noticeDialog.paper, keyFor(`paper:${current.id}:${noticeDialog.paper.workerId}`))
      forget(`paper:${current.id}:${noticeDialog.paper.workerId}`)
      patchNotice({ paper: { workerId: '', locale: noticeDialog.paper.locale } })
      afterNotice(current, { key: answer.changed ? 'pv.done.paper' : 'pv.done.paperAgain' })
      void readNotice(current.id)
    } catch (error) {
      patchNotice({ busy: false, problem: { key: problemOf(error) } })
    }
  }

  // ---- new notice version ----
  const openNewNotice = (kind: NoticeKind = 'WORKER_FLOOR') => {
    const taken = (notices.value ?? []).filter((row) => row.kind === kind).map((row) => row.label)
    go({ open: null })
    setDialog({ kind: 'newNotice', draft: { kind, label: suggestedLabel(taken, today), copyTexts: true }, busy: false, problem: null })
  }
  const createNoticeNow = async () => {
    if (dialog?.kind !== 'newNotice' || !companyId) return
    if (newNoticeHeld(dialog.draft, notices.value ?? [], can)) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      const created = await createNotice(api, { companyId, kind: dialog.draft.kind, label: dialog.draft.label.trim(), copyTexts: dialog.draft.copyTexts }, keyFor('newNotice'))
      forget('newNotice')
      setDialog(null)
      await loadCompany()
      go({ view: 'notices', open: created.id })
    } catch (error) {
      setDialog((current) => (current?.kind === 'newNotice' ? { ...current, busy: false, problem: { key: problemOf(error) } } : current))
    }
  }

  // ---- the DPIA ----
  const createDpiaNow = async () => {
    if (dialog?.kind !== 'newDpia' || !companyId) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await createDpia(api, { companyId, ...(dialog.scope.trim() ? { scope: dialog.scope.trim() } : {}) }, keyFor('newDpia'))
      forget('newDpia')
      setDialog(null)
      setDpiaForm({ signedByName: '', signedOn: '', reviewDueOn: '' })
      void loadCompany()
    } catch (error) {
      setDialog((current) => (current?.kind === 'newDpia' ? { ...current, busy: false, problem: { key: problemOf(error) } } : current))
    }
  }
  const uploadDpia = async (file: File) => {
    const draft = draftDpiaOf(dpia.value)
    if (!draft) return
    setUploading(true)
    setDpiaProblem(null)
    try {
      await uploadDpiaPdf(api, draft.id, await pickedFile(file))
      setNotice({ tone: 'success', words: { key: 'pv.done.dpiaPdf' } })
      void loadCompany()
    } catch (error) {
      setDpiaProblem({ key: problemOf(error) })
    } finally {
      setUploading(false)
    }
  }
  const storeDpiaNow = async () => {
    const draft = draftDpiaOf(dpia.value)
    if (!draft || storeHeld(draft, dpiaForm, can, today)) return
    setDpiaProblem(null)
    const key = keyFor(`dpia:${draft.id}`)
    try {
      await withStepUp('pv.stepUp.dpia', () => storeDpia(api, draft.id, { signedByName: dpiaForm.signedByName.trim(), signedOn: dpiaForm.signedOn, reviewDueOn: dpiaForm.reviewDueOn, version: draft.version }, key))
      forget(`dpia:${draft.id}`)
      setNotice({ tone: 'success', words: { key: 'pv.done.dpiaStored', params: { n: draft.versionNo } } })
      setDpiaForm({ signedByName: '', signedOn: '', reviewDueOn: '' })
      void loadAll()
    } catch (error) {
      if (error instanceof StepUpClosed) return setDpiaProblem({ key: 'pv.problem.stepUpClosed' })
      setDpiaProblem({ key: problemOf(error) })
    }
  }

  // ---- the register ----
  const openActivity = (activityId: string | null) => {
    const found = activityId ? (register.value ?? []).find((row) => row.id === activityId) : null
    setDialog({ kind: 'activity', activityId, draft: found ? activityDraftOf(found) : emptyActivity(), busy: false, problem: null, showErrors: false })
  }
  const saveActivity = async () => {
    if (dialog?.kind !== 'activity' || !companyId) return
    const isNew = dialog.activityId === null
    if (Object.keys(activityErrors(dialog.draft, isNew)).length > 0) return setDialog({ ...dialog, showErrors: true })
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      if (isNew) {
        await createActivity(api, { companyId, code: dialog.draft.code.trim().toUpperCase(), ...activityFields(dialog.draft) }, keyFor('newActivity'))
        forget('newActivity')
      } else {
        const found = (register.value ?? []).find((row) => row.id === dialog.activityId)
        const patch = found ? activityPatch(found, dialog.draft) : null
        if (found && patch) await patchActivity(api, found.id, { ...patch, version: found.version })
      }
      setDialog(null)
      setNotice({ tone: 'success', words: { key: isNew ? 'pv.done.activityAdded' : 'pv.done.activitySaved', params: { name: dialog.draft.name.trim() } } })
      void loadAll()
    } catch (error) {
      setDialog((current) => (current?.kind === 'activity' ? { ...current, busy: false, problem: { key: problemOf(error) } } : current))
    }
  }
  const archiveNow = async () => {
    if (dialog?.kind !== 'archive') return
    const found = (register.value ?? []).find((row) => row.id === dialog.activityId)
    if (!found) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await archiveActivity(api, found.id, found.version)
      setDialog(null)
      setNotice({ tone: 'success', words: { key: 'pv.done.archived', params: { name: found.name } } })
      void loadAll()
    } catch (error) {
      setDialog((current) => (current?.kind === 'archive' ? { ...current, busy: false, problem: { key: problemOf(error) } } : current))
    }
  }

  // ---- files and exports ----
  const openFile = async (fileId: string) => {
    try {
      window.open(await fileAddress(api, fileId), '_blank', 'noopener')
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: problemOf(error) } })
    }
  }
  const exportNotices = (ids: string[]) => {
    const rows = (notices.value ?? []).filter((row) => ids.includes(row.id))
    const header = ['version', 'label', 'state', 'languages', 'published', 'acknowledged', 'active']
    downloadText(
      `worker-notices-${today}.csv`,
      csvOf(header, rows.map((row) => [row.versionNo, row.label, row.status, languagesInOrder(row.languages).join(' '), row.publishedAt ?? '', row.acknowledgements?.acknowledged ?? '', row.acknowledgements?.active ?? ''])),
    )
  }
  const exportActivities = (ids: string[]) => {
    const rows = (register.value ?? []).filter((row) => ids.includes(row.id))
    const header = ['code', 'name', 'purpose', 'legalBasis', 'dataSubjects', 'dataCategories', 'recipients', 'processors', 'transfers', 'retention', 'security', 'status']
    downloadText(
      `processing-register-${today}.csv`,
      csvOf(header, rows.map((row) => [row.code, row.name, row.purpose, row.legalBasis, row.dataSubjects.join(' | '), row.dataCategories.join(' | '), row.recipients.join(' | '), row.processors.join(' | '), row.transfers, row.retention, row.security, row.status])),
    )
  }

  const model: PrivacyViewModel = {
    prefix,
    can,
    view,
    overview,
    companyId,
    notices,
    dpia,
    register,
    registerFilter,
    selectedNotices,
    selectedActivities,
    dpiaForm,
    uploading,
    dpiaProblem,
    dialog,
    stepUp,
    asOf,
    live,
    updates,
    notice,
    origin,
    today,
    timeZone: TIME_ZONE,
  }

  return (
    <PrivacyView
      model={model}
      actions={{
        onCompany: (id) => go({ company: id, open: null }),
        onView: (next) => go({ view: next }),
        onRetry: () => void loadAll(),
        onShowUpdates: () => void loadAll(),
        onDismissNotice: () => setNotice(null),
        onOpenNotice: (id) => go({ open: id }),
        onNewNotice: openNewNotice,
        onSelectNotices: setSelectedNotices,
        onExportNotices: exportNotices,
        onCopyAddress: (address) => {
          void navigator.clipboard?.writeText(address).then(
            () => setNotice({ tone: 'success', words: { key: 'pv.done.copied' } }),
            () => setNotice({ tone: 'warning', words: { key: 'pv.problem.copy' } }),
          )
        },
        onStartDpia: () => setDialog({ kind: 'newDpia', scope: '', busy: false, problem: null }),
        onUploadDpia: (file) => void uploadDpia(file),
        onDpiaForm: (change) =>
          setDpiaForm((current) => {
            const next = { ...current, ...change }
            if (change.signedOn && !current.reviewDueOn) next.reviewDueOn = reviewDefault(change.signedOn)
            return next
          }),
        onStoreDpia: () => void storeDpiaNow(),
        onOpenFile: (fileId) => void openFile(fileId),
        onRegisterFilter: setRegisterFilter,
        onSelectActivities: setSelectedActivities,
        onExportActivities: exportActivities,
        onNewActivity: () => openActivity(null),
        onOpenActivity: (id) => openActivity(id),
        onArchive: (id) => setDialog({ kind: 'archive', activityId: id, busy: false, problem: null }),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpClose: closeStepUp,
        onCloseDialog: () => {
          if (dialog?.kind === 'notice') go({ open: null })
          setDialog(null)
        },
        onNewNoticeDraft: (change) => setDialog((current) => (current?.kind === 'newNotice' ? { ...current, draft: { ...current.draft, ...change }, problem: null } : current)),
        onCreateNotice: () => void createNoticeNow(),
        onText: (locale, text) => setDialog((current) => (current?.kind === 'notice' ? { ...current, texts: { ...current.texts, [locale]: text }, done: null } : current)),
        onSaveText: (locale) => void saveText(locale),
        onRemoveText: (locale) => void removeText(locale),
        onAddLanguage: (adding) =>
          setDialog((current) => {
            if (current?.kind !== 'notice') return current
            // Added as text: an empty field for it appears with the others (saved with Save).
            const texts = adding?.as === 'text' ? { ...current.texts, [adding.locale]: current.texts[adding.locale] ?? '' } : current.texts
            return { ...current, adding, texts }
          }),
        onUploadTextPdf: (locale, file) => void uploadPdf(locale, file),
        onPublish: () => void publish(),
        onDeleteDraft: (confirm) => void removeDraft(confirm),
        onNewVersionFrom: (kind) => openNewNotice(kind),
        onPaper: (change) => setDialog((current) => (current?.kind === 'notice' ? { ...current, paper: { ...current.paper, ...change } } : current)),
        onRecordPaper: () => void recordPaper(),
        onDpiaScope: (scope) => setDialog((current) => (current?.kind === 'newDpia' ? { ...current, scope } : current)),
        onCreateDpia: () => void createDpiaNow(),
        onActivityDraft: (change) => setDialog((current) => (current?.kind === 'activity' ? { ...current, draft: { ...current.draft, ...change } } : current)),
        onSaveActivity: () => void saveActivity(),
        onConfirmArchive: () => void archiveNow(),
      }}
    />
  )
}
