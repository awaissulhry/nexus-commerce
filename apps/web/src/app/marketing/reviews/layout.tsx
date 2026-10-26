import { ReviewsShell } from './_shell/ReviewsShell'

/**
 * Every /marketing/reviews page, the old ones included, sits in the Reviews shell: the pinned Reviews sub-sidebar
 * beside the page (build spec §1, rulings 1 and 9). Each page renders its own PageHeader.
 */
export default function ReviewsLayout({ children }: { children: React.ReactNode }) {
  return <ReviewsShell>{children}</ReviewsShell>
}
