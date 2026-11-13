'use client'

import { useState } from 'react'
import { Banner, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, NumberStepper, RadioCard, SegmentedControl, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { ExportJobDialog } from '../../../../../list-frame/tools/dialogs'
import { DateField, Modal, ReviewChangesModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useT } from '../../../../../lib/i18n/provider'
import { holdWords, kindWords, kitFacts, kitSentence, laterWords, outsideDoneWords, quantityWords, switchHeld, warningWords, workshopOf, type Words as AllocationWords } from '../../../allocation/depth/model'
import type { Board } from '../../api'
import { whenWords, type Refusal } from '../../model'
import type { BoardActions, BoardDialog, BoardViewModel } from '../../view-model'
import { backlogChanges, backlogLeftOut, materialWords, sheetLanes, triedMoveWords, type DepthWords } from '../model'
import { DaySheetPreview } from './DaySheetPreview'
import { MultiSelect } from '../../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * The board's W2b pop-ups (SCR-122, B-W2b-337): the material check of a drop ("Leather arrives 14 Nov. Earliest start with
 * material: 15 Nov" → Snap · Keep my date), Move to a subcontractor (pop:subcontract-move: approved workshops only, the others
 * held with the reason; the kit's ship-out day and list; it plans the subcontract order), Print day sheets (pop:print), the
 * backlog reschedule's review, the what-if conflicts on Apply, and Export board (XLSX, the list frame's job). Every dialog:
 * Esc closes and the focus goes back to its opener (DS Modal).
 */
export function DepthDialogs({ model, actions, words, aw, say }: { model: BoardViewModel; actions?: BoardActions; words: DepthWords; aw: AllocationWords; say: (refusal: Refusal) => string }) {
  const dialog = model.dialog
  const board = model.read.status === 'ready' ? model.read.value : null
  if (!dialog) return null
  const close = () => actions?.onCloseDialog?.()
  switch (dialog.kind) {
    case 'material':
      return <MaterialDialog dialog={dialog} actions={actions} words={words} />
    case 'subcontract':
      return <SubcontractDialog dialog={dialog} model={model} board={board} actions={actions} words={words} aw={aw} say={say} onClose={close} />
    case 'print':
      return <PrintDialog dialog={dialog} model={model} board={board} actions={actions} words={words} onClose={close} />
    case 'backlog':
      return <BacklogDialog dialog={dialog} model={model} board={board} actions={actions} words={words} onClose={close} />
    case 'whatifConflicts':
      return <ConflictsDialog dialog={dialog} model={model} board={board} actions={actions} words={words} onClose={close} />
    case 'export':
      return dialog.job ? <ExportJobDialog job={dialog.job} problem={dialog.problem} onDownload={() => actions?.onExportDownload?.()} onAgain={() => actions?.onExportAgain?.()} onClose={close} /> : <ExportStarting problem={dialog.problem} words={words} onClose={close} />
    default:
      return null
  }
}

function Reading({ label }: { label: string }) {
  return (
    <div className="fw-pbd-stack" aria-busy="true" aria-label={label}>
      <Skeleton width="50%" />
      <Skeleton height={56} />
    </div>
  )
}

// ---- the material check of a drop ---------------------------------------------------------------------------------------------

function MaterialDialog({ dialog, actions, words }: { dialog: Extract<BoardDialog, { kind: 'material' }>; actions?: BoardActions; words: DepthWords }) {
  const { t } = words
  const snapTo = dialog.answer.check?.snapTo ?? null
  const snap = snapTo ? whenWords(snapTo, words) : null
  return (
    <Modal
      open
      onClose={() => actions?.onMaterialChoice?.('cancel')}
      size="md"
      title={t('material.title', { order: dialog.answer.workOrder.number })}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={() => actions?.onMaterialChoice?.('cancel')}>
            {t('material.cancel')}
          </Button>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onMaterialChoice?.('keep')}>
            {t('material.keep')}
          </Button>
          <Button size="sm" variant="primary" heldReason={snap ? null : t('material.noDay')} onClick={() => actions?.onMaterialChoice?.('snap')} aria-keyshortcuts="Enter">
            {snap ? t('material.snap', { start: snap }) : t('material.snapPlain')}
          </Button>
        </>
      }
    >
      <div className="fw-pbd-stack">
        <Banner tone="warning" title={materialWords(dialog.answer, words)} />
        <p className="fw-pb-hint">{t('material.body')}</p>
      </div>
    </Modal>
  )
}

// ---- Move to a subcontractor ---------------------------------------------------------------------------------------------------

function SubcontractDialog({ dialog, model, board, actions, words, aw, say, onClose }: { dialog: Extract<BoardDialog, { kind: 'subcontract' }>; model: BoardViewModel; board: Board | null; actions?: BoardActions; words: DepthWords; aw: AllocationWords; say: (refusal: Refusal) => string; onClose: () => void }) {
  const { t } = words
  const uom = useT('buying')
  const read = dialog.workshops.status === 'ready' ? dialog.workshops.value : null
  const operation = read?.operations.find((entry) => entry.id === dialog.operationId) ?? null
  const workOrder = board?.workOrders.find((entry) => entry.id === dialog.workOrderId) ?? null
  const boardOperation = workOrder?.operations.find((entry) => entry.id === dialog.operationId) ?? null
  const garments = boardOperation?.remainingPieces ?? read?.workOrder.garments ?? 1
  const picked = read?.workshops.find((entry) => entry.id === dialog.partyId) ?? null
  const timing = dialog.timing?.status === 'ready' ? dialog.timing.value : null
  const known = (partyId: string) => {
    const allocation = model.depth?.workshops.status === 'ready' ? model.depth.workshops.value : null
    return workshopOf(allocation, partyId)
  }
  const mayOutsource = (model.depth?.may.outsource ?? false) && (read?.mayOutsource ?? true)
  const held = dialog.done
    ? t('subcontract.doneHeld')
    : dialog.workshops.status !== 'ready'
      ? t('held.reading')
      : !(board?.plan.mayChange ?? false)
        ? t('held.readOnly')
        : (switchHeld({ mayOutsource, offline: model.offline, busy: dialog.busy ?? false, mode: 'outside', partyId: dialog.partyId, offered: picked?.offered ?? false, reason: '' }, aw) ??
          (operation?.outsourced ? t('subcontract.already') : null) ??
          (!Number.isInteger(dialog.pieces) || dialog.pieces < 1 || dialog.pieces > garments ? t('subcontract.piecesHeld', { pieces: String(garments) }) : null) ??
          (dialog.timing?.status === 'loading' ? t('held.reading') : null))
  const title = operation ? t('subcontract.title', { seq: operation.seq, operation: operation.name }) : t('subcontract.titlePlain')
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={title}
      subtitle={workOrder ? `${workOrder.number} · ${workOrder.style.code} · ${workOrder.style.name}` : undefined}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t(dialog.done ? 'dialog.close' : 'dialog.cancel')}
          </Button>
          <span className="grow" />
          <Button size="sm" variant="primary" heldReason={held} onClick={() => !held && actions?.onSubcontractConfirm?.()}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('subcontract.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-pbd-stack">
        {dialog.done ? (
          <Banner tone={dialog.done.stayed ? 'warning' : 'success'} title={outsideDoneWords(dialog.done.answer, aw, board?.site.timeZone ?? 'Europe/Rome')}>
            {dialog.done.stayed ? t('subcontract.barStayed', { reason: say(dialog.done.stayed) }) : null}
          </Banner>
        ) : null}
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        {dialog.workshops.status === 'loading' ? <Reading label={t('subcontract.reading')} /> : null}
        {dialog.workshops.status === 'error' ? (
          <EmptyState
            title={t('subcontract.errorTitle')}
            description={t(`error.${dialog.workshops.problem}`)}
            action={
              <Button size="sm" onClick={() => actions?.onSubcontractRetry?.()}>
                {t('dialog.retry')}
              </Button>
            }
          />
        ) : null}
        {read ? (
          <>
            <p className="fw-pb-hint">{t('subcontract.lead', { kind: kindWords(operation?.workCentreKind ?? null, aw) })}</p>
            {read.workshops.length === 0 ? (
              <p className="fw-pb-hint">{t('subcontract.noWorkshops')}</p>
            ) : (
              <div className="fw-pbd-choices" role="radiogroup" aria-label={t('subcontract.pick')}>
                {read.workshops.map((workshop) => {
                  const facts = known(workshop.id) ?? workshop
                  const why = workshop.held.map((reason) => holdWords(reason, facts, board?.site.name ?? '', aw))
                  const warn = workshop.warnings.map((reason) => warningWords(reason, facts, aw))
                  return (
                    <RadioCard
                      key={workshop.id}
                      name="fw-pbd-workshop"
                      value={workshop.id}
                      checked={dialog.partyId === workshop.id}
                      selected={dialog.partyId === workshop.id}
                      disabled={!workshop.offered}
                      onChange={() => actions?.onSubcontractPick?.(workshop.id)}
                      title={
                        <span className="fw-pbd-inline">
                          {workshop.name} {workshop.offered ? <Tag tone="success">{t('subcontract.approved')}</Tag> : <Tag tone="danger">{t('subcontract.held')}</Tag>}
                        </span>
                      }
                      description={[...why, ...warn].join(' ') || t('subcontract.noRemark')}
                    />
                  )
                })}
              </div>
            )}
            <Field label={t('subcontract.pieces')} hint={t('subcontract.piecesHint', { pieces: String(garments) })}>
              <NumberStepper size="sm" value={dialog.pieces} min={1} max={garments} onChange={(value) => actions?.onSubcontractPieces?.(value)} decrementLabel={t('subcontract.less')} incrementLabel={t('subcontract.more')} />
            </Field>
          </>
        ) : null}
        {dialog.timing?.status === 'loading' ? <Reading label={t('subcontract.kitReading')} /> : null}
        {dialog.timing?.status === 'error' ? <Banner tone="danger" title={t('subcontract.kitError')}>{t(`error.${dialog.timing.problem}`)}</Banner> : null}
        {timing ? (
          <>
            <Banner tone={timing.late ? 'warning' : 'info'} title={kitSentence(timing, aw)} />
            <KeyValue columns={2} labelCase="sentence" items={kitFacts(timing, board?.site.timeZone ?? 'Europe/Rome', aw)} />
            <section aria-labelledby="fw-pbd-kit">
              <h3 className="fw-pb-h3" id="fw-pbd-kit">
                {t('subcontract.kit')}
              </h3>
              {timing.kit.lines.length === 0 ? (
                <p className="fw-pb-hint">{t('subcontract.kitNone')}</p>
              ) : (
                <SummaryTable
                  label={t('subcontract.kit')}
                  density="compact"
                  stackOnPhone
                  columns={[t('subcontract.col.item'), t('subcontract.col.colour'), t('subcontract.col.quantity')]}
                  align={['left', 'left', 'right']}
                  rows={timing.kit.lines.map((line, index) => ({ id: `${line.item.id}-${line.colour?.id ?? 'none'}-${index}`, cells: [`${line.item.code} · ${line.item.name}`, line.colour?.code ?? '—', quantityWords(line, uom, words.locale)] }))}
                />
              )}
            </section>
            {timing.laterOperations.length > 0 ? (
              <ul className="fw-pbd-list" aria-label={t('subcontract.later')}>
                {timing.laterOperations.map((later) => (
                  <li key={later.id}>
                    {laterWords(later, aw)} {later.finishesLate ? <Tag tone="warning">{t('subcontract.finishesLate')}</Tag> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
        <p className="fw-pb-hint">{t(model.depth?.may.order ? 'subcontract.plans' : 'subcontract.plansBuyer')}</p>
      </div>
    </Modal>
  )
}

// ---- Print day sheets -----------------------------------------------------------------------------------------------------------

function PrintDialog({ dialog, model, board, actions, words, onClose }: { dialog: Extract<BoardDialog, { kind: 'print' }>; model: BoardViewModel; board: Board | null; actions?: BoardActions; words: DepthWords; onClose: () => void }) {
  const { t, locale } = words
  const options = board ? sheetLanes(board) : []
  const paper = dialog.paper && dialog.paper.status === 'ready' ? dialog.paper.value : null
  const held = model.offline ? t('held.offline') : dialog.busy ? t('held.busy') : !dialog.date ? t('print.dateHeld') : dialog.paper?.status === 'noVersion' ? t('print.noVersion') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('print.title')}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('dialog.close')}
          </Button>
          <span className="grow" />
          <Button size="sm" variant="primary" heldReason={held} onClick={() => !held && actions?.onPrintOpen?.()}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('print.open')}
          </Button>
        </>
      }
    >
      <div className="fw-pbd-stack">
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        <div className="fw-pbd-form">
          <Field label={t('print.lanes')} hint={dialog.lanes.length === 0 ? t('print.lanesAll') : undefined}>
            <MultiSelect size="sm" options={options} value={[...dialog.lanes]} onChange={(next) => actions?.onPrintChange?.({ lanes: next })} placeholder={t('print.lanesPlaceholder')} formatLabel={(value) => t('print.lanesPicked', { count: value.length, lanes: String(value.length) })} ariaLabel={t('print.lanes')} searchPlaceholder={t('print.search')} />
          </Field>
          <Field label={t('print.date')}>
            <DateField className="fw-pb-date" value={dialog.date} locale={INTL_LOCALE[locale]} ariaLabel={t('print.date')} onChange={(value) => actions?.onPrintChange?.({ date: value })} />
          </Field>
          <Field label={t('print.language')}>
            <Select size="sm" value={dialog.language} onChange={(event) => actions?.onPrintChange?.({ language: event.target.value === 'en' ? 'en' : 'it' })}>
              <option value="it">{t('print.languages.it')}</option>
              <option value="en">{t('print.languages.en')}</option>
            </Select>
          </Field>
          <Field label={t('print.plan')}>
            <SegmentedControl
              size="sm"
              ariaLabel={t('print.plan')}
              options={[
                { value: 'PUBLISHED', label: t('print.plans.PUBLISHED') },
                { value: 'WORKING', label: t('print.plans.WORKING') },
              ]}
              value={dialog.plan}
              onChange={(value) => actions?.onPrintChange?.({ plan: value === 'WORKING' ? 'WORKING' : 'PUBLISHED' })}
            />
          </Field>
        </div>
        <p className="fw-pb-hint">{t(dialog.plan === 'WORKING' ? 'print.workingHint' : 'print.publishedHint')}</p>
        {dialog.paper?.status === 'loading' ? <Reading label={t('print.reading')} /> : null}
        {dialog.paper?.status === 'noVersion' ? <Banner tone="warning" title={t('print.noVersion')}>{t('print.noVersionBody')}</Banner> : null}
        {dialog.paper?.status === 'error' ? <Banner tone="danger" title={t('print.errorTitle')}>{t(`error.${dialog.paper.problem}`)}</Banner> : null}
        {paper ? <DaySheetPreview paper={paper} words={words} /> : null}
      </div>
    </Modal>
  )
}

// ---- Reschedule backlog ----------------------------------------------------------------------------------------------------------

function BacklogDialog({ dialog, model, board, actions, words, onClose }: { dialog: Extract<BoardDialog, { kind: 'backlog' }>; model: BoardViewModel; board: Board | null; actions?: BoardActions; words: DepthWords; onClose: () => void }) {
  const { t } = words
  const [reason, setReason] = useState('')
  const run = dialog.preview.status === 'ready' ? dialog.preview.value : null
  const needsReason = (run?.overbooked ?? 0) > 0
  const leftOut = run && board ? backlogLeftOut(run, board, words) : []
  const state =
    dialog.preview.status === 'loading'
      ? ({ phase: 'reading' } as const)
      : dialog.preview.status === 'error'
        ? ({ phase: 'failed', error: t(`error.${dialog.preview.problem}`) } as const)
        : dialog.busy
          ? ({ phase: 'saving' } as const)
          : ({ phase: 'ready' } as const)
  const problems = [
    ...(dialog.error ? [dialog.error] : []),
    ...(dialog.preview.status === 'nothing' ? [t('backlog.nothing')] : []),
    ...(model.offline ? [t('held.offline')] : []),
    ...(!(board?.plan.mayChange ?? false) ? [t('held.readOnly')] : []),
  ]
  return (
    <ReviewChangesModal
      open
      onClose={onClose}
      size="xl"
      title={t('backlog.title')}
      summary={t('backlog.summary')}
      changes={run && board ? backlogChanges(run, board, words) : []}
      state={state}
      problems={problems}
      saveLabel={run ? t('backlog.apply', { count: run.moves.length, moves: String(run.moves.length) }) : t('backlog.applyPlain')}
      onSave={() => actions?.onBacklogApply?.(needsReason ? reason.trim() : null)}
      onRetry={() => actions?.onDepthDialog?.('backlog')}
      leadHeld={needsReason && reason.trim().length < 3 ? t('backlog.reasonHeld', { count: run?.overbooked ?? 0, lanes: String(run?.overbooked ?? 0) }) : null}
      lead={
        <div className="fw-pbd-stack">
          {leftOut.length > 0 ? (
            <Banner tone="info" title={t('backlog.leftOut', { count: leftOut.length, bars: String(leftOut.length) })}>
              <ul className="fw-pbd-list">
                {leftOut.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {needsReason ? (
            <Field label={t('backlog.reason', { count: run?.overbooked ?? 0, lanes: String(run?.overbooked ?? 0) })} hint={t('backlog.reasonHint')}>
              <Textarea rows={2} value={reason} limit={500} onChange={(event) => setReason(event.target.value)} />
            </Field>
          ) : null}
        </div>
      }
    />
  )
}

// ---- what-if conflicts on Apply ---------------------------------------------------------------------------------------------------

function ConflictsDialog({ dialog, model, board, actions, words, onClose }: { dialog: Extract<BoardDialog, { kind: 'whatifConflicts' }>; model: BoardViewModel; board: Board | null; actions?: BoardActions; words: DepthWords; onClose: () => void }) {
  const { t } = words
  const scenario = model.depth?.whatIf?.read.status === 'ready' ? model.depth.whatIf.read.value : null
  const clashing = new Set(dialog.conflicts.map((conflict) => conflict.index))
  const rest = (scenario?.moves ?? []).filter((_, index) => !clashing.has(index))
  const changes = dialog.conflicts.map((conflict) => {
    const move = scenario?.moves[conflict.index]
    const said = move && board ? triedMoveWords(move, board, words) : null
    return { id: `${conflict.index}`, what: said?.what ?? `#${conflict.index + 1}`, now: said?.from ?? '—', next: said?.to ?? t('log.offBoard'), note: t(`whatif.conflict.${conflict.code}`) }
  })
  return (
    <ReviewChangesModal
      open
      onClose={onClose}
      size="xl"
      title={t('whatif.conflictsTitle', { count: dialog.conflicts.length, moves: String(dialog.conflicts.length) })}
      summary={t('whatif.conflictsSummary')}
      changes={changes}
      state={dialog.busy ? { phase: 'saving' } : { phase: 'ready' }}
      problems={[...(dialog.error ? [dialog.error] : []), ...(rest.length === 0 ? [t('whatif.nothingElse')] : []), ...(model.offline ? [t('held.offline')] : [])]}
      saveLabel={t('whatif.applyRest', { count: rest.length, moves: String(rest.length) })}
      onSave={() => actions?.onWhatIfApplyRest?.()}
    />
  )
}

// ---- Export board: asking for the job ---------------------------------------------------------------------------------------------

function ExportStarting({ problem, words, onClose }: { problem: string | null; words: DepthWords; onClose: () => void }) {
  const { t } = words
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} size="md" title={t('export.title')} footer={<Button size="sm" onClick={onClose}>{t('dialog.close')}</Button>}>
      {problem ? <Banner tone="danger" title={lists(`tools.problem.${problem}`)} /> : <Reading label={t('export.starting')} />}
    </Modal>
  )
}
