import { z } from 'zod'
import { operationMinutesView, waitingView, type OperationMinutesView, type ProposeBody, type TimeVersionView, type WaitingView } from '@nexus/factory-domain/product/minutes/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Every call of the operation library's W2b depth (B-W2b-235 on B-W2b-215's and B-W2b-225's API): the Minutes tab (the SMV and
 * how it is built, its versions, what a change reaches), Propose SMV change, a second person's approve or reject, the SMV
 * changes waiting (the list's tile), and the Machine & settings tab. The minutes answers are checked against factory-domain's
 * own contracts (product/minutes, browser-safe); the settings answers against the shapes below, written here because
 * factory-domain product/routing-depth/contracts reaches `node:crypto` through quality's rules (a browser module may not import
 * it) — routing-depth.vitest.test.ts holds them equal to the domain's. No money.
 */

export type { OperationMinutesView, TimeVersionView, WaitingView }
export type WaitingEntry = WaitingView['versions'][number]

const enc = encodeURIComponent
const path = (operationId: string) => `/product/operations/${enc(operationId)}`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

// ---- the Minutes tab ------------------------------------------------------------------------------------------------------

const minutesAnswer = z.object({ minutes: operationMinutesView })

/** GET /product/operations/:id/minutes (product.routing.view). */
export const getMinutes = (api: ApiClient, operationId: string): Promise<OperationMinutesView> => api.get(`${path(operationId)}/minutes`, { schema: minutesAnswer }).then((answer) => answer.minutes)

export type ProposeInput = Omit<ProposeBody, 'replaces'> & { replaces?: string }

/** POST …/minutes/proposals (product.smv.propose): "Send for approval"; `replaces` names the waiting proposal it replaces. */
export const proposeSmv = (api: ApiClient, operationId: string, body: ProposeInput): Promise<{ minutes: OperationMinutesView; versionId: string }> =>
  api.post(`${path(operationId)}/minutes/proposals`, { body, schema: z.object({ minutes: operationMinutesView, versionId: z.string() }), ...key() })

/** POST …/versions/:versionId/approve (product.smv.approve; never one's own proposal): at the version read. */
export const approveSmv = (api: ApiClient, operationId: string, version: Pick<TimeVersionView, 'id' | 'version'>, note?: string): Promise<{ minutes: OperationMinutesView; tookEffect: boolean }> =>
  api.post(`${path(operationId)}/minutes/versions/${enc(version.id)}/approve`, {
    body: { version: version.version, ...(note?.trim() ? { note: note.trim() } : {}) },
    schema: z.object({ minutes: operationMinutesView, tookEffect: z.boolean() }),
    ...key(),
  })

/** POST …/versions/:versionId/reject (product.smv.approve): with why. */
export const rejectSmv = (api: ApiClient, operationId: string, version: Pick<TimeVersionView, 'id' | 'version'>, note: string): Promise<OperationMinutesView> =>
  api.post(`${path(operationId)}/minutes/versions/${enc(version.id)}/reject`, { body: { version: version.version, note: note.trim() }, schema: minutesAnswer, ...key() }).then((answer) => answer.minutes)

/** GET /product/minutes/waiting (product.routing.view): the SMV changes waiting for approval, oldest first, with the count. */
export const listWaiting = (api: ApiClient, companyId: string | null, limit = 200): Promise<WaitingView> =>
  api.get('/product/minutes/waiting', { query: { companyId: companyId ?? undefined, limit }, schema: waitingView })

// ---- machine and stitch settings (B-W2b-225, PRD-118) -----------------------------------------------------------------------

const words = z.object({ it: z.string(), en: z.string() })

/** One machine and stitch setting as the API answers it (factory-domain routing-depth settingView). */
export const settingSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  machineClass: z.object({ id: z.string(), code: z.string(), label: words, active: z.boolean() }).nullable(),
  stitchType: z.string().nullable(),
  needle: z.string().nullable(),
  thread: z.string().nullable(),
  stitchesPerCm: z.string().nullable(),
  tension: z.string().nullable(),
  foot: z.string().nullable(),
  notes: z.string().nullable(),
  /** One line for the tablet, in both languages. */
  line: words,
})
export type Setting = z.infer<typeof settingSchema>

/** What a setting sends (null: not said). */
export interface SettingBody {
  machineClassId: string | null
  stitchType: string | null
  needle: string | null
  thread: string | null
  stitchesPerCm: string | null
  tension: string | null
  foot: string | null
  notes: string | null
}

export const librarySettingsSchema = z.object({
  operation: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), status: z.enum(['ACTIVE', 'ARCHIVED']), version: z.number().int() }),
  settings: z.array(settingSchema),
  /** Draft routing steps of this operation with no settings of their own. */
  draftStepsWithout: z.number().int(),
  may: z.object({ manage: z.boolean() }),
})
export type LibrarySettings = z.infer<typeof librarySettingsSchema>

const settingsAnswer = z.object({ operation: librarySettingsSchema })

/** GET /product/operations/:id/settings (product.routing.view): the Machine & settings tab. */
export const getLibrarySettings = (api: ApiClient, operationId: string): Promise<LibrarySettings> => api.get(`${path(operationId)}/settings`, { schema: settingsAnswer }).then((answer) => answer.operation)

/** PUT /product/operations/:id/settings (product.operations.manage): the whole list, at the OPERATION's version. */
export const setLibrarySettings = (api: ApiClient, operation: { id: string; version: number }, settings: readonly SettingBody[]): Promise<LibrarySettings> =>
  api.request('PUT', `${path(operation.id)}/settings`, { body: { version: operation.version, settings }, schema: settingsAnswer, ...key() }).then((answer) => answer.operation)

/** The machine classes a setting may name (GET /plant/classes, plant.view; the active ones). */
const classSchema = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string() })
export type MachineClassChoice = z.infer<typeof classSchema>

export const listMachineClasses = (api: ApiClient): Promise<MachineClassChoice[]> =>
  api.get('/plant/classes', { query: { active: 'true' }, schema: z.object({ classes: z.array(classSchema) }) }).then((answer) => answer.classes)
