import { departmentOfAnswer, type Department } from '../../lib/department/model'
import type { RowPicture } from '../../lib/record-picture/model'
import type { BasketHome, BasketPicture, BasketRead, BasketRow, BasketStep, DepartmentLook, ForYouItem, QualityStep, StepState } from './api'
import { unseenForYou } from './home/seen'

/**
 * owb-fl5 (design § 4.3–4.5, § 5zf B, § 5zg A–C; P/floor.js floorHome, floorBasket; P/fplus.js floorDock, qcCard; P/fsteps.js stepBar) —
 * the basket on a phone without a screen: where the pages live, the home's lists, the step bar, the quality check's count and the
 * dock's ONE next action. Pure, so the tests hold every rule.
 */

// ---- where the pages live -----------------------------------------------------------------------------------------------------

/** The basket page of a code (a scan or a list row opens it). */
export const basketPath = (code: string): string => `/floor/basket/${encodeURIComponent(code)}`

/** The phone's home is `/floor` (lead settle 9); a tablet opens the same basket home from its Baskets tile. */
export const PHONE_HOME = '/floor'
export const TABLET_BASKETS = '/floor/baskets'
export const basketHomeOf = (deviceMode: string | null | undefined): string => (deviceMode === 'PHONE' ? PHONE_HOME : TABLET_BASKETS)

// ---- departments and pictures ---------------------------------------------------------------------------------------------------

/** A department of a read, in the page's language (null: the step names none). */
export const deptOf = (look: DepartmentLook | null | undefined, locale: string): Department | null => (look ? departmentOfAnswer(look, locale) : null)

/** The base picture part's row picture for a basket (its own picture: the order's, stamped for this site). */
export function rowPictureOf(basket: { readonly id: string; readonly code: string; readonly label?: string | null }, picture: BasketPicture | null): RowPicture | null {
  return picture ? { styleId: basket.id, styleCode: basket.code, styleName: basket.label ?? '', fileId: picture.fileId, small: true } : null
}

/** The address the picture part holds: the read's, until its expiry (one minute when the read names none). */
export function heldOf(picture: BasketPicture | null, now: number): { readonly url: string; readonly expiresAt: string } | null {
  return picture ? { url: picture.src, expiresAt: picture.expiresAt ?? new Date(now + 60_000).toISOString() } : null
}

// ---- the basket read, whole ----------------------------------------------------------------------------------------------------

/** A read that names a basket the page can draw (every part present). */
export type BasketView = BasketRead & {
  readonly basket: NonNullable<BasketRead['basket']>
  readonly route: NonNullable<BasketRead['route']>
  readonly place: NonNullable<BasketRead['place']>
  readonly work: NonNullable<BasketRead['work']>
  readonly here: NonNullable<BasketRead['here']>
  readonly flags: NonNullable<BasketRead['flags']>
  readonly next: NonNullable<BasketRead['next']>
  readonly can: NonNullable<BasketRead['can']>
}

/** The read as a basket to draw, or null (a refusal, or an answer that lacks a part). */
export function viewOf(read: BasketRead): BasketView | null {
  if (read.refusal || !read.basket || !read.route || !read.place || !read.work || !read.here || !read.flags || !read.next || !read.can) return null
  return read as BasketView
}

/** The steps that count (a skipped step is struck through, never counted). */
const counted = (steps: readonly BasketStep[]): BasketStep[] => steps.filter((step) => step.state !== 'SKIPPED')

/** Every step reported (or skipped): the basket is ready to ship. */
export const readyOf = (steps: readonly BasketStep[]): boolean => steps.length > 0 && steps.every((step) => step.state === 'DONE' || step.state === 'SKIPPED')

// ---- the step bar ("Step 3 / 6 · Change", the route's colours, "3 Patch & print → 4 Stitching") -------------------------------

export interface StepBarStep {
  readonly key: string
  readonly dept: Department | null
  readonly name: string
  readonly state: StepState
  readonly added: boolean
}

export interface StepBarModel {
  readonly steps: readonly StepBarStep[]
  /** The step it is at, from 1; null: ready to ship. */
  readonly at: number | null
  readonly total: number
  /** Where it is now ("3 Patch & print"); null: ready to ship. */
  readonly now: StepBarStep | null
  /** The step after ("→ 4 Stitching"); null: Done makes it ready to ship. */
  readonly next: StepBarStep | null
  readonly ready: boolean
  /** The route was changed for this basket ("Own route"). */
  readonly own: boolean
}

export function stepBarOf(view: Pick<BasketView, 'route'>, locale: string): StepBarModel {
  const steps = counted(view.route.steps).map((step) => ({ key: step.operationId, dept: deptOf(step.department, locale), name: step.name, state: step.state, added: step.added }))
  const ready = readyOf(view.route.steps)
  const hereAt = steps.findIndex((step) => step.state === 'HERE')
  const nowAt = ready ? -1 : hereAt >= 0 ? hereAt : steps.findIndex((step) => step.state === 'NEXT' || step.state === 'TODO')
  const nextAt = nowAt < 0 ? -1 : steps.findIndex((step, index) => index > nowAt && (step.state === 'NEXT' || step.state === 'TODO'))
  return {
    steps,
    at: nowAt < 0 ? null : nowAt + 1,
    total: steps.length,
    now: nowAt < 0 ? null : steps[nowAt]!,
    next: nextAt < 0 ? null : steps[nextAt]!,
    ready,
    own: view.route.own,
  }
}

/** The step a basket goes back to from Quality ("Not good: send back to 4 Stitching"): the reported step right before it. */
export function previousStepOf(view: Pick<BasketView, 'route'>): BasketStep | null {
  const steps = counted(view.route.steps)
  const at = steps.findIndex((step) => step.state === 'HERE')
  for (let index = at - 1; index >= 0; index--) if (steps[index]!.state === 'DONE') return steps[index]!
  return null
}

// ---- the quality check: the ticks and the photos ("Passed" waits for all of them) ----------------------------------------------

export interface QualityProgress {
  readonly done: number
  readonly total: number
  readonly complete: boolean
}

/** What is done of the check: the steps when the read lists them, else its counts. */
export function qualityOf(quality: BasketRead['quality'], steps: readonly QualityStep[]): QualityProgress | null {
  if (!quality) return null
  const required = steps.filter((step) => step.required)
  const done = required.length > 0 ? required.filter((step) => step.done).length : quality.ticks.done + quality.photos.done
  const total = required.length > 0 ? required.length : quality.ticks.required + quality.photos.required
  return { done, total, complete: done >= total }
}

/** A step ticked or photographed on this phone (the read answers it at the next read). */
export const stepDone = (steps: readonly QualityStep[], code: string): QualityStep[] => steps.map((step) => (step.code === code ? { ...step, done: true } : step))

// ---- the dock: the ONE next action, 64 px, always under the thumb ----------------------------------------------------------------

export type Dock =
  /** Nothing to do here (ready to ship, another worker's basket, a lock). */
  | { readonly kind: 'none' }
  /** A hold refuses the scan (pick B): why, and "Ask your team leader" instead of Start. */
  | { readonly kind: 'hold'; readonly hold: NonNullable<BasketRead['hold']>['kind']; readonly words: string }
  /** Scanned in another department, on its route: Take it here (a TAKEN_HERE move, logged with the warning). */
  | { readonly kind: 'takeHere'; readonly operationId: string }
  /** Scanned in a department that is not on its route (settle 8): its next step, and "Ask your team leader". */
  | { readonly kind: 'offRoute' }
  /** A team leader who opened it from a list, in another department: Change the step (fl6's window). */
  | { readonly kind: 'changeStep' }
  /** A changed design not looked at on this device: "I saw the new design" before the next Start. */
  | { readonly kind: 'sawDesign' }
  | { readonly kind: 'start'; readonly resume: boolean }
  /** Working: Pause beside Done (Passed at Quality, Packed at the last step); Passed held until the check is complete. */
  | { readonly kind: 'working'; readonly main: 'done' | 'passed' | 'packed'; readonly pause: boolean; readonly held: boolean; readonly back: BasketStep | null }

export interface DockInput {
  readonly view: BasketView
  /** The code came from a scan (the basket is in front of the person), not a tap in a list. */
  readonly scanned: boolean
  readonly leader: boolean
  /** A changed design this device has not marked seen (the order-change gate's note). */
  readonly designPending: boolean
  /** fl6's Steps window is built (until then Change the step is not offered: never a dead button). */
  readonly stepsReady: boolean
  readonly quality: QualityProgress | null
}

/** In another department: a department is picked on this phone and it is not the basket's (no pick: the basket's own step). */
export const elsewhereOf = (view: Pick<BasketView, 'here'>): boolean => view.here.departmentId !== null && !view.here.sameDepartment

export function dockOf({ view, scanned, leader, designPending, stepsReady, quality }: DockInput): Dock {
  if (view.restricted || readyOf(view.route.steps)) return { kind: 'none' }
  if (elsewhereOf(view)) {
    // A tap in a list only looks; a scan says the basket is in front of the person (design § 5zg C).
    if (leader && !scanned) return stepsReady ? { kind: 'changeStep' } : { kind: 'none' }
    if (!view.here.onRoute) return { kind: 'offRoute' }
    return view.here.takeHereOperationId && view.can.moveForward ? { kind: 'takeHere', operationId: view.here.takeHereOperationId } : { kind: 'none' }
  }
  if (view.hold) return { kind: 'hold', hold: view.hold.kind, words: view.hold.words }
  if (view.work.state !== 'WORKING') {
    if (designPending) return { kind: 'sawDesign' }
    return view.can.start ? { kind: 'start', resume: view.work.state === 'PAUSED' } : { kind: 'none' }
  }
  if (!view.can.done) return { kind: 'none' }
  const atQuality = view.quality !== null
  return {
    kind: 'working',
    main: atQuality ? 'passed' : view.next.operationId === null ? 'packed' : 'done',
    pause: view.work.mine,
    held: atQuality && !(quality?.complete ?? false),
    back: atQuality && view.can.moveBack ? previousStepOf(view) : null,
  }
}

// ---- the home -------------------------------------------------------------------------------------------------------------------

export interface HomeLists {
  /** ONE list: what is new for this person (news not opened on this device; a leader's waiting problems and asks). */
  readonly forYou: readonly ForYouItem[]
  /** The baskets in this department: "Do this first" on top, then a problem, then the ones being worked on. */
  readonly here: readonly BasketRow[]
  /** The baskets whose next step is here (read only). */
  readonly next: readonly BasketRow[]
}

const rank = (row: BasketRow): number => (row.flags.first ? 0 : row.flags.problem ? 1 : row.state === 'WORKING' ? 2 : 3)

export function homeOf(home: BasketHome, seen: readonly string[]): HomeLists {
  return {
    forYou: unseenForYou(home.forYou, seen).sort((a, b) => b.at.localeCompare(a.at)),
    here: [...home.here].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code)),
    next: [...home.comingNext].sort((a, b) => a.code.localeCompare(b.code)),
  }
}

/** A line of For you opens its basket (one tap); a handover note names none and is only read here. */
export const opensBasket = (item: ForYouItem): boolean => item.code !== null

// ---- what the home says after a Done (one line, the next time it opens) --------------------------------------------------------

export interface DoneFlash {
  readonly code: string
  /** Where it went (null: ready to ship). */
  readonly to: Department | null
  /** A second Done wrote a forward move (no scan, no pay): "Moved on to …". */
  readonly moved: boolean
  /** No network: the Done is kept on the phone and goes when the network is back. */
  readonly saved: boolean
}

let flash: DoneFlash | null = null
export const putFlash = (next: DoneFlash): void => {
  flash = next
}
/** What the home says once (read when it opens; React may read it twice in development: the home clears it after its first paint). */
export const peekFlash = (): DoneFlash | null => flash
export const clearFlash = (): void => {
  flash = null
}
