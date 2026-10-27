/**
 * Negative Targeting page, step 4 (2026-10-25) — the words and rules of the Protected tile, pure and
 * tested in Node (`protectionModel.vitest.test.ts`). The components (`protection.tsx`) only draw what these say.
 *
 *   term      a protected term in words: its match (Exact · Starts with · Contains), its scope (Amazon IT or every market;
 *             a campaign or every campaign), why — the chip on the row and its panel
 *   keep      "Keep protected" = the page's Skip for 30 days: the ticked rows it fits (protected, not kept already)
 *   remove    "Remove protection and stop": one UNPROTECT item per protected term that holds the row, then its own verb;
 *             held (with why) when the stop would still be held, or the person may not remove a protected term
 *   bulk      one removal per protected term across the ticked rows, then each row's own verb (left-out rows say why)
 *   follow-up a negative waits for the removal: Nexus sends it once the removal ran, as the approver; the page only watches
 *             (`watchFollowUp`, its calls passed in) and says how it went in the page's own words (wasteModel.ts doneLine):
 *             Nexus only → "Saved in Nexus"; in its 20 s window → "Sending"; "Sent" only once it ran
 *   keys      the Term cell: Enter opens the record (the grid's), Shift+Enter the protected term's panel
 */
import { dayWords } from '../../bid/_shared/format'
import { doneLine } from './wasteModel'
import type { FollowUpView, PreviewStep, ProtectionTerm, RowProtection, WasteItem, WasteRow } from './wasteTypes'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── a protected term in words ───────────────────────────────────────────────────────────────────────────────────────

const MATCH: Readonly<Record<ProtectionTerm['match'], string>> = { EXACT: 'Exact', PREFIX: 'Starts with', CONTAINS: 'Contains' }
export const protectionMatchWord = (m: ProtectionTerm['match']) => MATCH[m] ?? 'Exact'

/** Where it binds: "Amazon IT · every campaign", "Every market · Summer exact". */
export function protectionScopeWords(t: Pick<ProtectionTerm, 'market' | 'campaign'>): string {
  return `${t.market ? `Amazon ${t.market}` : 'Every market'} · ${t.campaign ? t.campaign.name : 'every campaign'}`
}

/** The chip's words on the row: the first term, "+1" for each more. */
export function protectionChipWords(p: RowProtection): { label: string; more: number } {
  return { label: p.terms[0]?.term ?? 'Protected', more: Math.max(0, p.terms.length - 1) }
}

/** The whole sentence (hover, the accessible name): every term, its match, its scope and why. */
export function protectionSentence(p: RowProtection): string {
  const one = (t: ProtectionTerm) => `"${t.term}" (${protectionMatchWord(t.match).toLowerCase()}, ${t.market ? `Amazon ${t.market}` : 'every market'}, ${t.campaign ? `campaign ${t.campaign.name}` : 'every campaign'})${t.reason ? `: ${t.reason}` : ''}`
  if (!p.terms.length) return 'Protected: never negated'
  return `Kept safe by the protected term${p.terms.length > 1 ? 's' : ''} ${p.terms.map(one).join('; ')}. No negative and no pause may stop it.`
}

/**
 * The record's "What protects it" card (2026-10-26): one line per protected term (its words, match, where, why), the
 * card's line, and the note under the table: what the protection blocks, and what holds the row once it is removed.
 */
export function protectsView(r: Pick<WasteRow, 'protection' | 'skipped' | 'state'>): {
  rows: Array<{ id: string; term: string; match: string; where: string; why: string }>
  desc: string
  note: string
} | null {
  const terms = r.protection?.terms ?? []
  if (!terms.length) return null
  const then = r.protection?.then ?? null
  const kept = keptProtectedWords(r)
  return {
    rows: terms.map((t) => ({ id: t.id, term: t.term, match: protectionMatchWord(t.match), where: protectionScopeWords(t), why: t.reason ?? '—' })),
    desc: terms.length > 1 ? 'Each of these terms keeps it safe on its own' : 'This term keeps it safe',
    note: [
      'No negative and no pause can stop it while it is protected.',
      then ? `Without the protection: ${then.label.charAt(0).toLowerCase()}${then.label.slice(1).replace(/\.$/, '')}.` : 'Without the protection, it can be stopped.',
      kept ? `${kept}: it stays out of view until then.` : null,
    ].filter(Boolean).join(' '),
  }
}

/** The protected record's "Keep protected" button: its words on hover (the Skip for 30 days, the protection stays). */
export const KEEP_PROTECTED_HINT = 'Hides it for 30 days. The protection stays.'

// ── Keep protected (Skip 30 d) ──────────────────────────────────────────────────────────────────────────────────────

/** "Keep protected" is the page's Skip for this many days. */
export const KEEP_PROTECTED_DAYS = 30 as const
/** The reason the skip stores (its History line says it). */
export const KEEP_PROTECTED_REASON = 'Kept protected: the protected term stays.'

/** The ticked rows Keep protected fits: protected, loaded, not kept (skipped) already. */
export function keepProtectedIds(picked: ReadonlyArray<WasteRow | { id: string }>): string[] {
  return picked.flatMap((p) => ('state' in p && p.state === 'PROTECTED' && !p.skipped ? [p.id] : []))
}

/** A kept-protected row's words: "Kept protected until 24 Nov 2026"; null when it is not one. */
export function keptProtectedWords(r: Pick<WasteRow, 'state' | 'skipped'>): string | null {
  return r.state === 'PROTECTED' && r.skipped ? `Kept protected until ${dayWords(r.skipped.until)}` : null
}

// ── Remove protection and stop ──────────────────────────────────────────────────────────────────────────────────────

/** The permissions the removal's tool asks (set-ad-guardrail), on top of changing ads here. */
export const UNPROTECT_PERMISSIONS = ['ads.automation.manage', 'ads.bids.edit', 'ads.budgets.edit', 'financials.adspend.view'] as const

/** The row's own verb, where it lands: what stops it once the protection is gone. */
export const stopItemOf = (r: Pick<WasteRow, 'id' | 'verb'>): WasteItem => ({ rowId: r.id, action: r.verb.action, ...(r.verb.action === 'NEGATE_EXACT' || r.verb.action === 'NEGATE_PHRASE' ? { where: r.verb.where } : {}) })

/** The review's items: each protected term that holds the row, then the row's own verb (where it lands). */
export function removeProtectionItems(r: Pick<WasteRow, 'id' | 'verb' | 'protection'>): WasteItem[] {
  return [...(r.protection?.terms ?? []).map((t): WasteItem => ({ rowId: r.id, action: 'UNPROTECT', protectionId: t.id })), stopItemOf(r)]
}

/** Why "Remove protection and stop" is held, or null: the person, then the stop that would still be held. */
export function removeProtectionHeld(r: Pick<WasteRow, 'state' | 'protection' | 'waiting' | 'followUp'>, can: { write: boolean; unprotect: boolean }): string | null {
  if (!can.write) return 'You can see ads here, not change them'
  if (!can.unprotect) return 'Removing a protected term needs the ads automation, bids, budgets and ad spend permissions'
  if (r.followUp?.status === 'WAITING') return 'Its protection is being removed: Nexus sends its negative once it is'
  if (r.state !== 'PROTECTED' || !r.protection?.terms.length) return 'No protected term keeps it safe'
  if (r.protection.then) return `Removing the protection would not stop it: ${r.protection.then.reason}`
  return null
}

/** The review's lead: what else each removed term keeps safe ("This protection also keeps 3 other terms safe"). */
export function alsoKeepsTitle(steps: readonly PreviewStep[]): { title: string; tone: 'warning' | 'info' } | null {
  const removing = steps.filter((s) => s.action === 'UNPROTECT' && !s.refusal && s.protection?.alsoKeeps)
  if (!removing.length) return null
  const n = removing.reduce((sum, s) => sum + (s.protection!.alsoKeeps!.count), 0)
  const who = removing.length === 1 ? 'This protection' : `These ${removing.length} protections`
  if (!n) return { title: `${who} keeps no other term safe`, tone: 'info' }
  return { title: `${who} also ${removing.length === 1 ? 'keeps' : 'keep'} ${plural(n, 'other term')} safe`, tone: 'warning' }
}

/** One "also keeps" line: "jacket brand red · 2 places · wastes". */
export function alsoKeepsLine(t: { text: string; places: number; wasting: boolean }): string {
  return [t.text, t.places > 1 ? plural(t.places, 'place') : null, t.wasting ? 'wastes' : null].filter(Boolean).join(' · ')
}

/** The review line's note: its place in the order ("Step 1 · Nexus only"). */
export function stepOrderNote(steps: readonly PreviewStep[], index: number, note: string): string {
  if (!steps.some((s) => s.action === 'UNPROTECT')) return note
  return `Step ${index + 1} · ${note}`
}

// ── bulk: one removal per protected term, then each row's own verb ──────────────────────────────────────────────────

/** The most changes one review sends (the server's own limit on a preview). */
export const MAX_REVIEW_ITEMS = 200

/**
 * Bulk "Remove protection and stop": one removal per protected term across the ticked rows (a term holding many rows is
 * ONE removal), then each row's own verb; every row it cannot stop is left out with why, as the page's bulk verbs do.
 * Pure.
 */
export function removeProtectionBulkPlan(rows: ReadonlyArray<WasteRow | { id: string }>, can: { write: boolean; unprotect: boolean }): { items: WasteItem[]; left: Array<{ id: string; text: string; why: string }> } {
  const removals = new Map<string, string>()
  const stops: WasteItem[] = []
  const left: Array<{ id: string; text: string; why: string }> = []
  for (const r of rows) {
    if (!('state' in r)) { left.push({ id: r.id, text: r.id, why: 'Not read yet' }); continue }
    if (r.state !== 'PROTECTED' || !r.protection?.terms.length) { left.push({ id: r.id, text: r.text, why: 'No protected term keeps it safe' }); continue }
    if (r.waiting) { left.push({ id: r.id, text: r.text, why: 'Waits for you: approve or reject it first' }); continue }
    const held = removeProtectionHeld(r, can)
    if (held) { left.push({ id: r.id, text: r.text, why: held }); continue }
    const fresh = r.protection.terms.filter((t) => !removals.has(t.id))
    if (removals.size + fresh.length + stops.length + 1 > MAX_REVIEW_ITEMS) { left.push({ id: r.id, text: r.text, why: `At most ${MAX_REVIEW_ITEMS} changes in one review` }); continue }
    for (const t of fresh) removals.set(t.id, r.id)
    stops.push(stopItemOf(r))
  }
  return { items: [...[...removals].map(([protectionId, rowId]): WasteItem => ({ rowId, action: 'UNPROTECT', protectionId })), ...stops], left }
}

/** How many ticked rows bulk "Remove protection and stop" fits (its button's count). */
export const removeProtectionBulkCount = (rows: ReadonlyArray<WasteRow | { id: string }>, can: { write: boolean; unprotect: boolean }) =>
  removeProtectionBulkPlan(rows, can).items.filter((i) => i.action !== 'UNPROTECT').length

// ── the follow-up: the negatives Nexus sends once the protection is removed ────────────────────────────────────────

export interface WatchDeps {
  commit(approvalId: string): Promise<unknown>
  run(approvalId: string): Promise<FollowUpView | null>
  sleep(ms: number): Promise<void>
  now(): number
  /** The negatives were asked: their change set is in its undo window (the page says so until it ran). */
  sent?(view: FollowUpView): void
}
export type WatchOutcome = { kind: 'done'; view: FollowUpView } | { kind: 'late' } | { kind: 'stopped' }

/** How often, and how many times, the page asks how the follow-up went (the server's cron sends it if the page cannot). */
const WATCH_POLL_MS = 2_000
export const WATCH_TRIES = 30

/** A change set still in its undo window (or running); one that did not run. */
const IN_WINDOW: ReadonlySet<string> = new Set(['pending', 'scheduled', 'approved', 'executing'])
const DID_NOT_RUN: ReadonlySet<string> = new Set(['rejected', 'expired', 'failed', 'cancelled'])

/** The negatives' change set: still in its 20 s window (queued), ran (applied), or it did not run. Pure. */
export function followUpSetState(view: FollowUpView): 'queued' | 'applied' | 'not_run' {
  const s = view.changeSet?.status
  if (!s) return 'applied'
  return IN_WINDOW.has(s) ? 'queued' : DID_NOT_RUN.has(s) ? 'not_run' : 'applied'
}

/**
 * The page only shows progress: once the removal's 20 s window closed it asks Nexus to run the removal (the Approvals
 * page's "run it now") and its follow-up now, then reads how it went until it ended. Once the negatives were asked, their
 * own change set has its 20 s window (`sent`): at its end the page asks Nexus to run it, then reads it until it ran.
 * Nexus sends the negatives itself, as the person who approved; leaving the page changes nothing (the server's cron and
 * the approvals sweep finish it). `stopped()`: Undo.
 */
export async function watchFollowUp(args: { removalId: string; executeAfter?: string | null; stopped(): boolean }, deps: WatchDeps): Promise<WatchOutcome> {
  const waitUntil = async (iso: string | null | undefined) => {
    const at = iso ? Date.parse(iso) : deps.now() + 20_000
    await deps.sleep(Math.max(0, at - deps.now()) + 500)
  }
  await waitUntil(args.executeAfter)
  if (args.stopped()) return { kind: 'stopped' }
  await deps.commit(args.removalId).catch(() => undefined)
  let view: FollowUpView | null = null
  for (let i = 0; i < WATCH_TRIES && !view; i++) {
    if (args.stopped()) return { kind: 'stopped' }
    const read = await deps.run(args.removalId).catch(() => null)
    if (read && read.status !== 'WAITING' && read.status !== 'SENDING') view = read
    else await deps.sleep(WATCH_POLL_MS)
  }
  if (!view) return { kind: 'late' }
  if (view.status !== 'SENT' || !view.changeSetId || followUpSetState(view) !== 'queued') return { kind: 'done', view }
  deps.sent?.(view)
  await waitUntil(view.changeSet?.executeAfter)
  if (args.stopped()) return { kind: 'stopped' }
  await deps.commit(view.changeSetId).catch(() => undefined)
  for (let i = 0; i < WATCH_TRIES; i++) {
    if (args.stopped()) return { kind: 'stopped' }
    const read = await deps.run(args.removalId).catch(() => null)
    if (read) view = read
    if (followUpSetState(view) !== 'queued') return { kind: 'done', view }
    await deps.sleep(WATCH_POLL_MS)
  }
  return { kind: 'done', view }
}

/** Where a sent row lands (Amazon unless Nexus only). */
const landsOf = (r: FollowUpView['results'][number]): 'amazon' | 'nexus' => (r.lands === 'nexus' ? 'nexus' : 'amazon')

/**
 * One waiting row's result: the page's own words for a change (wasteModel.ts appliedWords) — "Saved in Nexus" for a
 * Nexus-only change, "Sending" in its 20 s window, "Sent" only once it ran — or why not. Pure.
 */
export function followUpWords(view: FollowUpView, rowId: string): { ok: boolean; words: string; verb: 'saved' | 'sending' | 'sent' } {
  const mine = view.results.find((r) => r.rowId === rowId)
  if (view.status === 'SENT' && mine?.sent) {
    const set = followUpSetState(view)
    if (set === 'not_run') return { ok: false, words: 'Not sent', verb: 'sent' }
    if (landsOf(mine) === 'nexus') return { ok: true, words: 'Saved in Nexus', verb: 'saved' }
    return set === 'queued' ? { ok: true, words: 'Sending', verb: 'sending' } : { ok: true, words: 'Sent', verb: 'sent' }
  }
  if (view.status === 'CANCELLED') return { ok: false, words: 'Not sent', verb: 'sent' }
  return { ok: false, words: `Not sent: ${(mine?.why ?? view.why ?? 'refused').replace(/\.$/, '')}`, verb: 'sent' }
}

/**
 * The Done line while the negatives wait for their protection's removal, and each waiting row's words then: "sends"
 * only for a negative that goes to Amazon; a Nexus-only one is "saved in Nexus" (wasteModel.ts appliedWords). Pure.
 */
export function followUpWaitWords(waits: ReadonlyArray<Pick<PreviewStep, 'lands'>>): { line: string; row: (s: Pick<PreviewStep, 'lands'>) => string } {
  const amazon = waits.filter((s) => s.lands === 'amazon' || s.lands === 'approval').length
  const then = amazon === waits.length ? 'Nexus sends the negative' : amazon === 0 ? 'Nexus saves the negative in Nexus only' : 'Nexus sends the negatives (some in Nexus only)'
  return {
    line: `Removes the protection in 20 s, then ${then} — you can leave this page · Undo stops both`,
    row: (s) => (s.lands === 'amazon' || s.lands === 'approval' ? 'Nexus sends it once the protection is removed' : 'Saved in Nexus once the protection is removed'),
  }
}

/** The Done line once the follow-up ended: the protection is removed, then the page's own line for the negatives. Pure. */
export function followUpLine(view: FollowUpView | null): string {
  if (!view) return 'Nexus sends the negative once the protection is removed: the row says how it went'
  if (view.status === 'CANCELLED') return 'Not sent'
  if (view.status !== 'SENT') return `Protection removed · not sent: ${(view.why ?? 'refused').replace(/\.$/, '')}`
  const set = followUpSetState(view)
  if (set === 'not_run') return 'Protection removed · the negative did not run'
  const sent = view.results.filter((r) => r.sent).map((r) => ({ refusal: null, lands: landsOf(r) }))
  const line = doneLine(sent, { status: set === 'queued' ? 'queued' : 'applied' })
  return line ? `Protection removed · ${line}` : 'Protection removed'
}

/** The row's own words for its follow-up (its mark and its record). Pure. */
export function followUpSentence(f: NonNullable<WasteRow['followUp']>): string {
  return f.status === 'WAITING' ? 'Its protection is being removed: Nexus sends its negative once it is'
    : `Not stopped after the protection was removed: ${(f.why ?? 'refused').replace(/\.$/, '')}`
}

// ── keys: the Term cell ─────────────────────────────────────────────────────────────────────────────────────────────

interface KeyTarget { closest?: (selector: string) => unknown; querySelector?: (selector: string) => { click(): void } | null }
export interface TermKeyParams { event: { key: string; shiftKey?: boolean; type?: string; target: unknown; preventDefault?: () => void }; editing: boolean }

/** The protected term's chip in the Term cell. */
const PROTECTION_CHIP = '[data-protection-chip]'

/** Term: Shift+Enter opens the protected term's panel; on the chip, its own keys; everything else stays the grid's. */
export function termKeys({ event, editing }: TermKeyParams): boolean {
  const t = event.target as KeyTarget | null
  if (!t || typeof t.closest !== 'function') return false
  if (t.closest(PROTECTION_CHIP)) return true
  if (editing || event.key !== 'Enter' || !event.shiftKey || typeof t.querySelector !== 'function') return false
  const chip = t.querySelector(`${PROTECTION_CHIP} button`)
  if (!chip) return false
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  chip.click()
  return true
}
