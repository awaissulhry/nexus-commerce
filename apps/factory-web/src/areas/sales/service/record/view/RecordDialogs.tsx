'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { CASE_LIMITS, COVER_DECISIONS, COVERS, LINK_RECORD_TYPES } from '@nexus/factory-domain/sales/service/rules'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { CaseRecord, Cover, CoverDecision, LinkRecordType } from '../../api'
import { coverDraftProblems, coverDraftWarnings, linkTypeKey, MOVE_TO, moveDraftHeld, moveNeeds, repairDraftHeld, returnDraftHeld, RETURN_PURPOSES, type Phrase } from '../../model'
import { NoticeLine, useWords } from '../../parts'
import type { RecordDialog, ServiceRecordActions, ServiceRecordModel } from '../view-model'

/**
 * The case's dialogs: a move (what was done, why it closes, words for the customer with the status mail when the case tells
 * them), the cover decided (design case.warranty "Decide: covered / partly / not covered"), Link a record (a type and its
 * number), Unlink, Make repair and Make RMA (a return of the goods, a remake, a credit). Each submit is held, with why, until
 * it reads; ⌘↵ submits; every refusal is said in our words inside the dialog.
 */
export function RecordDialogs({ model, record, actions }: { model: ServiceRecordModel; record: CaseRecord; actions?: ServiceRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const props = { dialog, model, record, actions }
  switch (dialog.kind) {
    case 'move':
      return <MoveDialog {...props} dialog={dialog} />
    case 'decide':
      return <DecideDialog {...props} dialog={dialog} />
    case 'link':
      return <LinkDialog {...props} dialog={dialog} />
    case 'unlink':
      return <UnlinkDialog {...props} dialog={dialog} />
    case 'repair':
      return <RepairDialog {...props} dialog={dialog} />
    case 'return':
      return <ReturnDialog {...props} dialog={dialog} />
  }
}

type Props<K extends RecordDialog['kind']> = { dialog: Extract<RecordDialog, { kind: K }>; model: ServiceRecordModel; record: CaseRecord; actions?: ServiceRecordActions }

/** The frame every dialog shares: title, the notice, the body, Cancel and the held submit (⌘↵). */
function Frame({ title, subtitle, notice, held, busy, submit, tone = 'primary', children, actions, size = 'md' }: { title: string; subtitle?: string; notice: RecordDialog['notice']; held: string | null; busy: boolean; submit: string; tone?: 'primary' | 'danger'; children?: ReactNode; actions?: ServiceRecordActions; size?: 'md' | 'lg' }) {
  const { t } = useWords()
  const blocked = !!held || busy
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !blocked) {
        event.preventDefault()
        actions?.onSubmitDialog?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [blocked, actions])
  return (
    <Modal
      open
      size={size}
      title={title}
      subtitle={subtitle}
      onClose={() => actions?.onDialog?.(null)}
      footer={
        <span className="fw-svc-actions">
          <Button variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} heldReason={busy ? t('common.working') : held} onClick={() => actions?.onSubmitDialog?.()} aria-keyshortcuts="Meta+Enter">
            {busy && <Spinner size={12} />} {submit}
          </Button>
        </span>
      }
    >
      <div className="fw-svc-dialog">
        <NoticeLine notice={notice} />
        {children}
      </div>
    </Modal>
  )
}

const offlineHeld = (model: ServiceRecordModel): Phrase | null => (model.live === 'offline' ? { key: 'held.offline' } : null)

function MoveDialog({ dialog, model, record, actions }: Props<'move'>) {
  const { t, say } = useWords()
  const to = MOVE_TO[dialog.draft.action]
  const needs = moveNeeds(record.status, to, record.notifyCustomer)
  const held = say(offlineHeld(model) ?? moveDraftHeld(dialog.draft, needs))
  const change = (patch: Partial<typeof dialog.draft>) => actions?.onDialogChange?.({ draft: { ...dialog.draft, ...patch } })
  return (
    <Frame title={t(`move.title.${dialog.draft.action}`, { number: record.number })} subtitle={t('move.subtitle', { from: t(`status.${record.status}`), to: t(`status.${to}`) })} notice={dialog.notice} held={held} busy={dialog.busy} submit={t(`move.go.${dialog.draft.action}`)} tone={to === 'CLOSED' ? 'danger' : 'primary'} actions={actions}>
      {needs.resolution && (
        <Field label={t('move.resolution')} hint={t('move.resolutionHint')} required>
          <Textarea value={dialog.draft.resolution} rows={4} maxLength={CASE_LIMITS.resolution} onChange={(event) => change({ resolution: event.target.value })} />
        </Field>
      )}
      {to === 'CLOSED' && (
        <Field label={t('move.reason')} hint={needs.reason ? t('move.reasonHint') : t('move.reasonOptional')} required={needs.reason}>
          <Textarea value={dialog.draft.reason} rows={3} maxLength={CASE_LIMITS.closeReason} onChange={(event) => change({ reason: event.target.value })} />
        </Field>
      )}
      {record.notifyCustomer ? (
        <>
          <Banner tone="info" title={record.contact?.email ? t('move.mailGoes', { to: record.contact.email }) : t('move.mailNoContact')}>
            {t('move.mailWhat')}
          </Banner>
          <Field label={t('move.message')} hint={t('move.messageHint')}>
            <Textarea value={dialog.draft.message} rows={3} maxLength={CASE_LIMITS.message} onChange={(event) => change({ message: event.target.value })} />
          </Field>
        </>
      ) : (
        <p className="fw-svc-hint">{t('move.notTold')}</p>
      )}
      {to === 'CLOSED' && record.links.length > 0 && <p className="fw-svc-hint">{t('move.closeLinks', { count: record.links.length })}</p>}
    </Frame>
  )
}

function DecideDialog({ dialog, model, record, actions }: Props<'decide'>) {
  const { t, say } = useWords()
  const problems = coverDraftProblems(dialog.draft, record.warranty)
  const warnings = coverDraftWarnings(dialog.draft, record.warranty.check)
  const held = say(offlineHeld(model) ?? problems.cover ?? problems.note ?? null)
  const change = (patch: Partial<typeof dialog.draft>) => actions?.onDialogChange?.({ draft: { ...dialog.draft, ...patch } })
  return (
    <Frame title={t('decide.title', { number: record.number })} subtitle={t('decide.subtitle')} notice={dialog.notice} held={held} busy={dialog.busy} submit={t('decide.go')} actions={actions} size="lg">
      <fieldset className="fw-svc-stack fw-svc-fieldset">
        <legend className="fw-svc-h2">{t('decide.cover')}</legend>
        {COVERS.map((cover) => (
          <RadioCard key={cover} name="svc-cover" value={cover} checked={dialog.draft.cover === cover} selected={dialog.draft.cover === cover} onChange={() => change({ cover: cover as Cover, decision: cover === 'NONE' ? 'NOT_COVERED' : dialog.draft.decision === 'NOT_COVERED' ? 'COVERED' : dialog.draft.decision })} title={t(`coverName.${cover}`)} description={t(`decide.coverHint.${cover}`)} />
        ))}
      </fieldset>
      <Field label={t('decide.decision')} error={problems.cover ? say(problems.cover) : undefined}>
        <Select value={dialog.draft.decision} onChange={(event) => change({ decision: event.target.value as CoverDecision })}>
          {COVER_DECISIONS.map((decision) => (
            <option key={decision} value={decision}>
              {t(`decision.${decision}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('decide.note')} hint={t('decide.noteHint')} required error={dialog.draft.note && problems.note ? say(problems.note) : undefined}>
        <Textarea value={dialog.draft.note} rows={4} maxLength={CASE_LIMITS.coverNote} onChange={(event) => change({ note: event.target.value })} />
      </Field>
      {warnings.length > 0 && (
        <Banner tone="warning" title={t('decide.warnings')}>
          <ul className="fw-svc-lines">
            {warnings.map((warning, index) => (
              <li key={index}>{say(warning)}</li>
            ))}
          </ul>
        </Banner>
      )}
      <p className="fw-svc-hint">{say({ key: dialog.draft.cover === 'NONE' ? 'remedies.NONE' : `remedies.${dialog.draft.cover}` })}</p>
    </Frame>
  )
}

function LinkDialog({ dialog, model, record, actions }: Props<'link'>) {
  const { t, say } = useWords()
  const [q, setQ] = useState(dialog.q)
  const linked = new Set(record.links.map((link) => `${link.recordType}:${link.recordId}`))
  const held = say(offlineHeld(model) ?? (!dialog.picked ? { key: 'link.held.pick' } : linked.has(`${dialog.picked.recordType}:${dialog.picked.recordId}`) ? { key: 'link.held.already' } : dialog.note.trim().length > CASE_LIMITS.linkNote ? { key: 'common.atMost', params: { count: CASE_LIMITS.linkNote } } : null))
  const find = () => actions?.onFindLinkable?.(dialog.recordType, q)
  return (
    <Frame title={t('link.title', { number: record.number })} subtitle={t('link.subtitle')} notice={dialog.notice} held={held} busy={dialog.busy} submit={t('link.go')} actions={actions} size="lg">
      <div className="fw-svc-form">
        <Field label={t('link.type')}>
          <Select value={dialog.recordType} onChange={(event) => actions?.onDialogChange?.({ recordType: event.target.value as LinkRecordType, picked: null, found: { items: null, reading: false, problem: null } })}>
            {LINK_RECORD_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(linkTypeKey(type))}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('link.number')} hint={t('link.numberHint')}>
          <span className="fw-svc-row">
            <Input
              type="search"
              value={q}
              aria-label={t('link.number')}
              onChange={(event) => setQ(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  find()
                }
              }}
            />
            <Button size="sm" variant="secondary" onClick={find}>
              <Search size={14} aria-hidden /> {t('link.find')}
            </Button>
          </span>
        </Field>
      </div>
      {dialog.found.reading && (
        <p className="fw-svc-hint" role="status">
          <Spinner size={12} /> {t('common.reading')}
        </p>
      )}
      {dialog.found.problem && <Banner tone="warning" title={t(dialog.found.problem)} />}
      {dialog.found.items !== null && dialog.found.items.length === 0 && <p className="fw-svc-hint">{t('link.none')}</p>}
      {dialog.found.items && dialog.found.items.length > 0 && (
        <fieldset className="fw-svc-stack fw-svc-fieldset">
          <legend className="fw-svc-hint">{t('link.found', { count: dialog.found.items.length })}</legend>
          {dialog.found.items.map((item) => {
            const already = linked.has(`${item.recordType}:${item.recordId}`)
            return (
              <RadioCard
                key={item.recordId}
                variant="row"
                name="svc-link"
                value={item.recordId}
                checked={dialog.picked?.recordId === item.recordId}
                selected={dialog.picked?.recordId === item.recordId}
                disabled={already}
                onChange={() => actions?.onDialogChange?.({ picked: item })}
                title={item.number}
                description={already ? t('link.held.already') : (item.title ?? undefined)}
              />
            )
          })}
        </fieldset>
      )}
      <Field label={t('link.note')} hint={t('link.noteHint')}>
        <Input value={dialog.note} maxLength={CASE_LIMITS.linkNote} onChange={(event) => actions?.onDialogChange?.({ note: event.target.value })} />
      </Field>
    </Frame>
  )
}

function UnlinkDialog({ dialog, model, record, actions }: Props<'unlink'>) {
  const { t, say } = useWords()
  const link = record.links.find((entry) => entry.id === dialog.linkId)
  const what = link?.record?.label ?? (link ? t(linkTypeKey(link.recordType)) : '—')
  return (
    <Frame title={t('unlink.title', { what })} notice={dialog.notice} held={say(offlineHeld(model))} busy={dialog.busy} submit={t('unlink.go')} tone="danger" actions={actions}>
      <p className="fw-svc-hint">{t('unlink.body', { what, number: record.number })}</p>
    </Frame>
  )
}

function RepairDialog({ dialog, model, record, actions }: Props<'repair'>) {
  const { t, say } = useWords()
  const held = say(offlineHeld(model) ?? repairDraftHeld(dialog.draft))
  const change = (patch: Partial<typeof dialog.draft>) => actions?.onDialogChange?.({ draft: { ...dialog.draft, ...patch } })
  return (
    <Frame title={t('repair.title', { number: record.number })} subtitle={t('actions.repair.creates')} notice={dialog.notice} held={held} busy={dialog.busy} submit={t('repair.go')} actions={actions} size="lg">
      <Field label={t('repair.kind')}>
        <Select value={dialog.draft.kind} onChange={(event) => change({ kind: event.target.value as 'REPAIR' | 'ALTERATION' })}>
          <option value="REPAIR">{t('repair.kindREPAIR')}</option>
          <option value="ALTERATION">{t('repair.kindALTERATION')}</option>
        </Select>
      </Field>
      <Field label={t('repair.problem')} hint={t('repair.problemHint')} required>
        <Textarea value={dialog.draft.problem} rows={4} maxLength={2000} onChange={(event) => change({ problem: event.target.value })} />
      </Field>
      <Field label={t('repair.work')}>
        <Textarea value={dialog.draft.workWanted} rows={3} maxLength={2000} onChange={(event) => change({ workWanted: event.target.value })} />
      </Field>
      <Checkbox label={t('repair.received')} checked={dialog.draft.received} onChange={(event) => change({ received: event.target.checked })} />
    </Frame>
  )
}

function ReturnDialog({ dialog, model, record, actions }: Props<'return'>) {
  const { t, say } = useWords()
  const locale = useLocale()
  const held = say(offlineHeld(model) ?? returnDraftHeld(dialog.draft, record.garment))
  const change = (patch: Partial<typeof dialog.draft>) => actions?.onDialogChange?.({ draft: { ...dialog.draft, ...patch } })
  const shipment = record.garment.serial?.shipment ?? null
  return (
    <Frame title={t(`return.title.${dialog.draft.purpose}`, { number: record.number })} subtitle={t(`actions.${dialog.draft.purpose}.creates`)} notice={dialog.notice} held={held} busy={dialog.busy} submit={t(`return.go.${dialog.draft.purpose}`)} actions={actions} size="lg">
      <fieldset className="fw-svc-stack fw-svc-fieldset">
        <legend className="fw-svc-h2">{t('return.purpose')}</legend>
        {RETURN_PURPOSES.map((purpose) => (
          <RadioCard key={purpose} variant="row" name="svc-purpose" value={purpose} checked={dialog.draft.purpose === purpose} selected={dialog.draft.purpose === purpose} onChange={() => change({ purpose })} title={t(`actions.${purpose}.title`)} description={t(`actions.${purpose}.creates`)} />
        ))}
      </fieldset>
      {shipment ? <p className="fw-svc-hint">{t('return.line', { serial: record.garmentSerial ?? '', number: shipment.number })}</p> : <Banner tone="warning" title={t('return.held.noShipment')} />}
      <Field label={t('return.reason')} required hint={dialog.reasons.items === null && !dialog.reasons.problem ? t('common.reading') : undefined}>
        <Select value={dialog.draft.reasonCode} onChange={(event) => change({ reasonCode: event.target.value })}>
          <option value="">{t('return.pickReason')}</option>
          {(dialog.reasons.items ?? []).map((reason) => (
            <option key={reason.code} value={reason.code}>
              {locale === 'it' ? reason.labelIt : reason.labelEn}
            </option>
          ))}
        </Select>
      </Field>
      {dialog.reasons.problem && <Banner tone="warning" title={t('return.reasonsFailed')} />}
      {dialog.draft.purpose === 'REMAKE' && (
        <Field label={t('return.fit')} hint={t('return.fitHint')} required>
          <Textarea value={dialog.draft.fit} rows={3} maxLength={4000} onChange={(event) => change({ fit: event.target.value })} />
        </Field>
      )}
      <div className="fw-svc-form">
        <Field label={t('return.customerRef')}>
          <Input value={dialog.draft.customerRef} maxLength={80} onChange={(event) => change({ customerRef: event.target.value })} />
        </Field>
        <Field label={t('return.goodsDueBy')}>
          <DateField value={dialog.draft.goodsDueBy} onChange={(value) => change({ goodsDueBy: value })} />
        </Field>
      </div>
      <p className="fw-svc-hint">{t(`return.next.${dialog.draft.purpose}`)}</p>
    </Frame>
  )
}
