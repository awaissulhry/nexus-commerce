import { activationProblems, renderLabel, type LabelTemplateFacts, type LabelValues } from '@nexus/factory-domain/compliance/labels/render'
import {
  CARE_CATEGORIES,
  CARE_SYMBOLS,
  LAYOUT_PRESETS,
  LISTED_ONLY_FIELDS,
  printedFields,
  type CareCategory,
  type LabelContent,
  type LabelField,
  type LabelLayout,
  type LayoutPreset,
  type ManufactureDateFormat,
} from '@nexus/factory-domain/compliance/labels/rules'
import { classificationOf } from '@nexus/factory-domain/product/compliance/rules'
import type { PpeCategory, ProductType } from '@nexus/factory-domain/product/styles/rules'
import type { LabelBlock, LabelLayout as SheetLayout, LabelPrintState } from '@nexus/ui/components/LabelPreview/index'
import type { CellValues, ContentPatch, LabelDetail, LabelIssue, LabelTemplate, PrintJob, Rendered } from './api'

/**
 * The rules of Labels & marking (SCR-053), pure — no React, no API client: who may do what, the list's views and tiles,
 * the builder's draft and what Save sends, the browser's own render of a draft being typed (factory-domain renderLabel
 * with the cell values the server rendered with: the same blocks, the same problems), the rendered blocks drawn as the
 * DS LabelPreview's layout with the CE mark, the pictogram and the care symbols as named stand-ins, the rule checks in
 * our words by the field they are about, and the held reasons said before the click.
 */

// ---- rights -------------------------------------------------------------------------------------------------------------------

export interface LabelsCan {
  /** Read labels (the certificate register's view, as the API asks). */
  view: boolean
  /** Create, edit, activate, retire, revise, test-print. */
  manage: boolean
  /** Send a label to a label printer. */
  printLabels: boolean
  /** Read printers and print jobs. */
  printView: boolean
  /** Find styles (a style's label; the preview's colourways and sizes). */
  styles: boolean
  /** Open work orders (the Versions tab's links). */
  workOrders: boolean
}

export function labelsCan(permissions: readonly string[]): LabelsCan {
  const held = new Set(permissions)
  return {
    view: held.has('compliance.certificates.view'),
    manage: held.has('compliance.labels.manage'),
    printLabels: held.has('print.labels'),
    printView: held.has('print.view'),
    styles: held.has('product.styles.view'),
    workOrders: held.has('workorders.view'),
  }
}

// ---- the list -----------------------------------------------------------------------------------------------------------------

/** The live events that change labels (the label builder's, B-W1-19): a hint to read again, never data. */
export const LABEL_EVENTS: readonly string[] = ['compliance.label_template_', 'compliance.label_assigned']

export const LABEL_VIEWS = ['all', 'active', 'drafts', 'retired'] as const
export type LabelView = (typeof LABEL_VIEWS)[number]
/** The tiles: each a saved view (pressing it sets the view: one filter model). */
export const LABEL_TILES = ['active', 'drafts', 'retired'] as const satisfies readonly LabelView[]
/** The list reads at most this many (the API's own cap): beyond it a count is "500+". */
export const LIST_CAP = 500

export function viewOf(value: string | null | undefined): LabelView {
  return (LABEL_VIEWS as readonly string[]).includes(value ?? '') ? (value as LabelView) : 'all'
}

const VIEW_STATUS: Record<Exclude<LabelView, 'all'>, LabelTemplate['status']> = { active: 'ACTIVE', drafts: 'DRAFT', retired: 'RETIRED' }

/** The rows a view shows, searched over code, name, style and maker. */
export function viewRows(rows: readonly LabelTemplate[], view: LabelView, query: string): LabelTemplate[] {
  const words = query.trim().toLowerCase()
  return rows.filter((row) => {
    if (view !== 'all' && row.status !== VIEW_STATUS[view]) return false
    if (!words) return true
    return [row.code, row.name, row.style?.code ?? '', row.style?.name ?? '', row.makerName].some((text) => text.toLowerCase().includes(words))
  })
}

export interface TileCount {
  /** null: unknown ("—"); undefined: being read. */
  count: number | null | undefined
  atLeast: boolean
}

export function tileCounts(rows: readonly LabelTemplate[] | null, failed: boolean): Record<(typeof LABEL_TILES)[number], TileCount> {
  const count = (view: Exclude<LabelView, 'all'>): TileCount =>
    failed ? { count: null, atLeast: false } : rows === null ? { count: undefined, atLeast: false } : { count: rows.filter((row) => row.status === VIEW_STATUS[view]).length, atLeast: rows.length >= LIST_CAP }
  return { active: count('active'), drafts: count('drafts'), retired: count('retired') }
}

export const STATUS_TONE: Record<LabelTemplate['status'], 'success' | 'info' | 'neutral'> = { ACTIVE: 'success', DRAFT: 'info', RETIRED: 'neutral' }

/** Hundredths-free millimetres for a person: "50 × 80 mm" from "50.00" and "80.00". */
export const mmWords = (value: string): string => value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')

/** The address of a label's record (a tab, an action to open there). */
export const labelHref = (prefix: string, templateId: string, query = ''): string => `${prefix}/compliance/labels/${encodeURIComponent(templateId)}${query ? `?${query}` : ''}`

/** One CSV row per label: the codes and values as the API gave them; words through the screen's catalogue. */
export function labelsCsvRows(rows: readonly LabelTemplate[], header: readonly string[], words: { status: (row: LabelTemplate) => string; shared: string }): (string | number | null)[][] {
  return [
    [...header],
    ...rows.map((row) => [row.code, row.revision, row.name, row.style?.code ?? words.shared, row.languages.join(' '), row.makerName, words.status(row), mmWords(row.widthMm), mmWords(row.heightMm), row.problems.length, row.updatedAt.slice(0, 10)]),
  ]
}

/** A newer draft of the same code (a code has one draft at a time): its revision, else null. */
export function draftRevisionOf(detail: Pick<LabelDetail, 'revisions' | 'id'>): number | null {
  return detail.revisions.find((entry) => entry.status === 'DRAFT' && entry.id !== detail.id)?.revision ?? null
}

/** The newest revision of the code. */
export const newestRevision = (detail: Pick<LabelDetail, 'revisions' | 'revision'>): number => Math.max(detail.revision, ...detail.revisions.map((entry) => entry.revision))

// ---- the builder's draft ------------------------------------------------------------------------------------------------------

export interface FibreDraft {
  fibre: string
  percent: string
}
export interface PartDraft {
  part: string
  fibres: FibreDraft[]
}
export interface CareDraft {
  symbol: string
  /** Text per printed language; empty: the symbol only. */
  text: Record<string, string>
}

/** What the builder's form holds while a draft is edited (strings as typed; '' clears an optional field). */
export interface LabelDraft {
  name: string
  languages: string[]
  makerName: string
  makerAddress: string
  importerName: string
  importerAddress: string
  composition: PartDraft[]
  animalOriginPhrase: boolean
  animalOriginTexts: Record<string, string>
  care: CareDraft[]
  preset: LayoutPreset
  fields: LabelField[]
  manufactureDate: ManufactureDateFormat
  notifiedBodyNumber: string
  widthMm: string
  heightMm: string
}

export function draftOf(template: LabelTemplate): LabelDraft {
  return {
    name: template.name,
    languages: [...template.languages],
    makerName: template.makerName,
    makerAddress: template.makerAddress,
    importerName: template.importerName ?? '',
    importerAddress: template.importerAddress ?? '',
    composition: template.composition.map((part) => ({ part: part.part, fibres: part.fibres.map((fibre) => ({ ...fibre })) })),
    animalOriginPhrase: template.animalOriginPhrase,
    animalOriginTexts: { ...template.layout.texts.animalOrigin },
    care: template.care.map((entry) => ({ symbol: entry.symbol, text: { ...(entry.text ?? {}) } })),
    preset: template.layout.preset,
    fields: [...template.layout.fields],
    manufactureDate: template.layout.manufactureDate,
    notifiedBodyNumber: template.layout.notifiedBodyNumber ?? '',
    widthMm: mmWords(template.widthMm),
    heightMm: mmWords(template.heightMm),
  }
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The decimal comma people type ("50,5") as the API's point. */
export const mmTyped = (value: string): string => value.trim().replace(',', '.')

const textsOf = (texts: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(texts).flatMap(([language, text]) => (text.trim() ? [[language, text.trim()]] : [])))

/** The draft as the API's content (what Save sends when it changed, and what the browser renders). */
export function contentOf(draft: LabelDraft): Pick<LabelTemplate, 'name' | 'languages' | 'makerName' | 'makerAddress' | 'importerName' | 'importerAddress' | 'composition' | 'animalOriginPhrase' | 'care' | 'layout' | 'widthMm' | 'heightMm'> {
  const layout: LabelLayout = {
    preset: draft.preset,
    fields: [...draft.fields],
    notifiedBodyNumber: orNull(draft.notifiedBodyNumber),
    manufactureDate: draft.manufactureDate,
    texts: { animalOrigin: textsOf(draft.animalOriginTexts) },
  }
  return {
    name: draft.name.trim(),
    languages: [...draft.languages],
    makerName: draft.makerName.trim(),
    makerAddress: draft.makerAddress.trim(),
    importerName: orNull(draft.importerName),
    importerAddress: orNull(draft.importerAddress),
    composition: draft.composition.map((part) => ({ part: part.part.trim(), fibres: part.fibres.map((fibre) => ({ fibre: fibre.fibre.trim(), percent: fibre.percent.trim().replace(',', '.') })) })),
    animalOriginPhrase: draft.animalOriginPhrase,
    care: draft.care.map((entry) => {
      const text = textsOf(entry.text)
      return Object.keys(text).length > 0 ? { symbol: entry.symbol, text } : { symbol: entry.symbol }
    }),
    layout,
    widthMm: mmTyped(draft.widthMm),
    heightMm: mmTyped(draft.heightMm),
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What Save sends: only the fields that changed (a millimetre written "50" or "50.00" is the same size). */
export function patchOf(template: LabelTemplate, draft: LabelDraft): ContentPatch {
  const next = contentOf(draft)
  const now = contentOf(draftOf(template))
  const patch: ContentPatch = {}
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    if (!same(next[key], now[key])) (patch as Record<string, unknown>)[key] = next[key]
  }
  return patch
}

export const isDirty = (template: LabelTemplate, draft: LabelDraft | null): boolean => draft !== null && Object.keys(patchOf(template, draft)).length > 0

/** The draft as the domain's renderer reads a template. */
export function factsOf(template: LabelTemplate, draft: LabelDraft): LabelTemplateFacts {
  const content = contentOf(draft)
  return {
    id: template.id,
    code: template.code,
    revision: template.revision,
    status: template.status,
    styleId: template.styleId,
    companyId: template.companyId,
    storedProblems: [],
    makerPartyId: template.makerPartyId,
    ...(content as Omit<LabelContent, 'makerPartyId'>),
  }
}

/** The server's cell values as the renderer's (a SAMPLE: no batch or serial, no date of manufacture). */
export function valuesOf(values: CellValues): LabelValues {
  return {
    style: { ...values.style, productType: values.style.productType as ProductType, ppeCategory: values.style.ppeCategory as PpeCategory },
    colourway: values.colourway,
    size: values.size,
    certificate: values.certificate,
    identification: { kind: values.identification.kind, value: null, recordType: null, recordId: null, reference: null },
    manufactured: null,
    date: values.date,
    sample: true,
    marketLanguages: values.marketLanguages,
  }
}

/**
 * The draft rendered in the browser, as it is typed: factory-domain's renderLabel with the values the server rendered the
 * cell with (the API's PG test holds that the two agree for saved content). Null without those values.
 */
export function localRender(template: LabelTemplate, draft: LabelDraft, values: CellValues | null): Rendered | null {
  if (!values) return null
  const label = renderLabel(factsOf(template, draft), valuesOf(values))
  return JSON.parse(JSON.stringify(label)) as Rendered
}

/** What would keep the draft from ACTIVE as typed (the API's own activation check, run on this page). */
export function localActivation(template: LabelTemplate, draft: LabelDraft, values: CellValues | null, today: string): LabelIssue[] {
  const style = template.styleId && values && values.style.id === template.styleId ? valuesOf(values).style : null
  if (template.styleId && !style) return template.problems
  return activationProblems(factsOf(template, draft), style ? { ...style, companyId: values!.style.companyId } : null, today).map((issue) => ({ ...issue }))
}

// ---- printed fields and their order ---------------------------------------------------------------------------------------------

/** Whether the label's style is PPE (a shared label is checked as a PPE garment's). */
export const isPpeLabel = (template: Pick<LabelTemplate, 'style'>): boolean => (template.style ? template.style.ppeCategory !== 'NOT_PPE' : true)

/** The fields the draft prints, in order (the layout's first, then the others it prints). */
export function printedOrder(draft: LabelDraft, ppe: boolean): LabelField[] {
  const content = contentOf(draft)
  return printedFields({ layout: content.layout, importerName: content.importerName, composition: content.composition, animalOriginPhrase: content.animalOriginPhrase, care: content.care }, ppe)
}

/** Moves a printed field one place up or down: the layout then lists the whole printed order. */
export function moveField(draft: LabelDraft, ppe: boolean, field: LabelField, step: -1 | 1): LabelField[] {
  const order = printedOrder(draft, ppe)
  const at = order.indexOf(field)
  const to = at + step
  if (at < 0 || to < 0 || to >= order.length) return draft.fields
  const next = [...order]
  next[at] = order[to]!
  next[to] = field
  return next
}

/** The fields printed only when the layout lists them (the class in words, the colourway; body measures off PPE). */
export function optionalFields(ppe: boolean): LabelField[] {
  return ppe ? [...LISTED_ONLY_FIELDS] : [...LISTED_ONLY_FIELDS.filter((field) => field !== 'class'), 'bodyMeasures']
}

export function toggleField(draft: LabelDraft, field: LabelField, on: boolean): LabelField[] {
  const listed = draft.fields.filter((entry) => entry !== field)
  return on ? [...listed, field] : listed
}

/** Care symbols of one kind (ISO 3758), for the builder's choice per kind. */
export function careChoices(category: CareCategory): { code: string; words: string; mark: string }[] {
  return Object.entries(CARE_SYMBOLS)
    .filter(([, symbol]) => symbol.category === category)
    .map(([code, symbol]) => ({ code, words: symbol.words, mark: symbol.mark }))
}

export const CARE_KINDS: readonly CareCategory[] = CARE_CATEGORIES

/** The draft's care symbol of a kind, or null. */
export const careOfKind = (draft: LabelDraft, category: CareCategory): CareDraft | null => draft.care.find((entry) => CARE_SYMBOLS[entry.symbol]?.category === category) ?? null

/** Sets (or clears, symbol null) the care symbol of a kind: one per kind, in the kinds' order. */
export function setCare(draft: LabelDraft, category: CareCategory, symbol: string | null): CareDraft[] {
  const kept = draft.care.filter((entry) => CARE_SYMBOLS[entry.symbol]?.category !== category)
  const before = careOfKind(draft, category)
  const next = symbol ? [...kept, { symbol, text: before?.text ?? {} }] : kept
  const order = new Map(CARE_CATEGORIES.map((entry, index) => [entry, index]))
  return next.sort((a, b) => (order.get(CARE_SYMBOLS[a.symbol]?.category ?? 'WASH') ?? 0) - (order.get(CARE_SYMBOLS[b.symbol]?.category ?? 'WASH') ?? 0))
}

/** The fibres of a part as a person reads their sum ("80 + 20 = 100 %"): null when a share is not a number. */
export function partSum(part: PartDraft): number | null {
  let sum = 0
  for (const fibre of part.fibres) {
    const value = Number(fibre.percent.trim().replace(',', '.'))
    if (fibre.percent.trim() === '' || !Number.isFinite(value)) return null
    sum += value
  }
  return Math.round(sum * 100) / 100
}

/** Language codes typed or pasted ("de, fr IT") as the label's list: lower case, unique, at most 8. */
export function languagesTyped(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ''))].slice(0, 8)
}

// ---- the rendered label as the DS sheet --------------------------------------------------------------------------------------------

/** A stand-in mark on the sheet: what it stands for, drawn as words in a dashed box (never the artwork). */
export interface StandIn {
  kind: 'ce' | 'pictogram' | 'care'
  /** The care symbol's stand-in letters ("W40"), the pictogram's standard and class, the CE's notified body. */
  text: string
  /** The words a screen reader reads (the care symbol's meaning; the stand-in words for the rest). */
  words: string
}

export interface Sheet {
  layout: SheetLayout
  /** The stand-ins by mark id (renderMark draws them). */
  marks: Record<string, StandIn>
}

const mm = (hundredths: number): number => Math.round(hundredths) / 100

/**
 * The rendered blocks as the DS LabelPreview's layout, to scale: the SAMPLE banner first, then each field's drawn element
 * (the CE mark, the pictogram, the care symbols: stand-ins named as such; the batch or serial as Code 128 bars when there
 * is a value) and its printed lines, as the printer wraps them.
 */
export function sheetOf(label: Rendered, widthMm: number, heightMm: number, words: { name: string; ce: string; pictogram: (standard: string, ppeClass: string) => string; care: (symbolWords: string) => string; test?: string | null }): Sheet {
  const preset = LAYOUT_PRESETS[label.preset]
  const blocks: LabelBlock[] = []
  const marks: Record<string, StandIn> = {}
  if (words.test) blocks.push({ kind: 'text', text: words.test, size: 'sm', bold: true, align: 'center' })
  for (const line of label.banner) blocks.push({ kind: 'text', text: line, size: 'sm', bold: true, align: 'center' })
  if (label.banner.length > 0 || words.test) blocks.push({ kind: 'rule' })
  for (const block of label.blocks) {
    const graphic = block.graphic
    if (graphic?.kind === 'CE') {
      const id = `ce:${blocks.length}`
      marks[id] = { kind: 'ce', text: graphic.notifiedBodyNumber ?? '', words: words.ce }
      blocks.push({ kind: 'row', blocks: [{ kind: 'mark', id, label: words.ce, sizeMm: mm(preset.ce) }, ...(graphic.notifiedBodyNumber ? [{ kind: 'text' as const, text: graphic.notifiedBodyNumber, size: 'md' as const, bold: true }] : [])] })
    } else if (graphic?.kind === 'PICTOGRAM') {
      const id = `pictogram:${blocks.length}`
      const said = words.pictogram(graphic.standardCode ?? '', graphic.ppeClass ?? '')
      marks[id] = { kind: 'pictogram', text: [graphic.standardCode, graphic.ppeClass].filter(Boolean).join(' '), words: said }
      blocks.push({ kind: 'row', blocks: [{ kind: 'mark', id, label: said, sizeMm: mm(preset.pictogram) }, ...(graphic.ppeClass ? [{ kind: 'text' as const, text: graphic.ppeClass, size: 'xl' as const, bold: true }] : [])] })
    } else if (graphic?.kind === 'CARE' && graphic.symbols.length > 0) {
      blocks.push({
        kind: 'row',
        blocks: graphic.symbols.map((symbol, index) => {
          const id = `care:${blocks.length}:${index}`
          marks[id] = { kind: 'care', text: symbol.mark, words: words.care(symbol.words) }
          return { kind: 'mark' as const, id, label: words.care(symbol.words), sizeMm: mm(preset.care) }
        }),
      })
    } else if (graphic?.kind === 'BARCODE' && graphic.value) {
      blocks.push({ kind: 'barcode', value: graphic.value, heightMm: mm(preset.barcode) * 0.6, showText: false })
    }
    for (const line of block.lines) blocks.push({ kind: 'text', text: line.text, size: 'sm', bold: block.field === 'model' || block.field === 'size' })
  }
  return { layout: { name: words.name, widthMm, heightMm, paddingMm: mm(preset.margin), blocks }, marks }
}

/** A size written "50" or "50.5" as a number for the sheet; the defaults when it is not readable. */
export function sheetSize(value: string, fallback: number): number {
  const number = Number(mmTyped(value))
  return Number.isFinite(number) && number >= 20 && number <= 300 ? number : fallback
}

// ---- the rule checks in our words ------------------------------------------------------------------------------------------------

export const CHECK_FAMILIES = ['name', 'languages', 'maker', 'importer', 'composition', 'animalOrigin', 'care', 'notifiedBody', 'layout', 'size', 'style', 'certificate', 'class', 'bodyMeasures', 'batch', 'status', 'other'] as const
export type CheckFamily = (typeof CHECK_FAMILIES)[number]

/** Which part of the label a problem is about, by its path (the field the line points to). */
export function familyOf(path: string): CheckFamily {
  const head = path.replace(/^body\//, '')
  if (head === 'name') return 'name'
  if (head.startsWith('languages')) return 'languages'
  if (head.startsWith('maker')) return 'maker'
  if (head.startsWith('importer')) return 'importer'
  if (head.startsWith('composition')) return 'composition'
  if (head.startsWith('layout/texts/animalOrigin')) return 'animalOrigin'
  if (head.startsWith('care')) return 'care'
  if (head === 'layout/notifiedBodyNumber') return 'notifiedBody'
  if (head.startsWith('layout')) return 'layout'
  if (head === 'widthMm' || head === 'heightMm') return 'size'
  if (head.startsWith('style')) return 'style'
  if (head === 'certificate') return 'certificate'
  if (head === 'pictogram') return 'class'
  if (head === 'bodyMeasures') return 'bodyMeasures'
  if (head === 'batchOrSerial') return 'batch'
  if (head === 'status') return 'status'
  return 'other'
}

/** The builder's section a family points to (an anchor on the page), or null when it is about another record. */
export function sectionOf(family: CheckFamily): string | null {
  switch (family) {
    case 'name':
    case 'languages':
      return 'lb-sec-general'
    case 'maker':
    case 'importer':
      return 'lb-sec-maker'
    case 'composition':
    case 'animalOrigin':
      return 'lb-sec-composition'
    case 'care':
      return 'lb-sec-care'
    case 'notifiedBody':
    case 'layout':
    case 'size':
      return 'lb-sec-layout'
    default:
      return null
  }
}

export interface CheckRow {
  id: string
  family: CheckFamily
  /** The API's sentence (English, the domain's words): data shown under our words. */
  message: string
  section: string | null
  blocking: boolean
}

/** Problems (they stop the activation) then warnings (noted), each with its family and where to fix it. */
export function checkRows(problems: readonly LabelIssue[], warnings: readonly LabelIssue[]): CheckRow[] {
  const row = (issue: LabelIssue, index: number, blocking: boolean): CheckRow => {
    const family = familyOf(issue.path)
    return { id: `${blocking ? 'p' : 'w'}${index}:${issue.path}`, family, message: issue.message, section: sectionOf(family), blocking }
  }
  return [...problems.map((issue, index) => row(issue, index, true)), ...warnings.map((issue, index) => row(issue, index, false))]
}

/** The families every PPE label is checked for, in the builder's order: a family without a problem shows as passed. */
export const PASSED_FAMILIES: readonly CheckFamily[] = ['name', 'languages', 'maker', 'importer', 'composition', 'animalOrigin', 'care', 'notifiedBody', 'size', 'style']

// ---- held reasons ------------------------------------------------------------------------------------------------------------------

export interface Held {
  key: string
  params?: Record<string, string | number>
}

export function activateHeld(detail: LabelDetail, can: LabelsCan, problems: number, dirty: boolean): Held | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (detail.status !== 'DRAFT') return { key: 'held.notDraft' }
  if (dirty) return { key: 'held.unsaved' }
  if (problems > 0) return { key: 'held.problems', params: { count: problems } }
  return null
}

export function reviseHeld(detail: LabelDetail, can: LabelsCan): Held | null {
  if (!can.manage) return { key: 'held.noManage' }
  const draft = draftRevisionOf(detail)
  if (draft !== null) return { key: 'held.draftExists', params: { revision: draft } }
  if (detail.status === 'DRAFT') return { key: 'held.isDraft' }
  return null
}

export function retireHeld(detail: LabelDetail, can: LabelsCan): Held | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (detail.status === 'RETIRED') return { key: 'held.retired' }
  return null
}

export function testPrintHeld(can: LabelsCan, printers: readonly unknown[] | null): Held | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (!can.printLabels) return { key: 'held.noPrint' }
  if (printers !== null && printers.length === 0) return { key: 'held.noPrinter' }
  return null
}

export function saveHeld(can: LabelsCan, dirty: boolean, busy: boolean): Held | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (busy) return { key: 'held.busy' }
  if (!dirty) return { key: 'held.nothing' }
  return null
}

// ---- the new-label dialog ----------------------------------------------------------------------------------------------------------

export interface NewLabelDraft {
  /** A style's own label, or shared by several styles (then the code is typed). */
  kind: 'style' | 'shared'
  style: { id: string; code: string; name: string } | null
  code: string
  /** Start from another label's content (any revision), or the defaults. */
  fromTemplateId: string | null
  languages: string[]
  widthMm: string
  heightMm: string
}

export const NEW_LABEL: NewLabelDraft = { kind: 'style', style: null, code: '', fromTemplateId: null, languages: ['it', 'en'], widthMm: '50', heightMm: '80' }

const LABEL_CODE = /^[A-Z0-9](?:[A-Z0-9._-]{0,30}[A-Z0-9])?$/

export function newLabelHeld(draft: NewLabelDraft, can: LabelsCan, busy: boolean): Held | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (draft.kind === 'style' && !draft.style) return { key: 'held.pickStyle' }
  if (draft.kind === 'shared' && !LABEL_CODE.test(draft.code.trim().toUpperCase())) return { key: 'held.code' }
  if (draft.kind === 'style' && draft.code.trim() !== '' && !LABEL_CODE.test(draft.code.trim().toUpperCase())) return { key: 'held.code' }
  if (draft.languages.length === 0) return { key: 'held.languages' }
  const width = Number(mmTyped(draft.widthMm))
  const height = Number(mmTyped(draft.heightMm))
  if (!(width >= 20 && width <= 150) || !(height >= 20 && height <= 300)) return { key: 'held.size' }
  if (busy) return { key: 'held.busy' }
  return null
}

// ---- print jobs ------------------------------------------------------------------------------------------------------------------

/** A print job as the DS sheet's print state (words from the screen's catalogue). */
export function printStateOf(job: PrintJob, words: (status: PrintJob['status']) => string, detail: string | undefined): LabelPrintState {
  return { status: job.status.toLowerCase() as LabelPrintState['status'], label: words(job.status), detail }
}

/** Keep asking about a job until it is printed or failed. */
export const jobSettled = (job: PrintJob | null): boolean => job !== null && (job.status === 'PRINTED' || job.status === 'FAILED')

// ---- PPE words -------------------------------------------------------------------------------------------------------------------

/** The style's classification as the label marks it ("EN 17092-3:2020 · AA"). */
export function classWords(style: LabelTemplate['style']): string | null {
  if (!style) return null
  if (style.ppeCategory === 'NOT_PPE') return null
  const facts = classificationOf({ id: style.id, code: style.code, productType: 'JACKET', ppeCategory: style.ppeCategory as PpeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass, brandPartyId: null })
  return [style.ppeStandard, facts.ppeClass ?? facts.partClass].filter(Boolean).join(' · ') || null
}
