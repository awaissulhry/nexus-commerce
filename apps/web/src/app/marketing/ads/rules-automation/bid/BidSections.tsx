'use client'

/**
 * ⛔ PARKED 2026-08-16 (U1) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the seam that mounted Bounds · Activity · Staged tray.
 * Why it left: the Bid tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BidRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.2, §7.2).
 * Candidate home: travels with its three sections.
 *
 * Nothing here was changed, no endpoint was retired, and the file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BID.S0 — the seam where S1–S9 attach.
 *
 * Every one of the nine sections renders below the grid or over it, and every one of them needs
 * the same things: the resolved scope, the rows, the URL writer, and the reserved params. Rather
 * than each section reaching into `BidClient` and each arrival editing it, they land here — one
 * import line and one element apiece — and `BidClient` never changes shape again.
 *
 * This file renders nothing today, on purpose. It exists so that the props S1 needs are declared,
 * typed and already flowing before S1 is written; a contract added afterwards is a description of
 * whatever the first section happened to do, and by then the second section has to match it.
 *
 * The order below is the build order, which is not the display order — S2's columns land inside the
 * grid above, S1's band lands above it, and S3's drawer floats over everything. Each section's
 * comment says where it goes, so nobody has to re-derive the layout from the study.
 *
 *   S2  grid columns — band · suggested · bidder · sparkline      → inside the grid, via columns
 *   S3  the bid-curve drawer, `?target=`                          → portal over the page
 *   S1  the bidder band                                           → above the scope bar
 *   S5  bounds — floor/ceiling at four grains                     → a panel under the grid
 *   S8  activity — changes, refusals, failures                    → a panel under the grid
 *   S4  editing + the staged tray                                 → grid selection + a docked tray
 *   S6  bidder assignment + goal                                  → the campaign view's row action
 *   S7  rules as exceptions                                       → replaces the provisional list
 *   S9  notifications                                             → a panel under the grid
 *
 * 🔴 A section that writes must not simply appear. S0 is read-only, and `NO_WRITE_ACTIONS` in the
 * slot contract passes that as an explicit absence rather than an omission. The first section to
 * write replaces that object; it does not quietly stop passing it.
 */

import type { BidSlotProps } from './slot-contract'
import { BidBounds } from './BidBounds'
import { BidActivity } from './BidActivity'
import { BidStagedTray } from './BidStagedTray'

export function BidSections(props: BidSlotProps) {
  // S5 — bounds, then S8 — activity, then S4's staged tray (renders nothing while the hold is
  // empty). (S1's band mounts above the grid in BidClient; S3's drawer floats; S4's verbs ride
  // the grid selection; the remaining sections land here as built — hidden, not disabled.)
  return (
    <>
      <BidBounds {...props} />
      <BidActivity {...props} />
      <BidStagedTray />
    </>
  )
}
