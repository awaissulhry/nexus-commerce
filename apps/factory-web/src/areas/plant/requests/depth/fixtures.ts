import type { MachineCard, MaintenanceJob, MaintenanceRequest } from '../../_shared/api'
import { at, JOBS, MACHINES, PEOPLE, REQUESTS, uid } from '../../_shared/fixtures'
import type { DeepJob, DeepRequest, DeepRequestRecord, Media, TrailEntry } from './api'
import type { MediaView } from './model'

/**
 * Made-up data for the depth parts of Machine requests and Maintenance jobs (B-W2b-140): W2a's made-up requests and jobs
 * (`_shared/fixtures.ts`) with routing, escalation, progress, photos and voice notes, the hand-back's failure code and
 * the line lead's confirmation. Teams and people are invented ("Squadra Demo A", "Anna Esempio"). Design-only (only
 * fixtures and tests import it); it exports no `designScreen`.
 */

export const TEAM_A = { kind: 'TEAM' as const, id: uid('7171', 1), name: 'Squadra Demo A' }

/** A request with the depth fields: routed to the demo team, its progress read from its state. */
export function deep(request: MaintenanceRequest, over: Partial<DeepRequest> = {}): DeepRequest {
  const fixed = request.job?.status === 'HANDED_BACK' || request.job?.status === 'CLOSED'
  return {
    ...request,
    voiceNotes: 0,
    progress: {
      step: fixed ? 'FIXED' : request.acknowledgedAt || request.job ? 'ACKNOWLEDGED' : 'REPORTED',
      acknowledgedAt: request.acknowledgedAt ?? (request.job ? request.reportedAt : null),
      onTheWayAt: null,
      onTheWayBy: null,
      fixedAt: fixed ? at(30, 11) : null,
      worksAt: null,
      worksBy: null,
      closedWithoutJob: request.status === 'CLOSED',
      canConfirm: fixed && !request.locking,
    },
    routing: { routedTo: TEAM_A, ruleId: uid('7272', 1), escalationLevel: 0, escalatedAt: null },
    ...over,
  }
}

export const DEEP = {
  unsafe: deep(REQUESTS.unsafe, { voiceNotes: 1, progress: { step: 'ON_THE_WAY', acknowledgedAt: at(30, 9, 14), onTheWayAt: at(30, 9, 20), onTheWayBy: PEOPLE.lucaUnnamed, fixedAt: null, worksAt: null, worksBy: null, closedWithoutJob: false, canConfirm: false } }),
  thread: deep(REQUESTS.thread, { routing: { routedTo: TEAM_A, ruleId: uid('7272', 1), escalationLevel: 2, escalatedAt: at(30, 9, 20) } }),
  threadAgain: deep(REQUESTS.threadAgain, { routing: { routedTo: { kind: 'TECHNICIAN', id: PEOPLE.anna.id, name: PEOPLE.anna.name }, ruleId: uid('7272', 2), escalationLevel: 0, escalatedAt: null } }),
  noise: deep(REQUESTS.noise),
  oil: deep(REQUESTS.oil, { voiceNotes: 2, routing: { routedTo: TEAM_A, ruleId: uid('7272', 1), escalationLevel: 1, escalatedAt: at(29, 15, 15) } }),
  closed: deep(REQUESTS.closed, { routing: { routedTo: null, ruleId: null, escalationLevel: 0, escalatedAt: null } }),
}

export const DEEP_QUEUE: DeepRequest[] = [DEEP.unsafe, DEEP.oil, DEEP.thread, DEEP.threadAgain, DEEP.noise]

/** A second machine locked as unsafe, for the banners (the clicking press: its two-hand control fails). */
export const PRESS_LOCK = deep({ ...REQUESTS.oil, id: uid('5151', 21), machine: { id: MACHINES.press.id, assetNumber: MACHINES.press.assetNumber, status: 'DO_NOT_USE', class: MACHINES.press.class }, symptom: null, description: 'Il comando a due mani non ferma la lama.', unsafe: true, locking: true, reportedAt: at(30, 8, 5), ageMinutes: 97, reportedBy: PEOPLE.cut1, status: 'ACKNOWLEDGED', acknowledgedAt: at(30, 8, 10), acknowledgedBy: PEOPLE.me })

export const media = (n: number, kind: Media['kind'], category: Media['category'] = null, minute = 15): Media => ({
  id: uid('7777', n),
  kind,
  category,
  originalName: kind === 'AUDIO' ? `nota-${n}.webm` : `foto-${n}.jpg`,
  contentType: kind === 'AUDIO' ? 'audio/webm' : 'image/jpeg',
  sizeBytes: kind === 'AUDIO' ? 48_000 : 210_000,
  availableAt: at(30, 9, minute),
})

/** A made-up photo (an inline drawing standing in for a file of the files API). */
export const PHOTO = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#8a8f98"/><rect x="60" y="70" width="200" height="100" rx="12" fill="#c4c8ce"/><text x="160" y="128" font-size="20" text-anchor="middle" fill="#1f2328">foto</text></svg>')}`

/** A made-up voice note (a silent WAV header, standing in for a file of the files API). */
export const VOICE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='

/** The views of files as the page shows them once their addresses are read. */
export const viewsOf = (files: readonly (Media & { requestId?: string })[], read = true): MediaView[] =>
  files.map((file) => ({ id: file.id, kind: file.kind, category: file.category, name: file.originalName, availableAt: file.availableAt, requestId: file.requestId ?? null, src: read ? (file.kind === 'AUDIO' ? VOICE : PHOTO) : null }))

export const trail = (...entries: [TrailEntry['kind'], string, number?][]): TrailEntry[] => entries.map(([kind, when, level]) => ({ kind, at: when, level: level ?? null }))

/** A request's record as GET /plant/requests/:id answers it (the machine's card, its other open requests, the rights). */
export function deepRecord(record: { card: MachineCard; duplicates: MaintenanceRequest[]; canTriage: boolean; canSignSafe: boolean }, request: DeepRequest, over: Partial<DeepRequestRecord> = {}): DeepRequestRecord {
  return {
    request,
    card: record.card,
    duplicates: record.duplicates.map((other) => Object.values(DEEP).find((entry) => entry.id === other.id) ?? deep(other)),
    files: [],
    trail: trail(['REPORTED', request.reportedAt], ['ROUTED', request.reportedAt]),
    canGo: true,
    canConfirm: false,
    canLock: !record.card.machine.locked,
    canTriage: record.canTriage,
    canSignSafe: record.canSignSafe,
    ...over,
  }
}

/** A W2a job with the depth fields (no failure code, nobody confirmed yet). */
export function deepJob(job: MaintenanceJob, over: Partial<DeepJob> = {}): DeepJob {
  return { ...job, handedBack: job.handedBack ? { ...job.handedBack, failureCode: null, minutesSpent: null } : null, leadConfirmed: null, ...over }
}

export const DEEP_JOBS = {
  safety: deepJob(JOBS.safety),
  thread: deepJob(JOBS.thread),
  planned: deepJob(JOBS.planned),
  fresh: deepJob(JOBS.fresh),
  handedBack: deepJob(JOBS.handedBack, { handedBack: { ...JOBS.handedBack.handedBack!, failureCode: 'SETTINGS', minutesSpent: 180 } }),
  closed: deepJob(JOBS.closed),
}
