import type { DepartmentAnswer } from '../../../../../lib/department/model'
import type { RouteRouting, StyleRouteView } from './api'

/**
 * owb-pd6 (S4) — made-up data for the route parts' tests: the nine departments of the seed (owb-b1 a.6) in the factory's ONE order
 * (design § 5u: Design · Pattern · Cutting · Molding · Patch & print · Stitching · Assembly · Quality · Packing), the six of today on
 * the floor, and a draft revision's routing in the pd2 shape (owb-pd-server.md § Shape) with one model and one customer route.
 * Design-only: tests import it, nothing else.
 */

const row = (number: number, name: string, shortName: string, kind: string, tone: string, icon: string, seq: number, floorReady: boolean): DepartmentAnswer => ({
  id: `dept-${number}`,
  number,
  name,
  shortName,
  nameI18n: {},
  tone,
  icon,
  status: 'ACTIVE',
  workCentreKind: kind,
  floorReady,
  seq,
  version: 1,
})

export const DEPT_ROWS: readonly DepartmentAnswer[] = Object.freeze([
  row(7, 'Product design', 'Design', 'ASSEMBLY', 'violet', 'pen-tool', 1, false),
  row(1, 'Pattern', 'Pattern', 'CUTTING', 'blue', 'ruler', 2, true),
  row(2, 'Cutting', 'Cutting', 'CUTTING', 'orange', 'scissors', 3, true),
  row(8, 'Injection molding', 'Molding', 'ASSEMBLY', 'slate', 'cylinder', 4, false),
  row(3, 'Patchwork & printing', 'Patch & print', 'FINISHING', 'pink', 'layers', 5, true),
  row(4, 'Stitching', 'Stitching', 'SEWING', 'cyan', 'shirt', 6, true),
  row(9, 'Assembly', 'Assembly', 'ASSEMBLY', 'emerald', 'puzzle', 7, false),
  row(5, 'Quality check', 'Quality', 'INSPECTION', 'purple', 'shield-check', 8, true),
  row(6, 'Packing', 'Packing', 'PACKING', 'yellow', 'package', 9, true),
])

export const REVISION_ID = 'rev-3'
export const STYLE_ID = 'style-demo-1'

const step = (index: number, number: number, name: string, kind: string, minutes: string) => ({
  id: `step-${index}`,
  seq: (index + 1) * 10,
  code: `DEPT-${number}`,
  name,
  workCentreKind: kind,
  standardMinutes: minutes,
  department: { id: `dept-${number}`, number },
})

export const MODEL_ROUTE: StyleRouteView = {
  id: 'route-model',
  name: 'With molded sliders',
  kind: 'MODEL',
  party: null,
  steps: [
    { departmentId: 'dept-1', number: 1, minutes: '30' },
    { departmentId: 'dept-2', number: 2, minutes: '40' },
    { departmentId: 'dept-8', number: 8, minutes: '6' },
    { departmentId: 'dept-4', number: 4, minutes: '60' },
    { departmentId: 'dept-6', number: 6, minutes: '8' },
  ],
  rules: { errors: [], warnings: ['NO_QUALITY'] },
  version: 2,
}

export const CUSTOMER_ROUTE: StyleRouteView = {
  id: 'route-customer',
  name: 'Brand Alpha checks twice',
  kind: 'CUSTOMER',
  party: { id: 'party-alpha', code: 'ALPHA', name: 'Brand Alpha' },
  steps: [
    { departmentId: 'dept-2', number: 2, minutes: '40' },
    { departmentId: 'dept-4', number: 4, minutes: '60' },
    { departmentId: 'dept-5', number: 5, minutes: '15' },
    { departmentId: 'dept-5', number: 5, minutes: '10' },
    { departmentId: 'dept-6', number: 6, minutes: null },
  ],
  rules: { errors: [], warnings: [] },
  version: 1,
}

/** A draft revision 3: the six departments of today, 193.5 minutes; a model route and a customer route. */
export function demoRouteRouting(overrides: Partial<RouteRouting> = {}): RouteRouting {
  return {
    revision: { id: REVISION_ID, revision: 3, status: 'DRAFT', version: 7 },
    editable: true,
    steps: [step(0, 1, 'Pattern', 'CUTTING', '30'), step(1, 2, 'Cutting', 'CUTTING', '40'), step(2, 3, 'Patchwork & printing', 'FINISHING', '40.5'), step(3, 4, 'Stitching', 'SEWING', '60'), step(4, 5, 'Quality check', 'INSPECTION', '15'), step(5, 6, 'Packing', 'PACKING', '8')],
    rules: { errors: [], warnings: [] },
    routes: [MODEL_ROUTE, CUSTOMER_ROUTE],
    ...overrides,
  }
}
