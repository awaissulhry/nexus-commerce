import { depthRefusal, type DepthRefusal } from './refusals'

/**
 * What the person who reported a machine problem sees, and confirms (B-W2b-96; QHS-180; design floor.machine "Progress":
 * "Acknowledged → on the way → fixed; the requester confirms 'It works'", plant.jobs "Line lead confirms"). Pure.
 *
 *   acknowledged   maintenance saw it: the office's triage, or a technician on the floor (NEW → ACKNOWLEDGED)
 *   on the way     a technician is going to the machine (once; while ACKNOWLEDGED or JOB_MADE; from NEW it acknowledges in
 *                  the same step)
 *   fixed          its job was handed back (the job's handedBackAt; no column of the request). A request merged into
 *                  another follows that one: its job, or its own close (solved without a job) or its own confirmation
 *   works          the reporter confirms the machine works again (once): on JOB_MADE once the job is handed back or closed,
 *                  or on MERGED once the request it joined is fixed; never while the request still locks its machine (H1)
 *
 * The station keeps every reporter informed: a merged request keeps its own reporter, who sees the progress of the request
 * it joined and confirms on their own.
 */

export const PROGRESS_STEPS = ['REPORTED', 'ACKNOWLEDGED', 'ON_THE_WAY', 'FIXED', 'WORKS'] as const
export type ProgressStep = (typeof PROGRESS_STEPS)[number]

/** The entries of a request's trail (design plant.requests "Routing and escalation trail (Timeline)"). */
export const TRAIL_KINDS = ['REPORTED', 'ROUTED', 'ESCALATED', 'ACKNOWLEDGED', 'ON_THE_WAY', 'MERGED', 'CLOSED', 'SIGNED_SAFE', 'FIXED', 'WORKS_AGAIN'] as const
export type TrailKind = (typeof TRAIL_KINDS)[number]

export interface JobProgressFacts {
  readonly status: string
  readonly handedBackAt: Date | null
}

export interface RequestProgressFacts {
  readonly status: string
  readonly acknowledgedAt: Date | null
  readonly onTheWayAt: Date | null
  readonly confirmedWorksAt: Date | null
  readonly closedAt: Date | null
  readonly job: JobProgressFacts | null
}

export interface ProgressFacts extends RequestProgressFacts {
  readonly unsafe: boolean
  readonly signedSafeAt: Date | null
  /** The request it was merged into (MERGED only), with its job. */
  readonly target: RequestProgressFacts | null
}

export interface Progress {
  readonly step: ProgressStep
  readonly acknowledgedAt: Date | null
  readonly onTheWayAt: Date | null
  readonly fixedAt: Date | null
  readonly worksAt: Date | null
  /** Closed without a job (solved by the operator, not a fault, a duplicate, other): nothing to confirm. */
  readonly closedWithoutJob: boolean
  /** The reporter may confirm the machine works now. */
  readonly canConfirm: boolean
  /** The request still locks its machine: nobody confirms before a technician signs it safe. */
  readonly locking: boolean
}

const handedBack = (job: JobProgressFacts | null): Date | null => (job && (job.status === 'HANDED_BACK' || job.status === 'CLOSED') ? job.handedBackAt : null)

/** When a request counts as fixed: its job handed back; a CLOSED one when closed (solved without a job). */
function fixedAtOf(request: RequestProgressFacts): Date | null {
  if (request.status === 'JOB_MADE') return handedBack(request.job)
  if (request.status === 'CLOSED') return request.closedAt
  return null
}

/** The progress of a request as its reporter sees it. */
export function progressOf(facts: ProgressFacts): Progress {
  const locking = facts.unsafe && facts.signedSafeAt === null
  const followed = facts.status === 'MERGED' ? facts.target : null
  const acknowledgedAt = facts.acknowledgedAt ?? followed?.acknowledgedAt ?? null
  const onTheWayAt = facts.onTheWayAt ?? followed?.onTheWayAt ?? null
  const fixedAt = facts.status === 'MERGED' ? (followed ? (fixedAtOf(followed) ?? followed.confirmedWorksAt) : null) : fixedAtOf(facts)
  const closedWithoutJob = facts.status === 'CLOSED'
  const worksAt = facts.confirmedWorksAt
  const step: ProgressStep = worksAt ? 'WORKS' : fixedAt ? 'FIXED' : onTheWayAt ? 'ON_THE_WAY' : acknowledgedAt ? 'ACKNOWLEDGED' : 'REPORTED'
  const canConfirm = worksAt === null && !locking && !closedWithoutJob && fixedAt !== null && (facts.status === 'JOB_MADE' || facts.status === 'MERGED')
  return { step, acknowledgedAt, onTheWayAt, fixedAt, worksAt, closedWithoutJob, canConfirm, locking }
}

/** Why a technician on the floor may not acknowledge the request now, or null. */
export function floorAcknowledgeRefusal(request: { readonly status: string; readonly acknowledgedAt: Date | null }): DepthRefusal | null {
  if (request.status !== 'NEW' || request.acknowledgedAt !== null) {
    return depthRefusal('ALREADY_ACKNOWLEDGED', request.status === 'NEW' || request.status === 'ACKNOWLEDGED' ? 'Maintenance acknowledged this request already.' : 'This request is triaged already.', 'Read it again; say you are on the way when you go to the machine.')
  }
  return null
}

/** Why a technician may not say they are on the way now, or null. */
export function onTheWayRefusal(request: { readonly status: string; readonly onTheWayAt: Date | null }): DepthRefusal | null {
  if (request.onTheWayAt !== null) return depthRefusal('ON_THE_WAY_ALREADY', 'A technician is on the way to this machine already.', 'Read it again.')
  if (!['NEW', 'ACKNOWLEDGED', 'JOB_MADE'].includes(request.status)) {
    return depthRefusal('NOT_ON_THE_WAY_NOW', `This request is ${request.status === 'MERGED' ? 'merged into another' : 'closed'}: nobody goes to it now.`, request.status === 'MERGED' ? 'Go to the request it was merged into.' : 'Read it again.')
  }
  return null
}

/** Why the reporter may not confirm the machine works now, or null. */
export function worksAgainRefusal(progress: Progress, assetNumber: string): DepthRefusal | null {
  if (progress.worksAt !== null) return depthRefusal('WORKS_CONFIRMED', 'It was confirmed already that the machine works again.', 'Read it again.')
  if (progress.closedWithoutJob) return depthRefusal('CLOSED_WITHOUT_JOB', 'This request was closed without a job: there is nothing to confirm.', 'Report a new problem if the machine still does not work.')
  if (progress.locking) {
    return depthRefusal('NOT_FIXED_YET', `Machine ${assetNumber} was marked unsafe and no technician has signed it safe yet: nobody confirms it works before that.`, 'A technician checks the machine and signs it safe first (Owner answer H1; D.Lgs. 81/2008 art. 71).')
  }
  if (progress.fixedAt === null) return depthRefusal('NOT_FIXED_YET', `Machine ${assetNumber} is not handed back yet: its repair is still under way.`, 'Confirm once the technician has handed the machine back.')
  return null
}
