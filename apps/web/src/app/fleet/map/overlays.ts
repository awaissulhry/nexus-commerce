/**
 * NAF.SB.M.4 — what the canvas is coloured by, and the legend that explains it.
 *
 * An overlay is not a colour scheme. It is an ordered list of buckets, a
 * function that puts a node in exactly one of them, and a sentence per bucket.
 * The canvas asks `bucketOf(node)` for a class name; the legend iterates the
 * same `buckets`. Neither knows anything the other does not, so a legend that
 * disagrees with the graph is not possible — which matters, because the map
 * ships with a colour vocabulary in production today that nothing anywhere
 * explains (`FleetMapCanvas` tints a border by autonomy level and no legend
 * says so).
 *
 * TWO RULES THE BUCKETS EXIST TO ENFORCE.
 *
 * 1. NO DATA IS NOT THE BOTTOM OF THE SCALE. Every overlay has nodes it cannot
 *    colour, and the temptation in all three is to hand them the lowest band.
 *    An edge with no traffic is not a fast edge; a worker that has never run is
 *    not a cheap worker. Those get a hatch and a legend entry saying why there
 *    is nothing to colour.
 *
 * 2. COLOUR IS NEVER THE ONLY CHANNEL. The node keeps its status glyph and the
 *    literal status word whatever overlay is selected, so switching to "cost"
 *    never costs the reader the ability to see what a worker IS. The overlay
 *    changes one channel, not the card.
 */
import type { MapNode } from './lib'
import { severeFailure, stoppedByLimit } from './lib'

export interface OverlayBucket {
  id: string
  /** Drives BOTH the node tint and the legend swatch — one class, so they
   *  cannot disagree. Defined in map.css; never an inline colour, because the
   *  DS ratchet's zero fallback applies to `app/fleet` and one inline hex
   *  blocks every concurrent session's push. */
  className: string
  /** What the reader sees in the legend. Operator language, not system
   *  language: "Last run ended in an error", not "status=ERROR". */
  label: string
  /** One more sentence, for the reader who needs it. */
  note?: string
}

export interface Overlay {
  id: string
  label: string
  /** The question this overlay answers, shown above the legend so a beginner
   *  knows what they are looking at before they read any colour. */
  question: string
  buckets: OverlayBucket[]
  bucketOf: (n: MapNode) => OverlayBucket
}

const byId = (buckets: OverlayBucket[], id: string): OverlayBucket => {
  const b = buckets.find((x) => x.id === id)
  if (!b) throw new Error(`overlay bucket "${id}" is not declared`)
  return b
}

/* ── 1 · autonomy — what each worker is allowed to do ──────────────────── */

const AUTONOMY_BUCKETS: OverlayBucket[] = [
  {
    id: 'unreadable',
    className: 'ov-nodata',
    label: 'Settings unreadable',
    note: 'Its settings could not be read, so what is shown is the safe fallback, not your choices.',
  },
  {
    id: 'not-set-up',
    className: 'ov-nodata',
    label: 'Never set up',
    note: 'It exists in code but has no settings row, so it cannot be switched on yet.',
  },
  {
    id: 'off',
    className: 'ov-off',
    label: 'Held at off',
    note: 'Switched off, or paused. It will not start, whatever the schedule says.',
  },
  {
    id: 'observe',
    className: 'ov-observe',
    label: 'May look, may not act',
    note: 'It can read and write findings. It cannot change anything on Amazon.',
  },
  {
    id: 'propose',
    className: 'ov-propose',
    label: 'May propose, you approve',
    note: 'Its suggestions queue for your yes or no. Nothing reaches Amazon until you approve it.',
  },
  {
    id: 'auto',
    className: 'ov-auto',
    label: 'May act on its own',
    note: 'It acts inside every safety gate, and changes your Amazon account without asking first.',
  },
]

/**
 * The tint is the level a worker would actually run at if a sweep started now.
 * Both halves of that are resolved server-side and must not be recomputed
 * here: `autonomyLevel` is already `min(level, cap)`, and a live pause resolves
 * `enabled` to false WITHOUT touching the dial — deliberately, so that
 * resuming restores what the operator had set. A node tinted from
 * `autonomyLevel` alone would therefore paint a paused worker as armed, which
 * is what the canvas does today.
 */
function autonomyBucket(n: MapNode): OverlayBucket {
  const c = n.charter
  if (c.degraded) return byId(AUTONOMY_BUCKETS, 'unreadable')
  if (c.provisioned === false) return byId(AUTONOMY_BUCKETS, 'not-set-up')
  if (!c.enabled || c.autonomyLevel === 'OFF') return byId(AUTONOMY_BUCKETS, 'off')
  const lvl = c.autonomyLevel.toLowerCase()
  if (lvl === 'observe') return byId(AUTONOMY_BUCKETS, 'observe')
  if (lvl === 'propose') return byId(AUTONOMY_BUCKETS, 'propose')
  return byId(AUTONOMY_BUCKETS, 'auto')
}

/* ── 2 · health — how the last run went ────────────────────────────────── */

const HEALTH_BUCKETS: OverlayBucket[] = [
  {
    id: 'never-run',
    className: 'ov-nodata',
    label: 'Never run',
    note: 'It has never run at all, so there is nothing to report yet.',
  },
  {
    id: 'no-runs',
    className: 'ov-nodata',
    label: 'No runs in this window',
    note: 'It has run before, but not inside the time window you are looking at.',
  },
  {
    id: 'failed',
    className: 'ov-bad',
    label: 'Last run ended in an error',
    note: 'Something went wrong. The worker card and its profile say what.',
  },
  {
    id: 'limit',
    className: 'ov-warn',
    label: 'Last run stopped at a limit',
    note: 'It hit one of its own budget or token limits and stopped part-way. Nothing is broken — that is a safety limit doing its job.',
  },
  {
    id: 'clean',
    className: 'ov-good',
    label: 'Last run finished cleanly',
  },
]

/**
 * Health is bucketed from the LAST RUN, not from `deriveStatus`. That is a
 * deliberate departure and it is worth saying why: `deriveStatus` ranks `off`
 * above a failed run, which is right for a status badge — a worker you
 * switched off is not asking you for anything — but it would make this overlay
 * useless on a fleet where every dial is off, painting all seven the same grey
 * and hiding every failure. This overlay answers "how did the last run go",
 * which is a different question from "may it run", and the legend says so.
 */
function healthBucket(n: MapNode): OverlayBucket {
  if (n.runs.lifetime === 0) return byId(HEALTH_BUCKETS, 'never-run')
  if (!n.lastRun) return byId(HEALTH_BUCKETS, 'no-runs')
  if (severeFailure(n)) return byId(HEALTH_BUCKETS, 'failed')
  if (stoppedByLimit(n)) return byId(HEALTH_BUCKETS, 'limit')
  return byId(HEALTH_BUCKETS, 'clean')
}

/* ── 3 · cost — who is expensive ───────────────────────────────────────── */

const COST_BUCKETS: OverlayBucket[] = [
  {
    id: 'no-data',
    className: 'ov-nodata',
    label: 'Nothing to measure',
    note: 'It did not run in this window, so it has no cost here — which is not the same as being cheap.',
  },
  {
    id: 'free',
    className: 'ov-cost0',
    label: 'Ran, and cost nothing',
    note: 'It ran but was skipped or answered from cache, so no model was billed.',
  },
  {
    id: 'low',
    className: 'ov-cost1',
    label: 'Under a cent',
  },
  {
    id: 'mid',
    className: 'ov-cost2',
    label: 'Up to one analyst’s daily budget',
    note: 'An analyst is allowed $0.10 a day.',
  },
  {
    id: 'high',
    className: 'ov-cost3',
    label: 'More than an analyst’s daily budget',
    note: 'Worth a look — not necessarily wrong, since a director does more work than an analyst.',
  },
]

/**
 * The distinction that earns this overlay its "no data" bucket: `$0.00 over
 * three runs` and `$0.00 over no runs` are different facts, and colouring them
 * the same would tell the operator a worker is cheap when it simply has not
 * run. `cost.runs` is on the payload for exactly this.
 */
function costBucket(n: MapNode): OverlayBucket {
  if (n.cost.runs === 0) return byId(COST_BUCKETS, 'no-data')
  const usd = n.cost.windowUSD
  if (usd === 0) return byId(COST_BUCKETS, 'free')
  if (usd < 0.01) return byId(COST_BUCKETS, 'low')
  if (usd <= 0.1) return byId(COST_BUCKETS, 'mid')
  return byId(COST_BUCKETS, 'high')
}

export const OVERLAYS: Overlay[] = [
  {
    id: 'autonomy',
    label: 'What it may do',
    question: 'What is each worker allowed to do right now?',
    buckets: AUTONOMY_BUCKETS,
    bucketOf: autonomyBucket,
  },
  {
    id: 'health',
    label: 'How it went',
    question: 'How did each worker’s last run go?',
    buckets: HEALTH_BUCKETS,
    bucketOf: healthBucket,
  },
  {
    id: 'cost',
    label: 'What it cost',
    question: 'What did each worker spend in this window?',
    buckets: COST_BUCKETS,
    bucketOf: costBucket,
  },
]

export function overlayById(id: string): Overlay {
  return OVERLAYS.find((o) => o.id === id) ?? OVERLAYS[0]
}

/**
 * A legend entry for a bucket no node on this canvas occupies teaches a colour
 * the reader will never see. The autonomy ladder is the deliberate exception:
 * OFF → OBSERVE → PROPOSE → AUTO is an ordered scale, and a scale with its
 * unused rungs removed stops showing where a worker sits on it.
 */
export function visibleBuckets(overlay: Overlay, nodes: MapNode[]): OverlayBucket[] {
  if (overlay.id === 'autonomy') return overlay.buckets
  const occupied = occupiedBucketIds(overlay, nodes)
  return overlay.buckets.filter((b) => occupied.has(b.id))
}

/**
 * Which buckets any node on this canvas is actually in.
 *
 * S3R. The autonomy exception above kept the unused rungs — rightly, a scale
 * with holes stops being a scale — but it was implemented as *keep the rungs
 * AND their paragraphs*, which is a much more expensive decision. Measured on
 * prod: five of six legend rows described a colour that was nowhere on the
 * canvas, and those five carried ~175px of the 210px of notes, on a rail whose
 * bottom block was already off the screen.
 *
 * A note explains something you can see. When there is nothing to see, the note
 * has no referent — so the rung keeps its swatch and its label, and says
 * plainly that it is empty. Derived from the same `bucketOf` pass that paints
 * the swatch, so it cannot disagree with the canvas, and it is a presence
 * marker rather than a count: the census band above the canvas owns every
 * number about the node population.
 */
export function occupiedBucketIds(overlay: Overlay, nodes: MapNode[]): Set<string> {
  return new Set(nodes.map((n) => overlay.bucketOf(n).id))
}
