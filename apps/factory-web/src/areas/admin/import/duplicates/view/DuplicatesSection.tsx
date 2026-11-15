'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Merge, UsersRound } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { MERGE_REASON, mergeReasonProblem, type DuplicateRecordType } from '@nexus/factory-domain/imports/duplicates/rules'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { BulkReach, useKeysHelp, useLatest, useSelection } from '../../../kit/list'
import { BulkButton } from '../../../shared/view/parts'
import type { DuplicatePair, DuplicateScan, MergePreview } from '../api'
import { likelihoodTone, NAMESPACE, pairHeld, reasonWords, refusalWords, type MergeAsk, type MergeNotice } from '../model'
import { DupMessages, ReasonTags, RecordLink } from './parts'

/**
 * "Possible duplicates" on Admin › Import & export (B-W2b-427, SCR-620; design admin.import "duplicate checks"): the pairs
 * of customers and suppliers, or of materials, that look alike — the older record first (the one usually kept) — with
 * their reasons and how likely. Each pair opens the merge dialog (Merge…); ticked pairs merge together after ONE confirm
 * that previews each (a pair that cannot merge is said with why and left out), one reason for all. Archived records are
 * never listed. The list frame: select-all, shift range, x/Space; keys only in the footer's information icon.
 */

export interface BulkMergeModel {
  readonly pairs: readonly DuplicatePair[]
  /** Each pair's preview, by key (missing while it loads; 'failed' when it could not be read). */
  readonly previews: Readonly<Record<string, MergePreview | 'failed'>>
  readonly busy: boolean
  readonly problem: string | null
}

export interface DuplicatesSectionModel {
  readonly recordType: DuplicateRecordType
  /** Which record types the person may see (their view permission). */
  readonly types: readonly DuplicateRecordType[]
  readonly scan: DuplicateScan | null
  readonly problem: string | null
  readonly loading: boolean
  readonly prefix: string
  readonly canMerge: boolean
  readonly selected: readonly string[]
  readonly bulk: BulkMergeModel | null
  readonly notice: MergeNotice | null
}

export interface DuplicatesSectionActions {
  onType?: (recordType: DuplicateRecordType) => void
  onRetry?: () => void
  onSelect?: (keys: string[]) => void
  onMerge?: (ask: MergeAsk) => void
  onBulk?: (keys: readonly string[] | null) => void
  onBulkGo?: (reason: string) => void
  onDismissNotice?: () => void
}

export function DuplicatesSection({ model, actions }: { model: DuplicatesSectionModel; actions?: DuplicatesSectionActions }) {
  if (model.types.length === 0) return null
  return (
    <DupMessages>
      <SectionInner model={model} actions={actions} />
    </DupMessages>
  )
}

function useColumns(model: DuplicatesSectionModel, actions?: DuplicatesSectionActions): ColDef<DuplicatePair>[] {
  const t = useT(NAMESPACE)
  const latest = useLatest(actions)
  const recordType = model.recordType
  return useMemo<ColDef<DuplicatePair>[]>(
    () => [
      {
        colId: 'kept',
        headerName: t('dup.list.col.kept'),
        flex: 1.4,
        minWidth: 200,
        valueGetter: ({ data }) => (data ? `${data.a.code} · ${data.a.name}` : ''),
        cellRenderer: ({ data }: ICellRendererParams<DuplicatePair>) => (data ? <RecordLink prefix={model.prefix} record={data.a} /> : null),
      },
      {
        colId: 'duplicate',
        headerName: t('dup.list.col.duplicate'),
        flex: 1.4,
        minWidth: 200,
        valueGetter: ({ data }) => (data ? `${data.b.code} · ${data.b.name}` : ''),
        cellRenderer: ({ data }: ICellRendererParams<DuplicatePair>) => (data ? <RecordLink prefix={model.prefix} record={data.b} /> : null),
      },
      {
        colId: 'why',
        headerName: t('dup.list.col.why'),
        flex: 2,
        minWidth: 240,
        autoHeight: true,
        valueGetter: ({ data }) =>
          data
            ? data.reasons
                .map((reason) => {
                  const words = reasonWords(reason)
                  return t(words.key, words.params)
                })
                .join(' · ')
            : '',
        cellRenderer: ({ data }: ICellRendererParams<DuplicatePair>) => (data ? <ReasonTags reasons={data.reasons} /> : null),
      },
      {
        colId: 'likelihood',
        headerName: t('dup.list.col.likelihood'),
        flex: 0.8,
        minWidth: 120,
        valueGetter: ({ data }) => (data ? t(`dup.likelihood.${data.likelihood}`) : ''),
        cellRenderer: ({ data }: ICellRendererParams<DuplicatePair>) =>
          data ? (
            <Pill tone={likelihoodTone(data.likelihood)}>
              {t(`dup.likelihood.${data.likelihood}`)}
            </Pill>
          ) : null,
      },
      {
        colId: 'actions',
        headerName: t('dup.list.col.actions'),
        flex: 0.8,
        minWidth: 120,
        sortable: false,
        pinned: 'right',
        cellRenderer: ({ data }: ICellRendererParams<DuplicatePair>) =>
          data ? (
            <Button
              size="sm"
              variant="quiet"
              heldReason={model.canMerge ? null : t('dup.held.noRight')}
              aria-label={t('dup.list.mergeOne', { dropped: data.b.code, kept: data.a.code })}
              onClick={() => latest.current?.onMerge?.({ recordType, kept: { id: data.a.id, code: data.a.code }, dropped: { id: data.b.id, code: data.b.code } })}
            >
              {t('dup.list.merge')}
            </Button>
          ) : null,
      },
    ],
    [t, model.prefix, model.canMerge, recordType, latest],
  )
}

function SectionInner({ model, actions }: { model: DuplicatesSectionModel; actions?: DuplicatesSectionActions }) {
  const t = useT(NAMESPACE)
  const pairs = model.scan?.pairs ?? null
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, (pairs ?? []).map((pair) => pair.key))
  const columns = useColumns(model, actions)
  const { onHelp, help } = useKeysHelp([], true)
  const picked = (pairs ?? []).filter((pair) => selected.includes(pair.key))
  const mergeable = picked.filter((pair) => pairHeld(pair, model.canMerge) === null)
  const bulkHeld = !model.canMerge ? t('dup.held.noRight') : mergeable.length === 0 ? t('dup.held.noneMergeable') : null
  let state: ReactNode
  if (model.problem && !pairs)
    state = (
      <EmptyState
        title={t('dup.list.failed')}
        description={t(model.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('dup.retry')}
          </Button>
        }
      />
    )
  else if (pairs && pairs.length === 0) state = <EmptyState icon={<UsersRound size={20} aria-hidden />} title={t(`dup.list.empty.${model.recordType}`)} description={t('dup.list.emptyBody')} />
  return (
    <section className="fw-dup-section" aria-labelledby="dup-list-title">
      <div className="fw-dup-head">
        <div className="fw-dup-head-text">
          <h2 id="dup-list-title" className="fw-dup-h2">
            {t('dup.list.title')}
          </h2>
          <p className="fw-dup-hint">{t('dup.list.intro')}</p>
        </div>
      </div>
      {model.notice && (
        <Banner tone={model.notice.tone} title={t(model.notice.refused === 0 ? 'dup.notice.merged' : model.notice.merged === 0 ? 'dup.notice.none' : 'dup.notice.partial', { count: model.notice.merged, merged: model.notice.merged, refused: model.notice.refused })} onDismiss={() => actions?.onDismissNotice?.()} />
      )}
      {model.loading && !pairs ? (
        <div className="fw-dup-skeleton" aria-busy="true">
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : (
        <ListFrame<DuplicatePair>
          label={t('dup.list.tableLabel')}
          rows={model.problem && !pairs ? [] : pairs}
          rowId={(pair) => pair.key}
          columns={columns}
          isRowSelectable={(pair) => {
            const why = pairHeld(pair, model.canMerge)
            return why ? t(why) : null
          }}
          count={model.scan ? t('dup.list.count', { count: model.scan.pairs.length, compared: model.scan.compared }) : '—'}
          tools={
            model.types.length > 1 ? (
              <SegmentedControl
                ariaLabel={t('dup.list.typeLabel')}
                size="sm"
                value={model.recordType}
                onChange={(value) => actions?.onType?.(value === 'MATERIAL' ? 'MATERIAL' : 'PARTY')}
                options={model.types.map((type) => ({ value: type, label: t(`dup.list.type.${type}`) }))}
              />
            ) : undefined
          }
          selection={{
            selected,
            onChange,
            actions: <BulkButton icon={<Merge size={13} aria-hidden />} label={t('dup.list.mergeMany', { count: mergeable.length })} held={bulkHeld} onClick={() => actions?.onBulk?.(mergeable.map((pair) => pair.key))} />,
          }}
          cards={{}}
          onHelp={onHelp}
          listKey={`admin.import.duplicates.${model.recordType.toLowerCase()}`}
          state={state}
        />
      )}
      {model.scan?.more && <p className="fw-dup-hint">{t('dup.list.more', { count: model.scan.pairs.length })}</p>}
      {model.problem && pairs && <Banner tone="danger" title={t(model.problem)} />}
      {help}
      <BulkMergeDialog model={model.bulk} recordType={model.recordType} actions={actions} />
    </section>
  )
}

/**
 * Merge N pairs after ONE confirm: each pair's preview (the older record stays), those that cannot merge said with
 * the first reason and left out, one reason kept with each merge.
 */
function BulkMergeDialog({ model, recordType, actions }: { model: BulkMergeModel | null; recordType: DuplicateRecordType; actions?: DuplicatesSectionActions }) {
  const t = useT(NAMESPACE)
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const key = model ? model.pairs.map((pair) => pair.key).join('|') : ''
  useEffect(() => {
    setReason('')
    setTouched(false)
  }, [key])
  if (!model) return null
  const previewOf = (key: string): MergePreview | 'failed' | undefined => model.previews[key]
  const loaded = model.pairs.every((pair) => previewOf(pair.key) !== undefined)
  const going = model.pairs.filter((pair) => {
    const preview = previewOf(pair.key)
    return preview !== undefined && preview !== 'failed' && preview.refusals.length === 0
  })
  const left = model.pairs.filter((pair) => previewOf(pair.key) !== undefined && !going.includes(pair))
  const whyLeft = (preview: MergePreview | 'failed' | undefined): string => {
    if (preview === undefined || preview === 'failed' || preview.refusals.length === 0) return t('dup.problem.other')
    const words = refusalWords(preview.refusals[0]!, preview)
    return t(words.key, words.params)
  }
  const problem = mergeReasonProblem(reason)
  const held = !loaded ? t('dup.held.loading') : going.length === 0 ? t('dup.held.noneMergeable') : model.busy ? t('dup.held.busy') : problem ? t('dup.held.reason') : null
  const close = () => actions?.onBulk?.(null)
  return (
    <Modal
      open
      onClose={close}
      title={t('dup.bulk.title', { count: going.length })}
      size="md"
      busy={model.busy}
      footer={
        <>
          <Button onClick={close}>{t('dup.merge.cancel')}</Button>
          <Button
            variant="danger"
            heldReason={held}
            onClick={() => {
              setTouched(true)
              if (!held) actions?.onBulkGo?.(reason.trim())
            }}
          >
            {t('dup.bulk.go', { count: going.length })}
          </Button>
        </>
      }
    >
      <div className="fw-dup-body">
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        <p className="fw-dup-p">{t(`dup.bulk.body.${recordType}`)}</p>
        {!loaded ? (
          <div className="fw-dup-skeleton" aria-busy="true">
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        ) : (
          <BulkReach
            label={t('dup.bulk.listLabel')}
            names={going.map((pair) => t('dup.bulk.line', { dropped: pair.b.code, kept: pair.a.code }))}
            left={left.map((pair) => {
              return { why: pair.key, count: 1, words: `${t('dup.bulk.line', { dropped: pair.b.code, kept: pair.a.code })}: ${whyLeft(previewOf(pair.key))}` }
            })}
          />
        )}
        <Field label={t('dup.merge.reason')} hint={t('dup.merge.reasonHint', { min: MERGE_REASON.min, max: MERGE_REASON.max })} error={touched && problem ? t('dup.held.reason') : undefined} required>
          <Textarea value={reason} rows={2} maxLength={MERGE_REASON.max} onChange={(event) => setReason(event.target.value)} onBlur={() => setTouched(true)} />
        </Field>
        <p className="fw-dup-hint">{t('dup.merge.never')}</p>
      </div>
    </Modal>
  )
}

