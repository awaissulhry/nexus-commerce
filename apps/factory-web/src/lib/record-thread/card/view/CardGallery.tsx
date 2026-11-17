'use client'

import { useT } from '../../../i18n/provider'
import { ThreadMessages } from '../../parts/ThreadMessages'
import type { CardContext, CardMessage } from '../model'
import { MessageCard } from './MessageCard'

export interface CardGalleryModel {
  messages: readonly CardMessage[]
  context: CardContext
}

/** SCR-006-card: cards one under the other, in a column as wide as the docked thread (design review only). */
export function CardGallery({ model }: { model: CardGalleryModel }) {
  return (
    <ThreadMessages>
      <Gallery model={model} />
    </ThreadMessages>
  )
}

function Gallery({ model }: { model: CardGalleryModel }) {
  const t = useT('record-thread-feed')
  return (
    <div className="fw-rt-card-gallery" role="feed" aria-label={t('feed.label')}>
      {model.messages.map((message) => (
        <MessageCard key={message.id} message={message} context={model.context} actions={{}} />
      ))}
    </div>
  )
}
