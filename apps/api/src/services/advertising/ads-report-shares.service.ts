/**
 * RPT.15 — read-only, expiring share links.
 *
 * The point of this feature is handing a number to someone who has no account.
 * That makes it the only unauthenticated path into the reporting engine, so the
 * design is deliberately narrow:
 *
 *  1. **The token is never stored.** Only its SHA-256 hash. A database
 *     disclosure therefore yields no working links, and the raw token is
 *     returned exactly once — we cannot show it again, by construction.
 *  2. **The query is frozen at creation** and is the ONLY query the public
 *     endpoint runs. It accepts no filter, grouping, column or date input from
 *     the caller. Without that rule, one leaked link would be an
 *     unauthenticated query interface over every report we have.
 *  3. **Expiry is mandatory** — there is no "never expires" option — and both
 *     expiry and revocation are re-checked on every single read, never cached.
 *  4. **Row caps apply.** A share serves a page, not a bulk extract.
 *
 * A resolved link deliberately returns no owner, no user id and no schedule
 * data. The recipient sees a table and the window it covers, nothing else.
 */
import { createHash, randomBytes } from 'node:crypto'
import prisma from '../../db.js'
import { getSpec, runReport, type ReportQuery } from './ads-report-runner.service.js'

export class ShareLinkError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/** Maximum lifetime. A link that outlives the question it answered is a liability. */
const MAX_TTL_DAYS = 90
const DEFAULT_TTL_DAYS = 7
/** A share serves a readable page, never a bulk extract. */
const MAX_PAGE_SIZE = 200

export interface ShareLinkDto {
  id: string
  reportId: string
  label: string | null
  expiresAt: string
  revokedAt: string | null
  isExpired: boolean
  isActive: boolean
  viewCount: number
  lastViewedAt: string | null
  createdAt: string
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * 32 random bytes, base64url. Unguessable by construction — never derive a token
 * from an id, a timestamp or a counter, all of which are enumerable.
 */
function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

function toDto(r: {
  id: string; reportId: string; label: string | null; expiresAt: Date; revokedAt: Date | null
  viewCount: number; lastViewedAt: Date | null; createdAt: Date
}): ShareLinkDto {
  const isExpired = r.expiresAt.getTime() <= Date.now()
  return {
    id: r.id,
    reportId: r.reportId,
    label: r.label,
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    isExpired,
    isActive: !isExpired && !r.revokedAt,
    viewCount: r.viewCount,
    lastViewedAt: r.lastViewedAt ? r.lastViewedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }
}

export async function createShareLink(input: {
  reportId: string
  query: ReportQuery
  label?: string | null
  ttlDays?: number
  createdBy?: string
}): Promise<{ link: ShareLinkDto; token: string }> {
  // Reject unknown reports before minting anything.
  getSpec(input.reportId)

  const ttl = input.ttlDays ?? DEFAULT_TTL_DAYS
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > MAX_TTL_DAYS) {
    throw new ShareLinkError(`ttlDays must be between 1 and ${MAX_TTL_DAYS}`)
  }

  const token = mintToken()
  // Page size is clamped at creation, not at read: the frozen query is the
  // contract, so it must already be safe on its own terms.
  //
  // `page` MUST be a real number. runReport treats `page == null` as EXPORT mode
  // and streams the entire result set — that is how CSV/XLSX work. A query
  // arriving without a page would therefore turn an unauthenticated link into a
  // full-table dump. Caught by the RPT.15 test, and the reason `page` is forced
  // here and again at read time rather than trusted from either side.
  const frozen: ReportQuery = {
    ...input.query,
    reportId: input.reportId,
    page: Math.max(1, input.query.page ?? 1),
    pageSize: Math.min(input.query.pageSize ?? 50, MAX_PAGE_SIZE),
  }

  const row = await prisma.reportShareLink.create({
    data: {
      tokenHash: hashToken(token),
      reportId: input.reportId,
      query: frozen as unknown as object,
      label: input.label?.trim() || null,
      createdBy: input.createdBy ?? 'default-user',
      expiresAt: new Date(Date.now() + ttl * 86_400_000),
    },
  })

  // The only time the raw token exists outside the recipient's URL bar.
  return { link: toDto(row), token }
}

export async function listShareLinks(createdBy?: string): Promise<ShareLinkDto[]> {
  const rows = await prisma.reportShareLink.findMany({
    where: createdBy ? { createdBy } : {},
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return rows.map(toDto)
}

/** Revocation is immediate and irreversible — re-sharing means minting a new link. */
export async function revokeShareLink(id: string): Promise<ShareLinkDto> {
  const existing = await prisma.reportShareLink.findUnique({ where: { id } })
  if (!existing) throw new ShareLinkError('Share link not found', 404)
  if (existing.revokedAt) return toDto(existing)
  const row = await prisma.reportShareLink.update({
    where: { id },
    data: { revokedAt: new Date() },
  })
  return toDto(row)
}

export interface ResolvedShare {
  reportId: string
  title: string
  label: string | null
  expiresAt: string
  /** Whatever runReport returns for the frozen query. */
  result: Awaited<ReturnType<typeof runReport>>
}

/**
 * The public read. Every failure mode returns the SAME message and status.
 *
 * Distinguishing "no such link" from "expired" from "revoked" would confirm to
 * an enumerating caller that a token once existed, and there is no legitimate
 * recipient who benefits from knowing which of the three it was.
 */
export async function resolveShareLink(token: string): Promise<ResolvedShare> {
  const deny = () => new ShareLinkError('This link is not valid, or has expired', 404)
  if (!token || token.length < 20 || token.length > 200) throw deny()

  const row = await prisma.reportShareLink.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!row) throw deny()
  if (row.revokedAt) throw deny()
  if (row.expiresAt.getTime() <= Date.now()) throw deny()

  const spec = getSpec(row.reportId)

  // The stored query, and nothing the caller supplied.
  const query = row.query as unknown as ReportQuery
  // `page` and `pageSize` are re-forced here even though creation already did
  // it. Rows predating that clamp, or written by any future path, must not be
  // able to reach export mode through this endpoint.
  const result = await runReport({
    ...query,
    reportId: row.reportId,
    page: Math.max(1, query.page ?? 1),
    pageSize: Math.min(query.pageSize ?? 50, MAX_PAGE_SIZE),
  })

  // Best-effort telemetry: a counter must never fail a legitimate read.
  await prisma.reportShareLink
    .update({
      where: { id: row.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    })
    .catch(() => undefined)

  return {
    reportId: row.reportId,
    title: spec.title,
    label: row.label,
    expiresAt: row.expiresAt.toISOString(),
    result,
  }
}
