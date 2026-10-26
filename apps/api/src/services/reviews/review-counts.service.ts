/**
 * Reviews area — counts for the navigation badges (the app rail's Reviews row and the Reviews sub-sidebar's Inbox
 * row), read by GET /api/sidebar/counts. Fixture rows never count (review-visibility.ts).
 */
import prisma from '../../db.js'
import { needsReplyWhere } from './review-visibility.js'

/** Reviews that need a reply: visible, and New or In progress (or not triaged yet). */
export async function reviewsNeedReplyCount(): Promise<number> {
  return prisma.review.count({ where: needsReplyWhere() })
}
