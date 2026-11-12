'use client'

import { useEffect, type ReactNode } from 'react'
import { FilePlus2, XCircle } from 'lucide-react'
import { Banner, Field, ListboxPanel, SummaryTable } from '@nexus/ui/components'
import { Button, Input, RadioCard, Skeleton } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { Assignees } from '../api'
import { DECLINE_REASONS, declineHeld, lostHeld, type DeclineDraft, type DeclineReason, type Loaded, type Notice, type Phrase, type QuotePreview } from '../model'
import { NoticeLine, useWords } from '../parts'

/** ⌘↵ / Ctrl+↵ inside a dialog: its primary action (the design's kb). */
function useSubmitKey(onSubmit: () => void, held: boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !held) {
        event.preventDefault()
        onSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSubmit, held])
}

function Buttons({ onClose, children }: { onClose?: () => void; children: ReactNode }) {
  const { t } = useWords()
  return (
    <span className="fw-inq-buttons">
      <Button variant="secondary" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      {children}
    </span>
  )
}

// ---- Assign ----------------------------------------------------------------------------------------------------------------

export interface AssignModel {
  /** "INQ-2026-0001", or how many a selection holds. */
  readonly subject: Phrase
  /** Who has it now (one inquiry): its name inside the record; null with nobody or a selection. */
  readonly current: { readonly id: string; readonly name: string } | null
  readonly people: Loaded<Assignees>
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface AssignActions {
  onAssign?: (assigneeId: string | null) => void
  onRetry?: () => void
  onClose?: () => void
}

const NOBODY = '__nobody__'

/**
 * Assign (design pop:inquiries.assign, a ListboxPanel; row verb, bulk): the people who keep inquiries here, by name — me
 * first as "Me" — and "Nobody" to take it off. ↑ ↓ and Enter choose. Nobody is counted (no per-person figure in a list:
 * the brief's rule and B-W2b-295's decision), so the design's "open inquiries count" is left out.
 */
export function AssignDialog({ model, actions }: { model: AssignModel; actions?: AssignActions }) {
  const { t, say } = useWords()
  const people = model.people.status === 'ready' ? model.people.value.people : []
  const options = [
    ...[...people].sort((a, b) => Number(b.me) - Number(a.me)).map((person) => ({ value: person.id, label: person.me ? t('assign.me', { name: person.name }) : person.name, disabled: person.id === model.current?.id })),
    ...(model.current ? [{ value: NOBODY, label: t('assign.nobody') }] : []),
  ]
  const held = model.busy ? t('common.working') : model.offline ? t('held.offline') : null
  return (
    <Modal open onClose={() => actions?.onClose?.()} size="sm" title={t('assign.title')} subtitle={say(model.subject) ?? undefined} footer={<Buttons onClose={actions?.onClose}>{null}</Buttons>}>
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <p className="fw-inq-hint">{model.current ? t('assign.now', { name: model.current.name }) : t('assign.nobodyNow')}</p>
        {model.people.status === 'loading' && <Skeleton height={120} />}
        {model.people.status === 'error' && (
          <Banner
            tone="danger"
            title={t(model.people.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        {model.people.status === 'ready' && people.length === 0 && <p className="fw-inq-hint">{t('assign.noPeople')}</p>}
        {model.people.status === 'ready' && people.length > 0 && (
          <div className="fw-inq-people">
            <ListboxPanel
              options={options}
              onCommit={(value) => {
                if (held) return
                actions?.onAssign?.(value === NOBODY ? null : value)
              }}
              onCancel={() => actions?.onClose?.()}
              ariaLabel={t('assign.listLabel')}
              searchPlaceholder={t('assign.search')}
              style={{ position: 'relative', width: '100%' }}
            />
          </div>
        )}
        {held && <p className="fw-inq-hint">{held}</p>}
        {model.people.status === 'ready' && !model.people.value.complete && <p className="fw-inq-hint">{t('assign.partial')}</p>}
        <p className="fw-inq-hint">{t('assign.hint')}</p>
      </div>
    </Modal>
  )
}

// ---- Decline ---------------------------------------------------------------------------------------------------------------

export interface DeclineModel {
  readonly subject: Phrase
  readonly draft: DeclineDraft
  /** Who the optional message reaches, or why it is held (a selection, a prospect, no e-mail, no right). */
  readonly message: { readonly to: string | null; readonly held: Phrase | null }
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface DeclineActions {
  onDraft?: (patch: Partial<DeclineDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Decline inquiry (design pop:inquiries.decline; row verb D, the detail, Decline N): the reason (capacity, lead time, not our
 * product, price, other — Other says it in words) and an optional message to the customer, previewed, sent through the
 * inquiry's thread after the decline (the decline itself sends nothing; B-W2b-295). ⌘↵ declines.
 */
export function DeclineDialog({ model, actions }: { model: DeclineModel; actions?: DeclineActions }) {
  const { t, say } = useWords()
  const heldPhrase = model.busy ? { key: 'common.working' } : declineHeld(model.draft, model.offline)
  const held = say(heldPhrase)
  const submit = () => actions?.onSubmit?.()
  useSubmitKey(submit, !!heldPhrase)
  const reasons: DeclineReason[] = [...DECLINE_REASONS]
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('decline.title')}
      subtitle={say(model.subject) ?? undefined}
      footer={
        <Buttons onClose={actions?.onClose}>
          <Button variant="danger" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter">
            <XCircle size={14} aria-hidden /> {t('decline.go')}
          </Button>
        </Buttons>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <fieldset className="fw-inq-stack" aria-label={t('decline.reason')}>
          <legend className="fw-inq-h3">{t('decline.reason')}</legend>
          <div className="fw-inq-form-grid">
            {reasons.map((reason) => (
              <RadioCard key={reason} name="decline-reason" value={reason} checked={model.draft.reason === reason} selected={model.draft.reason === reason} onChange={() => actions?.onDraft?.({ reason })} title={t(`decline.${reason}`)} description={t(`decline.hint.${reason}`)} />
            ))}
          </div>
        </fieldset>
        <Field label={t('decline.note')} hint={model.draft.reason === 'OTHER' ? t('decline.noteOther') : t('decline.noteHint')}>
          <Textarea value={model.draft.note} rows={3} honourRows maxLength={2000} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
        </Field>
        <Field label={t('decline.messageLabel')} hint={model.message.held ? (say(model.message.held) ?? undefined) : t('decline.messageTo', { to: model.message.to ?? '' })}>
          <Textarea value={model.draft.message} rows={4} honourRows maxLength={4000} disabled={!!model.message.held} onChange={(event) => actions?.onDraft?.({ message: event.target.value })} />
        </Field>
        {model.draft.message.trim() && model.message.to && (
          <Banner tone="info" title={t('decline.preview', { to: model.message.to })}>
            <p className="fw-inq-text">{model.draft.message.trim()}</p>
          </Banner>
        )}
        <p className="fw-inq-hint">{t('decline.final')}</p>
      </div>
    </Modal>
  )
}

// ---- Lost ------------------------------------------------------------------------------------------------------------------

export interface LostModel {
  readonly subject: Phrase
  readonly note: string
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface LostActions {
  onNote?: (note: string) => void
  onSubmit?: () => void
  onClose?: () => void
}

/** Mark as lost: the customer went away before a quote — why, in words. ⌘↵ marks it. */
export function LostDialog({ model, actions }: { model: LostModel; actions?: LostActions }) {
  const { t, say } = useWords()
  const heldPhrase = model.busy ? { key: 'common.working' } : lostHeld(model.note, model.offline)
  const submit = () => actions?.onSubmit?.()
  useSubmitKey(submit, !!heldPhrase)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('lost.title')}
      subtitle={say(model.subject) ?? undefined}
      footer={
        <Buttons onClose={actions?.onClose}>
          <Button variant="danger" heldReason={say(heldPhrase)} onClick={submit} aria-keyshortcuts="Meta+Enter">
            {t('lost.go')}
          </Button>
        </Buttons>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <Field label={t('lost.note')} hint={t('lost.noteHint')}>
          <Textarea value={model.note} rows={3} honourRows maxLength={2000} onChange={(event) => actions?.onNote?.(event.target.value)} />
        </Field>
        <p className="fw-inq-hint">{t('decline.final')}</p>
      </div>
    </Modal>
  )
}

// ---- Make quote ------------------------------------------------------------------------------------------------------------

export interface QuoteModel {
  readonly subject: Phrase
  /** The customer and contact the quote is made for. */
  readonly customer: string
  readonly contact: string | null
  readonly wantedDate: string | null
  readonly preview: QuotePreview
  readonly customerRef: string
  /** Why Make quote is held (a prospect, closed, no right, offline), else null. */
  readonly held: Phrase | null
  readonly busy: boolean
  readonly notice: Notice | null
}

export interface QuoteActions {
  onRef?: (customerRef: string) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Make quote (Q; design "Make quote (pre-filled: customer, contact, styles, sizes, target date)"): what goes over — the
 * customer, the contact, each style line with its sizes (at the customer's list price, else 0), the wanted day as the
 * promise date — and what is left out and why (factory-domain quotableLines, the API's own rule). ONE command makes the
 * quote and closes the inquiry as Quoted. ⌘↵ makes it.
 */
export function QuoteDialog({ model, actions }: { model: QuoteModel; actions?: QuoteActions }) {
  const { t, say, day } = useWords()
  const held = model.busy ? t('common.working') : say(model.held)
  const submit = () => actions?.onSubmit?.()
  useSubmitKey(submit, !!held)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="lg"
      title={t('quote.title')}
      subtitle={say(model.subject) ?? undefined}
      footer={
        <Buttons onClose={actions?.onClose}>
          <Button variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter">
            <FilePlus2 size={14} aria-hidden /> {t('quote.go')}
          </Button>
        </Buttons>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <div className="fw-inq-form-grid">
          <Field label={t('quote.customer')}>
            <span className="fw-inq-value">{model.customer}</span>
          </Field>
          <Field label={t('quote.contact')}>
            <span className="fw-inq-value">{model.contact ?? '—'}</span>
          </Field>
          <Field label={t('quote.promise')} hint={t('quote.promiseHint')}>
            <span className="fw-inq-value">{day(model.wantedDate)}</span>
          </Field>
          <Field label={t('quote.customerRef')} hint={t('quote.customerRefHint')}>
            <Input size="sm" value={model.customerRef} maxLength={100} onChange={(event) => actions?.onRef?.(event.target.value)} />
          </Field>
        </div>
        <h3 className="fw-inq-h3">{t('quote.copied', { count: model.preview.copied.length })}</h3>
        {model.preview.copied.length > 0 ? (
          <SummaryTable
            label={t('quote.copiedLabel')}
            columns={[t('line.col.n'), t('quote.col.style'), t('line.col.pieces')]}
            rows={model.preview.copied.map((line) => ({ id: String(line.seq), cells: [String(line.seq / 10), line.label, <span key="n" className="fw-inq-num">{line.pieces}</span>] }))}
          />
        ) : (
          <p className="fw-inq-hint">{t('quote.emptyDraft')}</p>
        )}
        {model.preview.leftOut.length > 0 && (
          <Banner tone="warning" title={t('quote.leftOut', { count: model.preview.leftOut.length })}>
            <ul className="fw-inq-lines">
              {model.preview.leftOut.map((line) => (
                <li key={line.seq}>{say(line.phrase)}</li>
              ))}
            </ul>
          </Banner>
        )}
        <p className="fw-inq-hint">{t('quote.closes')}</p>
      </div>
    </Modal>
  )
}
