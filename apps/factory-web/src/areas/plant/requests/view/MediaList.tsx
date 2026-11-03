'use client'

import { AudioLines, ImageOff } from 'lucide-react'
import { Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { useLocale } from '../../../../lib/i18n/provider'
import type { Translate } from '../../_shared/parts'
import { mediaKey, type MediaView } from '../depth/model'
import '../depth/depth.css'

/**
 * Photos and voice notes of a request or a job (B-W2b-140; QHS-189; design plant.requests pop:request "photo (Lightbox)
 * and voice note", plant.jobs "Photos": "Photos with before / after tag, voice notes … Lightbox"): each photo a
 * thumbnail that opens the Lightbox, tagged before / after the work; each voice note played here. A file is read with
 * the files right (files.read); without it the list says so. Faces never: the floor's camera says so as it takes them.
 */
export function MediaList({ media, canRead, t, place, onPhoto, empty }: { media: readonly MediaView[]; canRead: boolean; t: Translate; place: { locale: ReturnType<typeof useLocale>; timeZone: string }; onPhoto?: (id: string) => void; empty?: string }) {
  if (media.length === 0) return <p className="fw-pl-hint">{empty ?? t('media.none')}</p>
  if (!canRead) return <p className="fw-pl-hint">{t('media.noRead', { count: media.length })}</p>
  const photos = media.filter((entry) => entry.kind === 'PHOTO')
  const voices = media.filter((entry) => entry.kind === 'AUDIO')
  const when = (entry: MediaView) => (entry.availableAt ? formatDateTime(entry.availableAt, place) : null)
  return (
    <div className="fw-pl-stack tight">
      {photos.length > 0 && (
        <div className="fw-pd-media">
          {photos.map((photo, at) => (
            <figure key={photo.id} className="fw-pd-media-item">
              {photo.src ? (
                <button type="button" className="fw-pl-photo" aria-label={t('media.openPhoto', { n: at + 1, what: t(mediaKey(photo)) })} onClick={() => onPhoto?.(photo.id)}>
                  {/* A presigned address of the files API; the DS Lightbox draws it full size. */}
                  <img src={photo.src} alt={t('media.photoAlt', { n: at + 1, what: t(mediaKey(photo)) })} />
                </button>
              ) : (
                <span className="fw-pl-hint">
                  <ImageOff size={14} aria-hidden /> {t('media.unread', { name: photo.name })}
                </span>
              )}
              <figcaption className="fw-pl-row">
                <Tag tone={photo.category === 'AFTER_WORK' ? 'success' : photo.category === 'BEFORE_WORK' ? 'warning' : 'neutral'}>{t(mediaKey(photo))}</Tag>
                {when(photo) && <span className="fw-pl-sub">{when(photo)}</span>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {voices.length > 0 && (
        <ul className="fw-pd-voices" aria-label={t('media.voices')}>
          {voices.map((voice, at) => (
            <li key={voice.id}>
              <span className="fw-pl-symptom">
                <AudioLines size={14} aria-hidden /> {t('media.voiceN', { n: at + 1 })}
              </span>
              {voice.src ? <audio src={voice.src} controls preload="auto" aria-label={t('media.listenTo', { n: at + 1 })} /> : <span className="fw-pl-hint">{t('media.unread', { name: voice.name })}</span>}
              {when(voice) && <span className="fw-pl-sub">{when(voice)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
