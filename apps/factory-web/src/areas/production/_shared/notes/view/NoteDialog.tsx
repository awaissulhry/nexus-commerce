'use client'

import { useId, useRef, useState } from 'react'
import { CheckCircle2, Lock, UserCog, XCircle } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox, Radio } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { MentionButton, MentionInput, type MentionInputHandle } from '../../../../../lib/record-thread/helpers/view/MentionInput'
import { WithMessages } from '../../../../../record-panels/i18n'
import {
  checkLines,
  customersOf,
  lastAnswerOf,
  NOTE_BODY_MAX,
  NOTES_NS,
  recordsOf,
  salesOrdersHeld,
  sendHeld,
  titleOf,
  type NoteDialogActions,
  type NoteDialogModel,
  type Phrase,
} from '../model'
import '../notes.css'

/**
 * F-PR-22 — THE note dialog (17-web-r2 §1.2; DS Modal, a full-screen sheet on a phone): the records named (the first three, Show all)
 * and their customers, Write on (each work order / their sales orders), the threads kit's yellow box "Office note · never shown to a
 * customer" with "Each record's supervisor" ticked and the threads MentionInput (@ suggests office people who may read the records,
 * the supervisor tagged first), "Needs an answer", then what the check says before Send — who cannot read some records ("not mentioned
 * there; the note is still written"), several customers said plainly, the records whose text names ANOTHER customer with the tick
 * "This text names no other customer" (Send held until the text changes or it is ticked) — and Send "Write on N" (held in words:
 * empty, offline, busy, checking, the hold). After Send: one result per record; a record the API did not name is only counted.
 * Focus starts in the box; @ opens suggestions (↑ ↓ Enter); Esc closes.
 */
export function NoteDialog(props: { model: NoteDialogModel; actions?: NoteDialogActions }) {
  return (
    <WithMessages namespaces={[NOTES_NS]}>
      <Dialog {...props} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: NoteDialogModel; actions?: NoteDialogActions }) {
  const t = useT(NOTES_NS)
  const say = (phrase: Phrase) => t(phrase.key, phrase.params)
  const records = recordsOf(model.targets, model.draft.on)
  const held = sendHeld({ can: model.can, records: records.length, body: model.draft.body, offline: model.offline, busy: model.busy, check: model.check })
  return (
    <Modal
      open
      size="md"
      onClose={() => actions?.onClose?.()}
      title={say(titleOf(model))}
      footer={
        model.result ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={() => actions?.onClose?.()}>
              {t('close')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onClose?.()}>
              {t('cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held ? say(held) : null} onClick={() => actions?.onSend?.()}>
              {t('send', { count: records.length })}
            </Button>
          </>
        )
      }
    >
      <NoteDialogBody model={model} actions={actions} />
    </Modal>
  )
}

const SHOWN = 3

/** The dialog's content (also drawn on its own by the tests: the DS Modal draws nothing before the page is hydrated). */
export function NoteDialogBody({ model, actions }: { model: NoteDialogModel; actions?: NoteDialogActions }) {
  const t = useT(NOTES_NS)
  const say = (phrase: Phrase) => t(phrase.key, phrase.params)
  const [all, setAll] = useState(false)
  const box = useRef<MentionInputHandle>(null)
  const legend = useId()
  const records = recordsOf(model.targets, model.draft.on)
  const customers = customersOf(records)
  const shown = all ? records : records.slice(0, SHOWN)
  const people = model.people.status === 'ready' ? model.people.people : []
  // The last answer stays drawn while the draft is checked again (Send waits on the check of THIS draft all the same).
  const answer = lastAnswerOf(model.check)
  const lines = answer ? checkLines(answer, model.draft) : null
  const customerCount = answer ? answer.customers : customers.count
  const ordersHeld = salesOrdersHeld(model.targets)
  const many = model.targets.workOrders.length

  if (model.result) {
    const result = model.result
    return (
      <div className="fw-pnt">
        <Banner tone={result.written > 0 ? 'success' : 'warning'} title={result.written > 0 ? t('result.title', { count: result.written }) : t('result.none')} />
        <ul className="fw-pnt-results" aria-label={t('result.label')}>
          {result.lines.map((line) => (
            <li key={line.key} className="fw-pnt-result">
              {line.state === 'written' ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}
              <span>
                <b>{line.label}</b> ·{' '}
                {line.state === 'written'
                  ? [t('result.written'), line.mentioned > 0 ? t('result.mentioned', { count: line.mentioned }) : null, line.supervisorAsked ? t('result.supervisorAsked') : null, line.issue ? t('result.issue') : null].filter(Boolean).join(' · ')
                  : t('result.notWritten', { why: t(line.why) })}
              </span>
            </li>
          ))}
        </ul>
        {result.unknown > 0 && <p className="fw-pnt-hint">{t('result.unknown', { count: result.unknown })}</p>}
        {result.notMentioned.map((phrase, index) => (
          <p key={`nm-${index}`} className="fw-pnt-hint">
            {say(phrase)}
          </p>
        ))}
        {result.tasks.map((phrase, index) => (
          <p key={`task-${index}`} className="fw-pnt-hint">
            {say(phrase)}
          </p>
        ))}
        {result.notRaised.map((phrase, index) => (
          <p key={`nr-${index}`} className="fw-pnt-hint">
            {t(phrase.key, { ...phrase.params, why: t(String(phrase.params?.why ?? 'issue.other')) })}
          </p>
        ))}
      </div>
    )
  }

  return (
    <div className="fw-pnt">
      {/* The records it is written on, and their customers. */}
      <p className="fw-pnt-records" aria-label={t('records.label')}>
        {shown.map((record) => record.label).join(', ')}
        {records.length > SHOWN && (
          <>
            {' '}
            <Button size="sm" variant="quiet" aria-expanded={all} onClick={() => setAll((open) => !open)}>
              {all ? t('records.showFewer') : t('records.showAll', { count: records.length })}
            </Button>
          </>
        )}
        {customerCount === 1 && customers.name ? ` · ${customers.name}` : customerCount > 1 ? ` · ${t('records.customers', { count: customerCount })}` : ''}
      </p>

      {/* Write on each work order, or on their sales orders. */}
      {model.targets.salesOrders.length > 0 || model.targets.withoutOrder > 0 ? (
        <fieldset className="fw-pnt-on" aria-labelledby={legend}>
          <span id={legend} className="fw-pnt-legend">
            {t('on.legend')}
          </span>
          <Radio name={`${legend}-on`} checked={model.draft.on === 'workOrders'} onChange={() => actions?.onDraft?.({ on: 'workOrders' })} label={t('on.workOrders', { count: many })} disabled={model.busy} />
          <Radio
            name={`${legend}-on`}
            checked={model.draft.on === 'salesOrders'}
            onChange={() => actions?.onDraft?.({ on: 'salesOrders' })}
            label={t('on.salesOrders', { count: model.targets.salesOrders.length })}
            disabled={model.busy || ordersHeld !== null}
            aria-describedby={ordersHeld ? `${legend}-held` : undefined}
          />
          {ordersHeld && (
            <span id={`${legend}-held`} className="fw-pnt-hint">
              {say(ordersHeld)}
            </span>
          )}
          {model.draft.on === 'salesOrders' && model.targets.withoutOrder > 0 && <span className="fw-pnt-hint">{t('on.withoutOrder', { count: model.targets.withoutOrder })}</span>}
        </fieldset>
      ) : null}

      {/* The threads kit's yellow Office note: never shown to a customer. */}
      <div className="fw-pnt-box">
        <p className="fw-pnt-mark">
          <Lock size={13} aria-hidden />
          <span>{t('box.mark')}</span>
        </p>
        <div className="fw-pnt-tools">
          <Checkbox checked={model.draft.askSupervisor} onChange={(event) => actions?.onDraft?.({ askSupervisor: event.target.checked })} label={t('box.supervisor')} title={t('box.supervisorHint')} disabled={model.busy} />
          {people.length > 0 && <MentionButton onClick={() => box.current?.startMention()} held={model.busy ? t('held.busy') : null} />}
        </div>
        <MentionInput
          ref={box}
          className="fw-pnt-text"
          value={model.draft.body}
          onChange={(body) => actions?.onDraft?.({ body })}
          people={people}
          mode="note"
          label={t('box.label')}
          limit={NOTE_BODY_MAX}
          rows={4}
          honourRows
          placeholder={t('box.placeholder')}
          autoFocus
          disabled={model.busy}
        />
      </div>
      {model.people.status === 'error' && (
        <p className="fw-pnt-hint">
          {t('people.failed')}{' '}
          <Button size="sm" variant="quiet" onClick={() => actions?.onRetryPeople?.()}>
            {t('people.retry')}
          </Button>
        </p>
      )}
      {model.people.status === 'ready' && !model.people.complete && <p className="fw-pnt-hint">{t('people.partial')}</p>}

      {/* Needs an answer: a question, a task for each record's supervisor. */}
      <div className="fw-pnt-answer">
        <Checkbox checked={model.draft.needsAnswer} onChange={(event) => actions?.onDraft?.({ needsAnswer: event.target.checked })} label={t('needsAnswer.label')} disabled={model.busy} />
        <span className="fw-pnt-hint">
          <UserCog size={12} aria-hidden /> {t('needsAnswer.hint')}
        </span>
      </div>

      {/* What the check says before Send. */}
      <div className="fw-pnt-check" role="status" aria-live="polite">
        {model.check.status === 'checking' && model.draft.body.trim() !== '' && !model.offline && <p className="fw-pnt-hint">{t('check.checking')}</p>}
        {model.check.status === 'failed' && (
          <Banner
            tone="warning"
            title={t('check.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetryCheck?.()}>
                {t('check.retry')}
              </Button>
            }
          />
        )}
        {lines?.people.map((phrase, index) => <Banner key={`p-${index}`} tone="warning" title={say(phrase)} />)}
        {lines?.customers && <p className="fw-pnt-line">{say(lines.customers)}</p>}
        {lines?.notWritable && <p className="fw-pnt-line">{say(lines.notWritable)}</p>}
        {lines?.unknown && <p className="fw-pnt-line">{say(lines.unknown)}</p>}
        {lines?.noSupervisor && <p className="fw-pnt-line">{say(lines.noSupervisor)}</p>}
        {lines?.noIssue && <p className="fw-pnt-line">{say(lines.noIssue)}</p>}
        {lines?.namesOther && (
          <Banner tone="danger" title={say(lines.namesOther.lead)}>
            {lines.namesOther.records.length > 0 && (
              <ul className="fw-pnt-named">
                {lines.namesOther.records.map((phrase, index) => (
                  <li key={`n-${index}`}>{say(phrase)}</li>
                ))}
              </ul>
            )}
            <p className="fw-pnt-hint">{t('check.namesOtherHint')}</p>
            <Checkbox checked={model.draft.namesNoOtherCustomer} onChange={(event) => actions?.onDraft?.({ namesNoOtherCustomer: event.target.checked })} label={t('check.namesOtherTick')} disabled={model.busy} />
          </Banner>
        )}
      </div>

      {model.offline && <Banner tone="warning" title={t('held.offline')} />}
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      {model.busy && (
        <p className="fw-pnt-hint" role="status">
          {t('held.busy')}
        </p>
      )}
    </div>
  )
}
