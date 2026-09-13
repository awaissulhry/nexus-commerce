/**
 * GDS — the ONE identity band, in the engine so both sheets draw the same row (#710).
 *
 * 🔴 Why this exists. Master drew identity across THREE pinned columns — `product` (expander + P/C
 * chip + thumbnail), `sku` (180px) and `completeness` (90px) — while the channel scope drew its own
 * `__identity`. Two surfaces, two layouts, and the Owner reading the same product on both:
 * *"It must all be the same exactly, visually and all."* Three columns also meant three widths to
 * keep in step, which is how the chip came to overlap the thumbnail (#709a): each column was sized
 * on its own and none of them was sized on the content.
 *
 * One component, one content-derived width, one row kind. A lane composes it by passing nodes; it
 * does not re-implement the layout, and it cannot drift from the other scope because there is only
 * one of these.
 *
 * The ORDER is fixed here on purpose — expander, role, picture, identity text, state — because that
 * order is the thing being made identical. What each slot CONTAINS is the lane's business: master
 * passes a P/C chip and a product name, a channel passes its alias mark and the axis values.
 */
import { memo, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'

/* The DS `Thumbnail`, the same one `IdentityCell` draws — not a lookalike. */
import { Menu, Thumbnail, type MenuItemDef } from '../../components'

export interface IdentityBandProps {
  /**
   * The tree control. A parent gets `ExpandButton`, a leaf gets `ExpandSlot` — never nothing, or
   * the SKUs in a family start on two different x positions and the column reads ragged.
   */
  expand?: ReactNode
  /** Who this row is: `P`/`C` on master, the primary/alias mark on a channel. */
  role?: ReactNode
  image?: string | null
  photoCount?: number
  /**
   * A BAND row carries no picture — an alias header is about the listing, not about one variant, and
   * a thumbnail there claims the band owns an image it does not have.
   */
  noImage?: boolean
  /**
   * A mark ABOUT THE PICTURE, drawn beside it — master's "inherited" glyph when a variation is
   * showing the family's image. It is not part of `role`: `role` says what the ROW is, this says
   * whose the photograph is, and a quarter of children have no image of their own.
   */
  imageMark?: ReactNode
  /** The key, monospace. Never edited here. */
  sku: ReactNode
  /** The second line: the product name on master, the axis values where the family varies. */
  secondary?: ReactNode
  /** Full text for the second line when it truncates. */
  secondaryTitle?: string
  /** Pinned RIGHT: readiness, and any state pill the scope owns. */
  trailing?: ReactNode
  /**
   * The row's verb menu, rendered as the LAST trailing item (#724).
   *
   * 🔴 In the band, not in a column of its own. A 56px `actions` column exists only to hold a `⋯`
   * that is already at the row's identity — and it is the difference between master's pinned set and
   * the channel's, which is the thing #710 exists to remove. The DS `Menu` with an icon Button
   * trigger, the same shape `ActionsCell` uses: one menu convention, not a second.
   */
  menuItems?: MenuItemDef[]
  /** Accessible name for the `⋯` trigger — a menu whose button is unnamed is unreachable by name. */
  menuLabel?: string
}

export const IdentityBand = memo(function IdentityBand({
  expand, role, image, photoCount, noImage, imageMark, sku, secondary, secondaryTitle, trailing,
  menuItems, menuLabel,
}: IdentityBandProps) {
  return (
    <div className="nds-identity-band">
      {expand}
      {role}
      {!noImage && (
        <span className="nds-identity-band-pic">
          <Thumbnail src={image ?? null} photoCount={photoCount} alt="" />
          {imageMark}
        </span>
      )}
      <span className="nds-identity-band-text">
        <span className="nds-identity-band-sku">{sku}</span>
        {secondary != null && secondary !== '' && (
          <span className="nds-identity-band-sub" title={secondaryTitle}>{secondary}</span>
        )}
      </span>
      {(trailing != null || (menuItems && menuItems.length > 0)) && (
        <span className="nds-identity-band-trail">
          {trailing}
          {menuItems && menuItems.length > 0 && (
            <Menu
              label={<MoreHorizontal size={15} />}
              items={menuItems}
              align="right"
              triggerProps={{ className: 'nds-btn sm icon', 'aria-label': menuLabel ?? 'Row actions' }}
            />
          )}
        </span>
      )}
    </div>
  )
})

export { CompletenessPill, type CompletenessPillProps } from './CompletenessPill'
