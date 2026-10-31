'use client'

import { useState } from 'react'
import { CheckCircle2, CircleAlert } from 'lucide-react'
import { Banner, Field, FileDropzone, FileRow, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { EVIDENCE_KINDS, type EvidenceKind, type Shipment } from '../../api'
import { evidenceEnough, fileSize, freightFacts, freightHeld, money, paperProblem, parseFreight, voidOutcomeKey, voidPlan } from '../../daily-model'
import { carrierWords } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { close, Frame } from './DialogFrame'

/**
 * The every-day dialogs of a shipment (B-W2a-71): Void labels (design pop:sh-void — "voiding one parcel voids all N
 * parcels of this shipment", the fee back only within the carrier's own window; a reason; the outcome per parcel), the
 * freight charged (typed, or back to the site's rule: a price), and the intra-EU transport evidence (file a paper of a
 * kind, mark it complete after the person's check, reopen it, say it is or is not needed — each with its reason). Esc
 * closes and the focus returns to the opener (DS Modal); ⌘↵ confirms; a refusal is said inside the dialog.
 */
export function DailyDialog({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const props = { shipment, model, actions }
  switch (dialog.kind) {
    case 'voidLabels':
      return <VoidDialog {...props} />
    case 'freight':
      return <FreightDialog {...props} />
    case 'evidenceFile':
      return <PaperDialog {...props} />
    case 'evidenceComplete':
      return <CompleteDialog {...props} />
    case 'evidenceReopen':
      return <ReopenDialog {...props} />
    case 'evidenceNeed':
      return <NeedDialog {...props} needed={dialog.needed} />
    default:
      return null
  }
}

interface DialogProps {
  shipment: Shipment
  model: ShipmentRecordModel
  actions?: ShipmentRecordActions
}

// ---- Void labels ----------------------------------------------------------------------------------------------------------

function VoidDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const [reason, setReason] = useState('')
  const plan = voidPlan(shipment, model.tracking?.value ?? null)
  const carrier = carrierWords(shipment)
  const voided = model.voided
  const count = plan.toVoid.length
  const done = voided ? (
    <div className="fw-sh-stack">
      <p className="fw-sh-done">
        {voided.problem ? <CircleAlert size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />} {voided.problem ? t('void.partial') : t('void.done', { count: voided.outcomes.filter((entry) => entry.ok).length })}
      </p>
      <ul className="fw-sh-list">
        {voided.outcomes.map((outcome) => (
          <li key={outcome.parcelId}>
            {t(voidOutcomeKey(outcome), { seq: outcome.seq })}
            {!outcome.ok && outcome.problem ? <span className="fw-sh-cell-sub">{outcome.problem}</span> : null}
          </li>
        ))}
      </ul>
      <p className="fw-sh-hint">{t('void.next')}</p>
    </div>
  ) : undefined
  const held = model.busy ? t('held.busy') : count === 0 ? t('held.voidCollected', { count: plan.kept.length }) : reason.trim().length < 3 ? t('void.held.reason') : null
  return (
    <Frame title={t('void.title')} subtitle={shipment.number} held={held} go={() => actions?.onVoidLabels?.(reason.trim())} goLabel={t('void.go', { count })} onClose={close(actions)} problem={model.dialogProblem} tone="danger" done={done}>
      <KeyValue
        labelCase="sentence"
        items={[
          { label: t('carrier.carrier'), value: t(carrier.key, carrier.params) },
          { label: t('void.parcels'), value: plan.toVoid.map((parcel) => t('cartons.name', { seq: parcel.seq, count: shipment.parcels.length })).join(' · ') || '—' },
        ]}
      />
      <ul className="fw-sh-list">
        <li>{t('void.all', { count: shipment.parcels.filter((parcel) => parcel.trackingNumber).length })}</li>
        <li>{t('void.fee')}</li>
        <li>{t('void.after')}</li>
      </ul>
      {plan.kept.length > 0 && <Banner tone="warning" title={t('void.kept', { count: plan.kept.length, parcels: plan.kept.map((entry) => entry.seq).join(', ') })} />}
      <Field label={t('void.reason')} hint={t('void.reasonHint')} required>
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      {model.busy && (
        <p className="fw-sh-hint" role="status">
          <Spinner size={14} /> {t('void.busy')}
        </p>
      )}
    </Frame>
  )
}

// ---- The freight charged ---------------------------------------------------------------------------------------------------

function FreightDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const locale = useLocale()
  const facts = freightFacts(shipment.freight, shipment, model.can)
  const [text, setText] = useState(facts.charge !== null && facts.state === 'byHand' ? String(facts.charge / 100).replace('.', locale === 'it' ? ',' : '.') : '')
  const [toRule, setToRule] = useState(false)
  const typed = parseFreight(text)
  const blocked = freightHeld(shipment, model.can)
  const held = model.busy ? t('held.busy') : blocked ? t(blocked.key, blocked.params) : toRule ? null : typed === undefined ? t('charge.held.amount') : typed === null ? t('charge.held.none') : null
  const goLabel = toRule ? t('charge.goRule') : t('charge.go', { amount: typed === null || typed === undefined ? '—' : money(typed, facts.currency, locale) })
  return (
    <Frame title={t('charge.title')} subtitle={shipment.number} held={held} go={() => actions?.onFreight?.(toRule ? null : (typed ?? null))} goLabel={goLabel} onClose={close(actions)} problem={model.dialogProblem} size="sm">
      <KeyValue
        labelCase="sentence"
        items={[
          { label: t('charge.now'), value: facts.shown ? (facts.charge === null ? t('charge.notDecided') : money(facts.charge, facts.currency, locale)) : t('charge.hidden') },
          { label: t('charge.rule'), value: facts.shown ? (facts.byRule === null ? t('charge.ruleNone') : money(facts.byRule, facts.currency, locale)) : t('charge.hidden') },
        ]}
      />
      <p className="fw-sh-hint">{t(facts.basis.key, facts.basis.params)}</p>
      <Field label={t('charge.amount', { currency: facts.currency })} hint={t('charge.amountHint')} error={!toRule && typed === undefined ? t('charge.held.amount') : undefined}>
        <Input size="sm" inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} disabled={toRule} suffix={facts.currency} autoFocus />
      </Field>
      {facts.state === 'byHand' && <Checkbox checked={toRule} onChange={(event) => setToRule(event.target.checked)} label={t('charge.backToRule')} />}
      <p className="fw-sh-hint">{t('charge.invoiceNote')}</p>
    </Frame>
  )
}

// ---- The intra-EU transport evidence -------------------------------------------------------------------------------------------

function PaperDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const locale = useLocale()
  const [kind, setKind] = useState<EvidenceKind>('POD')
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const held = model.busy ? t('held.busy') : !file ? t('evidence.file.held') : problem ? t(problem) : null
  return (
    <Frame title={t('evidence.file.title')} subtitle={shipment.number} held={held} go={() => file && actions?.onFilePaper?.(kind, file)} goLabel={t('evidence.file.go')} onClose={close(actions)} problem={model.dialogProblem}>
      <Field label={t('evidence.file.kind')} hint={t(`evidence.kindHint.${kind}`)}>
        <Select size="sm" value={kind} onChange={(event) => setKind(event.target.value as EvidenceKind)}>
          {EVIDENCE_KINDS.map((value) => (
            <option key={value} value={value}>
              {t(`evidence.kind.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      {file ? (
        <span className="fw-sh-paper-picked">
          <FileRow name={file.name} size={file.size} status={problem ? t(problem) : t('evidence.file.ready', { size: fileSize(file.size, locale) })} tone={problem ? 'danger' : 'neutral'} />
          <Button size="sm" variant="quiet" onClick={() => (setFile(null), setProblem(null))}>
            {t('evidence.file.another')}
          </Button>
        </span>
      ) : (
        // The DS dropzone's own refusals are English: it takes any file here, and this screen says why one is refused.
        <FileDropzone
          hint={t('evidence.file.hint')}
          onFiles={(files) => {
            const next = files[0] ?? null
            setFile(next)
            setProblem(next ? paperProblem(next) : null)
          }}
        />
      )}
      <p className="fw-sh-hint">{t('evidence.file.kept')}</p>
      {model.busy && (
        <p className="fw-sh-hint" role="status">
          <Spinner size={14} /> {t('evidence.file.busy')}
        </p>
      )}
    </Frame>
  )
}

function CompleteDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const [note, setNote] = useState(model.evidence.value?.note ?? '')
  const papers = (model.evidence.value?.papers ?? []).filter((paper) => paper.status === 'AVAILABLE')
  const held = model.busy ? t('held.busy') : !evidenceEnough(papers) ? t('held.evidenceShort') : null
  return (
    <Frame title={t('evidence.complete.title')} subtitle={shipment.number} held={held} go={() => actions?.onCompleteEvidence?.(note)} goLabel={t('evidence.complete.go')} onClose={close(actions)} problem={model.dialogProblem}>
      <p>{t('evidence.complete.what', { count: papers.length })}</p>
      <ul className="fw-sh-list">
        {papers.map((paper) => (
          <li key={paper.fileId}>
            {t(`evidence.kind.${paper.kind}`)} · {paper.originalName}
          </li>
        ))}
      </ul>
      <Banner tone="info" title={t('evidence.complete.check')} />
      <Field label={t('evidence.complete.note')} hint={t('evidence.complete.noteHint')}>
        <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
    </Frame>
  )
}

function ReopenDialog({ shipment, model, actions }: DialogProps) {
  const t = useT('shipments')
  const [reason, setReason] = useState('')
  const held = model.busy ? t('held.busy') : reason.trim().length < 3 ? t('evidence.reason.held') : null
  return (
    <Frame title={t('evidence.reopen.title')} subtitle={shipment.number} held={held} go={() => actions?.onReopenEvidence?.(reason.trim())} goLabel={t('evidence.reopen.go')} onClose={close(actions)} problem={model.dialogProblem} tone="danger" size="sm">
      <p>{t('evidence.reopen.what')}</p>
      <Field label={t('evidence.reason.label')} required>
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  )
}

function NeedDialog({ shipment, model, actions, needed }: DialogProps & { needed: boolean }) {
  const t = useT('shipments')
  const [reason, setReason] = useState('')
  const held = model.busy ? t('held.busy') : reason.trim().length < 3 ? t('evidence.reason.held') : null
  return (
    <Frame title={t(needed ? 'evidence.need.title.needed' : 'evidence.need.title.notNeeded')} subtitle={shipment.number} held={held} go={() => actions?.onEvidenceNeeded?.(needed, reason.trim())} goLabel={t(needed ? 'evidence.need.go.needed' : 'evidence.need.go.notNeeded')} onClose={close(actions)} problem={model.dialogProblem} size="sm">
      <p>{t(needed ? 'evidence.need.what.needed' : 'evidence.need.what.notNeeded')}</p>
      <Field label={t('evidence.reason.label')} hint={t(needed ? 'evidence.need.hint.needed' : 'evidence.need.hint.notNeeded')} required>
        <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  )
}
