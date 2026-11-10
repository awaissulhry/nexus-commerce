'use client'

import type { ReactNode } from 'react'
import { Camera, CircleAlert, CloudOff, FileImage, HelpCircle, Layers, MessageSquareText, Ruler, ScanFace, X } from 'lucide-react'
import type { FloorProblem } from '@nexus/factory-domain/product/changes/rules'
import { Field } from '@nexus/ui/components'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { FloorButton } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { PHOTO_KIT_NAMESPACE, usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { TaskCard, TaskLine } from '../../shared/view/TaskParts'
import { photoHeld, PROBLEM_NOTE_MAX, PROBLEMS, type ProblemDraft } from '../model'

/**
 * floor.instructions sec:problem "Report a spec problem" (PRD-259; B-W2b-226's floor change request): what kind of problem (DS
 * ReasonGrid: wrong measurement, unclear, material differs, other), a photo if it helps (DS PhotoCapture with "keep faces out of
 * the picture": nothing looks for faces), a few words, Send. Linked to the operation and the work order by the screen; it names
 * nobody. Three taps on the usual path: Spec problem → type → Send.
 */

export type ProblemAction = { type: 'problemTile'; problem: FloorProblem } | { type: 'problemNote'; note: string } | { type: 'problemCapture'; open: boolean } | { type: 'problemPhoto'; photo: Blob } | { type: 'problemDrop' }

const LOOK: Readonly<Record<FloorProblem, { icon: ReactNode; tone: 'danger' | 'warning' | 'info' | 'neutral' }>> = {
  WRONG_MEASUREMENT: { icon: <Ruler />, tone: 'warning' },
  UNCLEAR: { icon: <HelpCircle />, tone: 'info' },
  MATERIAL_DIFFERS: { icon: <Layers />, tone: 'info' },
  OTHER: { icon: <MessageSquareText />, tone: 'neutral' },
}

function PhotoStep({ t, send }: { t: Translate; send: (action: ProblemAction) => void }) {
  const words = usePhotoWords()
  return (
    <div className="fw-floor-stack">
      <h2 className="fw-floor-section-title">{t('problem.photo')}</h2>
      <PhotoCapture label={t('problem.photo')} words={words} facesHint onCapture={(photo) => send({ type: 'problemPhoto', photo: photo.marked ?? photo.photo })} onCancel={() => send({ type: 'problemCapture', open: false })} />
    </div>
  )
}

export function ProblemBody({ draft, subject, online, t, send }: { draft: ProblemDraft; subject: string; online: boolean; t: Translate; send: (action: ProblemAction) => void }) {
  const locale = useLocale()
  const words = useReasonWords()
  if (draft.capture) {
    return (
      <WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}>
        <PhotoStep t={t} send={send} />
      </WithMessages>
    )
  }
  const tiles: ReasonTile[] = PROBLEMS.map((problem) => ({ id: problem, label: t(`problem.kind.${problem}`), ...LOOK[problem] }))
  const held = photoHeld(online)
  return (
    <div className="fw-task-split">
      <div className="fw-floor-stack">
        <TaskCard icon={<CircleAlert />} type={t('problem.title')} code={subject} id="fw-fi-problem-subject" />
        <ReasonGrid label={t('problem.question')} reasons={tiles} value={draft.problem} onChange={(id) => send({ type: 'problemTile', problem: id as FloorProblem })} words={words} locale={INTL_LOCALE[locale]} />
      </div>
      <div className="fw-floor-stack">
        <TaskLine tone="info" icon={<ScanFace />}>
          {t('problem.faces')}
        </TaskLine>
        {draft.photo ? (
          <div className="fw-fi-photo-row">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <FileImage />
            </span>
            <span className="fw-fi-photo-name">{draft.photo.name}</span>
            <FloorButton size="md" variant="secondary" icon={<X />} aria-label={t('problem.drop', { name: draft.photo.name })} onClick={() => send({ type: 'problemDrop' })} />
          </div>
        ) : (
          <FloorButton size="lg" block variant="secondary" icon={online ? <Camera /> : <CloudOff />} heldReason={held ? t('problem.photoOffline') : null} onClick={() => send({ type: 'problemCapture', open: true })}>
            {t('problem.photoOptional')}
          </FloorButton>
        )}
        <Field label={t('problem.words')} htmlFor="fw-fi-problem-words">
          <Textarea id="fw-fi-problem-words" value={draft.note} limit={PROBLEM_NOTE_MAX} maxLength={PROBLEM_NOTE_MAX} rows={3} onChange={(event) => send({ type: 'problemNote', note: event.target.value })} />
        </Field>
        {draft.problem === 'OTHER' && !draft.note.trim() ? (
          <TaskLine tone="warning" icon={<MessageSquareText />}>
            {t('problem.detail')}
          </TaskLine>
        ) : null}
        {!online ? (
          <TaskLine tone="info" icon={<CloudOff />}>
            {t('problem.offline')}
          </TaskLine>
        ) : null}
        <p className="fw-floor-muted">{t('problem.linked')}</p>
      </div>
    </div>
  )
}
