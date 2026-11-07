'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { ANONYMOUS_KINDS, type IncidentKind } from '@nexus/factory-domain/safety/incidents/rules'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readHelpStation, type HelpStation } from '../help/api'
import { CALL_SEND, callWords, queuedCalls, sendPayload } from '../help/model'
import { TASK_ROUTES } from '../routes'
import { AsOfMemory } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import type { TaskProblem } from '../shared/task-api'
import { readReport, readStart, sendWithoutName, uploadPhoto, type IncidentStart } from './api'
import { takeIncidentOffer, type IncidentOffer } from './handoff'
import {
  EMERGENCY,
  EMPTY_DRAFT,
  helpCallOf,
  helpPress,
  isKnownRefusal,
  kindPicked,
  nextUpload,
  offeredWhere,
  outsideHeld,
  personHeld,
  photoHeld,
  photoName,
  QUEUED_KIND,
  queuedPayload,
  reportBody,
  sendHeld,
  sendsWithoutName,
  whereId,
  whereTiles,
  workerHeld,
  type IncidentDraft,
  type PhotoUpload,
  type ReportBody,
  type Stage,
  type UploadState,
} from './model'
import type { HelpButton } from './view/IncidentParts'
import { IncidentView, type IncidentAction, type IncidentStep, type SentReport } from './view/IncidentView'

/**
 * The live SCR-230 (`/floor/incident`; B-W2b-137 on the merged API of B-W2b-125). The report opens at once, network or not:
 * 112 is factory-domain's and "here" is this tablet's own station, so someone hurt never waits for a read. The start
 * (`GET /safety/floor/incidents/start`: the first aiders, this station's machines, the site's areas) and the station's call
 * types (`GET /production/calls/station`) only add to it, kept for the visit with their time for an offline open.
 *
 *   with the name     saved in the tablet's queue first (`safety.incident.report`, B-W0-30), sent at once when the network is
 *                     there: the two ticks, then the office's receipt names the incident. Not an online try first: the API
 *                     hashes the report's time into the request, so a try and a queued retry of one id would be refused as a
 *                     reused id after a lost answer (named in the notes); the queue sends ONE body under ONE id.
 *   without the name  a near miss or a hazard naming nobody, ONLINE only (the queue's ledger names the tablet): one key kept
 *                     until answered, the same body resent; with the network gone it waits in this page (never stored), goes
 *                     by itself when the network is back, or goes with the name instead (saved on the tablet)
 *   after             its number and "Seen by safety at …" (live `incident.seen`, the reconnect and a beat while in view: a
 *                     missed hint), the photos up one at a time (≤ 4, within 30 minutes)
 *   the call for help one tap queues the station's Safety call (else its team leader's) as `andon.call.send` (it works offline;
 *                     a second tap shows the call, never a second one), or opens Call for help
 */

const STARTS = new AsOfMemory<IncidentStart>(1)
const HELP = new AsOfMemory<HelpStation>(1)
const BEAT_MS = 30_000
const RETRY_MS = 15_000

type Open = 'photo' | 'worker' | 'outside' | null

type Current =
  | { readonly kind: 'report'; readonly stage: Stage; readonly draft: IncidentDraft; readonly open: Open; readonly outsideName: string; readonly busy: boolean; readonly problem: TaskProblem | null }
  | { readonly kind: 'held'; readonly draft: IncidentDraft; readonly why: 'offline' | 'unavailable'; readonly busy: boolean; readonly problem: TaskProblem | null }
  | { readonly kind: 'sent'; readonly report: Omit<SentReport, 'photoHeld'>; readonly capture: boolean }

/** The photos taken with the report, waiting for the office to name it (then named by its number). */
const uploadsOf = (draft: IncidentDraft, number: string | null): PhotoUpload[] => draft.photos.map((photo, index) => ({ id: photo.id, name: photoName(number, index + 1), state: 'waiting' as const }))

const startReport = (offer: IncidentOffer | null): Current => ({
  kind: 'report',
  stage: 'what',
  draft: offer?.kind ? { ...EMPTY_DRAFT, kind: offer.kind } : EMPTY_DRAFT,
  open: null,
  outsideName: '',
  busy: false,
  problem: null,
})

export function FloorIncident() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.incident', { showHome: true })
  const { api, me, online, sessionEnded, queue, queueSnapshot, locale } = store
  const offer = useRef<IncidentOffer | null | undefined>(undefined)
  if (offer.current === undefined) offer.current = takeIncidentOffer()
  const [current, setCurrent] = useState<Current>(() => startReport(offer.current ?? null))
  const latest = useRef(current)
  latest.current = current
  const [start, setStart] = useState<{ value: IncidentStart; asOf: string | null } | null>(() => {
    const kept = STARTS.get('start')
    return kept ? { value: kept.value, asOf: kept.asOf } : null
  })
  const [help, setHelp] = useState<HelpStation | null>(() => HELP.get('station')?.value ?? null)
  /** The call for help this screen saved on the tablet (its two ticks). */
  const [helpSent, setHelpSent] = useState<{ clientEventId: string; typeId: string } | null>(null)
  /** The call whose recording made the station be read again (once per call). */
  const helpFollowed = useRef<string | null>(null)
  /** The report saved in the queue (with the name): its client id; the office's receipt names the incident. */
  const sent = useRef<{ clientEventId: string | null; incidentId: string | null; since: string | null; read: boolean } | null>(null)
  /** The photos taken, by id, until each is up (this page's memory only). */
  const photos = useRef(new Map<string, Blob>())
  /** The report without a name waiting for its answer: the same body and key until the office answers. */
  const unnamed = useRef<{ body: ReportBody; key: string } | null>(null)

  const ended = useCallback(
    (problem: TaskProblem): boolean => {
      if (problem.kind !== 'signedOut') return false
      void sessionEnded()
      return true
    },
    [sessionEnded],
  )

  // ---- what the tablet reads (never waited for) ----------------------------------------------------------------------------

  const readAll = useCallback(async () => {
    const [answer, calls] = await Promise.all([readStart(api), readHelpStation(api)])
    if (answer.ok) {
      STARTS.keep('start', answer.value)
      setStart({ value: answer.value, asOf: null })
    } else if (ended(answer.problem)) return
    if (calls.ok) {
      HELP.keep('station', calls.value)
      setHelp(calls.value)
    }
  }, [api, ended])

  useEffect(() => {
    if (me && online) void readAll()
  }, [me, online, readAll])

  const anonymousKinds: readonly IncidentKind[] = start?.value.anonymousKinds ?? ANONYMOUS_KINDS
  const station = me?.device.station ?? null
  const stationRef = useMemo(() => (station ? { code: station.code, name: station.name } : null), [station])
  const offered = offer.current?.machine ?? null
  const where = useMemo(() => whereTiles({ station: stationRef, machines: start?.value.here?.machines ?? [], areas: start?.value.areas ?? [], offered }), [stationRef, start, offered])
  const roster = useMemo(() => (store.device?.roster ?? []).map((person) => ({ id: person.id, name: person.displayName })), [store.device])
  const meRef = me ? { id: me.worker.id, name: me.worker.displayName } : null

  // The machine report passed its machine on: Where? offers it picked, once its tile is known.
  useEffect(() => {
    const now = latest.current
    if (now.kind !== 'report' || now.draft.where || !offered) return
    const picked = offeredWhere(where, offered.id)
    if (picked) setCurrent({ ...now, draft: { ...now.draft, where: picked } })
  }, [where, offered])

  // ---- the report with the name: its ticks, its incident, its number and "seen" ---------------------------------------------

  const readSent = useCallback(
    async (incidentId: string) => {
      const answer = await readReport(api, incidentId)
      if (!answer.ok) {
        ended(answer.problem)
        return
      }
      setCurrent((now) => (now.kind === 'sent' && sent.current?.incidentId === incidentId ? { ...now, report: { ...now.report, number: answer.value.number, seenAt: answer.value.seenAt, closed: answer.value.closed } } : now))
    },
    [api, ended],
  )

  useEffect(() => {
    const now = latest.current
    const mine = sent.current
    if (now.kind !== 'sent' || !mine?.clientEventId) return
    const view = queuedView(queueSnapshot, mine.clientEventId)
    if (!view) return
    const refusal = view.refusal ? { code: view.refusal.code, message: view.refusal.message } : null
    const result = view.ticks === 'recorded' ? view.item?.result : null
    if (result && result.type === 'Incident' && !mine.incidentId) {
      mine.incidentId = result.id
      mine.since = new Date().toISOString()
    }
    if (view.ticks !== now.report.ticks || (refusal?.code ?? null) !== (now.report.refusal?.code ?? null)) setCurrent({ ...now, report: { ...now.report, ticks: view.ticks, refusal } })
    if (mine.incidentId && online && !mine.read) {
      mine.read = true
      void readSent(mine.incidentId)
    }
  }, [queueSnapshot, online, readSent])

  useLiveChanges(
    {
      onChange: (change) => {
        const id = sent.current?.incidentId
        if (change.type === 'incident.seen' && id && (change.fields.incidentId === undefined || change.fields.incidentId === id)) void readSent(id)
        if (change.type.startsWith('help_call.')) void readAll()
      },
      onReconnect: () => {
        const id = sent.current?.incidentId
        if (id) void readSent(id)
      },
    },
    Boolean(me) && online,
  )

  // A missed hint (no dispatcher, a dropped stream): read again on a beat while the report waits to be seen.
  const waitsToBeSeen = current.kind === 'sent' && current.report.ticks === 'recorded' && !current.report.seenAt
  useEffect(() => {
    if (!me || !online || !waitsToBeSeen) return
    const beat = window.setInterval(() => {
      const id = sent.current?.incidentId
      if (id && document.visibilityState === 'visible') void readSent(id)
    }, BEAT_MS)
    return () => window.clearInterval(beat)
  }, [me, online, waitsToBeSeen, readSent])

  // ---- photos up, one at a time, once the office has the report ------------------------------------------------------------

  const setUpload = (id: string, state: UploadState, refusal: string | null = null) =>
    setCurrent((now) => (now.kind === 'sent' ? { ...now, report: { ...now.report, uploads: now.report.uploads.map((entry) => (entry.id === id ? { ...entry, state, refusal } : entry)) } } : now))

  useEffect(() => {
    if (current.kind !== 'sent' || current.report.ticks !== 'recorded' || !current.report.number || !online) return
    const incidentId = sent.current?.incidentId
    const next = nextUpload(current.report.uploads)
    const blob = next ? photos.current.get(next.id) : null
    if (!incidentId || !next || !blob) return
    setUpload(next.id, 'sending')
    // Named by the report's number once the office gave it (a photo taken before the answer waited without one).
    const name = photoName(current.report.number, current.report.uploads.indexOf(next) + 1)
    void uploadPhoto(api, incidentId, blob, name).then((answer) => {
      if (!answer.ok && ended(answer.problem)) return
      if (answer.ok) photos.current.delete(next.id)
      const refusal = !answer.ok && answer.problem.kind === 'refused' ? (isKnownRefusal(answer.problem.code) ? answer.problem.code : answer.problem.message) : null
      setUpload(next.id, answer.ok ? 'added' : 'failed', refusal)
    })
  }, [current, online, api, ended])

  // ---- the report without a name: online only, the same body and key until answered ----------------------------------------

  const sendUnnamed = useCallback(async () => {
    const waiting = unnamed.current
    const now = latest.current
    if (!waiting || (now.kind !== 'report' && now.kind !== 'held')) return
    if (now.busy) return
    const draft = now.draft
    setCurrent({ ...now, busy: true, problem: null } as Current)
    const answer = await sendWithoutName(api, waiting.body, waiting.key)
    if (!answer.ok) {
      if (ended(answer.problem)) return
      const quiet = answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable'
      if (quiet) {
        setCurrent({ kind: 'held', draft, why: answer.problem.kind === 'offline' ? 'offline' : 'unavailable', busy: false, problem: null })
        return
      }
      // A refusal is an answer: the report goes back to its last step with the reason (nothing was recorded).
      unnamed.current = null
      feedback('error')
      setCurrent({ kind: 'report', stage: 'details', draft, open: null, outsideName: '', busy: false, problem: answer.problem })
      return
    }
    unnamed.current = null
    feedback('success')
    sent.current = { clientEventId: null, incidentId: answer.value.incident.id, since: new Date().toISOString(), read: true }
    setCurrent({
      kind: 'sent',
      capture: false,
      report: { kind: draft.kind!, anonymous: true, ticks: 'recorded', refusal: null, number: answer.value.incident.number, seenAt: null, uploads: uploadsOf(draft, answer.value.incident.number), where: draft.where, place: draft.place },
    })
  }, [api, ended, feedback])

  // Back online (or on a beat while the office does not answer): the waiting report goes by itself.
  useEffect(() => {
    if (current.kind !== 'held' || !online || current.busy) return
    if (current.why === 'offline') {
      void sendUnnamed()
      return
    }
    const timer = window.setTimeout(() => void sendUnnamed(), RETRY_MS)
    return () => window.clearTimeout(timer)
  }, [current, online, sendUnnamed])

  // ---- sending -----------------------------------------------------------------------------------------------------------------

  const sendNamed = async (draft: IncidentDraft) => {
    const body = reportBody({ ...draft, withoutName: false }, locale, { anonymousKinds })
    try {
      const item = await queue.enqueue(QUEUED_KIND, queuedPayload(body))
      sent.current = { clientEventId: item.clientEventId, incidentId: null, since: null, read: false }
      feedback(draft.kind === 'INJURY' ? 'warning' : 'success')
      setCurrent({ kind: 'sent', capture: false, report: { kind: draft.kind!, anonymous: false, ticks: 'saved', refusal: null, number: null, seenAt: null, uploads: uploadsOf(draft, null), where: draft.where, place: draft.place } })
    } catch {
      feedback('error')
      setCurrent({ kind: 'report', stage: 'details', draft, open: null, outsideName: '', busy: false, problem: { kind: 'unavailable' } })
    }
  }

  const send = async () => {
    const now = latest.current
    if (now.kind !== 'report' || sendHeld(now.draft, now.busy)) return
    photos.current = new Map(now.draft.photos.map((photo) => [photo.id, photo.blob]))
    if (!sendsWithoutName(now.draft, anonymousKinds)) return sendNamed(now.draft)
    unnamed.current = { body: reportBody(now.draft, locale, { anonymousKinds, occurredAt: new Date().toISOString() }), key: newIdempotencyKey() }
    if (!online) {
      setCurrent({ kind: 'held', draft: now.draft, why: 'offline', busy: false, problem: null })
      return
    }
    await sendUnnamed()
  }

  // ---- the call for help ------------------------------------------------------------------------------------------------------

  const helpType = helpCallOf(help)
  const queuedHelp = useMemo(() => queuedCalls(queueSnapshot.items), [queueSnapshot.items])
  const helpButton = useMemo<HelpButton>(() => {
    if (!help || !helpType) return { kind: 'page' }
    const label = callWords(helpType, locale)
    const view = helpSent ? queuedView(queueSnapshot, helpSent.clientEventId) : null
    const open = help.tiles.find((tile) => tile.type.id === helpType.id)?.open ?? null
    if (open && open.open && (open.status === 'SENT' || open.status === 'SEEN' || open.status === 'ON_THE_WAY') && (!view || view.ticks === 'recorded')) return { kind: 'open', label, status: open.status }
    if (view) return { kind: 'queued', label, ticks: view.ticks, refusal: view.refusal?.message ?? null }
    const waiting = queuedHelp.find((call) => call.typeId === helpType.id)
    if (waiting) return { kind: 'queued', label, ticks: queuedView(queueSnapshot, waiting.clientEventId)?.ticks ?? 'saved', refusal: null }
    return { kind: 'send', label }
  }, [help, helpType, helpSent, queueSnapshot, queuedHelp, locale])

  // Once the office has the call, the station is read again: "Help is called · seen · on the way".
  useEffect(() => {
    if (!helpSent || !online) return
    const view = queuedView(queueSnapshot, helpSent.clientEventId)
    if (view?.ticks !== 'recorded' || helpFollowed.current === helpSent.clientEventId) return
    helpFollowed.current = helpSent.clientEventId
    void readAll()
  }, [helpSent, queueSnapshot, online, readAll])

  const callHelp = async () => {
    if (!help || !helpType) return router.push(TASK_ROUTES.help)
    const press = helpPress(help, helpType, queuedHelp)
    if (press.kind === 'open') return
    if (press.kind === 'queued') return setHelpSent({ clientEventId: press.clientEventId, typeId: helpType.id })
    try {
      const item = await queue.enqueue(CALL_SEND, sendPayload(press.type))
      feedback('success')
      setHelpSent({ clientEventId: item.clientEventId, typeId: helpType.id })
    } catch {
      feedback('error')
      router.push(TASK_ROUTES.help)
    }
  }

  // ---- what the person does ---------------------------------------------------------------------------------------------------

  const back = () => {
    const now = latest.current
    if (now.kind === 'report') {
      if (now.open) return setCurrent({ ...now, open: null, outsideName: '' })
      if (now.stage === 'details') return setCurrent({ ...now, stage: 'where', problem: null })
      if (now.stage === 'where') return setCurrent({ ...now, stage: 'what' })
      return router.push('/floor')
    }
    if (now.kind === 'held') return setCurrent({ kind: 'report', stage: 'details', draft: now.draft, open: null, outsideName: '', busy: false, problem: null })
    if (now.kind === 'sent' && now.capture) return setCurrent({ ...now, capture: false })
    router.push('/floor')
  }

  const onReport = (change: (now: Extract<Current, { kind: 'report' }>) => Current | null) => {
    const now = latest.current
    if (now.kind !== 'report') return
    const next = change(now)
    if (next) setCurrent(next)
  }

  const nextId = () => globalThis.crypto.randomUUID()

  const onAction = (action: IncidentAction) => {
    switch (action.type) {
      case 'kind':
        return onReport((now) => {
          const draft = kindPicked(now.draft, action.kind, anonymousKinds)
          return { ...now, draft, problem: null, stage: action.advance ? 'where' : now.stage }
        })
      case 'where':
        return onReport((now) => {
          const picked = where.find((tile) => whereId(tile) === action.id)
          if (!picked) return null
          return { ...now, draft: { ...now.draft, where: picked }, problem: null, stage: action.advance && picked.kind !== 'elsewhere' ? 'details' : now.stage }
        })
      case 'place':
        return onReport((now) => ({ ...now, draft: { ...now.draft, place: action.text } }))
      case 'next':
        return onReport((now) => {
          if (now.stage === 'what') return now.draft.kind ? { ...now, stage: 'where' } : null
          if (now.stage === 'where') return now.draft.where && !(now.draft.where.kind === 'elsewhere' && now.draft.place.trim() === '') ? { ...now, stage: 'details' } : null
          return null
        })
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'send':
        return void send()
      case 'withoutName':
        return onReport((now) => ({ ...now, draft: { ...now.draft, withoutName: action.on } }))
      case 'openWords':
        return onReport((now) => ({ ...now, draft: { ...now.draft, wordsOpen: true } }))
      case 'words':
        return onReport((now) => ({ ...now, draft: { ...now.draft, words: action.text } }))
      case 'capture': {
        const now = latest.current
        if (now.kind === 'report') {
          if (photoHeld({ online, count: now.draft.photos.length })) return
          return setCurrent({ ...now, open: 'photo' })
        }
        if (now.kind === 'sent') {
          if (photoHeld({ online, count: now.report.uploads.length, since: sent.current?.since ?? null })) return
          return setCurrent({ ...now, capture: true })
        }
        return
      }
      case 'taken': {
        const now = latest.current
        if (now.kind === 'report') return setCurrent({ ...now, open: null, draft: { ...now.draft, photos: [...now.draft.photos, { id: nextId(), blob: action.blob, name: photoName(null, now.draft.photos.length + 1) }] } })
        if (now.kind === 'sent') {
          const id = nextId()
          photos.current.set(id, action.blob)
          feedback('success')
          return setCurrent({ ...now, capture: false, report: { ...now.report, uploads: [...now.report.uploads, { id, name: photoName(now.report.number, now.report.uploads.length + 1), state: 'waiting' }] } })
        }
        return
      }
      case 'captureCancel': {
        const now = latest.current
        if (now.kind === 'report') return setCurrent({ ...now, open: null })
        if (now.kind === 'sent') return setCurrent({ ...now, capture: false })
        return
      }
      case 'removePhoto':
        return onReport((now) => ({ ...now, draft: { ...now.draft, photos: now.draft.photos.filter((photo) => photo.id !== action.id) } }))
      case 'retryUpload':
        return setUpload(action.id, 'waiting')
      case 'addMe':
        return onReport((now) => {
          if (!meRef || personHeld(now.draft, 'ME', { meId: meRef.id, roster: roster.length })) return null
          return { ...now, draft: { ...now.draft, people: [...now.draft.people, { id: nextId(), who: 'ME', workerId: meRef.id, name: meRef.name, involvement: 'INJURED' }] } }
        })
      case 'addWorker':
        return onReport((now) => (meRef && !personHeld(now.draft, 'WORKER', { meId: meRef.id, roster: roster.filter((person) => person.id !== meRef.id).length }) ? { ...now, open: 'worker' } : null))
      case 'addOutside':
        return onReport((now) => (meRef && !personHeld(now.draft, 'OUTSIDE', { meId: meRef.id, roster: roster.length }) ? { ...now, open: 'outside', outsideName: '' } : null))
      case 'pickWorker':
        return onReport((now) => {
          const person = roster.find((entry) => entry.id === action.workerId)
          if (!person || !meRef || workerHeld(now.draft, person.id, meRef.id)) return { ...now, open: null }
          return { ...now, open: null, draft: { ...now.draft, people: [...now.draft.people, { id: nextId(), who: 'WORKER', workerId: person.id, name: person.name, involvement: 'INJURED' }] } }
        })
      case 'outsideName':
        return onReport((now) => ({ ...now, outsideName: action.text }))
      case 'addOutsideName':
        return onReport((now) => {
          if (outsideHeld(now.outsideName)) return null
          return { ...now, open: null, outsideName: '', draft: { ...now.draft, people: [...now.draft.people, { id: nextId(), who: 'OUTSIDE', name: now.outsideName.trim(), involvement: 'INJURED' }] } }
        })
      case 'closeOpen':
        return onReport((now) => ({ ...now, open: null, outsideName: '' }))
      case 'involvement':
        return onReport((now) => ({ ...now, draft: { ...now.draft, people: now.draft.people.map((person) => (person.id === action.id ? { ...person, involvement: action.involvement } : person)) } }))
      case 'removePerson':
        return onReport((now) => ({ ...now, draft: { ...now.draft, people: now.draft.people.filter((person) => person.id !== action.id) } }))
      case 'withName': {
        const now = latest.current
        if (now.kind !== 'held' || now.busy) return
        unnamed.current = null
        return void sendNamed({ ...now.draft, withoutName: false })
      }
      case 'retry':
        return void sendUnnamed()
      case 'discard':
        unnamed.current = null
        return router.push('/floor')
      case 'another':
        sent.current = null
        unnamed.current = null
        photos.current = new Map()
        return setCurrent(startReport(null))
      case 'callHelp':
        return void callHelp()
      case 'openHelp':
        return router.push(TASK_ROUTES.help)
    }
  }

  useFloorKeys({ escape: back })

  if (!me || !meRef) return null

  const kept = start ? (start.asOf ?? null) : null
  const emergency = {
    number: start?.value.emergency.number ?? EMERGENCY,
    firstAiders: start?.value.emergency.firstAiders ?? null,
    asOf: online ? null : kept,
    help: helpButton,
  }

  let step: IncidentStep
  switch (current.kind) {
    case 'report':
      step = { ...current, where, station: stationRef, anonymousKinds, asOf: online ? null : kept, me: meRef, roster }
      break
    case 'held':
      step = current
      break
    case 'sent':
      step = { kind: 'sent', capture: current.capture, report: { ...current.report, photoHeld: photoHeld({ online, count: current.report.uploads.length, since: sent.current?.since ?? null }) } }
      break
  }

  return <IncidentView model={{ frame, online, step, emergency }} onAction={onAction} onFrame={onFrame} />
}
