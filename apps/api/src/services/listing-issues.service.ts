import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * ALA Phase 4 — Listings-Items issue mirror.
 *
 * Takes the live `issues` array from getListingsItem / searchListingsItems (and
 * our own VALIDATION_PREVIEW pre-check) and mirrors it into the ListingIssue
 * table with an open/resolved lifecycle: an issue still present bumps lastSeenAt;
 * an issue that disappears on the next sync is marked resolved. Keyed by a stable
 * fingerprint (code + sorted attributeNames) so re-syncs upsert instead of
 * duplicating. This is the per-attribute "what's wrong" signal the cockpit's
 * Pre-Flight health panel and health scoring read from — the detail the
 * defect-report-driven AmazonSuppression loses.
 */
import type { PrismaClient } from '@prisma/client'

export interface MirrorIssueInput {
  code: string
  message: string
  severity?: string
  attributeNames?: string[]
  categories?: string[]
}

/**
 * P3.2 — how much of the listing this source just spoke about.
 *
 * `replace` — the source reported the listing's CURRENT full state, so anything open
 * from that source and absent now is fixed. Amazon's validation preview and a
 * getListingsItem sync are both like this.
 *
 * `merge` — the source reported only what it touched. A JSON_LISTINGS_FEED defaults to
 * PARTIAL_UPDATE (see flat-file.service.ts: a full UPDATE drops attributes the row did
 * not resend, which is what sank the DE feed), so its report covers ONLY the attributes
 * in that feed. Resolving everything else from the source would silently close an open
 * issue about an attribute this feed never mentioned. A write response and a single
 * notification are partial in the same way.
 */
export type MirrorMode = 'replace' | 'merge'

export interface MirrorOptions {
  /** Default 'replace', which is what the two pre-P3.2 callers already relied on. */
  mode?: MirrorMode
  /**
   * When the CHANNEL says this was true, if that differs from when we read it. A feed
   * report reconciled at 04:00 is as of the feed's completion, not of the poll.
   */
  occurredAt?: Date | null
}

const SEVERITIES = new Set(['ERROR', 'WARNING', 'INFO'])

/** Normalise SP-API severity to our enum, defaulting unknown/blank to ERROR (fail-safe). */
export function normalizeSeverity(raw: string | undefined): string {
  const s = (raw ?? '').toUpperCase()
  return SEVERITIES.has(s) ? s : 'ERROR'
}

/** Stable identity for an issue on a listing: code + sorted attribute names. */
export function fingerprintIssue(code: string, attributeNames?: string[]): string {
  const attrs = [...(attributeNames ?? [])].map(String).sort().join(',')
  return `${code}::${attrs}`
}

/**
 * Mirror a listing's CURRENT issues for a given source into ListingIssue.
 * Upserts each fresh issue (reopening if previously resolved) and resolves any
 * previously-open issue from the same source that is no longer present. Returns
 * counts. `source` scopes the resolve sweep so a 'listings-api' sync never
 * resolves a 'validation-preview' issue and vice-versa.
 */
export async function mirrorListingIssues(
  prisma: PrismaClient,
  listingId: string,
  issues: MirrorIssueInput[],
  source = 'listings-api',
  options: MirrorOptions = {},
): Promise<{ open: number; resolved: number }> {
  const now = new Date()
  const mode: MirrorMode = options.mode ?? 'replace'
  const occurredAt = options.occurredAt ?? null
  const fresh = (issues ?? []).map((i) => ({
    code: String(i.code),
    message: String(i.message ?? ''),
    severity: normalizeSeverity(i.severity),
    attributeNames: (i.attributeNames ?? []).map(String),
    categories: (i.categories ?? []).map(String),
    fingerprint: fingerprintIssue(String(i.code), i.attributeNames),
  }))
  // De-dupe by fingerprint within this batch (Amazon can repeat a code).
  const byFingerprint = new Map(fresh.map((f) => [f.fingerprint, f]))
  const freshFingerprints = [...byFingerprint.keys()]

  for (const f of byFingerprint.values()) {
    await prisma.listingIssue.upsert({
      where: { listingId_fingerprint: workspaceKey({ listingId, fingerprint: f.fingerprint }) },
      create: {
        listingId,
        code: f.code,
        severity: f.severity,
        message: f.message,
        attributeNames: f.attributeNames,
        categories: f.categories,
        source,
        fingerprint: f.fingerprint,
        occurredAt,
      },
      update: {
        severity: f.severity,
        message: f.message,
        attributeNames: f.attributeNames,
        categories: f.categories,
        source,
        lastSeenAt: now,
        occurredAt,
        resolvedAt: null, // reopen if it had been resolved
      },
    })
  }

  // 'merge' sources spoke about part of the listing only, so silence about an issue is
  // not evidence it is fixed. Nothing is resolved here — the next 'replace' sync is
  // what closes them.
  if (mode === 'merge') return { open: byFingerprint.size, resolved: 0 }

  // Resolve open issues (this source) that are no longer present. With no fresh
  // issues, every open issue for the source is resolved.
  const resolved = await prisma.listingIssue.updateMany({
    where: {
      listingId,
      source,
      resolvedAt: null,
      ...(freshFingerprints.length ? { fingerprint: { notIn: freshFingerprints } } : {}),
    },
    data: { resolvedAt: now },
  })

  return { open: byFingerprint.size, resolved: resolved.count }
}
