'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Boxes, MoreHorizontal, Plus, Power } from 'lucide-react'
import { EmptyState, Field, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Words } from '../../../shipments/queue/shared/depth'
import { DepthDialog, PartRead } from '../../../shipments/queue/shared/DepthDialog'
import { DISPATCH_NAMESPACES, DISPATCH_NS, kilograms } from '../../../shipments/pickup/dispatch'
import type { PackagingDefault, PackagingType } from '../api'
import { defaultProblem, innerSize, manageHeld, PACKAGING_KINDS, PACKAGING_NAME_MAX, PALLET_KINDS, scopeOf, typeFormOf, typeProblems, type PackagingActions, type PackagingDialog, type PackagingModel, type TypeField, type TypeForm } from '../model'
import { SettingsCard } from '../../test-mode/settings-card'
import '../../../shipments/queue/shared/depth.css'
import '../../shipping-setup.css'

/**
 * SCR-657 — Carriers & shipping › Packaging (B-W2b-412 on B-W2b-384; LOG-008; design warehouse.shipping sec sp-packaging): the
 * company's carton, box and pallet types — name, inner size, own weight (tare), the most it may weigh full, the pallet's kind;
 * the cost per unit only with the cost grain — in the shared list frame (select-all, shift range, x; Switch off N / Switch on
 * N; switched off, never deleted), Add a type and Edit; then the defaults per style or size run (which type a packer is offered
 * first), Add a default, Change type, Switch off.
 */
export function PackagingView({ model, actions }: { model: PackagingModel; actions?: PackagingActions }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function useWords() {
  const t = useT(DISPATCH_NS)
  return { t, say: (value: Words | null | undefined) => (value ? t(value.key, value.params) : null) }
}

function Body({ model, actions }: { model: PackagingModel; actions?: PackagingActions }) {
  const { t, say } = useWords()
  const held = say(manageHeld(model.can, model.busy))
  // B-W2b-F56: a role without shipping.view (an administrator opens Carriers & shipping by shipping.settings.view): the card
  // says so in words and the page asks nothing of what the role may not read.
  if (!model.can.view) {
    return (
      <SettingsCard id="packaging" wide icon={<Boxes size={16} aria-hidden />} title={t('packaging.title')} intro={t('packaging.intro')}>
        <EmptyState title={t('packaging.held.noView')} description={t('packaging.held.noViewBody')} />
      </SettingsCard>
    )
  }
  return (
    <SettingsCard id="packaging" wide icon={<Boxes size={16} aria-hidden />} title={t('packaging.title')} intro={t('packaging.intro')} done={model.done} problem={model.dialog ? null : model.problem} onDismiss={actions?.onDismiss}>
      <TypesList model={model} actions={actions} held={held} />
      <DefaultsList model={model} actions={actions} held={held} />
      {!model.can.packaging && <p className="fw-shipset-hint">{t('packaging.held.noRight')}</p>}
      {model.dialog && <PackagingDialogView model={model} dialog={model.dialog} actions={actions} />}
    </SettingsCard>
  )
}

function TypesList({ model, actions, held }: { model: PackagingModel; actions?: PackagingActions; held: string | null }) {
  const { t } = useWords()
  const locale = useLocale()
  const rows = model.types.state === 'ready' ? [...model.types.value].sort((a, b) => Number(b.active) - Number(a.active) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) : null
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const ids = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => ids.includes(id))), [ids])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const columns = useMemo<ColDef<PackagingType>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<PackagingType>) =>
      data ? (
        <span className="fw-sh-cell">
          <span>{data.name}</span>
          <span className="fw-sh-cell-sub">{t(`packaging.kind.${data.kind}`)}</span>
        </span>
      ) : null
    const SizeCell = ({ data }: ICellRendererParams<PackagingType>) => (data ? <span>{innerSize(data, locale) ? t('packaging.cm', { size: innerSize(data, locale)! }) : '—'}</span> : null)
    const kg = (value: string | null) => (kilograms(value, locale) ? t('packaging.kg', { value: kilograms(value, locale)! }) : '—')
    const TareCell = ({ data }: ICellRendererParams<PackagingType>) => (data ? <span>{kg(data.tareKg)}</span> : null)
    const MaxCell = ({ data }: ICellRendererParams<PackagingType>) => (data ? <span>{kg(data.maxWeightKg)}</span> : null)
    const PalletCell = ({ data }: ICellRendererParams<PackagingType>) => (data ? <span>{data.palletKind ? t(`packaging.pallet.${data.palletKind}`) : '—'}</span> : null)
    const CostCell = ({ data }: ICellRendererParams<PackagingType>) => (data ? <span>{data.cost ? new Intl.NumberFormat(locale, { style: 'currency', currency: data.cost.currency, maximumFractionDigits: 4 }).format(Number(data.cost.perUnit)) : '—'}</span> : null)
    const StateCell = ({ data }: ICellRendererParams<PackagingType>) => (data ? <Pill tone={data.active ? 'success' : 'neutral'}>{t(data.active ? 'packaging.on' : 'packaging.off')}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<PackagingType>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('packaging.rowMenu', { name: data.name }) }}
          items={[
            { id: 'edit', label: t('packaging.edit'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'type', typeId: data.id, form: typeFormOf(data), tried: false }) },
            { id: 'active', label: t(data.active ? 'packaging.switchOff' : 'packaging.switchOn'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'active', target: 'types', ids: [data.id], active: !data.active }) },
          ]}
        />
      ) : null
    return [
      { colId: 'name', headerName: t('packaging.col.name'), minWidth: 170, flex: 1.3, cellRenderer: NameCell },
      { colId: 'size', headerName: t('packaging.col.size'), minWidth: 150, flex: 1, cellRenderer: SizeCell },
      { colId: 'tare', headerName: t('packaging.col.tare'), minWidth: 100, flex: 0.6, type: 'rightAligned', cellRenderer: TareCell },
      { colId: 'max', headerName: t('packaging.col.max'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: MaxCell },
      { colId: 'pallet', headerName: t('packaging.col.pallet'), minWidth: 110, flex: 0.6, cellRenderer: PalletCell },
      ...(model.can.cost ? [{ colId: 'cost', headerName: t('packaging.col.cost'), minWidth: 110, flex: 0.6, type: 'rightAligned', cellRenderer: CostCell }] : []),
      { colId: 'state', headerName: t('packaging.col.state'), minWidth: 110, flex: 0.6, cellRenderer: StateCell },
      { colId: 'more', headerName: t('packaging.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, held, actions, model.can.cost])
  const state =
    model.types.state === 'error' ? (
      <PartRead problem={model.types.problem} onRetry={actions?.onRetry} label={t('packaging.types')} />
    ) : rows && rows.length === 0 ? (
      <EmptyState icon={<Boxes size={22} aria-hidden />} title={t('packaging.none.title')} description={t('packaging.none.body')} />
    ) : undefined
  const on = picked.filter((row) => !row.active).map((row) => row.id)
  const off = picked.filter((row) => row.active).map((row) => row.id)
  return (
    <ListFrame<PackagingType>
      label={t('packaging.types')}
      rows={state ? [] : rows}
      rowId={(row) => row.id}
      columns={columns}
      count={rows ? t('packaging.count', { count: rows.length }) : '—'}
      right={
        <Button size="sm" heldReason={held} onClick={() => actions?.onDialog?.({ kind: 'type', typeId: null, form: typeFormOf(null), tried: false })}>
          <Plus size={13} aria-hidden /> {t('packaging.add')}
        </Button>
      }
      selection={{
        selected,
        onChange: setSelected,
        actions: (
          <>
            <Button size="sm" aria-label={t('packaging.bulkOff', { count: off.length })} heldReason={held ?? (off.length === 0 ? t('packaging.held.noneOn') : null)} onClick={() => actions?.onDialog?.({ kind: 'active', target: 'types', ids: off, active: false })}>
              <Power size={13} aria-hidden /> <SelectionLabel>{t('packaging.bulkOff', { count: off.length })}</SelectionLabel>
            </Button>
            <Button size="sm" aria-label={t('packaging.bulkOn', { count: on.length })} heldReason={held ?? (on.length === 0 ? t('packaging.held.noneOff') : null)} onClick={() => actions?.onDialog?.({ kind: 'active', target: 'types', ids: on, active: true })}>
              <Power size={13} aria-hidden /> <SelectionLabel>{t('packaging.bulkOn', { count: on.length })}</SelectionLabel>
            </Button>
          </>
        ),
      }}
      listKey={null}
      state={state}
    />
  )
}

function DefaultsList({ model, actions, held }: { model: PackagingModel; actions?: PackagingActions; held: string | null }) {
  const { t, say } = useWords()
  const rows = model.defaults.state === 'ready' ? [...model.defaults.value].sort((a, b) => Number(b.active) - Number(a.active) || a.kind.localeCompare(b.kind)) : null
  const columns = useMemo<ColDef<PackagingDefault>[]>(() => {
    const ScopeCell = ({ data }: ICellRendererParams<PackagingDefault>) => (data ? <span>{say(scopeOf(data))}</span> : null)
    const TypeCell = ({ data }: ICellRendererParams<PackagingDefault>) =>
      data ? (
        <span className="fw-sh-cell">
          <span>{data.packagingTypeName}</span>
          <span className="fw-sh-cell-sub">{t(`packaging.kind.${data.kind}`)}</span>
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<PackagingDefault>) => (data ? <Pill tone={data.active ? 'success' : 'neutral'}>{t(data.active ? 'packaging.on' : 'packaging.off')}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<PackagingDefault>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('packaging.defaultMenu', { scope: say(scopeOf(data)) ?? '' }) }}
          items={[
            { id: 'type', label: t('packaging.changeType'), disabled: !!held || !data.active, description: held ?? (data.active ? undefined : t('packaging.held.defaultOff')), onSelect: () => actions?.onDialog?.({ kind: 'defaultType', defaultId: data.id, packagingTypeId: data.packagingTypeId }) },
            { id: 'active', label: t(data.active ? 'packaging.switchOff' : 'packaging.switchOn'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'active', target: 'defaults', ids: [data.id], active: !data.active }) },
          ]}
        />
      ) : null
    return [
      { colId: 'scope', headerName: t('packaging.col.scope'), minWidth: 220, flex: 1.6, cellRenderer: ScopeCell },
      { colId: 'type', headerName: t('packaging.col.type'), minWidth: 170, flex: 1.1, cellRenderer: TypeCell },
      { colId: 'state', headerName: t('packaging.col.state'), minWidth: 110, flex: 0.6, cellRenderer: StateCell },
      { colId: 'more', headerName: t('packaging.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, say, held, actions])
  const state =
    model.defaults.state === 'error' ? (
      <PartRead problem={model.defaults.problem} onRetry={actions?.onRetry} label={t('packaging.defaults')} />
    ) : rows && rows.length === 0 ? (
      <EmptyState title={t('packaging.noDefaults.title')} description={t('packaging.noDefaults.body')} />
    ) : undefined
  const anyType = model.types.state === 'ready' && model.types.value.some((type) => type.active)
  return (
    <div className="fw-shd-stack">
      <h3 className="fw-dsp-h3">{t('packaging.defaults')}</h3>
      <p className="fw-shipset-hint">{t('packaging.defaultsIntro')}</p>
      <ListFrame<PackagingDefault>
        label={t('packaging.defaults')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('packaging.defaultsCount', { count: rows.length }) : '—'}
        right={
          <Button size="sm" heldReason={held ?? (anyType ? null : t('packaging.held.noType'))} onClick={() => actions?.onDialog?.({ kind: 'default', form: { packagingTypeId: '', styleId: '', sizeScaleId: '', fromSize: '', toSize: '' } })}>
            <Plus size={13} aria-hidden /> {t('packaging.addDefault')}
          </Button>
        }
        listKey={null}
        state={state}
      />
    </div>
  )
}

function PackagingDialogView({ model, dialog, actions }: { model: PackagingModel; dialog: Exclude<PackagingDialog, null>; actions?: PackagingActions }) {
  const { t, say } = useWords()
  const close = () => actions?.onDialog?.(null)
  const types = model.types.state === 'ready' ? model.types.value : []
  const frame = (title: string, goLabel: string, held: string | null, children: ReactNode, tone: 'primary' | 'danger' = 'primary') => (
    <DepthDialog title={title} held={held ?? say(manageHeld(model.can, model.busy))} onGo={() => actions?.onGo?.()} goLabel={goLabel} onClose={close} problem={say(model.problem)} tone={tone} size="lg">
      {children}
    </DepthDialog>
  )
  switch (dialog.kind) {
    case 'type': {
      const problems = typeProblems(dialog.form, model.can.cost)
      const count = Object.keys(problems).length
      const set = (next: Partial<TypeForm>) => actions?.onDialog?.({ ...dialog, form: { ...dialog.form, ...next } })
      const error = (field: TypeField) => (dialog.tried ? (say(problems[field]) ?? undefined) : undefined)
      return frame(
        dialog.typeId ? t('packaging.dialog.editTitle', { name: dialog.form.name }) : t('packaging.dialog.addTitle'),
        dialog.typeId ? t('packaging.dialog.save') : t('packaging.dialog.create'),
        dialog.tried && count > 0 ? t('packaging.held.problems', { count }) : null,
        <div className="fw-shd-fields">
          <Field label={t('packaging.dialog.kind')} hint={dialog.typeId ? t('packaging.dialog.kindFixed') : undefined}>
            <Select value={dialog.form.kind} disabled={!!dialog.typeId} onChange={(event) => set({ kind: event.target.value as TypeForm['kind'], palletKind: event.target.value === 'PALLET' ? 'EUR' : '' })}>
              {PACKAGING_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`packaging.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('packaging.dialog.name')} error={error('name')} required>
            <Input value={dialog.form.name} maxLength={PACKAGING_NAME_MAX} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          {(['length', 'width', 'height'] as const).map((field) => (
            <Field key={field} label={t(`packaging.dialog.${field}`)} error={error(field)}>
              <Input value={dialog.form[field]} inputMode="decimal" maxLength={12} onChange={(event) => set({ [field]: event.target.value })} />
            </Field>
          ))}
          <Field label={t('packaging.dialog.tare')} error={error('tare')}>
            <Input value={dialog.form.tare} inputMode="decimal" maxLength={16} onChange={(event) => set({ tare: event.target.value })} />
          </Field>
          <Field label={t('packaging.dialog.maxWeight')} error={error('maxWeight')}>
            <Input value={dialog.form.maxWeight} inputMode="decimal" maxLength={16} onChange={(event) => set({ maxWeight: event.target.value })} />
          </Field>
          {dialog.form.kind === 'PALLET' && (
            <Field label={t('packaging.dialog.palletKind')} error={error('palletKind')}>
              <Select value={dialog.form.palletKind} onChange={(event) => set({ palletKind: event.target.value as TypeForm['palletKind'] })}>
                {PALLET_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`packaging.pallet.${kind}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {model.can.cost && (
            <Field label={t('packaging.dialog.cost', { currency: dialog.form.currency })} hint={t('packaging.dialog.costHint')} error={error('cost')}>
              <Input value={dialog.form.cost} inputMode="decimal" maxLength={24} onChange={(event) => set({ cost: event.target.value })} />
            </Field>
          )}
        </div>,
      )
    }
    case 'default': {
      const set = (next: Partial<typeof dialog.form>) => actions?.onDialog?.({ ...dialog, form: { ...dialog.form, ...next } })
      const picks = model.picks?.state === 'ready' ? model.picks.value : null
      return frame(
        t('packaging.dialog.defaultTitle'),
        t('packaging.dialog.defaultGo'),
        say(defaultProblem(dialog.form)),
        <>
          <p className="fw-sh-hint">{t('packaging.dialog.defaultBody')}</p>
          <div className="fw-shd-fields">
            <Field label={t('packaging.dialog.type')} required>
              <Select value={dialog.form.packagingTypeId} onChange={(event) => set({ packagingTypeId: event.target.value })}>
                <option value="">{t('packaging.dialog.choose')}</option>
                {types
                  .filter((type) => type.active)
                  .map((type) => (
                    <option key={type.id} value={type.id}>
                      {t('packaging.dialog.typeOption', { name: type.name, kind: t(`packaging.kind.${type.kind}`) })}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('packaging.dialog.style')} hint={t('packaging.dialog.styleHint')}>
              <Select value={dialog.form.styleId} onChange={(event) => set({ styleId: event.target.value })}>
                <option value="">{t('packaging.dialog.anyStyle')}</option>
                {(picks?.styles ?? []).map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.code} · {style.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('packaging.dialog.scale')}>
              <Select value={dialog.form.sizeScaleId} onChange={(event) => set({ sizeScaleId: event.target.value })}>
                <option value="">{t('packaging.dialog.anyScale')}</option>
                {(picks?.scales ?? []).map((scale) => (
                  <option key={scale.id} value={scale.id}>
                    {scale.code} · {scale.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('packaging.dialog.fromSize')} hint={t('packaging.dialog.runHint')}>
              <Input value={dialog.form.fromSize} maxLength={20} onChange={(event) => set({ fromSize: event.target.value })} />
            </Field>
            <Field label={t('packaging.dialog.toSize')}>
              <Input value={dialog.form.toSize} maxLength={20} onChange={(event) => set({ toSize: event.target.value })} />
            </Field>
          </div>
          {model.picks?.state === 'loading' && (
            <p className="fw-sh-hint" role="status">
              <Spinner size={12} /> {t('packaging.dialog.picksLoading')}
            </p>
          )}
          {model.picks?.state === 'error' && <p className="fw-sh-hint">{t('packaging.dialog.picksFailed')}</p>}
        </>,
      )
    }
    case 'defaultType': {
      const row = model.defaults.state === 'ready' ? model.defaults.value.find((entry) => entry.id === dialog.defaultId) : undefined
      return frame(
        t('packaging.dialog.changeTypeTitle'),
        t('packaging.dialog.save'),
        row && dialog.packagingTypeId === row.packagingTypeId ? t('packaging.held.sameType') : null,
        <Field label={t('packaging.dialog.type')} hint={row ? say(scopeOf(row)) ?? undefined : undefined}>
          <Select value={dialog.packagingTypeId} onChange={(event) => actions?.onDialog?.({ ...dialog, packagingTypeId: event.target.value })}>
            {types
              .filter((type) => type.active && (!row || type.kind === row.kind))
              .map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
          </Select>
        </Field>,
      )
    }
    case 'active': {
      const names = (dialog.target === 'types' ? types.filter((type) => dialog.ids.includes(type.id)).map((type) => type.name) : model.defaults.state === 'ready' ? model.defaults.value.filter((row) => dialog.ids.includes(row.id)).map((row) => say(scopeOf(row)) ?? '') : []).join(', ')
      return frame(
        t(dialog.active ? 'packaging.dialog.onTitle' : 'packaging.dialog.offTitle', { count: dialog.ids.length }),
        t(dialog.active ? 'packaging.dialog.onGo' : 'packaging.dialog.offGo', { count: dialog.ids.length }),
        dialog.ids.length === 0 ? t('packaging.held.noneOn') : null,
        <>
          <p>{names}</p>
          <p className="fw-sh-hint">{t(dialog.active ? 'packaging.dialog.onBody' : dialog.target === 'types' ? 'packaging.dialog.offBody' : 'packaging.dialog.offDefaultBody')}</p>
        </>,
        dialog.active ? 'primary' : 'danger',
      )
    }
  }
}
