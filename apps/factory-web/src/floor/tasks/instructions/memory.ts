import type { ApiClient } from '../../../lib/api/client'
import { AsOfMemory, codeKey, type Remembered } from '../shared/as-of'
import { readMedium, type FloorInstruction, type FloorSpec, type MineAnswer, type NewerSpec } from './api'
import { seenKey } from './model'

/**
 * What the tablet keeps of the instructions for this visit (design sec:open "offline: Instructions of the station's operations
 * are cached with their media", PLT-238; the plan's "the instruction of the queued bundle is cached; Seen is queued"). Memory
 * only, as the operation screen's cards (shared/as-of): nothing is written to storage, a reload offline starts empty and the
 * page says "not on this tablet". The Operation screen reads the instruction of every bundle it opens and keeps it here with
 * its photos and videos (as blobs), so the bundle in hand opens on this page with the network gone.
 *
 * What speaks of a person (the Seen due, the person's own list) leaves with them: `forPerson` forgets it when another person is
 * on the tablet. The versions Seen on this tablet (sent, or waiting in the queue) are kept per person and version.
 */

const INSTRUCTIONS = new AsOfMemory<FloorInstruction>(120)
const SPECS = new AsOfMemory<FloorSpec>(120)
const NEWER = new AsOfMemory<NewerSpec>(120)
const MINE = new AsOfMemory<MineAnswer>(1)
const SEEN_HERE = new Set<string>()
const OPENED_BEFORE_START = new Set<string>()
let PERSON: string | null = null

/** Another person on the tablet: what spoke of the last one is forgotten (the Seen due, their list). */
export function forPerson(workerId: string | null): void {
  if (workerId === PERSON) return
  INSTRUCTIONS.clear()
  MINE.clear()
  PERSON = workerId
}

const instructionKey = (code: string, operationId: string | null) => `${codeKey(code)}:${operationId ?? ''}`

export function keepInstruction(code: string, operationId: string | null, answer: FloorInstruction): void {
  INSTRUCTIONS.keep(instructionKey(code, operationId), answer)
  // The same answer under the bundle's own code and the operation it names, so either way of asking finds it.
  INSTRUCTIONS.keep(instructionKey(answer.bundle.code, answer.operation.id), answer)
  if (operationId === null) INSTRUCTIONS.keep(instructionKey(answer.bundle.code, null), answer)
}

export function keptInstruction(code: string, operationId: string | null): Remembered<FloorInstruction> | null {
  return INSTRUCTIONS.get(instructionKey(code, operationId))
}

export function keepSpec(code: string, spec: FloorSpec): void {
  SPECS.keep(codeKey(code), spec)
  SPECS.keep(codeKey(spec.bundle.code), spec)
}

export const keptSpec = (code: string): Remembered<FloorSpec> | null => SPECS.get(codeKey(code))

export const keepNewer = (workOrderId: string, spec: NewerSpec): void => NEWER.keep(workOrderId, spec)
export const keptNewer = (workOrderId: string): Remembered<NewerSpec> | null => NEWER.get(workOrderId)

export const keepMine = (workerId: string, mine: MineAnswer): void => MINE.keep(workerId, mine)
export const keptMine = (workerId: string): Remembered<MineAnswer> | null => MINE.get(workerId)

/** Seen on this tablet: sent, or waiting in the queue (the next read's stale "due" never reopens it). */
export function markSeen(workerId: string, versionId: string): void {
  SEEN_HERE.add(seenKey(workerId, versionId))
}

export const seenHere = (workerId: string | null) => (versionId: string): boolean => workerId !== null && SEEN_HERE.has(seenKey(workerId, versionId))

/** Opened before this person's Start once this visit (MES-110): the next Start goes. */
export function markOpenedBeforeStart(workerId: string, versionId: string): void {
  OPENED_BEFORE_START.add(seenKey(workerId, versionId))
}

export const openedBeforeStart = (workerId: string | null) => (versionId: string): boolean => workerId !== null && OPENED_BEFORE_START.has(seenKey(workerId, versionId))

// ---- photos and videos -------------------------------------------------------------------------------------------------------

const MEDIA = new Map<string, string>()
const FAILED = new Set<string>()
const LOADING = new Map<string, Promise<string | null>>()
const MEDIA_MAX = 120

/** A medium's blob address on this tablet; null: not read yet. */
export const keptMedium = (mediaId: string): string | null => MEDIA.get(mediaId) ?? null
export const mediumFailed = (mediaId: string): boolean => FAILED.has(mediaId)

/** Reads a medium once (through the floor's own route) and keeps its blob for the visit; the oldest goes past the cap. */
export function loadMedium(api: ApiClient, mediaId: string): Promise<string | null> {
  const kept = MEDIA.get(mediaId)
  if (kept) return Promise.resolve(kept)
  const running = LOADING.get(mediaId)
  if (running) return running
  const work = readMedium(api, mediaId)
    .then((answer) => {
      if (!answer.ok) {
        if (answer.problem.kind !== 'offline') FAILED.add(mediaId)
        return null
      }
      FAILED.delete(mediaId)
      const url = URL.createObjectURL(answer.value)
      MEDIA.set(mediaId, url)
      while (MEDIA.size > MEDIA_MAX) {
        const oldest = MEDIA.keys().next().value
        if (oldest === undefined) break
        const gone = MEDIA.get(oldest)
        MEDIA.delete(oldest)
        if (gone) URL.revokeObjectURL(gone)
      }
      return url
    })
    .finally(() => LOADING.delete(mediaId))
  LOADING.set(mediaId, work)
  return work
}

/** Every photo and video of the version in force, one after the other (light on the network), kept for an offline look. */
export async function keepMediaOf(api: ApiClient, answer: FloorInstruction): Promise<void> {
  for (const step of answer.instruction?.steps ?? []) for (const medium of step.media) if (!MEDIA.has(medium.id) && !FAILED.has(medium.id)) await loadMedium(api, medium.id)
}

// ---- the page's hand-over (never in the address: a floor page with search terms is another page to Next's cache) ----------

export interface InstructionsOffer {
  /** The bundle in hand (its ticket's code); null: the page asks for a scan. */
  readonly code: string | null
  /** The work order's operation it is at (Operation knows it); null: the station's. */
  readonly operationId: string | null
  /** Who opened it: the operation card, the Start that waits for it (MES-110), My work's "New instructions", or the tile. */
  readonly from: 'operation' | 'start' | 'mywork' | null
}

let OFFER: InstructionsOffer | null = null

export function offerInstructions(offer: InstructionsOffer): void {
  OFFER = offer
}

export function takeInstructionsOffer(): InstructionsOffer | null {
  const taken = OFFER
  OFFER = null
  return taken
}
