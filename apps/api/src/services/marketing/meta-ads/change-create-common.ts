/**
 * Meta step 19 — what create-meta-campaign, create-meta-ad-set and copy-meta-ads share: the record a create or a copy keeps
 * (every object it made on Meta, by id — its undo deletes ONLY those), the undo itself as a draft (DELETE of what the
 * change made, while nothing else hangs under it and it has spent nothing, read live first), scheduled budget increases at
 * create (step 18's units and limits), and the words about spending. Pure: no reads.
 *
 * The record (AgentChange `after`): `made` lists every object the change made (a copy's ad_object_ids too), `top` the ones
 * undo deletes (a campaign takes its ad sets and ads with it, an ad set its ads), `madeAt` when. Undo asks the SAME tool
 * with `removeMade: true` and `undoOf: <the change's id>`: the tool reads that change's record (in this business), never an
 * id a caller names, and deletes only what it says the change made (gateway rule object.delete, meta-create-rules.ts).
 * What cannot go back is said, pointing to remove-meta-ads-items (step 22, not built yet): an object that now holds
 * something the change did not make, one that has spent, a background copy (Meta makes those copies later; Nexus never had
 * their ids).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { capProblem, increaseWords } from './change-budget-schedule.js'
import { MetaUnitError, scheduleAbsoluteParam, schedulePercentParam, unixSecondsParam } from './settings-units.js'
import type { MadeKind, MadeNow } from './live-create.js'
import { MIN_PERIOD_SECONDS } from '../../gateway/meta-settings-rules.js'

export type { MadeKind } from './live-create.js'
export const KIND_WORD: Readonly<Record<MadeKind, string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad' }

/** One object a change made on Meta (a creative only from a copy's answer: Meta copies an ad's creative with it). */
export interface MadeObject { kind: MadeKind | 'creative'; id: string; name?: string | null }

/** What a create, a copy or its undo records (AgentChange before / after). */
export interface MadeRecord {
  op: 'create' | 'copy' | 'background-copy' | 'remove'
  /** Every object this change made on Meta, top first (empty in `before`, and for a background copy). */
  made: MadeObject[]
  /** The objects its undo deletes: their own children that this change made go with them. */
  top: Array<{ kind: MadeKind; id: string }>
  /** When it was made (ISO): undo reads what it spent since. */
  madeAt: string
  /** A background copy: the id of Meta's request set (Meta makes the copies later). */
  requestSetId?: string | null
  /** remove (an undo): what it deleted. */
  removed?: Array<{ kind: MadeKind; id: string }>
  /** What has no way back, in words. */
  noUndo?: string[]
}

/** The record of a create or a copy before it ran (nothing made yet). */
export const nothingMade = (op: MadeRecord['op']): MadeRecord => ({ op, made: [], top: [], madeAt: '' })

/** Meta's ad_object_type → the kind Nexus records (reference/ad-campaign-group/copies.md "Return Type"). */
const OBJECT_TYPE: Readonly<Record<string, MadeObject['kind']>> = { campaign: 'campaign', ad_set: 'adset', ad: 'ad', unique_adcreative: 'creative' }
const idText = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,25}$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null)

/** What a copy made, from Meta's answer: the copy itself, then every ad_object_ids entry (ad sets, ads, creatives). */
export function madeByCopy(kind: MadeKind, node: Record<string, unknown> | null, name: string | null): MadeObject[] {
  if (!node) return []
  const top = idText(node[kind === 'campaign' ? 'copied_campaign_id' : kind === 'adset' ? 'copied_adset_id' : 'copied_ad_id']) ?? idText(node.id)
  if (!top) return []
  const out: MadeObject[] = [{ kind, id: top, name }]
  const list = Array.isArray(node.ad_object_ids) ? node.ad_object_ids : []
  for (const raw of list) {
    const e = (raw ?? {}) as Record<string, unknown>
    const k = OBJECT_TYPE[String(e.ad_object_type)]
    const id = idText(e.copied_id)
    if (k && id && !out.some((o) => o.id === id)) out.push({ kind: k, id })
  }
  return out
}

// ── the undo: delete what the change made (removeMade) ──────────────────────────────────────────────────────────────

export const REMOVE_LATER = 'remove it with remove-meta-ads-items (step 22, not built yet) or in Ads Manager'

/**
 * The undo of a create or a copy as a draft: one DELETE per top object the change made that is still there, holds only
 * what the change made, and has spent nothing (all read live first: liveMadeObject). Anything else is said, not sent.
 */
export function removalDraft(record: MadeRecord, live: MadeNow[], tool: string): MetaChangeDraft | { refusal: string } {
  if (record.op === 'background-copy') return { refusal: `This was a background copy: Meta made the copies later, and Nexus never had their ids, so undo cannot tell them apart — meta-campaigns view copies shows them; ${REMOVE_LATER}.` }
  if (record.op === 'remove') return { refusal: 'This change deleted what an earlier change made: a deletion on Meta is final, there is nothing to put back.' }
  if (!record.top.length) return { refusal: 'This change recorded nothing it made on Meta, so there is nothing to delete.' }
  const made = new Set(record.made.map((m) => m.id))
  const requests: MetaChangeRequest[] = []
  const kept: string[] = []
  const skipped: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  for (const top of record.top) {
    const now = live.find((l) => l.id === top.id && l.kind === top.kind)
    const who = `${KIND_WORD[top.kind]} ${top.id}`
    if (!now) { kept.push(`Nexus could not read ${who}, so it is kept.`); continue }
    if (!now.there) { skipped.push(`${who} is no longer on Meta (deleted already).`); continue }
    const foreign = now.children.filter((c) => !made.has(c))
    if (foreign.length || now.childrenMore) {
      kept.push(`${who} now holds ${now.childrenMore ? 'more ad sets or ads than Nexus reads at once' : `${plural(foreign.length, 'ad set or ad', 'ad sets or ads')} this change did not make (${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''})`}: deleting it would take those with it, so Nexus keeps it — ${REMOVE_LATER}.`)
      continue
    }
    if (now.spend === null) { kept.push(`Nexus could not read what ${who} spent, so it keeps it — ${REMOVE_LATER}.`); continue }
    if (now.spend > 0) { kept.push(`${who} has spent since it was made (${now.spend} in the account currency, Meta's number): Nexus keeps it with its results — pause it with set-meta-status, or ${REMOVE_LATER}.`); continue }
    requests.push({
      step: requests.length + 1, label: `Delete ${who} (made by the change undone)`, kind: top.kind, objectId: top.id, params: {},
      // Meta documents no check for a delete (validate_only is on creates and campaign updates only).
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: `${top.kind}.delete`, method: 'DELETE',
    })
    lines.push([`${KIND_WORD[top.kind][0].toUpperCase()}${KIND_WORD[top.kind].slice(1)} ${top.id}`, now.status ?? 'there', 'deleted'])
  }
  if (!requests.length) return { refusal: `Nothing is deleted: ${[...kept, ...skipped].join(' ') || 'nothing this change made is left.'}` }
  const { changes, more } = changeLines(lines)
  const creatives = record.made.filter((m) => m.kind === 'creative').length
  return {
    summary: `Meta: delete ${plural(requests.length, 'object')} the change undone made (undo of ${tool}).`,
    changes,
    totals: { requests: requests.length, ...(kept.length ? { kept: kept.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings: [
      'A deletion on Meta is final: a deleted campaign, ad set or ad never comes back (Meta keeps its numbers readable for 28 days). A campaign takes its ad sets and ads with it, an ad set its ads.',
      ...(creatives ? [`The ${plural(creatives, 'creative')} Meta copied stay in the account's creative library (a creative alone never spends).`] : []),
      ...kept,
      'Meta has no check for a delete: the run reads every object again first and sends nothing if what it stands on moved.',
    ],
    spendsMoney: [],
    skipped,
    requests,
    stands: { live: live.map((l) => ({ ...l, children: [...l.children].sort() })), record: { op: record.op, top: record.top, made: record.made.map((m) => m.id).sort() } },
    before: { ...record, op: 'remove' as const, removed: [] },
    after: { ...nothingMade('remove'), removed: [] },
  }
}

// ── scheduled budget increases at create (CMP-058, AS-089) ──────────────────────────────────────────────────────────

export interface ScheduleAsk { startTime: string; endTime: string; increaseCents?: number; increasePercent?: number }

/**
 * budget_schedule_specs from what a person names: each a one-time increase in the future, at least 3 hours, by an amount
 * (whole currency units — step 18's reading of Meta's undocumented unit) or a percentage, within Meta's 8 daily budgets.
 * Throws MetaUnitError with the reason.
 */
export function scheduleSpecs(asks: ScheduleAsk[], dailyCents: number, currency: string | null, now: Date): { value: string; words: string[] } {
  if (asks.length > 50) throw new MetaUnitError('Meta allows at most 50 scheduled increases per campaign or ad set.')
  const nowSec = Math.floor(now.getTime() / 1000)
  const specs: Array<{ time_start: number; time_end: number; budget_value: number; budget_value_type: 'ABSOLUTE' | 'MULTIPLIER' }> = []
  const words: string[] = []
  for (const a of asks) {
    if ((a.increaseCents === undefined) === (a.increasePercent === undefined)) throw new MetaUnitError('Each scheduled increase names an amount (increaseCents) or a percentage (increasePercent), one of the two.')
    const start = Number(unixSecondsParam(a.startTime))
    const end = Number(unixSecondsParam(a.endTime))
    if (start <= nowSec) throw new MetaUnitError('A scheduled increase starts in the future.')
    if (end - start < MIN_PERIOD_SECONDS) throw new MetaUnitError('Meta schedules an increase of at least 3 hours.')
    const increase = a.increaseCents !== undefined
      ? { type: 'ABSOLUTE' as const, value: scheduleAbsoluteParam(a.increaseCents, currency), cents: a.increaseCents }
      : { type: 'MULTIPLIER' as const, value: schedulePercentParam(a.increasePercent!), cents: null }
    const cap = capProblem(increase, dailyCents, currency)
    if (cap) throw new MetaUnitError(cap)
    specs.push({ time_start: start, time_end: end, budget_value: Number(increase.value), budget_value_type: increase.type })
    words.push(`${increaseWords(increase.type, Number(increase.value), currency)}, ${new Date(start * 1000).toISOString()} → ${new Date(end * 1000).toISOString()}`)
  }
  return { value: JSON.stringify(specs), words }
}

/** The status a create sends: PAUSED unless the person asked to switch it on (then SPENDS MONEY, said by the draft). */
export const createStatus = (activate: boolean | undefined) => (activate ? 'ACTIVE' : 'PAUSED')
