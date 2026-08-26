/**
 * RD.P0 — the slot every section of this page mounts inside.
 *
 * This is the page's *contract for geometry*, and it exists so that P1–P7 get the layout right by
 * construction instead of each re-measuring it on prod. Two things it guarantees:
 *
 *   · **Zero horizontal inset.** The gutter inside `.h10-rules-page` is 0 — `h10-main`'s 30px
 *     padding IS the gutter, and every block on this page sits at 96→1698 at innerWidth 1728. A
 *     section styled `margin: … 24px` (the pattern that got copied from `.h10-svt-seg`, now
 *     retired in favour of the DS `SegmentedControl`) ends up
 *     inset 24px past everything else and is the only staggered thing on screen. `.rd-sec` carries
 *     no horizontal margin at all, so a section cannot acquire one by accident.
 *   · **An anchor.** `#rd-p2`, `#rd-p6`… so a tile, a digest line or a deep link can scroll to the
 *     section it is talking about.
 *
 * It deliberately adds no vertical rhythm of its own: the blocks inside already carry their
 * margins, and a `<section>` with no padding or border lets those collapse through exactly as they
 * did before this wrapper existed. Adding spacing here would change the page while claiming to
 * restructure it.
 *
 * Sections that are not built are NOT MOUNTED — there is no empty placeholder card. An empty card
 * is dead space, and P0's standard is that the page must look no worse than it did before.
 */
import type { ReactNode } from 'react'

export function RdSection({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={`rd-${id}`} className="rd-sec" data-rd-section={id}>
      {children}
    </section>
  )
}
