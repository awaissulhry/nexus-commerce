import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { createDepartmentBody, departmentMoveBody, updateDepartmentBody } from '@nexus/factory-domain/production/departments/contracts'

/** owb- (b3.3): GET /production/departments — the Shapes of owb-b23.md (ordered by seq). */
export const departmentView = output({
  id: id(),
  number: z.number().int(),
  name: z.string(),
  shortName: z.string(),
  /** Names per language (the floor's Urdu among them, marked draft until a reader checks it); {} when none. */
  nameI18n: z.record(z.string(), z.string()),
  /** One of the 10 grid tones (slate, purple, emerald, pink, orange, blue, yellow, red, violet, cyan). */
  tone: z.string(),
  /** A lucide icon id (kebab case); the web chip maps it. */
  icon: z.string(),
  workCentreKind: z.string(),
  seq: z.number().int(),
  floorReady: z.boolean(),
  status: z.enum(['ACTIVE', 'CLOSED']),
  /** owb-pd1 1.3: the row's version, sent back by a rename, a close or an open (a stale one is a 409). */
  version: z.number().int(),
})
export type DepartmentView = z.infer<typeof departmentView>

export const departmentsContract = defineContract({ response: { 200: output({ departments: z.array(departmentView) }) } })

// ---- owb-pd1 1.3: keeping the departments (./manage.ts) -----------------------------------------------------------------
const oneDepartment = output({ department: departmentView })
const department = input({ departmentId: id() })
export const createDepartmentContract = defineContract({ body: createDepartmentBody, response: { 201: oneDepartment } })
export const updateDepartmentContract = defineContract({ params: department, body: updateDepartmentBody, response: { 200: oneDepartment } })
export const moveDepartmentContract = defineContract({ params: department, body: departmentMoveBody, response: { 200: oneDepartment } })
