/**
 * MS.5 — the master sheet's publish PREVIEW.
 *
 * `docs/2026-08-29-master-sheet-design.md` §13. Publishing is outward-facing and hard to reverse, so
 * the sheet never sends anything as a side effect of a click. This service answers one question and
 * makes no channel call whatsoever: *if I published these rows to this coordinate right now, what
 * would happen to each one?*
 *
 * It deliberately adds NO publish path. The actual send stays on the routes that already own it —
 * `POST /api/products/:id/publish-amazon`, which has its own dry-run parameter and its own env gate
 * — and the sheet calls those only after an operator has seen this preview and confirmed.
 *
 * The verdicts:
 *   `blocked`  — readiness has errors; the channel would refuse it, so we refuse it here and name
 *                the fields, rather than spending an API call to be told the same thing.
 *   `unlisted` — nothing exists on the channel yet. Still sendable (that is how a listing is born),
 *                but called out because it is a create, not an update.
 *   `ready`    — every required field is present and the row is already listed.
 *   `warned`   — sendable, but something would probably be rejected downstream (an off-list value).
 */
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { getSheetRows, coordKey, type ReadinessIssue } from './sheet-rows.service.js'
import { UnknownMarketError } from './sheet-columns.service.js'

export type PublishVerdict = 'ready' | 'warned' | 'unlisted' | 'blocked'

export interface PublishPreviewRow {
  id: string
  sku: string
  name: string | null
  isParent: boolean
  verdict: PublishVerdict
  /** Why it is blocked, or what would probably be rejected. */
  issues: ReadinessIssue[]
  /** The channel's own id, when the row is already listed. */
  ref?: string
}

export interface PublishPreview {
  channel: string
  marketplace: string
  coordinate: string
  rows: PublishPreviewRow[]
  summary: { total: number; sendable: number; blocked: number; unlisted: number; warned: number }
  /**
   * What the PLATFORM would actually do on a real send. `dry-run` (the default everywhere) means
   * even a confirmed publish is simulated — the operator must know that, or a green result is
   * mistaken for a live listing.
   */
  publishMode: string
  /** Coordinates this sheet cannot send to from here, and why. */
  notSendable?: string
}

export interface PublishPreviewInput {
  ids: string[]
  channel: string
  marketplace: string
}

export async function previewPublish(input: PublishPreviewInput): Promise<PublishPreview> {
  const channel = String(input.channel).toUpperCase()
  const marketplace = String(input.marketplace).toUpperCase()
  const ids = [...new Set((input.ids ?? []).filter(Boolean))]

  if (ids.length === 0) throw new Error('ids[] is required')

  // The market is the sheet's own axis; an unknown one is an error, not an empty preview.
  const page = await getSheetRows({ market: marketplace, ids, limit: Math.min(200, Math.max(1, ids.length)) })

  const key = coordKey({ channel, marketplace })
  const coordinate = page.coordinates.find((c) => coordKey(c) === key)
  if (!coordinate) {
    throw new UnknownMarketError(
      `${channel}:${marketplace}`,
      page.coordinates.map((c) => `${c.channel}:${c.marketplace}`),
    )
  }

  const rows: PublishPreviewRow[] = page.rows.map((r) => {
    const readiness = r.readiness[key]
    const issues = readiness?.issues ?? []
    const hasError = issues.some((i) => i.severity === 'error')
    const verdict: PublishVerdict = hasError
      ? 'blocked'
      : readiness?.state === 'unlisted'
        ? 'unlisted'
        : issues.length > 0
          ? 'warned'
          : 'ready'
    return { id: r.id, sku: r.sku, name: r.name, isParent: r.isParent, verdict, issues, ref: readiness?.ref }
  })

  const count = (v: PublishVerdict) => rows.filter((r) => r.verdict === v).length
  const blocked = count('blocked')

  return {
    channel,
    marketplace,
    coordinate: coordinate.label,
    rows,
    summary: {
      total: rows.length,
      sendable: rows.length - blocked,
      blocked,
      unlisted: count('unlisted'),
      warned: count('warned'),
    },
    publishMode: publishModeFor(channel),
    notSendable: notSendableReason(channel),
  }
}

/**
 * The platform's real mode, from the SAME gates the publish routes consult — never re-derived from
 * env here. A preview that says "live" while the gate says "dry-run" would have an operator believe
 * a listing went out.
 */
function publishModeFor(channel: string): string {
  if (channel === 'AMAZON') return getAmazonPublishMode()
  if (channel === 'EBAY') return getEbayPublishMode()
  return 'unknown'
}

/**
 * Why a coordinate cannot be SENT from the sheet, even when its rows are green.
 *
 * eBay's publish route re-publishes an EXISTING offer (it answers "No offer found — push first")
 * and takes no dry-run parameter, so there is no way to rehearse it. Wiring a one-click send to a
 * live marketplace call that cannot be simulated is not something the sheet should do; the preview
 * is still useful, and the eBay flat-file surface still owns the send.
 */
function notSendableReason(channel: string): string | undefined {
  if (channel === 'EBAY') {
    return 'eBay is preview-only from the sheet: its publish route updates an existing offer and has no dry run, so it cannot be rehearsed. Use the eBay flat-file surface to send.'
  }
  if (channel !== 'AMAZON') {
    return `${channel} has no publish route wired to the sheet.`
  }
  return undefined
}
