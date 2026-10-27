// /marketing/reviews/insights — Insights has no page of its own: it opens on Themes (next.config.js redirects the
// address first, also inside a business; this page is the fallback when the redirect does not run).
import { redirect } from 'next/navigation'

export default function ReviewsInsightsPage() {
  redirect('/marketing/reviews/insights/themes')
}
