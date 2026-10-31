'use client'

import { useRef, type ReactNode } from 'react'
import { Camera } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { CONTAINMENT_KINDS, type NcrRecord } from '../../api'
import { NoticeLine } from '../../parts'
import {
  carryHeld,
  carryKindOf,
  holdHeld,
  holdSubjects,
  isQuantity,
  codeKindOf,
  linesTotal,
  quantityValue,
  type ActionDraft,
  type CarryDraft,
  type HoldDraft,
  type NcrRecordActions,
  type NcrRecordModel,
  type RecordDialog,
} from '../view-model'
import { codeLabel, type RecordWords } from './words'

/**
 * Every dialog of the NCR record (each a DS Modal: Esc closes, the focus goes back to the opener; the main button held
 * with its reason until the dialog has what it needs): add a containment action (with "Hold stock" placing its hold —
 * the design's Place hold dialog, composed here from its fields until the Holds screens share theirs), mark one done
 * with its evidence, cancel one, decide by quantity, carry a decision out by its code, create the rework order, remove a
 * decision, link a record, close a hold now, cancel the NCR, open its PPE register entry.
 */
export function RecordDialogs({ model, record, words, actions }: { model: NcrRecordModel; record: NcrRecord; words: RecordWords; actions?: NcrRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const props = { model, record, words, actions }
  switch (dialog.kind) {
    case 'addAction':
      return <AddAction {...props} dialog={dialog} />
    case 'doneAction':
      return <DoneAction {...props} dialog={dialog} />
    case 'cancelAction':
      return <ReasonDialog {...props} dialog={dialog} title={words.r('cancelAction.title')} body={words.r('cancelAction.body')} label={words.r('cancelAction.reason')} submit={words.r('cancelAction.submit')} value={dialog.reason} onValue={(reason) => actions?.onDialog?.({ ...dialog, reason })} />
    case 'decide':
      return <Decide {...props} dialog={dialog} />
    case 'carryOut':
      return <CarryOut {...props} dialog={dialog} />
    case 'rework':
      return <Rework {...props} dialog={dialog} />
    case 'removeDecision':
      return <RemoveDecision {...props} dialog={dialog} />
    case 'link':
      return <LinkRecord {...props} dialog={dialog} />
    case 'closeHold':
      return <ReasonDialog {...props} dialog={dialog} title={words.r('closeHold.title')} body={words.r('closeHold.body')} label={words.r('closeHold.note')} submit={words.r('closeHold.submit')} value={dialog.note} onValue={(note) => actions?.onDialog?.({ ...dialog, note })} />
    case 'cancelNcr':
      return <ReasonDialog {...props} dialog={dialog} title={words.r('cancelNcr.title', { number: record.ncr.number })} body={words.r('cancelNcr.body')} label={words.r('cancelNcr.reason')} submit={words.r('cancelNcr.submit')} value={dialog.reason} onValue={(reason) => actions?.onDialog?.({ ...dialog, reason })} danger />
    case 'register':
      return <Register {...props} dialog={dialog} />
  }
}

interface Props<K extends RecordDialog['kind']> {
  model: NcrRecordModel
  record: NcrRecord
  words: RecordWords
  actions?: NcrRecordActions
  dialog: Extract<RecordDialog, { kind: K }>
}

/** The frame every dialog shares: the stale banner, the dialog's notice, Cancel and the held main button. */
function Frame({ model, words, actions, dialog, title, submit, held, danger, children, size = 'md' }: { model: NcrRecordModel; words: RecordWords; actions?: NcrRecordActions; dialog: RecordDialog; title: string; submit: string; held: string | null; danger?: boolean; children?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={title}
      size={size}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onDialog?.(null)}>
            {words.t('common.cancel')}
          </Button>
          <Button size="sm" variant={danger ? 'danger' : 'primary'} heldReason={dialog.busy ? words.t('common.working') : held} onClick={() => actions?.onSubmitDialog?.()}>
            {dialog.busy ? <Spinner size={12} /> : null} {submit}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        {model.stale && <Banner tone="warning" title={words.r('stale.title', { time: model.stale })} action={<Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>{words.r('stale.reload')}</Button>} />}
        <NoticeLine notice={dialog.notice} />
        {children}
      </div>
    </Modal>
  )
}

function PeopleSelect({ model, words, value, onChange, label }: { model: NcrRecordModel; words: RecordWords; value: string; onChange: (value: string) => void; label: string }) {
  const people = model.people ?? []
  return (
    <Field label={label} hint={model.people === null ? words.r('people.reading') : undefined}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{words.t('common.nobody')}</option>
        {people.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.me ? words.t('common.me', { name: entry.name }) : entry.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/** The Place hold fields ("Hold stock"): what is held, why, a note. */
function HoldFields({ model, record, words, draft, onChange }: { model: NcrRecordModel; record: NcrRecord; words: RecordWords; draft: HoldDraft; onChange: (draft: HoldDraft) => void }) {
  const { r } = words
  const subjects = holdSubjects(record.ncr)
  const reasons = model.choices.holdReasons
  if (subjects.length === 0) return <Banner tone="info" title={r('hold.heldNoSubject')} />
  return (
    <div className="fw-ncr-form">
      <Field label={r('hold.subject')} required>
        <Select value={draft.subject} onChange={(event) => onChange({ ...draft, subject: event.target.value })}>
          <option value="">{r('hold.subjectPick')}</option>
          {subjects.map((subject) => (
            <option key={subject.key} value={subject.key}>
              {`${words.t(`recordType.${subject.subjectType}`)} ${subject.label}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={r('hold.reason')} required hint={reasons.problem ? r('hold.reasonsFailed') : reasons.items === null ? r('choices.reading') : undefined}>
        <Select value={draft.reasonCode} onChange={(event) => onChange({ ...draft, reasonCode: event.target.value })}>
          <option value="">{r('hold.reasonPick')}</option>
          {(reasons.items ?? []).map((reason) => (
            <option key={reason.id} value={reason.code}>
              {codeLabel(reason, words.locale)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={r('hold.note')} className="is-wide">
        <Textarea rows={2} value={draft.note} onChange={(event) => onChange({ ...draft, note: event.target.value })} />
      </Field>
    </div>
  )
}

function AddAction({ model, record, words, actions, dialog }: Props<'addAction'>) {
  const { r } = words
  const draft = dialog.draft
  const set = (patch: Partial<ActionDraft>) => actions?.onDialog?.({ ...dialog, draft: { ...draft, ...patch } })
  const hold = draft.kind === 'HOLD_STOCK' && draft.placeHold
  const held =
    draft.kind === 'OTHER' && !draft.description.trim()
      ? r('addAction.heldDescription')
      : hold && !model.can.holdsPlace
        ? r('hold.heldPlace')
        : hold
          ? (() => {
              const key = holdHeld(draft.hold, holdSubjects(record.ncr), model.choices.holdReasons.items)
              return key ? r(key) : null
            })()
          : null
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={r('addAction.title')} submit={hold ? r('addAction.submitHold') : r('addAction.submit')} held={held}>
      <div className="fw-ncr-form">
        <Field label={r('addAction.kind')} required>
          <Select value={draft.kind} onChange={(event) => set({ kind: event.target.value as ActionDraft['kind'] })}>
            {CONTAINMENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {r(`kind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <PeopleSelect model={model} words={words} label={r('col.owner')} value={draft.ownerId} onChange={(ownerId) => set({ ownerId })} />
        <Field label={r('addAction.description')} required={draft.kind === 'OTHER'} className="is-wide">
          <Textarea rows={2} value={draft.description} onChange={(event) => set({ description: event.target.value })} />
        </Field>
        <Field label={r('col.due')} hint={r('problem.zoneTime')}>
          <Input type="datetime-local" value={draft.dueAt} onChange={(event) => set({ dueAt: event.target.value })} />
        </Field>
      </div>
      {draft.kind === 'HOLD_STOCK' && (
        <>
          <Checkbox checked={draft.placeHold} onChange={(event) => set({ placeHold: event.target.checked })} label={r('addAction.placeHold')} />
          {draft.placeHold ? <HoldFields model={model} record={record} words={words} draft={draft.hold} onChange={(next) => set({ hold: next })} /> : <p className="fw-q-hint">{r('addAction.holdLater')}</p>}
        </>
      )}
      <p className="fw-q-hint">{r('addAction.hint')}</p>
    </Frame>
  )
}

function DoneAction({ model, record, words, actions, dialog }: Props<'doneAction'>) {
  const { r } = words
  const action = record.containment.find((entry) => entry.id === dialog.actionId)
  const file = useRef<HTMLInputElement>(null)
  const needsHold = action?.kind === 'HOLD_STOCK' && !action.hold
  const holdKey = needsHold ? (!model.can.holdsPlace ? 'hold.heldPlace' : holdHeld(dialog.hold, holdSubjects(record.ncr), model.choices.holdReasons.items)) : null
  const held = !dialog.evidence.trim() && !dialog.photoName && !needsHold ? r('done.heldEvidence') : holdKey ? r(holdKey) : null
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={r('done.title', { seq: action?.seq ?? '—' })} submit={r('done.submit')} held={held}>
      {action && <p className="fw-q-hint">{`${r(`kind.${action.kind}`)}${action.description ? ` · ${action.description}` : ''}`}</p>}
      <Field label={r('done.evidence')} hint={r('done.evidenceHint')}>
        <Textarea rows={3} maxLength={2000} value={dialog.evidence} onChange={(event) => actions?.onDialog?.({ ...dialog, evidence: event.target.value })} />
      </Field>
      <div className="fw-ncr-r-row">
        <Button size="sm" heldReason={model.can.filesUpload ? null : words.t('new.photosHeld')} onClick={() => file.current?.click()}>
          <Camera size={14} aria-hidden /> {r('done.photo')}
        </Button>
        <span className="fw-q-hint">{dialog.photoName ?? r('done.noPhoto')}</span>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null
            event.target.value = ''
            actions?.onDoneFile?.(picked)
          }}
        />
      </div>
      {needsHold && (
        <>
          <p className="fw-q-hint">{r('done.holdNeeded')}</p>
          <HoldFields model={model} record={record} words={words} draft={dialog.hold} onChange={(hold) => actions?.onDialog?.({ ...dialog, hold })} />
        </>
      )}
    </Frame>
  )
}

function ReasonDialog({ model, words, actions, dialog, title, body, label, submit, value, onValue, danger }: Omit<Props<'cancelAction' | 'closeHold' | 'cancelNcr'>, 'record'> & { record: NcrRecord; title: string; body: string; label: string; submit: string; value: string; onValue: (value: string) => void; danger?: boolean }) {
  const held = value.trim().length < 3 ? words.r('reason.held') : null
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={title} submit={submit} held={held} danger={danger} size="sm">
      <p className="fw-q-hint">{body}</p>
      <Field label={label} required hint={words.r('reason.hint')}>
        <Textarea rows={3} maxLength={500} value={value} onChange={(event) => onValue(event.target.value)} />
      </Field>
    </Frame>
  )
}

function Decide({ model, record, words, actions, dialog }: Props<'decide'>) {
  const { r, t, amount } = words
  const draft = dialog.draft
  const codes = model.choices.dispositions
  const code = codes.items?.find((entry) => entry.id === draft.dispositionCodeId) ?? null
  const left = Number(record.ncr.decided.left)
  const set = (patch: Partial<typeof draft>) => actions?.onDialog?.({ ...dialog, draft: { ...draft, ...patch } })
  const held = !draft.dispositionCodeId ? r('decide.heldCode') : !isQuantity(draft.quantity) ? r('decide.heldQuantity') : Number(quantityValue(draft.quantity)) > left ? r('decide.heldLeft', { left: amount(record.ncr.decided.left, record.ncr.uom) }) : null
  const kind = code ? codeKindOf(code) : null
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={r('decide.title', { number: record.ncr.number })} submit={r('decide.submit')} held={held}>
      <p className="fw-q-hint">{r('decide.left', { left: amount(record.ncr.decided.left, record.ncr.uom), affected: amount(record.ncr.quantityAffected, record.ncr.uom) })}</p>
      <div className="fw-ncr-form">
        <Field label={r('decide.code')} required hint={codes.problem ? r('decide.codesFailed') : codes.items === null ? r('choices.reading') : undefined}>
          <Select value={draft.dispositionCodeId} onChange={(event) => set({ dispositionCodeId: event.target.value })}>
            <option value="">{r('decide.codePick')}</option>
            {(codes.items ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${codeLabel(entry, words.locale)} · ${r(`outcome.${entry.outcome}`)}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t('col.quantity')} (${t(`uom.${record.ncr.uom}`)})`} required>
          <Input inputMode="decimal" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} />
        </Field>
        <Field label={r('col.note')} className="is-wide">
          <Textarea rows={2} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
      </div>
      {code && kind && <p className="fw-q-hint">{`${r(`carryKind.${kind}`)}${code.reinspection ? ` ${r('decide.reinspection')}` : ''}`}</p>}
      {code && code.outcome === 'USE_AS_IS' && record.ncr.severity !== 'MINOR' && <Banner tone="warning" title={r('decide.asIsRefused', { severity: t(`severity.${record.ncr.severity}`) })} />}
      <p className="fw-q-hint">{r('decide.approvalHint')}</p>
    </Frame>
  )
}

function CarryOut({ model, record, words, actions, dialog }: Props<'carryOut'>) {
  const { r, t, amount } = words
  const ncr = record.ncr
  const decision = record.decisions.find((entry) => entry.id === dialog.decisionId)
  if (!decision) return null
  const draft = dialog.draft
  const set = (patch: Partial<CarryDraft>) => actions?.onDialog?.({ ...dialog, draft: { ...draft, ...patch } })
  const move = decision.disposition?.stockMoveReason ?? null
  const kind = carryKindOf(decision)
  const heldKey = carryHeld(decision, ncr, draft)
  const total = linesTotal(draft, ncr.uom)
  const site = model.choices.sites.items?.find((entry) => entry.id === ncr.siteId) ?? null
  const places = (site?.locations ?? []).filter((location) => location.status === 'ACTIVE' && (decision.disposition?.outcome !== 'QUARANTINE' || location.kind === 'QUARANTINE'))
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={r('carry.title', { seq: decision.seq, code: codeLabel(decision.disposition, words.locale) })} submit={r('carry.submit')} held={heldKey ? r(heldKey) : null} size="lg">
      <p className="fw-q-hint">{r('carry.what', { quantity: amount(decision.quantity, ncr.uom), kind: r(`carryKind.${kind}`) })}</p>
      {move && (
        <section className="fw-q-stack" aria-labelledby="carry-lines">
          <h3 id="carry-lines" className="fw-ncr-h3">
            {r('carry.lines', { move: r(`move.${move}`) })}
          </h3>
          {model.choices.stock.problem ? (
            <p className="fw-q-hint">{r('carry.stockFailed')}</p>
          ) : model.choices.stock.items === null ? (
            <p className="fw-q-loading" role="status">
              <Spinner size={14} /> {r('carry.stockReading')}
            </p>
          ) : draft.lines.length === 0 ? (
            <Banner tone="warning" title={r('carry.heldNoPlaces')} />
          ) : (
            <ul className="fw-ncr-r-lines">
              {draft.lines.map((line, index) => (
                <li key={line.key} className="fw-ncr-r-line">
                  <span className="fw-ncr-r-cell">
                    <span className="fw-q-name">{line.place}</span>
                    <span className="fw-ncr-r-sub">{`${line.what} · ${r('carry.onHand', { quantity: amount(line.onHand, line.uom) })}`}</span>
                  </span>
                  <span className="fw-ncr-r-row">
                    <Input
                      size="sm"
                      inputMode="decimal"
                      className="fw-ncr-r-qty"
                      aria-label={r('carry.lineQuantity', { place: line.place })}
                      value={line.quantity}
                      onChange={(event) => set({ lines: draft.lines.map((entry, at) => (at === index ? { ...entry, quantity: event.target.value } : entry)) })}
                    />
                    <span className="fw-ncr-r-sub">{t(`uom.${line.uom}`)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {total !== null && draft.lines.length > 0 && (
            <p className={total === Number(decision.quantity) ? 'fw-q-hint' : 'fw-q-hint fw-ncr-r-bad'}>{r('carry.total', { total: amount(String(total), ncr.uom), quantity: amount(decision.quantity, ncr.uom) })}</p>
          )}
          {move === 'TRANSFER' && (
            <Field label={r('carry.to')} required hint={model.choices.sites.problem ? r('carry.sitesFailed') : model.choices.sites.items === null ? r('choices.reading') : undefined}>
              <Select value={draft.toLocationId} onChange={(event) => set({ toLocationId: event.target.value })}>
                <option value="">{r('carry.toPick')}</option>
                {places.map((location) => (
                  <option key={location.id} value={location.id}>
                    {`${location.code} · ${location.name}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {move === 'ISSUE' && ncr.workOrder && <p className="fw-q-hint">{r('carry.issueTo', { number: ncr.workOrder.number })}</p>}
        </section>
      )}
      {kind === 'repair' && (
        <section className="fw-q-stack" aria-labelledby="carry-repair">
          <h3 id="carry-repair" className="fw-ncr-h3">
            {r('carry.repair')}
          </h3>
          <Input type="search" aria-label={r('carry.repairSearch')} placeholder={r('carry.repairSearch')} value={draft.repairQuery} onChange={(event) => {
            set({ repairQuery: event.target.value })
            actions?.onFindRepairs?.(event.target.value)
          }} />
          {model.choices.repairs.problem ? (
            <p className="fw-q-hint">{r('carry.repairsFailed')}</p>
          ) : model.choices.repairs.items === null ? (
            <p className="fw-q-loading" role="status">
              <Spinner size={14} /> {r('choices.reading')}
            </p>
          ) : model.choices.repairs.items.length === 0 ? (
            <p className="fw-q-hint">{r('carry.repairsNone')}</p>
          ) : (
            <div className="fw-q-stack" role="radiogroup" aria-label={r('carry.repair')}>
              {model.choices.repairs.items.map((repair) => (
                <RadioCard key={repair.id} name="repair" checked={draft.followUpId === repair.id} selected={draft.followUpId === repair.id} onChange={() => set({ followUpId: repair.id })} title={`${repair.number}${repair.serial ? ` · ${repair.serial}` : ''}`} description={repair.problem} />
              ))}
            </div>
          )}
        </section>
      )}
      {(kind === 'claim' || kind === 'stockAndClaim') && (
        <section className="fw-q-stack" aria-labelledby="carry-claim">
          <h3 id="carry-claim" className="fw-ncr-h3">
            {r('carry.claim', { supplier: ncr.supplier ? ncr.supplier.name : '—' })}
          </h3>
          <div className="fw-ncr-r-row" role="radiogroup" aria-label={r('carry.claim', { supplier: ncr.supplier?.name ?? '—' })}>
            <RadioCard variant="row" name="claimMode" checked={draft.claimMode === 'open'} selected={draft.claimMode === 'open'} onChange={() => set({ claimMode: 'open', followUpId: '' })} title={r('carry.claimOpen')} description={r('carry.claimOpenHint')} />
            <RadioCard variant="row" name="claimMode" checked={draft.claimMode === 'name'} selected={draft.claimMode === 'name'} onChange={() => set({ claimMode: 'name' })} title={r('carry.claimName')} />
          </div>
          {draft.claimMode === 'open' ? (
            <div className="fw-ncr-form">
              <Field label={r('carry.claimKind')}>
                <Select value={draft.claimKind} onChange={(event) => set({ claimKind: event.target.value as CarryDraft['claimKind'] })}>
                  <option value="RETURN">{r('claimKind.RETURN')}</option>
                  <option value="CLAIM">{r('claimKind.CLAIM')}</option>
                </Select>
              </Field>
              <Field label={r('carry.claimReason')} required hint={model.choices.claimReasons.problem ? r('carry.claimReasonsFailed') : undefined}>
                <Select value={draft.claimReason} onChange={(event) => set({ claimReason: event.target.value })}>
                  <option value="">{r('hold.reasonPick')}</option>
                  {(model.choices.claimReasons.items ?? []).map((reason) => (
                    <option key={reason.id} value={reason.code}>
                      {codeLabel(reason, words.locale)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={r('carry.claimRemedy')}>
                <Select value={draft.claimRemedy} onChange={(event) => set({ claimRemedy: event.target.value as CarryDraft['claimRemedy'] })}>
                  <option value="">{r('remedy.none')}</option>
                  <option value="CREDIT">{r('remedy.CREDIT')}</option>
                  <option value="REPLACEMENT">{r('remedy.REPLACEMENT')}</option>
                </Select>
              </Field>
              <Field label={r('col.note')} className="is-wide">
                <Textarea rows={2} value={draft.claimNote} onChange={(event) => set({ claimNote: event.target.value })} />
              </Field>
            </div>
          ) : model.choices.claims.items && model.choices.claims.items.length > 0 ? (
            <Select aria-label={r('carry.claimName')} value={draft.followUpId} onChange={(event) => set({ followUpId: event.target.value })}>
              <option value="">{r('carry.claimPick')}</option>
              {model.choices.claims.items.map((claim) => (
                <option key={claim.id} value={claim.id}>
                  {`${claim.number} · ${r(`claimKind.${claim.kind === 'CLAIM' ? 'CLAIM' : 'RETURN'}`)}`}
                </option>
              ))}
            </Select>
          ) : (
            <p className="fw-q-hint">{model.choices.claims.problem ? r('carry.claimsFailed') : model.choices.claims.items === null ? r('choices.reading') : r('carry.claimsNone')}</p>
          )}
          <p className="fw-q-hint">{r('carry.claimDraft')}</p>
        </section>
      )}
      <Field label={r('col.note')}>
        <Textarea rows={2} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
    </Frame>
  )
}

function Rework({ model, record, words, actions, dialog }: Props<'rework'>) {
  const { r, amount } = words
  const decision = record.decisions.find((entry) => entry.id === dialog.decisionId)
  const operations = model.choices.operations
  const held = !dialog.operationId ? r('rework.heldOperation') : null
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={r('rework.title')} submit={r('rework.submit')} held={held}>
      <p className="fw-q-hint">{r('rework.body', { quantity: decision ? amount(decision.quantity, record.ncr.uom) : '—', number: record.ncr.workOrder?.number ?? '—' })}</p>
      <Field label={r('rework.operation')} required hint={operations.problem ? r('rework.operationsFailed') : operations.items === null ? r('choices.reading') : undefined}>
        <Select value={dialog.operationId} onChange={(event) => actions?.onDialog?.({ ...dialog, operationId: event.target.value })}>
          <option value="">{r('rework.operationPick')}</option>
          {(operations.items ?? []).map((operation) => (
            <option key={operation.id} value={operation.id}>
              {`${operation.seq} · ${operation.code} · ${operation.name}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={r('rework.description')}>
        <Textarea rows={2} maxLength={1000} value={dialog.description} onChange={(event) => actions?.onDialog?.({ ...dialog, description: event.target.value })} />
      </Field>
      <p className="fw-q-hint">{r('rework.reinspection')}</p>
    </Frame>
  )
}

function RemoveDecision({ model, record, words, actions, dialog }: Props<'removeDecision'>) {
  const decision = record.decisions.find((entry) => entry.id === dialog.decisionId)
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={words.r('remove.title', { seq: decision?.seq ?? '—' })} submit={words.r('remove.submit')} held={null} danger size="sm">
      <p className="fw-q-hint">{words.r('remove.body', { code: codeLabel(decision?.disposition, words.locale), quantity: decision ? words.amount(decision.quantity, record.ncr.uom) : '—' })}</p>
    </Frame>
  )
}

function LinkRecord({ model, words, actions, dialog }: Props<'link'>) {
  const { r, t } = words
  const held = !dialog.picked ? r('link.heldPick') : null
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={r('link.title')} submit={r('link.submit')} held={held}>
      <Field label={r('link.search')} hint={r('link.searchHint')}>
        <Input type="search" value={dialog.query} onChange={(event) => actions?.onFindLink?.(event.target.value)} />
      </Field>
      {dialog.searching ? (
        <p className="fw-q-loading" role="status">
          <Spinner size={14} /> {r('link.searching')}
        </p>
      ) : dialog.hits === null ? null : dialog.hits.length === 0 ? (
        <p className="fw-q-hint">{r('link.none')}</p>
      ) : (
        <div className="fw-q-stack" role="radiogroup" aria-label={r('link.results')}>
          {dialog.hits.map((hit) => (
            <RadioCard
              key={`${hit.recordType}:${hit.recordId}`}
              name="link"
              checked={dialog.picked?.recordId === hit.recordId}
              selected={dialog.picked?.recordId === hit.recordId}
              onChange={() => actions?.onDialog?.({ ...dialog, picked: hit })}
              title={`${t(`recordType.${hit.recordType}`)} · ${hit.number ?? hit.title}`}
              description={[hit.number ? hit.title : null, hit.subtitle].filter(Boolean).join(' · ') || undefined}
            />
          ))}
        </div>
      )}
      <Field label={r('col.note')}>
        <Input value={dialog.note} maxLength={1000} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} />
      </Field>
    </Frame>
  )
}

function Register({ model, record, words, actions, dialog }: Props<'register'>) {
  return (
    <Frame model={model} words={words} actions={actions} dialog={dialog} title={words.r('register.title')} submit={words.r('register.submit')} held={null}>
      <p className="fw-q-hint">{words.r('register.body', { style: record.ncr.style ? `${record.ncr.style.code} · ${record.ncr.style.name}` : '—' })}</p>
      <Field label={words.r('register.description')}>
        <Textarea rows={3} maxLength={2000} value={dialog.description} onChange={(event) => actions?.onDialog?.({ ...dialog, description: event.target.value })} />
      </Field>
    </Frame>
  )
}

