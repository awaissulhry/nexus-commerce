'use client'

import { ThreadMessages } from '../../parts/ThreadMessages'
import { Feed, type FeedModel } from './Feed'

/** SCR-006-feed: the feed in a column as tall as the docked thread's (design review only; the thread's own frame is SCR-006-thread). */
export function FeedCase({ model }: { model: FeedModel }) {
  return (
    <ThreadMessages>
      <div className="fw-rt-case">
        {/* B-TH-255: "Show all" drawn on the line of what the View hides (the live thread puts the View back to All). */}
        <Feed model={model} actions={{ onShowAll: () => undefined }} />
      </div>
    </ThreadMessages>
  )
}
