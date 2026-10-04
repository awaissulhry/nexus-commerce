'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/design-system/primitives'
import { useStudioProduct } from './contracts'
import { StudioPublishDialog as PublishDialog } from './StudioPublishDialog'
import { usePhotoPublish } from './images/plan-page/photoPublish'

/** Publishing is available on every studio tab and keeps the selected destination. On the Media page of a family on the
 *  photo plan it is the page's one Publish: it sends photos only (Media redesign, 2026-09-29). */
export function PublishMenu() {
  const product = useStudioProduct()
  const photos = usePhotoPublish()
  const [open, setOpen] = useState(false)
  if (photos) return <Button size="sm" variant="primary" disabled={!!product.deletedAt} onClick={photos.open}><Send size={14} aria-hidden />Publish photos</Button>
  return <>
    <Button size="sm" variant="primary" disabled={!!product.deletedAt} onClick={() => setOpen(true)}><Send size={14} aria-hidden />Publish</Button>
    {open && <PublishDialog onClose={() => setOpen(false)} />}
  </>
}
