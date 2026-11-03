'use client'

import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { PHOTO_KIT_NAMESPACE, usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { WithMessages } from '../../../../record-panels/i18n'

/**
 * The photo of the hide on the table before cutting (design floor.hidecut sec "photo", MES-060; DS FloorPhotoCapture = the DS
 * PhotoCapture, gap D21): the camera or a file, the outline guide, the "keep faces out of the picture" line, no markup (one
 * job: the hide as it lies). The camera starts only when the cutter asks. The part's words come from `photo-kit`, which the
 * floor layout does not load: `WithMessages` gives it to this part alone. The screen uploads the photo (online).
 */

export interface HidePhotoProps {
  label: string
  onCapture: (photo: CapturedPhoto) => void | Promise<void>
  onCancel: () => void
  /** Why nothing can be taken now (offline: the photo is sent at once, never queued). */
  heldReason?: string | null
}

export function HidePhoto(props: HidePhotoProps) {
  return (
    <WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}>
      <Capture {...props} />
    </WithMessages>
  )
}

function Capture({ label, onCapture, onCancel, heldReason }: HidePhotoProps) {
  const words = usePhotoWords()
  return <PhotoCapture label={label} markup={false} guide="frame" facesHint onCapture={onCapture} onCancel={onCancel} heldReason={heldReason ?? null} words={words} />
}
