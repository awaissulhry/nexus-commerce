'use client'

import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Banner, EmptyState, Field, Stepper, SummaryTable } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Checkbox, Input, RadioCard, Select, Skeleton } from '@nexus/ui/primitives'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { OutcomeWanted, ReturnableItem, ReturnableRead } from '../api'
import { itemFacts, LIMITS, pickable, startLineOf, type StartDraft, type StartLine, type StartStep, type StartType } from '../model'
import { useScopedT, useT } from '../../../../lib/i18n/provider'
import { RepairStartDetails, RepairStartReview } from '../repair/StartParts'
import { useReturnWords } from '../words'

/**
 * SCR-187 › "Start a return or claim" (design portal.customer.returns h.act, primary; the same forms as links.claim, by
 * the portal): three steps — what you need (a return or a quality complaint; repair, remake and safety come with W2b-5),
 * the details (for a return: the items we delivered that may come back, each with its pieces and reason, what you would
 * like, your reference and a note; for a complaint: the item, its serial or batch and what happened), check and send.
 * The end says the case number and when we answer (DS EndState); photos are added on the case's Request tab. ← → move
 * between steps (outside a field), Esc closes; typed work asks Discard / Stay first. Words by code, never the API's.
 */

export interface StartDialogModel {
  state: 'loading' | 'error' | 'ready'
  read: ReturnableRead | null
  draft: StartDraft
  /** The problems shown at their fields (after Next or Send was pressed): field → key. */
  problems: Readonly<Record<string, string>>
  /** Send waits: why (a key), or null. */
  held: string | null
  busy: boolean
  /** The API refused the send: why (a key). */
  problem: string | null
  /** Close was asked with typed work. */
  discard: boolean
  sent: { type: StartType; number: string; answerBy: string | null; href: string } | null
}

export interface StartDialogActions {
  onType?: (type: StartType) => void
  onLine?: (key: string, patch: Partial<StartLine>) => void
  onDraft?: (patch: Partial<StartDraft>) => void
  onNext?: () => void
  onBack?: () => void
  onSend?: () => void
  onClose?: () => void
  onDiscard?: () => void
  onStay?: () => void
  onRetry?: () => void
}

const STEPS: readonly StartStep[] = ['type', 'details', 'review']

export function StartDialog({ model, actions }: { model: StartDialogModel; actions?: StartDialogActions }) {
  const { t, day } = useReturnWords()
  const r = useT('returns-repair')
  // B-W2b-342: a repair's refusal names its own catalogue (`returns-repair:…`).
  const scoped = useScopedT('portal-returns')
  const ds = useDsWords()
  const draft = model.draft
  const bodyRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  // ← → between the steps, only while the focus is in this dialog and not in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const dialog = bodyRef.current?.closest('[role="dialog"]')
      const active = document.activeElement
      if (!dialog || !active || !dialog.contains(active) || active.closest('input, textarea, select, [role="radiogroup"]')) return
      const { model: now, actions: act } = latest.current
      if (now.sent || now.busy) return
      event.preventDefault()
      if (event.key === 'ArrowLeft' && now.draft.step !== 'type') act?.onBack?.()
      if (event.key === 'ArrowRight' && now.draft.step !== 'review') act?.onNext?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const problem = (field: string) => (model.problems[field] ? t(model.problems[field]!) : undefined)
  const at = STEPS.indexOf(draft.step)
  const close = () => actions?.onClose?.()

  if (model.sent) {
    const sent = model.sent
    return (
      <Modal open onClose={close} size="lg" sheet title={t('start.title')}>
        <div ref={bodyRef} className="fw-pret-dialog">
          <EndState
            title={sent.type === 'REPAIR' ? r('portal.start.sent', { number: sent.number }) : t(sent.type === 'RETURN' ? 'start.sent.return' : 'start.sent.complaint', { number: sent.number })}
            body={sent.answerBy ? t('start.sent.answerBy', { date: day(sent.answerBy) }) : t('start.sent.answerSoon')}
            next={sent.type === 'REPAIR' ? [r('portal.start.sentPhotos'), r('portal.start.sentNext')] : [t('start.sent.photos'), t(sent.type === 'RETURN' ? 'start.sent.nextReturn' : 'start.sent.nextComplaint')]}
            reference={{ value: sent.number, label: t('start.sent.reference') }}
            actions={[
              { label: sent.type === 'REPAIR' ? r('portal.start.open') : t(sent.type === 'RETURN' ? 'start.sent.openReturn' : 'start.sent.openComplaint'), href: sent.href, variant: 'primary' },
              { label: t('start.sent.close'), onClick: close },
            ]}
            labels={ds.endState}
          />
        </div>
      </Modal>
    )
  }

  const footer = model.discard ? (
    <>
      <Button variant="secondary" data-autofocus onClick={() => actions?.onStay?.()}>
        {t('start.stay')}
      </Button>
      <Button variant="danger" onClick={() => actions?.onDiscard?.()}>
        {t('start.discard')}
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" onClick={close} heldReason={model.busy ? t('held.busy') : null}>
        {t('start.cancel')}
      </Button>
      {draft.step !== 'type' ? (
        <Button variant="secondary" onClick={() => actions?.onBack?.()} heldReason={model.busy ? t('held.busy') : null} aria-keyshortcuts="ArrowLeft">
          {t('start.back')}
        </Button>
      ) : null}
      {draft.step === 'review' ? (
        <Button variant="primary" onClick={() => actions?.onSend?.()} heldReason={model.held ? t(model.held) : null}>
          {model.busy ? t('start.sending') : draft.type === 'REPAIR' ? r('portal.start.send') : t(draft.type === 'RETURN' ? 'start.sendReturn' : 'start.sendComplaint')}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => actions?.onNext?.()} heldReason={model.state === 'loading' && draft.step === 'details' ? t('held.reading') : null} aria-keyshortcuts="ArrowRight">
          {t('start.next')}
        </Button>
      )}
    </>
  )

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      sheet
      title={t('start.title')}
      subtitle={t('start.stepOf', { n: at + 1, of: STEPS.length, name: t(`start.step.${draft.step}`) })}
      footer={footer}
      busy={model.busy}
      closeHeld={model.busy ? t('held.busy') : null}
    >
      <div ref={bodyRef} className="fw-pret-dialog">
        <Stepper steps={STEPS.map((step) => ({ key: step, label: t(`start.step.${step}`) }))} current={at} />
        {model.discard ? (
          <Banner tone="warning" title={t('start.discardTitle')}>
            {t('start.discardBody')}
          </Banner>
        ) : null}
        {model.problem ? <Banner tone="danger" title={scoped(model.problem)} /> : null}
        {draft.step === 'type' ? <TypeStep draft={draft} error={problem('type')} onType={actions?.onType} /> : null}
        {draft.step === 'details' ? (
          model.state === 'loading' ? (
            <div className="fw-pret-loading" role="status" aria-busy="true" aria-label={t('state.loading')}>
              <Skeleton height={56} />
              <Skeleton height={56} />
            </div>
          ) : model.state === 'error' || !model.read ? (
            <EmptyState title={t('start.readFailed')} description={t('start.readFailedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
          ) : draft.type === 'REPAIR' ? (
            <RepairStartDetails draft={draft} read={model.read} problems={model.problems} onDraft={actions?.onDraft} />
          ) : draft.type === 'RETURN' ? (
            <ReturnDetails model={model} read={model.read} problem={problem} actions={actions} />
          ) : (
            <ComplaintDetails model={model} read={model.read} problem={problem} actions={actions} />
          )
        ) : null}
        {draft.step === 'review' && model.read ? draft.type === 'REPAIR' ? <RepairStartReview draft={draft} read={model.read} /> : <Review draft={draft} read={model.read} /> : null}
        {draft.step === 'review' ? <p className="fw-pret-hint">{t('start.photosLater')}</p> : null}
      </div>
    </Modal>
  )
}

function TypeStep({ draft, error, onType }: { draft: StartDraft; error?: string; onType?: (type: StartType) => void }) {
  const { t } = useReturnWords()
  const r = useT('returns-repair')
  return (
    <fieldset className="fw-pret-choices" aria-describedby={error ? 'fw-pret-type-error' : undefined}>
      <legend className="fw-pret-h3">{t('start.what')}</legend>
      {(['RETURN', 'COMPLAINT'] as const).map((type) => (
        <RadioCard key={type} name="fw-pret-type" value={type} checked={draft.type === type} selected={draft.type === type} onChange={() => onType?.(type)} title={t(`start.type.${type}`)} description={t(`start.typeBody.${type}`)} />
      ))}
      {/* B-W2b-342: a repair or an alteration (./repair). */}
      <RadioCard name="fw-pret-type" value="REPAIR" checked={draft.type === 'REPAIR'} selected={draft.type === 'REPAIR'} onChange={() => onType?.('REPAIR')} title={r('link.type.title')} description={r('portal.start.typeBody')} />
      {error ? (
        <p id="fw-pret-type-error" className="fw-pret-error">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

function ReturnDetails({ model, read, problem, actions }: { model: StartDialogModel; read: ReturnableRead; problem: (field: string) => string | undefined; actions?: StartDialogActions }) {
  const { t } = useReturnWords()
  const draft = model.draft
  return (
    <div className="fw-pret-dialog">
      <fieldset className="fw-pret-items">
        <legend className="fw-pret-h3">{t('start.items')}</legend>
        <p className="fw-pret-hint">{t('start.itemsHint')}</p>
        {read.items.length === 0 ? <p className="fw-pret-quiet">{t('start.noItems')}</p> : null}
        {problem('lines') ? <p className="fw-pret-error">{problem('lines')}</p> : null}
        {read.items.map((item) => (
          <ItemRow key={item.key} item={item} line={startLineOf(draft, item.key)} reasons={read.reasons} problem={problem} onLine={actions?.onLine} />
        ))}
      </fieldset>
      <fieldset className="fw-pret-choices">
        <legend className="fw-pret-h3">{t('start.outcome')}</legend>
        <RadioCard variant="row" name="fw-pret-outcome" value="" checked={draft.outcomeWanted === null} selected={draft.outcomeWanted === null} onChange={() => actions?.onDraft?.({ outcomeWanted: null })} title={t('start.outcomeNone')} />
        {read.outcomes.map((outcome) => (
          <RadioCard
            key={outcome.code}
            variant="row"
            name="fw-pret-outcome"
            value={outcome.code}
            checked={draft.outcomeWanted === outcome.code}
            selected={draft.outcomeWanted === outcome.code}
            onChange={() => actions?.onDraft?.({ outcomeWanted: outcome.code as OutcomeWanted })}
            title={t(`outcome.${outcome.code}`)}
          />
        ))}
      </fieldset>
      <div className="fw-pret-fields">
        <Field label={t('start.yourRef')} hint={t('start.yourRefHint')} error={problem('customerRef')}>
          <Input value={draft.customerRef} maxLength={LIMITS.customerRef + 20} onChange={(event) => actions?.onDraft?.({ customerRef: event.target.value })} />
        </Field>
      </div>
      <Field label={t('start.note')} hint={t('start.noteHint')} error={problem('note')}>
        <Textarea className="fw-pret-note" value={draft.note} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
      </Field>
    </div>
  )
}

function ItemRow({ item, line, reasons, problem, onLine }: { item: ReturnableItem; line: StartLine; reasons: ReturnableRead['reasons']; problem: (field: string) => string | undefined; onLine?: (key: string, patch: Partial<StartLine>) => void }) {
  const { t, locale, day } = useReturnWords()
  const can = pickable(item)
  const facts = itemFacts(item, t)
  const reason = reasons.find((entry) => entry.code === line.reasonCode)
  return (
    <div className="fw-pret-item" data-held={can ? undefined : ''}>
      <Checkbox
        checked={line.picked}
        disabled={!can}
        onChange={(event) => onLine?.(item.key, { picked: event.target.checked })}
        label={
          <span className="fw-pret-stack">
            <span className="fw-pret-strong">{item.style ? `${item.style.code} ${item.style.name}` : item.description}</span>
            <span className="fw-pret-sub">{[...facts, can ? t('start.canReturn', { count: item.canReturn, received: item.received }) : t('start.nothingLeft')].join(' · ')}</span>
          </span>
        }
      />
      {item.windowWarning && can ? (
        <p className="fw-pret-warn">
          <AlertTriangle size={14} aria-hidden /> {item.deliveredOn ? t('start.window', { date: day(item.deliveredOn) }) : t('start.windowNoDate')}
        </p>
      ) : null}
      {line.picked ? (
        <div className="fw-pret-fields">
          <Field label={t('start.pieces')} hint={t('start.piecesHint', { count: item.canReturn })} error={problem(`${item.key}.quantity`)} required>
            <Input type="number" inputMode="numeric" min={1} max={item.canReturn} value={line.quantity} onChange={(event) => onLine?.(item.key, { quantity: event.target.value })} />
          </Field>
          <Field label={t('start.reason')} error={problem(`${item.key}.reasonCode`)} required>
            <Select value={line.reasonCode} onChange={(event) => onLine?.(item.key, { reasonCode: event.target.value })}>
              <option value="">{t('start.reasonPick')}</option>
              {reasons.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.words[locale]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={reason?.needsNote ? t('start.reasonNoteNeeded') : t('start.reasonNote')} error={problem(`${item.key}.reasonNote`)} required={reason?.needsNote ?? false}>
            <Input value={line.reasonNote} onChange={(event) => onLine?.(item.key, { reasonNote: event.target.value })} />
          </Field>
          <Field label={t('start.serial')} hint={t('start.serialHint')} error={problem(`${item.key}.serial`)}>
            <Input value={line.serial} onChange={(event) => onLine?.(item.key, { serial: event.target.value })} />
          </Field>
        </div>
      ) : null}
    </div>
  )
}

function ComplaintDetails({ model, read, problem, actions }: { model: StartDialogModel; read: ReturnableRead; problem: (field: string) => string | undefined; actions?: StartDialogActions }) {
  const { t } = useReturnWords()
  const draft = model.draft
  return (
    <div className="fw-pret-dialog">
      <Field label={t('start.item')} hint={t('start.itemHint')}>
        <Select value={draft.itemKey} onChange={(event) => actions?.onDraft?.({ itemKey: event.target.value })}>
          <option value="">{t('start.itemNone')}</option>
          {read.items
            .filter((item) => item.salesOrderLineId !== null)
            .map((item) => (
              <option key={item.key} value={item.key}>
                {[item.style ? `${item.style.code} ${item.style.name}` : item.description, ...itemFacts(item, t)].join(' · ')}
              </option>
            ))}
        </Select>
      </Field>
      <div className="fw-pret-fields">
        <Field label={t('start.serial')} hint={t('start.serialHint')} error={problem('serial')}>
          <Input value={draft.serial} onChange={(event) => actions?.onDraft?.({ serial: event.target.value })} />
        </Field>
        <Field label={t('start.batch')} hint={t('start.batchHint')} error={problem('batchNumber')}>
          <Input value={draft.batchNumber} onChange={(event) => actions?.onDraft?.({ batchNumber: event.target.value })} />
        </Field>
      </div>
      <Field label={t('start.description')} hint={t('start.descriptionHint')} error={problem('description')} required>
        <Textarea className="fw-pret-note" value={draft.description} onChange={(event) => actions?.onDraft?.({ description: event.target.value })} />
      </Field>
      <div className="fw-pret-fields">
        <Field label={t('start.yourRef')} hint={t('start.yourRefHint')} error={problem('customerRef')}>
          <Input value={draft.customerRef} onChange={(event) => actions?.onDraft?.({ customerRef: event.target.value })} />
        </Field>
      </div>
    </div>
  )
}

/** sec:review — the one screen that says what goes, before Send. */
function Review({ draft, read }: { draft: StartDraft; read: ReturnableRead }) {
  const { t, locale } = useReturnWords()
  const name = (item: ReturnableItem) => [item.style ? `${item.style.code} ${item.style.name}` : item.description, ...itemFacts(item, t)].join(' · ')
  if (draft.type === 'RETURN') {
    const picked = read.items.filter((item) => draft.lines[item.key]?.picked)
    return (
      <div className="fw-pret-dialog">
        <h3 className="fw-pret-h3">{t('start.review.return')}</h3>
        <SummaryTable
          label={t('start.review.items')}
          columns={[t('start.review.item'), t('start.pieces'), t('start.reason')]}
          rows={picked.map((item) => {
            const line = startLineOf(draft, item.key)
            const reason = read.reasons.find((entry) => entry.code === line.reasonCode)
            return { id: item.key, cells: [name(item) + (line.serial.trim() ? ` · ${t('item.serial', { serial: line.serial.trim() })}` : ''), line.quantity, [reason?.words[locale] ?? line.reasonCode, line.reasonNote.trim()].filter(Boolean).join(': ')] }
          })}
          align={[undefined, 'right', undefined]}
          stackOnPhone
        />
        <dl className="fw-pret-facts">
          <dt>{t('start.outcome')}</dt>
          <dd>{draft.outcomeWanted ? t(`outcome.${draft.outcomeWanted}`) : t('start.outcomeNone')}</dd>
          <dt>{t('start.yourRef')}</dt>
          <dd>{draft.customerRef.trim() || '—'}</dd>
          <dt>{t('start.note')}</dt>
          <dd className="fw-pret-pre">{draft.note.trim() || '—'}</dd>
        </dl>
      </div>
    )
  }
  const item = read.items.find((entry) => entry.key === draft.itemKey) ?? null
  return (
    <div className="fw-pret-dialog">
      <h3 className="fw-pret-h3">{t('start.review.complaint')}</h3>
      <dl className="fw-pret-facts">
        <dt>{t('start.item')}</dt>
        <dd>{item ? name(item) : t('start.itemNone')}</dd>
        <dt>{t('start.serial')}</dt>
        <dd>{draft.serial.trim() || '—'}</dd>
        <dt>{t('start.batch')}</dt>
        <dd>{draft.batchNumber.trim() || '—'}</dd>
        <dt>{t('start.description')}</dt>
        <dd className="fw-pret-pre">{draft.description.trim()}</dd>
        <dt>{t('start.yourRef')}</dt>
        <dd>{draft.customerRef.trim() || '—'}</dd>
      </dl>
    </div>
  )
}
