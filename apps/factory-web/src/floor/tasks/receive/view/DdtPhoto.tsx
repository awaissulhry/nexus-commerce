'use client'

import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { PHOTO_KIT_NAMESPACE, usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { WithMessages } from '../../../../record-panels/i18n'

/**
 * The supplier's delivery note photo at receiving (B-W2a-75; design floor.receive sec "ddt": camera; DS part
 * FloorPhotoCapture = the DS PhotoCapture, gap D21, B-W2a-24): the camera or a file, no markup (a document, not a
 * defect), the "keep faces out" hint. The part's words come from the `photo-kit` catalogue, which the floor layout does
 * not load: `WithMessages` gives it to this part alone. The photo is kept on the tablet until the receipt is posted, then
 * sent as the receipt's photo.
 */

export interface DdtPhotoProps {
  label: string
  onCapture: (photo: CapturedPhoto) => void
  onCancel: () => void
  heldReason?: string | null
}

export function DdtPhoto(props: DdtPhotoProps) {
  return (
    <WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}>
      <Capture {...props} />
    </WithMessages>
  )
}

function Capture({ label, onCapture, onCancel, heldReason }: DdtPhotoProps) {
  const words = usePhotoWords()
  return <PhotoCapture label={label} markup={false} guide="frame" onCapture={onCapture} onCancel={onCancel} heldReason={heldReason ?? null} words={words} />
}
