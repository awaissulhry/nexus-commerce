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
): Promise<{ open: number; resolved: number }> {
  const now = new Date()
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
      where: { listingId_fingerprint: { listingId, fingerprint: f.fingerprint } },
      create: {
        listingId,
        code: f.code,
        severity: f.severity,
        message: f.message,
        attributeNames: f.attributeNames,
        categories: f.categories,
        source,
        fingerprint: f.fingerprint,
      },
      update: {
        severity: f.severity,
        message: f.message,
        attributeNames: f.attributeNames,
        categories: f.categories,
        source,
        lastSeenAt: now,
        resolvedAt: null, // reopen if it had been resolved
      },
    })
  }

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
