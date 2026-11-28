import { signedInFrame } from '../frame/fixtures'
import type { BasketHome, BasketRead, BasketRow, BasketStep, DepartmentLook, ForYouItem } from './api'

/**
 * owb-fl5 — made-up baskets for the tests (no real customer, person or code): the leather suit's six departments, a basket at each
 * place a phone meets one (waiting, working, at Quality, on hold, in another department, not on its route, ready to ship) and a home.
 */

const dept = (number: number, name: string, shortName: string, tone: string, icon: string): DepartmentLook => ({ id: `dept-${number}`, number, name, shortName, tone, icon, nameI18n: { it: name } })

export const PATTERN = dept(1, 'Pattern', 'Pattern', 'blue', 'ruler')
export const CUTTING = dept(2, 'Cutting', 'Cutting', 'orange', 'scissors')
export const PATCH = dept(3, 'Patchwork and printing', 'Patch & print', 'pink', 'layers')
export const STITCHING = dept(4, 'Stitching', 'Stitching', 'cyan', 'shirt')
export const QUALITY = dept(5, 'Quality check', 'Quality', 'purple', 'shield-check')
export const PACKING = dept(6, 'Packing', 'Packing', 'yellow', 'package')

const ROUTE = [PATTERN, CUTTING, PATCH, STITCHING, QUALITY, PACKING]

/** The suit's six steps, the basket at `at` (0-based; 6 = every step reported). */
export function route(at: number, here: 'HERE' | 'NEXT' = 'HERE'): BasketStep[] {
  return ROUTE.map((department, index): BasketStep => ({
    operationId: `op-${index + 1}`,
    seq: (index + 1) * 10,
    name: department.name,
    department,
    state: index < at ? 'DONE' : index === at ? here : index === at + 1 ? 'NEXT' : 'TODO',
    added: false,
  }))
}

/** A whole read of B-0431 waiting at Stitching, in Stitching. */
export function basketRead(extra: Partial<BasketRead> = {}): BasketRead {
  return {
    scanned: false,
    refusal: null,
    basket: {
      id: 'bnd-0431',
      code: 'B-0431',
      quantity: 1,
      smallParts: false,
      workOrderId: 'wo-0100',
      workOrderNumber: 'WO-2026-0100',
      salesOrderId: 'so-0100',
      customerCode: 'SEED-C1',
      due: '2026-12-10',
      words: { size: '52', colour: 'Red and black', label: 'Suit · No. 19', leather: 'Kangaroo' },
      team: { id: 'team-1', name: 'Team Noor', picture: { kind: 'ICON', icon: 'shirt', colour: 'cyan' } },
      rush: false,
    },
    picture: { fileId: 'file-1', src: 'https://files.example.com/b-0431.jpg', expiresAt: '2026-11-28T12:00:00.000Z' },
    route: { own: false, steps: route(3) },
    place: { operationId: 'op-4', how: 'SCANS', waitingFirst: false },
    work: { state: 'WAITING', mine: false },
    here: { departmentId: 'dept-4', sameDepartment: true, onRoute: true, takeHereOperationId: null },
    hold: null,
    changedDesign: null,
    flags: { first: false, late: null, problem: null, ask: null, answer: null },
    restricted: null,
    quality: null,
    next: { operationId: 'op-5', department: QUALITY },
    notes: [],
    designPageHref: '/floor/instructions?workOrderId=wo-0100',
    can: { start: true, done: true, moveForward: true, moveBack: false, route: false, give: false, flag: false, late: false },
    ...extra,
  }
}

/** At Quality, worked on: six points to tick and two photos (`done` of them done). */
export function atQuality(done: number, extra: Partial<BasketRead> = {}): BasketRead {
  const steps = [
    ['stitch', 'Stitching', false],
    ['size', 'Measurements', false],
    ['logo', 'Logos and patches', false],
    ['colour', 'Colour and material', false],
    ['zips', 'Zips and buttons', false],
    ['clean', 'Clean and complete', false],
    ['front', 'Front', true],
    ['back', 'Back', true],
  ] as const
  const list = steps.map(([code, words, photo], index) => ({ code, words, icon: null, required: true, photo, done: index < done }))
  return basketRead({
    route: { own: false, steps: route(4) },
    place: { operationId: 'op-5', how: 'SCANS', waitingFirst: false },
    work: { state: 'WORKING', mine: true },
    here: { departmentId: 'dept-5', sameDepartment: true, onRoute: true, takeHereOperationId: null },
    next: { operationId: 'op-6', department: PACKING },
    quality: { ticks: { required: 6, done: list.filter((step) => !step.photo && step.done).length }, photos: { required: 2, done: list.filter((step) => step.photo && step.done).length }, steps: list },
    can: { start: true, done: true, moveForward: true, moveBack: true, route: false, give: false, flag: false, late: false },
    ...extra,
  })
}

const row = (code: string, department: DepartmentLook, state: BasketRow['state'], flags: Partial<BasketRow['flags']> = {}): BasketRow => ({
  bundleId: `bnd-${code}`,
  code,
  picture: null,
  customerCode: 'SEED-C1',
  step: { operationId: `op-${department.number}`, department },
  state,
  flags: { first: false, late: false, problem: false, ...flags },
})

const item = (kind: ForYouItem['kind'], code: string | null, at: string, words = ''): ForYouItem => ({ kind, bundleId: code ? `bnd-${code}` : null, code, words, at })

/** A worker's home in Stitching. */
export function basketHome(extra: Partial<BasketHome> = {}): BasketHome {
  return {
    department: STITCHING,
    forYou: [item('ANSWER', 'B-0405', '2026-11-28T09:10:00.000Z', 'Use the logo of the 2026 file.'), item('CHANGED_DESIGN', 'B-0431', '2026-11-28T09:30:00.000Z', 'The chest logo is 2 cm bigger.'), item('PROBLEM', 'B-0420', '2026-11-28T08:00:00.000Z')],
    here: [row('B-0431', STITCHING, 'WAITING'), row('B-0402', STITCHING, 'WORKING'), row('B-0418', STITCHING, 'WAITING', { first: true }), row('B-0409', STITCHING, 'PAUSED', { problem: true })],
    comingNext: [row('B-0440', PATCH, 'WORKING'), row('B-0433', PATCH, 'WAITING')],
    ...extra,
  }
}

export const FRAME = signedInFrame('tile.baskets', { showHome: false })
