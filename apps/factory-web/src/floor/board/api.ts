import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { floorRead, type TaskOutcome } from '../tasks/shared/task-api'

/**
 * owb-fl9 step 2 — the phone's Board (the team leader's tab): GET /production/baskets/board?scope=team|floor&departmentId (floor:
 * floor.lead; server B's fl4). The floor's answer names the customer's CODE only, never its name, no money; a worker's name only where
 * the site's scanSubject names workers. This web's own zod (the floor reads no office file): what the list draws is required.
 */

const department = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
  shortName: z.string().nullable().optional(),
  nameI18n: z.record(z.string(), z.string()).nullable().optional(),
  tone: z.string(),
  icon: z.string(),
})
export type BoardDepartment = z.infer<typeof department>

const card = z.object({
  bundleId: z.string(),
  code: z.string(),
  picture: z.object({ src: z.string() }).nullable().optional(),
  customerCode: z.string().nullable().optional(),
  customer: z.object({ code: z.string().nullable().optional() }).passthrough().nullable().optional(),
  step: z.object({ operationId: z.string().nullable().optional(), department: department.nullable().optional() }).nullable().optional(),
  state: z.string().nullable().optional(),
  flags: z.object({ first: z.boolean().optional(), late: z.boolean().optional(), problem: z.object({ callId: z.string() }).passthrough().nullable().optional() }).nullable().optional(),
  team: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  worker: z.object({ name: z.string().nullable() }).nullable().optional(),
})
export type FloorBoardCard = z.infer<typeof card>

export const floorBoardSchema = z.object({
  columns: z.array(z.object({ department, baskets: z.array(card) })),
  readyToShip: z.array(card),
})
export type FloorBoard = z.infer<typeof floorBoardSchema>

export type BoardScope = 'team' | 'floor'

export const readFloorBoard = (api: ApiClient, scope: BoardScope): Promise<TaskOutcome<FloorBoard>> => floorRead(api, '/production/baskets/board', { query: { scope }, schema: floorBoardSchema })
