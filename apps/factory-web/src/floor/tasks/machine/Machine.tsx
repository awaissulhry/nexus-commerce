'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useFloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { useLiveChanges } from '../../../record-panels/live'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import { floorStepUp, steppedUp } from '../shared/step-up'
import type { TaskProblem } from '../shared/task-api'
import {
  confirmAsLead,
  freshKey,
  moveJob,
  openMedia,
  readFloorRequest,
  readJob,
  readJobs,
  readMachine,
  readQueue,
  readStation,
  readStationRequests,
  signSafe,
  stepOrKeep,
  uploadMedia,
  type FloorJob,
  type FloorRequest,
  type FloorRequestRecord,
  type JobRecord,
  type ProgressMove,
  type QueueEntry,
  type StationAnswer,
  type StationMachine,
  type StoredMedia,
  type TechnicianMove,
} from './api'
import { closeBody, closeDraftOf, closeHeld, INCIDENT_PAGE, mediaHeld, mediaName, nextUpload, offersIncident, type MediaKind, type UploadState } from './depth'
import { offerIncident } from '../incident/handoff'
import { defaultSafeAfter, EMPTY_DRAFT, firstStep, isUnsafe, labelOf, machineByTag, machineCan, pickedSymptom, reportHeld, reportPayload, signHeld } from './model'
import type { Peek } from './view/MediaParts'
import type { RequestDone } from './view/ProgressParts'
import { MachineView, type JobDone, type MachineAction, type MachineStep } from './view/MachineView'

/**
 * The live SCR-179 (`/floor/machine`; B-W2a-73 on the API of B-W2a-35, B-W2b-102 on the API of B-W2b-96): a machine
 * problem from the station and the technician's job. It reads the station's machines (`GET /plant/floor/machines`, with
 * `?code=` for a scanned tag) and the station's reports still under way (`GET /plant/floor/requests`), saves the report in
 * the tablet's queue first (kind `plant.report`: it works offline and is sent in the queue's order; the office records it
 * once), follows its two ticks, reads the machine again once it is recorded, and then sends the photos and voice notes
 * taken with it to the request the office named (the queue's receipt). A report opens on its progress
 * (`GET /plant/floor/requests/:id`): "It works", Seen and On my way go online first and keep on the tablet under the same
 * id when the network fails (`plant.request.progress`); the line lead's confirmation is online only. A technician
 * (plant.jobs.work) opens on My jobs with the site's requests above it (`GET /plant/floor/queue`), reads a job
 * (`GET /plant/jobs/:id`), makes the moves online with one Idempotency-Key each (kept for a retry), closes it on one screen
 * (action, failure code, the office's minutes, before and after photos) and signs an unsafe request safe with the PIN
 * (403 stepUp → POST /floor/step-up → the same act again: Owner answer H1). What the tablet read stays for this visit with
 * its time (offline: "as of"); new rows of a list wait behind "Show" (B-W2b-28) when the live stream (or the 30 s beat that
 * covers a missed hint) changes them; a step kept offline reads its report again once the office has it. A code
 * scanned on Home or on Scan anything opens here with that machine.
 */

const STATIONS = new AsOfMemory<StationAnswer>(4)
const MACHINES = new AsOfMemory<StationMachine>(100)
const JOBS = new AsOfMemory<FloorJob[]>(2)
const JOB_RECORDS = new AsOfMemory<JobRecord>(50)
const STATION_REQUESTS = new AsOfMemory<FloorRequest[]>(2)
const REQUESTS = new AsOfMemory<FloorRequestRecord>(50)
const QUEUE = new AsOfMemory<QueueEntry[]>(2)

/** The live events that change what this screen shows (their floor rules: plant.report, plant.jobs.work). */
const LIVE = new Set([
  'maintenance_request.reported',
  'maintenance_request.triaged',
  'maintenance_request.progressed',
  'maintenance_request.signed_safe',
  'machine.status_changed',
  'maintenance_job.created',
  'maintenance_job.changed',
  'maintenance_job.assigned',
  'maintenance_job.moved',
])
/** Several events of one change arrive together: one read after a short pause. */
const LIVE_PAUSE_MS = 1500
/** The re-read beat while the screen is in view (a missed live hint). */
const BEAT_MS = 30_000

type Back = 'which' | 'jobs'

const quietProblem = (problem: TaskProblem) => problem.kind === 'offline' || problem.kind === 'unavailable'

export function FloorMachine() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.machine', { showHome: true })
  const { api, me, online, sessionEnded, queue, queueSnapshot } = store
  const deviceId = store.device?.device.id ?? null
  const permissions = me?.permissions
  const can = useMemo(() => machineCan(permissions ?? []), [permissions])
  const [step, setStep] = useState<MachineStep>({ kind: 'loading' })
  const current = useRef(step)
  current.current = step
  /** Where Back goes from the report (a technician who came from My jobs goes back there). */
  const from = useRef<Back>('which')
  /** The report saved in the queue: its id, the machine read again once recorded. */
  const sent = useRef<{ id: string; machineId: string; read: boolean } | null>(null)
  /** The photos and voice notes taken with the sent report, by id, until each is up (this page's memory only). */
  const sentMedia = useRef(new Map<string, { kind: MediaKind; blob: Blob; name: string }>())
  /** A move's key, kept while its answer is lost (a resend is answered once). */
  const pending = useRef<{ what: string; key: string } | null>(null)
  /** A progress step kept on the tablet (no network): the report is read again once the office has it. */
  const keptStep = useRef<{ id: string; requestId: string; move: ProgressMove } | null>(null)
  /** The blob address of the photo or voice note open in the dialog (freed when it closes). */
  const peekUrl = useRef<string | null>(null)
  const [stepUntil, setStepUntil] = useState<string | null>(null)
  const taken = useRef(false)

  // The station's reports and the technician's queue as the server has them; new rows wait behind Show (B-W2b-28).
  const [stationIncoming, setStationIncoming] = useState<readonly FloorRequest[] | null>(null)
  const [queueIncoming, setQueueIncoming] = useState<readonly QueueEntry[] | null>(null)
  const stationLive = useFloorListUpdates(stationIncoming, { key: (request) => request.id, version: (request) => `${request.progress.step}:${request.locking}:${request.progress.canConfirm}` })
  const queueLive = useFloorListUpdates(queueIncoming, { key: (entry) => entry.request.id, version: (entry) => `${entry.request.progress.step}:${entry.toMe}:${entry.request.locking}:${entry.canAcknowledge}:${entry.canGo}` })
  /** A read the person asked for (opening the screen, Back, their own step): its rows go in at once. */
  const atOnce = useRef({ station: false, queue: false })
  const showStation = stationLive.show
  const showQueue = queueLive.show
  useEffect(() => {
    if (atOnce.current.station && stationLive.pending > 0) showStation()
    atOnce.current.station = false
  }, [stationIncoming, stationLive.pending, showStation])
  useEffect(() => {
    if (atOnce.current.queue && queueLive.pending > 0) showQueue()
    atOnce.current.queue = false
  }, [queueIncoming, queueLive.pending, showQueue])

  const keyFor = (what: string): string => {
    if (pending.current?.what !== what) pending.current = { what, key: freshKey() }
    return pending.current.key
  }

  const ended = useCallback(
    (problem: TaskProblem): boolean => {
      if (problem.kind !== 'signedOut') return false
      void sessionEnded()
      return true
    },
    [sessionEnded],
  )

  const remember = (answer: StationAnswer) => {
    for (const machine of answer.machines) MACHINES.keep(codeKey(machine.assetNumber), machine)
    if (answer.found) MACHINES.keep(codeKey(answer.found.assetNumber), answer.found)
  }

  // ---- the station ------------------------------------------------------------------------------------------------------

  /** The station's reports under way (kept for offline), into the list at once or behind Show. */
  const readReported = useCallback(
    async (now: boolean) => {
      if (!can.report) return
      const answer = await readStationRequests(api)
      if (answer.ok) STATION_REQUESTS.keep('station', answer.value.requests)
      const rows = answer.ok ? answer.value.requests : (STATION_REQUESTS.get('station')?.value ?? null)
      if (rows === null) return
      if (now) atOnce.current.station = true
      setStationIncoming(rows)
    },
    [api, can.report],
  )

  const loadStation = useCallback(
    async (extra: Partial<Extract<MachineStep, { kind: 'which' }>> = {}) => {
      from.current = 'which'
      const known = STATIONS.get('station')
      if (!known) setStep({ kind: 'loading' })
      void readReported(true)
      const answer = await readStation(api)
      if (!answer.ok) {
        if (ended(answer.problem)) return
        if (known && quietProblem(answer.problem)) {
          return setStep({ kind: 'which', station: known.value.station, machines: known.value.machines, blocked: known.value.words.blocked, asOf: known.asOf, ...extra })
        }
        return setStep({ kind: 'problem', problem: answer.problem, back: 'which' })
      }
      STATIONS.keep('station', answer.value)
      remember(answer.value)
      setStep({ kind: 'which', station: answer.value.station, machines: answer.value.machines, blocked: answer.value.words.blocked, asOf: null, ...extra })
    },
    [api, ended, readReported],
  )

  const openMachine = (machine: StationMachine, asOf: string | null = null) => {
    setStep({ kind: 'symptom', machine, draft: EMPTY_DRAFT, asOf })
  }

  /** A scanned tag: the machine of this site with that number (any state), else said in words; a badge switches person. */
  const openTag = useCallback(
    async (code: string) => {
      if (!me) return
      const read = readScan(code, me.scanTag)
      if (read.kind === 'badge') {
        if (await store.switchTo(read.code)) feedback('error')
        return
      }
      const which = current.current.kind === 'which' ? current.current : null
      const base = which ?? { kind: 'which' as const, station: STATIONS.get('station')?.value.station ?? null, machines: STATIONS.get('station')?.value.machines ?? [], blocked: STATIONS.get('station')?.value.words.blocked ?? false }
      if (!online) {
        const kept = MACHINES.get(codeKey(code))
        if (kept) return openMachine(kept.value, kept.asOf)
        feedback('error')
        return setStep({ ...base, reading: null, scanned: { code, why: 'offline' } })
      }
      setStep({ ...base, reading: code, scanned: null })
      const answer = await readStation(api, code)
      if (!answer.ok) {
        if (ended(answer.problem)) return
        const kept = MACHINES.get(codeKey(code))
        if (kept && quietProblem(answer.problem)) return openMachine(kept.value, kept.asOf)
        feedback('error')
        return setStep({ ...base, reading: null, scanned: { code, why: answer.problem.kind === 'offline' ? 'offline' : 'unavailable' } })
      }
      STATIONS.keep('station', answer.value)
      remember(answer.value)
      const found = answer.value.found ?? machineByTag(answer.value.machines, code)
      if (!found) {
        feedback('error')
        return setStep({ kind: 'which', station: answer.value.station, machines: answer.value.machines, blocked: answer.value.words.blocked, reading: null, scanned: { code, why: 'notFound' } })
      }
      feedback('success')
      openMachine(found)
    },
    [api, ended, feedback, me, online, store],
  )

  // ---- the technician's jobs ----------------------------------------------------------------------------------------------

  /** The site's open requests (the technician's queue), into the list at once or behind Show. */
  const readTheQueue = useCallback(
    async (now: boolean) => {
      if (!can.work) return
      const answer = await readQueue(api)
      if (answer.ok) QUEUE.keep('queue', answer.value)
      const rows = answer.ok ? answer.value : (QUEUE.get('queue')?.value ?? null)
      if (rows === null) return
      if (now) atOnce.current.queue = true
      setQueueIncoming(rows)
    },
    [api, can.work],
  )

  const loadJobs = useCallback(async () => {
    from.current = 'jobs'
    const known = JOBS.get('mine')
    if (!known) setStep({ kind: 'loading' })
    void readTheQueue(true)
    const answer = await readJobs(api)
    if (!answer.ok) {
      if (ended(answer.problem)) return
      if (known && quietProblem(answer.problem)) return setStep({ kind: 'jobs', jobs: known.value, asOf: known.asOf })
      return setStep({ kind: 'problem', problem: answer.problem, back: 'jobs' })
    }
    JOBS.keep('mine', answer.value)
    setStep({ kind: 'jobs', jobs: answer.value, asOf: null })
  }, [api, ended, readTheQueue])

  const loadJob = useCallback(
    async (jobId: string, done: JobDone | null = null) => {
      const known = JOB_RECORDS.get(jobId)
      if (!known) setStep({ kind: 'loading' })
      const answer = await readJob(api, jobId)
      if (!answer.ok) {
        if (ended(answer.problem)) return
        if (known && quietProblem(answer.problem)) return setStep({ kind: 'job', record: known.value, asOf: known.asOf, done })
        return setStep({ kind: 'problem', problem: answer.problem, back: 'jobs' })
      }
      JOB_RECORDS.keep(jobId, answer.value)
      setStep({ kind: 'job', record: answer.value, asOf: null, done })
    },
    [api, ended],
  )

  // ---- one report and its progress (B-W2b-102) ---------------------------------------------------------------------------

  const openRequest = useCallback(
    async (requestId: string, back: Back, done: RequestDone | null = null) => {
      const known = REQUESTS.get(requestId)
      if (!known) setStep({ kind: 'loading' })
      const answer = await readFloorRequest(api, requestId)
      if (!answer.ok) {
        if (ended(answer.problem)) return
        if (known && quietProblem(answer.problem)) return setStep({ kind: 'request', record: known.value, back, asOf: known.asOf, done })
        return setStep({ kind: 'problem', problem: answer.problem, back })
      }
      REQUESTS.keep(requestId, answer.value)
      setStep({ kind: 'request', record: answer.value, back, asOf: null, done })
    },
    [api, ended],
  )

  // ---- where the screen opens ---------------------------------------------------------------------------------------------

  useEffect(() => {
    if (taken.current || !me) return
    taken.current = true
    const code = store.takeScan()
    if (code) {
      void loadStation().then(() => openTag(code))
      return
    }
    if (firstStep(can) === 'jobs') void loadJobs()
    else void loadStation()
  }, [me, can, store, loadStation, loadJobs, openTag])

  // ---- live: the station sees a request acknowledged or fixed; the technician a new request ----------------------------------

  const liveTimer = useRef<number | null>(null)
  const refreshNow = useCallback(async () => {
    const now = current.current
    if (now.kind === 'which') return void readReported(false)
    if (now.kind === 'jobs') return void readTheQueue(false)
    if (now.kind === 'request' && !now.busy && !now.capture && !now.uploading) {
      const answer = await readFloorRequest(api, now.record.request.id)
      const still = current.current
      if (!answer.ok || still.kind !== 'request' || still.record.request.id !== now.record.request.id || still.busy) return
      REQUESTS.keep(now.record.request.id, answer.value)
      setStep({ ...still, record: answer.value, asOf: null })
    }
  }, [api, readReported, readTheQueue])
  const soon = useCallback(() => {
    if (liveTimer.current !== null) return
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null
      void refreshNow()
    }, LIVE_PAUSE_MS)
  }, [refreshNow])
  useEffect(
    () => () => {
      if (liveTimer.current !== null) window.clearTimeout(liveTimer.current)
      if (peekUrl.current) URL.revokeObjectURL(peekUrl.current)
    },
    [],
  )
  useLiveChanges({ onChange: (change) => (LIVE.has(change.type) ? soon() : undefined), onReconnect: soon }, Boolean(me) && online)
  // A missed hint (no dispatcher, a dropped stream): the screen reads again every 30 s while it is in view (as Help, Line view).
  useEffect(() => {
    if (!me || !online) return
    const beat = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshNow()
    }, BEAT_MS)
    return () => window.clearInterval(beat)
  }, [me, online, refreshNow])

  // ---- the sent report's two ticks; the machine read again once recorded; its photos and voice notes up -----------------------

  useEffect(() => {
    const shown = current.current
    if (shown.kind !== 'sent' || !sent.current) return
    const view = queuedView(queueSnapshot, sent.current.id)
    if (!view) return
    const refusal = view.refusal ? { code: view.refusal.code, message: view.refusal.message } : null
    // The office's receipt names the request it made: the photos and voice notes go to it, Follow it opens it.
    const result = view.ticks === 'recorded' ? view.item?.result : null
    const requestId = result && result.type === 'MaintenanceRequest' ? result.id : (shown.requestId ?? null)
    if (view.ticks !== shown.ticks || (refusal?.code ?? null) !== (shown.refusal?.code ?? null) || requestId !== (shown.requestId ?? null)) setStep({ ...shown, ticks: view.ticks, refusal, requestId })
    if (view.ticks === 'recorded' && online && !sent.current.read) {
      sent.current.read = true
      const machineId = sent.current.machineId
      void readMachine(api, machineId).then((answer) => {
        const now = current.current
        if (!answer.ok || now.kind !== 'sent') return
        setStep({ ...now, now: { status: answer.value.card.machine.status, locked: answer.value.card.machine.locked } })
      })
    }
  }, [queueSnapshot, online, api])

  // A step kept on the tablet: once the office has it the report is read again (its words say what was done); a refusal is said.
  useEffect(() => {
    const kept = keptStep.current
    if (!kept) return
    const view = queuedView(queueSnapshot, kept.id)
    if (!view || (view.ticks !== 'recorded' && view.ticks !== 'refused')) return
    keptStep.current = null
    const now = current.current
    if (now.kind !== 'request' || now.record.request.id !== kept.requestId) return
    if (view.ticks === 'refused') {
      setStep({ ...now, done: null, problem: { kind: 'refused', code: view.refusal?.code ?? 'REFUSED', message: view.refusal?.message ?? '', fix: null } })
      return
    }
    if (kept.move === 'WORKS_AGAIN') atOnce.current.station = true
    void openRequest(kept.requestId, now.back, kept.move === 'WORKS_AGAIN' ? 'works' : kept.move === 'ACKNOWLEDGE' ? 'acknowledged' : 'onTheWay')
  }, [queueSnapshot, openRequest])

  const setUpload = (id: string, state: UploadState) =>
    setStep((now) => (now.kind === 'sent' ? { ...now, uploads: (now.uploads ?? []).map((entry) => (entry.id === id ? { ...entry, state } : entry)) } : now))

  useEffect(() => {
    if (step.kind !== 'sent' || step.ticks !== 'recorded' || !step.requestId || !online) return
    const next = nextUpload(step.uploads ?? [])
    const media = next ? sentMedia.current.get(next.id) : null
    if (!next || !media) return
    const requestId = step.requestId
    setUpload(next.id, 'sending')
    void uploadMedia(api, { type: 'request', id: requestId }, media.kind, media.blob, media.name).then((answer) => {
      if (!answer.ok && ended(answer.problem)) return
      if (answer.ok) sentMedia.current.delete(next.id)
      setUpload(next.id, answer.ok ? 'added' : 'failed')
    })
  }, [step, online, api, ended])

  // ---- what the person does ------------------------------------------------------------------------------------------------

  const report = async (down: boolean) => {
    const shown = current.current
    if (shown.kind !== 'symptom') return
    const symptom = pickedSymptom(shown.machine, shown.draft)
    if (reportHeld({ can, machine: shown.machine, symptom, words: shown.draft.words })) return
    const unsafe = isUnsafe(symptom, shown.draft)
    try {
      const item = await queue.enqueue('plant.report', reportPayload(shown.machine, shown.draft, down))
      sent.current = { id: item.clientEventId, machineId: shown.machine.id, read: false }
      sentMedia.current = new Map(shown.draft.media.map((entry) => [entry.id, { kind: entry.kind, blob: entry.blob, name: entry.name }]))
      feedback(unsafe ? 'warning' : 'success')
      setStep({
        kind: 'sent',
        machine: shown.machine,
        symptom: symptom ? labelOf(symptom, store.locale) : shown.draft.words.trim() || null,
        unsafe,
        down,
        ticks: 'saved',
        refusal: null,
        now: null,
        requestId: null,
        uploads: shown.draft.media.map((entry) => ({ id: entry.id, kind: entry.kind, name: entry.name, state: 'waiting' as const })),
        incident: offersIncident(symptom),
      })
    } catch {
      feedback('error')
      setStep({ kind: 'problem', problem: { kind: 'unavailable' }, code: shown.machine.assetNumber, back: 'which' })
    }
  }

  /** The person is still on this job's step (a late answer never takes them back from where they went). */
  const stillOn = (kind: MachineStep['kind'], jobId: string): boolean => {
    const now = current.current
    return now.kind === kind && (now.kind === 'job' || now.kind === 'handBack' || now.kind === 'sign') && now.record.job.id === jobId
  }

  /** The person is still on this report. */
  const stillOnRequest = (requestId: string): boolean => {
    const now = current.current
    return now.kind === 'request' && now.record.request.id === requestId
  }

  const move = async (what: Exclude<TechnicianMove, 'handBack'>) => {
    const shown = current.current
    if (shown.kind !== 'job' || shown.busy) return
    setStep({ ...shown, busy: true, problem: null, done: null })
    const answer = await moveJob(api, shown.record.job, what, keyFor(`${what}:${shown.record.job.id}:${shown.record.job.version}`))
    if (!answer.ok) {
      if (ended(answer.problem)) return
      feedback('error')
      if (stillOn('job', shown.record.job.id)) setStep({ ...shown, busy: false, problem: answer.problem })
      return
    }
    pending.current = null
    feedback('success')
    if (stillOn('job', shown.record.job.id)) await loadJob(shown.record.job.id, what === 'start' ? 'started' : what === 'wait' ? 'waiting' : 'reopened')
  }

  /** The one-screen close (QHS-190): action, failure code, machine after, words when written. */
  const handBack = async () => {
    const shown = current.current
    if (shown.kind !== 'handBack') return
    if (closeHeld(shown.draft, shown.record.job.machine, online, shown.busy || shown.uploading)) return
    setStep({ ...shown, busy: true, problem: null })
    const job = shown.record.job
    const answer = await moveJob(api, job, 'handBack', keyFor(`handBack:${job.id}:${job.version}`), closeBody(shown.draft))
    if (!answer.ok) {
      if (ended(answer.problem)) return
      feedback('error')
      if (stillOn('handBack', job.id)) setStep({ ...shown, busy: false, problem: answer.problem })
      return
    }
    pending.current = null
    feedback('success')
    if (stillOn('handBack', job.id)) await loadJob(job.id, 'handedBack')
  }

  const sign = async (pinJustProved = false) => {
    const shown = current.current
    if (shown.kind !== 'sign') return
    if (signHeld(shown.draft, can, online, false)) return
    const fresh = pinJustProved || steppedUp(stepUntil) || steppedUp(me?.session.stepUpUntil)
    if (!fresh) return setStep({ ...shown, pin: true, pinProblem: null, problem: null })
    setStep({ ...shown, busy: true, problem: null })
    const answer = await signSafe(api, shown.request, { note: shown.draft.words.trim(), machineAfter: shown.draft.after }, keyFor(`sign:${shown.request.id}:${shown.request.version}`))
    if (!answer.ok) {
      if (ended(answer.problem) || !stillOn('sign', shown.record.job.id)) return
      if (answer.problem.kind === 'stepUp') return setStep({ ...shown, busy: false, pin: true, pinProblem: null })
      feedback('error')
      return setStep({ ...shown, busy: false, pin: false, problem: answer.problem })
    }
    pending.current = null
    feedback('success')
    if (stillOn('sign', shown.record.job.id)) await loadJob(shown.record.job.id, 'signed')
  }

  const pin = async (value: string) => {
    const shown = current.current
    if (shown.kind !== 'sign') return
    setStep({ ...shown, busy: true, pinProblem: null })
    const proved = await floorStepUp(api, value)
    if (!proved.ok) {
      if (proved.problem === 'signedOut') return void sessionEnded()
      feedback('error')
      return setStep({ ...shown, busy: false, pin: true, pinProblem: proved.problem })
    }
    setStepUntil(proved.until)
    setStep({ ...shown, busy: false, pin: false })
    await sign(true)
  }

  /** "It works", Seen, On my way: online first; a network failure keeps it on the tablet under the try's id (B-W2b-77). */
  const progress = async (asked: ProgressMove) => {
    const shown = current.current
    if (shown.kind !== 'request' || shown.busy) return
    const request = shown.record.request
    setStep({ ...shown, busy: true, problem: null, done: null })
    try {
      const outcome = await stepOrKeep(api, queue, online, deviceId, request.id, asked)
      if (outcome.kept) {
        keptStep.current = { id: outcome.kept.clientEventId, requestId: request.id, move: asked }
        feedback('success')
        if (stillOnRequest(request.id)) setStep({ ...shown, busy: false, problem: null, done: 'kept' })
        return
      }
      if (!outcome.answer.ok) {
        if (ended(outcome.answer.problem)) return
        feedback('error')
        if (stillOnRequest(request.id)) setStep({ ...shown, busy: false, problem: outcome.answer.problem })
        return
      }
      feedback('success')
      if (asked === 'WORKS_AGAIN') atOnce.current.station = true
      if (stillOnRequest(request.id)) await openRequest(request.id, shown.back, asked === 'WORKS_AGAIN' ? 'works' : asked === 'ACKNOWLEDGE' ? 'acknowledged' : 'onTheWay')
    } catch {
      feedback('error')
      if (stillOnRequest(request.id)) setStep({ ...shown, busy: false, problem: { kind: 'unavailable' } })
    }
  }

  /** The line lead confirms the machine works (floor.lead): online only, one key until answered. */
  const leadConfirm = async () => {
    const shown = current.current
    if (!online) return
    if (shown.kind === 'request' && !shown.busy && shown.record.request.job) {
      const request = shown.record.request
      const jobId = request.job!.id
      setStep({ ...shown, busy: true, problem: null, done: null })
      const answer = await confirmAsLead(api, jobId, keyFor(`lead:${jobId}`))
      if (!answer.ok) {
        if (ended(answer.problem)) return
        feedback('error')
        if (stillOnRequest(request.id)) setStep({ ...shown, busy: false, problem: answer.problem })
        return
      }
      pending.current = null
      feedback('success')
      if (stillOnRequest(request.id)) await openRequest(request.id, shown.back, 'leadConfirmed')
      return
    }
    if (shown.kind === 'job' && !shown.busy) {
      const jobId = shown.record.job.id
      setStep({ ...shown, busy: true, problem: null, done: null })
      const answer = await confirmAsLead(api, jobId, keyFor(`lead:${jobId}`))
      if (!answer.ok) {
        if (ended(answer.problem)) return
        feedback('error')
        if (stillOn('job', jobId)) setStep({ ...shown, busy: false, problem: answer.problem })
        return
      }
      pending.current = null
      feedback('success')
      if (stillOn('job', jobId)) await loadJob(jobId, 'leadConfirmed')
    }
  }

  /** A photo or voice note just taken: kept with the report, or sent at once to the report or job on screen. */
  const tookMedia = async (kind: MediaKind, blob: Blob) => {
    const shown = current.current
    if (shown.kind === 'symptom') {
      if (mediaHeld({ online: true, count: shown.draft.media.length })) return
      const entry = { id: freshKey(), kind, blob, name: mediaName(kind, shown.machine.assetNumber, shown.draft.media.length + 1, blob.type) }
      feedback('success')
      return setStep({ ...shown, capture: null, draft: { ...shown.draft, media: [...shown.draft.media, entry] } })
    }
    if (shown.kind === 'request') {
      const request = shown.record.request
      setStep({ ...shown, capture: null, uploading: true, failed: false, done: null, problem: null })
      const name = mediaName(kind, request.machine.assetNumber, shown.record.files.length + 1, blob.type)
      const answer = await uploadMedia(api, { type: 'request', id: request.id }, kind, blob, name)
      if (!answer.ok) {
        if (ended(answer.problem)) return
        feedback('error')
        if (stillOnRequest(request.id)) setStep((now) => (now.kind === 'request' ? { ...now, uploading: false, failed: answer.problem.kind !== 'refused', problem: answer.problem.kind === 'refused' ? answer.problem : null } : now))
        return
      }
      feedback('success')
      if (stillOnRequest(request.id)) await openRequest(request.id, shown.back, 'added')
      return
    }
    if (shown.kind === 'handBack' && shown.capture) {
      const job = shown.record.job
      const category = shown.capture.kind === 'PHOTO' ? shown.capture.category : null
      setStep({ ...shown, capture: null, uploading: true, failed: false, problem: null })
      const name = mediaName(kind, job.number, shown.files.length + 1, blob.type)
      const answer = await uploadMedia(api, { type: 'job', id: job.id, category }, kind, blob, name)
      if (!answer.ok) {
        if (ended(answer.problem)) return
        feedback('error')
        if (stillOn('handBack', job.id)) setStep((now) => (now.kind === 'handBack' ? { ...now, uploading: false, failed: answer.problem.kind !== 'refused', problem: answer.problem.kind === 'refused' ? answer.problem : null } : now))
        return
      }
      feedback('success')
      const added: StoredMedia = { id: answer.value.fileId, kind, category, originalName: name, contentType: blob.type.split(';')[0]!.trim(), availableAt: new Date().toISOString() }
      if (stillOn('handBack', job.id)) setStep((now) => (now.kind === 'handBack' ? { ...now, uploading: false, files: [...now.files, added] } : now))
    }
  }

  const setPeek = (peek: Peek | null) => setStep((now) => (now.kind === 'request' || now.kind === 'job' || now.kind === 'handBack' ? { ...now, peek } : now))

  /** A photo or voice note opened on the tablet (the floor's download route; the blob freed when the dialog closes). */
  const open = async (file: StoredMedia) => {
    if (!online) return
    setPeek({ fileId: file.id, kind: file.kind, name: file.originalName, url: null })
    const answer = await openMedia(api, file)
    const now = current.current
    const shownPeek = now.kind === 'request' || now.kind === 'job' || now.kind === 'handBack' ? now.peek : null
    if (!shownPeek || shownPeek.fileId !== file.id) return
    if (!answer.ok) {
      if (ended(answer.problem)) return
      return setPeek({ ...shownPeek, failed: true })
    }
    if (peekUrl.current) URL.revokeObjectURL(peekUrl.current)
    peekUrl.current = URL.createObjectURL(answer.value)
    setPeek({ ...shownPeek, url: peekUrl.current })
  }

  const closePeek = () => {
    if (peekUrl.current) URL.revokeObjectURL(peekUrl.current)
    peekUrl.current = null
    setPeek(null)
  }

  const back = () => {
    const shown = current.current
    switch (shown.kind) {
      case 'symptom':
        if (shown.capture) return setStep({ ...shown, capture: null })
        return from.current === 'jobs' ? void loadJobs() : void loadStation()
      case 'sent':
        return from.current === 'jobs' ? void loadJobs() : void loadStation()
      case 'which':
        return can.work ? void loadJobs() : router.push('/floor')
      case 'jobs':
      case 'loading':
        return router.push('/floor')
      case 'job':
        if (shown.peek) return closePeek()
        return void loadJobs()
      case 'request':
        if (shown.peek) return closePeek()
        if (shown.capture) return setStep({ ...shown, capture: null })
        return shown.back === 'jobs' ? void loadJobs() : void loadStation()
      case 'handBack':
        if (shown.peek) return closePeek()
        if (shown.capture) return setStep({ ...shown, capture: null })
        return setStep({ kind: 'job', record: shown.record, asOf: null, done: null })
      case 'sign':
        return setStep({ kind: 'job', record: shown.record, asOf: null, done: null })
      case 'problem':
        return shown.back === 'jobs' ? void loadJobs() : void loadStation()
    }
  }

  const onAction = (action: MachineAction) => {
    const shown = current.current
    switch (action.type) {
      case 'scan':
        return void openTag(action.code)
      case 'machine': {
        if (shown.kind !== 'which') return
        const machine = shown.machines.find((entry) => entry.id === action.id)
        if (machine) openMachine(machine, shown.asOf ?? null)
        return
      }
      case 'symptom':
        if (shown.kind === 'symptom') setStep({ ...shown, draft: { ...shown.draft, symptomId: shown.draft.symptomId === action.id ? null : action.id } })
        return
      case 'words':
        if (shown.kind === 'symptom') setStep({ ...shown, draft: { ...shown.draft, words: action.text } })
        else if (shown.kind === 'handBack') setStep({ ...shown, draft: { ...shown.draft, words: action.text } })
        else if (shown.kind === 'sign') setStep({ ...shown, draft: { ...shown.draft, words: action.text } })
        return
      case 'unsafe':
        if (shown.kind === 'symptom') setStep({ ...shown, draft: { ...shown.draft, unsafe: action.on } })
        return
      case 'report':
        return void report(action.down)
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'another':
        from.current = 'which'
        return void loadStation()
      case 'jobs':
        return void loadJobs()
      case 'job':
        return void loadJob(action.id)
      case 'move':
        return void move(action.move)
      case 'handBack':
        if (shown.kind === 'job') setStep({ kind: 'handBack', record: shown.record, draft: closeDraftOf(shown.record), files: shown.record.files })
        return
      case 'after':
        if (shown.kind === 'handBack') setStep({ ...shown, draft: { ...shown.draft, after: action.after } })
        return
      case 'sendHandBack':
        return void handBack()
      case 'sign': {
        if (shown.kind !== 'job') return
        const request = shown.record.requests.find((entry) => entry.id === action.requestId)
        if (request) setStep({ kind: 'sign', record: shown.record, request, draft: { words: '', after: defaultSafeAfter(shown.record.job) } })
        return
      }
      case 'safeAfter':
        if (shown.kind === 'sign') setStep({ ...shown, draft: { ...shown.draft, after: action.after } })
        return
      case 'sendSign':
        return void sign()
      case 'pin':
        return void pin(action.pin)
      case 'retry':
        return back()
      // ---- B-W2b-102 ----
      case 'capture':
        if (shown.kind === 'symptom' || shown.kind === 'request') setStep({ ...shown, capture: action.kind })
        return
      case 'closeMedia':
        if (shown.kind === 'handBack') setStep({ ...shown, capture: action.kind === 'AUDIO' ? { kind: 'AUDIO' } : { kind: 'PHOTO', category: action.category ?? 'AFTER_WORK' } })
        return
      case 'captureCancel':
        if (shown.kind === 'symptom' || shown.kind === 'request' || shown.kind === 'handBack') setStep({ ...shown, capture: null })
        return
      case 'taken':
        return void tookMedia(action.kind, action.blob)
      case 'removeMedia':
        if (shown.kind === 'symptom') setStep({ ...shown, draft: { ...shown.draft, media: shown.draft.media.filter((entry) => entry.id !== action.id) } })
        return
      case 'retryUpload':
        return setUpload(action.id, 'waiting')
      case 'request':
        return void openRequest(action.id, shown.kind === 'jobs' ? 'jobs' : 'which')
      case 'follow':
        if (shown.kind === 'sent' && shown.requestId) void openRequest(shown.requestId, from.current)
        return
      case 'works':
        return void progress('WORKS_AGAIN')
      case 'acknowledge':
        return void progress('ACKNOWLEDGE')
      case 'onTheWay':
        return void progress('ON_THE_WAY')
      case 'leadConfirm':
        return void leadConfirm()
      case 'open':
        return void open(action.file)
      case 'peekClose':
        return closePeek()
      case 'incident': {
        // B-W2b-137: the machine goes with it (Where? offers it first), a hazard as the likely kind; the person may pick another.
        const machine = shown.kind === 'symptom' ? { id: shown.machine.id, assetNumber: shown.machine.assetNumber } : shown.kind === 'sent' && sent.current ? { id: sent.current.machineId, assetNumber: shown.machine.assetNumber } : null
        offerIncident({ machine, kind: 'HAZARD' })
        router.push(INCIDENT_PAGE)
        return
      }
      case 'closeAction':
        if (shown.kind === 'handBack') setStep({ ...shown, draft: { ...shown.draft, action: action.code as typeof shown.draft.action } })
        return
      case 'closeFailure':
        if (shown.kind === 'handBack') setStep({ ...shown, draft: { ...shown.draft, failure: action.code } })
        return
      case 'showRequests':
        return showStation()
      case 'showQueue':
        return showQueue()
    }
  }

  useFloorKeys({ escape: back })

  if (!me) return null
  // The lists drawn are what was on screen until Show (B-W2b-28).
  const shownStep: MachineStep =
    step.kind === 'which' ? { ...step, requests: stationLive.rows, requestsPending: stationLive.pending } : step.kind === 'jobs' ? { ...step, queue: can.work ? queueLive.rows : null, queuePending: queueLive.pending } : step
  return <MachineView model={{ frame, can, online, step: shownStep }} onAction={onAction} onFrame={onFrame} camera={zxingCamera} />
}
