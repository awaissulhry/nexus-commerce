/**
 * Amazon A+ content (2026-10-19) — aplus-content: the A+ and Brand Story documents of one Amazon market, read LIVE
 * from Amazon's A+ Content API (services/aplus/aplus-client.ts: every call goes through the channel gateway, with the
 * account named). Nothing is stored in Nexus: Amazon's document is the record. The A+ builder page's own rows
 * (APlusContent) are neither read nor written here.
 *
 *   view list      the market's documents, one Amazon page at a time, each with its status, kind, badges and the first
 *                  ASINs it is applied to. nextCursor carries Amazon's pageToken, bound to the business, the market and
 *                  the account: a cursor from another list is refused, never a page of something else.
 *   view document  one document in full: every module exactly as Amazon keeps it (the shape set-aplus-content takes
 *                  back), its ASINs with their badges, and its documentHash
 *   view asin      which A+ and which Brand Story is published on each ASIN now (Amazon's publish records), each named
 *                  with a METADATA read of its document
 *   view modules   Nexus's own guide to the module types it sends (services/aplus/aplus-modules.ts): no Amazon call,
 *                  no market
 *
 * Order: pure checks, then the market and account (resolveAplusMarket), then Amazon. Nothing is fetched before the
 * account resolves. The handler never throws: every failure is a sentence (aplusErrorSentence). A read of a part
 * (one document's ASINs, one ASIN's publish records) that fails is named in notRead; the rest is still answered.
 *
 * These read a marketplace (openWorld). Channel logins are sealed with the production key, so a live read works only
 * in the deployed API; locally it answers with the read's own error.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { InvalidCursorError, cursorScope } from '../../../lib/pagination/cursor.js'
import { logger } from '../../../utils/logger.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import {
  AplusError,
  aplusErrorSentence,
  getContentDocument,
  listAllAsinRelations,
  listContentDocumentAsinRelations,
  resolveAplusMarket,
  searchContentDocuments,
  searchContentPublishRecords,
  type AplusAsin,
  type AplusMarket,
  type AplusMessage,
  type AplusPublishRecord,
  type AplusStatus,
  type AplusTarget,
} from '../../aplus/aplus-client.js'
import { APLUS_DOCUMENT_RULES, APLUS_MODULE_TYPES, aplusModuleGuide, documentHash, summarizeModules } from '../../aplus/aplus-modules.js'

const TOOL = 'aplus-content'
const VIEWS = ['list', 'document', 'asin', 'modules'] as const
type View = (typeof VIEWS)[number]

/** view list: the ASINs shown per document (view document lists them all). */
const LIST_ASINS = 20
/** view document: the ASINs listed with their title and badges; asinTotal counts every one Nexus read. */
const DOCUMENT_ASINS = 100
/** view asin: the most ASINs one call looks up, and the most documents it names with a METADATA read. */
const MAX_LOOKUP_ASINS = 20
const MAX_NAMED_DOCUMENTS = 20
/** view asin: Amazon's pages of publish records read per ASIN (one is the usual). */
const MAX_RECORD_PAGES = 5
/** Amazon allows 10 A+ calls a second per account; the gateway's rate bucket spaces them, this keeps the queue short. */
const PARALLEL_READS = 4
/** The cursor argument's own bound (input below). */
const MAX_CURSOR = 2000
const CHECK_LENGTH = 22
const TITLE_CAP = 120

const LIVE_NOTE = 'Read live from Amazon; a live read works only in the deployed API (channel logins are sealed there). Nothing here is stored in Nexus.'

const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const clip = (text: string | null | undefined, cap = TITLE_CAP) => (text == null ? null : text.length > cap ? `${text.slice(0, cap - 1)}…` : text)
const hyphenLocale = (locale: string) => locale.replace('_', '-')

const asinArg = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 letters and digits')

const input = z.object({
  market: z.string().trim().toUpperCase().min(2).max(8).optional()
    .describe('the Amazon market code as business-overview lists it, e.g. IT or DE (every view but modules needs it)'),
  accountId: z.string().trim().min(1).max(64).optional()
    .describe('the Amazon account (an id from business-overview accounts), when the business has more than one'),
  view: z.preprocess(lower, z.enum(VIEWS)).optional()
    .describe('list | document | asin | modules (default: document when contentReferenceKey is given, asin when asins are, modules when type is, else list)'),
  contentReferenceKey: z.string().trim().min(1).max(200).optional()
    .describe('view document: the document (contentReferenceKey from view list)'),
  asins: z.array(asinArg).min(1).max(MAX_LOOKUP_ASINS).optional()
    .describe(`view asin: the ASINs to look up (at most ${MAX_LOOKUP_ASINS})`),
  cursor: z.string().min(1).max(MAX_CURSOR).optional()
    .describe('view list: nextCursor from the previous page'),
  type: z.preprocess(upper, z.enum(APLUS_MODULE_TYPES)).optional()
    .describe('view modules: one module type, e.g. PREMIUM_IMAGE_TEXT (default: every type)'),
})
type Args = z.infer<typeof input>

/** The arguments only one view takes: given to another view, the call is refused before anything is read. */
const VIEW_OF_ARGUMENT: ReadonlyArray<[keyof Args, View]> = [
  ['contentReferenceKey', 'document'],
  ['asins', 'asin'],
  ['cursor', 'list'],
  ['type', 'modules'],
]

const viewOf = (a: Args): View => a.view ?? (a.contentReferenceKey ? 'document' : a.asins?.length ? 'asin' : a.type ? 'modules' : 'list')

/** What a call asks for that its view cannot answer, in a sentence; null when it is well made. Pure. */
function callProblem(a: Args, view: View): string | null {
  for (const [argument, owner] of VIEW_OF_ARGUMENT) {
    if (a[argument] !== undefined && owner !== view) return `${argument} is for view ${owner}, not view ${view}.`
  }
  if (view === 'document' && !a.contentReferenceKey) return 'view document needs contentReferenceKey (view list lists the documents).'
  if (view === 'asin' && !a.asins?.length) return 'view asin needs asins (at most 20).'
  if (view !== 'modules' && !a.market) return `view ${view} needs market: the Amazon market code as business-overview lists it, e.g. IT or DE.`
  return null
}

/**
 * Amazon's refusal (AplusError) in plain words. Anything else is a fault in Nexus: logged without its arguments, and
 * answered as a sentence too — the handler never throws.
 */
function sentenceOf(error: unknown): string {
  if (!(error instanceof AplusError)) {
    logger.warn('[aplus-content] a read failed in Nexus', { error: error instanceof Error ? error.message : String(error) })
  }
  return aplusErrorSentence(error)
}

/** Each item through `work`, at most PARALLEL_READS at a time, answers in the items' order. `work` never throws. */
async function eachLimited<T, U>(items: readonly T[], work: (item: T) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length)
  let next = 0
  const runner = async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await work(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, items.length) }, runner))
  return out
}

/** The kind a document's metadata badges say (ContentMetadata has no contentType): a tier badge, or else Brand Story. */
type Kind = 'premium' | 'standard' | 'brand-story'
const kindOfBadges = (badges: readonly string[]): Kind =>
  badges.includes('PREMIUM') ? 'premium' : badges.includes('STANDARD') ? 'standard' : 'brand-story'

/** view document knows the content type too: Brand Story by it, then the tier badge, then the modules' own tier. */
function kindOfDocument(contentType: string, badges: readonly string[], modules: ReadonlyArray<{ contentModuleType?: unknown }>): Kind {
  if (contentType === 'BrandStory') return 'brand-story'
  if (badges.includes('PREMIUM')) return 'premium'
  if (badges.includes('STANDARD')) return 'standard'
  return modules.some((m) => String(m.contentModuleType ?? '').startsWith('PREMIUM_')) ? 'premium' : 'standard'
}

const warningsOf = (...lists: ReadonlyArray<readonly AplusMessage[] | undefined>): AplusMessage[] => lists.flatMap((list) => list ?? [])

// ── The list cursor ──────────────────────────────────────────────────────────────────────────────────────────────
//
// Amazon's pageToken, carried with a check made from the list it belongs to (this tool, the business, the marketplace
// and the account), as lib/pagination/cursor.ts binds Nexus's own cursors. Not encodeCursor: Amazon's token is opaque
// and may be longer than a cursor position's id may be, so it travels as it is, after the check: `<check>.<pageToken>`.

const listScopeOf = (market: AplusMarket) =>
  cursorScope(TOOL, { business: workspaceIdForQuery(), marketplaceId: market.marketplaceId, accountId: market.accountId })

const checkOf = (scope: string, pageToken: string) =>
  createHash('sha256').update(JSON.stringify([TOOL, 1, scope, pageToken])).digest('base64url').slice(0, CHECK_LENGTH)

/** The cursor of Amazon's next page; null when it would not fit the cursor argument (said in the answer). */
function cursorOf(scope: string, pageToken: string): string | null {
  const cursor = `${checkOf(scope, pageToken)}.${pageToken}`
  return cursor.length <= MAX_CURSOR ? cursor : null
}

/** Amazon's pageToken a cursor carries. Throws InvalidCursorError for a cursor of another list, or an altered one. */
function pageTokenOf(scope: string, cursor: string): string {
  const dot = cursor.indexOf('.')
  const pageToken = cursor.slice(dot + 1)
  if (dot !== CHECK_LENGTH || !pageToken || cursor.slice(0, dot) !== checkOf(scope, pageToken)) throw new InvalidCursorError()
  return pageToken
}

// ── The views ────────────────────────────────────────────────────────────────────────────────────────────────────

const idsOf = (market: AplusMarket) => ({ market: market.market, marketplaceId: market.marketplaceId, accountId: market.accountId })
/** What the client calls take: the account and the marketplace, nothing else of the market. */
const targetOf = (market: AplusMarket): AplusTarget => ({ accountId: market.accountId, marketplaceId: market.marketplaceId })

async function listView(market: AplusMarket, cursor: string | undefined): Promise<ToolResult> {
  const scope = listScopeOf(market)
  let pageToken: string | undefined
  try {
    pageToken = cursor ? pageTokenOf(scope, cursor) : undefined
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${TOOL} was called wrongly — cursor: ${error.message}` }
    throw error
  }
  const target = targetOf(market)
  const page = await searchContentDocuments(target, pageToken)
  const notRead: Array<{ part: string; why: string }> = []
  const warnings = [...page.warnings]
  const documents = await eachLimited(page.records, async ({ contentReferenceKey, contentMetadata }) => {
    const row = {
      contentReferenceKey,
      name: contentMetadata.name,
      status: contentMetadata.status,
      kind: kindOfBadges(contentMetadata.badgeSet ?? []),
      badges: contentMetadata.badgeSet ?? [],
      updatedAt: contentMetadata.updateTime,
    }
    try {
      const relations = await listContentDocumentAsinRelations(target, contentReferenceKey)
      warnings.push(...relations.warnings)
      const more = relations.asins.length > LIST_ASINS || !!relations.nextPageToken
      return { ...row, asins: relations.asins.slice(0, LIST_ASINS).map((a) => a.asin), ...(more ? { moreAsins: true as const } : {}) }
    } catch (error) {
      notRead.push({ part: `the ASINs of ${contentReferenceKey}`, why: sentenceOf(error) })
      return { ...row, asins: null }
    }
  })
  const nextCursor = page.nextPageToken ? cursorOf(scope, page.nextPageToken) : null
  const notes = [
    LIVE_NOTE,
    'status: DRAFT (buyers see nothing), SUBMITTED (Amazon reviews it; read its status at most once an hour), APPROVED (live on its ASINs), REJECTED.',
    `asins: the first ${LIST_ASINS} it is applied to; moreAsins: there are more (view document lists them all, with the ones it is live on).`,
  ]
  if (page.nextPageToken && !nextCursor) notes.push('Amazon has more documents, but its page token is too long for Nexus to pass on as a cursor: this page is the last one Nexus can show.')
  return {
    ok: true,
    data: {
      ...idsOf(market),
      documents,
      nextCursor,
      ...(nextCursor ? { hint: 'Amazon has more documents. To go on, call again with cursor set to nextCursor (same market and account).' } : {}),
      ...(notRead.length ? { notRead } : {}),
      ...(warnings.length ? { warnings } : {}),
      note: notes.join(' '),
    },
  }
}

async function documentView(market: AplusMarket, contentReferenceKey: string): Promise<ToolResult> {
  const target = targetOf(market)
  const { record, warnings: documentWarnings } = await getContentDocument(target, contentReferenceKey, 'CONTENTS,METADATA')
  const document = record.contentDocument
  if (!document) return { ok: false, error: `Amazon answered ${contentReferenceKey} without its contents. Ask again in a minute.` }
  const metadata = record.contentMetadata
  const badges = metadata?.badgeSet ?? []
  const modules = document.contentModuleList ?? []
  const notRead: Array<{ part: string; why: string }> = []
  let relations: { asins: AplusAsin[]; complete: boolean; warnings: AplusMessage[] } | null = null
  try {
    relations = await listAllAsinRelations(target, contentReferenceKey, { metadata: true })
  } catch (error) {
    notRead.push({ part: 'its ASINs', why: sentenceOf(error) })
  }
  const asins = relations?.asins ?? []
  const published = asins.filter((a) => (a.badgeSet ?? []).includes('CONTENT_PUBLISHED')).length
  const notes = [
    LIVE_NOTE,
    'modules are Amazon\'s own module objects, the shape set-aplus-content takes back: keep each image\'s uploadDestinationId and imageCropSpecification. documentHash changes whenever the document does.',
    'An ASIN badged CONTENT_PUBLISHED shows this document now; an update or an ASIN change makes an approved document a draft again, while its approved version stays live until it is approved again.',
  ]
  if (metadata?.status === 'SUBMITTED') notes.push('Amazon reviews it now: read its status at most once an hour.')
  if (relations && !relations.complete) notes.push('Amazon has more ASINs than Nexus reads in one call: the list is not complete.')
  if (asins.length > DOCUMENT_ASINS) notes.push(`The first ${DOCUMENT_ASINS} ASINs are listed; asinTotal counts all ${asins.length} read.`)
  return {
    ok: true,
    data: {
      ...idsOf(market),
      contentReferenceKey: record.contentReferenceKey ?? contentReferenceKey,
      name: metadata?.name ?? document.name,
      status: metadata?.status ?? null,
      kind: kindOfDocument(document.contentType, badges, modules),
      badges,
      updatedAt: metadata?.updateTime ?? null,
      contentType: document.contentType,
      contentSubType: document.contentSubType ?? null,
      locale: document.locale,
      documentHash: documentHash(document),
      moduleSummary: summarizeModules(modules),
      modules,
      asins: relations
        ? asins.slice(0, DOCUMENT_ASINS).map((a) => ({ asin: a.asin, title: clip(a.title), parent: a.parent ?? null, badges: a.badgeSet ?? [] }))
        : null,
      asinTotal: relations ? asins.length : null,
      publishedOn: relations ? published : null,
      asinsComplete: relations ? relations.complete : false,
      warnings: warningsOf(documentWarnings, relations?.warnings),
      ...(notRead.length ? { notRead } : {}),
      note: notes.join(' '),
    },
  }
}

interface Named { name: string | null; status: AplusStatus | null }

async function asinView(market: AplusMarket, asked: readonly string[]): Promise<ToolResult> {
  const target = targetOf(market)
  const asins = [...new Set(asked)]
  const notRead: Array<{ part: string; why: string }> = []
  const warnings: AplusMessage[] = []
  // 1 — Amazon's publish records of each ASIN: what is live on it now.
  const read = await eachLimited(asins, async (asin) => {
    const records: AplusPublishRecord[] = []
    let pageToken: string | undefined
    let pages = 0
    try {
      do {
        const page = await searchContentPublishRecords(target, asin, pageToken)
        records.push(...page.records)
        warnings.push(...page.warnings)
        pageToken = page.nextPageToken ?? undefined
        pages += 1
      } while (pageToken && pages < MAX_RECORD_PAGES)
    } catch (error) {
      return { asin, records: null, error: sentenceOf(error) }
    }
    if (pageToken) notRead.push({ part: `more publish records of ${asin}`, why: `Amazon has more than ${MAX_RECORD_PAGES} pages of them; the first are shown.` })
    return { asin, records, error: null }
  })
  const failed = read.filter((r) => r.error)
  if (failed.length === read.length) return { ok: false, error: failed[0].error! }
  for (const f of failed) notRead.push({ part: `ASIN ${f.asin}`, why: f.error! })

  // 2 — each distinct document, named by a METADATA read (a document of another Amazon account cannot be read).
  const keys = [...new Set(read.flatMap((r) => (r.records ?? []).map((record) => record.contentReferenceKey)))]
  const named = new Map<string, Named>()
  await eachLimited(keys.slice(0, MAX_NAMED_DOCUMENTS), async (key) => {
    try {
      const { record } = await getContentDocument(target, key, 'METADATA')
      named.set(key, { name: record.contentMetadata?.name ?? null, status: record.contentMetadata?.status ?? null })
    } catch (error) {
      notRead.push({ part: `the name and status of ${key}`, why: sentenceOf(error) })
    }
  })
  if (keys.length > MAX_NAMED_DOCUMENTS) {
    notRead.push({ part: `the names of ${keys.length - MAX_NAMED_DOCUMENTS} more documents`, why: `one call names at most ${MAX_NAMED_DOCUMENTS}; ask for fewer ASINs.` })
  }

  const entry = (record: AplusPublishRecord) => ({
    contentReferenceKey: record.contentReferenceKey,
    name: named.get(record.contentReferenceKey)?.name ?? null,
    status: named.get(record.contentReferenceKey)?.status ?? null,
    locale: hyphenLocale(record.locale),
  })
  // A market with more than one language can show one document per language: the market's own first, the rest listed.
  const pick = (records: AplusPublishRecord[]) => records.find((r) => hyphenLocale(r.locale) === market.locale) ?? records[0] ?? null
  const rows = read.filter((r) => r.records).map(({ asin, records }) => {
    const aPlus = pick(records!.filter((r) => r.contentType !== 'BrandStory'))
    const brandStory = pick(records!.filter((r) => r.contentType === 'BrandStory'))
    const others = records!.filter((r) => r !== aPlus && r !== brandStory)
    return {
      asin,
      aPlus: aPlus ? entry(aPlus) : null,
      brandStory: brandStory ? entry(brandStory) : null,
      ...(others.length ? { alsoPublished: others.map((r) => ({ kind: r.contentType === 'BrandStory' ? 'brand-story' : 'a-plus', ...entry(r) })) } : {}),
    }
  })
  return {
    ok: true,
    data: {
      ...idsOf(market),
      asins: rows,
      ...(notRead.length ? { notRead } : {}),
      ...(warnings.length ? { warnings } : {}),
      note: [
        LIVE_NOTE,
        'aPlus and brandStory: the document published on the ASIN now (null: none). status is the document\'s own now: a DRAFT or SUBMITTED document that is published means a newer revision waits while the approved one stays live.',
        'A document Nexus cannot name (name null) may belong to another Amazon account, such as the brand owner\'s. Approving another document of the same kind on an ASIN replaces this one there.',
      ].join(' '),
    },
  }
}

function modulesView(type: Args['type']): ToolResult {
  return {
    ok: true,
    data: {
      rules: APLUS_DOCUMENT_RULES,
      modules: aplusModuleGuide(type),
      note: 'Nexus\'s own guide to the module types it sends (no Amazon call). Text limits are characters; image sizes are the least Amazon takes, and a new image is cropped to the module\'s shape. Amazon\'s own check stays authoritative.',
    },
  }
}

const aplusContent: AgentTool = {
  name: TOOL,
  title: 'Amazon A+ content',
  input,
  requires: [F.aplusManage],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  // It reads Amazon live (no change): Claude is told it reaches outside Nexus.
  openWorld: true,
  description:
    'Amazon A+ content of one market, read live from Amazon (nothing is stored in Nexus). view list (default): the '
    + "market's A+ and Brand Story documents, one Amazon page at a time (nextCursor) — key (contentReferenceKey), name, "
    + 'status (DRAFT, SUBMITTED, APPROVED, REJECTED), kind (premium, standard or brand-story), badges, last update and the '
    + 'ASINs it is applied to. view document: one document in full — every module exactly as Amazon keeps it, the shape '
    + 'set-aplus-content takes back (keep each image\'s uploadDestinationId and imageCropSpecification), its ASINs with '
    + 'their badges (CONTENT_PUBLISHED: live there) and documentHash. view asin: which A+ and which Brand Story is '
    + 'published on each ASIN now. view modules: every module type Nexus can send, with its fields, text limits and '
    + 'minimum image sizes (no Amazon call). Amazon reviews a submitted document; read its status at most once an hour. '
    + 'Read only.',
  async handler(args): Promise<ToolResult> {
    try {
      const a = args as Args
      const view = viewOf(a)
      const problem = callProblem(a, view)
      if (problem) return { ok: false, error: problem }
      if (view === 'modules') return modulesView(a.type)
      // Nothing is fetched before the market and the account resolve.
      const market = await resolveAplusMarket({ market: a.market!, ...(a.accountId ? { accountId: a.accountId } : {}) })
      if ('error' in market) return { ok: false, error: market.error }
      if (view === 'document') return await documentView(market, a.contentReferenceKey!)
      if (view === 'asin') return await asinView(market, a.asins!)
      return await listView(market, a.cursor)
    } catch (error) {
      return { ok: false, error: sentenceOf(error) }
    }
  },
}

export const APLUS_READ_TOOLS: AgentTool[] = [aplusContent]
