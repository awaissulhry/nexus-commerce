import { surchargeText, type Surcharge } from '../../../../products/options/model'
import type { Chosen, CheckAnswer, LineConfigurator, OptionGroupView, OptionValueView, PickBody, StyleConfigurator, Words2 } from './api'

/**
 * The configurator's rules without a screen (B-W2b-340; SAL-133, SAL-136, SAL-139, SAL-140): the person's draft of the
 * picks, what a click on a value does (one value of a SINGLE group, any of a MULTI), the body the API takes, whether the
 * draft differs from what is saved, why Save is held, and the words of a surcharge — the options area's surchargeText (ONE
 * place, CF1:02). Prices are never computed here: the live price is the API's check of the draft (B-W2b-330's waterfall).
 */

export const CONFIGURATOR_NS = 'sales-configurator'

/** Words of this catalogue, or { it, en } words the API gives (a rule, a check, a refusal). */
export type Say = { key: string; params?: Record<string, string | number> } | { words: Words2 }
export type Tone = 'info' | 'success' | 'warning' | 'danger'

/** A value in the person's draft: its text, a library colour OR a material and its colour (SAL-139). */
export interface DraftPick {
  valueId: string
  groupId: string
  text: string
  /** Taken from the style's default (nothing of the group chosen): not sent, the API takes it again. */
  byDefault: boolean
  colourId: string | null
  itemId: string | null
  itemColourId: string | null
}

/** The artwork a line takes (the API's rule, said before the upload). */
export const ARTWORK_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export const ARTWORK_MAX_BYTES = 25 * 1024 * 1024

export const nameIn = (entry: { name: string; nameI18n: Record<string, string> | null }, lang: 'it' | 'en'): string => entry.nameI18n?.[lang]?.trim() || entry.name
export const langOf = (locale: string): 'it' | 'en' => (locale === 'it' ? 'it' : 'en')
export const wordsIn = (words: Words2, lang: 'it' | 'en'): string => words[lang] || words.en

/** The draft of what a line has now (its rows, or the style's defaults when nothing is chosen yet). */
export function draftOf(chosen: readonly Chosen[]): DraftPick[] {
  return chosen.map((row) => ({ valueId: row.valueId, groupId: row.groupId, text: row.text ?? '', byDefault: row.byDefault, colourId: row.colourId, itemId: row.itemId, itemColourId: row.itemColourId }))
}

/** A click on a value: a SINGLE group (at most one) takes it in place of its other value; a second click leaves it out. */
export function togglePick(draft: readonly DraftPick[], group: Pick<OptionGroupView, 'groupId' | 'maxPicks' | 'kind'>, valueId: string): DraftPick[] {
  const has = draft.find((pick) => pick.valueId === valueId)
  if (has) return draft.filter((pick) => pick.valueId !== valueId)
  const single = group.kind === 'SINGLE' || group.maxPicks === 1
  const rest = single ? draft.filter((pick) => pick.groupId !== group.groupId) : draft.filter((pick) => !(pick.groupId === group.groupId && pick.byDefault))
  return [...rest, { valueId, groupId: group.groupId, text: '', byDefault: false, colourId: null, itemId: null, itemColourId: null }]
}

export const setPick = (draft: readonly DraftPick[], valueId: string, change: Partial<Pick<DraftPick, 'text' | 'colourId' | 'itemId' | 'itemColourId'>>): DraftPick[] =>
  draft.map((pick) => {
    if (pick.valueId !== valueId) return pick
    const next = { ...pick, ...change, byDefault: false }
    // A colour of the library OR a material (and its colour), never both; a material's colour goes with its material.
    if (change.colourId) return { ...next, itemId: null, itemColourId: null }
    if (change.itemId !== undefined) return { ...next, colourId: change.itemId ? null : next.colourId, itemColourId: change.itemId === pick.itemId ? next.itemColourId : (change.itemColourId ?? null) }
    return next
  })

/** The picks as the API takes them: the defaults are left out (the API takes them again), a text only where the value takes one. */
export function picksBody(draft: readonly DraftPick[], groups: readonly OptionGroupView[]): PickBody[] {
  const values = new Map(groups.flatMap((group) => group.values.map((value) => [value.id, value] as const)))
  return draft
    .filter((pick) => !pick.byDefault)
    .map((pick) => {
      const value = values.get(pick.valueId)
      return {
        valueId: pick.valueId,
        ...(value?.freeText ? { text: pick.text.trim() } : {}),
        ...(pick.colourId ? { colourId: pick.colourId } : {}),
        ...(pick.itemId ? { itemId: pick.itemId, ...(pick.itemColourId ? { itemColourId: pick.itemColourId } : {}) } : {}),
      }
    })
}

/** A stable key of a draft (what is sent): equal keys, the same choice. */
export const draftKey = (draft: readonly DraftPick[], groups: readonly OptionGroupView[]): string =>
  JSON.stringify(
    picksBody(draft, groups)
      .map((pick) => [pick.valueId, pick.text ?? '', pick.colourId ?? '', pick.itemId ?? '', pick.itemColourId ?? ''])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
  )

/** The draft differs from what the line has. */
export const draftChanged = (draft: readonly DraftPick[], saved: readonly Chosen[], groups: readonly OptionGroupView[]): boolean => draftKey(draft, groups) !== draftKey(draftOf(saved), groups)

/** A value's surcharge in the options area's words (CF1:02): "+60 EUR", "+5 %", or none. */
export function surchargeWords(value: Pick<OptionValueView, 'surcharge'>, locale: string): string | null {
  if (!value.surcharge) return null
  const surcharge: Surcharge = { amount: value.surcharge.delta, currency: value.surcharge.currency, percent: value.surcharge.percent }
  const text = surchargeText(surcharge, locale)
  return text === '—' ? null : text
}

/** The rules of a group the person reads beside its values: each in the rule's words, a BLOCK first. */
export function groupRules(group: OptionGroupView, lang: 'it' | 'en'): { ruleId: string; text: string; block: boolean }[] {
  return [...group.rules].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'BLOCK' ? -1 : 1)).map((rule) => ({ ruleId: rule.ruleId, text: wordsIn(rule.words, lang), block: rule.severity === 'BLOCK' }))
}

/** A free text's own problem before anything is sent (the API checks the pattern). */
export function textProblem(value: Pick<OptionValueView, 'freeText' | 'freeTextMaxLength'>, text: string): Say | null {
  if (!value.freeText) return null
  if (text.trim() === '') return { key: 'groups.textMissing' }
  if (value.freeTextMaxLength !== null && [...text.trim()].length > value.freeTextMaxLength) return { key: 'groups.textTooLong', params: { max: value.freeTextMaxLength } }
  return null
}

export interface SaveState {
  /** The person may change the options now (else the API's words). */
  held: Words2 | null
  changed: boolean
  checking: boolean
  preview: CheckAnswer | null
  saving: boolean
  offline: boolean
  /** An order: the options change what they add, and the person has not chosen to keep the accepted price. */
  keepPrice: boolean
  kind: 'QUOTE' | 'ORDER' | 'BENCH'
}

/** Why Save waits, in words (null: it can be pressed). */
export function saveHeld(state: SaveState, draft: readonly DraftPick[], groups: readonly OptionGroupView[]): Say | null {
  if (state.kind === 'BENCH') return { key: 'bench.nothingSaved' }
  if (state.held) return { words: state.held }
  if (state.offline) return { key: 'save.held.offline' }
  if (state.saving) return { key: 'save.saving' }
  if (!state.changed) return { key: 'save.held.unchanged' }
  const values = new Map(groups.flatMap((group) => group.values.map((value) => [value.id, value] as const)))
  for (const pick of draft) {
    const value = values.get(pick.valueId)
    const problem = value ? textProblem(value, pick.text) : null
    if (problem) return problem
  }
  if (state.checking || !state.preview) return { key: 'save.held.checking' }
  if (state.preview.problem) return { words: state.preview.problem }
  if (!state.preview.ok) return { key: 'save.held.blocked' }
  if (state.kind === 'ORDER' && orderChange(state.preview) !== null && !state.keepPrice) return { key: 'save.held.keepPrice' }
  return null
}

/** On an order: what the draft's options add a piece more (or less) than accepted, or null when nothing changes. */
export function orderChange(preview: CheckAnswer | null): string | null {
  const change = preview?.pricing.change
  if (change === undefined || change === null) return null
  return Number(change) === 0 ? null : change
}

export interface PriceSummary {
  before: string | null
  after: string | null
  optionsTotal: string | null
  marginBefore: string | null
  marginAfter: string | null
  /** Why the line is not priced again by the options (a quote line), or null. */
  held: 'NO_START' | 'NOT_SIZE_GRID' | 'FEE' | null
  manualKept: boolean
  /** The saved price does not hold the saved options (priced by hand after the picks). */
  notHeld: boolean
}

/** The price and margin shown beside the picks: the saved line, then the API's check of the draft when there is one. */
export function priceSummary(view: LineConfigurator | null, preview: CheckAnswer | null): PriceSummary {
  const before = view?.line.unitPrice ?? null
  const marginBefore = view?.line.marginPct ?? null
  if (!view) return { before: null, after: null, optionsTotal: null, marginBefore: null, marginAfter: null, held: null, manualKept: false, notHeld: false }
  const repriced = preview?.pricing.repriced === true
  return {
    before,
    after: repriced ? (preview?.pricing.unitPrice ?? null) : before,
    optionsTotal: preview ? (preview.pricing.optionsTotal ?? null) : (view.line.optionsTotal ?? null),
    marginBefore,
    marginAfter: repriced ? (preview?.pricing.marginPct ?? null) : marginBefore,
    held: preview ? preview.pricing.held : view.pricing.held,
    manualKept: preview ? preview.pricing.manualKept : view.pricing.manualKept,
    notHeld: !view.pricing.holdsOptions,
  }
}

/** Why a picked artwork file is refused before it is sent (null: it goes). */
export function artworkRefusal(file: { type: string; size: number }): Say | null {
  if (!(ARTWORK_TYPES as readonly string[]).includes(file.type)) return { key: 'artwork.problem.type' }
  if (file.size > ARTWORK_MAX_BYTES) return { key: 'artwork.problem.size' }
  return null
}

/** The findings of a check in the reader's language, a BLOCK first. */
export function findingsOf(check: Pick<CheckAnswer, 'blocks' | 'warnings'> | null, lang: 'it' | 'en'): { text: string; block: boolean }[] {
  if (!check) return []
  return [...check.blocks.map((finding) => ({ text: wordsIn(finding.message, lang), block: true })), ...check.warnings.map((finding) => ({ text: wordsIn(finding.message, lang), block: false }))]
}

/** The groups of a style read for the bench (the line's view without a line). */
export const benchGroups = (style: StyleConfigurator | null): OptionGroupView[] => style?.groups ?? []
