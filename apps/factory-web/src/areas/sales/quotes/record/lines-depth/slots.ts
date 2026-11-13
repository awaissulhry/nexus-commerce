import type { ReactNode } from 'react'
import type { MenuItemDef } from '@nexus/ui/components'
import type { QuoteLine } from '../../api'

/**
 * Where the quote record's W2b parts (B-W2b-316) sit in W1's record (SCR-035): each W1 tab draws its slot in one place
 * and nothing else changes in it. The container `use-depth.tsx` fills them on the live page; the design index fills them
 * from made-up data (fixtures.ts, SCR-035-depth). Absent: the W1 record as it was.
 */
export interface QuoteDepthSlots {
  /** A notice of a W2b action (saved, sent, refused in words), under the record's own. */
  notice?: ReactNode
  /** Lines: the Warnings section and the Blocks | Table switch, above the composer. */
  linesTop?: ReactNode
  /** Lines › Table view: drawn in place of the style blocks while it is on (null: the blocks). */
  linesTable?: ReactNode | null
  /** Lines › Add a style: "Paste lines" and "From inquiry …". */
  composerExtra?: ReactNode
  /** A style block's ⋯: "Open line …" per colour line and "Fill by curve…". */
  blockItems?: (block: { styleId: string; code: string; lines: readonly QuoteLine[] }) => MenuItemDef[]
  /** Price & margin › Target price. */
  price?: ReactNode
  /** Terms & delivery › Validity and offer: the validity's state and the acceptance mode. */
  termsValidity?: ReactNode
  /** Terms & delivery › Delivery: Incoterm and place, ship complete, Check capacity, the delivery schedule per line. */
  termsDelivery?: ReactNode
  /** Versions: the versions in the list frame (two selected → Compare), in place of W1's table. */
  versionsList?: ReactNode
  /** Documents › Deposit request: Send the pay-online page. */
  depositActions?: ReactNode
  /** The line drawer and the W2b dialogs (paste, fill, bulk, compare). */
  overlay?: ReactNode
  // B-W2b-343 (prices on screen, price-depth/use-price-depth.tsx): Price & margin › Pricing by line in place of W1's table,
  // and a style block's discount and price by size under its prices.
  pricing?: ReactNode
  blockPrices?: (block: { styleId: string; lines: readonly QuoteLine[] }) => ReactNode
}
