'use client'

import { AlertTriangle, CircleCheck, Hourglass, Info, Lock } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Textarea } from '../../i18n/ds-parts'
import { WindowShell } from '../../window-shell/view/WindowShell'
import { reviewPointsOf, type ReviewDraft } from '../review-send'
import { DraftDoorProvider, useDraftWords } from '../words'
import '../order-draft.css'

/**
 * owb-po3.4 — the window "Review and send" (design § 5h; prototype sheet.js `sendModal`) for ONE or MANY drafts: each draft's lines and
 * pieces, its price (agreed, agreed for a part, or "the factory answers"; money only), its open points as WARNINGS (nothing here stops
 * you), a note to the factory (one draft), ONE button. A colleague who may not order reads who may (the button waits and says why).
 * After a send of many: how many went and each refused one with why (the server's words). The orders sheet (po7) and the order band
 * (web B) open it; on the base's WindowShell.
 */

export interface ReviewSendModel {
  readonly open: boolean
  readonly drafts: readonly ReviewDraft[]
  readonly currency: string
  /** The note to the factory (offered for one draft: it joins the draft's message). */
  readonly note: string
  readonly noteDoor: boolean
  /** Why Send waits (words: a colleague who may not order, a preview, offline), or null. */
  readonly held: string | null
  readonly busy: boolean
  /** After a send of many: how many went and the refused ones with why; null before. */
  readonly results: { readonly sent: number; readonly refused: readonly { readonly id: string; readonly title: string; readonly words: string }[] } | null
}

export interface ReviewSendActions {
  readonly onClose: () => void
  readonly onNote?: (text: string) => void
  readonly onSend?: () => void
}

export function ReviewSendWindow({ model, actions }: { model: ReviewSendModel; actions: ReviewSendActions }) {
  return (
    <DraftDoorProvider door="portal">
      <ReviewSendFrame model={model} actions={actions} />
    </DraftDoorProvider>
  )
}

function ReviewSendFrame({ model, actions }: { model: ReviewSendModel; actions: ReviewSendActions }) {
  const { t } = useDraftWords()
  const one = model.drafts.length === 1
  const act = model.results ? null : { words: one ? t('window.send') : t('review.sendMany', { n: model.drafts.length }), onAct: () => actions.onSend?.(), held: model.held, busy: model.busy }
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={one ? t('review.title') : t('review.titleMany', { n: model.drafts.length })} subtitle={t('review.sub')} act={act} size="lg" closeHeld={model.busy ? t('window.busy') : null}>
      <ReviewSendBody model={model} actions={actions} />
    </WindowShell>
  )
}

/** The window's body (exported for the tests: a server render draws no dialog). */
export function ReviewSendBody({ model, actions }: { model: ReviewSendModel; actions: ReviewSendActions }) {
  const words = useDraftWords()
  const { t } = words
  const money = (amount: string) => {
    const number = Number(amount)
    return Number.isFinite(number) ? new Intl.NumberFormat(words.locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency: model.currency }).format(number) : amount
  }
  if (model.results) {
    return (
      <div className="fw-odw">
        {model.results.sent > 0 ? <Banner tone="success" icon={<CircleCheck size={16} aria-hidden />} title={t('review.sentMany', { count: model.results.sent })} /> : null}
        {model.results.refused.length > 0 ? (
          <Banner tone="warning" icon={<AlertTriangle size={16} aria-hidden />} title={t('review.refusedMany', { count: model.results.refused.length })}>
            <ul className="fw-od-notes">
              {model.results.refused.map((row) => (
                <li key={row.id}>
                  <strong>{row.title}</strong>: {row.words}
                </li>
              ))}
            </ul>
          </Banner>
        ) : null}
      </div>
    )
  }
  return (
    <div className="fw-odw">
      {model.drafts.map((draft) => (
        <Card key={draft.id} padded>
          <section className="fw-od-section" aria-label={draft.title}>
            <div className="fw-od-parthead">
              <h3 className="fw-od-h2">{draft.title}</h3>
              {draft.price ? (
                <span className="fw-od-total">
                  {draft.price.kind === 'FACTORY' ? t('review.priceFactory') : t(draft.price.kind === 'AGREED' ? 'review.priceAgreed' : 'review.pricePart', { amount: money(draft.price.amount) })}
                </span>
              ) : null}
            </div>
            <ul className="fw-od-still">
              {reviewPointsOf(draft).map((point) => (
                <li key={point.key} className={point.ok ? 'fw-od-quiet' : 'fw-od-held'}>
                  {point.ok ? <CircleCheck size={14} aria-hidden /> : <Hourglass size={14} aria-hidden />} {t(point.key, point.key === 'review.wanted' && point.params ? { ...point.params, day: words.day(String(point.params.day)) } : point.params)}
                </li>
              ))}
            </ul>
          </section>
        </Card>
      ))}
      {model.noteDoor ? (
        <Field label={t('review.note')}>
          <Textarea value={model.note} rows={2} maxLength={1000} placeholder={t('review.notePh')} onChange={(event) => actions.onNote?.(event.target.value)} />
        </Field>
      ) : null}
      {model.held ? (
        <Banner tone="warning" icon={<Lock size={16} aria-hidden />} title={model.held} />
      ) : (
        <p className="fw-od-quiet">
          <Info size={14} aria-hidden /> {t('review.nothingStops')}
        </p>
      )}
    </div>
  )
}
