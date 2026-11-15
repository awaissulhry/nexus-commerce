'use client'

import { useMemo, type ReactNode } from 'react'
import { KeyRound, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, EmptyState, Field, Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Pill, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Words } from '../../../shipments/queue/shared/depth'
import { DepthDialog, PartRead } from '../../../shipments/queue/shared/DepthDialog'
import { DISPATCH_NAMESPACES, DISPATCH_NS } from '../../../shipments/pickup/dispatch'
import type { Contract } from '../api'
import { addHeld, changeHeld, contractOrder, contractProblem, scopeWords, type ContractDialog, type ContractsActions, type ContractsModel } from '../model'
import { SettingsCard } from '../../test-mode/settings-card'
import '../../../shipments/queue/shared/depth.css'
import '../../shipping-setup.css'

/**
 * SCR-659 — Carriers & shipping › Our own carrier contracts (B-W2b-412 on B-W2b-400; LOG-033; design warehouse.shipping sec
 * sp-carrier "W2b own carrier contracts"): the company's contracts with carriers — for one site or every site, "use only our
 * rates", the number sealed and never shown, live or switched off, and which one a label of this site is bought on. Add a
 * contract and Replace the number ask a fresh code (the number is said once more only by its last four characters); Switch
 * off removes the number and keeps the row.
 */
export function ContractsView({ model, actions }: { model: ContractsModel; actions?: ContractsActions }) {
  return (
    <WithMessages namespaces={DISPATCH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: ContractsModel; actions?: ContractsActions }) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words | null) => (value ? t(value.key, value.params) : null)
  const rows = model.contracts.state === 'ready' ? contractOrder(model.contracts.value) : null
  const columns = useMemo<ColDef<Contract>[]>(() => {
    const CarrierCell = ({ data }: ICellRendererParams<Contract>) =>
      data ? (
        <span className="fw-sh-cell">
          <span>{data.carrierName}</span>
          <span className="fw-sh-cell-sub fw-sh-mono">{data.carrierCode}</span>
        </span>
      ) : null
    const ScopeCell = ({ data }: ICellRendererParams<Contract>) => {
      if (!data) return null
      const scope = scopeWords(data)
      return (
        <span className="fw-shd-chips">
          <span>{t(scope.key, scope.params)}</span>
          {data.usedForSite && <Tag tone="info">{t('contracts.usedHere', { site: model.siteCode ?? '' })}</Tag>}
        </span>
      )
    }
    const RatesCell = ({ data }: ICellRendererParams<Contract>) => (data ? <span>{t(data.ownRatesOnly ? 'contracts.ratesOwn' : 'contracts.ratesAny')}</span> : null)
    const NumberCell = ({ data }: ICellRendererParams<Contract>) => (data ? <span>{t(data.numberOnFile ? 'contracts.numberOnFile' : 'contracts.noNumber')}</span> : null)
    const StateCell = ({ data }: ICellRendererParams<Contract>) => (data ? <Pill tone={data.active ? 'success' : 'neutral'}>{t(data.active ? 'contracts.live' : 'contracts.off')}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<Contract>) => {
      if (!data) return null
      const held = say(changeHeld(data, model.can, model.busy))
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('contracts.rowMenu', { carrier: data.carrierName }) }}
          items={[
            { id: 'rates', label: t(data.ownRatesOnly ? 'contracts.action.ratesOff' : 'contracts.action.ratesOn'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'rates', contractId: data.id, ownRatesOnly: !data.ownRatesOnly }) },
            { id: 'number', label: t('contracts.action.number'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'number', contractId: data.id, accountNumber: '' }) },
            { id: 'off', label: t('contracts.action.off'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'off', contractId: data.id }) },
          ]}
        />
      )
    }
    return [
      { colId: 'carrier', headerName: t('contracts.col.carrier'), minWidth: 150, flex: 1, cellRenderer: CarrierCell },
      { colId: 'scope', headerName: t('contracts.col.scope'), minWidth: 180, flex: 1.2, cellRenderer: ScopeCell },
      { colId: 'rates', headerName: t('contracts.col.rates'), minWidth: 170, flex: 1, cellRenderer: RatesCell },
      { colId: 'number', headerName: t('contracts.col.number'), minWidth: 140, flex: 0.8, cellRenderer: NumberCell },
      { colId: 'state', headerName: t('contracts.col.state'), minWidth: 120, flex: 0.6, cellRenderer: StateCell },
      { colId: 'more', headerName: t('contracts.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, model.can, model.busy, model.siteCode, actions])
  const state =
    model.contracts.state === 'error' ? (
      <PartRead problem={model.contracts.problem} onRetry={actions?.onRetry} label={t('contracts.title')} />
    ) : rows && rows.length === 0 ? (
      <EmptyState icon={<KeyRound size={22} aria-hidden />} title={t('contracts.none.title')} description={t('contracts.none.body')} />
    ) : undefined
  const add = (
    <Button size="sm" heldReason={say(addHeld(model.can, model.busy))} onClick={() => actions?.onDialog?.({ kind: 'add', carrierCode: '', everySite: false, accountNumber: '', ownRatesOnly: false })}>
      <Plus size={13} aria-hidden /> {t('contracts.add')}
    </Button>
  )
  return (
    <SettingsCard id="contracts" wide icon={<KeyRound size={16} aria-hidden />} title={t('contracts.title')} intro={t('contracts.intro')} done={model.done} problem={model.dialog ? null : model.problem} onDismiss={actions?.onDismiss} stepUp={model.stepUp} onStepUpSubmit={actions?.onStepUpSubmit} onStepUpCancel={actions?.onStepUpCancel}>
      <ListFrame<Contract> label={t('contracts.title')} rows={state ? [] : rows} rowId={(row) => row.id} columns={columns} count={rows ? t('contracts.count', { count: rows.length }) : '—'} right={add} listKey={null} state={state} />
      <p className="fw-shipset-hint">{t('contracts.sealed')}</p>
      {model.dialog && <ContractDialogView model={model} dialog={model.dialog} actions={actions} />}
    </SettingsCard>
  )
}

function ContractDialogView({ model, dialog, actions }: { model: ContractsModel; dialog: Exclude<ContractDialog, null>; actions?: ContractsActions }) {
  const t = useT(DISPATCH_NS)
  const say = (value: Words | null) => (value ? t(value.key, value.params) : null)
  const contract = dialog.kind === 'add' || model.contracts.state !== 'ready' ? null : (model.contracts.value.find((row) => row.id === dialog.contractId) ?? null)
  const held = say(dialog.kind === 'add' ? addHeld(model.can, model.busy) : contract ? changeHeld(contract, model.can, model.busy) : null) ?? say(contractProblem(dialog))
  const close = () => actions?.onDialog?.(null)
  const set = (next: Partial<Exclude<ContractDialog, null>>) => actions?.onDialog?.({ ...dialog, ...next } as ContractDialog)
  const frame = (title: string, goLabel: string, children: ReactNode, tone: 'primary' | 'danger' = 'primary') => (
    <DepthDialog title={title} subtitle={contract ? `${contract.carrierName} · ${t(scopeWords(contract).key, scopeWords(contract).params)}` : undefined} held={held} onGo={() => actions?.onGo?.()} goLabel={goLabel} onClose={close} problem={say(model.problem)} tone={tone}>
      {children}
    </DepthDialog>
  )
  const numberField = (value: string) => (
    <Field label={t('contracts.dialog.number')} hint={t('contracts.dialog.numberHint')} required>
      <Input value={value} maxLength={40} autoComplete="off" spellCheck={false} onChange={(event) => set({ accountNumber: event.target.value })} />
    </Field>
  )
  switch (dialog.kind) {
    case 'add':
      return frame(
        t('contracts.dialog.addTitle'),
        t('contracts.dialog.addGo'),
        <>
          <p className="fw-sh-hint">{t('contracts.dialog.addBody')}</p>
          <div className="fw-shd-fields">
            <Field label={t('contracts.dialog.carrier')} hint={t('contracts.dialog.carrierHint')} required>
              <Input value={dialog.carrierCode} maxLength={40} spellCheck={false} autoCapitalize="none" placeholder="brt" onChange={(event) => set({ carrierCode: event.target.value })} />
            </Field>
            {numberField(dialog.accountNumber)}
          </div>
          {model.siteId && <Checkbox checked={dialog.everySite} onChange={(event) => set({ everySite: event.target.checked })} label={t('contracts.dialog.everySite')} />}
          <p className="fw-sh-hint">{dialog.everySite || !model.siteId ? t('contracts.scope.every') : t('contracts.scope.site', { site: model.siteCode ?? '' })}</p>
          <Checkbox checked={dialog.ownRatesOnly} onChange={(event) => set({ ownRatesOnly: event.target.checked })} label={t('contracts.dialog.ownRates')} />
          <p className="fw-sh-hint">{t('contracts.dialog.ownRatesHint')}</p>
        </>,
      )
    case 'number':
      return frame(t('contracts.dialog.numberTitle'), t('contracts.dialog.numberGo'), <><p className="fw-sh-hint">{t('contracts.dialog.numberBody')}</p>{numberField(dialog.accountNumber)}</>)
    case 'rates':
      return frame(t(dialog.ownRatesOnly ? 'contracts.dialog.ratesOnTitle' : 'contracts.dialog.ratesOffTitle'), t('contracts.dialog.ratesGo'), <p>{t(dialog.ownRatesOnly ? 'contracts.dialog.ratesOnBody' : 'contracts.dialog.ratesOffBody')}</p>)
    case 'off':
      return frame(t('contracts.dialog.offTitle'), t('contracts.dialog.offGo'), <Banner tone="warning" title={t('contracts.dialog.offBody')} />, 'danger')
  }
}
