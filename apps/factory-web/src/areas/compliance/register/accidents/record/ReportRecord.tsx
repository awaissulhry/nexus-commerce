'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { romeToday } from '../../../../../lib/safety-reports/intake'
import { uploadSafetyPhoto } from '../../../../../lib/safety-reports/photos'
import { useSafetyPhotos } from '../../../../../lib/safety-reports/use-photos'
import { companyPrefix } from '../../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { readFromStore } from '../../../../../record-panels/store'
import { liveMatches, useLive } from '../../../../quality/_shared/hooks'
import {
  changeReport,
  eraseInjury,
  eraseReporter,
  fileReport,
  getReport,
  markSeen,
  moveReport,
  officePhotoDoor,
  openInjury,
  openPhoto,
  recordInjury,
  reportRevisions,
  reviseAccident,
  type Report,
  type Revision,
} from '../api'
import { actionHeld, isRecordDo, isRecordTab, readProblemOf, refusalOf, reviseBodyOf, safetyCan, type RecordTab } from '../model'
import { SafetyMessages } from '../parts'
import { dialogFor, dialogHeld, factsPatchOf, toldDialogFor } from './dialogs'
import type { DialogState, InjuryState, RecordDialog, ReportRecordModel } from './view-model'
import { ReportRecordView } from './view/ReportRecordView'

const LIVE_TYPES = ['safety_report.', 'accident_log.revised']

/**
 * `/w/<company>/compliance/register/accidents/reports/<id>?tab=report|accident|photos&do=revise|told` — a product-safety report
 * (SCR-421-record, B-W2b-357 on B-W2b-351's API): reads the report (and its accident log on that tab), runs each verb as ONE
 * call with its own Idempotency-Key and the version read, opens the injury only through `POST …/injury/open` (the API records
 * the opening first; the words live in this page's state only and leave with Hide, another report or the page), opens a photo
 * through its recorded opening (read into a new tab), adds photos by the camera, and listens for changes to this report
 * (read again, or "changed meanwhile" while a dialog holds work). `?do=` (a row verb of the accident log) opens that dialog once.
 */
export function ReportRecord({ reportId }: { reportId: string }) {
  return (
    <SafetyMessages>
      <RecordContainer reportId={reportId} />
    </SafetyMessages>
  )
}

function RecordContainer({ reportId }: { reportId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const can = useMemo(() => safetyCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tabParam = params?.get('tab') ?? null
  const tab: RecordTab = isRecordTab(tabParam) ? tabParam : 'report'
  const doParam = params?.get('do') ?? null
  const today = romeToday()

  const [report, setReport] = useState<Report | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [revisions, setRevisions] = useState<{ items: readonly Revision[] | null; problem: string | null }>({ items: null, problem: null })
  const [injury, setInjury] = useState<InjuryState>({ state: 'closed' })
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [notice, setNotice] = useState<ReportRecordModel['notice']>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const latest = useRef({ report, dialog })
  latest.current = { report, dialog }
  const keys = useRef(new Map<string, string>())
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    let key = keys.current.get(text)
    if (!key) {
      key = newIdempotencyKey()
      keys.current.set(text, key)
    }
    return key
  }

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      const next = await getReport(api, reportId)
      setReport(next)
      setProblem(null)
      setChanged(false)
    } catch (error) {
      setProblem(readProblemOf(error))
    }
  }, [api, reportId, can.view])

  const loadRevisions = useCallback(async () => {
    try {
      const next = await reportRevisions(api, reportId)
      setRevisions({ items: next.revisions, problem: null })
    } catch (error) {
      setRevisions({ items: null, problem: readProblemOf(error) })
    }
  }, [api, reportId])

  useEffect(() => {
    setInjury({ state: 'closed' })
    void load()
  }, [load])
  useEffect(() => {
    if (tab === 'accident') void loadRevisions()
  }, [tab, loadRevisions])

  // `?do=revise|told`: open that dialog once the report is read, then clean the address.
  const doneDo = useRef(false)
  useEffect(() => {
    if (!report || doneDo.current || !isRecordDo(doParam)) return
    doneDo.current = true
    if (!actionHeld(report, 'logAccident')) setDialog({ dialog: doParam === 'told' ? toldDialogFor(report, today) : dialogFor('revise', report), tried: false, busy: false, problem: null })
    router.replace(`${pathname}${tab === 'report' ? '' : `?tab=${tab}`}`, { scroll: false })
  }, [report, doParam, router, pathname, tab, today])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, LIVE_TYPES) || change.fields.reportId !== reportId) return
      if (latest.current.dialog) setChanged(true)
      else {
        void load()
        if (tab === 'accident') void loadRevisions()
      }
    },
    () => void load(),
  )

  // Add a photo: each one sent reads the report again (its list shows it) and empties this list.
  const photosRef = useRef<{ reset: () => void } | null>(null)
  const photos = useSafetyPhotos({
    number: report?.number ?? null,
    until: null,
    already: report?.photos.length ?? 0,
    upload: async (photo, photoKeys) => {
      const sent = await uploadSafetyPhoto(api, officePhotoDoor(reportId), photo, photoKeys)
      await load()
      photosRef.current?.reset()
      return sent
    },
  })
  photosRef.current = photos

  /** One write: the answer replaces the report, a receipt says what happened; a refusal in our words stays in the dialog. */
  const write = (work: (current: Report) => Promise<Report>, receipt: string, after?: () => void) => {
    const current = latest.current.report
    if (!current) return
    setDialog((state) => (state ? { ...state, busy: true, problem: null } : state))
    work(current)
      .then((next) => {
        setReport(next)
        setDialog(null)
        setNotice({ key: receipt, tone: 'success' })
        setChanged(false)
        after?.()
      })
      .catch((error: unknown) => {
        const key = refusalOf(error)
        if (latest.current.dialog) setDialog((state) => (state ? { ...state, busy: false, problem: key } : state))
        else setNotice({ key, tone: 'danger' })
        if (key === 'refused.stale') void load()
      })
  }

  const submit = () => {
    const state = latest.current.dialog
    const current = latest.current.report
    if (!state || !current || state.busy) return
    const held = dialogHeld(state.dialog, current, today)
    if (held) return setDialog({ ...state, tried: true })
    const d = state.dialog
    const v = current.version
    switch (d.kind) {
      case 'close': {
        const body = { to: 'CLOSED', note: d.note.trim(), v }
        return write(() => moveReport(api, reportId, v, 'CLOSED', d.note.trim(), keyFor(body)), 'receipt.closed')
      }
      case 'file': {
        const body = { file: true, v }
        return write(
          () =>
            fileReport(api, reportId, v, keyFor(body)).then((answer) => {
              return answer.report
            }),
          'receipt.filed',
        )
      }
      case 'eraseReporter': {
        const body = { erase: 'reporter', reason: d.reason.trim(), v }
        return write(() => eraseReporter(api, reportId, v, d.reason.trim(), keyFor(body)), 'receipt.reporterErased')
      }
      case 'eraseInjury': {
        const body = { erase: 'injury', reason: d.reason.trim(), v }
        return write(() => eraseInjury(api, reportId, v, d.reason.trim(), keyFor(body)), 'receipt.injuryErased', () => setInjury({ state: 'closed' }))
      }
      case 'recordInjury': {
        const words = d.draft.injured && d.draft.consent && d.draft.words.trim() ? d.draft.words.trim() : null
        const body = { injured: d.draft.injured === true, ...(d.draft.injured && d.draft.consent ? { consent: true } : {}), words }
        return write(() => recordInjury(api, reportId, v, body, keyFor({ ...body, v })), 'receipt.injuryRecorded')
      }
      case 'facts': {
        const patch = factsPatchOf(d.draft, current)
        return write(() => changeReport(api, reportId, v, patch, keyFor({ ...patch, v })), 'receipt.facts')
      }
      case 'revise': {
        const body = reviseBodyOf(d.draft, current.accidentLog.newest)
        return write(
          () => reviseAccident(api, reportId, v, body, keyFor({ ...body, v })).then((answer) => answer.report),
          d.told ? 'receipt.told' : 'receipt.revised',
          () => void loadRevisions(),
        )
      }
    }
  }

  const move = (to: 'seen' | 'assess') => {
    const current = latest.current.report
    if (!current) return
    const v = current.version
    const run = to === 'seen' ? markSeen(api, reportId, v, keyFor({ seen: true, v })) : moveReport(api, reportId, v, 'ASSESSING', null, keyFor({ to: 'ASSESSING', v }))
    run
      .then((next) => {
        setReport(next)
        setNotice({ key: to === 'seen' ? 'receipt.seen' : 'receipt.assessing', tone: 'success' })
      })
      .catch((error: unknown) => {
        setNotice({ key: refusalOf(error), tone: 'danger' })
        void load()
      })
  }

  const photosHeld = report ? actionHeld(report, 'photos') : null
  const model: ReportRecordModel = {
    prefix,
    tab,
    can,
    today,
    report,
    problem,
    revisions,
    injury,
    opening,
    photos: report ? { ...photos.model, held: photos.model.held ?? photosHeld } : null,
    dialog,
    notice,
    live,
    changed,
  }

  return (
    <ReportRecordView
      model={model}
      actions={{
        onRetry: () => {
          void load()
          if (tab === 'accident') void loadRevisions()
        },
        onReload: () => {
          void load()
          if (tab === 'accident') void loadRevisions()
        },
        onSeen: () => move('seen'),
        onAssess: () => move('assess'),
        onDialog: (next: RecordDialog | null) => setDialog(next ? { dialog: next, tried: false, busy: false, problem: null } : null),
        onDialogChange: (next) => setDialog((state) => (state && !state.busy ? { ...state, dialog: next, problem: null } : state)),
        onDialogSubmit: submit,
        onOpenInjury: () => {
          setInjury({ state: 'reading' })
          openInjury(api, reportId, newIdempotencyKey())
            .then((value) => setInjury({ state: 'open', value, at: new Date().toISOString() }))
            .catch(() => setInjury({ state: 'failed' }))
        },
        onHideInjury: () => setInjury({ state: 'closed' }),
        onOpenPhoto: (fileId) => {
          if (opening) return
          const tabWindow = window.open('about:blank', '_blank')
          setOpening(fileId)
          openPhoto(api, reportId, fileId, newIdempotencyKey())
            .then((download) => readFromStore(download))
            .then((bytes) => {
              const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: report?.photos.find((photo) => photo.id === fileId)?.contentType ?? 'image/jpeg' }))
              if (tabWindow) tabWindow.location.href = url
              else window.open(url, '_blank', 'noopener')
              setTimeout(() => URL.revokeObjectURL(url), 60_000)
            })
            .catch(() => {
              tabWindow?.close()
              setNotice({ key: 'refused.photo', tone: 'danger' })
            })
            .finally(() => setOpening(null))
        },
        onCopy: (text) => void navigator.clipboard?.writeText(text),
        onDismissNotice: () => setNotice(null),
        photos: photos.actions,
      }}
    />
  )
}
