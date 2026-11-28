import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { kindOf, uploadTo } from '../basket/help/api'
import { onlineFirst, type KeepsActions } from '../queue/online-first'
import { floorRead, floorWrite, type TaskOutcome } from '../tasks/shared/task-api'

/**
 * owb-fl8 step 4 — the Me page's calls (server B's fl3, agreed 2026-11-28):
 *
 *   profile      GET /floor/me/profile: my team and its leader (names per the site's scanSubject), the departments I may work in,
 *                the site's floor languages (GET /floor/me stays the operator FloorApp reads: untouched)
 *   suggestion   POST /floor/suggestions { kind, words?, voiceFileId?, withName, clientEventId }: online first; a NAMED one waits on
 *                the phone when the network is gone (`floor.suggestion`), one without the name goes only online
 *   voice        POST /floor/suggestions/files (+ …/complete), AUDIO only, online
 *
 * This web's own zod: only what the page draws is required.
 */

export const PROFILE_PATH = '/floor/me/profile'

const department = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  shortName: z.string().nullable().optional(),
  nameI18n: z.record(z.string(), z.string()).nullable().optional(),
  tone: z.string(),
  icon: z.string(),
})

export const profileSchema = z.object({
  team: z.object({ id: z.string(), name: z.string() }).nullable(),
  leader: z.object({ name: z.string().nullable() }).nullable(),
  departments: z.array(department),
  /** SKILLS: the person's own; ALL: no skill set, every open department of the site. */
  departmentsFrom: z.enum(['SKILLS', 'ALL']).optional(),
  floorLocales: z.array(z.string()),
})
export type FloorProfile = z.infer<typeof profileSchema>

export const readProfile = (api: ApiClient): Promise<TaskOutcome<FloorProfile>> => floorRead(api, PROFILE_PATH, { schema: profileSchema })

const sentSchema = z.object({ suggestion: z.object({ id: z.string() }).passthrough(), replayed: z.boolean().optional() })

/** The queue kind server B adds in factory-domain floor-sync (fl3). */
export const SUGGESTION_KIND = kindOf('floor.suggestion')

/** A named suggestion: online first, else kept on the phone under the same id. */
export function sendNamedSuggestion(api: ApiClient, queue: KeepsActions, online: boolean, payload: Readonly<Record<string, unknown>>) {
  return onlineFirst(queue, { online, kind: SUGGESTION_KIND, payload, attempt: (clientEventId) => postSuggestion(api, payload, clientEventId) })
}

/** One try, online only (a suggestion without the name never waits on the phone). */
export function postSuggestion(api: ApiClient, payload: Readonly<Record<string, unknown>>, clientEventId: string): Promise<TaskOutcome<z.infer<typeof sentSchema>>> {
  return floorWrite(api, 'POST', '/floor/suggestions', { body: { ...payload, clientEventId }, schema: sentSchema, idempotencyKey: clientEventId })
}

/** The voice note of a suggestion (AUDIO only, online). */
export const uploadSuggestionVoice = (api: ApiClient, blob: Blob, name: string, seconds: number) => uploadTo(api, '/floor/suggestions/files', blob, name, seconds)
