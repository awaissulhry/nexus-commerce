/**
 * Listings page export (live layer step 4, docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md):
 * GET /api/catalog-transfer/readiness/export?format=csv|xlsx&level=listing|family&<the page's filters>.
 *
 * The page's own reading, without a page limit: the same filter (`readinessFilter`), the same SQL summary
 * (`familiesSummary`, every matched family in the page's order), then the families 200 at a time through the same fold,
 * fill, problems, next step and live summaries as the page — so every number in the file is a number on the screen.
 *
 *   listing  one row per product × destination in view (under a state tile, the listings in that state): the count the
 *            toolbar says ("… listings"). Live columns per listing — each row has its own currency.
 *   family   one row per family; live columns only when the request names ONE destination (a market page): a value
 *            across markets would not be honest (currencies differ; Amazon EU shares one quantity).
 *
 * At most `READINESS_EXPORT_MAX_ROWS` rows: above it the request is refused (400) with the count, before any row is
 * built. Live columns only for a caller with `listings.view`. A text cell a spreadsheet would run as a formula (it
 * starts with = + - @, a tab or a carriage return) is written with a leading apostrophe.
 */
import { SELLING_STATE_LABEL } from '@nexus/shared/listing-actions'
import {
  READINESS_EXPORT_MAX_ROWS,
  type ReadinessExportFormat, type ReadinessExportLevel, type ReadinessLiveSummary, type ReadinessNextStep, type ReadinessPushSummary, type ReadinessScopeState,
  type ReadinessStateFilter,
} from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { inDatabaseReadTransaction } from '../../lib/database-context.js'
import { buildCsv, buildXlsx } from '../stock-import-export.js'
import {
  aliasNameOf, channelName, dayAgo, destinationKeyOf, destinationsOf, familiesQuery, familiesSummary, familyItemsOf, familyPageRows, matchesState, oneDestinationOf,
  problemAggregates, readinessFilter, rowsOf, sqlPlanOf, type DestinationInfo, type FamilyPageItem, type MemberSummary, type OneDestination,
} from './listing-readiness-families.service.js'
import { canonicalDestinationKey, coordinateOfKey, liveScopeOf, readLive, summarizeLive, type LiveOptions, type LiveRead } from './listing-readiness-live.service.js'

/** Families built per round: the page's own largest page. */
export const EXPORT_CHUNK = 200

/* ── the request ──────────────────────────────────────────────────────────────────────────── */

export function exportQuery(query: Record<string, unknown>) {
  // Paging is the export's own: every matched family.
  const input = familiesQuery({ ...query, page: undefined, pageSize: undefined })
  const format = query.format === undefined || query.format === '' ? 'csv' : query.format
  if (format !== 'csv' && format !== 'xlsx') throw new Error('Export as csv or xlsx')
  const level = query.level === undefined || query.level === '' ? 'listing' : query.level
  if (level !== 'listing' && level !== 'family') throw new Error('Export one row per listing or per family')
  return { input, format: format as ReadinessExportFormat, level: level as ReadinessExportLevel }
}

/** Too many rows: refused before any is built, with the count. */
export class ExportTooLarge extends Error {
  statusCode = 400
  constructor(readonly count: number) {
    super(`This export has ${count.toLocaleString('en')} rows; at most ${READINESS_EXPORT_MAX_ROWS.toLocaleString('en')} can be exported at once. Narrow the filters first.`)
  }
}

/** The listings the grid shows under a state tile (the toolbar's "… listings"; `listingsInView` on the web). */
export function listingsInView(stats: { blocked: number; warn: number; notComputed: number; absent: number; ready: number; listingCount: number }, state: ReadinessStateFilter | undefined): number {
  if (!state) return stats.listingCount
  if (state === 'notChecked') return stats.absent + stats.notComputed
  return stats[state]
}

/* ── cells ────────────────────────────────────────────────────────────────────────────────── */

/**
 * A text cell made safe for a spreadsheet: one that starts with = + - @ (or a tab or carriage return, the same attack)
 * would be read as a formula, so it gets a leading apostrophe. Numbers and empty cells pass as they are.
 */
export function spreadsheetSafe(value: unknown): unknown {
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

/** The design system's words for a readiness state (`readinessMeta(state, 'scope').label`). */
export const READINESS_STATE_WORD: Record<ReadinessScopeState, string> = {
  blocked: 'Blocked', warn: 'Warnings', notComputed: 'Not computed', absent: 'Not set up', ready: 'Ready',
}

/** The last push in words ("Failed", "Failed · 3 of 20"); empty when nothing here was ever pushed. */
export function pushWords(push: ReadinessPushSummary | undefined): string {
  if (!push?.worst) return ''
  const word = { failed: 'Failed', waiting: 'Waiting', done: 'Accepted', other: 'Other' }[push.worst]
  const total = push.failed + push.waiting + push.done + push.other
  return total > 1 && push.worst !== 'done' ? `${word} · ${push[push.worst].toLocaleString('en')} of ${total.toLocaleString('en')}` : word
}

/** The channel state in words: "Active", "Mixed (18 Active · 2 Not listed)". */
export function statusWords(live: ReadinessLiveSummary): string {
  const word = SELLING_STATE_LABEL[live.state] ?? live.state
  if (live.state !== 'mixed') return word
  const counts = new Map<string, number>()
  for (const [state, n] of Object.entries(live.byState)) if (n) counts.set(SELLING_STATE_LABEL[state as keyof typeof SELLING_STATE_LABEL] ?? state, (counts.get(SELLING_STATE_LABEL[state as keyof typeof SELLING_STATE_LABEL] ?? state) ?? 0) + n)
  if (live.notListed) counts.set(SELLING_STATE_LABEL.not_listed, (counts.get(SELLING_STATE_LABEL.not_listed) ?? 0) + live.notListed)
  return `${word} (${[...counts].map(([label, n]) => `${n.toLocaleString('en')} ${label}`).join(' · ')})`
}

const stepWords = (step: ReadinessNextStep | null, where?: string) =>
  step ? `${step.label}${step.message ? `: ${step.message}` : ''}${where ? ` (${where})` : ''}` : ''

/* ── the file ─────────────────────────────────────────────────────────────────────────────── */

const LISTING_HEADERS = ['SKU', 'Name', 'Family', 'Store', 'Market', 'Readiness', 'Problems', 'Next step']
const FAMILY_HEADERS = ['SKU', 'Name', 'Variations', 'Markets', 'Listings', 'Readiness', 'Problems', 'Next step']
const LIVE_HEADERS = ['Status', 'Price', 'Currency', 'Qty', 'Channel ID', 'Last push', 'Synced']
const FAMILY_LIVE_HEADERS = ['Status', 'Price', 'Price max', 'Currency', 'Qty', 'Channel ID', 'Last push', 'Synced']

export interface ReadinessExportFile { filename: string; contentType: string; data: string | Buffer; rows: number }

/** GET /api/catalog-transfer/readiness/export */
export async function exportReadiness(query: Record<string, unknown>, userId: string | null, options: LiveOptions = {}): Promise<ReadinessExportFile> {
  const { input, format, level } = exportQuery(query)
  const live = options.live === true
  const table = await inDatabaseReadTransaction(prisma, async () => {
    const filter = await readinessFilter(query, input.q, userId)
    const plan = await sqlPlanOf(input, live)
    const summary = await familiesSummary(filter, input, dayAgo(), plan, null)
    const count = level === 'family' ? summary.total : listingsInView(summary, input.state)
    if (count > READINESS_EXPORT_MAX_ROWS) throw new ExportTooLarge(count)
    const { infos, destinations, order } = await destinationsOf(summary)
    const label = new Map(destinations.map(d => [d.key, d.label]))
    const stores = await storeWordsOf(infos)
    // A family row's live columns need ONE destination; a listing row has its own.
    const one = live && level === 'family' ? await oneDestinationOf(input) : null
    const dest = one && one !== 'many' ? one : null
    const headers = level === 'listing' ? [...LISTING_HEADERS, ...(live ? LIVE_HEADERS : []), 'Checked']
      : [...FAMILY_HEADERS, ...(dest ? FAMILY_LIVE_HEADERS : []), 'Checked']
    const rows: unknown[][] = []
    for (let at = 0; at < summary.roots.length; at += EXPORT_CHUNK) {
      const { items } = await familyItemsOf(filter, summary.roots.slice(at, at + EXPORT_CHUNK), input)
      const read = live && (level === 'listing' || dest) ? await readLive(items.flatMap(f => f.members.map(m => m.product.id)), liveScopeOf(input)) : null
      if (level === 'listing') rows.push(...await listingRows(items, input.state, { order, infos, stores, read }))
      else rows.push(...await familyRows(items, { order, infos, label, read, dest }))
    }
    return { headers, rows }
  })
  const safe = table.rows.map(row => row.map(spreadsheetSafe))
  const name = fileName(input, level)
  if (format === 'xlsx') {
    // SKUs and channel ids stay text: Excel would turn a 12-digit eBay Item ID into 2.255E+11.
    const textCols = table.headers.flatMap((header, i) => header === 'SKU' || header === 'Family' || header === 'Channel ID' ? [i] : [])
    return { filename: `${name}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: await buildXlsx(table.headers, safe, textCols), rows: safe.length }
  }
  // The byte-order mark makes Excel read the file as UTF-8 ("Città", not "CittÃ ").
  return { filename: `${name}.csv`, contentType: 'text/csv; charset=utf-8', data: `﻿${buildCsv(table.headers, safe)}`, rows: safe.length }
}

/** "listings-amazon-it-2026-10-25", "-families" for the family level. */
function fileName(input: { channel?: string; marketplace?: string }, level: ReadinessExportLevel): string {
  const scope = [input.channel, input.marketplace].filter(Boolean).map(part => part!.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
  return ['listings', ...scope, new Date().toISOString().slice(0, 10)].join('-') + (level === 'family' ? '-families' : '')
}

/** Each destination's store in words: "Amazon · Xavia", "eBay · Second listing", "Shared". */
async function storeWordsOf(infos: ReadonlyMap<string, DestinationInfo>): Promise<Map<string, string>> {
  const accountIds = [...new Set([...infos.values()].map(i => i.accountId).filter((id): id is string => !!id))]
  const accounts = accountIds.length ? await prisma.channelConnection.findMany({ where: { id: { in: accountIds } }, select: { id: true, accountLabel: true, displayName: true } }) : []
  const names = new Map(accounts.map(a => [a.id, a.accountLabel || a.displayName || null]))
  const baseLabel = (info: DestinationInfo) => [...infos.values()].find(b => !b.aliasId && b.channel === info.channel && b.market === info.market && b.accountId === info.accountId)?.label
  return new Map([...infos.values()].map(info => {
    if (!info.channel) return [info.key, 'Shared']
    const store = info.accountId ? names.get(info.accountId) : null
    const alias = info.aliasId ? aliasNameOf(info.label, baseLabel(info), info.aliasId) : null
    return [info.key, [channelName(info.channel), store, alias].filter(Boolean).join(' · ')]
  }))
}

const marketOfKey = (key: string) => {
  const market = coordinateOfKey(key).market
  return market && market !== 'GLOBAL' ? market : ''
}

/** One row per product × destination of the families, in the page's order (members, then destinations, in chip order). */
async function listingRows(items: readonly FamilyPageItem[], state: ReadinessStateFilter | undefined,
  facts: { order: ReadonlyMap<string, number>; infos: ReadonlyMap<string, DestinationInfo>; stores: ReadonlyMap<string, string>; read: LiveRead | null }): Promise<unknown[][]> {
  const position = (key: string) => facts.order.get(key) ?? Infinity
  const listings = items.flatMap(family => family.members.flatMap((member: MemberSummary) => member.listings
    .filter(listing => matchesState(listing.state, state))
    .sort((a, b) => position(a.destinationKey) - position(b.destinationKey))
    .map(listing => ({ id: member.product.id, members: [member], listing, family }))))
  // The problems by product (as a member row reads them) and the next step per listing: the page's own `rowsOf`.
  const problems = await problemAggregates(listings.flatMap(l => l.listing.rowIds), 'product')
  const built = await rowsOf(listings, problems, facts.order, facts.infos, l => [l.listing])
  return built.map(({ row, chips, state: rowState, nextStep }) => {
    const { listing, family } = row
    const product = row.members[0].product
    const chip = chips[0]
    const base = [product.sku, product.name ?? '', family.root.sku, facts.stores.get(listing.destinationKey) ?? '', marketOfKey(listing.destinationKey),
      READINESS_STATE_WORD[rowState], chip?.issueCount ?? 0, stepWords(nextStep)]
    const checked = listing.computedAt?.toISOString() ?? ''
    if (!facts.read) return [...base, checked]
    const shared = !coordinateOfKey(listing.destinationKey).channel
    if (shared) return [...base, '', '', '', '', '', '', '', checked]
    const live = summarizeLive([product.id], listing.destinationKey, facts.read)
    const own = facts.read.get(product.id)?.get(canonicalDestinationKey(listing.destinationKey)) ?? []
    return [...base, statusWords(live), live.priceMin ?? '', live.currency ?? '', live.quantity ?? '',
      (own.length === 1 ? own[0].externalId : null) ?? live.externalId ?? '', pushWords(live.push), live.lastSyncedAt ?? '', checked]
  })
}

/** One row per family, as the page's family row; live columns on the one destination only. */
async function familyRows(items: readonly FamilyPageItem[], facts: { order: ReadonlyMap<string, number>; infos: ReadonlyMap<string, DestinationInfo>;
  label: ReadonlyMap<string, string>; read: LiveRead | null; dest: OneDestination | null }): Promise<unknown[][]> {
  const rows = await familyPageRows(items, facts.order, facts.infos)
  return rows.map((row, i) => {
    const words = (key: string) => facts.label.get(key) ?? key
    const markets = row.chips.map(chip => `${words(chip.destinationKey)}: ${READINESS_STATE_WORD[chip.state]}${chip.state !== 'ready' && chip.issueCount ? ` · ${chip.issueCount}` : ''}`).join('; ')
    const listings = row.chips.reduce((n, chip) => n + chip.counts.blocked + chip.counts.warn + chip.counts.notComputed + chip.counts.absent + chip.counts.ready, 0)
    const base = [row.sku, row.name ?? '', row.variantCount, markets, listings, READINESS_STATE_WORD[row.state],
      row.chips.reduce((n, chip) => n + chip.issueCount, 0), stepWords(row.nextStep, row.nextStep ? words(row.nextStep.destinationKey) : undefined)]
    const checked = row.computedAt ?? ''
    if (!facts.dest || !facts.read) return [...base, checked]
    const live = summarizeLive(items[i].members.map(m => m.product.id), destinationKeyOf(facts.dest), facts.read)
    return [...base, statusWords(live), live.priceMin ?? '', live.priceMax ?? '', live.currency ?? '', live.quantity ?? '', live.externalId ?? '',
      pushWords(live.push), live.lastSyncedAt ?? '', checked]
  })
}
