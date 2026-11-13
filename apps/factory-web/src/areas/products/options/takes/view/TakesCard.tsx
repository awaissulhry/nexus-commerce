'use client'

import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, RadioCard, Spinner } from '@nexus/ui/primitives'
import { FollowupsMessages, useFollowupsWords, type FollowupsSay } from '../../../../../lib/options-followups/words'
import type { Takes, TakesView } from '../api'
import { TAKES_CHOICES } from '../model'
import '../takes.css'

/** SCR-432's view model: what a chosen value of the group takes. */
export interface TakesModel {
  read: { status: 'loading' } | { status: 'error'; problem: FollowupsSay } | { status: 'ready' }
  view: TakesView | null
  draft: Takes
  /** Why Save waits (null: it can be pressed). */
  saveHeld: FollowupsSay | null
  notice: { tone: 'success' | 'danger' | 'warning'; words: FollowupsSay } | null
  offline: boolean
}

export interface TakesActions {
  onDraft?: (takes: Takes) => void
  onSave?: () => void
  onDiscard?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-432 — what a chosen value of an option group takes (B-W2b-374; XF3:05; Products › Options & rules › a group, its
 * Options tab): a colour of the library (a panel), a material and its colour (leather by article), or either (as before);
 * how many chosen options on quotes and orders pick each kind; Save held with why (chosen options of the other kind are
 * changed first). It fetches nothing.
 */
export function TakesCard({ model, actions }: { model: TakesModel; actions?: TakesActions }) {
  return (
    <FollowupsMessages>
      <Body model={model} actions={actions} />
    </FollowupsMessages>
  )
}

function Body({ model, actions }: { model: TakesModel; actions?: TakesActions }) {
  const { t, say } = useFollowupsWords()
  const view = model.view
  const editable = !!view && view.may.change
  return (
    <Card header={t('takes.title')}>
      <div className="fw-tk">
      {model.notice && (
        <Banner tone={model.notice.tone} onDismiss={actions?.onDismissNotice}>
          {say(model.notice.words)}
        </Banner>
      )}
      {model.offline && <Banner tone="warning">{t('common.offline')}</Banner>}
      {model.read.status === 'loading' && (
        <p className="fw-tk-hint" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      )}
      {model.read.status === 'error' && (
        <Banner tone="danger" action={actions?.onRetry ? <Button size="sm" onClick={actions.onRetry}>{t('common.retry')}</Button> : undefined}>
          {say(model.read.problem)}
        </Banner>
      )}
      {model.read.status === 'ready' && view && (
        <>
          {!view.may.change && view.may.held && <Banner tone="info">{say({ words: view.may.held })}</Banner>}
          <Field label={t('takes.label')} hint={t('takes.hint')}>
            <div className="fw-tk-choices" role="radiogroup" aria-label={t('takes.label')}>
              {TAKES_CHOICES.map((choice) => (
                <RadioCard
                  key={choice.value ?? 'NONE'}
                  variant="row"
                  name={`fw-takes-${view.groupId}`}
                  value={choice.value ?? 'NONE'}
                  checked={model.draft === choice.value}
                  disabled={!editable}
                  onChange={() => actions?.onDraft?.(choice.value)}
                  title={t(choice.label)}
                  description={t(choice.hint)}
                />
              ))}
            </div>
          </Field>
          <p className="fw-tk-hint">{t('takes.picking', { colours: view.picking.colours, materials: view.picking.materials })}</p>
          {editable && (
            <div className="fw-tk-actions">
              <Button size="sm" variant="primary" heldReason={model.saveHeld ? say(model.saveHeld) : null} onClick={() => actions?.onSave?.()}>
                {t('takes.save')}
              </Button>
              {model.draft !== view.takes && (
                <Button size="sm" variant="quiet" onClick={() => actions?.onDiscard?.()}>
                  {t('takes.discard')}
                </Button>
              )}
            </div>
          )}
        </>
      )}
      </div>
    </Card>
  )
}
