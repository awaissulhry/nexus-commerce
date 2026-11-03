'use client'

import { FileText, MessageSquareReply, Plus } from 'lucide-react'
import { Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import type { Concession, NcrRecord } from '../../api'
import { localOf } from '../../model'
import {
  answerConcessionHeld,
  answerDraftHeld,
  askConcessionHeld,
  askDraftHeld,
  NEW_CONCESSION,
  type NcrRecordActions,
  type NcrRecordModel,
  type RecordDialog,
} from '../view-model'
import { Frame } from './RecordDialogs'
import type { RecordWords } from './words'

/**
 * A concession asked of the customer (B-W2b-113; QHS-085 "Customer concession by link, with NCR"; plan §12: the customer's
 * link page is links.approve, W2b-3 — until then the office asks by its own mail or the thread and records the customer's
 * written answer here, with its file). On the Disposition tab, under the decisions: the asks with their state, "Ask a
 * concession…", and per ask still open "Record the answer…". Never on a critical NCR (a critical defect is never sold
 * under a concession), nor once the NCR is closed or cancelled; an answer may come after the close. Nothing reaches the
 * customer from here.
 */
export function ConcessionPanel({ model, record, words, actions }: { model: NcrRecordModel; record: NcrRecord; words: RecordWords; actions?: NcrRecordActions }) {
  const { r, sayAny, when, person } = words
  const held = askConcessionHeld(record, model.can)
  const tone = (status: Concession['status']) => (status === 'ACCEPTED' ? 'success' : status === 'REFUSED' ? 'danger' : 'warning')
  const rows = record.concessions.map((concession) => {
    const answerHeld = answerConcessionHeld(concession.status, model.can)
    return {
      id: concession.id,
      cells: [
        <span key="ask" className="fw-ncr-r-cell">
          <span className="fw-q-name">{`${concession.seq}. ${concession.ask}`}</span>
          <span className="fw-ncr-r-sub">{r('concession.proposalLine', { proposal: concession.proposal })}</span>
        </span>,
        <span key="who" className="fw-ncr-r-cell">
          <span>{concession.party.name}</span>
          <span className="fw-ncr-r-sub">{concession.contact ? concession.contact.name : r('concession.noContact')}</span>
        </span>,
        <span key="state" className="fw-ncr-r-cell">
          <span>
            <Tag tone={tone(concession.status)}>{r(`concession.status.${concession.status}`)}</Tag>
          </span>
          <span className="fw-ncr-r-sub">{concession.answeredAt ? r('concession.answeredLine', { who: concession.answeredBy ?? '—', when: when(concession.answeredAt) }) : r('concession.askedLine', { who: person(concession.askedById), when: when(concession.askedAt) })}</span>
          {concession.answer && <span className="fw-ncr-r-sub">{concession.answer}</span>}
        </span>,
        concession.status === 'ASKED' ? (
          <Button
            key="do"
            size="xs"
            heldReason={sayAny(answerHeld)}
            onClick={() =>
              actions?.onDialog?.({ kind: 'answerConcession', concessionId: concession.id, draft: { status: 'ACCEPTED', answer: '', answeredBy: concession.contact?.name ?? '', answeredAt: localOf(new Date().toISOString(), model.timeZone) }, fileName: null, busy: false, notice: null })
            }
          >
            <MessageSquareReply size={13} aria-hidden /> {r('concession.answer')}
          </Button>
        ) : concession.answerFile ? (
          <Button key="do" size="xs" variant="quiet" onClick={() => actions?.onOpenFile?.(concession.answerFile!.id)}>
            <FileText size={13} aria-hidden /> {r('concession.openAnswer')}
          </Button>
        ) : (
          <span key="do" className="fw-ncr-r-sub">{r('concession.noFile')}</span>
        ),
      ],
    }
  })
  return (
    <Card padded>
      <section className="fw-q-stack" aria-labelledby="ncr-concession">
        <div className="fw-ncr-head">
          <div className="fw-q-stack">
            <h2 id="ncr-concession" className="fw-ncr-h3">
              {r('concession.title')}
            </h2>
            <p className="fw-q-hint">{r('concession.body')}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            heldReason={sayAny(held)}
            onClick={() => {
              actions?.onFindCustomers?.('')
              actions?.onDialog?.({ kind: 'askConcession', draft: NEW_CONCESSION, busy: false, notice: null })
            }}
          >
            <Plus size={14} aria-hidden /> {r('concession.ask')}
          </Button>
        </div>
        {record.concessions.length === 0 ? (
          <p className="fw-q-hint">{r('concession.none')}</p>
        ) : (
          <SummaryTable label={r('concession.title')} columns={[r('concession.col.ask'), r('concession.col.customer'), r('concession.col.state'), '']} rows={rows} density="roomy" stackOnPhone align={['left', 'left', 'left', 'right']} widths={['38%', '20%', '28%', '14%']} />
        )}
        <p className="fw-q-hint">{r('concession.foot')}</p>
      </section>
    </Card>
  )
}

interface DialogProps<K extends RecordDialog['kind']> {
  model: NcrRecordModel
  record: NcrRecord
  words: RecordWords
  actions?: NcrRecordActions
  dialog: Extract<RecordDialog, { kind: K }>
}

/** Ask a concession: the customer (a customer or brand of the company), the person asked, the deviation, what we propose. */
export function AskConcessionDialog({ model, words, actions, dialog }: DialogProps<'askConcession'>) {
  const { r } = words
  const draft = dialog.draft
  const customers = model.choices.customers
  const contacts = model.choices.contacts
  const heldKey = askDraftHeld(draft)
  const set = (patch: Partial<typeof draft>) => actions?.onDialog?.({ ...dialog, draft: { ...draft, ...patch } })
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={r('concession.askTitle')} submit={r('concession.askSubmit')} held={heldKey ? r(heldKey) : null}>
      <p className="fw-q-hint">{r('concession.askBody')}</p>
      <Field label={r('concession.customerFind')}>
        <Input
          value={draft.partyQuery}
          placeholder={r('concession.customerPlaceholder')}
          onChange={(event) => {
            set({ partyQuery: event.target.value })
            actions?.onFindCustomers?.(event.target.value)
          }}
        />
      </Field>
      <Field label={r('concession.customer')} required hint={customers.problem ? r('concession.customersFailed') : customers.items === null ? r('choices.reading') : customers.items.length === 0 ? r('concession.customersNone') : undefined}>
        <Select
          value={draft.partyId}
          onChange={(event) => {
            set({ partyId: event.target.value, contactId: '' })
            if (event.target.value) actions?.onPickCustomer?.(event.target.value)
          }}
        >
          <option value="">{r('concession.customerPick')}</option>
          {(customers.items ?? []).map((customer) => (
            <option key={customer.id} value={customer.id}>
              {`${customer.code} · ${customer.name}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={r('concession.contact')} hint={draft.partyId && contacts.items === null && !contacts.problem ? r('choices.reading') : undefined}>
        <Select value={draft.contactId} disabled={!draft.partyId} onChange={(event) => set({ contactId: event.target.value })}>
          <option value="">{r('concession.contactNone')}</option>
          {(contacts.items ?? []).map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.email ? `${contact.name} · ${contact.email}` : contact.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={r('concession.askField')} hint={r('concession.askHint')} required>
        <Textarea rows={3} maxLength={1000} value={draft.ask} onChange={(event) => set({ ask: event.target.value })} />
      </Field>
      <Field label={r('concession.proposalField')} hint={r('concession.proposalHint')} required>
        <Textarea rows={2} maxLength={1000} value={draft.proposal} onChange={(event) => set({ proposal: event.target.value })} />
      </Field>
    </Frame>
  )
}

/** Record the customer's written answer (once): accepted or refused, who answered, when, their words, their file. */
export function AnswerConcessionDialog({ model, record, words, actions, dialog }: DialogProps<'answerConcession'>) {
  const { r } = words
  const concession = record.concessions.find((entry) => entry.id === dialog.concessionId)
  const draft = dialog.draft
  const heldKey = answerDraftHeld(draft, model.timeZone)
  const set = (patch: Partial<typeof draft>) => actions?.onDialog?.({ ...dialog, draft: { ...draft, ...patch } })
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={r('concession.answerTitle', { seq: concession?.seq ?? '' })} submit={r('concession.answerSubmit')} held={heldKey ? r(heldKey) : null}>
      {concession && <p className="fw-q-hint">{r('concession.answerAbout', { ask: concession.ask, customer: concession.party.name })}</p>}
      <div className="fw-q-stack" role="radiogroup" aria-label={r('concession.answerKind')}>
        <RadioCard name="answer" checked={draft.status === 'ACCEPTED'} selected={draft.status === 'ACCEPTED'} onChange={() => set({ status: 'ACCEPTED' })} title={r('concession.status.ACCEPTED')} description={r('concession.acceptedHint')} />
        <RadioCard name="answer" checked={draft.status === 'REFUSED'} selected={draft.status === 'REFUSED'} onChange={() => set({ status: 'REFUSED' })} title={r('concession.status.REFUSED')} description={r('concession.refusedHint')} />
      </div>
      <Field label={r('concession.answeredBy')} required>
        <Input value={draft.answeredBy} maxLength={120} onChange={(event) => set({ answeredBy: event.target.value })} />
      </Field>
      <Field label={r('concession.answeredAt')} hint={r('problem.zoneTime')} required>
        <Input type="datetime-local" value={draft.answeredAt} onChange={(event) => set({ answeredAt: event.target.value })} />
      </Field>
      <Field label={r('concession.answerWords')} required={draft.status === 'REFUSED'} hint={draft.status === 'REFUSED' ? r('concession.whyHint') : undefined}>
        <Textarea rows={3} maxLength={2000} value={draft.answer} onChange={(event) => set({ answer: event.target.value })} />
      </Field>
      <Field label={r('concession.file')} hint={dialog.fileName ?? r('concession.fileHint')}>
        <Input type="file" accept="application/pdf,image/*" aria-label={r('concession.file')} onChange={(event) => actions?.onConcessionFile?.(event.target.files?.[0] ?? null)} />
      </Field>
    </Frame>
  )
}
