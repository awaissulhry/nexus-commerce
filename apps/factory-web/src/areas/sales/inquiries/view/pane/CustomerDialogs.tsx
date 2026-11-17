'use client'

import { ClipboardList, UserCheck } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../../lib/i18n/ds-parts'
import { REQUEST_TASK_KINDS, type CustomerCheck, type InquiryView } from '../../api'
import { customerAsksFirst, customerHeld, taskHeld, type CustomerChoice, type InquiriesCan, type Loaded, type Notice, type Phrase, type TaskDraft } from '../../model'
import { NoticeLine, useWords } from '../../parts'

/**
 * B-TH-234 (threads plan TH-3; O-SAL-INQ-LIST.pane-actions-F08, .pane-thread-F02, O-SAL-INQ-REC.side; on B-TH-042 and B-TH-051), two
 * dialogs over the request's pane and full page:
 *
 *   Make or match the customer  the check first (GET …/customer): the customers the prospect may already be — only customers this
 *                               person may make a request for, each with how it was found (one of its contacts' own address, its
 *                               company domain, its name) —, or a new customer from the prospect (the code proposed, the name, the
 *                               lawful basis carried). A pick that is not one customer found by its own contact's address asks first
 *                               (W23: the API never matches silently). After it the "new" mark goes and replies become possible.
 *   Ask <customer> for…         a document, an answer or measurements on its own open request, by a date: a task in the customer's
 *                               portal (a prospect has no portal yet; a closed request waits for nothing — held in words).
 *
 * Words never name a customer the person may not see: the candidates are the API's, already in the person's reach. Draws its model.
 */

export interface CustomerDialogModel {
  readonly view: InquiryView
  readonly check: Loaded<CustomerCheck>
  readonly choice: CustomerChoice | null
  readonly confirmed: boolean
  readonly can: InquiriesCan
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface CustomerDialogActions {
  onCustomer?: (patch: { choice?: CustomerChoice | null; confirmed?: boolean }) => void
  onRetry?: () => void
  onSubmit?: () => void
  onClose?: () => void
}

const MATCHED_BY = { CONTACT: 'customer.by.CONTACT', DOMAIN: 'customer.by.DOMAIN', NAME: 'customer.by.NAME' } as const

export function CustomerDialog({ model, actions }: { model: CustomerDialogModel; actions?: CustomerDialogActions }) {
  const { t, say } = useWords()
  const close = () => actions?.onClose?.()
  const check = model.check.status === 'ready' ? model.check.value : null
  const heldPhrase: Phrase | null = model.busy ? { key: 'common.working' } : check ? customerHeld(check, model.choice, model.confirmed, model.can, model.offline) : { key: 'customer.reading' }
  const choice = model.choice
  const asks = check ? customerAsksFirst(check, choice) : false
  const picked = check && choice?.mode === 'match' ? (check.candidates.find((one) => one.party.id === choice.partyId) ?? null) : null
  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={t('customer.title', { number: model.view.number })}
      subtitle={model.view.fromWords}
      footer={
        <span className="fw-inq-buttons">
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={say(heldPhrase)} onClick={() => actions?.onSubmit?.()}>
            <UserCheck size={14} aria-hidden /> {choice?.mode === 'make' ? t('customer.goMake') : t('customer.goMatch')}
          </Button>
        </span>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        {model.check.status === 'loading' && (
          <div aria-busy="true">
            <p className="fw-inq-hint" role="status">
              {t('customer.reading')}
            </p>
            <Skeleton height={96} />
          </div>
        )}
        {(model.check.status === 'error' || model.check.status === 'notFound' || model.check.status === 'forbidden') && (
          <Banner
            tone="danger"
            title={t('customer.failed')}
            action={
              model.check.status === 'error' ? (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              ) : undefined
            }
          >
            {model.check.status === 'error' ? t(model.check.problem) : t('record.notFoundBody')}
          </Banner>
        )}
        {check && (
          <>
            {/* The prospect as it wrote: e-mail and phone only for who answers requests (PR-30); the lawful basis travels with it. */}
            <KeyValue
              labelCase="sentence"
              items={[
                { label: t('customer.prospect.name'), value: check.prospect.name ?? '—' },
                { label: t('customer.prospect.company'), value: check.prospect.company ?? '—' },
                ...(model.can.manage ? [{ label: t('customer.prospect.email'), value: check.prospect.email ?? '—' }, { label: t('customer.prospect.phone'), value: check.prospect.phone ?? '—' }] : []),
                { label: t('customer.prospect.basis'), value: check.prospect.lawfulBasis ? t(`basis.${check.prospect.lawfulBasis}`) : '—' },
              ]}
            />
            <fieldset className="fw-inq-stack" aria-label={t('customer.pick')}>
              <legend className="fw-inq-h3">{check.candidates.length > 0 ? t('customer.found', { count: check.candidates.length }) : t('customer.noneFound')}</legend>
              {check.ambiguous && <p className="fw-inq-hint">{t('customer.ambiguous')}</p>}
              <div className="fw-inq-form-grid">
                {check.candidates.map((candidate) => (
                  <RadioCard
                    key={candidate.party.id}
                    name="customer-pick"
                    value={candidate.party.id}
                    checked={choice?.mode === 'match' && choice.partyId === candidate.party.id}
                    selected={choice?.mode === 'match' && choice.partyId === candidate.party.id}
                    disabled={!check.match.allowed}
                    onChange={() => actions?.onCustomer?.({ choice: { mode: 'match', partyId: candidate.party.id, contactId: candidate.contact?.id ?? null, addContact: candidate.contact === null } })}
                    title={`${candidate.party.code} · ${candidate.party.name}`}
                    description={`${t(MATCHED_BY[candidate.matchedBy])}${candidate.contact ? ` · ${t('customer.contactOf', { name: candidate.contact.name })}` : ''}`}
                  />
                ))}
                <RadioCard
                  name="customer-pick"
                  value="make"
                  checked={choice?.mode === 'make'}
                  selected={choice?.mode === 'make'}
                  disabled={!check.make.allowed}
                  onChange={() => actions?.onCustomer?.({ choice: { mode: 'make', code: check.suggestion.code, legalName: check.suggestion.legalName, kind: check.suggestion.kind, status: 'PROSPECT' } })}
                  title={t('customer.make')}
                  description={check.make.allowed ? t('customer.makeHint') : (say(customerHeld(check, { mode: 'make', code: check.suggestion.code, legalName: check.suggestion.legalName, kind: check.suggestion.kind, status: 'PROSPECT' }, true, model.can, false)) ?? t('customer.makeHeld'))}
                />
              </div>
            </fieldset>
            {picked && choice?.mode === 'match' && picked.contact === null && (
              // No contact of that customer has the prospect's address: add the prospect as one (the lawful basis carried), or match without.
              <Checkbox checked={choice.addContact} onChange={(event) => actions?.onCustomer?.({ choice: { ...choice, addContact: event.target.checked } })} label={t('customer.addContact', { customer: picked.party.name })} />
            )}
            {choice?.mode === 'make' && (
              <div className="fw-inq-form-grid">
                <Field label={t('customer.code')} hint={t('customer.codeHint')}>
                  <Input value={choice.code} maxLength={24} onChange={(event) => actions?.onCustomer?.({ choice: { ...choice, code: event.target.value } })} />
                </Field>
                <Field label={t('customer.legalName')}>
                  <Input value={choice.legalName} maxLength={200} onChange={(event) => actions?.onCustomer?.({ choice: { ...choice, legalName: event.target.value } })} />
                </Field>
                <Field label={t('customer.kind')}>
                  <Select value={choice.kind} onChange={(event) => actions?.onCustomer?.({ choice: { ...choice, kind: event.target.value as 'ORGANISATION' | 'PERSON' } })}>
                    <option value="ORGANISATION">{t('customer.kindOf.ORGANISATION')}</option>
                    <option value="PERSON">{t('customer.kindOf.PERSON')}</option>
                  </Select>
                </Field>
                <Field label={t('customer.status')} hint={t('customer.statusHint')}>
                  <Select value={choice.status} onChange={(event) => actions?.onCustomer?.({ choice: { ...choice, status: event.target.value as 'PROSPECT' | 'ACTIVE' } })}>
                    <option value="PROSPECT">{t('customer.statusOf.PROSPECT')}</option>
                    <option value="ACTIVE">{t('customer.statusOf.ACTIVE')}</option>
                  </Select>
                </Field>
              </div>
            )}
            {asks && choice && (
              // W23: a match the check did not find by the customer's own contact address, or a new customer while one was found, asks first.
              <Checkbox
                checked={model.confirmed}
                onChange={(event) => actions?.onCustomer?.({ confirmed: event.target.checked })}
                label={choice.mode === 'make' ? t('customer.confirmMake', { count: check.candidates.length }) : t('customer.confirmMatch', { number: model.view.number, customer: picked?.party.name ?? '' })}
              />
            )}
            <p className="fw-inq-hint">{t('customer.after')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

export interface TaskDialogModel {
  readonly view: InquiryView
  readonly draft: TaskDraft
  readonly can: InquiriesCan
  readonly today: string
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface TaskDialogActions {
  onTask?: (patch: Partial<TaskDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

/** "Ask <customer> for…": a document, an answer or measurements, by a date — a task in the customer's portal on its own request. */
export function TaskDialog({ model, actions }: { model: TaskDialogModel; actions?: TaskDialogActions }) {
  const { t, say } = useWords()
  const customer = model.view.party?.name ?? model.view.fromWords
  const heldPhrase: Phrase | null = model.busy ? { key: 'common.working' } : taskHeld(model.view, model.draft, model.can, model.offline, model.today)
  const close = () => actions?.onClose?.()
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('task.title', { customer })}
      subtitle={model.view.number}
      footer={
        <span className="fw-inq-buttons">
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={say(heldPhrase)} onClick={() => actions?.onSubmit?.()}>
            <ClipboardList size={14} aria-hidden /> {t('task.go')}
          </Button>
        </span>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <fieldset className="fw-inq-stack" aria-label={t('task.kindLabel')}>
          <legend className="fw-inq-h3">{t('task.kindLabel')}</legend>
          <div className="fw-inq-form-grid">
            {REQUEST_TASK_KINDS.map((kind) => (
              <RadioCard key={kind} name="task-kind" value={kind} checked={model.draft.kind === kind} selected={model.draft.kind === kind} onChange={() => actions?.onTask?.({ kind })} title={t(`task.kind.${kind}`)} description={t(`task.hint.${kind}`)} />
            ))}
          </div>
        </fieldset>
        <Field label={t('task.due')} hint={t('task.dueHint')}>
          <DateField value={model.draft.due ?? ''} clearable onChange={(value) => actions?.onTask?.({ due: value || null })} />
        </Field>
        <p className="fw-inq-hint">{t('task.after', { customer })}</p>
      </div>
    </Modal>
  )
}
