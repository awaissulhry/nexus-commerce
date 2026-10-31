'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Pencil, Send, ShieldCheck } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, Stepper, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Checkbox, Input, SegmentedControl, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { Freshness, RecordFrame, Section, StepUpDialog } from '../../../../quality/_shared/parts'
import { POINT_RESULTS, REPAIR_KINDS, type PointResult, type Repair, type RepairAction, type RepairKind } from '../../api'
import { CHECK_POINTS, checklistProblems, checklistResult, ownerName, repairHref, repairStep, returnHref, type CheckPoint, type Words } from '../../model'
import type { IntakeDraft, RepairActions, RepairModel, RepairTab } from '../../view-model'
import { DayText, GateChecklist, InstantText, RepairStagePill, ReturnsMessages, SafetyTag, say, useDayWords, useWords } from '../../view/parts'
import { RepairDialogs } from './RepairDialogs'

/**
 * A repair or alteration's record (SCR-112, design sales.returns › Repair order, `?tab=intake|work|safety|return|activity`):
 * the band (‹ Returns & repairs, the repair number, the customer and the garment, the stage; the next step by stage and ⋯
 * Cancel, Copy number), then the tabs: Intake & photos (what came in and in what state: the serial's garment, the
 * customer's DDT, the customer's words, photos, the serial's other repairs; edited with the EditModeBar), Work (the stages
 * as a stepper and their history, the repair work order, the moves held with their reason), Safety check (a protective
 * garment goes back only after a check that it still protects: the GateChecklist, signed with a fresh code), Return (the
 * way back on its own DDT, reason repair) and Activity. No money (the estimate with prices is W2b). Fetches nothing.
 */
export function RepairRecordView({ model, actions, panels }: { model: RepairModel; actions?: RepairActions; panels?: ReactNode }) {
  return (
    <ReturnsMessages>
      <RepairRecord model={model} actions={actions} panels={panels} />
    </ReturnsMessages>
  )
}

const NEXT_BY_STAGE: Partial<Record<Repair['stage'], RepairAction>> = {
  AWAITING_GOODS: 'receive',
  RECEIVED: 'estimate',
  ESTIMATED: 'approve',
  APPROVED: 'startRepair',
  IN_REPAIR: 'finishRepair',
  REPAIRED: 'ship',
}

function RepairRecord({ model, actions, panels }: { model: RepairModel; actions?: RepairActions; panels?: ReactNode }) {
  const t = useWords()
  const { repair, prefix, can } = model
  const tab: RepairTab = model.tab === 'activity' && !panels ? 'intake' : model.tab
  const base = repairHref(prefix, repair.id)
  const held = (action: RepairAction): string | null => {
    const words = repairStep(action, repair, can, model.offline)
    return words ? say(t, words) : null
  }
  const run = (action: RepairAction) => {
    if (action === 'receive') actions?.onDialog?.({ kind: 'receive', ddtNumber: repair.inboundDdt?.number ?? '', ddtDate: repair.inboundDdt?.date ?? '', note: '' })
    else if (action === 'estimate' || action === 'approve' || action === 'startRepair' || action === 'finishRepair' || action === 'reopenRepair') actions?.onDialog?.({ kind: 'move', action, note: '' })
    else if (action === 'makeWorkOrder') actions?.onDialog?.({ kind: 'workOrder', options: null, problem: null, seqs: [] })
    else if (action === 'ship') actions?.onDialog?.({ kind: 'ship', draft: { transportBy: 'CARRIER', carrier: '', packages: '1', weight: '', appearance: '', freight: '', remarks: '' }, note: '', preview: null, previewing: false, useLive: repair.ddts.some((ddt) => ddt.live) })
    else if (action === 'cancel') actions?.onDialog?.({ kind: 'cancel', reason: '' })
  }
  const next = NEXT_BY_STAGE[repair.stage] ?? null
  const garment = [repair.garment.style?.code, repair.garment.colourway?.name, repair.garment.size].filter(Boolean).join(' · ')
  const menuItem = (action: RepairAction, label: string): MenuItemDef => {
    const reason = held(action)
    return { id: action, label, onSelect: () => run(action), disabled: !!reason, description: reason ?? undefined }
  }
  const moreItems: MenuItemDef[] = [
    menuItem('cancel', t('repair.cancel')),
    { id: 'sep', separator: true } as MenuItemDef,
    { id: 'number', label: t('row.copy'), onSelect: () => actions?.onCopy?.(repair.number) },
    { id: 'link', label: t('record.copyLink'), onSelect: () => actions?.onCopy?.(typeof window === 'undefined' ? base : `${window.location.origin}${base}`) },
  ]
  const tabs = [
    { id: 'intake', label: t('tab.intake') },
    { id: 'work', label: t('tab.work') },
    { id: 'safety', label: t('tab.safety') },
    { id: 'return', label: t('tab.return') },
    ...(panels ? [{ id: 'activity', label: t('tab.activity') }] : []),
  ]

  return (
    <>
      <RecordFrame
        back={{ href: `${prefix}/sales/returns`, label: t('record.back') }}
        title={
          <>
            <span className="fw-q-code">{repair.number}</span> · {t(`kind.${repair.kind}`)}
          </>
        }
        meta={
          <span className="fw-q-cell-row">
            <span>{repair.party.legalName}</span>
            {garment && <span className="fw-q-hint fw-q-code">{garment}</span>}
            <Freshness asOf={model.asOf} live={model.live} />
          </span>
        }
        status={
          <span className="fw-q-cell-row">
            {repair.safety.required && <SafetyTag state={repair.safety.state} />}
            <RepairStagePill stage={repair.stage} />
          </span>
        }
        actions={
          <>
            {next && (
              <Button size="sm" variant="primary" heldReason={held(next)} onClick={() => run(next)}>
                {t(`repair.action.${next}`)}
              </Button>
            )}
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={moreItems} />
          </>
        }
        tabs={tabs}
        active={tab}
        tabHref={(id) => `${base}?tab=${id}`}
        dock={panels}
        dockOpen={model.dockOpen}
        onDock={() => actions?.onDock?.()}
      >
        <div className="fw-q-stack">
          {model.offline && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
          {model.changedAt && (
            <Banner
              tone="info"
              title={t('record.changed')}
              action={
                <Button size="sm" onClick={() => actions?.onReload?.()}>
                  {t('record.reload')}
                </Button>
              }
            />
          )}
          {model.receipt && (
            <Banner
              tone={model.receipt.tone}
              title={say(t, model.receipt.words)}
              action={
                <span className="fw-q-actions">
                  {model.receipt.href && (
                    <Link className="fw-q-link" href={model.receipt.href}>
                      {t('record.openIt')}
                    </Link>
                  )}
                  <Button size="sm" variant="quiet" onClick={() => actions?.onDismissReceipt?.()}>
                    {t('quality:common.dismiss')}
                  </Button>
                </span>
              }
            />
          )}
          {repair.stage === 'CANCELLED' && <Banner tone="info" title={t('repair.cancelled')}>{repair.cancelReason ?? null}</Banner>}
          {tab === 'intake' && <IntakeTab model={model} actions={actions} held={held} run={run} />}
          {tab === 'work' && <WorkTab model={model} held={held} run={run} />}
          {tab === 'safety' && <SafetyTab model={model} actions={actions} />}
          {tab === 'return' && <ReturnTab model={model} held={held} run={run} />}
          {tab === 'activity' && panels}
        </div>
      </RecordFrame>
      <RepairDialogs model={model} actions={actions} />
      <StepUpDialog state={model.stepUp} onSubmit={(code) => actions?.onStepUpSubmit?.(code)} onCancel={() => actions?.onStepUpCancel?.()} confirmLabel={t('safety.sign')} />
    </>
  )
}

// ---- Intake & photos ------------------------------------------------------------------------------------------------------

function IntakeTab({ model, actions, held, run }: { model: RepairModel; actions?: RepairActions; held: (action: RepairAction) => string | null; run: (action: RepairAction) => void }) {
  const t = useWords()
  const dayWords = useDayWords()
  const { repair, prefix, can } = model
  const ids = { kind: useId(), problem: useId(), ddt: useId(), ddtDate: useId(), note: useId(), photos: useId() }
  const edit = model.edit
  const editHeld = held('edit')
  const found = repair.garment.found
  const owner = ownerName(repair.people, repair.ownerId, model.me)
  const set = (patch: Partial<IntakeDraft>) => actions?.onEditDraft?.(patch)
  return (
    <div className="fw-q-two">
      <Section
        title={t('intake.title')}
        sub={t('intake.sub')}
        actions={
          !edit ? (
            <span className="fw-q-actions">
              {repair.stage === 'AWAITING_GOODS' && (
                <Button size="sm" heldReason={held('receive')} onClick={() => run('receive')}>
                  {t('repair.action.receive')}
                </Button>
              )}
              <Button size="sm" heldReason={editHeld} onClick={() => actions?.onEdit?.()}>
                <Pencil size={14} aria-hidden /> {t('intake.edit')}
              </Button>
            </span>
          ) : undefined
        }
      >
        {edit ? (
          <div className="fw-q-stack">
            {edit.problem && <Banner tone="danger" title={say(t, edit.problem)} />}
            <Field label={t('newRepair.kind')} htmlFor={ids.kind}>
              <Select id={ids.kind} value={edit.draft.kind} onChange={(event) => set({ kind: event.target.value as RepairKind })}>
                {REPAIR_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`kind.${kind}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('newRepair.problemLabel')} required htmlFor={ids.problem}>
              <Textarea id={ids.problem} rows={3} value={edit.draft.problem} onChange={(event) => set({ problem: event.target.value })} />
            </Field>
            <div className="fw-q-form-two">
              <Field label={t('newRepair.ddt')} htmlFor={ids.ddt}>
                <Input id={ids.ddt} value={edit.draft.inboundDdtNumber} onChange={(event) => set({ inboundDdtNumber: event.target.value })} />
              </Field>
              <Field label={t('newRepair.ddtDate')} hint={t('intake.dateHint')} htmlFor={ids.ddtDate}>
                <Input id={ids.ddtDate} type="date" value={edit.draft.inboundDdtDate} max={model.today} onChange={(event) => set({ inboundDdtDate: event.target.value })} />
              </Field>
            </div>
            <Field label={t('newReturn.note')} hint={t('newReturn.noteHint')} htmlFor={ids.note}>
              <Textarea id={ids.note} rows={2} value={edit.draft.internalNote} onChange={(event) => set({ internalNote: event.target.value })} />
            </Field>
            <EditBar busy={edit.busy} onSave={() => actions?.onEditSave?.()} onDiscard={() => actions?.onEditCancel?.()} />
          </div>
        ) : (
          <div className="fw-q-stack">
            {editHeld && !can.repairsManage && <p className="fw-q-hint">{t('intake.viewOnly')}</p>}
            <KeyValue
              columns={2}
              items={[
                { label: t('intake.serial'), value: repair.garment.serial ?? '—' },
                { label: t('intake.garment'), value: [repair.garment.style ? `${repair.garment.style.code} · ${repair.garment.style.name}` : null, repair.garment.colourway?.name, repair.garment.size].filter(Boolean).join(' · ') || t('intake.unknownStyle') },
                { label: t('intake.made'), value: found ? t('newRepair.garmentFacts', { day: dayWords(found.madeOn), workOrder: found.workOrderNumber, batch: found.batchNumber ?? '—' }) : t('intake.notOurs') },
                { label: t('intake.received'), value: repair.receivedAt ? <InstantText value={repair.receivedAt} /> : t('stage.AWAITING_GOODS') },
                { label: t('intake.ddt'), value: repair.inboundDdt ? t('intake.ddtValue', { number: repair.inboundDdt.number, date: repair.inboundDdt.date ? dayWords(repair.inboundDdt.date) : '—' }) : repair.receivedAt ? t('intake.noDdt') : '—' },
                { label: t('intake.source'), value: repair.source.returnLine ? <Link className="fw-q-link fw-q-code" href={returnHref(prefix, repair.source.returnLine.returnId, '?tab=inspection')}>{t('intake.fromLine', { number: repair.source.returnLine.returnNumber, seq: repair.source.returnLine.seq })}</Link> : repair.source.complaint ? <Link className="fw-q-link fw-q-code" href={`${prefix}/quality/complaints/${encodeURIComponent(repair.source.complaint.id)}`}>{repair.source.complaint.number}</Link> : t('source.HAND') },
                { label: t('intake.site'), value: `${repair.site.code} · ${repair.site.name}` },
                { label: t('fact.owner'), value: owner ? ('key' in owner ? t(owner.key) : owner.name) : '—' },
              ]}
            />
            <div>
              <h3 className="fw-q-hint">{t('intake.words')}</h3>
              <p>{repair.problem}</p>
            </div>
            {repair.safety.required && !repair.garment.style && <Banner tone="warning" title={t('intake.unknownStyleSafety')} />}
          </div>
        )}
      </Section>
      <div className="fw-q-stack">
        <Section title={t('intake.photos')} sub={t('intake.photosSub')}>
          <div className="fw-q-stack">
            {model.photos.length === 0 ? (
              <p className="fw-q-hint">{can.filesRead ? t('intake.noPhotos') : t('held.right.filesRead')}</p>
            ) : (
              <div className="fw-rr-photos">
                {model.photos.map((photo) => (photo.src ? <img key={photo.id} className="fw-rr-photo" src={photo.src} alt={photo.name} /> : <span key={photo.id} className="fw-rr-photo" role="img" aria-label={photo.name} />))}
              </div>
            )}
            <Field label={t('intake.addPhotos')} hint={can.filesUpload ? t('intake.photosHint') : t('held.right.filesUpload')} htmlFor={ids.photos}>
              <Input id={ids.photos} type="file" accept="image/jpeg,image/png,image/webp,image/heic" multiple disabled={!can.filesUpload || model.uploading || model.offline} onChange={(event) => actions?.onPhotos?.(Array.from(event.target.files ?? []))} />
            </Field>
            {model.uploading && (
              <p className="fw-q-loading" role="status">
                <Spinner size={12} /> {t('intake.uploading')}
              </p>
            )}
            <p className="fw-q-hint">{t('intake.markupLater')}</p>
          </div>
        </Section>
        <Section title={t('intake.history')} sub={t('intake.historySub')}>
          {repair.history.length === 0 ? (
            <p className="fw-q-hint">{t('intake.noHistory')}</p>
          ) : (
            <SummaryTable
              label={t('intake.history')}
              columns={[t('col.number'), t('col.status'), t('intake.when'), t('intake.words')]}
              rows={repair.history.map((other) => ({
                id: other.id,
                cells: [
                  <Link key="n" className="fw-q-link fw-q-code" href={repairHref(prefix, other.id)}>
                    {other.number}
                  </Link>,
                  t(`stagePill.${other.stage}`),
                  <DayText key="d" value={other.createdAt} />,
                  other.problem,
                ],
              }))}
              stackOnPhone
            />
          )}
        </Section>
      </div>
    </div>
  )
}

/**
 * The edit bar of the intake card (design "explicit: EditModeBar"): composed from DS buttons because the DS EditModeBar
 * speaks English only ("Discard", "Unsaved changes"); ⌘S saves.
 */
function EditBar({ busy, onSave, onDiscard }: { busy: boolean; onSave: () => void; onDiscard: () => void }) {
  const t = useWords()
  const latest = useRef({ onSave, busy })
  latest.current = { onSave, busy }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!latest.current.busy) latest.current.onSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="nds-actionbar" role="region" aria-label={t('intake.editBar')}>
      <span className="lbl">{t('intake.unsaved')}</span>
      <span className="grow" />
      <span className="acts">
        <Button onClick={onDiscard} disabled={busy}>
          {t('intake.discard')}
        </Button>
        <Button variant="primary" heldReason={busy ? t('quality:common.working') : null} onClick={onSave} aria-keyshortcuts="Meta+S">
          {busy ? <Spinner size={12} /> : null} {t('intake.save')}
        </Button>
      </span>
    </div>
  )
}

// ---- Work ----------------------------------------------------------------------------------------------------------------

function WorkTab({ model, held, run }: { model: RepairModel; held: (action: RepairAction) => string | null; run: (action: RepairAction) => void }) {
  const t = useWords()
  const { repair, prefix } = model
  const current = repair.steps.findIndex((step) => step.state === 'CURRENT')
  const doneCount = repair.steps.filter((step) => step.state === 'DONE').length
  const actionButton = (action: RepairAction, primary = false) => (
    <Button key={action} size="sm" variant={primary ? 'primary' : 'secondary'} heldReason={held(action)} onClick={() => run(action)}>
      {t(`repair.action.${action}`)}
    </Button>
  )
  const person = (id: string | null) => (id ? (repair.people.find((entry) => entry.id === id)?.name ?? (id === model.me ? t('row.you') : '—')) : t('stage.system'))
  return (
    <div className="fw-q-stack">
      <Card padded>
        <Stepper
          steps={repair.steps.map((step) => ({ key: step.stage, label: <span className="fw-q-cell"><span>{t(`step.${step.stage}`)}</span><span className="fw-q-hint">{step.at ? <DayText value={step.at} /> : t(`track.word.${step.state}`)}</span></span> }))}
          current={current >= 0 ? current : repair.stage === 'SHIPPED' ? repair.steps.length : doneCount}
        />
      </Card>
      <div className="fw-q-two">
        <Section title={t('work.moves')} sub={t('work.movesSub')}>
          <div className="fw-q-actions">
            {(['estimate', 'approve', 'startRepair', 'finishRepair', 'reopenRepair'] as const).map((action) => actionButton(action))}
          </div>
          <p className="fw-q-hint">{t('work.estimateLater')}</p>
        </Section>
        {/* B-W2b-16: back into repair after it was repaired, the rework gets its own work order once the last one is done. */}
        <Section title={t('work.workOrder')} sub={t('work.workOrderSub')} actions={!repair.workOrder || repair.workOrder.status === 'CANCELLED' || repair.reworkRound ? actionButton('makeWorkOrder') : undefined}>
          {repair.workOrder ? (
            <p>
              <Link className="fw-q-link fw-q-code" href={`${prefix}/production/work-orders/${encodeURIComponent(repair.workOrder.id)}`}>
                {repair.workOrder.number}
              </Link>{' '}
              <span className="fw-q-hint">{t(`woStatus.${repair.workOrder.status}`)}</span>
            </p>
          ) : (
            <p className="fw-q-hint">{t('work.noWorkOrder')}</p>
          )}
          {repair.reworkRound && repair.workOrder && ['COMPLETED', 'CLOSED'].includes(repair.workOrder.status) && <p className="fw-q-hint">{t('work.rework')}</p>}
          {repair.earlierWorkOrders.length > 0 && (
            <>
              <p className="fw-q-hint">{t('work.earlier')}</p>
              <ul className="fw-q-lines">
                {repair.earlierWorkOrders.map((order) => (
                  <li key={order.id}>
                    <Link className="fw-q-link fw-q-code" href={`${prefix}/production/work-orders/${encodeURIComponent(order.id)}`}>
                      {order.number}
                    </Link>{' '}
                    <span className="fw-q-hint">{t(`woStatus.${order.status}`)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>
      <Section title={t('work.history')}>
        <SummaryTable
          label={t('work.history')}
          columns={[t('work.col.move'), t('work.col.when'), t('work.col.by'), t('work.col.note')]}
          rows={repair.stages.map((stage) => ({
            id: stage.id,
            cells: [stage.from ? t('work.from', { from: t(`stagePill.${stage.from}`), to: t(`stagePill.${stage.to}`) }) : t(`stagePill.${stage.to}`), <InstantText key="w" value={stage.at} />, person(stage.byId), stage.note ?? '—'],
          }))}
          stackOnPhone
        />
      </Section>
      {repair.ncrs.length > 0 && (
        <Section title={t('work.ncrs')}>
          <ul className="fw-q-lines">
            {repair.ncrs.map((ncr) => (
              <li key={ncr.id}>
                <Link className="fw-q-link fw-q-code" href={`${prefix}/quality/ncr/${encodeURIComponent(ncr.id)}`}>
                  {ncr.number}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

// ---- Safety check ----------------------------------------------------------------------------------------------------------

const POINT_HINT: Readonly<Record<CheckPoint, string>> = { seams: 'safety.hint.seams', abrasionZones: 'safety.hint.abrasionZones', closures: 'safety.hint.closures', protectors: 'safety.hint.protectors' }

function SafetyTab({ model, actions }: { model: RepairModel; actions?: RepairActions }) {
  const t = useWords()
  const { repair } = model
  const ids = { lot: useId(), level: useId(), note: useId() }
  const signHeld = repairStep('safetyCheck', repair, model.can, model.offline)
  const draft = model.checklist
  const problems = checklistProblems(draft)
  const result = checklistResult(draft)
  const last = repair.safety
  const checker = last.checkedById ? (repair.people.find((entry) => entry.id === last.checkedById)?.name ?? (last.checkedById === model.me ? t('row.you') : '—')) : '—'

  if (!last.required)
    return (
      <Card padded>
        <EmptyState icon={<ShieldCheck size={24} aria-hidden />} title={t('safety.notRequired')} description={t('safety.notRequiredBody')} />
      </Card>
    )
  const choice = (point: CheckPoint) => {
    const options = (point === 'seams' ? POINT_RESULTS.filter((value) => value !== 'NOT_APPLICABLE') : POINT_RESULTS).map((value) => ({ value, label: t(`safety.result.${value}`) }))
    return signHeld ? (
      <span>{draft[point] ? t(`safety.result.${draft[point]}`) : '—'}</span>
    ) : (
      <SegmentedControl ariaLabel={t(`safety.point.${point}`)} size="sm" value={draft[point]} onChange={(value) => actions?.onChecklist?.({ [point]: value as PointResult })} options={options} />
    )
  }
  const sign: Words | null = signHeld ?? (model.checkBusy ? { key: 'quality:common.working' } : model.showCheckProblems && problems[0] ? problems[0] : null)
  return (
    <div className="fw-q-two">
      <Section title={t('safety.title')} sub={t('safety.sub')}>
        <div className="fw-q-stack">
          {last.state !== 'NOT_CHECKED' && (
            <Banner tone={last.state === 'PASSED' ? 'success' : last.state === 'FAILED' ? 'danger' : 'warning'} title={t(`safety.last.${last.state}`, { by: checker })}>
              {last.checkedAt ? <InstantText value={last.checkedAt} /> : null}
              {last.failures.length > 0 ? ` · ${t('safety.failedPoints', { count: last.failures.length })}` : ''}
            </Banner>
          )}
          {signHeld && <p className="fw-q-hint">{say(t, signHeld)}</p>}
          <GateChecklist
            label={t('safety.points')}
            points={CHECK_POINTS.map((point) => ({ id: point, label: t(`safety.point.${point}`), hint: t(POINT_HINT[point]), control: choice(point), state: draft[point] === '' ? 'OPEN' : (draft[point] as 'PASS' | 'FAIL' | 'NOT_APPLICABLE') }))}
          />
          <Checkbox checked={draft.replaced} disabled={!!signHeld} onChange={(event) => actions?.onChecklist?.({ replaced: event.target.checked })} label={t('safety.replaced')} />
          {draft.replaced && (
            <div className="fw-q-form-two">
              <Field label={t('safety.lot')} required error={model.showCheckProblems && !draft.lot.trim() ? t('safety.problem.lot') : undefined} htmlFor={ids.lot}>
                <Input id={ids.lot} value={draft.lot} disabled={!!signHeld} onChange={(event) => actions?.onChecklist?.({ lot: event.target.value })} />
              </Field>
              <Field label={t('safety.level')} required error={model.showCheckProblems && !draft.level ? t('safety.problem.level') : undefined} htmlFor={ids.level}>
                <Select id={ids.level} value={draft.level} disabled={!!signHeld} onChange={(event) => actions?.onChecklist?.({ level: event.target.value as '' | '1' | '2' })}>
                  <option value="">{t('safety.pickLevel')}</option>
                  <option value="1">{t('safety.levelN', { level: 1 })}</option>
                  <option value="2">{t('safety.levelN', { level: 2 })}</option>
                </Select>
              </Field>
            </div>
          )}
          <Field label={t('safety.certificate')} hint={t('safety.certificateHint')}>
            {signHeld ? (
              <span>{draft.certificateCovers === null ? '—' : t(draft.certificateCovers ? 'safety.yes' : 'safety.no')}</span>
            ) : (
              <SegmentedControl
                ariaLabel={t('safety.certificate')}
                size="sm"
                value={draft.certificateCovers === null ? '' : draft.certificateCovers ? 'yes' : 'no'}
                onChange={(value) => actions?.onChecklist?.({ certificateCovers: value === 'yes' })}
                options={[
                  { value: 'yes', label: t('safety.yes') },
                  { value: 'no', label: t('safety.no') },
                ]}
              />
            )}
          </Field>
          <Field label={t('safety.note')} htmlFor={ids.note}>
            <Textarea id={ids.note} rows={2} value={draft.note} disabled={!!signHeld} onChange={(event) => actions?.onChecklist?.({ note: event.target.value })} />
          </Field>
        </div>
      </Section>
      <Section title={t('safety.signTitle')} sub={t('safety.signSub')}>
        <div className="fw-q-stack">
          {model.checkProblem && <Banner tone="danger" title={say(t, model.checkProblem)} />}
          <p>{problems.length === 0 ? t(result === 'PASS' ? 'safety.willPass' : 'safety.willFail') : t('safety.answerAll', { count: problems.length })}</p>
          <p className="fw-q-hint">{t('safety.signAs')}</p>
          <span className="fw-q-actions">
            <Button variant="primary" heldReason={sign ? say(t, sign) : null} onClick={() => actions?.onSign?.()}>
              {model.checkBusy ? <Spinner size={12} /> : <ShieldCheck size={14} aria-hidden />} {t('safety.sign')}
            </Button>
          </span>
          <p className="fw-q-hint">{t('safety.floorLater')}</p>
        </div>
      </Section>
    </div>
  )
}

// ---- Return to the customer ------------------------------------------------------------------------------------------------

function ReturnTab({ model, held, run }: { model: RepairModel; held: (action: RepairAction) => string | null; run: (action: RepairAction) => void }) {
  const t = useWords()
  const { repair } = model
  const live = repair.ddts.find((ddt) => ddt.live) ?? null
  return (
    <div className="fw-q-two">
      <Section
        title={t('return.title')}
        sub={t('return.sub')}
        actions={
          repair.stage !== 'SHIPPED' && repair.stage !== 'CANCELLED' ? (
            <Button size="sm" variant="primary" heldReason={held('ship')} onClick={() => run('ship')}>
              <Send size={14} aria-hidden /> {t('repair.action.ship')}
            </Button>
          ) : undefined
        }
      >
        <KeyValue
          columns={3}
          items={[
            { label: t('return.shipped'), value: repair.shippedAt ? <InstantText value={repair.shippedAt} /> : '—' },
            { label: t('return.ddt'), value: live ? t('return.ddtValue', { number: live.number, reason: t(`ddtReason.${live.reason}`) }) : t('return.noDdt') },
            { label: t('return.repaired'), value: repair.repairedAt ? <InstantText value={repair.repairedAt} /> : t('return.notRepaired') },
          ]}
        />
        {repair.ddts.filter((ddt) => !ddt.live).length > 0 && <p className="fw-q-hint">{t('return.cancelledDdts', { numbers: repair.ddts.filter((ddt) => !ddt.live).map((ddt) => ddt.number).join(', ') })}</p>}
      </Section>
      <Section title={t('return.label')}>
        <p className="fw-q-hint">{t('return.labelLater')}</p>
      </Section>
    </div>
  )
}
