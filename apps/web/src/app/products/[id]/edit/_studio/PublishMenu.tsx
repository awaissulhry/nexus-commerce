'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import type { WaitingCounts } from '@nexus/shared/publish-actions'
import { Button } from '@/design-system/primitives'
import { useStudioProduct } from './contracts'
import { publishButtonWords } from './SellingSummary'
import { StudioPublishDialog as PublishDialog } from './StudioPublishDialog'
import { usePhotoPublish } from './images/plan-page/photoPublish'

/** Publishing is available on every studio tab and keeps the selected destination. On the Media page of a family on the
 *  photo plan it is the page's one Publish: it sends photos only (Media redesign, 2026-09-29). */
export function PublishMenu({ waiting }: {
  /** Build shape v2, P9 — the family's Status and Action values waiting for Publish: "Publish · 4" (the header reads them). */
  waiting?: WaitingCounts | null
} = {}) {
  const product = useStudioProduct()
  const photos = usePhotoPublish()
  const [open, setOpen] = useState(false)
  if (photos) return <Button size="sm" variant="primary" disabled={!!product.deletedAt} onClick={photos.open}><Send size={14} aria-hidden />Publish photos</Button>
  const words = publishButtonWords(waiting)
  return <>
    <Button size="sm" variant="primary" disabled={!!product.deletedAt} onClick={() => setOpen(true)} title={words.title} aria-label={words.ariaLabel}><Send size={14} aria-hidden />{words.label}</Button>
    {open && <PublishDialog onClose={() => setOpen(false)} />}
  </>
}
