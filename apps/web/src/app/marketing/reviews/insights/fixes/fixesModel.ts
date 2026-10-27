/**
 * Reviews › Insights › Fixes — the page's words and rules (build spec §3.4 + ruling 7, the Fixes board). A fix never
 * changes a listing by itself: "Send for approval" turns the ticked fixes into ONE Nexus change plan a person approves on
 * the Approvals page; a Task is created without approval and changes nothing on a channel; there is no direct Apply.
 *
 * The status tabs and kind chips in the address, each fix's card (why, what it proposes, where it goes, what it waits
 * for), the way out of a held fix, the bulk bar (Send N for approval, held while a ticked fix cannot be sent — naming
 * it — Dismiss), and the toasts in the server's count. The held reasons are the API's (`review-fix-plan.service.ts`
 * `listHeld`, `statusHeld`). Pure, tested in fixesModel.vitest.test.ts.
 */
import { inboxHref, insightsHref } from '../../_lib/reviewsLinks'
import { channelMarketWords } from '../../_lib/reviewWords'
import type { InsightsScope } from '../_shared/insightsScope'

// ── The API's answer ────────────────────────────────────────────────

export const FIX_KINDS = ['BULLETS', 'APLUS', 'SIZE_GUIDE', 'RECALL_FLAG', 'TASK'] as const
export type FixKind = (typeof FIX_KINDS)[number]
export const FIX_STATUSES = ['OPEN', 'SENT', 'APPLIED', 'DISMISSED'] as const
export type FixStatus = (typeof FIX_STATUSES)[number]

export interface FixItem {
  id: string
  kind: FixKind
  kindWords: string
  status: FixStatus
  title: string
  detail: string | null
  product: { id: string; sku: string; name: string } | null
  market: string | null
  theme: { key: string; label: string } | null
  spikeId: string | null
  proposal: { bullets?: string[]; module?: { headline: string; body: string } | null; language: string; english?: unknown; days?: number }
  held: string | null
  plan: { approvalId: string; state: string; words: string; sentBy: string | null; sentAt: string | null; expiresAt: string | null } | null
  task: { createdBy: string | null; createdAt: string | null; assignee: string | null } | null
  applied: { words: string; at: string | null; approvalId: string | null } | null
  lastSend: { words: string; at: string | null } | null
  source: string
  createdBy: string | null
  createdAt: string
}

export interface FixesAnswer {
  items: FixItem[]
  count: number
  counts: Record<FixStatus, number>
}

export interface ProposeAnswer {
  changed: number
  held: Array<{ id: string; words: string }>
  sent: { approvalId: string; fixes: number; steps: number; expiresAt: string | null; summary: string | null } | null
  tasks: number
}

// ── Tabs and kinds in the address ───────────────────────────────────

export const STATUS_TABS: Array<{ id: FixStatus; label: string }> = [
  { id: 'OPEN', label: 'Open' },
  { id: 'SENT', label: 'Sent for approval' },
  { id: 'APPLIED', label: 'Applied' },
  { id: 'DISMISSED', label: 'Dismissed' },
]

export function parseFixStatus(raw: string | null | undefined): FixStatus {
  const value = (raw ?? '').trim().toUpperCase()
  return (FIX_STATUSES as readonly string[]).includes(value) ? (value as FixStatus) : 'OPEN'
}

/** `?kind=BULLETS,APLUS` → the kinds shown; none (or none known) = every kind. */
export function parseKinds(raw: string | null | undefined): FixKind[] {
  const wanted = (raw ?? '').split(',').map((k) => k.trim().toUpperCase())
  return FIX_KINDS.filter((k) => wanted.includes(k))
}

export const KIND_CHIPS: Array<{ kind: FixKind; label: string }> = [
  { kind: 'BULLETS', label: 'Bullets' },
  { kind: 'APLUS', label: 'A+ content' },
  { kind: 'SIZE_GUIDE', label: 'Size guide' },
  { kind: 'RECALL_FLAG', label: 'Recall check' },
  { kind: 'TASK', label: 'Task' },
]

/** A kind chip press: on, or off when it is on. */
export function toggleKind(kinds: readonly FixKind[], kind: FixKind): FixKind[] {
  return kinds.includes(kind) ? kinds.filter((k) => k !== kind) : FIX_KINDS.filter((k) => k === kind || kinds.includes(k))
}

/** The newest fixes the page reads at once; the tabs, kind chips and market are applied here, so every count agrees. */
export const FIXES_READ_LIMIT = 300

/** What GET /api/reviews/action-items reads: every status of the business (or of one product), newest first. */
export function fixesApiParams(product: string | null): Record<string, string | null> {
  return { productId: product, limit: String(FIXES_READ_LIMIT) }
}

export interface FixesView {
  status: FixStatus
  kinds: readonly FixKind[]
  /** The scope's market: a fix for another market is not listed (a fix with no market always is). */
  market: string | null
}

const inView = (f: FixItem, v: Omit<FixesView, 'status'>) => (v.kinds.length === 0 || v.kinds.includes(f.kind)) && (!v.market || !f.market || f.market === v.market)

/** The fixes a tab lists. */
export function filterFixes(items: readonly FixItem[], view: FixesView): FixItem[] {
  return items.filter((f) => f.status === view.status && inView(f, view))
}

/** Each tab's count, after the kind chips and the market. */
export function tabCounts(items: readonly FixItem[], view: Omit<FixesView, 'status'>): Record<FixStatus, number> {
  const counts = { OPEN: 0, SENT: 0, APPLIED: 0, DISMISSED: 0 } as Record<FixStatus, number>
  for (const f of items) if (inView(f, view) && f.status in counts) counts[f.status] += 1
  return counts
}

// ── One fix ─────────────────────────────────────────────────────────

export const STATUS_PILL: Record<FixStatus, { word: string; tone: 'info' | 'warning' | 'success' | 'neutral' }> = {
  OPEN: { word: 'Open', tone: 'info' },
  SENT: { word: 'Waiting for approval', tone: 'warning' },
  APPLIED: { word: 'Applied', tone: 'success' },
  DISMISSED: { word: 'Dismissed', tone: 'neutral' },
}

const LANGUAGE: Record<string, string> = { en: 'English', de: 'German', it: 'Italian', fr: 'French', es: 'Spanish', nl: 'Dutch', pl: 'Polish', sv: 'Swedish' }
export const languageWords = (code: string) => LANGUAGE[code] ?? code.toUpperCase()

/** Where a fix goes when it is approved, in words (tags on the card). */
export function targetWords(fix: Pick<FixItem, 'kind' | 'market' | 'proposal'>): string[] {
  const market = fix.market ? channelMarketWords('AMAZON', fix.market) : null
  if (fix.kind === 'BULLETS') return [`Product text · ${languageWords(fix.proposal.language)}`, 'every channel that shows these bullets']
  if (fix.kind === 'APLUS') return [market ? `${market} · A+ content` : 'Amazon · A+ content', 'a draft Amazon checks']
  if (fix.kind === 'RECALL_FLAG') return ['Stock hold · your own warehouses only', 'never Amazon FBA stock']
  if (fix.kind === 'SIZE_GUIDE') return ['Size guide · coming later']
  return ['A task: nothing changes on a channel']
}

/** What the fix proposes, as lines to show. */
export function proposalLines(fix: Pick<FixItem, 'kind' | 'proposal' | 'detail'>): { heading: string; lines: string[] } {
  const p = fix.proposal
  if (fix.kind === 'BULLETS') return { heading: `Proposed bullets (${languageWords(p.language)})`, lines: p.bullets?.length ? p.bullets : ['No bullet points yet: edit the proposal.'] }
  if (fix.kind === 'APLUS') return { heading: `Proposed A+ text (${languageWords(p.language)})`, lines: p.module ? [p.module.headline, p.module.body].filter(Boolean) : ['No headline or text yet: edit the proposal.'] }
  if (fix.kind === 'RECALL_FLAG') return { heading: 'Proposed stock hold', lines: [`Hold the available units in your own warehouses for ${p.days ?? 14} days, while the complaint is checked. Amazon FBA stock is never held from here.`] }
  return { heading: fix.kind === 'TASK' ? 'The task' : 'Proposed', lines: [fix.detail ?? 'No details.'] }
}

/** What the text means in English, when it is in another language (the person who approves reads it). */
export function englishLines(fix: Pick<FixItem, 'proposal'>): string[] | null {
  const e = fix.proposal.english
  if (fix.proposal.language === 'en' || e == null) return null
  if (Array.isArray(e)) return e.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
  return typeof e === 'string' && e.trim() ? [e.trim()] : null
}

/** "Written by AI from the reviews · 2 days ago". */
export function metaWords(fix: Pick<FixItem, 'source' | 'createdAt'>, now: number): string {
  const days = Math.floor((now - new Date(fix.createdAt).getTime()) / 86_400_000)
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
  const who = /ai|auto|spike|suggest/i.test(fix.source) ? 'Written by AI from the reviews' : 'Added by a person'
  return `${who} · ${when}`
}

/** The evidence link: the alert it came from (Alerts), or the theme's reviews (the Inbox). */
export function evidenceLink(fix: Pick<FixItem, 'spikeId' | 'theme' | 'market' | 'product'>, scope: Pick<InsightsScope, 'channel' | 'market' | 'period'>): { label: string; href: string } | null {
  if (fix.spikeId) return { label: 'The alert it came from', href: insightsHref('alerts', { status: 'ALL', product: fix.product?.id ?? null, channel: scope.channel, market: fix.market ?? scope.market, period: scope.period }) }
  if (fix.theme) return { label: `Reviews about ${fix.theme.label}`, href: inboxHref({ theme: fix.theme.key, market: fix.market, q: fix.product?.sku ?? null, period: scope.period }) }
  return null
}

/**
 * The way out of a held fix, from its reason: edit the proposal, make it a task, or dismiss it. The reason itself is the
 * API's; this only picks the button that answers it.
 */
export function wayOut(held: string): 'edit' | 'task' | 'dismiss' {
  if (/edit the proposal|english/i.test(held)) return 'edit'
  if (/task/i.test(held)) return 'task'
  return 'dismiss'
}

export const WAY_OUT_LABEL: Record<'edit' | 'task' | 'dismiss', string> = { edit: 'Edit the proposal', task: 'Create task instead', dismiss: 'Dismiss' }

/** "Send for approval" on one card; a Task is created, never sent. */
export function sendLabel(fix: Pick<FixItem, 'kind'>): string {
  return fix.kind === 'TASK' ? 'Create task' : 'Send for approval'
}

/** Withdraw only while the plan waits (or is scheduled); afterwards it is undone from the plan. */
export function withdrawHeld(fix: Pick<FixItem, 'plan'>): string | null {
  if (!fix.plan) return 'It is not waiting for approval.'
  if (fix.plan.state === 'waiting' || fix.plan.state === 'scheduled') return null
  if (fix.plan.state === 'running' || fix.plan.state === 'done') return 'It was approved already: undo it from its change plan on the Approvals page.'
  return 'It is not waiting any more.'
}

/** A Sent fix's line: "Change plan waits on the Approvals page · sent by Teammate A · expires 28 Oct". */
export function sentWords(fix: Pick<FixItem, 'plan'>): string {
  const p = fix.plan
  if (!p) return 'Sent for approval'
  const parts = [p.words]
  if (p.sentBy) parts.push(`sent by ${p.sentBy}`)
  if (p.expiresAt && p.state === 'waiting') parts.push(`expires ${new Date(p.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`)
  return parts.join(' · ')
}

/** An Applied or Dismissed fix's line. */
export function doneWords(fix: Pick<FixItem, 'status' | 'applied' | 'task'>): string {
  if (fix.status === 'APPLIED') {
    const at = fix.applied?.at ? ` · ${new Date(fix.applied.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''
    return `${fix.applied?.words ?? 'Applied'}${at}`
  }
  return 'Dismissed: nothing was sent'
}

/** The tab's empty title. */
export function emptyTitle(status: FixStatus, filtered: boolean): string {
  if (filtered) return 'No fixes of these kinds here'
  if (status === 'OPEN') return 'No open fixes'
  if (status === 'SENT') return 'Nothing waits for approval'
  if (status === 'APPLIED') return 'No fix applied yet'
  return 'No dismissed fixes'
}

// ── The bulk bar (Open tab, ruling 7) ───────────────────────────────

export const MANAGE_FIXES = "You need 'Manage reviews' to send or dismiss fixes."

export interface SendPlan {
  /** Fixes that go into the ONE change plan. */
  send: string[]
  /** Tasks, created at once without approval. */
  tasks: string[]
  /** Ticked fixes that cannot be sent, with the API's reason. */
  blocked: Array<{ id: string; title: string; words: string }>
}

export function sendPlan(selected: readonly FixItem[]): SendPlan {
  const plan: SendPlan = { send: [], tasks: [], blocked: [] }
  for (const f of selected) {
    if (f.status !== 'OPEN') plan.blocked.push({ id: f.id, title: f.title, words: f.status === 'SENT' ? 'Already sent for approval.' : f.status === 'APPLIED' ? 'Already applied.' : 'Dismissed: bring it back first.' })
    else if (f.kind === 'TASK') plan.tasks.push(f.id)
    else if (f.held) plan.blocked.push({ id: f.id, title: f.title, words: f.held })
    else plan.send.push(f.id)
  }
  return plan
}

/** "Send 3 for approval", "Send 2 for approval + 1 task", "Create 2 tasks". */
export function sendBulkLabel(plan: SendPlan): string {
  const tasks = plan.tasks.length
  if (plan.send.length === 0 && tasks > 0) return `Create ${tasks} ${tasks === 1 ? 'task' : 'tasks'}`
  const base = plan.send.length ? `Send ${plan.send.length} for approval` : 'Send for approval'
  return tasks ? `${base} + ${tasks} ${tasks === 1 ? 'task' : 'tasks'}` : base
}

/**
 * Why the bulk Send is held (null = it can send): the permission; then a ticked fix that cannot be sent — named, with
 * its reason, so the person unticks it and sends the rest (the Owner's rule: one plan, never a silent partial send).
 */
export function sendBulkHeld(canManage: boolean, plan: SendPlan): string | null {
  if (!canManage) return MANAGE_FIXES
  const first = plan.blocked[0]
  if (first) {
    const more = plan.blocked.length - 1
    return `“${first.title}” cannot be sent: ${first.words} Untick it to send the rest${more > 0 ? ` (and ${more} more like it)` : ''}.`
  }
  if (plan.send.length === 0 && plan.tasks.length === 0) return 'Tick at least one fix.'
  return null
}

/** The tip on a Send that can go: what happens. */
export function sendBulkTip(plan: SendPlan): string {
  const parts: string[] = []
  if (plan.send.length) parts.push(`One change plan with ${plan.send.length} ${plan.send.length === 1 ? 'fix' : 'fixes'}: a person who may approve changes decides it on the Approvals page; only then does Nexus change anything.`)
  if (plan.tasks.length) parts.push(`${plan.tasks.length} ${plan.tasks.length === 1 ? 'task is' : 'tasks are'} created at once, without approval: nothing changes on a channel.`)
  return parts.join(' ')
}

/** Dismiss the ticked open fixes; held without the permission or with nothing open ticked. */
export function dismissBulkHeld(canManage: boolean, selected: readonly FixItem[]): string | null {
  if (!canManage) return MANAGE_FIXES
  if (!selected.some((f) => f.status === 'OPEN')) return 'No ticked fix is open: only an open fix can be dismissed.'
  return null
}

/** The toast after Send, in the server's count. */
export function proposeResultWords(answer: ProposeAnswer): string {
  const parts: string[] = []
  if (answer.sent) parts.push(`${answer.sent.fixes} ${answer.sent.fixes === 1 ? 'fix' : 'fixes'} sent for approval in one change plan (${answer.sent.steps} ${answer.sent.steps === 1 ? 'step' : 'steps'})`)
  if (answer.tasks) parts.push(`${answer.tasks} ${answer.tasks === 1 ? 'task' : 'tasks'} created`)
  if (parts.length === 0) parts.push('Nothing was sent')
  const held = answer.held.length ? ` · ${answer.held.length} held: ${[...new Set(answer.held.map((h) => h.words))].join(' ')}` : ''
  return `${parts.join(' · ')}${held}`
}

/** The toast after Dismiss. */
export function dismissResultWords(changed: number, held: ReadonlyArray<{ words: string }>): string {
  const done = `${changed} ${changed === 1 ? 'fix' : 'fixes'} dismissed`
  return held.length ? `${done} · ${held.length} left out: ${[...new Set(held.map((h) => h.words))].join(' ')}` : done
}

// ── Edit the proposal ───────────────────────────────────────────────

export const EDIT_LANGUAGES = ['en', 'de', 'it', 'fr', 'es', 'nl', 'pl', 'sv'] as const

export interface FixForm {
  title: string
  /** Bullets: one per line. */
  bullets: string
  headline: string
  body: string
  language: string
  /** What the text says in English (bullets: one per line). */
  english: string
  days: number
}

/** The edit window's fields, from the fix as it is. */
export function fixForm(fix: Pick<FixItem, 'title' | 'proposal'>): FixForm {
  const p = fix.proposal
  const e = p.english
  return {
    title: fix.title,
    bullets: (p.bullets ?? []).join('\n'),
    headline: p.module?.headline ?? '',
    body: p.module?.body ?? '',
    language: p.language,
    english: Array.isArray(e) ? e.filter((x) => typeof x === 'string').join('\n') : typeof e === 'string' ? e : '',
    days: p.days ?? 14,
  }
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean)

/**
 * What PATCH /api/reviews/action-items/:id gets: only the fields that changed, checked the way the API checks them, or
 * the first problem in words. Nothing changed → `{ body: null, error: null }` (Save stays held).
 */
export function fixEditBody(fix: Pick<FixItem, 'kind' | 'title' | 'proposal'>, form: FixForm): { body: Record<string, unknown> | null; error: string | null } {
  const before = fixForm(fix)
  const body: Record<string, unknown> = {}
  const title = form.title.trim()
  if (!title || title.length > 200) return { body: null, error: 'The title needs 1 to 200 characters.' }
  if (title !== before.title.trim()) body.title = title
  if (fix.kind === 'BULLETS' || fix.kind === 'APLUS') {
    if (form.language !== before.language) body.language = form.language
    const english = fix.kind === 'BULLETS' ? lines(form.english) : form.english.trim()
    const englishBefore = fix.kind === 'BULLETS' ? lines(before.english) : before.english.trim()
    if (form.language !== 'en' && JSON.stringify(english) !== JSON.stringify(englishBefore)) {
      if (Array.isArray(english) ? english.length === 0 : !english) return { body: null, error: 'Say what the text means in English: the person who approves reads it.' }
      body.english = english
    }
  }
  if (fix.kind === 'BULLETS') {
    const bullets = lines(form.bullets)
    if (bullets.length === 0 || bullets.length > 10) return { body: null, error: 'Write 1 to 10 bullet points, one per line.' }
    const long = bullets.findIndex((b) => b.length > 500)
    if (long >= 0) return { body: null, error: `Bullet ${long + 1} is ${bullets[long].length - 500} characters too long (500 at most).` }
    if (JSON.stringify(bullets) !== JSON.stringify(lines(before.bullets))) body.bullets = bullets
  }
  if (fix.kind === 'APLUS') {
    const headline = form.headline.trim()
    const text = form.body.trim()
    if (!headline || headline.length > 150) return { body: null, error: 'The headline needs 1 to 150 characters.' }
    if (!text || text.length > 2000) return { body: null, error: 'The text needs 1 to 2,000 characters.' }
    if (headline !== before.headline.trim() || text !== before.body.trim()) body.module = { headline, body: text }
  }
  if (fix.kind === 'RECALL_FLAG') {
    if (!Number.isInteger(form.days) || form.days < 1 || form.days > 90) return { body: null, error: 'Hold for 1 to 90 days.' }
    if (form.days !== before.days) body.days = form.days
  }
  return { body: Object.keys(body).length ? body : null, error: null }
}
