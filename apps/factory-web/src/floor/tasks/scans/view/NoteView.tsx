'use client'

import type { ReactNode } from 'react'
import { Camera, CircleAlert, CloudOff, FileImage, Film, Layers, MessageSquareText, PackageX, Palette, Ruler, Spline, TriangleAlert, Video, X } from 'lucide-react'
import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { FloorButton } from '@nexus/ui/floor'
import { Field } from '@nexus/ui/components'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { PHOTO_KIT_NAMESPACE, usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { WithMessages } from '../../../../record-panels/i18n'
import { HeldLine, TaskCard, TaskLine } from '../../shared/view/TaskParts'
import { FLOOR_NOTE_LIMITS, FLOOR_NOTE_TILES, moreFiles, type FloorNoteTileCode, type NoteDraft } from '../notes'
import { ClipCapture } from './ClipCapture'

/**
 * SCR-090 "Photo or comment" (MES-101, COL-017): what differs from the plan, on the work order's thread. A short tile first, then
 * a photo with the spot marked (D21: DS PhotoCapture, the marks drawn into the picture) or a 15-second clip, and a few words if
 * the person wants. "Keep faces out of the picture" stands over every camera (GDPR minimisation); nothing looks for faces.
 * Offline the comment is saved on the tablet and the camera is held with the reason: a picture needs the network.
 */

export type NoteAction =
  | { type: 'noteTile'; code: FloorNoteTileCode }
  | { type: 'noteWords'; words: string }
  | { type: 'noteCapture'; what: 'photo' | 'clip' | null }
  | { type: 'notePhoto'; photo: CapturedPhoto }
  | { type: 'noteClip'; clip: Blob; seconds: number }
  | { type: 'noteDrop'; id: string }

const TILE_LOOK: Readonly<Record<FloorNoteTileCode, { icon: ReactNode; tone: 'danger' | 'warning' | 'info' | 'neutral' }>> = {
  MATERIAL_DIFFERS: { icon: <Layers />, tone: 'info' },
  MEASURE_DIFFERS: { icon: <Ruler />, tone: 'info' },
  COLOUR_DIFFERS: { icon: <Palette />, tone: 'info' },
  STITCHING_DIFFERS: { icon: <Spline />, tone: 'warning' },
  DAMAGED: { icon: <TriangleAlert />, tone: 'danger' },
  PART_MISSING: { icon: <PackageX />, tone: 'warning' },
  OTHER: { icon: <MessageSquareText />, tone: 'neutral' },
}

/** The DS camera with its outline guide, "keep faces out" and the marks drawn into the picture (its words load with it). */
function PhotoStep({ t, send }: { t: Translate; send: (action: NoteAction) => void }) {
  const words = usePhotoWords()
  return (
    <div className="fw-floor-stack">
      <h2 className="fw-floor-section-title">{t('note.photo')}</h2>
      <PhotoCapture label={t('note.photo')} words={words} facesHint onCapture={(photo) => send({ type: 'notePhoto', photo })} onCancel={() => send({ type: 'noteCapture', what: null })} />
    </div>
  )
}

export function NoteBody({ draft, subject, online, t, send }: { draft: NoteDraft; subject: string; online: boolean; t: Translate; send: (action: NoteAction) => void }) {
  const locale = useLocale()
  const words = useReasonWords()
  const reminder = t('note.reminder')
  if (draft.capture === 'photo') {
    return (
      <WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}>
        <PhotoStep t={t} send={send} />
      </WithMessages>
    )
  }
  if (draft.capture === 'clip') {
    return (
      <div className="fw-floor-stack">
        <h2 className="fw-floor-section-title">{t('note.clip.title')}</h2>
        <ClipCapture seconds={FLOOR_NOTE_LIMITS.clipSeconds} reminder={reminder} t={t} onClip={(clip, seconds) => send({ type: 'noteClip', clip, seconds })} onCancel={() => send({ type: 'noteCapture', what: null })} />
      </div>
    )
  }
  const tiles: ReasonTile[] = FLOOR_NOTE_TILES.map((tile) => ({ id: tile.code, label: locale === 'it' ? tile.label.it : tile.label.en, ...TILE_LOOK[tile.code] }))
  const held = !online ? t('note.offline') : !moreFiles(draft) ? t('note.full', { count: FLOOR_NOTE_LIMITS.filesPerNote }) : draft.busy ? t('note.uploading') : null
  return (
    <div className="fw-task-split">
      <div className="fw-floor-stack">
        <TaskCard icon={<MessageSquareText />} type={t('note.title')} code={subject} id="fw-scans-note-subject" />
        <ReasonGrid label={t('note.question')} reasons={tiles} value={draft.tile} onChange={(id) => send({ type: 'noteTile', code: id as FloorNoteTileCode })} words={words} locale={INTL_LOCALE[locale]} />
      </div>
      <div className="fw-floor-stack">
        {!online ? <HeldLine text={t('note.offline')} /> : null}
        <TaskLine tone="info" icon={<Camera />}>
          {reminder}
        </TaskLine>
        <div className="fw-scans-more">
          <FloorButton size="lg" block variant="secondary" icon={<Camera />} heldReason={held} onClick={() => send({ type: 'noteCapture', what: 'photo' })}>
            {t('note.photo')}
          </FloorButton>
          <FloorButton size="lg" block variant="secondary" icon={<Video />} heldReason={held} onClick={() => send({ type: 'noteCapture', what: 'clip' })}>
            {t('note.clip.title')}
          </FloorButton>
        </div>
        {draft.failed ? (
          <TaskLine tone="danger" icon={<CircleAlert />} alert>
            {t('note.failed')}
          </TaskLine>
        ) : null}
        {draft.busy ? <p className="fw-floor-muted" aria-busy="true">{t('note.uploading')}</p> : null}
        {draft.files.map((file) => (
          <div key={file.id} className="fw-scans-lot">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              {file.kind === 'clip' ? <Film /> : <FileImage />}
            </span>
            <span className="fw-scans-lot-code">{file.name}</span>
            <FloorButton size="md" variant="secondary" icon={<X />} aria-label={t('note.drop', { name: file.name })} onClick={() => send({ type: 'noteDrop', id: file.id })} />
          </div>
        ))}
        <Field label={t('note.words')} htmlFor="fw-scans-note-words">
          <Textarea id="fw-scans-note-words" value={draft.words} limit={FLOOR_NOTE_LIMITS.noteMax} maxLength={FLOOR_NOTE_LIMITS.noteMax} rows={3} onChange={(event) => send({ type: 'noteWords', words: event.target.value })} />
        </Field>
        {draft.tile === 'OTHER' && !draft.words.trim() && draft.files.length === 0 ? (
          <TaskLine tone="warning" icon={online ? <TriangleAlert /> : <CloudOff />}>
            {t('note.detail')}
          </TaskLine>
        ) : null}
      </div>
    </div>
  )
}
