import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { pictureSchema } from '../../../lib/people-picture/schema'

/**
 * owb-ss8 (S3 web B; the server Shape of owb-ss5 § units/people/history, FIXED) — People › Factory structure: the tree, a unit's and a
 * person's profile, their history, and the writes (new unit, profile, move, merge, close, ready-made). Answers are checked (zod; unknown
 * fields dropped). A write answers what it answers: the page reads the structure (and the open profile) again after it, so no write's
 * answer is relied on. The leader stays today's `PUT /people/teams/:id/lead`; a person moves with today's `POST /people/teams/moves`; a
 * new person is today's `POST /people/employees`; a person's own fields are today's `PATCH /people/employees/:id`.
 *
 * Privacy: no figure about one person's work in any answer read here (the real app's rule; design § 5zb). A person's phone is read and
 * written only by someone with the personal right (the API checks; the screen offers it only then).
 */

const person = z.object({ employeeId: z.string(), name: z.string() })

export const unitRowSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  kindWord: z.string().nullable(),
  picture: pictureSchema,
  leader: person.nullable(),
  takesOrders: z.boolean(),
  closed: z.boolean(),
  siteId: z.string(),
  people: z.number().int().min(0),
})
export type UnitRow = z.infer<typeof unitRowSchema>

export const personRowSchema = z.object({
  employeeId: z.string(),
  name: z.string(),
  unitId: z.string().nullable(),
  isLeader: z.boolean(),
  role: z.string().nullable(),
  picture: pictureSchema,
})
export type PersonRow = z.infer<typeof personRowSchema>

const structureSchema = z.object({ units: z.array(unitRowSchema), people: z.array(personRowSchema), may: z.object({ manage: z.boolean() }) })
export type Structure = z.infer<typeof structureSchema>

export const getStructure = (api: ApiClient, signal?: AbortSignal) => api.get('/people/structure', { schema: structureSchema, signal })

const unitRecordSchema = unitRowSchema.extend({
  about: z.string().nullable(),
  standIn: z.object({ employeeId: z.string(), name: z.string(), until: z.string().nullable() }).nullable(),
  worksFor: z.array(z.object({ partyId: z.string(), name: z.string() })),
  maxBaskets: z.number().int().nullable(),
  takesNewOrders: z.boolean(),
  ownFacts: z.array(z.object({ label: z.string(), value: z.string() })),
  work: z.array(z.object({ orderId: z.string(), number: z.string(), customerCode: z.string(), state: z.string() })),
  members: z.array(personRowSchema),
  version: z.number().int(),
})
export type UnitRecord = z.infer<typeof unitRecordSchema>

const seg = (value: string): string => encodeURIComponent(value)

export const getUnit = (api: ApiClient, unitId: string, signal?: AbortSignal) => api.get(`/people/units/${seg(unitId)}`, { schema: unitRecordSchema, signal })

const historySchema = z.object({ rows: z.array(z.object({ at: z.string(), who: z.string(), words: z.string(), icon: z.string() })) })
export type HistoryRow = z.infer<typeof historySchema>['rows'][number]

export const unitHistory = (api: ApiClient, unitId: string, signal?: AbortSignal) => api.get(`/people/units/${seg(unitId)}/history`, { schema: historySchema, signal }).then((answer) => answer.rows)
export const personHistory = (api: ApiClient, employeeId: string, signal?: AbortSignal) => api.get(`/people/employees/${seg(employeeId)}/history`, { schema: historySchema, signal }).then((answer) => answer.rows)

/** A unit's profile as the Edit window sends it (model.ts unitBodyOf). */
export interface UnitBody {
  readonly name: string
  readonly kindWord: string | null
  readonly takesOrders: boolean
  readonly pictureKind: 'LETTERS' | 'ICON'
  readonly pictureIcon: string | null
  readonly pictureColour: string
  readonly about: string | null
  readonly standInEmployeeId: string | null
  readonly standInUntil: string | null
  readonly worksForPartyIds: readonly string[]
  readonly maxBaskets: number | null
  readonly takesNewOrders: boolean
}

export const createUnit = (api: ApiClient, body: UnitBody & { siteId: string; parentId: string | null }) =>
  api.post('/people/units', { body, schema: z.object({ id: z.string() }).passthrough(), idempotencyKey: newIdempotencyKey() })
export const patchUnit = (api: ApiClient, unitId: string, body: UnitBody & { version: number }) => api.request('PATCH', `/people/units/${seg(unitId)}`, { body, idempotencyKey: newIdempotencyKey() })
export const moveUnit = (api: ApiClient, unitId: string, parentId: string | null) => api.post(`/people/units/${seg(unitId)}/move`, { body: { parentId }, idempotencyKey: newIdempotencyKey() })
export const mergeUnits = (api: ApiClient, body: { keepId: string; mergeIds: readonly string[]; name: string; leaderEmployeeId?: string | null }) =>
  api.post('/people/units/merge', { body, idempotencyKey: newIdempotencyKey() })
export const closeUnit = (api: ApiClient, unitId: string) => api.post(`/people/units/${seg(unitId)}/close`, { body: {}, idempotencyKey: newIdempotencyKey() })

export const READY_MADE = ['OWNER_TEAMS', 'SUPERVISORS', 'GENERAL_MANAGER'] as const
export type ReadyMade = (typeof READY_MADE)[number]

/** The preview's rows are the API's words for each change (through the base's faces), drawn as they come; no row: nothing changes. */
const previewSchema = z.object({ rows: z.array(z.object({ name: z.string(), words: z.string() })).catch([]) }).passthrough()
export type ReadyMadePreview = z.infer<typeof previewSchema>

export const previewReadyMade = (api: ApiClient, kind: ReadyMade) => api.post('/people/units/ready-made/preview', { body: { kind }, schema: previewSchema })
export const applyReadyMade = (api: ApiClient, kind: ReadyMade) => api.post('/people/units/ready-made/apply', { body: { kind }, idempotencyKey: newIdempotencyKey() })

// ── a person (today's employee routes, only the fields this page shows) ───────────────────────────────────────────────────────

const employeeSchema = z.object({
  id: z.string(),
  name: z.string(),
  site: z.object({ id: z.string() }),
  jobRole: z.string().nullable(),
  locale: z.string(),
  startDate: z.string(),
  /** Personal: sent only to someone with the personal right (absent otherwise). */
  phone: z.string().nullable().optional(),
  version: z.number().int(),
})
export type EmployeeFacts = z.infer<typeof employeeSchema>

export const getEmployeeFacts = (api: ApiClient, employeeId: string, signal?: AbortSignal) =>
  api.get(`/people/employees/${seg(employeeId)}`, { schema: z.object({ employee: employeeSchema }), signal }).then((answer) => answer.employee)

export const patchEmployee = (api: ApiClient, employeeId: string, body: { version: number; jobRole?: string | null; locale?: string; startDate?: string; phone?: string | null }) =>
  api.request('PATCH', `/people/employees/${seg(employeeId)}`, { body, idempotencyKey: newIdempotencyKey() })
