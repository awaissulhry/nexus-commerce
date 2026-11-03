'use client'

import { useMemo } from 'react'
import { Ruler, Scale } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { EditModeBar, Modal, Textarea, Timeline } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { quantity, type Phrase } from '../../../../_shared/stock/model'
import { PartState, useWords, type Words } from '../../../lots/shared/parts'
import type { GradeChoice, GradingView, MeasuresView, MeasureView } from '../grading/api'
import {
  applyHeldKey,
  audienceKey,
  changeCount,
  changeLines,
  correctHeldKey,
  measureDraftHeldKey,
  measuredBy,
  measureHeldKey,
  OUTCOME_TONE,
  readOnlyKey,
  type GradingActions,
  type GradingDraft,
  type GradingModel,
  type MeasureDialogModel,
} from '../grading/grading-model'
import './hide-tabs.css'

const say = (t: Words, said: Phrase) => t(said.key, said.params)

/**
 * The hide's "Measurements & grade" tab (design warehouse.hides rec:Hide tab `grade`; B-W2b-131 on B-W2b-94's routes):
 * the grade (the article's grades, each with its usable share), the shade group, the thickness and the tannery number,
 * the area read-only ("measured at receipt and never changed: a correction is an adjustment move" + Correct the area…),
 * an EditModeBar with ⌘S, Discard and Apply held with its reason (a reason is asked once the hide was cut); W2b: the usable
 * area at its grade and the estimate per grade it may be given (SCM-250); the changes (from → to, why); the measures
 * against the tannery with Measure again… (only a whole hide). Read-only for a used, scrapped or returned hide, and for a
 * role without inventory.hides.manage. Draws the model; the container (use-grading.ts) reads and writes.
 */
export function GradeTab({ model, actions, timeZone }: { model: GradingModel; actions?: GradingActions; timeZone: string }) {
  const t = useWords()
  return (
    <PartState value={model.view} label={t('hd.tab.grade')} onRetry={actions?.onRetry}>
      {(view) => <GradeBody view={view} model={model} actions={actions} timeZone={timeZone} />}
    </PartState>
  )
}

function gradeName(grade: Pick<GradeChoice, 'code' | 'labelIt' | 'labelEn'>, locale: string): string {
  const label = locale === 'en' ? grade.labelEn : grade.labelIt
  return label && label !== grade.code ? `${grade.code} · ${label}` : grade.code
}

function GradeBody({ view, model, actions, timeZone }: { view: GradingView; model: GradingModel; actions?: GradingActions; timeZone: string }) {
  const t = useWords()
  const locale = useLocale()
  const draft = model.gradeDraft
  const unit = (uom: string) => t(`stock:uom.${uom}`)
  const readOnly = readOnlyKey(view)
  const editable = readOnly === null && model.can.manage && view.canEdit && draft !== null
  const count = draft ? changeCount(view, draft, 'grade') : 0
  const held = draft ? applyHeldKey(view, draft, 'grade', model.can, model.saving === 'grade') : null
  const set = (next: Partial<GradingDraft>) => draft && actions?.onDraft?.('grade', { ...draft, ...next })
  const area = view.hide.area
  const measures = model.measures.value
  const correctHeld = measures ? correctHeldKey(measures, model.can) : 'hd.measure.held.reading'

  const gradeNow = view.grade ? gradeName(view.grade, locale) : t('hd.grading.ungraded')
  const shadeNow = view.shade ? view.shade.label : view.shadeText ? t('hd.grading.shadeText', { shade: view.shadeText }) : t('hd.grading.unsorted')

  return (
    <div className="fw-wl-stack">
      {/* A used or scrapped hide: the record's band says it already (one Banner, not two). */}
      {readOnly && view.hide.state !== 'CONSUMED' && view.hide.state !== 'SCRAPPED' && (
        <Banner tone="info" title={t(readOnly, { code: view.hide.code })}>
          {t('hd.grading.readOnlyBody')}
        </Banner>
      )}
      {model.changedMeanwhile && <Banner tone="warning" title={t('hd.grading.changedMeanwhile')} />}
      {model.problem?.tab === 'grade' && <Banner tone="danger" title={say(t, model.problem.phrase)} onDismiss={() => actions?.onDismissNotice?.()} />}
      {model.saved === 'grade' && <Banner tone="success" title={t('hd.grading.saved')} onDismiss={() => actions?.onDismissNotice?.()} />}

      <div className="fw-wl-split">
        <div className="fw-wl-stack">
          <Card header={t('hd.grading.title')} description={editable ? t('hd.grading.hint') : readOnly ? t(readOnly, { code: view.hide.code }) : t('hd.grading.viewOnly')}>
            <div className="fw-wl-stack">
              {editable && draft ? (
                <div className="fw-hr-form">
                  <Field label={t('hd.grading.grade')} hint={view.grade?.byText && draft.gradeId === view.grade.id ? t('hd.grading.byTextHint', { grade: view.grade.code }) : undefined}>
                    <Select value={draft.gradeId ?? ''} onChange={(event) => set({ gradeId: event.target.value || null, recordByText: false })}>
                      <option value="">{t('hd.grading.noGrade')}</option>
                      {view.choices.grades.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {t(choice.active ? 'hd.grading.gradeOption' : 'hd.grading.gradeOptionRetired', { grade: gradeName(choice, locale), share: quantity(choice.share, locale) })}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('hd.grading.shade')} hint={!view.shade && view.shadeText ? t('hd.grading.shadeTextHint', { shade: view.shadeText }) : undefined}>
                    <Select value={draft.shadeGroupId ?? ''} onChange={(event) => set({ shadeGroupId: event.target.value || null })}>
                      <option value="">{t('hd.grading.unsorted')}</option>
                      {view.choices.shadeGroups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.outOfShade ? t('hd.grading.outOfShadeOption', { shade: group.label }) : group.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('hd.grading.thickness')} hint={t('hd.grading.thicknessHint')}>
                    <Input inputMode="decimal" value={draft.thicknessMm} onChange={(event) => set({ thicknessMm: event.target.value })} />
                  </Field>
                  <Field label={t('hd.facts.tannery')}>
                    <span className="fw-wl-text">{view.hide.supplierCode ?? '—'}</span>
                  </Field>
                  {view.grade?.byText && draft.gradeId === view.grade.id && (
                    <div className="is-wide">
                      <Checkbox label={t('hd.grading.recordByText', { grade: view.grade.code })} checked={draft.recordByText} onChange={(event) => set({ recordByText: event.target.checked })} />
                    </div>
                  )}
                  {view.reasonRequired && count > 0 && (
                    <div className="is-wide">
                      <Field label={t('hd.grading.reason')} required hint={t('hd.grading.reasonHint')}>
                        <Textarea rows={2} maxLength={500} value={draft.reason} onChange={(event) => set({ reason: event.target.value })} />
                      </Field>
                    </div>
                  )}
                </div>
              ) : (
                <KeyValue
                  dense
                  columns={2}
                  labelCase="sentence"
                  items={[
                    { label: t('hd.grading.grade'), value: gradeNow, hint: view.grade?.byText ? t('hd.grading.byText') : undefined },
                    { label: t('hd.grading.shade'), value: shadeNow, hint: view.shade?.outOfShade ? t('hd.grading.outOfShade') : undefined },
                    { label: t('hd.grading.thickness'), value: view.hide.thicknessMm ? `${quantity(view.hide.thicknessMm, locale)} mm` : '—' },
                    { label: t('hd.facts.tannery'), value: view.hide.supplierCode ?? '—' },
                  ]}
                />
              )}
              <div className="fw-hr-area">
                <span className="fw-hr-area-words">
                  <span className="fw-wl-text">
                    <b>{t('hd.grading.areaLine', { area: `${quantity(area.quantity, locale)} ${unit(area.uom)}`, other: `${quantity(area.other.quantity, locale, 1)} ${unit(area.other.uom)}` })}</b>
                  </span>
                  <span className="fw-wl-hint">{t('hd.grading.areaFixed')}</span>
                </span>
                {readOnly === null && (
                  <Button size="sm" heldReason={correctHeld ? t(correctHeld) : null} onClick={() => actions?.onMeasureOpen?.(true)}>
                    <Scale size={14} aria-hidden /> {t('hd.grading.correctArea')}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          <MeasuresCard model={model} actions={actions} timeZone={timeZone} readOnly={readOnly !== null} />
        </div>

        <div className="fw-wl-stack">
          <UsableCard view={view} />
          <ChangesCard view={view} />
        </div>
      </div>

      {editable && draft && count > 0 && (
        <EditModeBar
          count={count}
          onDiscard={() => actions?.onDiscard?.('grade')}
          onApply={() => actions?.onApply?.('grade')}
          applyHeldReason={held ? t(held) : null}
          busy={model.saving === 'grade'}
          saveShortcut
        />
      )}
      {model.measure && measures && <MeasureDialog dialog={model.measure} view={view} measures={measures} model={model} actions={actions} />}
    </div>
  )
}

/** W2b (SCM-250): the usable area at the hide's grade, and at each grade it may be given (of what is left). */
function UsableCard({ view }: { view: GradingView }) {
  const t = useWords()
  const locale = useLocale()
  const unit = t(`stock:uom.${view.hide.item.baseUom}`)
  const usable = view.usable
  return (
    <Card header={t('hd.grading.usable.title')} description={t('hd.grading.usable.hint')}>
      <div className="fw-wl-stack tight">
        {usable && view.grade ? (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('hd.grading.usable.share'), value: `${quantity(usable.share, locale)} %`, hint: t(usable.source === 'RULE' ? 'hd.grading.usable.byRule' : 'hd.grading.usable.byGrade', { grade: view.grade.code }) },
              { label: t('hd.grading.usable.ofMeasured'), value: `${quantity(usable.measured, locale)} ${unit}` },
              { label: t('hd.grading.usable.ofLeft'), value: `${quantity(usable.left, locale)} ${unit}` },
              { label: t('hd.grading.usable.panels'), value: usable.panels.length > 0 ? usable.panels.join(', ') : t('hd.grading.usable.everyPanel') },
            ]}
          />
        ) : (
          <p className="fw-wl-text">{t('hd.grading.usable.unknown')}</p>
        )}
        <h4 className="fw-wl-h3">{t('hd.grading.usable.estimates')}</h4>
        {view.estimates.length === 0 ? (
          <p className="fw-wl-hint">{t('hd.grading.usable.noGrades')}</p>
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={view.estimates.map((entry) => ({
              label: t('hd.grading.usable.atGrade', { grade: entry.code, share: quantity(entry.share, locale) }),
              value: `${quantity(entry.usable, locale)} ${unit}`,
              hint: entry.current ? t('hd.grading.usable.now') : t(entry.source === 'RULE' ? 'hd.grading.usable.ruleShort' : 'hd.grading.usable.gradeShort'),
            }))}
          />
        )}
      </div>
    </Card>
  )
}

/** Who changed grade, shade, thickness or defects: from → to, why (design hd-grade-history). */
function ChangesCard({ view }: { view: GradingView }) {
  const t = useWords()
  const locale = useLocale()
  const value = (field: string, text: string | null) => (text === null ? t('hd.grading.changes.none') : field === 'thicknessMm' ? `${quantity(text, locale)} mm` : text)
  return (
    <Card header={t('hd.grading.changes.title')}>
      {view.changes.length === 0 ? (
        <p className="fw-wl-hint">{t('hd.grading.changes.empty')}</p>
      ) : (
        <Timeline
          label={t('hd.grading.changes.title')}
          steps={view.changes.map((change, n) => ({
            key: `${change.at}:${n}`,
            tone: 'info' as const,
            at: change.at,
            label: changeLines(change)
              .map((line) => (line.field === 'defects' ? t('hd.grading.changes.defects') : t(`hd.grading.changes.line`, { field: t(`hd.grading.changes.field.${line.field}`), from: value(line.field, line.from), to: value(line.field, line.to) })))
              .join(' · ') || t('hd.grading.changes.noField'),
            detail: [t(audienceKey(change.audience)), change.reason ? t('hd.grading.changes.why', { reason: change.reason }) : null].filter(Boolean).join(' · '),
          }))}
        />
      )}
    </Card>
  )
}

function MeasuresCard({ model, actions, timeZone, readOnly }: { model: GradingModel; actions?: GradingActions; timeZone: string; readOnly: boolean }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const measures = model.measures.value
  const columns = useMemo<ColDef<MeasureView>[]>(() => {
    const unit = (uom: string) => t(`stock:uom.${uom}`)
    const WhenCell = ({ data }: ICellRendererParams<MeasureView>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num">{formatDateTime(data.measuredAt, place)}</span>
          <span className="fw-st-sub">{data.latest ? t('hd.measure.latest') : data.incomingInspectionId ? t('hd.measure.atInspection') : ''}</span>
        </span>
      ) : null
    const DeclaredCell = ({ data }: ICellRendererParams<MeasureView>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num">{`${quantity(data.declared, locale)} ${unit(data.areaUom)}`}</span>
          <span className="fw-st-sub">{t(data.declaredFrom === 'TANNERY' ? 'hd.measure.fromTannery' : 'hd.measure.fromReceipt')}</span>
        </span>
      ) : null
    const DifferenceCell = ({ data }: ICellRendererParams<MeasureView>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num">{`${quantity(data.difference, locale)} ${unit(data.areaUom)}`}</span>
          <span className="fw-st-sub">{`${quantity(data.differencePercent, locale)} %`}</span>
        </span>
      ) : null
    const OutcomeCell = ({ data }: ICellRendererParams<MeasureView>) => (data ? <Pill tone={OUTCOME_TONE[data.outcome]}>{t(`hd.measure.outcome.${data.outcome}`)}</Pill> : null)
    return [
      { colId: 'when', headerName: t('hd.measure.col.when'), minWidth: 160, flex: 1, cellRenderer: WhenCell },
      { colId: 'declared', headerName: t('hd.measure.col.declared'), minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: DeclaredCell },
      { colId: 'measured', headerName: t('hd.measure.col.measured'), minWidth: 120, flex: 0.8, type: 'rightAligned', valueGetter: (params) => (params.data ? `${quantity(params.data.measuredArea, locale)} ${unit(params.data.areaUom)}` : '') },
      { colId: 'difference', headerName: t('hd.measure.col.difference'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: DifferenceCell },
      { colId: 'outcome', headerName: t('hd.measure.col.outcome'), minWidth: 120, flex: 0.7, cellRenderer: OutcomeCell },
      { colId: 'by', headerName: t('hd.measure.col.by'), minWidth: 140, flex: 0.9, valueGetter: (params) => (params.data ? measuredBy(params.data, t) : '') },
      { colId: 'note', headerName: t('hd.measure.col.note'), minWidth: 140, flex: 1, valueGetter: (params) => params.data?.note ?? '—', tooltipValueGetter: (params) => params.data?.note ?? '' },
    ]
    // `place` is made of the locale and the zone, both listed.
  }, [t, locale, timeZone])
  const held = measures ? measureHeldKey(measures, model.can) : 'hd.measure.held.reading'
  return (
    <section className="fw-wl-stack tight" aria-labelledby="hd-measures-title">
      <div className="fw-wl-card-head">
        <h3 className="fw-wl-h3" id="hd-measures-title">
          {t('hd.measure.title')}
        </h3>
        {!readOnly && (
          <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onMeasureOpen?.(false)}>
            <Ruler size={14} aria-hidden /> {t('hd.measure.again')}
          </Button>
        )}
      </div>
      {measures && <p className="fw-wl-hint">{t(measures.toleranceFrom === 'ORDER_LINE' ? 'hd.measure.toleranceLine' : 'hd.measure.toleranceDefault', { percent: quantity(measures.tolerancePercent, locale) })}</p>}
      <PartState value={model.measures} label={t('hd.measure.title')} onRetry={actions?.onRetryMeasures}>
        {(read: MeasuresView) => (
          <ListFrame<MeasureView>
            label={t('hd.measure.label')}
            listKey={null}
            rows={read.measures}
            rowId={(row) => row.id}
            columns={columns}
            count={t('hd.measure.count', { count: read.measures.length })}
            state={read.measures.length === 0 ? <EmptyState title={t('hd.measure.none')} description={t('hd.measure.noneBody')} /> : undefined}
          />
        )}
      </PartState>
    </section>
  )
}

/** Measure again… / Correct the area… (one dialog): a whole hide against the tannery's area; the stock corrected when asked. */
function MeasureDialog({ dialog, view, measures, model, actions }: { dialog: MeasureDialogModel; view: GradingView; measures: MeasuresView; model: GradingModel; actions?: GradingActions }) {
  const t = useWords()
  const locale = useLocale()
  const uom = view.hide.area.uom
  const unit = (code: string) => t(`stock:uom.${code}`)
  const held = measureDraftHeldKey(dialog.draft, dialog.posting)
  const canCorrect = model.can.adjust && measures.canCorrectStock
  const set = (next: Partial<MeasureDialogModel['draft']>) => actions?.onMeasureDraft?.({ ...dialog.draft, ...next })
  const done = dialog.done
  return (
    <Modal
      open
      onClose={() => actions?.onMeasureClose?.()}
      size="md"
      title={t(dialog.correcting ? 'hd.measure.dialog.correctTitle' : 'hd.measure.dialog.title', { code: view.hide.code })}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onMeasureClose?.()}>
            {done ? t('rec.close') : t('stock:common.cancel')}
          </Button>
          {!done && (
            <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onMeasureSave?.()}>
              {dialog.posting && <Spinner size={12} />} {t(dialog.draft.correctStock ? 'hd.measure.dialog.saveCorrect' : 'hd.measure.dialog.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-wl-stack">
        {done ? (
          <div className="fw-wl-stack tight" role="status">
            <span className="fw-wl-chips">
              <Pill tone={OUTCOME_TONE[done.measure.outcome]}>{t(`hd.measure.outcome.${done.measure.outcome}`)}</Pill>
            </span>
            <p className="fw-wl-text">
              {t('hd.measure.dialog.doneLine', {
                measured: `${quantity(done.measure.measuredArea, locale)} ${unit(done.measure.areaUom)}`,
                declared: `${quantity(done.measure.declared, locale)} ${unit(done.measure.areaUom)}`,
                percent: quantity(done.measure.differencePercent, locale),
              })}
            </p>
            <p className="fw-wl-hint">
              {done.move
                ? t(done.move.direction === 'OUT' ? 'hd.measure.dialog.movedOut' : 'hd.measure.dialog.movedIn', { quantity: `${quantity(done.move.quantity, locale)} ${unit(done.move.uom)}` })
                : dialog.draft.correctStock
                  ? t('hd.measure.dialog.stockSaidIt')
                  : t('hd.measure.dialog.stockUntouched')}
            </p>
          </div>
        ) : (
          <>
            <p className="fw-wl-hint">{t('hd.measure.dialog.hint')}</p>
            <div className="fw-hr-form">
              <Field label={t('hd.measure.dialog.measured', { unit: unit(uom) })} required>
                <Input inputMode="decimal" autoFocus value={dialog.draft.measuredArea} onChange={(event) => set({ measuredArea: event.target.value })} />
              </Field>
              <Field label={t('hd.measure.dialog.declared', { unit: unit(uom) })} hint={t('hd.measure.dialog.declaredHint', { area: `${quantity(view.hide.area.quantity, locale)} ${unit(uom)}` })}>
                <Input inputMode="decimal" value={dialog.draft.declaredArea} onChange={(event) => set({ declaredArea: event.target.value })} />
              </Field>
              <div className="is-wide">
                <Field label={t('hd.measure.dialog.note')}>
                  <Textarea rows={2} maxLength={500} value={dialog.draft.note} onChange={(event) => set({ note: event.target.value })} />
                </Field>
              </div>
              <div className="is-wide">
                {canCorrect ? (
                  <Checkbox label={t('hd.measure.dialog.correct')} checked={dialog.draft.correctStock} onChange={(event) => set({ correctStock: event.target.checked })} />
                ) : (
                  <p className="fw-wl-hint">{t('hd.measure.held.noAdjust')}</p>
                )}
              </div>
              {canCorrect && dialog.draft.correctStock && (
                <div className="is-wide">
                  <Field label={t('hd.measure.dialog.correctNote')} hint={t('hd.measure.dialog.correctHint')}>
                    <Input maxLength={500} value={dialog.draft.correctNote} onChange={(event) => set({ correctNote: event.target.value })} />
                  </Field>
                </div>
              )}
            </div>
          </>
        )}
        {dialog.problem && <Banner tone="danger" title={say(t, dialog.problem)} />}
      </div>
    </Modal>
  )
}
