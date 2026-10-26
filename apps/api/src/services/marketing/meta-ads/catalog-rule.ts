/**
 * Meta ads step 12 — WHICH catalogs a business may read, which it may WRITE, and WHO writes a catalog's items (D7), in a
 * LEAF module (fix A4): it imports only live.ts, the read client, the errors, taken.ts and the leaf paging.ts, and nothing
 * imports back, so lane C4's write path can import it without an import cycle (live-catalog.ts holds the read views).
 *
 * READ rule (lane C4's Q5; no CATALOG link exists yet, so this is the SAFE rule and nothing wider — readableCatalog):
 *   - the chosen ad account must name a business portfolio, and no OTHER business in Nexus may use that portfolio
 *     (nexus_meta_links_taken PORTFOLIO, step 10): when it is shared, every catalog read is refused before any call
 *     (CATALOG_PORTFOLIO_SHARED) — Nexus cannot tell whose catalog is whose;
 *   - a catalog is readable when that portfolio owns it (`business`, "Business that owns a catalog"), or when it is one
 *     of the portfolio's client catalogs (`/{portfolio}/client_product_catalogs`) whose owner Meta NAMES (fix A1: no
 *     named owner = refused) and is no portfolio another business in Nexus uses;
 *   - every id below a catalog is checked to be a child of a readable catalog before it is read (catalogChild): an
 *     item, item group or product set by its own `product_catalog` (one owner-only read, asking a field only that kind
 *     has, so Meta's "nonexisting field" refuses another kind), a feed or an event source by the catalog's own list, an
 *     upload by its feed's list, a feed rule by its feed's list, an upload error by its upload's list.
 *
 * WRITE rule (fix A3 — writableCatalog; lane C4 must NEVER reuse the read rule for a write): readable AND owned by the
 * chosen account's portfolio (a client catalog is another business's: two Nexus businesses on one client catalog would
 * both see "Nexus's own app" writes, so a client catalog is never writable) AND shared with no portfolio another business
 * in Nexus uses (its agencies and connected businesses) AND, for item writes, the deep writer check allows it.
 *
 * WHO writes a catalog (D7 = A: Shopify keeps writing; Nexus reads, and later adds only product sets and the D7 columns
 * — internal_label, custom_label_0…4, custom_number_0…4 — by an update-only upload or its own supplementary feed): catalogWriter reads the catalog's data sources (ingestion_source_type=ALL) and feeds and, deep (the writer
 * view and writableCatalog), items Meta flags with a Shopify error, the smart pixel's settings and the
 * shop (commerce account) that sells from it. Meta publishes no list of the fields Shopify manages (CT-192, RECHECK:
 * NOT-AVAILABLE): every field of a Shopify-fed item except D7_NEXUS_COLUMNS counts as Shopify's. Shopify itself is never called from here.
 * `partner_integration` (a create parameter holding a partner's access token) is never asked.
 *
 * Lane C4 (round 4): every catalog write goes through writableCatalog with a CLOSED purpose (CatalogWritePurpose:
 * 'items' | 'settings' | { upload } | { rules }, see there — no optional escape hatch), and C4 runs writableCatalog AGAIN
 * when the approved change runs, not only at preview: a writer can appear between the two. items_batch, localized items
 * and single-item writes are ALWAYS 'items' (D7 forbids them on a Shopify catalog), gated ONLY on
 * `nexusMayWriteItems === true` (never on `!shopifyWrites`, never on the quick check, whose nexusMayWriteItems is null).
 * A { upload } / { rules } write builds its file or rules from the `fields` writableCatalog returns (frozen, each once):
 * exactly what was checked. The deep writer itself refuses item writes on a client catalog or one shared out.
 *
 * Not masked yet (fix A7): pixels and apps (no PIXEL kind in nexus_meta_links_taken yet) and suggested-partner brands are
 * shown as Meta answers them; a later step adds a PIXEL taken kind.
 */
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { listPaged, listWithFallback, part } from './paging.js'
import { portfolioTaken, takenIds } from './taken.js'

type Row = Record<string, unknown>

/** What the catalog checks use of the chosen account: its connection and its business portfolio (a MetaChosenAccount fits). */
export type CatalogAccount = Pick<MetaChosenAccount, 'connectionId' | 'businessId'> & {
  /**
   * Step 25 — one change's memo of catalog verdicts (CatalogRuleMemo.catalogs): a catalog named twice in one change is read
   * once. Absent (every other caller): each check reads, as before.
   */
  catalogs?: Map<string, Promise<ReadableCatalog>>
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
/** The id lists Nexus reads to find a child in its parent (a catalog's feeds, a feed's uploads): at most this many. */
const CHECK_ROWS = 500

/**
 * Round 5 item 3b — a token-like part: a `.` / `_` / `-` / space-separated segment of 20+ characters mixing letters and
 * digits (an API key, a JWT part, a Sheet id, a 32-hex file name). A name holding one is hidden; a
 * host holding one (a token as its subdomain) is hidden too.
 */
const tokenLike = (s: string): boolean => s.split(/[._\s-]+/).some((seg) => seg.length >= 20 && /\p{L}/u.test(seg) && /\p{N}/u.test(seg))
/** A host as shown: none when it holds a token-like part. */
const shownHost = (host: string | null): string | null => (host && !tokenLike(host) ? host : null)

/** The host of a fetch URL as Meta answers it — for the who-writes checks only, never shown as such. */
function urlHost(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try { return new URL(url).hostname || null } catch { return null }
}
/** A fetch address as its host only (a feed or upload address may hold a key or a password); a token-like host: none. */
export const hostOf = (url: unknown): string | null => shownHost(urlHost(url))

/**
 * Rounds 4–5 item 2 / 3a — a PLAIN name is an ALLOW-list, checked after NFKC (so fullwidth ／ ： ＼ ＠ are / : \ @):
 * letters, marks, digits, spaces and . , - _ ' ’ ‘ “ ” – — · • ( ) [ ] + ! | & # only (none of these separates an
 * address on its own). Anything else makes the text address-like: a separator (/ \ : ? @ ; =), `%` (an encoded one), a
 * look-alike slash (∕ U+2215, ⁄ U+2044, ⧸ U+29F8)… A name with a token-like part is not plain either.
 */
const PLAIN_NAME = /^[\p{L}\p{M}\p{N} .,'’‘“”–—·•()\[\]+!|&#_-]+$/u
const plainName = (s: string): boolean => PLAIN_NAME.test(s) && !tokenLike(s)
/** A text after NFKC, trimmed; null when empty. */
const nfkc = (value: unknown): string | null => text(typeof value === 'string' ? value.normalize('NFKC') : value)

/**
 * The host of an address-like text, also without a scheme ("feeds.example.com/x.csv") and percent-encoded (decoded at
 * most three times; a text that does not decode has none): the leading host-like run after the scheme and a user, so
 * any separator, encoded or look-alike, ends it. null when it has none. For the who-writes checks only (textHost);
 * what is shown is hostOfText (no token-like host).
 */
function textHost(value: unknown): string | null {
  let s = nfkc(value)
  if (!s) return null
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) {
    try { s = decodeURIComponent(s).normalize('NFKC') } catch { return null }
  }
  const rest = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/\\?#]*@/, '')
  return /^[\w-]+(\.[\w-]+)+/.exec(rest)?.[0].toLowerCase() ?? null
}
const hostOfText = (value: unknown): string | null => shownHost(textHost(value))

/**
 * Fix A5 (rounds 2–5) — a feed's name or file name, an upload's file name or a source's name may be its fetch address,
 * and any part of one may be a key: whatever is not a plain name (PLAIN_NAME, no token-like part) is shown as its HOST
 * only (null when it has none, or when the host holds a token), with NAME_HIDDEN next to it (hiddenNote).
 */
export function nameOrHost(value: unknown): string | null {
  const s = nfkc(value)
  if (!s) return null
  return plainName(s) ? s : hostOfText(s)
}

/** Rounds 4–5 item 5 — why a name is not shown whole. */
export const NAME_HIDDEN = 'It looks like an address or holds a key-like part, so only its host is shown, or nothing when it has none.'

/** Round 4 item 5 — `{ [key]: NAME_HIDDEN }` next to a name nameOrHost did not show whole; else nothing. */
export function hiddenNote<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  const s = nfkc(value)
  return s && !plainName(s) ? { [key]: NAME_HIDDEN } as Partial<Record<K, string>> : {}
}

export const need = (value: string | null | undefined, sentence: string): string => {
  if (!value) throw new MetaLiveRefusal(sentence)
  return value
}

// ── the portfolio and the ONE readable-catalog rule ───────────────────────────────────────────────────────────────

export const CATALOG_PORTFOLIO_SHARED = 'This Meta business portfolio is shared with another business in Nexus, so Nexus cannot tell whose catalog is whose; a per-business catalog choice is needed (a later Nexus step), so no catalog is read here.'
export const NO_PORTFOLIO = 'The chosen ad account names no business portfolio, so Nexus cannot tell which catalogs are this business\'s and reads none. A person can move the ad account into a business portfolio in Meta Business settings.'
export const CATALOG_NOT_READABLE = 'That catalog is not owned by the chosen ad account\'s business portfolio, nor shared with it as a client catalog, so it is not read here.'
export const CATALOG_OF_ANOTHER_BUSINESS = 'That catalog belongs to a business portfolio another business in Nexus uses, so it is not read here.'
export const CATALOG_NO_OWNER = 'Meta names no owner business for that client catalog, so Nexus cannot tell whose it is and does not read it.'

/** The chosen account's business portfolio — refused before any Meta call when there is none or another Nexus business uses it too. */
export async function catalogPortfolio(account: CatalogAccount): Promise<string> {
  if (!account.businessId) throw new MetaLiveRefusal(NO_PORTFOLIO)
  if (await portfolioTaken(account.businessId)) throw new MetaLiveRefusal(CATALOG_PORTFOLIO_SHARED)
  return account.businessId
}

export interface ReadableCatalog {
  catalogId: string
  portfolioId: string
  /** owned: the portfolio owns it; client: another business shared it with the portfolio. */
  relation: 'owned' | 'client'
  ownerBusinessId: string | null
  name: string | null
  vertical: string | null
  productCount: number | null
  isSegment: boolean | null
}

const CATALOG_CHECK_FIELDS = 'id,name,business{id},vertical,product_count,is_catalog_segment'

/** The portfolio's client catalogs (ids), for the readable check. */
export async function clientCatalogIds(account: CatalogAccount, portfolioId: string): Promise<Set<string>> {
  const read = await listPaged(account.connectionId, 'catalog.clientCheck', `${portfolioId}/client_product_catalogs`, { fields: 'id' }, CHECK_ROWS)
  return new Set(read.rows.map((r) => idText(r.id)).filter((id): id is string => !!id))
}

/**
 * THE read check of a catalog id (lane C4's Q5, the SAFE rule): the chosen account's portfolio is not shared with another
 * Nexus business (refused before any call), and the catalog is that portfolio's own, or one of its client catalogs with a
 * named owner that is no other Nexus business's portfolio. One owner read (Meta's "nonexisting field" says the id is no
 * catalog), and the client list only when the portfolio does not own it. For a WRITE: writableCatalog, never this.
 */
export async function readableCatalog(account: CatalogAccount, catalogId: string, operation = 'catalog.ownerCheck'): Promise<ReadableCatalog> {
  if (!account.catalogs) return readableCatalogOnce(account, catalogId, operation)
  // Step 25 — within one change only (the memo dies with it), keyed by connection, portfolio and catalog: the same verdict,
  // a refusal included, without reading Meta again.
  const key = `${account.connectionId}|${account.businessId ?? ''}|${catalogId}`
  let verdict = account.catalogs.get(key)
  if (!verdict) { verdict = readableCatalogOnce(account, catalogId, operation); account.catalogs.set(key, verdict) }
  return verdict
}
async function readableCatalogOnce(account: CatalogAccount, catalogId: string, operation: string): Promise<ReadableCatalog> {
  const portfolioId = await catalogPortfolio(account)
  const id = metaObjectId(catalogId)
  if (!id) throw new MetaLiveRefusal(`"${catalogId}" is not a Meta catalog id (digits).`)
  let body: Row
  try {
    body = (await metaReadOne({ connectionId: account.connectionId }, { operation, path: id, query: { fields: CATALOG_CHECK_FIELDS } })).body as Row
  } catch (err) {
    if (!(err instanceof MetaReadError)) throw err
    if (err.failure.origin === 'meta' && /nonexisting field/i.test(err.failure.sentence)) throw new MetaLiveRefusal('That id is not a Meta catalog (Meta does not know a catalog\'s own fields on it), so it is not read.')
    throw new MetaLiveRefusal(`Nexus could not confirm that this catalog is the business's (${err.failure.sentence}), so it is not read.`)
  }
  const owner = metaObjectId(obj(body.business)?.id)
  const base = { catalogId: id, portfolioId, ownerBusinessId: owner, name: text(body.name), vertical: text(body.vertical), productCount: num(body.product_count), isSegment: bool(body.is_catalog_segment) }
  if (owner && owner === portfolioId) return { ...base, relation: 'owned' }
  if (!(await clientCatalogIds(account, portfolioId)).has(id)) throw new MetaLiveRefusal(CATALOG_NOT_READABLE)
  // Fix A1 — a client catalog needs a named owner: without one Nexus cannot tell whether another business in Nexus owns it.
  if (!owner) throw new MetaLiveRefusal(CATALOG_NO_OWNER)
  if (await portfolioTaken(owner)) throw new MetaLiveRefusal(CATALOG_OF_ANOTHER_BUSINESS)
  return { ...base, relation: 'client' }
}

// ── children of a readable catalog ────────────────────────────────────────────────────────────────────────────────

export type CatalogChildKind = 'item' | 'group' | 'product_set' | 'feed' | 'upload' | 'feed_rule' | 'upload_error' | 'event_source'
const CHILD_WORDS: Readonly<Record<CatalogChildKind, string>> = {
  item: 'catalog item', group: 'item group', product_set: 'product set', feed: 'feed', upload: 'feed upload', feed_rule: 'feed rule', upload_error: 'upload error', event_source: 'event source',
}
/** product_catalog and a field only that kind has (an item: availability; a group: variants; a set: filter). */
const CHILD_OWNER_FIELDS: Readonly<Record<'item' | 'group' | 'product_set', string>> = {
  item: 'product_catalog{id},retailer_id,availability',
  group: 'product_catalog{id},retailer_id,variants',
  product_set: 'product_catalog{id},filter',
}

export interface CatalogChildInput { kind: CatalogChildKind; id: string; catalogId?: string | null; feedId?: string | null; uploadId?: string | null }

/** Is `id` in this list of the parent (ids only, at most CHECK_ROWS)? */
async function inList(account: CatalogAccount, operation: string, path: string, id: string): Promise<boolean> {
  const read = await listPaged(account.connectionId, operation, path, { fields: 'id' }, CHECK_ROWS)
  return read.rows.some((r) => idText(r.id) === id)
}

/**
 * A caller's id below a catalog, read only when it is a child of a readable catalog (checked before it is read): an item,
 * item group or product set by its own product_catalog; a feed or event source in the catalog's own list; an upload or
 * feed rule in its feed's list; an upload error in its upload's list. Returns the id and the readable catalog.
 */
export async function catalogChild(account: CatalogAccount, input: CatalogChildInput): Promise<{ id: string; catalog: ReadableCatalog }> {
  const word = CHILD_WORDS[input.kind]
  const id = metaObjectId(input.id)
  if (!id) throw new MetaLiveRefusal(`"${input.id}" is not a Meta ${word} id (digits).`)
  if (input.kind === 'item' || input.kind === 'group' || input.kind === 'product_set') {
    await catalogPortfolio(account)
    let body: Row
    try {
      body = (await metaReadOne({ connectionId: account.connectionId }, { operation: `catalog.${input.kind}.ownerCheck`, path: id, query: { fields: CHILD_OWNER_FIELDS[input.kind] } })).body as Row
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      if (err.failure.origin === 'meta' && /nonexisting field/i.test(err.failure.sentence)) throw new MetaLiveRefusal(`That id is not ${word === 'item group' ? 'an' : 'a'} ${word} (Meta does not know its own fields on it), so it is not read.`)
      throw new MetaLiveRefusal(`Nexus could not confirm that this ${word} is in one of the business's catalogs (${err.failure.sentence}), so it is not read.`)
    }
    const catalogId = metaObjectId(obj(body.product_catalog)?.id)
    if (!catalogId) throw new MetaLiveRefusal(`Meta names no catalog for that ${word}, so it is not read.`)
    if (input.catalogId && metaObjectId(input.catalogId) !== catalogId) throw new MetaLiveRefusal(`That ${word} is not in the catalog named (catalogId), so it is not read.`)
    return { id, catalog: await readableCatalog(account, catalogId) }
  }
  const catalog = await readableCatalog(account, need(input.catalogId, `Name the catalog of this ${word} (catalogId, from meta-catalogs view list).`))
  if (input.kind === 'event_source') {
    if (!(await inList(account, 'catalog.eventSourceCheck', `${catalog.catalogId}/external_event_sources`, id))) throw new MetaLiveRefusal('That pixel or app is not connected to this catalog (Meta\'s list of its event sources), so it is not read here.')
    return { id, catalog }
  }
  const feedId = input.kind === 'feed' ? id : metaObjectId(need(input.feedId, `Name the feed of this ${word} (feedId, from meta-catalog-feeds view list).`))
  if (!feedId) throw new MetaLiveRefusal(`"${input.feedId}" is not a Meta feed id (digits).`)
  if (!(await inList(account, 'catalog.feedCheck', `${catalog.catalogId}/product_feeds`, feedId))) throw new MetaLiveRefusal('That feed is not one of this catalog\'s feeds (Meta\'s list of its feeds), so it is not read.')
  if (input.kind === 'feed') return { id, catalog }
  if (input.kind === 'feed_rule') {
    if (!(await inList(account, 'catalog.feedRuleCheck', `${feedId}/rules`, id))) throw new MetaLiveRefusal('That rule is not one of this feed\'s rules, so it is not read.')
    return { id, catalog }
  }
  const uploadId = input.kind === 'upload' ? id : metaObjectId(need(input.uploadId, `Name the upload of this ${word} (uploadId, from meta-catalog-feeds view uploads).`))
  if (!uploadId) throw new MetaLiveRefusal(`"${input.uploadId}" is not a Meta upload id (digits).`)
  if (!(await inList(account, 'catalog.uploadCheck', `${feedId}/uploads`, uploadId))) throw new MetaLiveRefusal(`That upload is not among this feed's newest ${CHECK_ROWS} uploads, so it is not read.`)
  if (input.kind === 'upload') return { id, catalog }
  if (!(await inList(account, 'catalog.uploadErrorCheck', `${uploadId}/errors`, id))) throw new MetaLiveRefusal('That error is not one of this upload\'s errors, so it is not read.')
  return { id, catalog }
}

// ── who writes a catalog (D7) ─────────────────────────────────────────────────────────────────────────────────────

export type CatalogWriterKind = 'shopify' | 'partner' | 'feed' | 'api' | 'pixel' | 'mixed' | 'none' | 'unknown'
type EvidenceKind = 'shopify' | 'partner' | 'feed' | 'api' | 'pixel' | 'unclear'
export interface WriterEvidence { from: 'data source' | 'feed' | 'items' | 'smart pixel'; id: string | null; name: string | null; nameHidden?: string; kind: EvidenceKind; supplementary: boolean; detail: string; nexusApp?: boolean }
export interface CatalogWriter {
  catalogId: string
  writer: CatalogWriterKind
  /** A Shopify source writes items here, a supplementary one included (D7: Nexus must not write items). */
  shopifyWrites: boolean
  /**
   * Lane C4's ONE gate for item writes. null on the quick check (view writer decides); true only on the deep check when
   * every read answered, no Shopify / other platform / feed / smart pixel writes, and either no source writes and the
   * catalog holds no item and no shop sells from it, or only Nexus's own app writes through the API.
   */
  nexusMayWriteItems: boolean | null
  sentence: string
  evidence: WriterEvidence[]
  /** The shop (commerce account) that sells from this catalog (deep only; null: none, or not read). */
  commerceAccountId: string | null
  /**
   * Round 2 item 1 (deep only; null on the quick check): 'owned' only when the portfolio owns the catalog and shares it
   * with no portfolio another business in Nexus uses; 'client' / 'shared' make nexusMayWriteItems false.
   */
  ownership: 'owned' | 'client' | 'shared' | null
  /** deep: the writer view also read items Meta flags with a Shopify error, the smart pixel and the shop. */
  deep: boolean
  notRead: string[]
}

export const D7_SHOPIFY = 'Shopify writes its items; Nexus must not write items here (D7).'
const QUICK_NOTE = 'This is the quick check; meta-catalogs view writer decides whether Nexus may write items.'
const SHOPIFY = /shopify/i
const SHOPIFY_HOST = /(^|\.)(myshopify\.com|shopify\.com|shopifycdn\.com)$/i
const PARTNERS = /woocommerce|magento|adobe commerce|bigcommerce|salesforce commerce|prestashop|wix|squarespace|shopware|ecwid|opencart|channable|feedonomics|godatafeed|productsup/i

const DATA_SOURCE_CORE = 'id'
export const DATA_SOURCE_MORE = 'name,app_id,upload_type,ingestion_source_type'
const WRITER_FEED_FIELDS = 'id,name,file_name,ingestion_source_type,schedule{url},update_schedule{url},latest_upload{input_method,url}'

function dataSourceEvidence(r: Row, nexusAppId: string | null): WriterEvidence {
  // Round 2 item 4 — Meta's RAW name (and its host) decides; only what is shown is masked.
  const raw = text(r.name)
  const rawHost = textHost(raw)
  const name = nameOrHost(raw)
  const uploadType = text(r.upload_type)
  const appId = idText(r.app_id)
  const words = [raw, uploadType, rawHost].filter(Boolean).join(' ')
  const shown = [name, uploadType].filter(Boolean).join(' ')
  // Round 4 item 5 — a hidden name is said in words, never as "" or "null".
  const named = (who: string) => (shown ? `Meta names this source "${shown}" (${who}).` : `Meta names this source with a name that looks like an address (not shown; ${who}).`)
  const supplementary = /supplementary/i.test(String(r.ingestion_source_type ?? ''))
  const base = { from: 'data source' as const, id: idText(r.id), name, ...hiddenNote('nameHidden', raw), supplementary }
  if (SHOPIFY.test(words) || (rawHost && SHOPIFY_HOST.test(rawHost))) return { ...base, kind: 'shopify', detail: named('Shopify') }
  const partner = PARTNERS.exec(words)
  if (partner) return { ...base, kind: 'partner', detail: named(partner[0]) }
  if (uploadType && /feed|file|schedul|upload|sheet|manual/i.test(uploadType)) return { ...base, kind: 'feed', detail: `Upload type ${uploadType}.` }
  if ((uploadType && /api|batch|session/i.test(uploadType)) || appId) {
    const nexusApp = !!appId && appId === nexusAppId
    return { ...base, kind: 'api', nexusApp, detail: appId ? (nexusApp ? 'Nexus\'s own Meta app writes through the API.' : 'A Meta app that is not Nexus\'s writes through the API.') : `Upload type ${uploadType}; Meta names no app.` }
  }
  return { ...base, kind: 'unclear', detail: 'Meta does not say how this source writes.' }
}

/** A feed is Shopify's when a fetch address is a Shopify host or its name says Shopify; else a data feed (never "Nexus's"). */
function feedEvidence(r: Row): WriterEvidence {
  const rawName = text(r.name) ? r.name : r.file_name
  const name = nameOrHost(r.name) ?? nameOrHost(r.file_name)
  // Round 5 — Meta's raw hosts decide; only token-free hosts are shown.
  const rawHosts = [...[obj(r.schedule)?.url, obj(r.update_schedule)?.url, obj(r.latest_upload)?.url].map(urlHost), textHost(r.name), textHost(r.file_name)].filter((h): h is string => !!h)
  const hosts = rawHosts.map(shownHost).filter((h): h is string => !!h)
  const supplementary = /supplementary/i.test(String(r.ingestion_source_type ?? ''))
  const base = { from: 'feed' as const, id: idText(r.id), name, ...hiddenNote('nameHidden', rawName), supplementary }
  // Round 4 item 5 — no "(null)" when the feed's name is hidden and it has no host.
  const where = hosts.join(', ') || name
  if (rawHosts.some((h) => SHOPIFY_HOST.test(h)) || SHOPIFY.test(`${text(r.name) ?? ''} ${text(r.file_name) ?? ''}`)) return { ...base, kind: 'shopify', detail: `A feed fetched from Shopify${where ? ` (${where})` : ''}.` }
  // Round 3 item 2 — a feed tool (Channable, Feedonomics, productsup…) or another shop platform named by the feed's RAW
  // name, file name or fetch host is a partner, a supplementary feed too (feed tools often write custom_label_0…4).
  const partner = PARTNERS.exec(`${text(r.name) ?? ''} ${text(r.file_name) ?? ''} ${rawHosts.join(' ')}`)
  if (partner) return { ...base, kind: 'partner', detail: `A ${supplementary ? 'supplementary ' : ''}feed from ${partner[0]}${hosts.length ? ` fetched from ${hosts.join(', ')}` : ''}.` }
  const input = text(obj(r.latest_upload)?.input_method)
  return { ...base, kind: 'feed', detail: `${supplementary ? 'A supplementary feed (it changes fields only)' : 'A data feed'}${hosts.length ? ` fetched from ${hosts.join(', ')}` : ''}${input ? `; last upload: ${input}` : ''}.` }
}

const WRITER_SENTENCES: Readonly<Record<Exclude<CatalogWriterKind, 'mixed'>, string>> = {
  shopify: D7_SHOPIFY,
  partner: 'A shop platform or feed tool other than Shopify writes these items; Nexus must not write items here.',
  feed: 'A data feed writes these items; Nexus does not write items here (Meta: never mix feed items with API item writes — a full feed upload would undo them).',
  api: 'A Meta app writes these items through the API.',
  pixel: 'Meta\'s smart pixel makes or updates these items from the website\'s own product data; Nexus does not write items here.',
  none: 'No data source writes items to this catalog yet.',
  unknown: 'Nexus could not tell who writes this catalog\'s items; treat it as not Nexus\'s to write.',
}

/**
 * D7 — who writes this catalog's items, from Meta's own answers (never Shopify's). `deep` (the writer view,
 * writableCatalog) also asks whether Meta flags items with a Shopify error, whether the smart pixel
 * makes items, which shop sells from the catalog, and whether the portfolio owns it and shares it with no other Nexus
 * business's portfolio; only the deep check decides nexusMayWriteItems. Each read fails on its
 * own: what Meta refused (or cut: a list with more pages) is named in notRead, and a writer Nexus cannot see is "unknown",
 * never "none".
 */
export async function catalogWriter(account: MetaChosenAccount, catalog: ReadableCatalog, deep = false): Promise<CatalogWriter> {
  const { connectionId } = account
  const nexusAppId = account.connection.appId
  const notRead: string[] = []
  const evidence: WriterEvidence[] = []
  const sources = await part(() => listWithFallback(connectionId, 'catalog.writer.dataSources', `${catalog.catalogId}/data_sources`, DATA_SOURCE_CORE, DATA_SOURCE_MORE, { ingestion_source_type: 'ALL' }, 100))
  const feeds = await part(() => listPaged(connectionId, 'catalog.writer.feeds', `${catalog.catalogId}/product_feeds`, { fields: WRITER_FEED_FIELDS }, 100))
  if (sources.notRead) notRead.push(`data sources: ${sources.notRead}`)
  if (feeds.notRead) notRead.push(`feeds: ${feeds.notRead}`)
  // Fix A2 (d) — a list cut at its first 100 rows may hide a writer.
  if (sources.value?.more) notRead.push('data sources: more than 100; Nexus read the first 100 only.')
  if (feeds.value?.more) notRead.push('feeds: more than 100; Nexus read the first 100 only.')
  if (sources.value?.note) notRead.push(`data sources: ${sources.value.note}`)
  const feedIds = new Set<string>()
  for (const r of feeds.value?.rows ?? []) {
    const e = feedEvidence(r)
    if (e.id) feedIds.add(e.id)
    evidence.push(e)
  }
  // A feed is a data source too: the feed's own row says more (its fetch address), so its data-source row is skipped.
  for (const r of sources.value?.rows ?? []) {
    const id = idText(r.id)
    if (id && feedIds.has(id)) continue
    evidence.push(dataSourceEvidence(r, nexusAppId))
  }
  let commerceAccountId: string | null = null
  let ownership: CatalogWriter['ownership'] = null
  if (deep) {
    // Round 2 item 1 — the write gate never rests on the read rule: a client catalog, or one shared with a portfolio
    // another business in Nexus uses (its agencies and connected businesses), is never Nexus's to write items in.
    ownership = catalog.relation === 'owned' ? 'owned' : 'client'
    if (ownership === 'owned') {
      const sharedWith: string[] = []
      for (const edge of ['agencies', 'connected_businesses']) {
        const read = await part(() => listPaged(connectionId, `catalog.writer.${edge}`, `${catalog.catalogId}/${edge}`, { fields: 'id' }, CHECK_ROWS))
        if (read.notRead) notRead.push(`who else has the catalog (${edge}): ${read.notRead}`)
        else if (read.value?.more) notRead.push(`who else has the catalog (${edge}): more than ${CHECK_ROWS}; Nexus read the first ${CHECK_ROWS} only.`)
        sharedWith.push(...(read.value?.rows ?? []).map((r) => idText(r.id)).filter((id): id is string => !!id && id !== catalog.portfolioId))
      }
      if ((await takenIds('PORTFOLIO', sharedWith)).size > 0) ownership = 'shared'
    }
    if (!evidence.some((e) => e.kind === 'shopify')) {
      for (const errorType of ['INACTIVE_SHOPIFY_PRODUCT', 'SHOPIFY_INVALID_RETAILER_ID']) {
        const read = await part(() => listPaged(connectionId, 'catalog.writer.shopifyItems', `${catalog.catalogId}/products`, { fields: 'id', error_type: errorType }, 1, true))
        if (read.notRead) notRead.push(`items with ${errorType}: ${read.notRead}`)
        else if ((read.value?.totalCount ?? read.value?.rows.length ?? 0) > 0) {
          evidence.push({ from: 'items', id: null, name: null, kind: 'shopify', supplementary: false, detail: `Meta flags ${read.value?.totalCount ?? 'some'} item(s) with ${errorType}: items Shopify sends.` })
          break
        }
      }
    }
    const pixel = await part(() => listWithFallback(connectionId, 'catalog.writer.smartPixel', `${catalog.catalogId}/smart_pixel_settings`, 'id', 'is_create_enabled,is_update_enabled', {}, 10))
    if (pixel.notRead) notRead.push(`smart pixel settings: ${pixel.notRead}`)
    else if (pixel.value?.note) notRead.push(`smart pixel settings: ${pixel.value.note}`)
    else if (pixel.value?.more) notRead.push('smart pixel settings: more than Nexus read.')
    for (const r of pixel.value?.rows ?? []) {
      if (r.is_create_enabled === true || r.is_update_enabled === true) {
        evidence.push({ from: 'smart pixel', id: idText(r.id), name: null, kind: 'pixel', supplementary: false, detail: `The smart pixel ${r.is_create_enabled === true ? 'makes' : 'updates'} items from the website's product data.` })
      }
    }
    // Fix A2 (e) — a shop (commerce account) selling from the catalog counts (SDK-only field: Meta's refusal is notRead).
    const shop = await part(() => metaReadOne({ connectionId }, { operation: 'catalog.writer.shop', path: catalog.catalogId, query: { fields: 'id,commerce_merchant_settings{id}' } }))
    if (shop.notRead) notRead.push(`the shop that sells from it: ${shop.notRead}`)
    commerceAccountId = idText(obj(obj(shop.value?.body)?.commerce_merchant_settings)?.id)
  }
  // Fix A2 (b) — a supplementary source counts as a writer unless it is a plain data feed (it only changes fields).
  const writers = evidence.filter((e) => e.kind !== 'unclear' && !(e.supplementary && e.kind === 'feed'))
  const kinds = [...new Set(writers.map((e) => e.kind))] as Array<Exclude<EvidenceKind, 'unclear'>>
  const unclear = evidence.some((e) => e.kind === 'unclear')
  // Fix A2 (a) — no source named: "none" only when Meta says the catalog holds no item; items, or no count, are unknown.
  if (kinds.length === 0 && !unclear && !notRead.length && catalog.productCount !== 0) {
    notRead.push(catalog.productCount === null ? 'Meta did not say how many items the catalog holds.' : `The catalog holds ${catalog.productCount} item(s) but Meta names no source that wrote them.`)
  }
  const writer: CatalogWriterKind = kinds.length > 1 ? 'mixed' : kinds.length === 1 ? kinds[0] : unclear || notRead.length ? 'unknown' : 'none'
  const shopifyWrites = evidence.some((e) => e.kind === 'shopify')
  const apiOnlyNexus = writer === 'api' && !unclear && writers.every((e) => e.nexusApp === true)
  const blocked = evidence.some((e) => e.kind === 'partner' || e.kind === 'pixel' || e.kind === 'feed')
  // Flag for the leader (round 2 item 6): a shop selling from a catalog only Nexus's own app writes still passes (writer
  // 'api'); the shop only blocks the 'none' case (no writer yet, so the shop's items would come from somewhere else).
  const nexusMayWriteItems = !deep ? null
    : ownership === 'owned' && !notRead.length && !shopifyWrites && !blocked && (writer === 'none' ? catalog.productCount === 0 && !commerceAccountId : apiOnlyNexus)
  const base = writer === 'mixed'
    ? `${shopifyWrites ? `${D7_SHOPIFY} ` : ''}More than one source writes these items (${kinds.join(', ')}); Nexus does not write items here.`
    : writer === 'api' ? `${WRITER_SENTENCES.api} ${apiOnlyNexus ? 'Only Nexus\'s own app does.' : 'It is not (only) Nexus\'s app, so Nexus does not write items here.'}`
    : `${shopifyWrites && writer !== 'shopify' ? `${D7_SHOPIFY} ` : ''}${WRITER_SENTENCES[writer]}`
  const shopNote = commerceAccountId ? ' A shop (commerce account) sells from this catalog.' : ''
  const ownershipNote = ownership === 'client' ? ' It is a client catalog (another business\'s), so Nexus never writes its items.'
    : ownership === 'shared' ? ' It is shared with a business portfolio another business in Nexus uses, so Nexus cannot tell whose change it would be and never writes its items.' : ''
  const sentence = !deep ? `${base} ${QUICK_NOTE}`
    : `${base}${shopNote}${ownershipNote} ${nexusMayWriteItems ? 'Nexus may write items here (each change a person approves).' : 'Nexus writes no items here.'}`
  return { catalogId: catalog.catalogId, writer, shopifyWrites, nexusMayWriteItems, sentence, evidence, commerceAccountId, ownership, deep, notRead }
}

// ── the WRITE rule (lane C4) ──────────────────────────────────────────────────────────────────────────────────────

export const CATALOG_NOT_OWNED_FOR_WRITE = 'Nexus changes only a catalog the chosen ad account\'s business portfolio owns; a client catalog is another business\'s (two businesses in Nexus could share it), so Nexus changes nothing in it.'
export const CATALOG_SHARED_OUT = 'This catalog is shared with a business portfolio another business in Nexus uses, so Nexus cannot tell whose change it would be and changes nothing in it.'

/**
 * Round 2 item 5 — D7: the ONLY item fields Nexus may write on a catalog it does not write items in (Shopify sends every
 * other field): the internal label and the custom labels and numbers, through an update-only upload or Nexus's own
 * supplementary feed (LANE-C4-BUILD-PROMPT.md step 35). The key column `id` (D7_KEY_COLUMN) of an upload file names
 * the item and writes no field.
 */
export const D7_NEXUS_COLUMNS: readonly string[] = [
  'internal_label', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4',
  'custom_number_0', 'custom_number_1', 'custom_number_2', 'custom_number_3', 'custom_number_4',
]
export const D7_KEY_COLUMN = 'id'

/**
 * Rounds 3–4 — what a catalog write may be, CLOSED (no optional escape hatch; any other value or key is refused):
 *   - 'items': anything that decides item data. items_batch, localized items and single-item writes are ALWAYS 'items'
 *     (D7 forbids them on a Shopify catalog), as are item deletes (remove-meta-catalog-items), a catalog delete, a feed
 *     upload from a URL or on a schedule (the file decides the columns), a primary or migrated feed create, offer,
 *     ratings-and-reviews and local-inventory feeds, and the smart pixel's settings (it makes / updates items). Needs
 *     nexusMayWriteItems === true, and never on a catalog segment (its items live in a parent catalog whose writer is
 *     not checked).
 *   - 'settings': catalog-level settings that touch no item field — the catalog's name, default / fallback image, image
 *     display settings (da_display_settings), its categories' display (destination / image), connected pixels and apps,
 *     people and partner access, product sets (name, filter, metadata; a set's filter selects items, it writes none).
 *   - { upload }: an update-only upload or an upload to Nexus's own supplementary feed, of a file Nexus makes: EVERY
 *     column of the file — `id` (the key column) and D7_NEXUS_COLUMNS only, at least one of these.
 *   - { rules }: feed rules: EVERY rule's attribute, each in D7_NEXUS_COLUMNS — never `id` (a rule on id re-keys items).
 *   { upload } and { rules } also carry `ownFeedIds`: the ids of the supplementary feeds Nexus made (C4 stores them when
 *   it creates them; none = []). C4 reads ownFeedIds ONLY from Nexus's own stored rows for THIS business and THIS
 *   catalog, never from tool input (a caller could name anyone's feed); an own feed counts only as a plain feed. Every other supplementary feed or source refuses them (a person's sheet, a feed tool or
 *   a hand-made feed may write the same labels; Nexus would fight it for the column, sending items back to review). Both
 *   need the writer to be Shopify, no one yet, or Nexus's own app alone, with nothing unread and no source Meta does not
 *   describe, and are never on a catalog segment (as 'items').
 */
export type CatalogWritePurpose =
  | 'items'
  | 'settings'
  | { upload: readonly string[]; ownFeedIds?: readonly string[] }
  | { rules: readonly string[]; ownFeedIds?: readonly string[] }

export const CATALOG_SEGMENT_ITEMS = 'This catalog is a segment of another catalog (or Meta does not say whether it is one): its items live in the parent catalog, whose writer Nexus has not checked, so Nexus writes no items or item fields here.'
const UNKNOWN_PURPOSE = 'Nexus does not know this kind of catalog change (it is \'items\', \'settings\', { upload } or { rules }).'

/** Round 4 item 4 — a list of texts with no hole and no other entry (`missing`: the refusal when it is no list, or empty). */
function textList(list: unknown, what: string, missing: string, mayBeEmpty = false): string[] {
  if (!Array.isArray(list) || (!mayBeEmpty && list.length === 0)) throw new MetaLiveRefusal(missing)
  const out: string[] = []
  // Every slot by its index (never filter / some, which skip holes): a hole reads as undefined and is refused.
  for (let i = 0; i < list.length; i++) {
    const v: unknown = list[i]
    if (typeof v !== 'string') throw new MetaLiveRefusal(`Every ${what} is a name (text); entry ${i + 1} is not.`)
    out.push(v)
  }
  return out
}

/** Rounds 3–4 — the { upload } / { rules } purpose checked: its kind, its fields (frozen, each once) and Nexus's own feeds. */
function fieldWriteOf(purpose: object): { kind: 'upload' | 'rules'; fields: readonly string[]; ownFeedIds: ReadonlySet<string> } {
  const p = purpose as Record<string, unknown>
  const keys = Object.keys(p)
  const kinds = keys.filter((k): k is 'upload' | 'rules' => k === 'upload' || k === 'rules')
  // Exactly one kind: a second one (upload AND rules) is a key the first does not allow.
  if (kinds.length === 0 || keys.some((k) => k !== kinds[0] && k !== 'ownFeedIds')) throw new MetaLiveRefusal(UNKNOWN_PURPOSE)
  const kind = kinds[0]
  const names = kind === 'upload'
    ? textList(p.upload, 'column', 'Name every column of the upload file (upload); Nexus checks each against what D7 lets it add.')
    : textList(p.rules, 'rule attribute', 'Name every rule attribute (rules); Nexus checks each against what D7 lets it add.')
  if (kind === 'rules' && names.includes(D7_KEY_COLUMN)) throw new MetaLiveRefusal(`A feed rule on ${D7_KEY_COLUMN} would re-key the items, so Nexus never writes one.`)
  // `id` here can only be an upload's key column: a rule on id was refused above.
  const outside = [...new Set(names.filter((c) => c !== D7_KEY_COLUMN && !D7_NEXUS_COLUMNS.includes(c)))]
  if (outside.length) throw new MetaLiveRefusal(`Shopify writes ${outside.join(', ')}; change ${outside.length === 1 ? 'it' : 'them'} in Shopify. Nexus adds only ${D7_NEXUS_COLUMNS.join(', ')} (D7).`)
  if (!names.some((c) => D7_NEXUS_COLUMNS.includes(c))) throw new MetaLiveRefusal(`This change names no field Nexus may add (the key column ${D7_KEY_COLUMN} writes none); name the D7 fields it writes.`)
  const own = p.ownFeedIds === undefined ? [] : textList(p.ownFeedIds, 'own feed id', 'ownFeedIds is the list of the Meta ids of the supplementary feeds Nexus made ([] when none).', true)
  if (own.some((id) => !/^\d+$/.test(id))) throw new MetaLiveRefusal('ownFeedIds are the Meta ids (digits) of the supplementary feeds Nexus made.')
  return { kind, fields: Object.freeze([...new Set(names)]), ownFeedIds: new Set(own) }
}

/**
 * THE write check for lane C4 (never readableCatalog, never a reused read): readable, OWNED by the chosen account's
 * portfolio (a client catalog is never writable: two Nexus businesses on one client catalog would both see "Nexus's own
 * app" writes), shared (agencies, connected businesses) with no portfolio another Nexus business uses (a list Meta does not
 * answer refuses the write), the deep writer read, and the purpose's own rule (CatalogWritePurpose). Run it again when
 * the approved change runs. `fields`: for { upload } / { rules }, the checked fields, frozen and each once — C4 builds
 * its file or rules from exactly these; null for 'items' and 'settings'.
 */
export async function writableCatalog(
  account: MetaChosenAccount, catalogId: string, purpose: CatalogWritePurpose,
): Promise<{ catalog: ReadableCatalog; writer: CatalogWriter; fields: readonly string[] | null }> {
  const write = purpose !== null && typeof purpose === 'object' ? fieldWriteOf(purpose) : null
  if (!write && purpose !== 'items' && purpose !== 'settings') throw new MetaLiveRefusal(UNKNOWN_PURPOSE)
  const catalog = await readableCatalog(account, catalogId, 'catalog.writeCheck')
  if (catalog.relation !== 'owned') throw new MetaLiveRefusal(CATALOG_NOT_OWNED_FOR_WRITE)
  // Round 3 item 5 — items (and item fields) never on a segment, or where Meta does not say whether it is one.
  if ((purpose === 'items' || write) && catalog.isSegment !== false) throw new MetaLiveRefusal(CATALOG_SEGMENT_ITEMS)
  const writer = await catalogWriter(account, catalog, true)
  if (writer.ownership === 'shared') throw new MetaLiveRefusal(CATALOG_SHARED_OUT)
  const sharedNotRead = writer.notRead.filter((n) => n.startsWith('who else has the catalog'))
  if (sharedNotRead.length) throw new MetaLiveRefusal(`Nexus could not read who else has this catalog (${sharedNotRead.join(' ')}), so it changes nothing in it.`)
  if (purpose === 'items' && writer.nexusMayWriteItems !== true) throw new MetaLiveRefusal(`${writer.sentence}${writer.notRead.length ? ` (${writer.notRead.join(' ')})` : ''}`)
  if (write) {
    // Round 3 item 2 — D7 columns only beside Shopify, no writer yet, or Nexus's own app alone; nothing unread.
    const nexusAlone = writer.writer === 'api' && writer.nexusMayWriteItems === true
    if (writer.notRead.length) throw new MetaLiveRefusal(`Nexus could not read everything that writes this catalog (${writer.notRead.join(' ')}), so it adds no fields here.`)
    const unclear = writer.evidence.filter((e) => e.kind === 'unclear').length
    if (unclear) throw new MetaLiveRefusal(`Meta does not say how ${unclear === 1 ? 'one source' : `${unclear} sources`} of this catalog write${unclear === 1 ? 's' : ''}, so Nexus adds no fields here.`)
    if (!(writer.writer === 'shopify' || writer.writer === 'none' || nexusAlone)) throw new MetaLiveRefusal(`${writer.sentence} Nexus adds D7 fields only beside Shopify, on a catalog no one writes yet, or where only Nexus's own app writes (a feed tool or another platform may write these labels itself).`)
    // Round 4 item 1 — an ALLOW-list of supplementary feeds: only those Nexus made (ownFeedIds); any other one refuses.
    // Round 5 item 2 — and an own one only as a plain feed (kind 'feed'): one named Shopify or a feed tool is no exemption.
    const foreign = writer.evidence.filter((e) => e.supplementary && !(e.id && e.kind === 'feed' && write.ownFeedIds.has(e.id)))
    if (foreign.length) {
      const ids = foreign.map((e) => e.id ?? 'no id').join(', ')
      throw new MetaLiveRefusal(`${foreign.length === 1 ? 'A supplementary feed or source' : `${foreign.length} supplementary feeds or sources`} that is not a plain feed Nexus made (${ids}) may write the same fields, so Nexus adds none here (it would fight it for the column and send items back to review).`)
    }
  }
  return { catalog, writer, fields: write ? write.fields : null }
}

// ─── Step 18 (lane C1, #711): the catalog / product-set rule for a CHANGE that names one (a promoted object). ───
/*
 * Meta step 18 review A4, owner fix (2026-10-21, found by lane R on #718): a change of THIS business may name a catalog or a
 * product set (a promoted object's product_catalog_id / product_set_id) only when step 12's READ rule passes for it —
 * readableCatalog / catalogChild above, never a looser copy: the chosen ad account's business portfolio is used by no other
 * business in Nexus, and the catalog is that portfolio's own, or one of its client catalogs whose OWNER Meta names and is no
 * portfolio another business in Nexus uses (before this fix a client catalog passed whoever owned it). A product set
 * counts as its catalog. Naming a catalog in an ad is no write to the catalog, so the read rule (not writableCatalog) is the
 * one. The tool asks it before the preview, and the gateway asks it again before it sends anything (gateway.ts
 * metaBodyIdsProblem). The portfolio is read live from the ad account (`business`, reference/ad-account), so the gateway
 * needs no stored account. Reads only, through the gateway.
 *
 * Step 25 — a creative also names catalog ITEMS (a product tag's product_id, product_data's product_id): an item counts as
 * its catalog too, by the same read rule (catalogChild kind item: its own product_catalog, then readableCatalog).
 */
export interface CatalogRuleTarget { connectionId: string; adAccountId: string }

const idIn = (body: unknown, key: string): string | null => {
  const inner = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : null
  return metaObjectId(inner && typeof inner === 'object' ? (inner as Record<string, unknown>).id : null)
}

/** The read rule's refusal, worded for a change: what it says, and that nothing is sent. */
const notSent = (sentence: string): string =>
  `${sentence.replace(/,? (so (it is not|no catalog is) read( here)?|and (reads none|does not read it))\.$/, '.')} Nexus names no such catalog in a change, so nothing is sent.`

/** Why this catalog / product set may not be named by a change of the chosen ad account, in words; null when it may. */
/**
 * Step 25 — ONE change that names several catalog ids (a creative's product set, its tagged items, its product data): the
 * ad account's portfolio is read once, each catalog's verdict and each id's verdict are remembered. The caller makes a memo
 * per change (the tool per draft, the gateway per call) and drops it with the change: nothing is kept across changes,
 * connections or businesses. Without a memo, metaCatalogProblem reads as before.
 */
export interface CatalogRuleMemo {
  portfolios: Map<string, Promise<string | null>>
  catalogs: Map<string, Promise<ReadableCatalog>>
  verdicts: Map<string, Promise<string | null>>
}
export const newCatalogRuleMemo = (): CatalogRuleMemo => ({ portfolios: new Map(), catalogs: new Map(), verdicts: new Map() })

export async function metaCatalogProblem(target: CatalogRuleTarget, ids: { catalogId?: string | null; productSetId?: string | null; productItemId?: string | null; owned?: boolean }, memo?: CatalogRuleMemo): Promise<string | null> {
  if (!ids.catalogId && !ids.productSetId && !ids.productItemId) return null
  if (!memo) return catalogProblemOnce(target, ids)
  const key = `${target.connectionId}|${target.adAccountId}|${ids.catalogId ?? ''}|${ids.productSetId ?? ''}|${ids.productItemId ?? ''}|${ids.owned ? 'owned' : ''}`
  let verdict = memo.verdicts.get(key)
  if (!verdict) { verdict = catalogProblemOnce(target, ids, memo); memo.verdicts.set(key, verdict) }
  return verdict
}

/**
 * Gap 46b (master CR-331) — NEXUS'S OWN RULE, not Meta's (review N6, the leader's decision): the intro card is only for the
 * business's own catalog. Meta's partnership catalog-ads guide and master CR-331 / CR-320 say nothing of catalog ownership;
 * Nexus asks it because such an ad puts a partner's or an existing post beside the catalog. So a creative with an intro card
 * names only a catalog OWNED by the chosen ad account's portfolio, never a client catalog another business shared
 * (`owned`). Every other change — a catalog creative without an intro card included — keeps the read rule unchanged.
 */
export const CATALOG_NOT_OWNED_FOR_PARTNERSHIP = 'A partnership catalog ad with an existing post as its intro card names only a catalog the chosen ad account\'s business portfolio owns; this one is a client catalog another business shared with it.'

async function catalogProblemOnce(target: CatalogRuleTarget, ids: { catalogId?: string | null; productSetId?: string | null; productItemId?: string | null; owned?: boolean }, memo?: CatalogRuleMemo): Promise<string | null> {
  try {
    const portfolioOf = () => metaReadOne({ connectionId: target.connectionId }, { operation: 'catalogRule.portfolio', path: `act_${target.adAccountId}`, query: { fields: 'business{id}' } }).then((read) => idIn(read.body, 'business'))
    const accountKey = `${target.connectionId}|${target.adAccountId}`
    let portfolio = memo?.portfolios.get(accountKey)
    if (!portfolio) { portfolio = portfolioOf(); memo?.portfolios.set(accountKey, portfolio) }
    const account: CatalogAccount = { connectionId: target.connectionId, businessId: await portfolio, ...(memo ? { catalogs: memo.catalogs } : {}) }
    const found: ReadableCatalog[] = []
    if (ids.productSetId) found.push((await catalogChild(account, { kind: 'product_set', id: ids.productSetId, catalogId: ids.catalogId ?? null })).catalog)
    if (ids.productItemId) found.push((await catalogChild(account, { kind: 'item', id: ids.productItemId, catalogId: ids.catalogId ?? null })).catalog)
    if (!ids.productSetId && !ids.productItemId) found.push(await readableCatalog(account, ids.catalogId!))
    // Gap 46b — owned only: the portfolio's own catalog (catalogChild / readableCatalog name the relation).
    if (ids.owned && found.some((c) => c.relation !== 'owned')) return `${CATALOG_NOT_OWNED_FOR_PARTNERSHIP} Nothing is sent.`
    return null
  } catch (err) {
    // A refusal of the read rule is said in its own words; a lookup that fails (Meta's refusal, a lost connection, the
    // database) never lets a catalog through either: the change is refused in words, here and at the gateway.
    if (err instanceof MetaLiveRefusal) return notSent(err.message)
    if (err instanceof MetaReadError) return `Nexus could not confirm the catalog (${err.message}), so it is not sent.`
    return `Nexus could not confirm the catalog (${err instanceof Error ? err.message : String(err)}), so it is not sent.`
  }
}
