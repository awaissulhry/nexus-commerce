/**
 * Reviews › Settings — what the page shows, in words, from what the API answers: the sections' problem counts, the
 * Sources rows' links, the pipeline's times, the review automations' last runs, the templates grid, and the unsubscribe
 * list with its bulk bar (build spec ruling 7: Remove counts only bounced and hand-added addresses; when every ticked
 * address is a buyer's own unsubscribe, Remove is held — "Only the buyer can undo that"). Pure; tested in
 * settingsModel.vitest.test.ts.
 */
import { inboxHref, requestsHref, type ReviewsSettingsSection } from '../../_lib/reviewsLinks'

// ── Answers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type SourceTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

export interface SourceRow {
  key: string
  name: string
  what: string
  stateWords: string
  tone: SourceTone
  words: string
  later: string | null
  lastAt: string | null
  lastWords: string | null
  action: { kind: 'rules' | 'reconnect' | 'connect' | 'import'; label: string; href: string | null } | null
}

export interface SourcesResponse {
  rows: SourceRow[]
  problems: number
  checkedAt: string
}

export interface PipelineJob {
  key: string
  name: string
  what: string
  every: string
  lastRunAt: string | null
  nextRunAt: string | null
  state: 'healthy' | 'running' | 'stuck' | 'failed' | 'late' | 'partial' | 'never' | 'off'
  stateWords: string
  tone: SourceTone
  code: string | null
  words: string
}

export interface PipelineResponse {
  jobs: PipelineJob[]
  problems: string[]
  troubled: number
  stuck: number
  checkedAt: string
}

export interface AutomationRule {
  id: string
  name: string
  description: string | null
  enabled: boolean
  dryRun: boolean
  lastEvaluatedAt: string | null
  lastMatchedAt: string | null
  matchCount: number
}

export interface ReplyTemplateRow {
  id: string
  name: string
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY' | null
  bodies: Partial<Record<'it' | 'de' | 'fr' | 'es' | 'en', string>>
  languages: Array<'it' | 'de' | 'fr' | 'es' | 'en'>
  usedCount: number
  updatedAt: string
}

export interface SuppressionRow {
  id: string
  email: string
  channel: string | null
  source: string
  reason: string | null
  createdAt: string
}

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const SECTIONS: ReadonlyArray<{ id: ReviewsSettingsSection; label: string }> = [
  { id: 'sources', label: 'Sources' },
  { id: 'emails', label: 'Emails & unsubscribes' },
  { id: 'templates', label: 'Reply templates & voice' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'automations', label: 'Automations' },
  { id: 'pipeline', label: 'Pipeline health' },
]

/** `?section=` → a section the page has; anything else → null (the page opens at the top). */
export function sectionFromSearch(search: string): ReviewsSettingsSection | null {
  const value = new URLSearchParams(search).get('section')
  return SECTIONS.some((s) => s.id === value) ? (value as ReviewsSettingsSection) : null
}

/** The count a section shows in the strip ("Sources 2"), with its spoken words; null when nothing needs a person. */
export function sectionFlag(id: ReviewsSettingsSection, counts: { sources: number | null; pipeline: number | null }): { count: number; words: string } | null {
  if (id === 'sources' && counts.sources) {
    return { count: counts.sources, words: counts.sources === 1 ? '1 source needs attention' : `${counts.sources} sources need attention` }
  }
  if (id === 'pipeline' && counts.pipeline) {
    return { count: counts.pipeline, words: counts.pipeline === 1 ? '1 problem in the pipeline' : `${counts.pipeline} problems in the pipeline` }
  }
  return null
}

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a source's action goes: the Reviews pages through reviewsLinks.ts, Settings › Channels as the API says. */
export function sourceActionHref(action: SourceRow['action']): string | null {
  if (!action) return null
  if (action.kind === 'rules') return requestsHref()
  if (action.kind === 'import') return inboxHref({ import: 1 })
  return action.href
}

// ── Times ────────────────────────────────────────────────────────────────────────────────────────────────────────

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "Today 13:00", "Tomorrow 03:30", "Mon 2 Nov 06:00", in this browser's time zone; "—" for none. */
export function timeWords(iso: string | null, now: Date): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const clock = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (sameDay(at, now)) return `Today ${clock}`
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(at, tomorrow)) return `Tomorrow ${clock}`
  if (sameDay(at, yesterday)) return `Yesterday ${clock}`
  return `${at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')} ${clock}`
}

/** "26 Oct 2026". */
export function dayWords(iso: string | null): string {
  if (!iso) return '—'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Pipeline ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The banner over the jobs: what needs a person, or null when every job is fine. */
export function pipelineSummary(p: Pick<PipelineResponse, 'jobs' | 'problems'>): { title: string; words: string[] } | null {
  const stuck = p.jobs.filter((j) => j.state === 'stuck')
  const failed = p.jobs.filter((j) => j.state === 'failed')
  const late = p.jobs.filter((j) => j.state === 'late' || j.state === 'partial')
  const parts: string[] = []
  if (stuck.length) parts.push(stuck.length === 1 ? '1 job is stuck' : `${stuck.length} jobs are stuck`)
  if (failed.length) parts.push(failed.length === 1 ? '1 failed' : `${failed.length} failed`)
  if (late.length) parts.push(late.length === 1 ? '1 is late' : `${late.length} are late`)
  if (!parts.length && !p.problems.length) return null
  const title = parts.length ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}` : 'The pipeline needs attention'
  const words = [
    ...[...stuck, ...failed, ...late].map((j) => `${j.name}: ${j.words}`),
    ...p.problems,
  ]
  return { title, words }
}

export const NO_STUCK_JOB = 'No job is stuck.'

// ── Automations ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The last-run cell: when, and what came of it. */
export function automationLastRun(rule: AutomationRule, now: Date): { when: string; result: string } {
  if (!rule.lastEvaluatedAt) return { when: 'Never run', result: rule.enabled ? 'waits for its first run' : 'off' }
  const result = rule.matchCount > 0 ? `${rule.matchCount.toLocaleString('en-US')} matched so far` : 'nothing matched yet'
  return { when: timeWords(rule.lastEvaluatedAt, now), result }
}

/** "Load templates (3)" and why it is held when every template is loaded. */
export function loadTemplatesButton(t: { total: number; missing: number }): { label: string; held: string | null } {
  return t.missing > 0
    ? { label: `Load templates (${t.missing})`, held: null }
    : { label: 'Load templates', held: `All ${t.total} review automation templates are loaded.` }
}

// ── Templates ────────────────────────────────────────────────────────────────────────────────────────────────────

const CHANNEL_WORD: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }

export function templateChannelWords(channel: string | null): string {
  return channel ? (CHANNEL_WORD[channel] ?? channel) : 'All channels'
}

export function templateLanguagesWords(languages: readonly string[]): string {
  return languages.map((l) => l.toUpperCase()).join(' · ') || '—'
}

// ── Unsubscribe list ─────────────────────────────────────────────────────────────────────────────────────────────

/** Sources the BUYER put on the list (the API refuses to remove them too). */
export const BUYER_SOURCES: ReadonlySet<string> = new Set(['UNSUBSCRIBE_LINK', 'COMPLAINT', 'GDPR_REQUEST'])

export const BUYER_HELD = 'The buyer put this address on the list. Only the buyer can undo that.'

export function canRemove(row: Pick<SuppressionRow, 'source'>): boolean {
  return !BUYER_SOURCES.has(row.source.toUpperCase())
}

/** "g••••••@gmail.com": the first character and the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return email
  const local = email.slice(0, at)
  return `${local[0]}${'•'.repeat(Math.min(6, Math.max(2, local.length - 1)))}${email.slice(at)}`
}

/** Why the address is on the list, in words. */
export function suppressionWhy(row: Pick<SuppressionRow, 'source' | 'reason'>): string {
  const reason = row.reason?.trim()
  switch (row.source.toUpperCase()) {
    case 'UNSUBSCRIBE_LINK': return 'Clicked unsubscribe'
    case 'COMPLAINT': return 'Marked our e-mail as spam'
    case 'GDPR_REQUEST': return 'Asked by privacy request'
    case 'BOUNCE_HARD': return reason ? `E-mail bounced — ${reason}` : 'E-mail bounced — the address does not exist'
    case 'MANUAL': return reason ? `Added by hand — ${reason}` : 'Added by hand'
    default: return reason || 'On the list'
  }
}

/** Which of our e-mails the row stops. */
export function suppressionScope(channel: string | null): string {
  if (!channel) return 'Every review e-mail'
  if (channel === 'review-request') return 'Review requests'
  if (channel === 'review-sentiment-check') return '“How was it?” e-mails'
  return channel
}

export interface RemovePlan {
  /** The ticked rows Remove takes off. */
  ids: string[]
  /** Ticked rows that stay (the buyer's own). */
  kept: number
  label: string
  /** Remove is held: every ticked address is the buyer's own. */
  held: string | null
  /** Some ticked rows stay: said beside the button. */
  note: string | null
}

/** What "Remove…" does with the ticked rows (ruling 7): it counts the rows it changes; held when it changes none. */
export function removePlan(ticked: readonly SuppressionRow[]): RemovePlan {
  const removable = ticked.filter(canRemove)
  const kept = ticked.length - removable.length
  const n = removable.length
  if (n === 0) {
    return {
      ids: [], kept, label: 'Remove…', note: null,
      held: kept === 0 ? 'Tick the addresses to remove first.'
        : kept === 1 ? 'The ticked address was put on the list by the buyer and stays there. Only the buyer can undo that.'
          : `All ${kept} ticked addresses were put on the list by the buyer and stay there. Only the buyer can undo that.`,
    }
  }
  return {
    ids: removable.map((r) => r.id), kept, held: null,
    label: kept > 0 ? `Remove ${n}…` : 'Remove…',
    note: kept > 0
      ? `${kept === 1 ? '1 ticked address was' : `${kept} ticked addresses were`} put on the list by the buyer and ${kept === 1 ? 'stays' : 'stay'}. Remove takes off the other ${n === 1 ? 'one' : n} (bounced or added by hand).`
      : null,
  }
}

export function removeConfirmWords(n: number): string {
  return `${n === 1 ? 'This address' : `These ${n} addresses`} can get our review e-mails again from the next send. Addresses the buyer put on the list are never removed.`
}

export function removedWords(removed: number, kept: number): string {
  const head = removed === 1 ? 'Removed 1 address from the list.' : `Removed ${removed} addresses from the list.`
  return kept > 0 ? `${head} ${kept === 1 ? '1 stays' : `${kept} stay`}: only the buyer can undo that.` : head
}

/** The first rows, or all of them. */
export function visibleSuppressions<T>(rows: readonly T[], showAll: boolean, first = 10): T[] {
  return showAll ? [...rows] : rows.slice(0, first)
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** The ticked addresses as a CSV file: address, why, which e-mails, since. */
export function suppressionsCsv(rows: readonly SuppressionRow[]): string {
  const lines = [['Address', 'Why', 'Stops', 'Since'].join(',')]
  for (const r of rows) lines.push([r.email, suppressionWhy(r), suppressionScope(r.channel), r.createdAt.slice(0, 10)].map(csvCell).join(','))
  return `${lines.join('\n')}\n`
}

/** A typed address is one Nexus can put on the list. */
export function addressProblem(email: string): string | null {
  const t = email.trim()
  if (!t) return 'Type the e-mail address.'
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? null : 'This does not look like an e-mail address.'
}
