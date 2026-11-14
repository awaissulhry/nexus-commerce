'use client'

import { useState } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select } from '@nexus/ui/primitives'
import { Modal, StepUpModal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { moneyText } from '../../../model'
import { approveHeld, CS_NS, removeHeld, sendHeld, takeBackHeld, type Phrase } from '../model'
import { newVersionDraft, newVersionProblems, reasonProblem, type NewVersionDraft, type VersionsActions, type VersionsModel } from '../screen'

/**
 * The dialogs of the Cost tab's versions (B-W2b-430): New version (from the components of the revision in view, or a copy of
 * a version), Send for approval, Approve and lock (the engine's yes, with the version's facts), Take back (with a reason),
 * Delete the draft, and the fresh code an approval rule may ask. Esc closes each (the DS Modal) and focus returns to the
 * opener. A refused write is said in the dialog, the typed values kept.
 */
export function VersionDialogs({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const dialog = model.dialog
  return (
    <>
      {dialog?.kind === 'new' && <NewVersionDialog key={dialog.from === 'COPY' ? dialog.basedOnId : 'components'} model={model} actions={actions} from={dialog.from} basedOnId={dialog.from === 'COPY' ? dialog.basedOnId : null} />}
      {dialog?.kind === 'send' && <SendDialog model={model} actions={actions} />}
      {dialog?.kind === 'approve' && <ApproveDialog model={model} actions={actions} />}
      {dialog?.kind === 'takeBack' && <TakeBackDialog model={model} actions={actions} />}
      {dialog?.kind === 'remove' && <RemoveDialog model={model} actions={actions} />}
      <StepUpModal
        open={model.stepUp.open}
        title={t('verStepUp.title')}
        sentence={t('verStepUp.sentence')}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('verStepUp.confirm')}
      />
    </>
  )
}

function Problem({ problem }: { problem: Phrase | null }) {
  const t = useT(CS_NS)
  return problem ? <Banner tone="danger" title={t(problem.key, problem.params)} /> : null
}

function NewVersionDialog({ model, actions, from, basedOnId }: { model: VersionsModel; actions?: VersionsActions; from: 'COMPONENTS' | 'COPY'; basedOnId: string | null }) {
  const t = useT(CS_NS)
  const copied = basedOnId && model.list.status === 'ready' ? model.list.value.versions.find((row) => row.id === basedOnId) : undefined
  // A new version starts in the series of the version in view (its season, while open): a new season or none is picked on purpose.
  const season = model.inView?.season?.status === 'OPEN' ? model.inView.season.id : ''
  const [draft, setDraft] = useState<NewVersionDraft>(() => newVersionDraft(from, basedOnId, copied?.baseSize ?? model.baseSize, { seasonId: season, ...model.draft }))
  const set = <K extends keyof NewVersionDraft>(key: K, value: NewVersionDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const problems = newVersionProblems(draft)
  const first = Object.values(problems)[0]
  const held = model.busy ? t('verHeld.busy') : first ? t(first) : from === 'COMPONENTS' && !model.revision ? t('verHeld.noRevision') : null
  const close = () => actions?.onDialog?.(null)
  const title = from === 'COPY' && copied ? t('verNew.copyTitle', { version: copied.sheetVersion }) : t('verNew.title', { revision: model.revision?.revision ?? '—' })
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={title}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onCreate?.(draft)}>
            {model.busy ? t('csCommon.working') : t('verNew.make')}
          </Button>
        </>
      }
    >
      <div className="fw-st-form">
        <p className="fw-st-hint">{from === 'COPY' ? t('verNew.copyIntro') : t('verNew.intro')}</p>
        {from === 'COMPONENTS' && (
          <div className="fw-st-form-grid">
            <Field label={t('verNew.season')} hint={model.seasons.status === 'error' ? t(model.seasons.problem) : t('verNew.seasonHint')}>
              <Select value={draft.seasonId} onChange={(event) => set('seasonId', event.target.value)}>
                <option value="">{t('ver.noSeason')}</option>
                {model.seasons.status === 'ready' &&
                  model.seasons.value.map((season) => (
                    <option key={season.id} value={season.id}>
                      {season.code} · {season.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('verNew.baseSize')} hint={t('verNew.baseSizeHint')}>
              <Select value={draft.baseSize} onChange={(event) => set('baseSize', event.target.value)}>
                {model.sizes.map((size) => (
                  <option key={size} value={size}>
                    {size === model.baseSize ? t('steps.baseSizeOption', { size }) : size}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('steps.carton')} hint={t('steps.cartonHint')} error={problems.piecesPerCarton ? t(problems.piecesPerCarton) : undefined}>
              <Input inputMode="numeric" value={draft.piecesPerCarton} onChange={(event) => set('piecesPerCarton', event.target.value)} />
            </Field>
          </div>
        )}
        {(model.grains.price || model.grains.margin) && (
          <div className="fw-st-form-grid">
            {model.grains.price && (
              <Field label={t('verNew.targetPrice')} hint={t('verNew.targetPriceHint')} error={problems.targetPrice ? t(problems.targetPrice) : undefined}>
                <Input inputMode="decimal" value={draft.targetPrice} onChange={(event) => set('targetPrice', event.target.value)} />
              </Field>
            )}
            {model.grains.margin && (
              <Field label={t('verNew.targetMargin')} hint={t('verNew.targetMarginHint')} error={problems.targetMarginPct ? t(problems.targetMarginPct) : undefined}>
                <Input inputMode="decimal" value={draft.targetMarginPct} onChange={(event) => set('targetMarginPct', event.target.value)} />
              </Field>
            )}
          </div>
        )}
        <Field label={t('verNew.note')} error={problems.note ? t(problems.note) : undefined}>
          <Textarea rows={2} maxLength={2000} value={draft.note} onChange={(event) => set('note', event.target.value)} />
        </Field>
        {from === 'COMPONENTS' && (
          <Checkbox checked={draft.leaveOutMissing} onChange={(event) => set('leaveOutMissing', event.target.checked)} label={t('verNew.leaveOut')} />
        )}
        {from === 'COMPONENTS' && draft.leaveOutMissing && <p className="fw-st-hint">{t('verNew.leaveOutHint')}</p>}
        <Problem problem={model.problem} />
      </div>
    </Modal>
  )
}

function SendDialog({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const [note, setNote] = useState(model.draft?.note ?? '')
  const [covered, setCovered] = useState(false)
  const row = model.inView
  const record = model.record.status === 'ready' ? model.record.value : null
  const leftOut = record?.leftOut.length ?? 0
  const held = sendHeld(model.can, row, record, model.busy)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('verSend.title', { version: row?.sheetVersion ?? '—' })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held.key, held.params) : leftOut > 0 && !covered ? t('verSend.leftOutHeld', { count: leftOut }) : null} onClick={() => actions?.onSend?.({ note: note.trim(), coveredByTyped: covered })}>
            {model.busy ? t('csCommon.working') : t('verSend.send')}
          </Button>
        </>
      }
    >
      <div className="fw-st-form">
        <p className="fw-st-hint">{t('verSend.intro')}</p>
        {leftOut > 0 && (
          <>
            <Banner tone="warning" title={t('verSend.leftOut', { count: leftOut })} />
            <Checkbox checked={covered} onChange={(event) => setCovered(event.target.checked)} label={t('verSend.covered')} />
          </>
        )}
        <Field label={t('verSend.note')} hint={t('verSend.noteHint')}>
          <Textarea rows={3} maxLength={4000} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <Problem problem={model.problem} />
      </div>
    </Modal>
  )
}

function ApproveDialog({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const [comment, setComment] = useState(model.draft?.note ?? '')
  const row = model.inView
  const held = approveHeld(model.can, row, model.task, model.busy)
  const close = () => actions?.onDialog?.(null)
  const money = (value: string | null | undefined, grain: boolean) => (grain && row && value !== undefined && value !== null ? moneyText(value, row.currency, locale) : null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('verApprove.title', { version: row?.sheetVersion ?? '—' })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onApprove?.(comment)}>
            {model.busy ? t('csCommon.working') : t('verApprove.approve')}
          </Button>
        </>
      }
    >
      <div className="fw-st-form">
        <p className="fw-st-hint">{t('verApprove.intro')}</p>
        {row && (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('verView.revision'), value: t('ver.rev', { revision: row.revision.revision }) },
              { label: t('verView.season'), value: row.season?.code ?? t('ver.noSeason') },
              ...(model.grains.cost ? [{ label: t('verView.base', { size: row.baseSize }), value: money(row.baseCost, true) ?? t('ver.notKnown') }, { label: t('verView.weighted'), value: money(row.weightedCost, true) ?? t('ver.notKnown') }] : []),
              ...(model.grains.price ? [{ label: t('verView.target'), value: money(row.targetPrice, true) ?? t('verView.noTarget') }] : []),
            ]}
          />
        )}
        <p className="fw-st-hint">{t('verApprove.after')}</p>
        <Field label={t('verApprove.comment')}>
          <Textarea rows={2} maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value)} />
        </Field>
        <Problem problem={model.problem} />
      </div>
    </Modal>
  )
}

function TakeBackDialog({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const row = model.inView
  const held = takeBackHeld(model.can, row, model.busy)
  const problem = reasonProblem(reason)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('verBack.title', { version: row?.sheetVersion ?? '—' })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held.key, held.params) : problem ? t(problem) : null} onClick={() => actions?.onTakeBack?.(reason.trim())}>
            {model.busy ? t('csCommon.working') : t('verBack.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-st-form">
        <p className="fw-st-hint">{t('verBack.intro')}</p>
        <Field label={t('verBack.reason')} hint={t('verBack.reasonHint')} error={reason.trim() !== '' && problem ? t(problem) : undefined}>
          <Textarea rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <Problem problem={model.problem} />
      </div>
    </Modal>
  )
}

function RemoveDialog({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const row = model.inView
  const record = model.record.status === 'ready' ? model.record.value : null
  const held = removeHeld(model.can, row, record, model.busy)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('verRemove.title', { version: row?.sheetVersion ?? '—' })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onRemove?.()}>
            {model.busy ? t('csCommon.working') : t('verRemove.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-st-form">
        <p className="fw-st-hint">{row?.approval?.status === 'PENDING' ? t('verRemove.introWaiting') : t('verRemove.intro')}</p>
        <Problem problem={model.problem} />
      </div>
    </Modal>
  )
}
