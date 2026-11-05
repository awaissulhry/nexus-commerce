import { z } from 'zod'
import { INCIDENT_KINDS } from '@nexus/factory-domain/safety/incidents/rules'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { contentTypeOf } from '../machine/api'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'
import type { ReportBody } from './model'

/**
 * Report an incident's calls (B-W2b-137 on the merged API of B-W2b-125, apps/factory-api modules/safety/incidents; floor.work at
 * the tablet's site, anyone at the station, as a help call):
 *
 *   GET  /safety/floor/incidents/start                 112, the site's first aiders in force (names, as the notice board), "here"
 *                                                      = this tablet's station with its machines, the site's areas, and the kinds
 *                                                      that may go without a name
 *   POST /safety/floor/incidents                       the report WITHOUT a name, online only (a named one is the tablet queue's
 *                                                      `safety.incident.report`: saved here first; see Incident.tsx)
 *   GET  /safety/floor/incidents/:id                   "Seen by safety at …" for this tablet's report (7 days), or one without a
 *                                                      name by its id
 *   POST /safety/floor/incidents/:id/photos (+ complete)  a photo: announced with its size and SHA-256, PUT to the store, then
 *                                                      confirmed (≤ 4, within 30 minutes; OFFICE only: the tablet cannot read it
 *                                                      back)
 *
 * Each answer is checked against the fields the screen reads. No money; no injury detail; first aiders by name as the site's
 * notice board names them.
 */

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })

const startSchema = z.object({
  emergency: z.object({ number: z.string(), firstAiders: z.array(z.object({ name: z.string(), shift: z.string().nullable() })) }),
  here: z.object({ station: ref, machines: z.array(z.object({ id: z.string(), assetNumber: z.string() })) }).nullable(),
  areas: z.array(ref),
  anonymousKinds: z.array(z.enum(INCIDENT_KINDS)),
})
export type IncidentStart = z.infer<typeof startSchema>

export const readStart = (api: ApiClient): Promise<TaskOutcome<IncidentStart>> => floorRead(api, '/safety/floor/incidents/start', { schema: startSchema })

const reportAnswer = z.object({
  incident: z.object({ id: z.string(), number: z.string(), kind: z.enum(INCIDENT_KINDS), status: z.literal('OPEN'), anonymous: z.boolean(), version: z.number() }),
  replayed: z.boolean(),
})
export type ReportAnswer = z.infer<typeof reportAnswer>

/**
 * The report without a name, online only. `key`: kept by the screen while no answer came (a resend with the same key and the
 * same body is answered from the first receipt: one report).
 */
export const sendWithoutName = (api: ApiClient, body: ReportBody, key: string): Promise<TaskOutcome<ReportAnswer>> =>
  floorWrite(api, 'POST', '/safety/floor/incidents', { body, schema: reportAnswer, idempotencyKey: key })

const reportState = z.object({ incident: z.object({ id: z.string(), number: z.string(), kind: z.enum(INCIDENT_KINDS), seenAt: z.string().nullable(), closed: z.boolean() }) })
export type ReportState = z.infer<typeof reportState>['incident']

/** "Seen by safety": this tablet's report as the office has it (its number, when safety saw it). */
export async function readReport(api: ApiClient, incidentId: string): Promise<TaskOutcome<ReportState>> {
  const answer = await floorRead(api, `/safety/floor/incidents/${seg(incidentId)}`, { schema: reportState })
  return answer.ok ? { ok: true, value: answer.value.incident } : answer
}

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })
const completed = z.object({ file: z.object({ id: z.string() }) })

/** A photo onto the report: announced, its bytes PUT straight to the store, then confirmed. Each step's failure stops it. */
export async function uploadPhoto(api: ApiClient, incidentId: string, file: Blob, name: string): Promise<TaskOutcome<{ readonly fileId: string }>> {
  const base = `/safety/floor/incidents/${seg(incidentId)}/photos`
  const bytes = await file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  const first = await floorWrite(api, 'POST', base, { body: { originalName: name, contentType: contentTypeOf(file, 'image/jpeg'), sizeBytes: bytes.byteLength, sha256 }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: completed })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}
