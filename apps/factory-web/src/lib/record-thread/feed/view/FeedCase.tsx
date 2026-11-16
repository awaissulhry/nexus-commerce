'use client'

import { ThreadMessages } from '../../parts/ThreadMessages'
import { Feed, type FeedModel } from './Feed'

/** SCR-006-feed: the feed in a column as tall as the docked thread's (design review only; the thread's own frame is SCR-006-thread). */
export function FeedCase({ model }: { model: FeedModel }) {
  return (
    <ThreadMessages>
      <div className="fw-rt-case">
        <Feed model={model} actions={{}} />
      </div>
    </ThreadMessages>
  )
}
