import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'

export const dynamic = 'force-dynamic'

export default async function FeedbackPage() {
  // U.61 — defensive try/catch. See /catalog/drafts for context.
  let feedbacks: any[] = []
  try {
    feedbacks = await prisma.sellerFeedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[performance/feedback] prisma error:', err)
  }

  // Compute stats
  const totalFeedback = feedbacks.length
  const avgRating = totalFeedback > 0
    ? feedbacks.reduce((sum: number, f: any) => sum + f.rating, 0) / totalFeedback
    : 0
  const positiveCount = feedbacks.filter((f: any) => f.rating >= 4).length
  const neutralCount = feedbacks.filter((f: any) => f.rating === 3).length
  const negativeCount = feedbacks.filter((f: any) => f.rating <= 2).length
  const positiveRate = totalFeedback > 0 ? (positiveCount / totalFeedback) * 100 : 0

  const ratingStars = (rating: number) => {
    return Array.from({ length: 5 }, (_, i) => (
      <span key={i} className={i < rating ? 'text-yellow-400' : 'text-gray-300'}>★</span>
    ))
  }

  return (
    <div>
      <PageHeader
        title="Seller Feedback"
        subtitle="Customer feedback and ratings"
        breadcrumbs={[
          { label: 'Performance', href: '#' },
          { label: 'Feedback' },
        ]}
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-card rounded-lg shadow border border-default p-5">
          <p className="text-xs font-medium text-tertiary uppercase tracking-wide">Average Rating</p>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-2xl font-bold text-primary">{avgRating.toFixed(1)}</p>
            <div className="flex text-lg">{ratingStars(Math.round(avgRating))}</div>
          </div>
        </div>
        <div className="bg-card rounded-lg shadow border border-default p-5">
          <p className="text-xs font-medium text-tertiary uppercase tracking-wide">Positive</p>
          <p className="text-2xl font-bold text-success-strong mt-1">{positiveCount}</p>
          <p className="text-xs text-tertiary">{positiveRate.toFixed(0)}% of total</p>
        </div>
        <div className="bg-card rounded-lg shadow border border-default p-5">
          <p className="text-xs font-medium text-tertiary uppercase tracking-wide">Neutral</p>
          <p className="text-2xl font-bold text-warning-strong mt-1">{neutralCount}</p>
        </div>
        <div className="bg-card rounded-lg shadow border border-default p-5">
          <p className="text-xs font-medium text-tertiary uppercase tracking-wide">Negative</p>
          <p className="text-2xl font-bold text-danger-strong mt-1">{negativeCount}</p>
        </div>
      </div>

      {/* Rating Distribution */}
      <div className="bg-card rounded-lg shadow border border-default p-6 mb-6">
        <h3 className="text-sm font-semibold text-primary mb-4">Rating Distribution</h3>
        <div className="space-y-2">
          {[5, 4, 3, 2, 1].map((star) => {
            const count = feedbacks.filter((f: any) => f.rating === star).length
            const pct = totalFeedback > 0 ? (count / totalFeedback) * 100 : 0
            return (
              <div key={star} className="flex items-center gap-3">
                <span className="text-sm font-medium text-secondary w-12">{star} star</span>
                <div className="flex-1 bg-sunken rounded-full h-3 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      star >= 4 ? 'bg-green-500' : star === 3 ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-sm text-tertiary w-16 text-right">{count} ({pct.toFixed(0)}%)</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Feedback Table */}
      <div className="bg-card rounded-lg shadow border border-default overflow-hidden">
        <div className="px-6 py-4 border-b border-default">
          <h3 className="text-sm font-semibold text-primary">Recent Feedback</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-sunken border-b border-default">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-tertiary uppercase tracking-wider">Date</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-tertiary uppercase tracking-wider">Rating</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-tertiary uppercase tracking-wider">Buyer</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-tertiary uppercase tracking-wider">Comment</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-tertiary uppercase tracking-wider">Order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {feedbacks.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-sm text-tertiary">
                    No feedback received yet.
                  </td>
                </tr>
              ) : (
                feedbacks.map((feedback: any) => (
                  <tr key={feedback.id} className="hover:bg-sunken transition-colors">
                    <td className="px-6 py-4 text-sm text-secondary whitespace-nowrap">
                      {new Date(feedback.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1.5">
                        <div className="flex text-sm">{ratingStars(feedback.rating)}</div>
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                          feedback.rating >= 4
                            ? 'bg-success-soft text-success-strong'
                            : feedback.rating === 3
                              ? 'bg-warning-soft text-warning-strong'
                              : 'bg-danger-soft text-danger-strong'
                        }`}>
                          {feedback.rating}/5
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-primary">
                      {feedback.buyerName || '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-secondary max-w-md">
                      {feedback.comment ? (
                        <p className="truncate">{feedback.comment}</p>
                      ) : (
                        <span className="text-tertiary italic">No comment</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-secondary font-mono">
                      {feedback.orderId || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
