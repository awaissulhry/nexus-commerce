'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import { floorStepUp, steppedUp } from '../shared/step-up'
import type { TaskProblem } from '../shared/task-api'
import { freshKey, moveJob, readJob, readJobs, readMachine, readStation, signSafe, type FloorJob, type JobRecord, type StationAnswer, type StationMachine, type TechnicianMove } from './api'
import {
  defaultSafeAfter,
  EMPTY_DRAFT,
  EMPTY_HAND_BACK,
  firstStep,
  handBackHeld,
  isUnsafe,
  labelOf,
  machineByTag,
  machineCan,
  pickedSymptom,
  reportHeld,
  reportPayload,
  signHeld,
  workDoneText,
} from './model'
import { MachineView, type JobDone, type MachineAction, type MachineStep } from './view/MachineView'

/**
 * The live SCR-179 (`/floor/machine`; B-W2a-73 on the API of B-W2a-35): a machine problem from the station and the
 * technician's job. It reads the station's machines (`GET /plant/floor/machines`, with `?code=` for a scanned tag), saves
 * the report in the tablet's queue first (kind `plant.report`: it works offline and is sent in the queue's order; the
 * office records it once), follows its two ticks, and reads the machine again once it is recorded. A technician
 * (plant.jobs.work) opens on My jobs (`GET /plant/floor/jobs`), reads a job (`GET /plant/jobs/:id`), makes the moves
 * (start, wait for parts, hand back, take back) online with one Idempotency-Key each (kept for a retry), and signs an
 * unsafe request safe with the PIN (403 stepUp → POST /floor/step-up → the same act again: Owner answer H1). What the
 * tablet read stays for this visit with its time (offline: "as of"). A code scanned on Home or on Scan anything opens
 * here with that machine.
 */

const STATIONS = new AsOfMemory<StationAnswer>(4)
const MACHINES = new AsOfMemory<StationMachine>(100)
const JOBS = new AsOfMemory<FloorJob[]>(2)
const JOB_RECORDS = new AsOfMemory<JobRecord>(50)

type Back = 'which' | 'jobs'

export function FloorMachine() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.machine', { showHome: true })
  const { api, me, online, sessionEnded, queue, queueSnapshot } = store
  const permissions = me?.permissions
  const can = useMemo(() => machineCan(permissions ?? []), [permissions])
  const [step, setStep] = useState<MachineStep>({ kind: 'loading' })
  const current = useRef(step)
  current.current = step
  /** Where Back goes from the report (a technician who came from My jobs goes back there). */
  const from = useRef<Back>('which')
  /** The report saved in the queue: its id, the machine read again once recorded. */
  const sent = useRef<{ id: string; machineId: string; read: boolean } | null>(null)
  /** A move's key, kept while its answer is lost (a resend is answered once). */
  const pending = useRef<{ what: string; key: string } | null>(null)
  const [stepUntil, setStepUntil] = useState<string | null>(null)
  const taken = useRef(false)

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

  const loadStation = useCallback(
    async (extra: Partial<Extract<MachineStep, { kind: 'which' }>> = {}) => {
      from.current = 'which'
      const known = STATIONS.get('station')
      if (!known) setStep({ kind: 'loading' })
      const answer = await readStation(api)
      if (!answer.ok) {
        if (ended(answer.problem)) return
        if (known && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) {
          return setStep({ kind: 'which', station: known.value.station, machines: known.value.machines, blocked: known.value.words.blocked, asOf: known.asOf, ...extra })
        }
        return setStep({ kind: 'problem', problem: answer.problem, back: 'which' })
      }
      STATIONS.keep('station', answer.value)
      remember(answer.value)
      setStep({ kind: 'which', station: answer.value.station, machines: answer.value.machines, blocked: answer.value.words.blocked, asOf: null, ...extra })
    },
    [api, ended],
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
        if (kept && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) return openMachine(kept.value, kept.asOf)
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

  const loadJobs = useCallback(async () => {
    from.current = 'jobs'
    const known = JOBS.get('mine')
    if (!known) setStep({ kind: 'loading' })
    const answer = await readJobs(api)
    if (!answer.ok) {
      if (ended(answer.problem)) return
      if (known && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) return setStep({ kind: 'jobs', jobs: known.value, asOf: known.asOf })
      return setStep({ kind: 'problem', problem: answer.problem, back: 'jobs' })
    }
    JOBS.keep('mine', answer.value)
    setStep({ kind: 'jobs', jobs: answer.value, asOf: null })
  }, [api, ended])

  const loadJob = useCallback(
    async (jobId: string, done: JobDone | null = null) => {
      const known = JOB_RECORDS.get(jobId)
      if (!known) setStep({ kind: 'loading' })
      const answer = await readJob(api, jobId)
      if (!answer.ok) {
        if (ended(answer.problem)) return
        if (known && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) return setStep({ kind: 'job', record: known.value, asOf: known.asOf, done })
        return setStep({ kind: 'problem', problem: answer.problem, back: 'jobs' })
      }
      JOB_RECORDS.keep(jobId, answer.value)
      setStep({ kind: 'job', record: answer.value, asOf: null, done })
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

  // ---- the sent report's two ticks; the machine read again once the office recorded it --------------------------------------

  useEffect(() => {
    const shown = current.current
    if (shown.kind !== 'sent' || !sent.current) return
    const view = queuedView(queueSnapshot, sent.current.id)
    if (!view) return
    const refusal = view.refusal ? { code: view.refusal.code, message: view.refusal.message } : null
    if (view.ticks !== shown.ticks || (refusal?.code ?? null) !== (shown.refusal?.code ?? null)) setStep({ ...shown, ticks: view.ticks, refusal })
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
      feedback(unsafe ? 'warning' : 'success')
      setStep({ kind: 'sent', machine: shown.machine, symptom: symptom ? labelOf(symptom, store.locale) : shown.draft.words.trim() || null, unsafe, down, ticks: 'saved', refusal: null, now: null })
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

  const handBack = async () => {
    const shown = current.current
    if (shown.kind !== 'handBack') return
    if (handBackHeld(shown.draft, shown.record.job.machine, online, shown.busy) || !shown.draft.after) return
    setStep({ ...shown, busy: true, problem: null })
    const job = shown.record.job
    const answer = await moveJob(api, job, 'handBack', keyFor(`handBack:${job.id}:${job.version}`), { workDone: workDoneText(shown.draft), machineAfter: shown.draft.after })
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

  const back = () => {
    const shown = current.current
    switch (shown.kind) {
      case 'symptom':
      case 'sent':
        return from.current === 'jobs' ? void loadJobs() : void loadStation()
      case 'which':
        return can.work ? void loadJobs() : router.push('/floor')
      case 'jobs':
      case 'loading':
        return router.push('/floor')
      case 'job':
        return void loadJobs()
      case 'handBack':
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
        if (shown.kind === 'job') setStep({ kind: 'handBack', record: shown.record, draft: EMPTY_HAND_BACK })
        return
      case 'done':
        if (shown.kind === 'handBack') setStep({ ...shown, draft: { ...shown.draft, done: action.code } })
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
    }
  }

  useFloorKeys({ escape: back })

  if (!me) return null
  return <MachineView model={{ frame, can, online, step }} onAction={onAction} onFrame={onFrame} camera={zxingCamera} />
}
