import type { ApiClient } from '../../../lib/api/client'
import { fetchInstruction, fetchNewerSpec, fetchSpec, type NewerSpec } from '../instructions/api'
import { forPerson, keepInstruction, keepMediaOf, keepNewer, keepSpec, keptInstruction, keptNewer, keptSpec, markOpenedBeforeStart, offerInstructions, openedBeforeStart, seenHere } from '../instructions/memory'
import { flagOf, opensBeforeStart, type InstructionFlag } from '../instructions/model'

/**
 * The operation screen's part of Spec & instructions (SCR-090 W2b markers floor.operation/page.h#3 "Instructions (W2b)" and
 * page.live#2 "New instruction version → banner, opens before Start"; B-W2b-232, follow-up FI9:01; PRD-195 "on the operation
 * card"). Right after the scan, beside the timing, the checks and the steps, the screen reads the instruction in force for the
 * bundle at its operation (B-W2b-214 `…/floor/operation`: `acknowledgement.due`) and whether a newer spec exists for its work
 * order (B-W2b-220 `…/spec/newer`). Both are kept for the visit with the instruction's photos and videos and the frozen spec (instructions/memory),
 * so Spec & instructions opens for the bundle in hand with the network gone. There is no live "New" badge (an instruction has
 * no site, B-W2b-214's gap): the version in force is read when the operation opens.
 */

export interface InstructionParts {
  /** The instruction in force (null: none for this operation; absent: not read, offline and not kept). */
  readonly instruction?: InstructionFlag | null
  /** The work order's newer-spec read (PRD-195); null when not read. */
  readonly newerSpec?: NewerSpec | null
  /** A read answered 401: the session ended. */
  readonly signedOut?: boolean
}

/** Reads both while online (a read that fails leaves its part unknown), else what the tablet kept. */
export async function readInstructionParts(api: ApiClient, input: { readonly code: string; readonly workOrderId: string; readonly operationId: string; readonly online: boolean; readonly workerId: string | null }): Promise<InstructionParts> {
  forPerson(input.workerId)
  const seen = seenHere(input.workerId)
  if (!input.online) {
    const kept = keptInstruction(input.code, input.operationId)
    return { ...(kept ? { instruction: flagOf(kept.value, seen) } : {}), newerSpec: keptNewer(input.workOrderId)?.value ?? null }
  }
  const [instruction, newer] = await Promise.all([fetchInstruction(api, input.code, input.operationId), fetchNewerSpec(api, input.workOrderId)])
  const signedOut = [instruction, newer].some((answer) => !answer.ok && answer.problem.kind === 'signedOut')
  if (instruction.ok) {
    keepInstruction(input.code, input.operationId, instruction.value)
    // Its photos and videos follow in the background, one at a time: the bundle in hand opens offline with its pictures.
    void keepMediaOf(api, instruction.value)
  }
  if (newer.ok) keepNewer(input.workOrderId, newer.value)
  // The frozen spec for the bundle's size too, once and in the background (it never changes): Spec & instructions shows it offline.
  if (!keptSpec(input.code)) void fetchSpec(api, input.code).then((answer) => (answer.ok ? keepSpec(input.code, answer.value) : undefined))
  const kept = instruction.ok ? null : keptInstruction(input.code, input.operationId)
  const flag = instruction.ok ? flagOf(instruction.value, seen) : kept ? flagOf(kept.value, seen) : undefined
  return { ...(flag !== undefined ? { instruction: flag } : {}), newerSpec: newer.ok ? newer.value : (keptNewer(input.workOrderId)?.value ?? null), ...(signedOut ? { signedOut } : {}) }
}

/** The flag as the card shows it now: a version Seen on this tablet since the read is no longer new. */
export function shownFlag(flag: InstructionFlag | null | undefined, workerId: string | null): InstructionFlag | null {
  if (!flag) return null
  return flag.due && seenHere(workerId)(flag.versionId) ? { ...flag, due: null } : flag
}

/** Start opens the instruction first (MES-110): a version whose Seen waits, once per visit for this person. */
export function startOpensInstruction(flag: InstructionFlag | null | undefined, workerId: string | null): boolean {
  return opensBeforeStart(shownFlag(flag, workerId), openedBeforeStart(workerId))
}

/** Hands the bundle in hand to Spec & instructions (the caller moves there): from the card, or before Start. */
export function handInstructions(input: { readonly code: string; readonly operationId: string; readonly from: 'operation' | 'start'; readonly workerId: string | null; readonly flag?: InstructionFlag | null }): void {
  if (input.from === 'start' && input.workerId && input.flag) markOpenedBeforeStart(input.workerId, input.flag.versionId)
  offerInstructions({ code: input.code, operationId: input.operationId, from: input.from })
}
