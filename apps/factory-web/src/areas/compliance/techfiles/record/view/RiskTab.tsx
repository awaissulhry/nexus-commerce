'use client'

import { useMemo, useRef } from 'react'
import { FilePlus2, MoreHorizontal, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SignOffPanel, type SignOffStep } from '@nexus/ui/components/SignOffPanel/index'
import { selectEditor, SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { HAZARDS, RESIDUAL_RISKS, type Hazard, type ResidualRisk } from '@nexus/factory-domain/compliance/techfiles/rules'
import { CellSaveMark, Modal, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { GarmentZoneMap, zoneWords } from '../../../../quality/defects/zones/GarmentZoneMap'
import type { RiskRow } from '../../api'
import { ASSESSMENT_TONE, newRevisionHeld, RESIDUAL_TONE, riskWriteHeld, shownAssessment, signHeld, signProblems, valueOf, zoneCodeOf, zoneIdOf, zoneMarks } from '../../model'
import { NoticeBanner, SectionFailed, SectionHead, SectionLoading, StatePill, useDay, useWhen, useWords } from '../../view/parts'
import type { Mark, RecordActions, RecordModel } from '../view-model'

/** A text cell that edits in the grid (autosave per cell at the row's version): any printable key starts editing. */
const typing = () => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key.length === 1 && event.key !== ' '
}

const NO_ZONE = '—'

/**
 * Technical file › Risk assessment (design rec tab "risk", sec tf-risk; PRD-301; PPE Reg. Annex III (b)): the revisions (a draft,
 * the one signed, those superseded), the class reasoning (EN 17092; for a line that is not PPE, the GPSR risk analysis), the
 * hazards on the list frame — hazard, zone of the garment, intended use, foreseeable misuse, how it is controlled, standard
 * clause, residual risk — each cell autosaved at the row's version with its save mark; the garment sketch (GarmentZoneMap) with
 * how many hazards each zone holds (pick a zone: a new hazard goes there); then the sign-off (SignOffPanel): a draft with
 * hazards is signed with the typed name and function and a fresh code; a signed revision is read-only and a new one starts from
 * its rows.
 */
export function RiskTab({ model, actions }: { model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const when = useWhen()
  const ds = useDsWords()
  const locale = useLocale()
  const { riskUi } = model
  const answer = valueOf(model.risk)
  const shown = answer ? shownAssessment(answer.assessments, riskUi.shown) : null
  const fileStatus = model.record.file.status
  const can = { manage: model.can.manage && (answer?.may.manage ?? true), sign: model.can.sign && (answer?.may.sign ?? true) }
  const writeHeld = answer ? riskWriteHeld(shown, fileStatus, can, model.online) : 'held.reading'
  const latest = useRef({ marks: riskUi.marks, actions })
  latest.current = { marks: riskUi.marks, actions }
  const rows = shown?.rows ?? []
  const selected = riskUi.selected.filter((id) => rows.some((row) => row.id === id))

  const columns = useMemo<ColDef<RiskRow>[]>(() => {
    const editable = !writeHeld
    const mark = (id: string, field: string): Mark | undefined => latest.current.marks[`${id}:${field}`]
    const words = {
      hazard: (code: string) => t(`hazard.${code}`),
      residual: (code: string) => t(`residual.${code}`),
      zone: (code: string | null) => {
        if (!code) return t('risk.wholeGarment')
        const id = zoneIdOf(code)
        return id ? zoneWords(id, locale) : code
      },
    }
    const SaveMark = ({ id, field }: { id: string; field: string }) => {
      const value = mark(id, field)
      if (!value || value.state === 'saved') return null
      if (value.state === 'refused') {
        const reason = t(value.problem ?? 'problem.unavailable')
        return (
          <span className="fw-tf-refused" role="img" aria-label={reason} title={reason}>
            !
          </span>
        )
      }
      return <CellSaveMark state={value.state} />
    }
    const choice = (field: 'hazard' | 'residualRisk' | 'garmentZone', header: string, values: readonly string[], say: (code: string) => string, width: number): ColDef<RiskRow> => ({
      colId: field,
      headerName: header,
      minWidth: width,
      flex: 1,
      valueGetter: (params) => (params.data ? (field === 'garmentZone' ? (zoneIdOf(params.data.garmentZone) ?? (params.data.garmentZone ? params.data.garmentZone : NO_ZONE)) : params.data[field]) : ''),
      ...(editable ? selectEditor(values.map((value) => ({ value, label: say(value) }))) : {}),
      valueSetter: (params) => {
        if (params.data) {
          const value = String(params.newValue ?? '')
          latest.current.actions?.onCell?.(params.data.id, field, field === 'garmentZone' ? (value === NO_ZONE ? '' : (zoneCodeOf(value) ?? '')) : value)
        }
        return false
      },
      cellRenderer: ({ data }: ICellRendererParams<RiskRow>) =>
        data ? (
          <span className="fw-tf-cell-row">
            <span>{field === 'garmentZone' ? words.zone(data.garmentZone) : field === 'hazard' ? words.hazard(data.hazard) : t(`residual.${data.residualRisk}`)}</span>
            {field === 'residualRisk' && <span className={`fw-tf-dot fw-tf-dot-${RESIDUAL_TONE[data.residualRisk]}`} aria-hidden />}
            <SaveMark id={data.id} field={field} />
          </span>
        ) : null,
    })
    const text = (field: 'intendedUse' | 'foreseeableMisuse' | 'control' | 'standardClause', header: string, flex: number, max: number): ColDef<RiskRow> => ({
      colId: field,
      headerName: header,
      minWidth: field === 'standardClause' ? 130 : 180,
      flex,
      wrapText: true,
      autoHeight: true,
      valueGetter: (params) => (params.data ? (params.data[field] ?? '') : ''),
      ...(editable ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: max } } : {}),
      suppressKeyboardEvent: typing(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data.id, field, String(params.newValue ?? ''))
        return false
      },
      cellRenderer: ({ data }: ICellRendererParams<RiskRow>) =>
        data ? (
          <span className="fw-tf-cell-row">
            <span className={data[field] ? undefined : 'fw-tf-muted'}>{data[field] || '—'}</span>
            <SaveMark id={data.id} field={field} />
          </span>
        ) : null,
    })
    return [
      choice('hazard', t('risk.col.hazard'), HAZARDS, words.hazard, 150),
      choice('garmentZone', t('risk.col.zone'), [NO_ZONE, ...GARMENT_ZONES.map((zone) => zone.id)], (code) => (code === NO_ZONE ? t('risk.wholeGarment') : words.zone(zoneCodeOf(code))), 150),
      text('intendedUse', t('risk.col.intendedUse'), 1.6, 2000),
      text('foreseeableMisuse', t('risk.col.misuse'), 1.4, 2000),
      text('control', t('risk.col.control'), 1.6, 2000),
      text('standardClause', t('risk.col.clause'), 0.9, 100),
      choice('residualRisk', t('risk.col.residual'), RESIDUAL_RISKS, words.residual, 130),
    ]
  }, [t, locale, writeHeld])

  if (model.risk === null || model.risk.status === 'loading') return <SectionLoading rows={5} />
  if (model.risk.status === 'error') return <SectionFailed title={t('risk.failed')} problem={model.risk.problem} onRetry={() => actions?.onRetry?.('risk')} />
  const value = model.risk.value
  const startHeld = newRevisionHeld(value.assessments, fileStatus, can, model.online)
  const next = (value.assessments.reduce((max, entry) => Math.max(max, entry.revision), 0) || 0) + 1

  if (!shown) {
    return (
      <div className="fw-tf-tab">
        <SectionHead id="fw-tf-risk" title={t('risk.title')} note={t('risk.note')} />
        <Card padded>
          <EmptyState
            icon={<ShieldCheck size={22} aria-hidden />}
            title={t('risk.emptyTitle')}
            description={t('risk.empty')}
            action={
              <Button size="sm" variant="primary" heldReason={startHeld ? t(startHeld) : null} onClick={() => actions?.onNewRevision?.()}>
                {t('risk.start', { revision: next })}
              </Button>
            }
          />
        </Card>
      </div>
    )
  }

  const zone = riskUi.zone
  const marks = zoneMarks(rows)
  const inZone = zone ? rows.filter((row) => zoneIdOf(row.garmentZone) === zone) : []
  const sign = signHeld(shown, fileStatus, can, model.online)
  const steps: SignOffStep[] = [
    shown.status === 'DRAFT'
      ? {
          id: 'sign',
          label: t('risk.signStep'),
          state: sign && sign !== 'held.noHazards' && sign !== 'held.sign' && sign !== 'held.offline' ? 'held' : 'waiting',
          whoMay: t('risk.whoMay'),
          heldReason: sign ? t(sign) : null,
          action: { label: t('risk.sign'), onClick: () => actions?.onSign?.(true) },
        }
      : {
          id: 'sign',
          label: t('risk.signStep'),
          state: 'signed',
          signer: shown.signedByName ?? shown.signedBy?.name ?? '—',
          ...(shown.signedByFunction ? { signerRole: shown.signedByFunction } : {}),
          method: 'typed',
          methodDetail: t('risk.withCode'),
          ...(shown.signedAt ? { signedAt: when(shown.signedAt) } : {}),
          ...(shown.status === 'SUPERSEDED' ? { note: t('risk.supersededOn', { date: day(shown.supersededAt) }) } : {}),
        },
  ]
  const revisionMenu: MenuItemDef[] = [
    { id: 'new', label: t('risk.start', { revision: next }), disabled: !!startHeld, description: startHeld ? t(startHeld) : undefined, onSelect: () => actions?.onNewRevision?.() },
    {
      id: 'remove',
      label: t('risk.removeDraft'),
      disabled: shown.status !== 'DRAFT' || !!writeHeld,
      description: shown.status !== 'DRAFT' ? t('held.onlyDraft') : writeHeld ? t(writeHeld) : undefined,
      onSelect: () => actions?.onRemoveRevision?.(),
    },
  ]

  return (
    <div className="fw-tf-tab">
      <SectionHead id="fw-tf-risk" title={t('risk.title')} note={t('risk.note')}>
        <Select size="sm" value={shown.id} aria-label={t('risk.revision')} onChange={(event) => actions?.onRevision?.(event.target.value)}>
          {[...value.assessments]
            .sort((a, b) => b.revision - a.revision)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {t('risk.revisionOption', { revision: entry.revision, status: t(`assessment.${entry.status}`) })}
              </option>
            ))}
        </Select>
        <StatePill group="assessment" state={shown.status} tone={ASSESSMENT_TONE[shown.status]} />
        <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('risk.more') }} items={revisionMenu} />
      </SectionHead>
      <NoticeBanner notice={riskUi.writing.problem} />
      {shown.status !== 'DRAFT' && <Banner tone="neutral" title={t(shown.status === 'SIGNED' ? 'risk.signedReadOnly' : 'risk.supersededReadOnly')} />}

      <Card padded>
        <Field label={t('risk.reasoning')} hint={t('risk.reasoningHint')}>
          {writeHeld ? (
            <p className={shown.classReasoning ? 'fw-tf-pre' : 'fw-tf-muted'}>{shown.classReasoning ?? t('risk.noReasoning')}</p>
          ) : (
            <span className="fw-tf-stack-tight">
              <Textarea rows={3} maxLength={8000} value={riskUi.reasoning ?? shown.classReasoning ?? ''} onChange={(event) => actions?.onReasoning?.(event.target.value)} onBlur={() => actions?.onReasoningSave?.()} />
              {riskUi.reasoningMark && riskUi.reasoningMark.state !== 'saved' ? (
                riskUi.reasoningMark.state === 'refused' ? (
                  <span className="fw-tf-danger-text">{t(riskUi.reasoningMark.problem ?? 'problem.unavailable')}</span>
                ) : (
                  <CellSaveMark state={riskUi.reasoningMark.state} />
                )
              ) : null}
            </span>
          )}
        </Field>
      </Card>

      <div className="fw-tf-risk">
        <div className="fw-tf-risk-grid">
          <ListFrame<RiskRow>
            label={t('risk.hazards')}
            listKey={null}
            rows={rows}
            rowId={(row) => row.id}
            columns={columns}
            count={t('risk.count', { count: rows.length })}
            right={
              <Button size="sm" variant="primary" heldReason={writeHeld ? t(writeHeld) : null} onClick={() => actions?.onAddRow?.()}>
                <Plus size={13} aria-hidden /> {t('risk.addRow')}
              </Button>
            }
            selection={
              writeHeld
                ? undefined
                : {
                    selected,
                    onChange: (ids) => actions?.onRiskSelected?.(ids),
                    actions: (
                      <Button size="sm" variant="danger" aria-label={t('risk.removeRows', { count: selected.length })} onClick={() => actions?.onRemoveRows?.(selected)}>
                        <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('risk.removeRows', { count: selected.length })}</SelectionLabel>
                      </Button>
                    ),
                  }
            }
            state={
              rows.length === 0 ? (
                <EmptyState
                  icon={<FilePlus2 size={22} aria-hidden />}
                  title={t('risk.noRows')}
                  description={t(writeHeld ? 'risk.noRowsRead' : 'risk.noRowsHint')}
                  action={
                    writeHeld ? undefined : (
                      <Button size="sm" variant="primary" onClick={() => actions?.onAddRow?.()}>
                        {t('risk.addRow')}
                      </Button>
                    )
                  }
                />
              ) : undefined
            }
            cards={{ fields: { hazard: { role: 'title' }, control: { role: 'subtitle' }, residualRisk: { role: 'aside' } } }}
          />
          <p className="fw-tf-muted">{t('risk.autosave')}</p>
        </div>
        <Card padded className="fw-tf-risk-map">
          <h3 className="fw-tf-h3">{t('risk.mapTitle')}</h3>
          <GarmentZoneMap
            label={t('risk.mapLabel')}
            value={zone}
            onChange={(next) => actions?.onZone?.(next)}
            marks={marks}
            formatMark={(count) => String(count)}
            compact
          />
          {zone ? (
            <span className="fw-tf-stack-tight">
              <span className="fw-tf-strong">{t('risk.zonePicked', { zone: zoneWords(zone, locale), count: inZone.length })}</span>
              {inZone.map((row) => (
                <span key={row.id} className="fw-tf-muted">
                  {t(`hazard.${row.hazard}`)} · {t(`residual.${row.residualRisk}`)}
                </span>
              ))}
              <Button size="sm" heldReason={writeHeld ? t(writeHeld) : null} onClick={() => actions?.onAddRow?.()}>
                <Plus size={13} aria-hidden /> {t('risk.addHere', { zone: zoneWords(zone, locale) })}
              </Button>
            </span>
          ) : (
            <p className="fw-tf-muted">{t('risk.mapHint')}</p>
          )}
        </Card>
      </div>

      <SignOffPanel title={t('risk.signTitle')} steps={steps} labels={ds.signOffPanel} headingLevel={3} />
    </div>
  )
}

/** Sign the risk assessment: the typed name and function, then a fresh code (StepUpModal); it supersedes the one signed before. */
export function SignDialog({ model, actions }: { model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const sign = model.riskUi.sign!
  const answer = valueOf(model.risk)
  const shown = answer ? shownAssessment(answer.assessments, model.riskUi.shown) : null
  const signed = answer?.assessments.find((entry) => entry.status === 'SIGNED') ?? null
  const problems = signProblems({ name: sign.name, fn: sign.fn })
  const close = () => actions?.onSign?.(false)
  return (
    <Modal
      open
      onClose={close}
      title={t('sign.title', { revision: shown?.revision ?? '—' })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={sign.writing.busy} heldReason={problems[0] ? t(problems[0]) : !model.online ? t('held.offline') : null} onClick={() => actions?.onSignSave?.()}>
            {t('sign.do')}
          </Button>
        </>
      }
    >
      <div className="fw-tf-form">
        <NoticeBanner notice={sign.writing.problem} />
        <p>{t('sign.lead', { count: shown?.rows.length ?? 0 })}</p>
        {signed && <p className="fw-tf-muted">{t('sign.supersedes', { revision: signed.revision })}</p>}
        {model.record.file.status === 'COMPLETE' && <Banner tone="warning" title={t('sign.reopens')} />}
        <Field label={t('sign.name')} required>
          <Input size="sm" value={sign.name} maxLength={200} onChange={(event) => actions?.onSignChange?.({ name: event.target.value })} />
        </Field>
        <Field label={t('sign.function')} required hint={t('sign.functionHint')}>
          <Input size="sm" value={sign.fn} maxLength={200} onChange={(event) => actions?.onSignChange?.({ fn: event.target.value })} />
        </Field>
        <p className="fw-tf-muted">{t('sign.code')}</p>
      </div>
    </Modal>
  )
}

export type { Hazard, ResidualRisk }
