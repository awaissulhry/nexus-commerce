// Promotions migrated to /pricing/promotions in E.1 (alongside the rest of
// the pricing surface). Redirect any old bookmarks / cross-links to the new
// home so they don't 404 on the deprecated stub.
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function MarketingPromotionsRedirect() {
  redirect('/pricing/promotions')
}
