import type { TransferJob, TransferOptions, TransferOutcome } from './sourceMapping'
import { hasReadyRecords } from './reviewConfirmations'
import { channelName, languageName } from './workbookSelection'

/**
 * CFI — review sentences that depend on what THIS review holds. Each one must be true for the file in
 * front of the Owner: a channel file's full-update blank removes a value, which the old fixed sentence
 * ("blank values are preserved") denied.
 */

/** A channel file's full-update rows carried blanks (cleared, already empty, or not checkable). */
export const hasFullUpdateBlanks = (counts: TransferJob['counts'] | undefined) =>
  !!counts && ((counts.cleared ?? 0) + (counts.alreadyEmpty ?? 0) + (counts.clearUnchecked ?? 0)) > 0

export function blankSentence(counts: TransferJob['counts'] | undefined) {
  return hasFullUpdateBlanks(counts)
    ? 'In a full-update row of this channel file, a blank cell removes that value for the listing’s marketplace where Nexus holds one, as Amazon does. Blanks in partial-update rows and omitted columns are preserved.'
    : 'Blank and omitted values are preserved.'
}

/** A review that needs correction but also holds ready records must not say the whole review is blocked. */
export function invalidBody(job: Pick<TransferJob, 'state' | 'counts'>, fallback: string, offersReady: boolean) {
  if (!offersReady || !hasReadyRecords(job)) return fallback
  const n = job.counts.refused ?? 0
  return `The ${n.toLocaleString()} ${n === 1 ? 'issue' : 'issues'} listed below need correction; those records are not saved. You can save the ready records now and correct the rest in the file, or correct the file and check it again.`
}

/** The check-again button, worded by what it confirms (ticked first, else what the panel asks about). */
export function recheckLabel(linksTicked: number, deletesTicked: number, linksShown: number, deletesShown: number) {
  const links = linksTicked > 0 || deletesTicked === 0 && linksShown > 0
  const deletes = deletesTicked > 0 || linksTicked === 0 && deletesShown > 0
  return links && deletes ? 'Check the file again with these links and ended listings'
    : deletes ? 'Check the file again with these ended listings'
    : 'Check the file again with these links'
}

/** "Amazon Germany", never "Amazon Amazon Germany": a market name that already names its channel is used as is. */
export function marketLabel(options: Pick<TransferOptions, 'markets'>, channel: string, code: string) {
  const name = options.markets.find(m => m.channel === channel && m.code === code)?.name
  const brand = channelName(channel)
  if (!name) return `${brand} ${code}`
  return name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`
}

/** One outcome's summary line. An issue-only record names its issues instead of an empty scope. */
export function outcomeSummary(row: TransferOutcome, options: Pick<TransferOptions, 'markets' | 'accounts' | 'listings'>, status: string, attributeCount: number) {
  const id = row.identity
  const sku = id?.sku || row.issues[0]?.sku || row.exclusions[0]?.sku || `Record ${row.index}`
  if (!id?.entity) {
    const issues = row.issues.length, exclusions = row.exclusions.length
    const what = issues ? `${issues} file ${issues === 1 ? 'issue' : 'issues'}` : exclusions ? `${exclusions} ${exclusions === 1 ? 'input' : 'inputs'} kept out` : 'No attributes'
    const field = row.issues[0]?.field || row.exclusions[0]?.field
    return `${sku} · ${what}${field ? ` · ${field}` : ''} · ${status}`
  }
  const alias = options.listings?.find(l => l.channel === id.channel && l.accountId === id.accountId && l.marketplace === id.marketplace && l.aliasKey === id.aliasKey)?.aliasLabel ?? (id.aliasKey || 'Primary listing')
  const account = options.accounts.find(a => a.id === id.accountId)?.displayName ?? id.accountId
  const scope = id.entity === 'Products' ? id.locale ? `${languageName(id.locale)} content` : 'Shared product details' : `${marketLabel(options, id.channel, id.marketplace)} · ${account} · ${alias}`
  return `${sku} · ${scope} · ${status} · ${attributeCount} ${attributeCount === 1 ? 'attribute' : 'attributes'}`
}

/**
 * The `market` an upload sends. An Amazon template (chosen, or an `.xlsm`, which is never a Nexus
 * workbook) sends the Owner's explicit choice or EMPTY = "use the file's own marketplace" — a fixed
 * default (IT) refused every DE/FR/ES file before it was read.
 */
export const readsFileMarket = (format: string, filename: string | undefined) => format === 'amazon' || format === 'catalog' && /\.xlsm$/i.test(filename ?? '')
export function uploadMarket(format: string, filename: string | undefined, referenceMarket: string, channelMarket: string) {
  return readsFileMarket(format, filename) ? channelMarket : referenceMarket
}
