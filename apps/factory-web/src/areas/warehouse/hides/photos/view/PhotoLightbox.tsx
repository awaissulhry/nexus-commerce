'use client'

import { Lightbox } from '@nexus/ui/patterns'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useWords } from '../../../lots/shared/parts'
import { photoCaption, photoPlaceKey, shownPhotos, type PhotoLightboxActions, type PhotoLightboxModel } from '../model'

/**
 * Hide photo (design warehouse.hides pop-up hd-photo, opened from a Thumbnail of the grid or a photo of the record): the DS
 * Lightbox over one hide's photos — the photo full size, where and when it was taken under the title, ← / → between photos,
 * Esc closes and gives the focus back. Only photos whose image was read are shown (an address that fails says so in the
 * record's card). Fetches nothing: the hook (use-hide-photos.ts) reads the addresses.
 */
export function PhotoLightbox({ model, timeZone, actions }: { model: PhotoLightboxModel | null; timeZone: string; actions?: PhotoLightboxActions }) {
  const t = useWords()
  const locale = useLocale()
  if (!model) return null
  const shown = shownPhotos(model.photos)
  if (shown.length === 0) return null
  const current = model.photos[model.index]
  const at = Math.max(0, shown.findIndex((photo) => photo.fileId === current?.fileId))
  const photo = shown[at]!
  const place = { locale, timeZone }
  return (
    <Lightbox
      open
      onClose={() => actions?.onClose?.()}
      items={shown.map((entry, n) => ({ url: entry.src!, alt: t('hd.photos.alt', { n: n + 1, count: shown.length, code: model.hideCode, place: t(photoPlaceKey(entry)) }) }))}
      index={at}
      onIndex={(next) => {
        const target = shown[next]
        const back = target ? model.photos.findIndex((entry) => entry.fileId === target.fileId) : -1
        if (back >= 0) actions?.onIndex?.(back)
      }}
      title={t('hd.photos.lightboxTitle', { code: model.hideCode, n: at + 1, count: shown.length })}
      meta={photoCaption(photo, t, place)}
      caption={photo.originalName}
    />
  )
}
