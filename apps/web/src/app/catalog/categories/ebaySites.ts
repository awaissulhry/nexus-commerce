/**
 * "Fill other eBay sites" (Categories workspace, the Owner's D1 = A, 2026-09-27): the dialog's words, defaults and
 * requests, kept out of the component so they are testable in Node.
 *
 * The API (`apps/api/src/services/pim/mapping/ebay-site-*.service.ts`) proposes up to three categories per eBay site
 * with no category; the operator confirms each site; the save goes through the workspace's own review → activation
 * path. Nothing is sent to eBay.
 */
import type { ListboxOption } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { commandConflictMessage, sendCommand, type CommandKey, type CommandResponse } from '@/lib/command-key'

export type SuggestionReason = 'same_id' | 'same_name' | 'ebay_suggestion'
export interface SiteCandidate { categoryId: string; path: string; reasons: SuggestionReason[] }
export interface SiteSuggestion { market: string; treeReady: boolean; candidates: SiteCandidate[]; defaultCategoryId: string | null }
export interface EbaySiteSuggestions {
  categoryId: string
  categoryName: string
  productTitle: string | null
  source: { market: string; channelCategoryId: string; path: string | null } | null
  assignedSites: string[]
  sites: SiteSuggestion[]
  ebay: { available: boolean; message: string | null }
}
export interface SiteCoverage { sites: string[]; fillable: Record<string, { assigned: string[]; missing: string[] }> }
export interface AssignResult { market: string; channelCategoryId: string; outcome: 'assigned' | 'failed'; reason?: string; assignedAt?: string }
export interface UndoResult { market: string; channelCategoryId: string; outcome: 'removed' | 'unchanged' | 'failed'; reason?: string }

/** One site's choice: a category, or null to leave the site empty. */
export type Choice = SiteCandidate | null
export type Choices = Record<string, Choice>

export const LEAVE_EMPTY = ''
export const SEARCH = '__search__'
export const REASON_LABELS: Record<SuggestionReason, string> = { same_id: 'Same number', same_name: 'Same name', ebay_suggestion: 'eBay suggests' }

export const coveragePath = 'category-workspace/EBAY/site-coverage'
export const suggestionsPath = (categoryId: string) => `category-workspace/EBAY/site-suggestions?${new URLSearchParams({ categoryId })}`
export const siteLabel = (market: string) => `eBay · ${market}`

/** Why a category was suggested, in plain words. A category found by search has no reason. */
export function whyLabel(choice: Choice): string {
  if (!choice) return '—'
  return choice.reasons.length ? choice.reasons.map(reason => REASON_LABELS[reason]).join(' · ') : 'Your search'
}

/** The dialog's one summary line. */
export function summaryLine(data: Pick<EbaySiteSuggestions, 'categoryName' | 'source'>): string {
  const where = data.source
    ? `${data.categoryName} is on eBay ${data.source.market} as ${data.source.channelCategoryId}${data.source.path ? ` · ${data.source.path}` : ''}.`
    : `${data.categoryName} has no eBay category yet.`
  return `${where} Choose the category for the other sites. Nothing is sent to eBay.`
}

/** Each site starts on its suggested default, or empty when there is none. */
export function defaultChoices(sites: readonly SiteSuggestion[]): Choices {
  return Object.fromEntries(sites.map(site => [site.market, site.candidates.find(c => c.categoryId === site.defaultCategoryId) ?? null]))
}

/** The sites the primary button will assign, in the table's order. */
export function chosenAssignments(sites: readonly SiteSuggestion[], choices: Choices): Array<{ market: string; channelCategoryId: string }> {
  return sites.flatMap(site => { const choice = choices[site.market]; return choice ? [{ market: site.market, channelCategoryId: choice.categoryId }] : [] })
}

/** The counted primary button. */
export function assignLabel(count: number): string {
  return count ? `Assign ${count} ${count === 1 ? 'site' : 'sites'}` : 'Nothing to assign'
}

/** One site's Category options: its candidates, a category found by search, Search…, and Leave empty. */
export function siteOptions(site: SiteSuggestion, choice: Choice): ListboxOption[] {
  const option = (c: SiteCandidate): ListboxOption => ({ value: c.categoryId, label: `${c.categoryId} · ${c.path.split(' › ').pop() ?? c.path}`, title: `${c.path}\nID: ${c.categoryId}`, searchText: `${c.path} ${c.categoryId}` })
  const listed = site.candidates.map(option)
  if (choice && !site.candidates.some(c => c.categoryId === choice.categoryId)) listed.push(option(choice))
  return [...listed, { value: SEARCH, label: 'Search…' }, { value: LEAVE_EMPTY, label: 'Leave empty' }]
}

/** What the Path column says for a site. */
export function pathText(site: SiteSuggestion, choice: Choice): string {
  if (choice) return choice.path
  return site.treeReady ? 'Left empty' : `The ${siteLabel(site.market)} category list is not downloaded. Refresh it in Taxonomy updates.`
}

/** The rows one save created, for its Undo. */
export function undoRows(results: readonly AssignResult[]): Array<{ market: string; channelCategoryId: string; assignedAt: string }> {
  return results.flatMap(r => r.outcome === 'assigned' && r.assignedAt ? [{ market: r.market, channelCategoryId: r.channelCategoryId, assignedAt: r.assignedAt }] : [])
}

/** The Done state's headline. */
export function doneView(results: readonly AssignResult[]): { tone: 'success' | 'warning' | 'danger'; title: string } {
  const assigned = results.filter(r => r.outcome === 'assigned').length
  const failed = results.length - assigned
  const sites = (n: number) => `${n} ${n === 1 ? 'site' : 'sites'}`
  if (!failed) return { tone: 'success', title: `Assigned ${sites(assigned)}. Nothing was sent to eBay.` }
  if (!assigned) return { tone: 'danger', title: `Nothing was assigned. ${sites(failed)} could not be assigned.` }
  return { tone: 'warning', title: `Assigned ${sites(assigned)}. ${sites(failed)} could not be assigned.` }
}

export const ASSIGN_OUTCOME: Record<AssignResult['outcome'], string> = { assigned: 'Assigned', failed: 'Not assigned' }
export const UNDO_OUTCOME: Record<UndoResult['outcome'], string> = { removed: 'Removed', unchanged: 'Left as it is', failed: 'Not removed' }

export function undoView(results: readonly UndoResult[]): { tone: 'success' | 'warning'; title: string } {
  const removed = results.filter(r => r.outcome === 'removed').length
  return removed === results.length
    ? { tone: 'success', title: `Undone. ${removed} ${removed === 1 ? 'assignment was' : 'assignments were'} removed.` }
    : { tone: 'warning', title: `${removed} of ${results.length} assignments removed. The others are listed below.` }
}

const url = () => `${getBackendUrl()}/api/pim/category-workspace/EBAY/site-assignments`
const NO_ANSWER = 'No answer from the server. The assignments may still be running: wait a moment, then reload Channel assignments before trying again.'

/** Save the chosen sites. One key per press (`COMMAND_SCOPES`), so a double-click cannot run it twice. */
export async function assignSites(slot: CommandKey, categoryId: string, assignments: Array<{ market: string; channelCategoryId: string }>): Promise<AssignResult[]> {
  let sent: CommandResponse<{ results?: AssignResult[]; error?: string }>
  try {
    sent = await sendCommand<{ results?: AssignResult[]; error?: string }>(slot, url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryId, assignments }) })
  } catch { throw new Error(NO_ANSWER) }
  if (sent.conflict) throw new Error(commandConflictMessage(sent.conflict, 'assignment'))
  if (!sent.response.ok || !Array.isArray(sent.body?.results)) throw new Error(sent.body?.error ?? 'The sites could not be assigned. Try again.')
  return sent.body.results
}

/** Undo one save: removes only the rows it created, and only while they are unchanged. */
export async function undoSites(categoryId: string, assignments: Array<{ market: string; channelCategoryId: string; assignedAt: string }>): Promise<UndoResult[]> {
  let response: Response
  try {
    response = await fetch(url(), { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categoryId, assignments }) })
  } catch { throw new Error('No answer from the server. Reload Channel assignments to see what was removed.') }
  const body = await response.json().catch(() => null) as { results?: UndoResult[]; error?: string } | null
  if (!response.ok || !Array.isArray(body?.results)) throw new Error(body?.error ?? 'The assignments could not be removed. Try again.')
  return body.results
}
