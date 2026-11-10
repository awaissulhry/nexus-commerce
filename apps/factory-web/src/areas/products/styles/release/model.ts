import { BOM_ISSUE_CODES } from '@nexus/factory-domain/product/bom/rules'
import { GATE_FINDING_CODES, GATE_ITEMS, type GateFix, type GateItemCode, type GateState } from '@nexus/factory-domain/product/release/gate'
import { sizeWords } from '@nexus/factory-domain/product/release/scope'
import { ROUTING_ISSUE_CODES } from '@nexus/factory-domain/product/routing/rules'
import type { Tone } from '@nexus/ui/primitives'
import { isApiError } from '../../../../lib/api/errors'
import { refusalCode, refusalPhrase } from '../../changes/model'
import type { BomView, RoutingView, StyleView } from '../api'
import { issueWords, type StyleAbilities, type StyleTab } from '../model'
import type { GateFindingView, GateItemView, GateView, ScopeAsk } from './api'

/**
 * The Release modal's rules on B-W2b-231's gate (design products.styles pop:styles.release: the GateChecklist with "Fix"
 * per item — BOM, routing with SMV, materials priced, label, certificate per switched-on colourway × size, size spec (W2b),
 * materials approved (W2b) —, "Release only some colourways or sizes" (PRD-191) and "What happens, in words"), pure: each
 * item and finding in this app's words (W1's BOM and routing findings in the studio's own `issue.*` words, every other in
 * products-versions), where its Fix goes, the scope picked, whether the release would pass and why it is held, the effects.
 * The API's English sentences are never drawn.
 */

export const VERSIONS_NS = 'products-versions'

/** A phrase of a catalogue: the studio's (`products`), this step's (`products-versions`) or Changes & versions' (a refusal). */
export interface Say {
  ns: 'products' | 'versions' | 'changes'
  key: string
  params?: Record<string, string | number>
}
const mine = (key: string, params?: Say['params']): Say => (params ? { ns: 'versions', key, params } : { ns: 'versions', key })
const studio = (key: string, params?: Say['params']): Say => (params ? { ns: 'products', key, params } : { ns: 'products', key })

export const ITEM_TONE: Readonly<Record<GateState, Tone>> = { OK: 'success', WARNING: 'warning', BLOCKED: 'danger', NOT_REQUIRED: 'neutral' }

/** Every item and finding code has its words (the tests hold the catalogue to these lists). */
export const ITEM_CODES: readonly GateItemCode[] = GATE_ITEMS
const W1_CODES: ReadonlySet<string> = new Set<string>([...BOM_ISSUE_CODES, ...ROUTING_ISSUE_CODES])
/** The finding codes said in this step's words (W1's BOM and routing codes keep the studio's `issue.*`). */
export const OWN_FINDING_CODES: readonly string[] = GATE_FINDING_CODES.filter((code) => !W1_CODES.has(code))

// ---- the items and their findings --------------------------------------------------------------------------------------------

export interface GateFacts {
  bom: Pick<BomView, 'lines' | 'colourways'> | null
  routing: Pick<RoutingView, 'steps'> | null
  gate: Pick<GateView, 'scope'>
}

/** A finding in words: W1's codes in the studio's `issue.*`, the rest in this step's `finding.*`, with where it is. */
export function findingWords(finding: Pick<GateFindingView, 'code' | 'cell'>, facts: GateFacts): Say {
  const { cell } = finding
  if (W1_CODES.has(finding.code)) {
    const words = issueWords({ code: finding.code, lineId: cell.lineId, stepId: cell.stepId, colourwayId: cell.colourwayId, size: cell.size, message: '' } as BomView['issues'][number], facts.bom ? { lines: facts.bom.lines, colourways: facts.bom.colourways } : null, facts.routing)
    return studio(words.key, words.params)
  }
  const line = cell.lineId ? facts.bom?.lines.find((entry) => entry.id === cell.lineId) : undefined
  const step = cell.stepId ? facts.routing?.steps.find((entry) => entry.id === cell.stepId) : undefined
  const colourway = cell.colourwayId ? facts.gate.scope.colourways.find((entry) => entry.id === cell.colourwayId) : undefined
  return mine(`finding.${finding.code}`, {
    line: line ? `${line.seq} · ${line.item.code}` : '—',
    step: step ? `${step.seq} · ${step.code}` : '—',
    colourway: colourway?.code ?? '—',
    size: cell.size ?? '—',
    field: cell.field ?? '—',
  })
}

/** At most this many findings under an item; the rest are counted ("and 3 more"). */
export const FINDINGS_SHOWN = 5

export interface ItemView {
  code: GateItemCode
  state: GateState
  /** Where its Fix goes (null: nothing to fix here, or it is fixed in this dialog). */
  fix: string | null
  findings: Say[]
  more: number
}

/** The checklist in the design's order: each item with its state, its Fix, and its first findings in words. */
export function itemViews(gate: GateView, facts: Omit<GateFacts, 'gate'>, fixOf: (item: Pick<GateItemView, 'code' | 'fix' | 'state'>) => string | null): ItemView[] {
  const all: GateFacts = { ...facts, gate }
  return [...gate.items]
    .sort((a, b) => GATE_ITEMS.indexOf(a.code) - GATE_ITEMS.indexOf(b.code))
    .map((item) => ({
      code: item.code,
      state: item.state,
      fix: item.state === 'OK' || item.state === 'NOT_REQUIRED' ? null : fixOf(item),
      findings: item.findings.slice(0, FINDINGS_SHOWN).map((finding) => findingWords(finding, all)),
      more: Math.max(0, item.findings.length - FINDINGS_SHOWN),
    }))
}

/** The studio tab (or page) that fixes an item: B-W2b-231's GATE_FIXES in this app's places. */
export const FIX_TAB: Readonly<Record<GateFix, StyleTab | 'changes' | null>> = {
  bom: 'bom',
  routing: 'routing',
  minutes: 'routing',
  materials: 'compliance',
  labels: 'compliance',
  compliance: 'compliance',
  measurements: 'sizes',
  type: 'overview',
  changes: 'changes',
  // The scope is picked in the Release modal itself.
  release: null,
  versions: 'versions',
}

/** Where an item's Fix goes: a tab of the style on its revision, or Products › Changes for the style (null: here). */
export function fixHref(prefix: string, styleId: string, revisionId: string | null, item: Pick<GateItemView, 'code' | 'fix'>): string | null {
  // A missing standard cost is fixed on the material, reached from the BOM's line; an approval in Compliance › Material checks.
  const tab = item.code === 'PRICES' ? 'bom' : FIX_TAB[item.fix]
  if (!tab) return null
  if (tab === 'changes') return `${prefix}/products/changes?style=${encodeURIComponent(styleId)}`
  return `${prefix}/products/styles/${encodeURIComponent(styleId)}?tab=${tab}${revisionId ? `&rev=${encodeURIComponent(revisionId)}` : ''}`
}

/** "87,5 %" — the completeness score (a decimal string), in the page's language; null: none. */
export function pctText(pct: string | null | undefined, locale: 'it' | 'en'): string | null {
  if (pct === null || pct === undefined || pct === '') return null
  const value = Number(pct)
  if (!Number.isFinite(value)) return null
  return `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 2 }).format(value)} %`
}

/** The completeness meter's tone (colour rule A): from what is open, never from the %. */
export function meterTone(gate: Pick<GateView, 'items'>): 'complete' | 'partial' | 'missing' {
  if (gate.items.some((item) => item.state === 'BLOCKED')) return 'missing'
  if (gate.items.some((item) => item.state === 'WARNING')) return 'partial'
  return 'complete'
}

// ---- the scope ("Release only some colourways or sizes") ----------------------------------------------------------------------

/** The colourways and sizes picked; each empty = every one (the API's rule). */
export type ScopePick = ScopeAsk

export const WHOLE: ScopePick = { colourwayIds: [], sizes: [] }

const listed = <T extends { asked?: boolean; planned?: boolean }>(entries: readonly T[], flag: 'asked' | 'planned', key: (entry: T) => string): string[] => {
  const on = entries.filter((entry) => entry[flag])
  // Every one listed is the same as "every one".
  return on.length === entries.length ? [] : on.map(key)
}

/** The scope a gate was asked about (the preview), or what the revision holds (planned on a draft, released on a frozen one). */
export function pickOf(gate: Pick<GateView, 'scope'>, flag: 'asked' | 'planned' = 'asked'): ScopePick {
  const scope = flag === 'asked' ? gate.scope.asked : gate.scope.planned
  if (scope.whole) return WHOLE
  const colourways = gate.scope.colourways.filter((entry) => entry.status === 'ACTIVE' || entry[flag])
  return { colourwayIds: scope.colourwayIds.length === 0 ? [] : listed(colourways, flag, (entry) => entry.id), sizes: scope.sizes.length === 0 ? [] : listed(gate.scope.sizes, flag, (entry) => entry.code) }
}

export const isWholePick = (pick: ScopePick): boolean => pick.colourwayIds.length === 0 && pick.sizes.length === 0

/** The same scope (order does not matter). */
export function samePick(a: ScopePick, b: ScopePick): boolean {
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && [...x].sort().join('\n') === [...y].sort().join('\n')
  return same(a.colourwayIds, b.colourwayIds) && same(a.sizes, b.sizes)
}

/** A colourway or size ticked or not: every one listed again collapses to "every one". */
export function togglePick(pick: ScopePick, side: 'colourway' | 'size', id: string, every: readonly string[]): ScopePick {
  const field = side === 'colourway' ? 'colourwayIds' : 'sizes'
  const current = pick[field].length === 0 ? [...every] : [...pick[field]]
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
  const ordered = every.filter((entry) => next.includes(entry))
  return { ...pick, [field]: ordered.length === every.length ? [] : ordered }
}

/** Whether a colourway or size is in the pick. */
export const picked = (pick: ScopePick, side: 'colourway' | 'size', id: string): boolean => {
  const list = side === 'colourway' ? pick.colourwayIds : pick.sizes
  return list.length === 0 || list.includes(id)
}

/** Nothing would be released: a side picked down to none (an empty list means every one, so this is a pick of none). */
export interface PickState {
  pick: ScopePick
  /** A side unticked down to nothing (the pick itself still says "every one" there). */
  none: { colourways: boolean; sizes: boolean }
}

export interface ScopeChoice {
  id: string
  label: string
  /** Ticked. */
  on: boolean
  /** Held as it is: a later release only adds (a released colourway or size stays). */
  fixed: boolean
}

/** The chips of the scope: the active colourways (and any archived one the revision still names) and the range's sizes. */
export function scopeChoices(gate: Pick<GateView, 'scope' | 'revision'>, pick: ScopePick, none: PickState['none']): { colourways: ScopeChoice[]; sizes: ScopeChoice[] } {
  const frozen = gate.revision.status === 'RELEASED'
  return {
    colourways: gate.scope.colourways
      .filter((entry) => entry.status === 'ACTIVE' || entry.planned)
      .map((entry) => ({ id: entry.id, label: entry.code, on: !none.colourways && picked(pick, 'colourway', entry.id), fixed: frozen && entry.planned })),
    sizes: gate.scope.sizes.map((entry) => ({ id: entry.code, label: entry.label, on: !none.sizes && picked(pick, 'size', entry.code), fixed: frozen && entry.planned })),
  }
}

/** "NERO, ROSSO in 50–54" (codes and sizes are the same in every language); null: every colourway and size. */
export function pickText(pick: ScopePick, gate: Pick<GateView, 'scope'>): { colourways: string | null; sizes: string | null } {
  const codes = pick.colourwayIds.map((id) => gate.scope.colourways.find((entry) => entry.id === id)?.code ?? '—')
  return {
    colourways: pick.colourwayIds.length === 0 ? null : codes.join(', '),
    sizes: pick.sizes.length === 0 ? null : sizeWords(pick.sizes, gate.scope.sizes.map((entry) => entry.code)),
  }
}

/** What the pick leaves for a later release, by codes: the colourways and sizes not ticked. */
export function waitingText(pick: ScopePick, gate: Pick<GateView, 'scope'>): { colourways: string | null; sizes: string | null } {
  const colourways = gate.scope.colourways.filter((entry) => entry.status === 'ACTIVE' && !picked(pick, 'colourway', entry.id)).map((entry) => entry.code)
  const sizes = gate.scope.sizes.filter((entry) => !picked(pick, 'size', entry.code)).map((entry) => entry.code)
  return { colourways: colourways.length ? colourways.join(', ') : null, sizes: sizes.length ? sizeWords(sizes, gate.scope.sizes.map((entry) => entry.code)) : null }
}

/** The scope as one sentence of this app: every one, or the codes picked (and what waits). */
export function scopeSay(pick: ScopePick, gate: Pick<GateView, 'scope'>): Say {
  if (isWholePick(pick)) return mine('scope.whole')
  const text = pickText(pick, gate)
  const waits = waitingText(pick, gate)
  const what = mine(text.colourways && text.sizes ? 'scope.both' : text.colourways ? 'scope.colourwaysOnly' : 'scope.sizesOnly', { colourways: text.colourways ?? '', sizes: text.sizes ?? '' })
  if (!waits.colourways && !waits.sizes) return what
  return { ...what, key: `${what.key}Waiting`, params: { ...what.params, waiting: [waits.colourways, waits.sizes].filter(Boolean).join(' · ') } }
}

// ---- whether it would pass, and why it is held -------------------------------------------------------------------------------

export type GateRead = { status: 'loading' } | { status: 'ready'; value: GateView } | { status: 'error'; problem: string }

export interface ReleaseState {
  /** The revision the modal releases (a draft), or widens (a released one: "Release more"). */
  mode: 'release' | 'widen'
  gate: GateRead
  /** The scope picked in the modal; the gate shown may still be for an earlier pick (`previewing`). */
  pick: ScopePick
  none: PickState['none']
  /** "Release only some colourways or sizes" is open. */
  partial: boolean
  /** A preview of the pick is being read. */
  previewing: boolean
  busy: boolean
  /** A refused release or scope, in words (the modal keeps what was picked). */
  problem: Say | null
}

/** The first blocking item, in words ("Fix first: Materials approved"). */
export function firstBlocker(gate: Pick<GateView, 'items'>): GateItemCode | null {
  const sorted = [...gate.items].sort((a, b) => GATE_ITEMS.indexOf(a.code) - GATE_ITEMS.indexOf(b.code))
  return sorted.find((item) => item.state === 'BLOCKED')?.code ?? null
}

/** Why "Release revision N" (or "Release more") is held, or null when it would go. */
export function releaseGateHeld(state: ReleaseState, style: Pick<StyleView, 'status'>, can: Pick<StyleAbilities, 'release'>): Say | null {
  if (!can.release) return studio('held.noRelease')
  if (style.status === 'ARCHIVED') return studio('held.archived')
  if (state.gate.status === 'loading') return mine('hold.reading')
  if (state.gate.status === 'error') return mine('hold.unread')
  const gate = state.gate.value
  if (state.mode === 'release' && gate.revision.status !== 'DRAFT') return studio('held.notDraft')
  if (state.mode === 'widen' && gate.revision.status !== 'RELEASED') return mine('hold.notReleased')
  if (state.none.colourways || state.none.sizes) return mine('hold.scopeEmpty')
  if (state.previewing) return mine('hold.reading')
  if (!gate.mayRelease) return mine('hold.mayNot')
  if (state.mode === 'widen') {
    if (samePick(state.pick, pickOf(gate, 'planned'))) return mine('hold.notWider')
    const scope = gate.items.find((item) => item.code === 'SCOPE')
    if (scope?.state === 'BLOCKED') return mine('hold.scope')
  } else if (!gate.releasable) {
    const first = firstBlocker(gate)
    return first ? mine('hold.blocked', { item: `gateItem.${first}` }) : mine('hold.notReleasable')
  }
  if (state.busy) return studio('held.busy')
  return null
}

/** The release sends the picked scope first when it is not what the draft holds (two calls: the scope, then W1's release). */
export const scopeToSend = (state: Pick<ReleaseState, 'pick'>, gate: Pick<GateView, 'scope'>): ScopePick | null => (samePick(state.pick, pickOf(gate, 'planned')) ? null : state.pick)

/** What happens, in words (design: "Revision 4 becomes the one every new work order uses…"). */
export function effectsOf(gate: GateView, style: Pick<StyleView, 'status' | 'revisions'>, pick: ScopePick): Say[] {
  const released = style.revisions.find((entry) => entry.status === 'RELEASED' && entry.id !== gate.revision.id) ?? null
  const drift = gate.items.find((item) => item.code === 'DRIFT')
  return [
    studio('release.becomes', { revision: gate.revision.revision }),
    ...(released ? [studio('release.obsoletes', { revision: released.revision })] : []),
    ...(style.status === 'DRAFT' ? [studio('release.activates')] : []),
    scopeSay(pick, gate),
    ...(released && drift?.state === 'WARNING' ? [mine('effect.drift', { revision: released.revision })] : []),
    studio('release.frozen'),
  ]
}

/** A later release's effects: what it adds, and that the readers (planning, quotes, work orders) take it at once. */
export function widenEffectsOf(gate: GateView, pick: ScopePick): Say[] {
  return [mine('effect.widen', { revision: gate.revision.revision }), scopeSay(pick, gate), mine('effect.widenNever')]
}

// ---- a refused read or write in words -----------------------------------------------------------------------------------------

/** A failed read (never drawn as empty): this step's words per kind. */
export function readFault(error: unknown): Say {
  if (!isApiError(error)) return mine('fault.unavailable')
  if (error.kind === 'forbidden') return mine('fault.forbidden')
  if (error.kind === 'not_found') return mine('fault.notFound')
  if (error.kind === 'signed_out') return mine('fault.signedOut')
  if (error.kind === 'contract') return mine('fault.contract')
  if (error.kind === 'rate_limited') return mine('fault.rateLimited')
  return mine('fault.unavailable')
}

/** A refused scope or release: a rule's code in Changes & versions' words (the edit rule, a change order), else by kind. */
export function writeFault(error: unknown): Say {
  if (!isApiError(error)) return mine('fault.unavailable')
  const code = refusalCode(error)
  if (code) return { ns: 'changes', key: refusalPhrase(code).key }
  if (error.kind === 'conflict') return error.code === 'version_conflict' ? mine('fault.moved') : mine('fault.refused')
  if (error.kind === 'invalid') return mine('fault.scope')
  if (error.kind === 'forbidden' || error.kind === 'step_up') return mine('fault.writeForbidden')
  if (error.kind === 'not_found') return mine('fault.notFound')
  if (error.kind === 'rate_limited') return mine('fault.rateLimited')
  return mine('fault.unavailable')
}
