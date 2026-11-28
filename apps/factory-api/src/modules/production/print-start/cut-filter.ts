import type { Prisma } from '@nexus/factory-db'

/**
 * Guard 3 of baskets made at print (owb- order workflow, S3 ss2 step 2.4; PL-review § 4): a reader that takes "a bundle exists" as
 * "the cell is cut" reads only the bundles that WERE cut — a bundle made at cutting (madeAtPrint false), or a basket made at
 * "Print and start the work" once the bench attached its first cut log entries (cutLogIds not empty). Without it a printed order
 * shows the customer "Cutting" on day 1 and freezes the customer's changes. One Prisma fragment, spread into the bundle reads of
 * modules/sales/change-requests/store.ts and modules/sales/order-changes/stages.ts (S2's yes, shared-asks 08:27).
 */
export const BUNDLE_IS_CUT: Prisma.BundleWhereInput = { OR: [{ madeAtPrint: false }, { NOT: { cutLogIds: { isEmpty: true } } }] }
