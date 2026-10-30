'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { recordAddress } from '../../../../lib/records/record-links'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { liveMatches, useLive, useRecordTab } from '../../_shared/hooks'
import { problemKey } from '../../_shared/model'
import { RecordProblem, RecordSkeleton } from '../../_shared/parts'
import {
  acknowledgeComplaint,
  changeComplaint,
  closeComplaint,
  complaintPeople,
  getComplaint,
  listPhotos,
  listSites,
  listStyles,
  makeRepairFrom,
  moveComplaint,
  photoAddress,
  raiseNcrFrom,
  registerComplaint,
  triageComplaint,
  type Complaint,
  type ComplaintPeople,
  type ComplaintPatch,
  type SiteOption,
  type StyleOption,
} from '../api'
import { complaintsCan, isStale, raisesSafety, refusalKey, romeToday, triageDraftOf, triageProblems } from '../model'
import type { Notice, PhotoView, TriageModel } from '../view-model'
import { ComplaintsMessages, useWords } from '../view/parts'
import { RECORD_TABS, type FactsDraft, type RecordDialog } from './view-model'
import { ComplaintRecordView } from './view/ComplaintRecordView'

/**
 * A complaint's container (`/w/<company>/quality/complaints/<id>?tab=…`, SCR-113 W2a part): reads the complaint (its
 * steps held with the API's codes), its photos, and — when a step needs them — the people of the company's complaints,
 * the styles and the sites; runs ONE write at a time with the version read (a stale one reads the complaint again and
 * says so); live complaint events read it again, or, while a dialog or an edit is open, say it changed with Reload.
 * `?do=ncr|register` (the list's row verbs) opens that step's dialog. The thread dock (O1) and Activity mount the record
 * panels. An NCR (B-W2a-47) or a repair (B-W2a-57) made from here opens in its own place.
 */
export function ComplaintRecord({ complaintId }: { complaintId: string }) {
  return (
    <ComplaintsMessages>
      <RecordContainer complaintId={complaintId} />
    </ComplaintsMessages>
  )
}

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.complaints.dock'

const factsOf = (complaint: Complaint): FactsDraft => ({
  description: complaint.description,
  customerRef: complaint.customerRef ?? '',
  channel: complaint.channel === 'PORTAL' || complaint.channel === 'LINK' ? '' : complaint.channel,
  styleId: complaint.style?.id ?? '',
  size: complaint.size ?? '',
  serial: complaint.serial ?? '',
  batchNumber: complaint.batchNumber ?? '',
  internalNote: complaint.internalNote ?? '',
})

/** Only what changed, as the API takes it (an emptied field is null). */
function patchOf(draft: FactsDraft, complaint: Complaint): ComplaintPatch {
  const patch: ComplaintPatch = {}
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (draft.description.trim() !== complaint.description) patch.description = draft.description.trim()
  if (text(draft.customerRef) !== complaint.customerRef) patch.customerRef = text(draft.customerRef)
  if (draft.channel !== '' && draft.channel !== complaint.channel) patch.channel = draft.channel
  if ((draft.styleId || null) !== (complaint.style?.id ?? null)) patch.styleId = draft.styleId || null
  if (text(draft.size) !== complaint.size) patch.size = text(draft.size)
  if (text(draft.serial) !== complaint.serial) patch.serial = text(draft.serial)
  if (text(draft.batchNumber) !== complaint.batchNumber) patch.batchNumber = text(draft.batchNumber)
  if (text(draft.internalNote) !== complaint.internalNote) patch.internalNote = text(draft.internalNote)
  return patch
}

function RecordContainer({ complaintId }: { complaintId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useWords()
  const can = useMemo(() => complaintsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(RECORD_TABS)
  const me = session.user.id
  const today = romeToday()
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const [complaint, setComplaint] = useState<Complaint | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [photos, setPhotos] = useState<PhotoView[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ draft: FactsDraft; busy: boolean; problem: string | null } | null>(null)
  const [styles, setStyles] = useState<readonly StyleOption[] | null>(null)
  const [sites, setSites] = useState<readonly SiteOption[] | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [people, setPeople] = useState<{ value: ComplaintPeople | null; problem: string | null } | null>(null)
  const [triage, setTriage] = useState<TriageModel | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const busy = useRef(false)
  const triageKey = useRef<string | null>(null)
  const quietRef = useRef(false)
  quietRef.current = dialog !== null || edit !== null || triage !== null

  const load = useCallback(async () => {
    try {
      const next = await getComplaint(api, complaintId)
      setComplaint(next)
      setProblem(null)
      setAsOf(new Date().toISOString())
      setChangedAt(null)
      return next
    } catch (error) {
      setProblem(problemKey(error))
      setNotice((current) => current ?? { tone: 'warning', words: { key: 'notice.readFailed' } })
      return null
    }
  }, [api, complaintId])

  const loadPhotos = useCallback(async () => {
    if (!can.filesRead) return
    const files = await listPhotos(api, complaintId).catch(() => [])
    setPhotos(files.map((file) => ({ id: file.id, name: file.originalName, src: null })))
    for (const file of files) {
      photoAddress(api, file.id)
        .then((src) => setPhotos((current) => current.map((entry) => (entry.id === file.id ? { ...entry, src } : entry))))
        .catch(() => undefined)
    }
  }, [api, can.filesRead, complaintId])

  useEffect(() => {
    void load()
    void loadPhotos()
  }, [load, loadPhotos])

  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['complaint.']) || change.fields.complaintId !== complaintId) return
      if (quietRef.current) setChangedAt(new Date().toISOString())
      else void load()
    },
    () => void load(),
  )

  // The styles when the facts are edited or a triage names one (product.styles.view); the sites for an NCR or a repair.
  const needStyles = edit !== null || triage !== null
  useEffect(() => {
    if (!needStyles || styles !== null || !can.stylesView) return
    listStyles(api)
      .then(setStyles)
      .catch(() => setStyles(null))
  }, [api, can.stylesView, needStyles, styles])
  const needSites = dialog?.kind === 'ncr' || dialog?.kind === 'repair'
  useEffect(() => {
    if (!needSites || sites !== null || !can.sitesView || !complaint) return
    listSites(api, complaint.companyId)
      .then(setSites)
      .catch(() => setSites(null))
  }, [api, can.sitesView, complaint, needSites, sites])

  // `?do=ncr|register` (the list's verbs) opens the step once the complaint is read; then the address forgets it.
  const asked = params?.get('do') ?? null
  useEffect(() => {
    if (!asked || !complaint) return
    if (asked === 'ncr') setDialog({ kind: 'ncr', siteId: '', severity: complaint.severity ?? '' })
    if (asked === 'register') setDialog({ kind: 'register', risk: complaint.category === 'SAFETY' ? 'ASSESSING' : 'NO' })
    const search = new URLSearchParams(params?.toString() ?? '')
    search.delete('do')
    const qs = search.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [asked, complaint, params, pathname, router])

  // ---- triage --------------------------------------------------------------------------------------------------------------
  const openTriage = useCallback(() => {
    if (!complaint) return
    triageKey.current = null
    setTriage({
      queue: [complaint.id],
      id: complaint.id,
      loaded: { status: 'ready', value: complaint },
      photos,
      draft: triageDraftOf(complaint, me, people?.value?.owners ?? null),
      people: people?.value ?? null,
      peopleProblem: people?.problem ?? null,
      styles,
      showProblems: false,
      busy: false,
      problem: null,
      confirmSafety: false,
      today,
      offline,
    })
    if (people === null) {
      setPeople({ value: null, problem: null })
      complaintPeople(api, complaint.companyId)
        .then((value) => {
          setPeople({ value, problem: null })
          setTriage((current) => (current ? { ...current, draft: current.draft.ownerId ? current.draft : triageDraftOf(complaint, me, value.owners) } : current))
        })
        .catch((error) => setPeople({ value: null, problem: refusalKey(error) }))
    }
  }, [api, complaint, me, offline, people, photos, styles, today])

  const saveTriage = useCallback(
    async (confirmed: boolean) => {
      if (!triage || !complaint || triage.busy) return
      if (triageProblems(triage.draft, complaint).length > 0) {
        setTriage({ ...triage, showProblems: true })
        return
      }
      if (!confirmed && raisesSafety(triage.draft, complaint)) {
        setTriage({ ...triage, confirmSafety: true, problem: null })
        return
      }
      setTriage({ ...triage, busy: true, problem: null })
      triageKey.current ??= newIdempotencyKey()
      const draft = triage.draft
      try {
        const answer = await triageComplaint(
          api,
          complaint,
          {
            category: draft.category!,
            severity: draft.severity!,
            ownerId: draft.ownerId,
            answerDueOn: draft.answerDueOn,
            ...(!complaint.style && draft.styleId ? { styleId: draft.styleId } : {}),
            ...(raisesSafety(draft, complaint) ? { risk: draft.risk } : {}),
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          },
          triageKey.current,
        )
        triageKey.current = null
        setTriage(null)
        setComplaint(answer.complaint)
        setAsOf(new Date().toISOString())
        setNotice({
          tone: answer.safetyRaised ? 'warning' : 'success',
          words: answer.safetyRaised ? { key: 'done.safetyRaised', params: { number: answer.complaint.number, reference: answer.register?.reference ?? '—' } } : { key: 'done.triaged', params: { number: answer.complaint.number } },
        })
      } catch (error) {
        triageKey.current = null
        if (isStale(error)) {
          const fresh = await load()
          setTriage((current) => (current ? { ...current, busy: false, confirmSafety: false, problem: 'refusal.conflict', ...(fresh ? { loaded: { status: 'ready' as const, value: fresh } } : {}) } : current))
          return
        }
        setTriage((current) => (current ? { ...current, busy: false, confirmSafety: false, problem: refusalKey(error) } : current))
      }
    },
    [api, complaint, load, triage],
  )

  // ---- the other steps -------------------------------------------------------------------------------------------------------
  /** One write at a time with the version read: the step's answer (or a fresh read) and its receipt in words. */
  const write = useCallback(
    async (work: () => Promise<{ complaint: Complaint | null; words: Notice['words'] }>) => {
      if (busy.current) return
      busy.current = true
      setDialogBusy(true)
      setDialogProblem(null)
      try {
        const done = await work()
        if (done.complaint) setComplaint(done.complaint)
        else await load()
        setAsOf(new Date().toISOString())
        setDialog(null)
        setChangedAt(null)
        setNotice({ tone: 'success', words: done.words })
      } catch (error) {
        if (isStale(error)) {
          await load()
          setDialogProblem('refusal.conflict')
        } else setDialogProblem(refusalKey(error))
      } finally {
        busy.current = false
        setDialogBusy(false)
      }
    },
    [load],
  )

  const submitDialog = useCallback(
    (note?: string | null) => {
      if (!complaint || !dialog) return
      const number = complaint.number
      if (dialog.kind === 'acknowledge') void write(async () => ({ complaint: await acknowledgeComplaint(api, complaint, note ?? null), words: { key: 'done.acknowledged', params: { number } } }))
      else if (dialog.kind === 'move')
        void write(async () => ({ complaint: await moveComplaint(api, complaint, dialog.to, dialog.note.trim() || null), words: { key: dialog.to === 'ANSWERED' ? 'done.answered' : 'done.investigating', params: { number } } }))
      else if (dialog.kind === 'close') void write(async () => ({ complaint: await closeComplaint(api, complaint, dialog.reason.trim()), words: { key: 'done.closed', params: { number } } }))
      else if (dialog.kind === 'register')
        void write(async () => {
          const answer = await registerComplaint(api, complaint, dialog.risk)
          return { complaint: answer.complaint, words: { key: 'done.registered', params: { number, reference: answer.register.reference } } }
        })
      else if (dialog.kind === 'ncr') {
        const key = newIdempotencyKey()
        void write(async () => {
          const ncr = await raiseNcrFrom(api, complaint.id, { ...(dialog.siteId ? { siteId: dialog.siteId } : {}), ...(dialog.severity ? { severity: dialog.severity } : {}) }, key)
          return { complaint: null, words: { key: 'done.ncr', params: { number: ncr.number } } }
        })
      } else if (dialog.kind === 'repair') {
        const key = newIdempotencyKey()
        void write(async () => {
          const repair = await makeRepairFrom(api, complaint.id, { ...(dialog.siteId ? { siteId: dialog.siteId } : {}), received: dialog.received }, key)
          return { complaint: null, words: { key: 'done.repair', params: { number: repair.number } } }
        })
      }
    },
    [api, complaint, dialog, write],
  )

  const saveEdit = useCallback(async () => {
    if (!edit || !complaint || edit.busy) return
    const patch = patchOf(edit.draft, complaint)
    if (Object.keys(patch).length === 0) {
      setEdit(null)
      return
    }
    setEdit({ ...edit, busy: true, problem: null })
    try {
      const answer = await changeComplaint(api, complaint, patch)
      setComplaint(answer.complaint)
      setEdit(null)
      setAsOf(new Date().toISOString())
      setNotice({ tone: answer.warnings.length > 0 ? 'warning' : 'success', words: { key: 'done.saved', params: { number: answer.complaint.number } }, detail: answer.warnings.length > 0 ? { key: 'done.savedWarnings', params: { count: answer.warnings.length } } : null })
    } catch (error) {
      if (isStale(error)) {
        await load()
        setEdit((current) => (current ? { ...current, busy: false, problem: 'refusal.conflict' } : current))
        return
      }
      setEdit((current) => (current ? { ...current, busy: false, problem: refusalKey(error) } : current))
    }
  }, [api, complaint, edit, load])

  if (problem && !complaint)
    return (
      <RecordProblem
        problem={problem}
        back={
          <Link className="fw-q-link" href={`${prefix}/quality/complaints`}>
            {t('record.back')}
          </Link>
        }
        onRetry={() => void load()}
      />
    )
  if (!complaint) return <RecordSkeleton />

  const built = OFFICE_PAGES
  const hrefs: Record<string, string> = {}
  const add = (type: string, id: string, label: string) => {
    hrefs[`${type}:${id}`] = `${prefix}${recordAddress({ type, id, label, companyId: complaint.companyId }, built)}`
  }
  for (const ncr of complaint.ncrs) add('Nonconformance', ncr.id, ncr.number)
  for (const repair of complaint.repairs) add('RepairOrder', repair.id, repair.number)
  if (complaint.return) add('ReturnAuthorisation', complaint.return.id, complaint.return.number)
  if (complaint.shipment) add('Shipment', complaint.shipment.id, complaint.shipment.number)
  if (complaint.order) add('SalesOrder', complaint.order.id, complaint.order.number)

  const panels = can.threadsRead ? <RecordPanels record={{ type: 'Complaint', id: complaint.id, companyId: complaint.companyId, siteId: null }} title={complaint.number} party={{ id: complaint.party.id, name: complaint.party.legalName, emails: complaint.contact?.email ? [complaint.contact.email] : [] }} /> : undefined

  const triageModel: TriageModel | null = triage ? { ...triage, people: people?.value ?? null, peopleProblem: people?.problem ?? null, styles, photos, offline } : null

  return (
    <ComplaintRecordView
      model={{ prefix, can, tab, complaint, photos, asOf, live, offline, today, notice, changedAt, edit, styles, dialog, dialogBusy, dialogProblem, sites, triage: triageModel, dockOpen, hrefs }}
      panels={panels}
      actions={{
        onTriage: openTriage,
        onDialog: (next) => {
          setDialog(next)
          if (next === null || next.kind !== dialog?.kind) setDialogProblem(null)
        },
        onDialogSubmit: submitDialog,
        onEdit: (on) => setEdit(on ? { draft: factsOf(complaint), busy: false, problem: null } : null),
        onEditDraft: (patch) => setEdit((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onEditSave: () => void saveEdit(),
        onReload: () => {
          void load()
          void loadPhotos()
        },
        onCopy: (text) => {
          void navigator.clipboard?.writeText(text).then(
            () => setNotice({ tone: 'success', words: { key: 'done.copied', params: { text } } }),
            () => undefined,
          )
        },
        onDismissNotice: () => setNotice(null),
        onDock: () => {
          let wide = false
          try {
            wide = window.matchMedia(WIDE).matches
          } catch {
            wide = false
          }
          if (!wide) {
            router.push(`${pathname}?tab=activity`)
            return
          }
          setDockOpen((current) => {
            const next = !current
            try {
              window.localStorage.setItem(DOCK_KEY, next ? '1' : '0')
            } catch {
              // Not kept on this device; the dock still toggles.
            }
            return next
          })
        },
        onTriageGo: () => undefined,
        onTriageClose: () => setTriage(null),
        onTriageRetry: () => undefined,
        onTriageDraft: (patch) => {
          triageKey.current = null
          setTriage((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))
        },
        onTriageSave: () => void saveTriage(false),
        onTriageConfirmSafety: () => void saveTriage(true),
        onTriageCancelSafety: () => setTriage((current) => (current ? { ...current, confirmSafety: false } : current)),
      }}
    />
  )
}
