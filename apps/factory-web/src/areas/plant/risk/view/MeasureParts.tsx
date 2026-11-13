'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { CheckCircle2, Paperclip, XCircle } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, FileDropzone, FileRow, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Assessment, Measure, Owner } from '../api'
import { atField, measureChanged, measureProblems, moveAsks, moveHeld, MEASURE_SOURCES, sourceWords, versionNo, type MeasureStatus } from '../model'
import type { CellState, MeasureActions, MeasureDialogState, MoveState, Read, RiskFrame } from '../view-model'
import { CellMark, problemText, StatusPill, useCost, useDay, useWhen, useWords } from './parts'
import { MultiSelect } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/** What the measure columns need from the page or the record. */
export interface MeasureColumnsInput {
  readonly frame: RiskFrame
  readonly cells: Readonly<Record<string, CellState>>
  readonly owners: Read<readonly Owner[]> | null
  /** The page with "All sites": a Site column. */
  readonly site: boolean
  /** The record's plan tab: the evidence column. */
  readonly evidence: boolean
  /** Where a measure's name leads: a link (the page: its assessment's plan tab) or its window (the record). */
  readonly hrefOf?: ((measure: Measure) => string) | undefined
  readonly onTitle?: ((measure: Measure) => void) | undefined
  readonly actions?: MeasureActions | undefined
}

/**
 * The improvement plan's columns (design sec measures and the record's plan tab; QHS-234, art. 28 c.2 c-d): Measure (with its
 * roles), Site (All sites), Risk or area, Owner, Due (the DS DueCell), Cost (the cost grain only: without it the column is
 * withheld and said in Columns ▾), Status, Evidence (the record) and Source (the DVR's version, an incident, an inspection, a
 * meeting). Owner, due and status edit in their cells (autosaved, each cell's save mark): owner and due for the measures the
 * person keeps (safety.risk.manage), the status for its owner too (the states the API says they may choose); a move to done
 * or cancelled asks first. A person's name only as a measure's owner (inside one measure, never a filter or a total).
 */
export function useMeasureColumns({ frame, cells, owners, site, evidence, hrefOf, onTitle, actions }: MeasureColumnsInput): ColDef<Measure>[] {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const cost = useCost()
  const act = useRef(actions)
  act.current = actions
  const ownerList = owners?.status === 'ready' ? owners.value : null
  const open = useRef({ hrefOf, onTitle })
  open.current = { hrefOf, onTitle }

  return useMemo<ColDef<Measure>[]>(() => {
    const editable = (row: Measure) => frame.can.manage && row.canManage && row.status !== 'VERIFIED' && row.status !== 'CANCELLED'
    const TitleCell = ({ data }: ICellRendererParams<Measure>) =>
      data ? (
        <span className="fw-rk-cell">
          {open.current.hrefOf ? (
            <Link href={open.current.hrefOf(data)} className="fw-rk-strong">
              {data.title}
            </Link>
          ) : open.current.onTitle ? (
            <Button size="sm" variant="quiet" className="fw-rk-link" onClick={() => open.current.onTitle?.(data)}>
              {data.title}
            </Button>
          ) : (
            <span className="fw-rk-strong">{data.title}</span>
          )}
          {data.roleSheets.length > 0 && <span className="fw-rk-muted">{data.roleSheets.map((sheet) => sheet.name).join(', ')}</span>}
        </span>
      ) : null
    const OwnerCell = ({ data }: ICellRendererParams<Measure>) => {
      if (!data) return null
      if (!editable(data)) return <span className="fw-rk-ellipsis">{data.owner ?? t('owner.none')}</span>
      const known = ownerList ?? []
      return (
        <span className="fw-rk-row">
          <Select
            size="sm"
            aria-label={t('cell.owner', { measure: data.title })}
            value={data.ownerId ?? ''}
            onFocus={() => (owners === null || owners.status === 'error') && act.current?.onRetryOwners?.()}
            onChange={(event) => act.current?.onMeasureEdit?.(data, { ownerId: event.target.value || null }, 'owner')}
          >
            <option value="">{t('owner.none')}</option>
            {data.ownerId && !known.some((owner) => owner.id === data.ownerId) && <option value={data.ownerId}>{data.owner ?? t('owner.someone')}</option>}
            {known.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.me ? t('owner.me', { name: owner.name }) : owner.name}
              </option>
            ))}
          </Select>
          <CellMark cell={cells[`${data.id}:owner`]} />
        </span>
      )
    }
    const DueCellView = ({ data }: ICellRendererParams<Measure>) => {
      if (!data) return null
      const due = <DueCell value={{ due: data.dueOn, state: data.status === 'DONE' || data.status === 'VERIFIED' ? 'done' : null, doneOn: data.doneAt }} today={frame.today} formatDate={(iso) => day(iso)} labels={{ ...ds.dueCell, validUntil: (text) => t('due.on', { date: text }), none: t('due.none') }} />
      if (!editable(data)) return due
      return (
        <span className="fw-rk-cell">
          <span className="fw-rk-row">
            <Input
              size="sm"
              type="date"
              aria-label={t('cell.due', { measure: data.title })}
              defaultValue={data.dueOn ?? ''}
              key={`${data.id}:${data.version}`}
              onBlur={(event) => {
                const next = event.target.value || null
                if (next !== (data.dueOn ?? null)) act.current?.onMeasureEdit?.(data, { dueOn: next }, 'due')
              }}
            />
            <CellMark cell={cells[`${data.id}:due`]} />
          </span>
          {data.dueOn && (data.dueState === 'OVERDUE' || data.dueState === 'DUE_SOON') ? due : null}
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<Measure>) => {
      if (!data) return null
      if (data.canMove.length === 0) return <StatusPill status={data.status} />
      return (
        <span className="fw-rk-row">
          <Select size="sm" aria-label={t('cell.status', { measure: data.title })} value={data.status} onChange={(event) => act.current?.onMeasureMove?.(data, event.target.value as MeasureStatus)}>
            <option value={data.status}>{t(`status.${data.status}`)}</option>
            {data.canMove.map((to) => (
              <option key={to} value={to}>
                {t(`move.${to}`)}
              </option>
            ))}
          </Select>
          <CellMark cell={cells[`${data.id}:status`]} />
        </span>
      )
    }
    const SourceCell = ({ data }: ICellRendererParams<Measure>) => {
      if (!data) return null
      const words = sourceWords(data)
      return <span>{t(words.key, words.params)}</span>
    }
    const EvidenceCell = ({ data }: ICellRendererParams<Measure>) =>
      data ? (
        <span className="fw-rk-cell">
          {data.evidence.length > 0 ? (
            <span className="fw-rk-row">
              <Paperclip size={12} aria-hidden /> {t('evidence.files', { count: data.evidence.length })}
            </span>
          ) : null}
          {data.evidenceNote ? <span className="fw-rk-muted fw-rk-ellipsis">{data.evidenceNote}</span> : data.evidence.length === 0 ? <span className="fw-rk-muted">—</span> : null}
        </span>
      ) : null

    const columns: ColDef<Measure>[] = [
      { colId: 'title', headerName: t('measures.col.title'), minWidth: 240, flex: 1.8, valueGetter: (params) => params.data?.title ?? '', cellRenderer: TitleCell },
      ...(site ? [{ colId: 'site', headerName: t('measures.col.site'), minWidth: 130, flex: 0.7, valueGetter: (params: { data?: Measure }) => (params.data ? params.data.site.name : '') } as ColDef<Measure>] : []),
      { colId: 'risk', headerName: t('measures.col.risk'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.risk ?? '—') : '') },
      { colId: 'owner', headerName: t('measures.col.owner'), minWidth: frame.can.manage ? 190 : 140, flex: 1, valueGetter: (params) => (params.data ? (params.data.owner ?? '') : ''), cellRenderer: OwnerCell },
      { colId: 'due', headerName: t('measures.col.due'), minWidth: frame.can.manage ? 190 : 150, flex: 0.9, valueGetter: (params) => params.data?.dueOn ?? '', cellRenderer: DueCellView },
      ...(frame.can.cost ? [{ colId: 'cost', headerName: t('measures.col.cost'), minWidth: 110, flex: 0.6, cellClass: 'fw-rk-num', valueGetter: (params: { data?: Measure }) => (params.data ? cost(params.data.cost, params.data.currency) : '') } as ColDef<Measure>] : []),
      { colId: 'status', headerName: t('measures.col.status'), minWidth: 170, flex: 0.9, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: StatusCell },
      ...(evidence ? [{ colId: 'evidence', headerName: t('measures.col.evidence'), minWidth: 150, flex: 0.9, sortable: false, valueGetter: (params: { data?: Measure }) => params.data?.evidenceNote ?? '', cellRenderer: EvidenceCell } as ColDef<Measure>] : []),
      { colId: 'source', headerName: t('measures.col.source'), minWidth: 130, flex: 0.7, valueGetter: (params) => (params.data ? t(sourceWords(params.data).key, sourceWords(params.data).params) : ''), cellRenderer: SourceCell },
    ]
    return columns
  }, [t, ds, day, cost, frame.can.manage, frame.can.cost, frame.today, ownerList, owners, site, evidence, cells])
}

/** The cost column held back without the cost grain (Columns ▾ says it). */
export const withheldCost = (t: (key: string) => string, seesCost: boolean) => (seesCost ? [] : [{ label: t('measures.col.cost'), reason: t('held.costGrain') }])

/**
 * Add measure (design pop:measure: "Measure · risk · roles · owner · due · cost · source", `c`) and a measure's own window
 * (the same form, its evidence files and its state). The assessment first (with "All sites" or from the page: the site's
 * assessment is chosen here), its site's roles to name, the owner (who may read the safety pages), the due day, the cost
 * (only with the cost grain), the source (the DVR's version in force or waiting; an incident is added from its own record).
 */
export function MeasureDialog({ frame, state, assessments, actions }: { frame: RiskFrame; state: MeasureDialogState; assessments: readonly Assessment[] | null; actions?: MeasureActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const when = useWhen()
  const { draft } = state
  const edit = state.mode === 'edit'
  const measure = edit && state.read?.status === 'ready' ? state.read.value.measure : null
  const set = (change: Partial<typeof draft>) => actions?.onMeasureDraft?.({ ...draft, ...change })
  const assessment = assessments?.find((row) => row.id === draft.assessmentId) ?? null
  const problems = measureProblems(draft, frame.today, frame.can.cost, !edit)
  const final = measure ? measure.status === 'VERIFIED' || measure.status === 'CANCELLED' : false
  const held = !frame.can.manage ? 'held.manage' : state.busy ? 'held.saving' : problems[0]?.key ?? (measure && !measureChanged(measure, draft, frame.can.cost, locale) ? 'held.nothingChanged' : null)
  const error = (...fields: string[]) => {
    const key = atField(state.problem, ...fields)
    return key ? t(key) : undefined
  }
  const sheets = state.sheets?.status === 'ready' ? state.sheets.value : []
  const owners = state.owners?.status === 'ready' ? state.owners.value : []
  const close = () => actions?.onMeasureClose?.()
  const loading = edit && (!state.read || state.read.status === 'loading')
  const failed = edit && state.read?.status === 'error' ? state.read.problem : null

  return (
    <Modal
      open
      onClose={close}
      title={edit ? (measure?.title ?? t('measure.title')) : t('measure.addTitle')}
      subtitle={edit && measure ? `${measure.assessment} · ${measure.site.name}` : t('measure.addSubtitle')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          {!final && (
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onMeasureSave?.()}>
              {state.busy ? <Spinner size={14} /> : null} {edit ? t('measure.save') : t('measure.add')}
            </Button>
          )}
        </>
      }
    >
      {loading ? (
        <p className="fw-rk-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : failed ? (
        <Banner tone="warning" title={t('measure.failed')}>
          {t(failed)}
        </Banner>
      ) : (
        <div className="fw-rk-form">
          {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
          {final && measure && <Banner tone="info" title={t('measure.final', { status: t(`status.${measure.status}`) })} />}
          {!edit && (
            <Field label={t('measure.assessment')} required error={error('assessmentId')}>
              <Select value={draft.assessmentId ?? ''} onChange={(event) => set({ assessmentId: event.target.value || null, roleSheetIds: [], versionId: null })} aria-label={t('measure.assessment')}>
                <option value="">{t('measure.chooseAssessment')}</option>
                {(assessments ?? []).map((row) => (
                  <option key={row.id} value={row.id}>{`${row.name} · ${row.site.name}`}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('measure.what')} required hint={t('measure.whatHint')} error={error('title')}>
            <Input value={draft.title} maxLength={300} disabled={final} onChange={(event) => set({ title: event.target.value })} />
          </Field>
          <div className="fw-rk-form-row">
            <Field label={t('measure.risk')} hint={t('measure.riskHint')} error={error('risk')}>
              <Input value={draft.risk} maxLength={300} disabled={final} onChange={(event) => set({ risk: event.target.value })} />
            </Field>
            <Field label={t('measure.roles')} hint={draft.assessmentId ? undefined : t('measure.rolesAfter')} error={error('roleSheetIds')}>
              <MultiSelect
                options={sheets.map((sheet) => ({ value: sheet.id, label: `${sheet.name} (${sheet.code})` }))}
                value={draft.roleSheetIds}
                onChange={(next) => set({ roleSheetIds: next })}
                placeholder={state.sheets?.status === 'loading' ? t('common.reading') : t('measure.noRoles')}
                ariaLabel={t('measure.roles')}
                formatLabel={(value) => t('measure.rolesChosen', { count: value.length })}
              />
            </Field>
          </div>
          <div className="fw-rk-form-row">
            <Field label={t('measure.owner')} hint={t('measure.ownerHint')} error={error('ownerId')}>
              <Select value={draft.ownerId ?? ''} disabled={final} onChange={(event) => set({ ownerId: event.target.value || null })} aria-label={t('measure.owner')}>
                <option value="">{t('owner.none')}</option>
                {measure?.ownerId && !owners.some((owner) => owner.id === measure.ownerId) && <option value={measure.ownerId}>{measure.owner ?? t('owner.someone')}</option>}
                {owners.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.me ? t('owner.me', { name: owner.name }) : owner.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('measure.due')} hint={t('measure.dueHint')} error={error('dueOn')}>
              <DateField value={draft.dueOn} disabled={final} clearable onChange={(value) => set({ dueOn: value })} ariaLabel={t('measure.due')} />
            </Field>
            {frame.can.cost ? (
              <Field label={t('measure.cost', { currency: measure?.currency ?? 'EUR' })} hint={t('measure.costHint')} error={error('cost')}>
                <Input value={draft.cost} inputMode="decimal" disabled={final} onChange={(event) => set({ cost: event.target.value })} />
              </Field>
            ) : (
              <p className="fw-rk-muted fw-rk-field-note">{t('measure.costHidden')}</p>
            )}
          </div>
          {!edit ? (
            <div className="fw-rk-form-row">
              <Field label={t('measure.source')} error={error('source')}>
                <Select value={draft.source} onChange={(event) => set({ source: event.target.value as typeof draft.source, versionId: null })} aria-label={t('measure.source')}>
                  {MEASURE_SOURCES.filter((source) => source !== 'INCIDENT').map((source) => (
                    <option key={source} value={source}>
                      {t(`source.${source}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.source === 'DVR' && (
                <Field label={t('measure.version')} hint={assessment && !assessment.inForce && !assessment.waiting ? t('measure.noVersion') : undefined} error={error('versionId')}>
                  <Select value={draft.versionId ?? ''} onChange={(event) => set({ versionId: event.target.value || null })} aria-label={t('measure.version')}>
                    <option value="">{t('measure.versionDefault')}</option>
                    {assessment?.inForce && <option value={assessment.inForce.id}>{t('measure.versionInForce', { version: versionNo(assessment.inForce) })}</option>}
                    {assessment?.waiting && <option value={assessment.waiting.id}>{t('measure.versionWaiting', { version: versionNo(assessment.waiting) })}</option>}
                  </Select>
                </Field>
              )}
              <Field label={t('measure.startAs')}>
                <Select value={draft.status} onChange={(event) => set({ status: event.target.value as 'PLANNED' | 'IN_PROGRESS' })} aria-label={t('measure.startAs')}>
                  <option value="PLANNED">{t('status.PLANNED')}</option>
                  <option value="IN_PROGRESS">{t('status.IN_PROGRESS')}</option>
                </Select>
              </Field>
            </div>
          ) : measure ? (
            <p className="fw-rk-muted">{t('measure.fromSource', { source: t(sourceWords(measure).key, sourceWords(measure).params) })}</p>
          ) : null}
          <Field label={t('measure.note')} error={error('note')}>
            <Textarea value={draft.note} rows={2} onChange={(event) => set({ note: event.target.value })} />
          </Field>
          {!edit && <p className="fw-rk-muted">{t('measure.incidentNote')}</p>}
          {measure && (
            <section className="fw-rk-stack" aria-labelledby="fw-rk-measure-state">
              <h3 id="fw-rk-measure-state" className="fw-rk-h3">
                {t('measure.state')}
              </h3>
              <p>
                <StatusPill status={measure.status} />{' '}
                {measure.doneAt && <span className="fw-rk-muted">{t('measure.doneBy', { date: when(measure.doneAt), person: measure.doneBy ?? '—' })}</span>}{' '}
                {measure.verifiedAt && <span className="fw-rk-muted">{t('measure.verifiedBy', { date: when(measure.verifiedAt), person: measure.verifiedBy ?? '—' })}</span>}
                {measure.cancelledAt && <span className="fw-rk-muted">{t('measure.cancelledBy', { date: when(measure.cancelledAt), reason: measure.cancelReason ?? '—' })}</span>}
              </p>
              {measure.evidenceNote && <p>{measure.evidenceNote}</p>}
              {measure.canMove.length > 0 && (
                <span className="fw-rk-row">
                  {measure.canMove.map((to) => (
                    <Button key={to} size="sm" onClick={() => actions?.onMeasureMove?.(measure, to)}>
                      {to === 'VERIFIED' ? <CheckCircle2 size={13} aria-hidden /> : to === 'CANCELLED' ? <XCircle size={13} aria-hidden /> : null} {t(`move.${to}`)}
                    </Button>
                  ))}
                </span>
              )}
              <h3 className="fw-rk-h3">{t('evidence.title')}</h3>
              {measure.evidence.length === 0 ? (
                <p className="fw-rk-muted">{t('evidence.none')}</p>
              ) : (
                measure.evidence.map((file) => (
                  <FileRow
                    key={file.fileId}
                    name={file.name}
                    actions={
                      <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(file.fileId)}>
                        {t('common.open')}
                      </Button>
                    }
                  />
                ))
              )}
              {state.read?.status === 'ready' && state.read.value.canUpload ? (
                <>
                  <FileDropzone onFiles={(files) => actions?.onMeasureEvidence?.(files)} accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" maxBytes={25 * 1024 * 1024} multiple disabled={state.uploading} hint={t('evidence.hint')} />
                  {state.uploading && (
                    <p className="fw-rk-muted" role="status">
                      <Spinner size={14} /> {t('common.uploading')}
                    </p>
                  )}
                </>
              ) : (
                <p className="fw-rk-muted">{t('held.upload')}</p>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  )
}

/** A move that asks first: done (what was done, evidence files) or cancelled (why). */
export function MoveDialog({ state, actions }: { state: MoveState; actions?: MeasureActions | undefined }) {
  const t = useWords()
  const asks = moveAsks(state.to)
  const held = moveHeld(state.to, state, state.busy)
  const close = () => actions?.onMoveClose?.()
  return (
    <Modal
      open
      onClose={close}
      title={t(`moveTitle.${state.to}`, { measure: state.measure.title })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onMoveApply?.()}>
            {state.busy ? <Spinner size={14} /> : null} {t(`move.${state.to}`)}
          </Button>
        </>
      }
    >
      <div className="fw-rk-form">
        {state.problem && <Banner tone="danger" title={problemText(t, state.problem) ?? ''} />}
        {asks === 'evidence' ? (
          <>
            <Field label={t('move.evidenceNote')} hint={t('move.evidenceHint')}>
              <Textarea value={state.evidenceNote} rows={3} onChange={(event) => actions?.onMoveDraft?.({ evidenceNote: event.target.value })} />
            </Field>
            <FileDropzone onFiles={(files) => actions?.onMoveFiles?.(files)} accept=".pdf,.jpg,.jpeg,.png,.webp,.heic" maxBytes={25 * 1024 * 1024} multiple disabled={state.busy} hint={t('evidence.hint')} />
            {state.files.length > 0 && (
              <ul className="fw-rk-list">
                {state.files.map((file) => (
                  <li key={file.name}>{file.name}</li>
                ))}
              </ul>
            )}
          </>
        ) : asks === 'reason' ? (
          <Field label={t('move.reason')} required>
            <Textarea value={state.reason} rows={3} onChange={(event) => actions?.onMoveDraft?.({ reason: event.target.value })} />
          </Field>
        ) : null}
        <p className="fw-rk-muted">{t(`moveNote.${state.to}`)}</p>
      </div>
    </Modal>
  )
}
