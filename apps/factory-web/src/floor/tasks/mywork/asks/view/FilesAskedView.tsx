'use client'

import { Camera, CircleAlert, CircleCheckBig, Clock, FileQuestion } from 'lucide-react'
import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { FloorButton } from '@nexus/ui/floor'
import { PHOTO_KIT_NAMESPACE, usePhotoWords } from '../../../../../lib/ds-words/photo-capture'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { HeldLine, TaskLine } from '../../../shared/view/TaskParts'
import { askPhotoHeld, floorAskCards, type AskPhotoOutcome, type FloorAsk } from '../model'
import './asked.css'

export type FilesAskedAction = { readonly type: 'photo'; readonly askId: string | null } | { readonly type: 'captured'; readonly askId: string; readonly photo: CapturedPhoto } | { readonly type: 'dismiss' }

export interface FilesAskedModel {
  /** null: not read (or not there yet: no section at all). */
  readonly asks: readonly FloorAsk[] | null
  readonly online: boolean
  /** The ask whose camera is open. */
  readonly capture: string | null
  readonly busy: boolean
  readonly outcome: { readonly askId: string; readonly outcome: AskPhotoOutcome } | null
}

/**
 * F-OF-204 (order FILES tab W2; 10-design §8) — "Files asked (1)" on My work: one card per ask — "Photos for step 3 · Sewing", the work
 * order, the customer's floor code, due and "2 days late", "The office asks: …", "Asked again: …", "The office asked for an update, …";
 * the big "Photo for this ask" (the DS camera: keep faces out of the picture), then "Sent to the office." No worker's name, no "seen".
 * Offline the camera waits (L8). Draws its model; fetches nothing.
 */
export function FilesAskedView({ model, onAction }: { model: FilesAskedModel; onAction?: (action: FilesAskedAction) => void }) {
  const t = useT('floor-mywork')
  const locale = useLocale()
  const send = (action: FilesAskedAction) => onAction?.(action)
  if (!model.asks || model.asks.length === 0) return null
  const capturing = model.capture ? model.asks.find((ask) => ask.askId === model.capture) ?? null : null
  if (capturing) {
    return (
      <WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}>
        <AskCamera ask={capturing} onCapture={(photo) => send({ type: 'captured', askId: capturing.askId, photo })} onCancel={() => send({ type: 'photo', askId: null })} />
      </WithMessages>
    )
  }
  const held = askPhotoHeld({ online: model.online, busy: model.busy })
  return (
    <section className="fw-floor-stack fw-mywork-asked" aria-labelledby="fw-mywork-asked">
      <h2 id="fw-mywork-asked" className="fw-floor-section-title">
        {t('asked.title', { count: model.asks.length })}
      </h2>
      {!model.online ? <HeldLine text={t('asked.offline')} /> : null}
      {model.outcome ? (
        <TaskLine tone={model.outcome.outcome === 'failed' ? 'danger' : 'success'} icon={model.outcome.outcome === 'failed' ? <CircleAlert /> : <CircleCheckBig />} alert>
          {t(`asked.${model.outcome.outcome}`)}
        </TaskLine>
      ) : null}
      <ul className="fw-mywork-asked-list">
        {floorAskCards(model.asks).map((ask) => (
          <li key={ask.askId} className="fw-mywork-asked-card">
            <p className="fw-mywork-asked-what">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <FileQuestion />
              </span>
              {ask.step ? t('asked.forStep', { seq: ask.step.seq, name: ask.step.name }) : t('asked.forOrder')}
            </p>
            <p className="fw-floor-muted">
              <span className="fw-floor-code">{ask.workOrder.number}</span>
              {ask.customer ? ` · ${t('asked.customer', { code: ask.customer })}` : ''} · {t('asked.due', { date: formatDate(ask.dueOn, { locale }) })}
              {ask.lateDays > 0 ? (
                <span className="fw-floor-pill" data-tone="warning">
                  <span className="fw-floor-inline-icon" aria-hidden="true">
                    <Clock />
                  </span>
                  {t('asked.late', { count: ask.lateDays })}
                </span>
              ) : null}
            </p>
            {ask.words ? <p className="fw-mywork-asked-words">{t('asked.office', { words: ask.words })}</p> : null}
            {ask.askedAgain ? <p className="fw-floor-muted">{t('asked.again', { reason: ask.askedAgain })}</p> : null}
            {ask.chasedAt ? <p className="fw-floor-muted">{t('asked.chased', { date: formatDate(ask.chasedAt, { locale }) })}</p> : null}
            <FloorButton size="lg" block variant="primary" icon={<Camera />} heldReason={held ? t(held) : null} onClick={() => send({ type: 'photo', askId: ask.askId })}>
              {t('asked.photo')}
            </FloorButton>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The DS camera for one ask: its words on top, "keep faces out of the picture", the marks drawn into the picture. */
function AskCamera({ ask, onCapture, onCancel }: { ask: FloorAsk; onCapture: (photo: CapturedPhoto) => void; onCancel: () => void }) {
  const t = useT('floor-mywork')
  const words = usePhotoWords()
  return (
    <div className="fw-floor-stack">
      <h2 className="fw-floor-section-title">{t('asked.photo')}</h2>
      {ask.words ? <p className="fw-mywork-asked-words">{t('asked.office', { words: ask.words })}</p> : null}
      <PhotoCapture label={t('asked.photo')} words={words} facesHint onCapture={onCapture} onCancel={onCancel} />
    </div>
  )
}
