'use client'

import { createContext, useContext, useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, Scissors, Trash2 } from 'lucide-react'
import { childLotCodes } from '@nexus/factory-domain/inventory/lots-depth/split'
import { Banner, EmptyState, Field, Menu, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { quantity } from '../../../../_shared/stock/model'
import type { SplitHide, SplitRead } from '../api'
import { filledGroups, groupHides, hideRefusalKey, nextGroupKey, proposalLabel, regroupMoves, splitHeld, type DepthCan, type SplitDraft } from '../model'
import type { LotDepthActions, SplitDialog as Dialog } from '../view-model'
import '../depth.css'
import { useDepthWords, type DepthWords } from './DepthParts'

/**
 * B-W2b-320 — Split into shade groups (design warehouse.lots pop:lt-split, SCM-237; LT1:01): the family's hides in stock on the
 * shared list frame, each with its place, area, grade, its shade and what the incoming inspection said, and the group it goes
 * to — picked per hide, or for the selected hides at once ("Put N hides into ▾"). The groups come first from the newest
 * incoming inspection of the family (one per shade it gave, rejected and to-sort hides apart); each group names an article's
 * shade group or a label and becomes ONE child lot that keeps the parent link ("Create N child lots"). When the family has
 * child lots already, "Move between lots" moves hides into another lot of the family (regroup). A hide that cannot move says
 * why and cannot be picked. After it: the lots made and the NEW tags to print (each moved hide is a new hide row). The
 * hide-by-group picker is composed here (no DS part): a Select in the row through a context, as the transfers' picker.
 */

interface PickContext {
  draft: SplitDraft
  choices: { value: string; label: string }[]
  stay: string
  onPick: (hideId: string, to: string | null) => void
}
const HidePick = createContext<PickContext | null>(null)

function GroupCell({ data }: ICellRendererParams<SplitHide>) {
  const context = useContext(HidePick)
  if (!data || !context) return null
  if (data.refusal !== null) return null
  return (
    <Select size="sm" aria-label={data.code} value={context.draft.assign[data.id] ?? ''} onChange={(event) => context.onPick(data.id, event.target.value || null)}>
      <option value="">{context.stay}</option>
      {context.choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </Select>
  )
}

/** The name a group shows: its shade group's label, its typed label, or the inspection's "kept apart" words. */
function groupName(group: SplitDraft['groups'][number], read: SplitRead, t: DepthWords, index: number): string {
  const shade = group.shadeGroupId ? read.shadeGroups.find((choice) => choice.id === group.shadeGroupId) : null
  if (shade) return t('ld.split.groupShade', { label: shade.label })
  const apart = proposalLabel(group)
  if (apart) return t(apart.key)
  return group.label.trim() ? group.label.trim() : t('ld.split.groupN', { n: index + 1 })
}

export function SplitDialog({ model, can, prefix, actions }: { model: Dialog; can: Pick<DepthCan, 'manage'>; prefix: string; actions?: LotDepthActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const read = model.read.value
  const draft = model.draft
  const close = () => actions?.onSplit?.(false)
  const set = (next: SplitDraft) => actions?.onSplitDraft?.(next)
  const [selected, setSelected] = useState<readonly string[]>([])

  const columns = useMemo<ColDef<SplitHide>[]>(() => {
    const HideCell = ({ data }: ICellRendererParams<SplitHide>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-wl-code">{data.code}</span>
          <span className="fw-st-sub">{[data.lot.code, data.supplierCode].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const AreaCell = ({ data }: ICellRendererParams<SplitHide>) => (data ? <span className="fw-st-num">{`${quantity(data.area, locale)} ${t(`ld.uom.${data.areaUom}`)}`}</span> : null)
    const ShadeCell = ({ data }: ICellRendererParams<SplitHide>) =>
      data ? (
        <span className="fw-st-cell">
          <span>{data.shade ?? '—'}</span>
          <span className="fw-st-sub">{data.grade ? t('ld.split.grade', { grade: data.grade }) : ''}</span>
        </span>
      ) : null
    const SaidCell = ({ data }: ICellRendererParams<SplitHide>) => {
      if (!data) return null
      const refusal = hideRefusalKey(data.refusal)
      if (refusal) return <span className="fw-st-sub fw-st-warning">{t(refusal.key, refusal.params)}</span>
      if (!data.inspection) return <span className="fw-st-sub">{t('ld.split.noInspection')}</span>
      return (
        <span className="fw-st-cell">
          <span>{data.inspection.shade ?? (data.inspection.decision ? t(`ld.split.decision.${data.inspection.decision}`) : '—')}</span>
          <span className="fw-st-sub">{data.inspection.number}</span>
        </span>
      )
    }
    return [
      { colId: 'hide', headerName: t('ld.split.col.hide'), minWidth: 150, flex: 1.1, cellRenderer: HideCell },
      { colId: 'place', headerName: t('ld.split.col.place'), minWidth: 110, flex: 0.8, valueGetter: (params) => params.data?.location?.code ?? '—' },
      { colId: 'area', headerName: t('ld.split.col.area'), minWidth: 100, flex: 0.6, type: 'rightAligned', cellRenderer: AreaCell },
      { colId: 'shade', headerName: t('ld.split.col.shade'), minWidth: 110, flex: 0.7, cellRenderer: ShadeCell },
      { colId: 'said', headerName: t('ld.split.col.said'), minWidth: 170, flex: 1.2, cellRenderer: SaidCell },
      { colId: 'group', headerName: t('ld.split.col.group'), minWidth: 200, flex: 1.2, sortable: false, cellRenderer: GroupCell },
    ]
  }, [t, locale])

  const footer = (
    <>
      <span className="fw-wl-hint">{draft?.mode === 'regroup' ? t('ld.split.footRegroup') : t('ld.split.foot')}</span>
      <span className="grow" />
      <Button size="sm" onClick={close}>
        {model.done ? t('ld.common.close') : t('ld.common.cancel')}
      </Button>
      {read && draft && !model.done && (
        <Button size="sm" variant="primary" heldReason={say(splitHeld(read, draft, can, model.busy))} onClick={() => actions?.onConfirmSplit?.()}>
          {model.busy ? <Spinner size={12} /> : <Scissors size={13} aria-hidden />}{' '}
          {draft.mode === 'regroup' ? t('ld.split.move', { count: regroupMoves(read, draft).length }) : t('ld.split.create', { count: filledGroups(read, draft).length })}
        </Button>
      )}
    </>
  )

  return (
    <Modal open onClose={close} title={read ? t('ld.split.title', { code: read.parent.code }) : t('ld.split.titleShort')} size="xl" footer={footer}>
      <div className="fw-ld-dialog">
        {model.problem && <Banner tone="danger" title={say(model.problem) ?? ''} />}
        {!read ? (
          model.read.problem ? (
            <EmptyState
              title={t('ld.split.readFailed')}
              description={t('ld.common.tryAgainLater')}
              action={
                <Button size="sm" onClick={() => actions?.onRetrySplit?.()}>
                  {t('ld.common.retry')}
                </Button>
              }
            />
          ) : (
            <p className="fw-wl-hint" role="status">
              <Spinner size={12} /> {t('ld.common.reading')}
            </p>
          )
        ) : model.done ? (
          <Done model={model} read={read} prefix={prefix} />
        ) : draft ? (
          <Body read={read} draft={draft} set={set} columns={columns} selected={selected} setSelected={setSelected} />
        ) : null}
      </div>
    </Modal>
  )
}

function Body({ read, draft, set, columns, selected, setSelected }: { read: SplitRead; draft: SplitDraft; set: (next: SplitDraft) => void; columns: ColDef<SplitHide>[]; selected: readonly string[]; setSelected: (ids: readonly string[]) => void }) {
  const { t } = useDepthWords()
  const family = read.lots.length > 1
  const hides = groupHides(draft, read.hides)
  const filled = filledGroups(read, draft)
  const codes = childLotCodes(read.parent.code, read.lots.map((lot) => lot.code), filled.length)
  const codeOf = (key: string) => codes[filled.findIndex((group) => group.key === key)] ?? null
  const choices =
    draft.mode === 'regroup'
      ? read.lots.map((lot) => ({ value: lot.id, label: t('ld.split.intoLot', { code: lot.code }) }))
      : draft.groups.map((group, index) => ({ value: group.key, label: groupName(group, read, t, index) }))
  const assign = (ids: readonly string[], to: string | null) => {
    const next = { ...draft.assign }
    for (const id of ids) {
      if (to) next[id] = to
      else delete next[id]
    }
    set({ ...draft, assign: next })
  }
  const shadeChoices = read.shadeGroups.filter((choice) => choice.active)
  return (
    <>
      {family && (
        <SegmentedControl
          ariaLabel={t('ld.split.modeLabel')}
          size="sm"
          value={draft.mode}
          onChange={(value) => set({ ...draft, mode: value as SplitDraft['mode'], assign: {} })}
          options={[
            { value: 'split', label: t('ld.split.modeSplit') },
            { value: 'regroup', label: t('ld.split.modeRegroup') },
          ]}
        />
      )}
      <p className="fw-wl-hint">
        {read.proposal.inspection && draft.mode === 'split' && read.proposal.groups.length > 0 ? t('ld.split.fromInspection', { number: read.proposal.inspection.number }) : t('ld.split.intro')}
        {family ? ` ${t('ld.split.family', { lots: read.lots.map((lot) => lot.code).join(', ') })}` : ''}
      </p>
      {draft.mode === 'split' && (
        <section className="fw-wl-stack tight" aria-label={t('ld.split.groups')}>
          <div className="fw-wl-card-head">
            <h3 className="fw-wl-h3">{t('ld.split.groups')}</h3>
            <Button size="sm" heldReason={draft.groups.length >= 26 ? t('ld.split.held.tooMany') : null} onClick={() => set({ ...draft, groups: [...draft.groups, { key: nextGroupKey(draft), shadeGroupId: shadeChoices[0]?.id ?? null, label: '' }] })}>
              <Plus size={13} aria-hidden /> {t('ld.split.addGroup')}
            </Button>
          </div>
          {draft.groups.length === 0 ? (
            <p className="fw-wl-hint">{t('ld.split.noGroups')}</p>
          ) : (
            <ul className="fw-wl-checks">
              {draft.groups.map((group, index) => (
                <li key={group.key} className="fw-ld-group">
                  <Field label={t('ld.split.shadeGroup')}>
                    <Select
                      size="sm"
                      value={group.shadeGroupId ?? ''}
                      onChange={(event) => set({ ...draft, groups: draft.groups.map((entry) => (entry.key === group.key ? { ...entry, shadeGroupId: event.target.value || null } : entry)) })}
                    >
                      <option value="">{t('ld.split.ownLabel')}</option>
                      {shadeChoices.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.outOfShade ? t('ld.split.outOfShade', { label: choice.label }) : choice.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {!group.shadeGroupId && (
                    <Field label={t('ld.split.label')}>
                      <Input size="sm" value={group.label} maxLength={60} onChange={(event) => set({ ...draft, groups: draft.groups.map((entry) => (entry.key === group.key ? { ...entry, label: event.target.value } : entry)) })} />
                    </Field>
                  )}
                  <span className="fw-st-cell">
                    <span>{t('ld.split.holds', { count: hides.get(group.key)?.length ?? 0 })}</span>
                    <span className="fw-st-sub">{codeOf(group.key) ? t('ld.split.becomes', { code: codeOf(group.key)! }) : t('ld.split.empty')}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={t('ld.split.removeGroup', { name: groupName(group, read, t, index) })}
                    onClick={() => set({ ...draft, groups: draft.groups.filter((entry) => entry.key !== group.key), assign: Object.fromEntries(Object.entries(draft.assign).filter(([, to]) => to !== group.key)) })}
                  >
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <HidePick.Provider value={{ draft, choices, stay: t('ld.split.stays'), onPick: (hideId, to) => assign([hideId], to) }}>
        <ListFrame<SplitHide>
          label={t('ld.split.hidesLabel')}
          rows={read.hides}
          rowId={(row) => row.id}
          columns={columns}
          count={t('ld.split.hidesCount', { count: read.hides.length, movable: read.hides.filter((hide) => hide.refusal === null).length })}
          listKey={null}
          cards={null}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Menu
                label={t(draft.mode === 'regroup' ? 'ld.split.moveSelected' : 'ld.split.putSelected', { count: selected.length })}
                align="right"
                items={[
                  ...choices.map((choice) => ({ id: choice.value, label: choice.label, onSelect: () => assign(selected, choice.value) })),
                  { id: 'stay', label: t('ld.split.stays'), onSelect: () => assign(selected, null) },
                ]}
              />
            ),
          }}
          isRowSelectable={(row) => {
            const refusal = hideRefusalKey(row.refusal)
            return refusal ? t(refusal.key, refusal.params) : null
          }}
          state={read.hides.length === 0 ? <EmptyState title={t('ld.split.noHides')} description={t('ld.split.noHidesBody')} /> : undefined}
        />
      </HidePick.Provider>
      <Field label={t('ld.split.note')}>
        <Textarea value={draft.note} maxLength={500} rows={2} onChange={(event) => set({ ...draft, note: event.target.value })} />
      </Field>
    </>
  )
}

/** What the split made: the lots, and each moved hide's NEW tag (the old tag holds nothing now) with where to print it. */
function Done({ model, read, prefix }: { model: Dialog; read: SplitRead; prefix: string }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const done = model.done!
  const made = done.lots.filter((lot) => lot.made)
  return (
    <div className="fw-wl-stack">
      <Banner tone="success" title={made.length > 0 ? t('ld.split.doneMade', { count: made.length, codes: made.map((lot) => lot.code).join(', ') }) : t('ld.split.doneMoved', { count: done.hides.length })}>
        {t('ld.split.retag')}
      </Banner>
      <SummaryTable
        label={t('ld.split.newTags')}
        columns={[t('ld.split.col.oldTag'), t('ld.split.col.newTag'), t('ld.split.col.lot'), t('ld.split.col.area'), t('ld.split.col.shade')]}
        align={['left', 'left', 'left', 'right', 'left']}
        stackOnPhone
        rows={done.hides.map((hide) => ({
          id: hide.hideId,
          cells: [hide.fromCode, <b key="n" className="fw-wl-code">{hide.code}</b>, hide.lot.code, `${quantity(hide.area, locale)} ${t(`ld.uom.${hide.areaUom}`)}`, hide.shade ?? '—'],
        }))}
      />
      <span className="fw-st-actions">
        {[...new Map(done.hides.map((hide) => [hide.lot.id, hide.lot])).values()].map((lot) => (
          <Button key={lot.id} size="sm" asChild>
            <Link href={`${prefix}/warehouse/hides?lot=${encodeURIComponent(lot.id)}&view=all`}>{t('ld.split.printTags', { code: lot.code })}</Link>
          </Button>
        ))}
        <Tag tone="neutral">{t('ld.split.parentNow', { code: read.parent.code })}</Tag>
      </span>
    </div>
  )
}
