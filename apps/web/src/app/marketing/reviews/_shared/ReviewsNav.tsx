'use client'

/**
 * The old Reviews pages' header strip, until PR D retires it. The tab strip that used to sit here is gone: the Reviews
 * sub-sidebar (app/marketing/reviews/layout.tsx) is the navigation now. What stays is the channel × market filter those
 * pages still read, and the "Reviews" button that opens the sub-sidebar below 1024 px (these pages have no PageHeader
 * of their own to put it in).
 */
import { ReviewsMenuButton } from '../_shell/ReviewsShell'
import { GlobalFilterBar } from './GlobalFilterBar'

export function ReviewsNav() {
  return (
    <>
      <ReviewsMenuButton />
      <GlobalFilterBar />
    </>
  )
}

/** Theme words, for the old pages that import them from here (moved to `_lib/reviewWords.ts`). */
export { THEME_LABEL as CATEGORY_LABEL } from '../_lib/reviewWords'
