// Reviews › channel pages — the lock of a `/marketing/reviews/<channel>/<market>` route (server only): the market is two
// letters (`gb` is the UK), or the page does not exist (the Listings pattern, listings/_readiness/ReadinessPage.tsx).
import { notFound } from 'next/navigation'
import { lockOf, type ReviewsChannel, type ReviewsLock } from './reviewsScope'

export async function marketLock(channel: ReviewsChannel, params: Promise<{ market: string }>): Promise<ReviewsLock> {
  const lock = lockOf(channel, (await params).market)
  if (!lock) notFound()
  return lock
}
