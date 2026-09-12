/**
 * PES.7 — reading an exact-mirror diff safely. Pure, tested.
 *
 * An exact-mirror publish makes Amazon match Nexus, which means it REMOVES slots Amazon has that
 * Nexus does not fill. `deletes` is therefore the most consequential number on the surface, and the
 * one an operator must not misread.
 *
 * 🔴 **The trap this module exists for.** `buildMirrorDiff` compares Nexus's plan against the
 * CACHED `ChannelLiveImage` rows — the same cache that is empty until somebody reads the listing
 * back. Measured on GALE-JACKET: 0 cached rows. Against an empty cache every slot looks absent, so
 * the diff comes back as "N adds, 0 deletes" — which READS as "nothing will be removed" when the
 * truth is "nothing is known about what is there". Presenting that as a safe diff would be the
 * worst lie this tab could tell, because the operator would approve a publish believing it removes
 * nothing.
 *
 * So the diff is only ever presented as a comparison when there is something to compare against.
 */

export interface MirrorAsin {
  sku: string
  asin: string | null
  skipped: boolean
  adds: { slot: string; url: string }[]
  replaces: { slot: string; live: string; next: string }[]
  deletes: { slot: string; url: string }[]
  unchanged: number
}

export interface MirrorDiff {
  perAsin: MirrorAsin[]
  totals: { adds: number; replaces: number; deletes: number; asins: number; skipped: number }
}

export type MirrorTrust =
  /** The live cache holds rows, so the comparison means something. */
  | 'comparable'
  /** The live cache is empty — the diff describes nothing real. */
  | 'unknown'

export interface MirrorReading {
  trust: MirrorTrust
  /** Only ever non-null when `trust` is 'comparable'. */
  totals: MirrorDiff['totals'] | null
  /** The sentence the surface must show. Never omitted. */
  statement: string
  /** True only when a mirror publish can be honestly described. */
  canDescribePublish: boolean
  /** ASINs left untouched because Nexus has no MAIN for them. */
  skipped: number
}

export function readMirrorDiff(args: {
  diff: MirrorDiff | null
  /** How many rows the live read-back cache holds for this market. */
  liveRowCount: number
}): MirrorReading {
  const { diff, liveRowCount } = args

  if (!diff) {
    return {
      trust: 'unknown', totals: null, skipped: 0, canDescribePublish: false,
      statement: 'The mirror comparison has not run yet.',
    }
  }

  if (liveRowCount === 0) {
    return {
      trust: 'unknown',
      // Withheld on purpose: publishing these numbers next to the word "deletes" would invite
      // exactly the misreading described above.
      totals: null,
      skipped: diff.totals.skipped,
      canDescribePublish: false,
      statement:
        'Amazon has not been read back for this market, so there is nothing to compare against. '
        + 'A mirror publish REMOVES any slot Amazon has that Nexus does not fill — and right now we '
        + 'do not know what Amazon has, so we cannot say what would be removed. Check Amazon first.',
    }
  }

  const t = diff.totals
  const parts = [
    `${t.adds} slot${t.adds === 1 ? '' : 's'} added`,
    `${t.replaces} replaced`,
    `${t.deletes} REMOVED from Amazon`,
  ]
  const skippedNote = t.skipped > 0
    ? ` ${t.skipped} ASIN${t.skipped === 1 ? ' is' : 's are'} skipped entirely because Nexus has no MAIN image for them — those listings are left untouched rather than wiped.`
    : ''

  return {
    trust: 'comparable',
    totals: t,
    skipped: t.skipped,
    canDescribePublish: true,
    statement: `Against what Amazon is currently serving: ${parts.join(', ')}.${skippedNote}`,
  }
}

/** The ASINs where something would actually be removed — the rows worth reading before publishing. */
export function asinsLosingImages(diff: MirrorDiff | null): MirrorAsin[] {
  if (!diff) return []
  return diff.perAsin.filter((a) => a.deletes.length > 0)
}
