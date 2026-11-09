'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { postMessage } from '../../shell/api'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { PortalThread } from '../../shell/thread/PortalThread'
import { NotInAccessHere, useOffline } from '../orders/parts'
import { fetchJob, sendJobAct, uploadKitPhoto, type JobAct, type JobPage, type KitLine } from './api'
import { jobBandOf } from './band'
import {
  ACCEPT_DRAFT,
  acceptBody,
  acceptHeld,
  actHeld,
  DECLINE_DRAFT,
  declineBody,
  declineHeld,
  isRecordTab,
  kitAllAct,
  kitDayOf,
  kitDraftOf,
  kitHeld,
  kitLinesAct,
  kitToCount,
  NS,
  PROBLEM_DRAFT,
  problemHeld,
  problemText,
  progressAct,
  progressDraftOf,
  progressHeld,
  progressTyped,
  returnAct,
  returnDraftOf,
  returnHeld,
  returnPieces,
  tabFor,
  writeProblem,
  type ActEnd,
  type ActName,
  type KitDraft,
  type PersonFacts,
  type ProblemDraft,
  type ProgressDraft,
  type ReturnDraft,
  type Words,
} from './model'
import { usePortalCapabilities, useToday } from './parts'
import type { AcceptModel, DeclineModel, PhotoModel } from './view/Dialogs'
import { JobRecordView, type JobRecordViewModel } from './view/JobRecordView'
import { useJobWords } from './words'

/**
 * `/p/<party>/jobs/<id>?tab=…` for a workshop (B-W2b-181, SCR-193; design portal.supplier.jobs rec "Job"): reads the job
 * (GET /portal/jobs/:id), fills the band (title, the state, Accept while it waits, ⋯ Decline, the job sheet, Ask a
 * question, the five tabs), keeps what is typed (the kit count, today's pieces, the send-back, a problem: leaving asks
 * first), sends each act at the version shown with ONE Idempotency-Key per body, says the end in our words, and reads again
 * on the live channel's job events. A report not sent for want of a connection stays on the page (no background queue).
 */
export function SupplierJobPage({ id }: { id: string }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'photo-kit']}>
      <JobContainer id={id} />
    </WithMessages>
  )
}

const NO_KIT: KitDraft = { lines: {} }
const NO_PROGRESS: ProgressDraft = { grids: {}, whole: {}, finishBy: '', note: '' }
const NO_RETURN: ReturnDraft = { rows: {}, material: {}, parcels: '1', expectedDate: '', weCollect: false, ddtNumber: '', ddtDate: '', note: '' }

function JobContainer({ id }: { id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const search = useSearchParams()
  const words = useJobWords()
  const { t, say } = words
  const offline = useOffline()
  const today = useToday()
  const mayAct = usePortalCapabilities()
  const allowed = frame.me.permissions.includes('portal.jobs.view')

  const [page, setPage] = useState<JobPage | null>(null)
  const [state, setState] = useState<JobRecordViewModel['state'] | 'forbidden'>('loading')
  const [readAt, setReadAt] = useState<string | null>(null)
  const [kitLines, setKitLines] = useState(false)
  const [kit, setKit] = useState<KitDraft>(NO_KIT)
  const [progress, setProgress] = useState<ProgressDraft>(NO_PROGRESS)
  const [returns, setReturns] = useState<ReturnDraft>(NO_RETURN)
  const [problem, setProblem] = useState<ProblemDraft>(PROBLEM_DRAFT)
  const [busy, setBusy] = useState<ActName | null>(null)
  const [refusal, setRefusal] = useState<{ act: ActName; words: Words } | null>(null)
  const [end, setEnd] = useState<ActEnd | null>(null)
  const [accept, setAccept] = useState<AcceptModel | null>(null)
  const [decline, setDecline] = useState<DeclineModel | null>(null)
  const [photo, setPhoto] = useState<(PhotoModel & { lineId: string }) | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const typed = useRef({ progress: false, returns: false, kit: false })
  const actKey = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (actKey.current?.body !== text) actKey.current = { body: text, key: newIdempotencyKey() }
    return actKey.current.key
  }

  const fresh = useCallback(
    (next: JobPage, keepTyped: boolean) => {
      setPage(next)
      setReadAt(new Date().toISOString())
      setState('ready')
      // A newer read keeps what was typed; a fresh page (or after a send) starts from the job.
      if (!keepTyped || !typed.current.kit) setKit(kitDraftOf(next.job))
      if (!keepTyped || !typed.current.progress) setProgress(progressDraftOf(next.job))
      if (!keepTyped || !typed.current.returns) setReturns(returnDraftOf(next.job, today))
    },
    [today],
  )

  const load = useCallback(
    async (keepTyped = true) => {
      try {
        fresh(await fetchJob(api, id), keepTyped)
      } catch (error) {
        if (isApiError(error) && error.kind === 'not_found') setState('missing')
        else if (isApiError(error) && error.kind === 'forbidden') setState('forbidden')
        else setState((current) => (current === 'ready' ? current : 'error'))
      }
    },
    [api, id, fresh],
  )

  useEffect(() => {
    if (!allowed) return
    void load(false)
  }, [load, allowed])

  usePortalLive({ onChange: (change) => (page?.live.events.includes(change.type) ? void load() : undefined), onReconnect: () => void load() }, allowed)

  const tabParam = search?.get('tab') ?? null
  const tab = isRecordTab(tabParam) ? tabParam : page ? tabFor(page.job.nextStep) : 'progress'
  const job = page?.job ?? null
  const facts: PersonFacts = { preview: frame.me.preview, offline, busy: busy !== null, mayAct: page ? { approve: page.mayAct.approve && mayAct.approve, comment: page.mayAct.comment && mayAct.comment, upload: page.mayAct.upload && mayAct.upload } : mayAct }

  const dirty = (job ? progressTyped(progress, job) > 0 : false) || problem.note.trim() !== '' || (typed.current.returns && returns.ddtNumber.trim() !== '') || (kitLines && typed.current.kit)
  usePortalUnsaved(`job:${id}`, { dirty, what: t('unsaved.job') })

  // ── one act ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const run = async (name: ActName, act: JobAct, endOf: (next: JobPage) => ActEnd) => {
    if (!job || busy) return
    setBusy(name)
    setRefusal(null)
    setEnd(null)
    try {
      const next = await sendJobAct(api, job.id, job.version, act, keyFor({ id: job.id, ...act }))
      actKey.current = null
      typed.current = { ...typed.current, ...(name === 'kit' ? { kit: false } : name === 'progress' ? { progress: false } : name === 'sendBack' ? { returns: false } : {}) }
      if (name === 'kit') setKitLines(false)
      fresh(next, true)
      if (name === 'kit') setKit(kitDraftOf(next.job))
      if (name === 'progress') setProgress(progressDraftOf(next.job))
      if (name === 'sendBack') setReturns(returnDraftOf(next.job, today))
      setEnd(endOf(next))
      setAccept(null)
      setDecline(null)
      setReviewing(false)
      frame.refreshTasks()
    } catch (error) {
      setRefusal({ act: name, words: writeProblem(error) })
      if (isApiError(error) && error.kind === 'conflict') void load()
      return error
    } finally {
      setBusy(null)
    }
  }

  const sendAccept = async () => {
    if (!job || !accept) return
    if (actHeld(job, facts, 'accept') ?? acceptHeld(accept.draft, job, today)) return
    const body = acceptBody(accept.draft)
    const error = await run('accept', { act: 'accept', body }, (next) => ({ kind: 'accepted', proposedDate: body.proposedDate ?? null, kitDay: kitDayOf(next.job) }))
    if (error) setAccept((current) => (current ? { ...current, problem: writeProblem(error) } : current))
  }
  const sendDecline = async () => {
    if (!job || !decline) return
    const held = actHeld(job, facts, 'decline') ?? declineHeld(decline.draft)
    if (held) return setDecline({ ...decline, tried: true })
    const error = await run('decline', { act: 'decline', body: declineBody(decline.draft) }, () => ({ kind: 'declined' }))
    if (error) setDecline((current) => (current ? { ...current, problem: writeProblem(error) } : current))
  }
  const sendKitAll = () => {
    if (!job || actHeld(job, facts, 'kit')) return
    const lines = kitToCount(job).length
    void run('kit', kitAllAct(), () => ({ kind: 'kit', lines, short: 0 }))
  }
  const sendKitLines = () => {
    if (!job || (actHeld(job, facts, 'kit') ?? kitHeld(kit, job))) return
    const act = kitLinesAct(kit, job)
    const lines = act.act === 'kit' ? (act.body.lines ?? []) : []
    const short = lines.filter((line) => Number(line.quantity) < Number(job.kit.lines.find((entry) => entry.id === line.kitLineId)?.quantity ?? 0)).length
    void run('kit', act, () => ({ kind: 'kit', lines: lines.length, short }))
  }
  const sendProgress = () => {
    if (!job || (actHeld(job, facts, 'progress') ?? progressHeld(progress, job))) return
    const pieces = progressTyped(progress, job)
    void run('progress', progressAct(progress, job), () => ({ kind: 'progress', pieces }))
  }
  const sendReturn = () => {
    if (!job || (actHeld(job, facts, 'sendBack') ?? returnHeld(returns, job, today))) return
    const pieces = returnPieces(returns)
    const day = returns.expectedDate
    void run('sendBack', returnAct(returns), () => ({ kind: 'returns', pieces: pieces.finished + pieces.scrapped, day }))
  }
  const sendProblem = async () => {
    if (!job || busy || (actHeld(job, facts, 'problem') ?? problemHeld(problem))) return
    setBusy('problem')
    setRefusal(null)
    setEnd(null)
    const text = problemText(problem, t)
    try {
      await postMessage(api, 'SubcontractOrder', job.id, text, keyFor({ problem: text }))
      actKey.current = null
      setProblem(PROBLEM_DRAFT)
      setEnd({ kind: 'problem' })
    } catch (error) {
      setRefusal({ act: 'problem', words: writeProblem(error) })
    } finally {
      setBusy(null)
    }
  }
  const capture = async (shot: CapturedPhoto) => {
    if (!job || !photo) return
    setPhoto({ ...photo, busy: true, problem: null })
    setBusy('photo')
    try {
      const name = `${job.number}-kit-${photo.line.seq}.jpg`
      const file = await uploadKitPhoto(api, job.id, photo.lineId, shot.photo, name)
      setPhoto(null)
      setEnd({ kind: 'photo', name: file.originalName })
      void load()
    } catch (error) {
      setPhoto((current) => (current ? { ...current, busy: false, problem: writeProblem(error) } : current))
    } finally {
      setBusy(null)
    }
  }

  const openAccept = () => job && setAccept({ number: job.number, job, loading: false, draft: ACCEPT_DRAFT, today, person: frame.me.user.displayName, busy: false, heldReason: null, problem: null })
  const openDecline = () => job && setDecline({ number: job.number, draft: DECLINE_DRAFT, tried: false, busy: false, heldReason: null, problem: null })

  usePortalBand(
    allowed && state !== 'forbidden' && job
      ? jobBandOf({ t, job, tab, prefix: frame.prefix, acceptHeld: say(actHeld(job, facts, 'accept')), declineHeld: say(actHeld(job, facts, 'decline')), onAccept: openAccept, onDecline: openDecline })
      : { title: t('record.titleLoading'), back: { href: `${frame.prefix}/jobs`, label: t('list.title') } },
  )

  if (!allowed || state === 'forbidden') return <NotInAccessHere />

  const model: JobRecordViewModel = {
    state,
    page,
    tab,
    prefix: frame.prefix,
    today,
    facts,
    kitLines,
    kit,
    progress,
    returns,
    problem,
    busy,
    refusal,
    end,
    accept: accept && job ? { ...accept, busy: busy === 'accept', heldReason: busy === 'accept' ? { key: 'held.busy' } : (actHeld(job, facts, 'accept') ?? acceptHeld(accept.draft, job, today)) } : null,
    decline: decline && job ? { ...decline, busy: busy === 'decline', heldReason: busy === 'decline' ? { key: 'held.busy' } : (actHeld(job, facts, 'decline') ?? declineHeld(decline.draft)) } : null,
    photo: photo && job ? { line: photo.line, busy: photo.busy, problem: photo.problem, heldReason: photo.busy ? { key: 'held.busy' } : actHeld(job, { ...facts, busy: false }, 'photo') } : null,
    review: reviewing && job ? { job, draft: returns, busy: busy === 'sendBack', problem: refusal?.act === 'sendBack' ? refusal.words : null, heldReason: busy === 'sendBack' ? { key: 'held.busy' } : (actHeld(job, facts, 'sendBack') ?? returnHeld(returns, job, today)) } : null,
    offlineSince: offline && page ? readAt : null,
  }

  return (
    <JobRecordView
      model={model}
      actions={{
        onRetry: () => {
          setState('loading')
          void load(false)
        },
        onAccept: openAccept,
        onDecline: openDecline,
        onKitAll: sendKitAll,
        onKitLines: (on) => {
          setKitLines(on)
          if (!on && job) {
            typed.current.kit = false
            setKit(kitDraftOf(job))
          }
        },
        onKitDraft: (draft) => {
          typed.current.kit = true
          setKit(draft)
        },
        onKitSend: sendKitLines,
        onPhoto: (line: KitLine) => setPhoto({ lineId: line.id, line: { seq: line.seq, name: line.item.name || line.item.code }, busy: false, heldReason: null, problem: null }),
        onProgressDraft: (draft) => {
          typed.current.progress = true
          setProgress(draft)
        },
        onProgressSend: sendProgress,
        onProblemDraft: setProblem,
        onProblemSend: () => void sendProblem(),
        onReturnDraft: (draft) => {
          typed.current.returns = true
          setReturns(draft)
        },
        onReturnReview: () => {
          if (job && !(actHeld(job, facts, 'sendBack') ?? returnHeld(returns, job, today))) setReviewing(true)
        },
        onDismissEnd: () => setEnd(null),
        accept: {
          onDraft: (draft) => setAccept((current) => (current ? { ...current, draft, problem: null } : current)),
          onSend: () => void sendAccept(),
          onDecline: () => {
            setAccept(null)
            openDecline()
          },
          onClose: () => (busy ? undefined : setAccept(null)),
        },
        decline: {
          onDraft: (draft) => setDecline((current) => (current ? { ...current, draft, problem: null } : current)),
          onSend: () => void sendDecline(),
          onClose: () => (busy ? undefined : setDecline(null)),
        },
        photo: { onCapture: capture, onClose: () => (photo?.busy ? undefined : setPhoto(null)) },
        review: { onSend: sendReturn, onClose: () => (busy ? undefined : setReviewing(false)) },
      }}
    >
      {job ? <PortalThread type="SubcontractOrder" id={job.id} showRecord={false} headingLevel={2} /> : null}
    </JobRecordView>
  )
}
