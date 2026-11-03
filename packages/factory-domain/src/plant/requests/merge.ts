import { depthRefusal, type DepthRefusal } from './refusals'

/**
 * Possible duplicates and merging them into one (B-W2b-96; QHS-181; design plant.requests "Possible duplicates": "'3
 * requests on Lockstitch L2-07 in 20 min'", "'Merge into one' keeps every reporter informed", pop-up "Merge requests":
 * "Target: suggested open job or request on the same machine; all reporters are kept and informed"). Pure.
 *
 *   group      the open requests (NEW, ACKNOWLEDGED) of one machine when there are two or more, oldest first
 *   suggested  the machine's open job when it has one (the requests join it), else the request that locks the machine
 *              (an unsafe one not yet signed safe is never merged away), else the oldest
 *   merge      ONE command, all or none: into a request (each becomes MERGED into it), or into an open job of the machine
 *              (each becomes JOB_MADE with it). A request that still locks its machine joins a job but is never merged into
 *              another request (H1).
 * Each merged request keeps its reporter, who follows the target's progress and confirms on their own (progress.ts).
 */

export interface GroupRequest {
  readonly id: string
  readonly machineId: string
  readonly reportedAt: Date
  readonly locking: boolean
}

export interface DuplicateGroup {
  readonly machineId: string
  /** Oldest first. */
  readonly requestIds: readonly string[]
  readonly firstAt: Date
  readonly lastAt: Date
  /** Minutes between the first and the last report. */
  readonly withinMinutes: number
  readonly suggested: { readonly kind: 'JOB'; readonly jobId: string } | { readonly kind: 'REQUEST'; readonly requestId: string }
}

const byTime = (a: GroupRequest, b: GroupRequest) => a.reportedAt.getTime() - b.reportedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The machines with two or more open requests, each with its suggestion; the groups with the newest report first. */
export function duplicateGroups(open: readonly GroupRequest[], openJobOf: ReadonlyMap<string, string>): DuplicateGroup[] {
  const byMachine = new Map<string, GroupRequest[]>()
  for (const request of open) byMachine.set(request.machineId, [...(byMachine.get(request.machineId) ?? []), request])
  const groups: DuplicateGroup[] = []
  for (const [machineId, requests] of byMachine) {
    if (requests.length < 2) continue
    const sorted = [...requests].sort(byTime)
    const first = sorted[0]!
    const last = sorted.at(-1)!
    const jobId = openJobOf.get(machineId)
    const target = sorted.find((request) => request.locking) ?? first
    groups.push({
      machineId,
      requestIds: sorted.map((request) => request.id),
      firstAt: first.reportedAt,
      lastAt: last.reportedAt,
      withinMinutes: Math.max(0, Math.round((last.reportedAt.getTime() - first.reportedAt.getTime()) / 60_000)),
      suggested: jobId ? { kind: 'JOB', jobId } : { kind: 'REQUEST', requestId: target.id },
    })
  }
  return groups.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime())
}

/** The group in words (design: "3 requests on Lockstitch L2-07 in 20 min"), in English. */
export const groupWords = (count: number, machine: string, minutes: number): string => `${count} requests on ${machine} in ${minutes} min`

/** Why a bulk merge is refused as a whole before reading the requests, or null. */
export function mergeNothing(sources: number): DepthRefusal | null {
  return sources === 0 ? depthRefusal('MERGE_NOTHING', 'Name the requests to merge.', 'Pick the duplicates of the same machine, then merge them into one.') : null
}
