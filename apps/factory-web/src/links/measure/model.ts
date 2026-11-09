import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import {
  basicProblems,
  FITS,
  fitProblems,
  formProblems,
  hintsOf,
  MEASURE_UNITS,
  PHOTO_VIEWS,
  photoProblems,
  pointProblems,
  walkOrder,
  type MeasureForm,
  type MeasureHint,
  type MeasurePoint,
  type MeasureProblem,
  type MeasureProblemCode,
  type PhotoView,
} from '@nexus/factory-domain/sales/measure-link/rules'
import { issuePath, type ApiError } from '../../lib/api/errors'
import type { LinkState } from '../../shell/links/link-state'
import type { MeasurePage, MeasureSent, PagePoint } from './api'

/**
 * SCR-195 — Send measurements (design links.measure), pure: the six steps (before you start and your data · about you ·
 * measurements · how you like it · photos · check and send), what each step checks (factory-domain sales/measure-link: the
 * same rules as the API), the hints that never block, the draft kept with us, and the API's refusals in our words.
 */

export const STEPS = ['start', 'basics', 'points', 'fit', 'photos', 'review'] as const
export type Step = (typeof STEPS)[number]
export const stepIndex = (step: Step): number => STEPS.indexOf(step)
export const nextOf = (step: Step): Step | null => STEPS[stepIndex(step) + 1] ?? null
export const previousOf = (step: Step): Step | null => STEPS[stepIndex(step) - 1] ?? null

/** About 15 minutes (design sec:intro). */
export const MINUTES = 15

export const EMPTY_FORM: MeasureForm = {
  units: 'cm',
  basics: { height: '', weight: '', age: '' },
  values: {},
  fit: { fit: null, posture: '', asymmetry: '' },
  photos: {},
}

export interface PhotoTile {
  readonly state: 'loading' | 'uploading' | 'ready' | 'failed'
  /** What the page shows (a data address of the photo); null while it is read. */
  readonly src: string | null
}

export type ProblemKey =
  | 'problem.read'
  | 'problem.notice'
  | 'problem.noticeChanged'
  | 'problem.noNotice'
  | 'problem.unavailable'
  | 'problem.internal'
  | 'problem.rateLimited'
  | 'problem.uploadsClosed'
  | 'problem.photosFull'
  | 'problem.fix'
  | 'problem.photosBusy'

export interface DraftState {
  readonly status: SaveStatusState
  /** When the draft this page started from was saved (the "We kept your measurements" banner). */
  readonly restoredAt: string | null
  /** Finish later was pressed and the save went through. */
  readonly later: boolean
}

export interface MeasureViewModel {
  readonly link: LinkState
  readonly page: MeasurePage | null
  readonly problem: ProblemKey | null
  readonly step: Step
  readonly form: MeasureForm
  /** The field problems shown (path → code): a step's on Continue, a field's when it is left. */
  readonly issues: Readonly<Record<string, MeasureProblemCode>>
  readonly notice: 'idle' | 'busy' | 'failed'
  readonly tiles: Partial<Readonly<Record<PhotoView, PhotoTile>>>
  /** The photo sheet open for this view (PhotoCapture). */
  readonly photoFor: PhotoView | null
  /** A made-up photo for the design case of the sheet. */
  readonly photoSample?: { src: string; width: number; height: number } | null
  /** The guide pop-up open for this point (pop:guide). */
  readonly guideFor: string | null
  /** The point with the focus (the counter "Point 9 of 24"); null: none. */
  readonly pointAt: number | null
  readonly typedName: string
  readonly draft: DraftState
  readonly send: 'idle' | 'busy'
  readonly done: MeasureSent | null
  readonly timeZone?: string
}

export interface MeasureActions {
  onRetry?: () => void
  onTick?: () => void
  onNext?: () => void
  onBack?: () => void
  onStep?: (step: Step) => void
  onUnits?: (units: MeasureForm['units']) => void
  onBasic?: (field: keyof MeasureForm['basics'], value: string) => void
  onValue?: (code: string, value: string) => void
  onLeave?: (path: string) => void
  onPointFocus?: (index: number | null) => void
  onFit?: (fit: MeasureForm['fit']['fit']) => void
  onNotes?: (field: 'posture' | 'asymmetry', value: string) => void
  onGuide?: (code: string | null) => void
  onPhotoOpen?: (view: PhotoView | null) => void
  onPhoto?: (view: PhotoView, photo: CapturedPhoto) => void | Promise<void>
  onPhotoRetry?: (view: PhotoView) => void
  onTypedName?: (value: string) => void
  onSend?: () => void
  onSaveRetry?: () => void
  onFinishLater?: () => void
  onDismissRestored?: () => void
  onStartAgain?: () => void
}

// ---- points as the page shows them ---------------------------------------------------------------------------------------

/** The page's points as the domain's (the name in the reader's language). */
export function pointsOf(page: MeasurePage, locale: 'it' | 'en'): Array<MeasurePoint & { zone: PagePoint['zone'] }> {
  return page.points.map((point) => ({ code: point.code, name: point.name[locale], seq: point.seq, required: point.required, minCm: point.minCm, maxCm: point.maxCm, howTo: point.howTo, zone: point.zone }))
}

/** The points in the order Enter walks them (zone by zone). */
export function walkOf(page: MeasurePage, locale: 'it' | 'en') {
  return walkOrder(pointsOf(page, locale))
}

export const fieldId = (path: string): string => `mf-${path.replace(/^body\//, '').replace(/[^A-Za-z0-9_-]+/g, '-')}`

// ---- checks ---------------------------------------------------------------------------------------------------------------

/** The problems of one step (the start: the notice must be ticked). */
export function stepProblems(step: Step, page: MeasurePage, form: MeasureForm, locale: 'it' | 'en'): MeasureProblem[] {
  const points = pointsOf(page, locale)
  switch (step) {
    case 'start':
      return page.noticeRead ? [] : [{ path: 'notice', code: 'REQUIRED', message: '' }]
    case 'basics':
      return basicProblems(form)
    case 'points':
      return pointProblems(form, points)
    case 'fit':
      return fitProblems(form)
    case 'photos':
      return photoProblems(form, page.photos)
    case 'review':
      return [...(page.noticeRead ? [] : [{ path: 'notice', code: 'REQUIRED' as const, message: '' }]), ...formProblems(form, points, page.photos)]
  }
}

/** The step a field belongs to (the API's path). */
export function stepOfPath(path: string): Step {
  if (path === 'notice' || path.startsWith('refusal/')) return 'start'
  if (path.startsWith('body/basics/')) return 'basics'
  if (path.startsWith('body/values/')) return 'points'
  if (path.startsWith('body/fit/')) return 'fit'
  if (path.startsWith('body/photos/')) return 'photos'
  return 'review'
}

/** The first step with something to fix before `upTo` (a step may be chosen only past steps with nothing to fix). */
export function firstBlocked(page: MeasurePage, form: MeasureForm, locale: 'it' | 'en', upTo: Step): Step | null {
  for (const step of STEPS.slice(0, stepIndex(upTo))) if (stepProblems(step, page, form, locale).length > 0) return step
  return null
}

export const issuesOf = (problems: readonly MeasureProblem[]): Record<string, MeasureProblemCode> => Object.fromEntries(problems.map((problem) => [problem.path, problem.code]))

/** The hints of the points typed (never a refusal). */
export function hintsFor(page: MeasurePage, form: MeasureForm, locale: 'it' | 'en'): MeasureHint[] {
  return hintsOf(form, pointsOf(page, locale))
}

export function filled(page: MeasurePage, form: MeasureForm): number {
  return page.points.filter((point) => (form.values[point.code] ?? '').trim() !== '').length
}

/** A photo still on its way: the send waits for it. */
export const photosBusy = (tiles: MeasureViewModel['tiles']): boolean => PHOTO_VIEWS.some((view) => tiles[view]?.state === 'uploading')

/** Something typed or taken: worth keeping (Finish later is held until then). */
export function worthKeeping(form: MeasureForm): boolean {
  return Object.values(form.basics).some((value) => value.trim() !== '') || Object.values(form.values).some((value) => value.trim() !== '') || form.fit.fit !== null || form.fit.posture.trim() !== '' || form.fit.asymmetry.trim() !== '' || Object.keys(form.photos).length > 0
}

// ---- the draft --------------------------------------------------------------------------------------------------------------

/** What is kept with us: the step and the form (the photos as their file ids; never their bytes). */
export function draftDataOf(step: Step, form: MeasureForm): Record<string, unknown> {
  return { v: 1, step, form }
}

const text = (value: unknown, max = 1200): string => (typeof value === 'string' ? value.slice(0, max) : '')

/** The draft made to fit the page as it is now: points gone dropped, unknown values cleared. */
export function formFromDraft(data: Record<string, unknown>, page: MeasurePage): { form: MeasureForm; step: Step } | null {
  if (data.v !== 1 || !data.form || typeof data.form !== 'object') return null
  const raw = data.form as Record<string, any>
  const codes = new Set(page.points.map((point) => point.code))
  const values: Record<string, string> = {}
  for (const [code, value] of Object.entries((raw.values ?? {}) as Record<string, unknown>)) if (codes.has(code) && typeof value === 'string') values[code] = value.slice(0, 12)
  const photos: Partial<Record<PhotoView, string>> = {}
  for (const view of PHOTO_VIEWS) if (typeof raw.photos?.[view] === 'string') photos[view] = raw.photos[view]
  const form: MeasureForm = {
    units: (MEASURE_UNITS as readonly string[]).includes(raw.units) ? raw.units : 'cm',
    basics: { height: text(raw.basics?.height, 12), weight: text(raw.basics?.weight, 12), age: text(raw.basics?.age, 3) },
    values,
    fit: { fit: (FITS as readonly string[]).includes(raw.fit?.fit) ? raw.fit.fit : null, posture: text(raw.fit?.posture), asymmetry: text(raw.fit?.asymmetry) },
    photos,
  }
  const step = (STEPS as readonly string[]).includes(String(data.step)) ? (data.step as Step) : 'start'
  return { form, step: page.noticeRead ? step : 'start' }
}

// ---- the API's refusals in our words ---------------------------------------------------------------------------------------

export interface SendRefusal {
  readonly problem: ProblemKey | null
  readonly issues: Record<string, MeasureProblemCode>
  readonly step: Step | null
  /** 404: the link no longer opens (used, withdrawn, past its day). */
  readonly gone: boolean
  /** Keep the Idempotency-Key for a retry (nothing reached the API, or it failed before answering). */
  readonly keepKey: boolean
}

const REFUSALS: Readonly<Record<string, ProblemKey>> = {
  'refusal/NOTICE_FIRST': 'problem.notice',
  'refusal/NOTICE_CHANGED': 'problem.noticeChanged',
  'refusal/NO_NOTICE': 'problem.noNotice',
  'refusal/PHOTOS_FULL': 'problem.photosFull',
}

/** A refused send (or photo, or tick) → what the page says and where it goes. Never the API's English. */
export function refusalOf(error: Pick<ApiError, 'kind' | 'issues'>): SendRefusal {
  const paths = error.issues.map((issue) => issuePath(issue))
  const refusal = paths.map((path) => REFUSALS[path]).find((key): key is ProblemKey => key !== undefined)
  if (error.kind === 'not_found') return { problem: null, issues: {}, step: null, gone: true, keepKey: false }
  if (refusal) return { problem: refusal, issues: {}, step: refusal === 'problem.photosFull' ? 'photos' : 'start', gone: false, keepKey: false }
  if (error.kind === 'invalid') {
    const fields = paths.filter((path) => path.startsWith('body/'))
    const issues: Record<string, MeasureProblemCode> = {}
    for (const path of fields) issues[path] = path.startsWith('body/photos/') ? 'PHOTO_REQUIRED' : path === 'body/contentType' ? 'NOT_A_NUMBER' : 'OUT_OF_LIMITS'
    const first = fields[0]
    return { problem: 'problem.fix', issues, step: first ? stepOfPath(first) : null, gone: false, keepKey: false }
  }
  if (error.kind === 'unavailable') return { problem: paths.length === 0 ? 'problem.unavailable' : 'problem.uploadsClosed', issues: {}, step: null, gone: false, keepKey: true }
  if (error.kind === 'rate_limited') return { problem: 'problem.rateLimited', issues: {}, step: null, gone: false, keepKey: true }
  return { problem: 'problem.internal', issues: {}, step: null, gone: false, keepKey: true }
}

/** Why Send is held, as a key (null: it may go). */
export function sendHeldKey(model: Pick<MeasureViewModel, 'page' | 'send' | 'tiles'>): string | null {
  if (!model.page?.notice) return 'held.noNotice'
  if (!model.page.noticeRead) return 'held.notice'
  if (model.send === 'busy') return 'send.busy'
  if (photosBusy(model.tiles)) return 'held.photos'
  return null
}
