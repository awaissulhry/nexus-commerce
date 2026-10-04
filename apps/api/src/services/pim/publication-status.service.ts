/**
 * Sheet publish parity, step 3 (item 2) — what became of the last publish of each sheet row on one destination.
 *
 * The sheet's "Last publish" column reads this beside the sheet, not inside it: the sheet read is tuned for speed
 * (#194) and this status changes on its own schedule (the result sweep, step 2). One read per destination:
 *  - the family's listings on the EXACT coordinate (channel, market, account, alias) — never another account's or
 *    alias's rows;
 *  - per listing, its newest publish journal (`ChannelListingSnapshot`, reason `publish`), reading only the journal's
 *    SKU, the field names it carried and whether it created the listing — never the stored request itself;
 *  - the publication's status, sender and time from the BulkOperation columns, and that SKU's stored result (only
 *    `changes->'result'`, never the change plan);
 *  - the issues the channel reports for each listing now (open `ListingIssue` rows);
 *  - whether a publication to this destination has not settled yet.
 *
 * Build shape v2 (P7): a selling change is a publish too. The newest of the publish journals AND the audit records the
 * listing-action engine writes per row (`ChannelListingSnapshot`, reason = the action: pause, resume, end, relist,
 * delete) is the row's last publish, with its `kind` so the card reads "Pause offer · Accepted · 10:42 · Awais". A
 * successful selling change is ACCEPTED (never VERIFIED: Nexus does not read it back); a failed one keeps the engine's
 * message. A publish journal is `full_update` when its publication sent this row as a Full update
 * (`changes.fullProductIds`), else `publish`.
 */
import { Prisma } from '@prisma/client'
import type { LastPublishKind } from '@nexus/shared/publication-history'
import type { StudioChannelIssue, StudioPublicationStatus, StudioPublishResult, StudioRowLastPublish, StudioRowOpenIssue, StudioRowPublicationStatus } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { resolveWorkspaceDestination, WorkspaceScopeError } from './workspace-destination.js'
import { IN_FLIGHT, OPEN_PUBLICATION, PUBLICATION_KIND } from './studio-publication-settle.js'

export interface PublicationStatusInput {
  productId: string
  channel: string
  marketplace: string
  accountId?: string
  aliasKey?: string
}

/** Statuses a sent publication can have; a PREVIEW (or anything else) was never sent. */
const SENT = [...IN_FLIGHT, 'ACCEPTED', 'VERIFIED', 'PARTIAL', 'FAILED']
/** Open issues per listing — the newest first; the card lists them, it is not a report. */
const ISSUES_PER_LISTING = 50
/** A journal's own words for "this publish created the listing": an Amazon full UPDATE or an eBay AddFixedPriceItem. */
export const CREATE_FIELD = '$create'
/** The listing-action engine's run kind and the reasons of its per-row audit records (listing-action.service.ts). */
const SELLING_KIND = 'listing-action'
const SELLING_REASONS = ['pause', 'resume', 'end', 'relist', 'delete'] as const

/** A row's last publish, with what it was (build shape v2): the sheet titles its card with `kind`. */
export interface LastPublish extends StudioRowLastPublish { kind: LastPublishKind }
export interface RowPublicationStatus extends Omit<StudioRowPublicationStatus, 'last'> { last: LastPublish | null }
export interface PublicationStatusRead extends Omit<StudioPublicationStatus, 'rows'> { rows: RowPublicationStatus[] }

interface JournalRow {
  listingId: string
  publicationId: string | null
  /** 'publish', or the selling change's action. */
  reason: string
  outcome: string
  createdAt: Date
  sku: string | null
  /** A selling change's own row message (its audit record); null for a publish journal. */
  message: string | null
  fields: unknown
  created: boolean
}

interface PublicationRow {
  id: string
  kind: string | null
  status: string
  userId: string | null
  submittedAt: Date | null
  createdAt: Date
  result: unknown
  /** The rows the publication sent as a Full update (a publication only). */
  fullProductIds: unknown
}

/** A selling change's run status in the publish vocabulary the Last publish cell reads (`PUBLICATION_STATUSES`). */
const SELLING_STATUS: Record<string, string> = { RUNNING: 'PUBLISHING', DONE: 'ACCEPTED', PARTIAL: 'PARTIAL', FAILED: 'FAILED', NOT_SENT: 'NOT_SENT', UNKNOWN: 'UNVERIFIED' }
const isSellingReason = (reason: string): reason is (typeof SELLING_REASONS)[number] => (SELLING_REASONS as readonly string[]).includes(reason)

const severityOf = (raw: string): StudioChannelIssue['severity'] => {
  const value = raw.toUpperCase()
  return value === 'ERROR' ? 'error' : value === 'WARNING' ? 'warning' : 'info'
}

/** The per-SKU result vocabulary from a journal outcome, when no stored result names the SKU. */
const journalOutcome = (outcome: string): StudioRowLastPublish['outcome'] =>
  outcome === 'ACCEPTED' || outcome === 'FAILED' || outcome === 'SUBMITTED' || outcome === 'UNKNOWN' ? outcome : null

const resultOutcome = (status: unknown): StudioRowLastPublish['outcome'] =>
  status === 'SUBMITTED' || status === 'ACCEPTED' || status === 'VERIFIED' || status === 'FAILED' ? status : null

function channelIssues(raw: unknown): StudioChannelIssue[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const issue = item as Record<string, unknown>
    if (typeof issue.message !== 'string') return []
    return [{
      code: typeof issue.code === 'string' ? issue.code : '',
      severity: issue.severity === 'error' || issue.severity === 'warning' ? issue.severity : 'info',
      message: issue.message,
      attributeNames: Array.isArray(issue.attributeNames) ? issue.attributeNames.filter((name): name is string => typeof name === 'string') : [],
    }]
  })
}

function sentFields(row: JournalRow): string[] {
  if (row.created) return [CREATE_FIELD]
  const fields = Array.isArray(row.fields) ? row.fields.filter((field): field is string => typeof field === 'string' && field.trim() !== '') : []
  return [...new Set(fields)]
}

/**
 * The newest publish journal or selling-change record per listing. One statement; each lateral step walks the
 * [channelListingId, createdAt] index.
 */
async function newestJournals(listingIds: string[]): Promise<JournalRow[]> {
  if (!listingIds.length) return []
  return prisma.$queryRaw<JournalRow[]>(Prisma.sql`
    SELECT l.id AS "listingId", j."publishEventId" AS "publicationId", j.reason, j.outcome, j."createdAt", j.sku, j.message, j.fields, j.created
      FROM unnest(${listingIds}::text[]) AS l(id)
      CROSS JOIN LATERAL (
        SELECT s."publishEventId", s.reason, s.outcome, s."createdAt",
               s.payload->>'sku' AS sku,
               CASE WHEN s.reason = 'publish' THEN NULL ELSE s.payload->>'message' END AS message,
               CASE WHEN s.reason = 'publish' THEN jsonb_path_query_array(s.payload, '$.requests[*].writes[*].field') ELSE '[]'::jsonb END AS fields,
               s.reason = 'publish' AND jsonb_path_exists(s.payload, '$.requests[*] ? (@.intentVersion == 1 && (@.message.operationType == "UPDATE" || @.operation == "AddFixedPriceItem"))') AS created
          FROM "ChannelListingSnapshot" s
         WHERE s."channelListingId" = l.id
           AND ((s.reason = 'publish' AND s.payload->>'kind' = ${PUBLICATION_KIND})
             OR (s.reason IN (${Prisma.join(SELLING_REASONS)}) AND s.payload->>'kind' = ${SELLING_KIND}))
         ORDER BY s."createdAt" DESC, s.id DESC
         LIMIT 1
      ) j`)
}

/**
 * The publications those journals belong to: status, sender, time and the stored result only. A publication made
 * while the previous release still served traffic may have no `kind` column yet; its `changes` says what it is.
 */
async function publications(ids: string[]): Promise<PublicationRow[]> {
  if (!ids.length) return []
  return prisma.$queryRaw<PublicationRow[]>(Prisma.sql`
    SELECT b.id, b.kind, b.status, b."userId", b."submittedAt", b."createdAt",
           CASE WHEN b.kind = ${SELLING_KIND} THEN NULL ELSE b.changes->'result' END AS result,
           CASE WHEN b.kind = ${SELLING_KIND} THEN NULL ELSE b.changes->'fullProductIds' END AS "fullProductIds"
      FROM "BulkOperation" b
     WHERE b.id = ANY(${ids}::text[])
       AND (b.kind IN (${PUBLICATION_KIND}, ${SELLING_KIND}) OR (b.kind IS NULL AND b.changes->>'kind' = ${PUBLICATION_KIND}))`)
}

/** A selling change's record as the row's last publish: its own outcome and message; no fields, no channel issues. */
function sellingLast(journal: JournalRow, publication: PublicationRow, userName: string | null, kind: LastPublishKind): LastPublish {
  return {
    publicationId: publication.id,
    status: SELLING_STATUS[publication.status] ?? publication.status,
    outcome: journal.outcome === 'ACCEPTED' ? 'ACCEPTED' : journal.outcome === 'FAILED' ? 'FAILED' : 'UNKNOWN',
    at: (publication.submittedAt ?? journal.createdAt).toISOString(),
    userName, message: journal.message || null, reference: null, sentFields: [], issues: [], kind,
  }
}

export async function readPublicationStatus(input: PublicationStatusInput, now = new Date()): Promise<PublicationStatusRead> {
  if (!input.channel?.trim()) throw new WorkspaceScopeError('Choose the channel.', 400)
  if (!input.accountId?.trim()) throw new WorkspaceScopeError('Choose the connected account.', 400)
  const channel = input.channel.trim().toUpperCase()
  const marketplace = input.marketplace.trim().toUpperCase()
  const destination = await resolveWorkspaceDestination({ productId: input.productId, channel, marketplace, accountId: input.accountId.trim(),
    ...(input.aliasKey?.trim() ? { aliasKey: input.aliasKey.trim() } : {}) })
  const accountId = destination.accountId
  const aliasKey = destination.aliasKey ?? ''
  const familyId = destination.familyId
  const where = { kind: PUBLICATION_KIND, productId: familyId, channel, marketplace, channelConnectionId: accountId, aliasKey }

  const [products, inFlight, latest] = await Promise.all([
    prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: familyId }, { parentId: familyId }] }, select: { id: true, sku: true } }),
    // In flight and not closed: a publication a person marked checked (D3) no longer holds the destination.
    prisma.bulkOperation.findFirst({ where: { ...where, ...OPEN_PUBLICATION }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true } }),
    prisma.bulkOperation.findFirst({ where: { ...where, status: { in: SENT } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, createdAt: true, submittedAt: true, completedAt: true, summary: true } }),
  ])
  const skuOf = new Map(products.map(product => [product.id, product.sku]))
  const listings = products.length ? await prisma.channelListing.findMany({
    where: { productId: { in: products.map(product => product.id) }, channel, marketplace, channelConnectionId: accountId, aliasKey },
    select: { id: true, productId: true }, orderBy: { id: 'asc' },
  }) : []
  const listingIds = listings.map(listing => listing.id)

  const [journals, openIssues] = await Promise.all([
    newestJournals(listingIds),
    listingIds.length ? prisma.listingIssue.findMany({ where: { listingId: { in: listingIds }, resolvedAt: null },
      select: { listingId: true, code: true, severity: true, message: true, attributeNames: true, source: true, lastSeenAt: true },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }] }) : Promise.resolve([]),
  ])
  const journalOf = new Map(journals.map(journal => [journal.listingId, journal]))
  const publicationIds = [...new Set(journals.map(journal => journal.publicationId).filter((id): id is string => !!id))]
  const sent = await publications(publicationIds)
  const publicationOf = new Map(sent.map(row => [row.id, row]))
  const userIds = [...new Set(sent.map(row => row.userId).filter((id): id is string => !!id))]
  const users = userIds.length ? await prisma.userProfile.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }) : []
  const nameOf = new Map(users.map(user => [user.id, user.displayName.trim() || null]))

  const issuesOf = new Map<string, StudioRowOpenIssue[]>()
  for (const issue of openIssues) {
    const list = issuesOf.get(issue.listingId) ?? []
    if (list.length >= ISSUES_PER_LISTING) continue
    list.push({ code: issue.code, severity: severityOf(issue.severity), message: issue.message, attributeNames: issue.attributeNames,
      source: issue.source, seenAt: issue.lastSeenAt.toISOString() })
    issuesOf.set(issue.listingId, list)
  }

  const rows = listings.map((listing): RowPublicationStatus => {
    const journal = journalOf.get(listing.id)
    const publication = journal?.publicationId ? publicationOf.get(journal.publicationId) : undefined
    let last: LastPublish | null = null
    const userName = publication?.userId ? nameOf.get(publication.userId) ?? null : null
    if (journal && publication && isSellingReason(journal.reason)) {
      last = publication.kind === SELLING_KIND ? sellingLast(journal, publication, userName, journal.reason) : null
    } else if (journal && publication && publication.kind !== SELLING_KIND) {
      const full = Array.isArray(publication.fullProductIds) && publication.fullProductIds.includes(listing.productId)
      const result = (publication.result && typeof publication.result === 'object' ? publication.result : null) as StudioPublishResult | null
      const entries = journal.sku && Array.isArray(result?.results) ? result!.results.filter(entry => entry?.sku === journal.sku) : []
      const entry = entries.length === 1 ? entries[0] : undefined
      last = {
        publicationId: publication.id,
        status: publication.status,
        outcome: resultOutcome(entry?.status) ?? journalOutcome(journal.outcome),
        at: (publication.submittedAt ?? journal.createdAt).toISOString(),
        userName,
        message: typeof entry?.message === 'string' ? entry.message : null,
        reference: typeof entry?.reference === 'string' && entry.reference ? entry.reference : null,
        sentFields: sentFields(journal),
        issues: channelIssues(entry?.issues),
        kind: full && !journal.created ? 'full_update' : 'publish',
      }
    }
    return { productId: listing.productId, listingId: listing.id, sku: skuOf.get(listing.productId) ?? '', last, issues: issuesOf.get(listing.id) ?? [] }
  })

  return {
    destination: { channel, marketplace, accountId, aliasKey },
    inFlight: inFlight ? { publicationId: inFlight.id, status: inFlight.status } : null,
    latest: latest ? { publicationId: latest.id, status: latest.status, at: (latest.submittedAt ?? latest.createdAt).toISOString(),
      completedAt: latest.completedAt?.toISOString() ?? null,
      summary: latest.summary && typeof latest.summary === 'object' && !Array.isArray(latest.summary) ? latest.summary as Record<string, unknown> : null } : null,
    rows,
    readAt: now.toISOString(),
  }
}
