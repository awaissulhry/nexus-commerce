import { redirect } from 'next/navigation'

// /insights was renamed to /dashboard/overview in an earlier phase but
// the sidebar still says "Insights" — this redirect keeps the label
// (and any external links) working without renaming the underlying
// page or duplicating the dashboard.
export default function InsightsPage() {
  redirect('/dashboard/overview')
}
