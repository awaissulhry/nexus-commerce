import type { LabelLayout, LabelPrintState } from '@nexus/ui/components/LabelPreview/index'
import { MACHINE_DEPTH_REFUSALS } from '@nexus/factory-domain/plant/machines/status'
import { minutesByStatus, statusDays, statusSpans, type StatusSpan } from '@nexus/factory-domain/plant/machines/history'
import { isApiError } from '../../../../lib/api/errors'
import type { Machine, MachineStatus } from '../../_shared/api'
import { MACHINE_TONE, problemOf, type Tone, type Words } from '../../_shared/model'
import type { DocumentGroup, HistoryAnswer, MachineDepth, MachineDocument, PrintState, Settable, TagJob, WallAnswer, WallTile } from './api'

/**
 * The pure rules of machines in depth (B-W2b-136) the screens share: the page's own address terms (the section — Machines,
 * Clicking dies, Status wall — and the two tiles that are filters), the words of a next check, a tag's print state and a
 * document group, when Change status is held and why, the week a status history shows cut day by day, the wall's
 * filter, a refusal said in our words, and the tag's label to scale. Nothing here fetches.
 */

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

// ---- the page's own address terms ------------------------------------------------------------------------------------------

export const SECTIONS = ['machines', 'dies', 'wall'] as const
export type Section = (typeof SECTIONS)[number]
export const NEED_TERMS = { ce: 'CE', checks: 'CHECKS' } as const
export type NeedTerm = keyof typeof NEED_TERMS

export interface DepthAddress {
  section: Section
  need: NeedTerm | null
}

interface ParamsLike {
  get(name: string): string | null
}

export function depthAddressOf(params: ParamsLike | null): DepthAddress {
  const section = params?.get('section') ?? ''
  const need = params?.get('need') ?? ''
  return { section: (SECTIONS as readonly string[]).includes(section) ? (section as Section) : 'machines', need: need in NEED_TERMS ? (need as NeedTerm) : null }
}

/** The W2a address text (`?view=…`) with this step's terms added; the other terms of the address (the dies') are kept by the caller. */
export function withDepthTerms(base: string, depth: DepthAddress): string {
  const query = new URLSearchParams(base.startsWith('?') ? base.slice(1) : base)
  if (depth.section !== 'machines') query.set('section', depth.section)
  if (depth.need) query.set('need', depth.need)
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** Every term of the current address that is neither W2a's nor this step's (the dies' own `d…` terms): kept as they are. */
export function otherTerms(params: ParamsLike & { forEach?: (fn: (value: string, key: string) => void) => void }, own: readonly string[]): [string, string][] {
  const out: [string, string][] = []
  params.forEach?.((value, key) => {
    if (!own.includes(key)) out.push([key, value])
  })
  return out
}

export const PAGE_TERMS = ['view', 'q', 'site', 'class', 'new', 'section', 'need'] as const

// ---- the register's columns ------------------------------------------------------------------------------------------------

export const DUE_TONE: Readonly<Record<'OVERDUE' | 'DUE_SOON' | 'PLANNED' | 'ENDED', Tone>> = { OVERDUE: 'danger', DUE_SOON: 'warning', PLANNED: 'neutral', ENDED: 'neutral' }
export const PRINT_TONE: Readonly<Record<PrintState, Tone>> = { QUEUED: 'info', SENT: 'info', PRINTED: 'success', FAILED: 'danger' }

/** The words of a machine's next check: "Press guards · 12 Dec 2026" with its state. */
export function nextCheckWords(t: Translate, depth: Pick<MachineDepth, 'nextCheck'> | null | undefined, formatDay: (day: string) => string, labelOf: (worded: { labelIt: string; labelEn: string; labelI18n: Record<string, string> }) => string): { text: string; state: keyof typeof DUE_TONE | null } {
  const check = depth?.nextCheck
  if (!check) return { text: t('depth.noCheck'), state: null }
  const when = formatDay(check.nextDueOn)
  const key = check.state === 'OVERDUE' ? 'depth.checkOverdue' : check.state === 'DUE_SOON' ? 'depth.checkSoon' : 'depth.checkPlanned'
  return { text: t(key, { check: labelOf(check.checkType), date: when, days: Math.abs(check.days) }), state: check.state }
}

/** The tag column: never sent, or the newest job's state (printed on a day). */
export function tagWords(t: Translate, depth: Pick<MachineDepth, 'tag'> | null | undefined, formatDay: (instant: string) => string): { text: string; tone: Tone } {
  const tag = depth?.tag
  if (!tag) return { text: t('depth.tagNever'), tone: 'neutral' }
  if (tag.state === 'PRINTED' && tag.printedAt) return { text: t('depth.tagPrintedOn', { date: formatDay(tag.printedAt) }), tone: 'success' }
  return { text: t(`printState.${tag.state}`), tone: PRINT_TONE[tag.state] }
}

/** The DS LabelPreview's print state from a tag job. */
export function printStateOf(t: Translate, job: Pick<TagJob, 'state' | 'printerCode' | 'lastError'> | null, at?: string): LabelPrintState | undefined {
  if (!job) return undefined
  const status = job.state === 'QUEUED' ? 'queued' : job.state === 'SENT' ? 'sent' : job.state === 'PRINTED' ? 'printed' : 'failed'
  return { status, label: t(`printState.${job.state}`), detail: job.state === 'FAILED' ? t('tags.failedDetail', { printer: job.printerCode }) : t('tags.onPrinter', { printer: job.printerCode, at: at ?? '' }) }
}

// ---- documents -------------------------------------------------------------------------------------------------------------

export const GROUP_ORDER: readonly DocumentGroup[] = ['MACHINE_CE', 'MANUAL', 'PHOTO', 'OTHER']

export function documentsByGroup(documents: readonly MachineDocument[]): { group: DocumentGroup; documents: MachineDocument[] }[] {
  return GROUP_ORDER.map((group) => ({ group, documents: documents.filter((document) => document.group === group) }))
}

/** What a picked file may be filed as (a photo is never a CE declaration or a manual). */
export function groupHeld(group: DocumentGroup, contentType: string): string | null {
  const image = contentType.startsWith('image/')
  if (group === 'MANUAL' && image) return 'docs.held.manualPdf'
  if (group === 'PHOTO' && !image) return 'docs.held.photoImage'
  return null
}

export const isPdf = (document: Pick<MachineDocument, 'contentType'>): boolean => document.contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf'
export const isImage = (document: Pick<MachineDocument, 'contentType'>): boolean => document.contentType.startsWith('image/')

/** "1.2 MB" / "820 KB". */
export function sizeWords(bytes: number, locale: string): string {
  const format = (value: number, digits: number) => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: digits }).format(value)
  if (bytes >= 1_048_576) return `${format(bytes / 1_048_576, 1)} MB`
  return `${format(Math.max(1, Math.round(bytes / 1024)), 0)} KB`
}

// ---- Change status ---------------------------------------------------------------------------------------------------------

export interface StatusDraft {
  to: Settable | null
  reason: string
}

export const releases = (from: MachineStatus, to: Settable | null): boolean => from === 'DO_NOT_USE' && to !== null && to !== 'DO_NOT_USE'

/** Why the dialog's Change status is held (a message key), or null. */
export function statusHeld(machine: Pick<Machine, 'status' | 'locked'>, draft: StatusDraft, can: { manage: boolean; signSafe: boolean }, busy: boolean): string | null {
  if (!can.manage) return 'held.noManage'
  if (machine.status === 'RETIRED') return 'held.retired'
  if (machine.locked) return 'held.locked'
  if (!draft.to) return 'held.pickStatus'
  if (draft.to === machine.status) return 'held.sameStatus'
  if (releases(machine.status, draft.to) && !can.signSafe) return 'held.technician'
  if (draft.reason.trim().length < 3) return 'held.reason'
  if (busy) return 'held.busy'
  return null
}

/** Why the record's Change status is held before the dialog opens, or null. */
export function changeHeld(machine: Pick<Machine, 'status' | 'locked'>, can: { manage: boolean }): string | null {
  if (!can.manage) return 'held.noManage'
  if (machine.status === 'RETIRED') return 'held.retired'
  if (machine.locked) return 'held.locked'
  return null
}

// ---- the status history ------------------------------------------------------------------------------------------------------

/** The Monday of the week a day is in (`YYYY-MM-DD`). */
export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  const back = (date.getUTCDay() + 6) % 7
  return new Date(date.getTime() - back * 86_400_000).toISOString().slice(0, 10)
}

export const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)

export const STATUS_TONE: Readonly<Record<MachineStatus, Tone>> = MACHINE_TONE

export interface HistoryDay {
  date: string
  from: string
  to: string
  spans: readonly StatusSpan[]
}

/** The window's spans and the days they fall on (in the site's zone), and the minutes in each status. */
export function historyOf(answer: HistoryAnswer, first: string, days: number, timeZone: string): { days: HistoryDay[]; minutes: Partial<Record<MachineStatus, number>> } {
  const spans = statusSpans({ from: answer.from, to: answer.to, now: answer.now, registeredAt: answer.registeredAt, before: answer.before, current: answer.current, events: answer.events })
  return { days: statusDays(spans, first, days, timeZone), minutes: minutesByStatus(spans) }
}

/** The order a status is said in a summary. */
export const STATUS_ORDER: readonly MachineStatus[] = ['RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE', 'RETIRED']

// ---- the status wall ---------------------------------------------------------------------------------------------------------

export const WALL_FILTERS = ['ALL', 'NOT_RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE'] as const
export type WallFilter = (typeof WALL_FILTERS)[number]

export function wallTilesOf(lines: WallAnswer['lines'], filter: WallFilter): WallAnswer['lines'] {
  const keep = (tile: WallTile) => (filter === 'ALL' ? true : filter === 'NOT_RUNNING' ? tile.status !== 'RUNNING' : tile.status === filter)
  return lines.map((line) => ({ ...line, machines: line.machines.filter(keep) })).filter((line) => line.machines.length > 0)
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------

/** The words of a failed call of this step: its own refusals by code, else the plant's words. */
export function depthProblemOf(error: unknown): Words {
  if (isApiError(error)) {
    for (const issue of error.issues) {
      const path = String((issue as { path?: unknown }).path ?? '')
      if (!path.startsWith('refusal/')) continue
      const code = path.slice('refusal/'.length)
      if ((MACHINE_DEPTH_REFUSALS as readonly string[]).includes(code)) return { key: `depth:refusal.${code}` }
    }
  }
  return problemOf(error)
}

// ---- the tag -----------------------------------------------------------------------------------------------------------------

/** The tag to scale (the label printers' 100 × 50 mm stock unless a printer says otherwise): QR + asset number + where. */
export function tagLayout(t: Translate, machine: { assetNumber: string; typeWords: string; placeWords: string }, stock: { widthMm: number; heightMm: number } = { widthMm: 100, heightMm: 50 }): LabelLayout {
  return {
    name: t('tags.labelName', { machine: machine.assetNumber }),
    widthMm: stock.widthMm,
    heightMm: stock.heightMm,
    blocks: [
      {
        kind: 'row',
        blocks: [
          { kind: 'qr', value: machine.assetNumber, sizeMm: Math.min(30, stock.heightMm - 16) },
          { kind: 'fields', columns: 1, fields: [{ label: t('tags.labelAsset'), value: machine.assetNumber, size: 'xl' }, { label: t('tags.labelType'), value: machine.typeWords, size: 'sm' }, { label: t('tags.labelPlace'), value: machine.placeWords, size: 'sm' }] },
        ],
      },
      { kind: 'fill' },
      { kind: 'text', text: t('tags.scan'), size: 'sm', bold: true },
    ],
  }
}
