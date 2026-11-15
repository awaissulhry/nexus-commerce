'use client'

import { useMemo } from 'react'
import { Archive, MoreHorizontal, Play, Plus, ShieldAlert } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { useKeysHelp } from '../../../kit/list'
import { DepthMessages } from '../../requests/view/RequestsView'
import type { Rule } from '../api'
import { bulkSweepable, keptKnown, lastSweepPhrase, purgeKnown, ruleHeld, ruleState, STATE_PILL, typeKey, type RetentionViewModel } from '../model'
import { Period } from './Period'
import { RetentionDialogs, type RetentionDialogActions } from './RetentionDialogs'
import '../retention.css'

export interface RetentionActions extends RetentionDialogActions {
  onNewRule?: () => void
  onChangeRule?: (ruleId: string) => void
  onSwitch?: (ruleId: string, active: boolean) => void
  onApply?: (ruleId: string, on: boolean) => void
  onSweep?: (ruleId: string) => void
  onSweeps?: (ruleId: string) => void
  onSelect?: (ids: string[]) => void
  onSweepSelected?: (ids: string[]) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpClose?: () => void
}

/**
 * SCR-662 — Admin › Privacy › Retention rules (design admin.privacy sec:retention; PLT-204; GDPR art. 5(1)(e); GATE-PRIVACY): per
 * record type how long it is kept, then what happens (delete, anonymise, archive), the legal reason, the state and the last
 * sweep, on the shared list frame (Sweep N now for rules that only report). Nothing deletes by itself: a rule REPORTS until a
 * person switches it on to apply (a confirm, then a fresh code); shortening a period asks a fresh code too; every period says
 * UNVERIFIED until the privacy consultant sets it. Below: the append-only ledgers, kept for good and never purged (the Owner's
 * decision of 15 Nov 2026; never offered for a sweep), the purges that run on their own dates, and what is kept for good. Fetches nothing (RetentionRules reads it).
 */
export function RetentionView({ model, actions }: { model: RetentionViewModel; actions?: RetentionActions }) {
  return (
    <DepthMessages>
      <Retention model={model} actions={actions} />
    </DepthMessages>
  )
}

function useColumns(model: RetentionViewModel, actions?: RetentionActions): ColDef<Rule>[] {
  const t = useT('admin-privacy-depth')
  const locale = useLocale()
  return useMemo(() => {
    const place = { locale, timeZone: model.timeZone }
    const TypeCell = ({ data }: ICellRendererParams<Rule>) =>
      data ? (
        <span className="fw-dpret-cell">
          <span className="fw-dpret-strong">{t(typeKey(data.recordType, 'name'))}</span>
          <span className="fw-dpret-sub" title={t(typeKey(data.recordType, 'countsFrom'))}>
            {t(typeKey(data.recordType, 'countsFrom'))}
          </span>
        </span>
      ) : null
    const CompanyCell = ({ data }: ICellRendererParams<Rule>) => (data ? <span className="fw-dpret-ellipsis">{data.company?.name ?? t('dp.ret.company.all')}</span> : null)
    const KeepCell = ({ data }: ICellRendererParams<Rule>) =>
      data ? (
        <span className="fw-dpret-inline">
          <Period months={data.keepMonths} />
          {data.unverified && <Pill tone="warning">{t('dp.ret.unverified')}</Pill>}
        </span>
      ) : null
    const ThenCell = ({ data }: ICellRendererParams<Rule>) =>
      data ? (
        <span className="fw-dpret-cell">
          <span>{t(`dp.ret.then.${data.thenAction}`)}</span>
          {data.holdsAll && <span className="fw-dpret-sub fw-dpret-warning">{t(`dp.ret.sweepHeld.${data.holdsAll.code}.short`)}</span>}
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<Rule>) =>
      data ? (
        <span className="fw-dpret-ellipsis" title={data.legalReason}>
          {data.legalReason}
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<Rule>) => {
      if (!data) return null
      const state = ruleState(data)
      return <Pill tone={STATE_PILL[state]}>{t(`dp.ret.state.${state}`)}</Pill>
    }
    const LastCell = ({ data }: ICellRendererParams<Rule>) => {
      if (!data) return null
      const phrase = lastSweepPhrase(data.lastSweep)
      const words = t(phrase.key, phrase.params)
      return (
        <span className="fw-dpret-cell">
          <span className="fw-dpret-ellipsis" title={words}>
            {words}
          </span>
          {data.lastSweep && <span className="fw-dpret-sub">{formatDate(data.lastSweep.startedAt, place)}</span>}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<Rule>) => {
      if (!data) return null
      const held = (action: Parameters<typeof ruleHeld>[1]) => ruleHeld(data, action, model.can)
      const item = (id: string, label: string, heldKey: string | null, onSelect: () => void, tone?: 'danger') => ({ id, label, ...(tone ? { tone } : {}), ...(heldKey ? { disabled: true, title: t(heldKey) } : { onSelect }) })
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('dp.ret.menu', { type: t(typeKey(data.recordType, 'name')) }) }}
          items={[
            item('change', t('dp.ret.action.change'), held('change'), () => actions?.onChangeRule?.(data.id)),
            item('sweep', t(data.applyOn ? 'dp.ret.action.sweepApply' : 'dp.ret.action.sweepNow'), held('sweepNow'), () => actions?.onSweep?.(data.id)),
            { id: 'sweeps', label: t('dp.ret.action.sweeps'), onSelect: () => actions?.onSweeps?.(data.id) },
            { id: 'sep', separator: true },
            data.applyOn
              ? item('applyOff', t('dp.ret.action.applyOff'), held('applyOff'), () => actions?.onApply?.(data.id, false))
              : item('applyOn', t('dp.ret.action.applyOn'), held('applyOn'), () => actions?.onApply?.(data.id, true), 'danger'),
            data.active ? item('off', t('dp.ret.action.switchOff'), held('switchOff'), () => actions?.onSwitch?.(data.id, false)) : item('on', t('dp.ret.action.switchOn'), held('switchOn'), () => actions?.onSwitch?.(data.id, true)),
          ]}
        />
      )
    }
    return [
      { colId: 'type', headerName: t('dp.ret.col.type'), minWidth: 220, flex: 1.4, cellRenderer: TypeCell },
      { colId: 'company', headerName: t('dp.ret.col.company'), minWidth: 140, flex: 0.8, cellRenderer: CompanyCell },
      { colId: 'keep', headerName: t('dp.ret.col.keep'), minWidth: 190, flex: 1, cellRenderer: KeepCell },
      { colId: 'then', headerName: t('dp.ret.col.then'), minWidth: 150, flex: 0.9, cellRenderer: ThenCell },
      { colId: 'reason', headerName: t('dp.ret.col.reason'), minWidth: 200, flex: 1.2, cellRenderer: ReasonCell },
      { colId: 'state', headerName: t('dp.ret.col.state'), minWidth: 120, flex: 0.6, cellRenderer: StateCell },
      { colId: 'last', headerName: t('dp.ret.col.last'), minWidth: 180, flex: 1, cellRenderer: LastCell },
      { colId: 'more', headerName: t('dp.ret.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.timeZone, model.can, actions])
}

function Retention({ model, actions }: { model: RetentionViewModel; actions?: RetentionActions }) {
  const t = useT('admin-privacy-depth')
  const admin = useT('admin')
  const lists = useT('lists')
  const list = model.list.value
  const rows = list?.rules ?? null
  const columns = useColumns(model, actions)
  const selected = model.selected.filter((id) => rows?.some((row) => row.id === id))
  const sweepable = (rows ?? []).filter((row) => selected.includes(row.id) && bulkSweepable(row))
  const ownKeys: ListKey[] = [{ keys: ['1', '2', '3', '4', '5'], does: t('dp.keys.views') }, ...(model.can.manage ? [{ keys: ['a'], does: t('dp.keys.newRule') }] : [])]
  const { onHelp, help } = useKeysHelp(ownKeys, true)

  const state = model.list.problem ? (
    <EmptyState
      title={t('dp.ret.failed')}
      description={t(model.list.problem)}
      action={
        <Button size="sm" onClick={actions?.onRetry}>
          {t('dp.common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState
      icon={<Archive size={22} aria-hidden />}
      title={t('dp.ret.empty')}
      description={t('dp.ret.emptyHint')}
      action={
        model.can.manage ? (
          <Button size="sm" variant="primary" onClick={actions?.onNewRule}>
            <Plus size={14} aria-hidden /> {t('dp.ret.new')}
          </Button>
        ) : undefined
      }
    />
  ) : undefined

  return (
    <section className="fw-dpret" aria-labelledby="fw-dpret-title">
      <div className="fw-dpret-head">
        <h2 id="fw-dpret-title" className="fw-dpret-h2">
          {t('dp.ret.title')}
        </h2>
        <p className="fw-dpret-muted">{t('dp.ret.intro')}</p>
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, { ...model.notice.params, ...(typeof model.notice.params?.type === 'string' ? { type: t(typeKey(model.notice.params.type, 'name')) } : {}) })}
          action={
            <Button size="sm" variant="quiet" onClick={actions?.onDismissNotice}>
              {t('dp.common.dismiss')}
            </Button>
          }
        />
      )}
      <Banner tone="warning" icon={<ShieldAlert size={16} aria-hidden />} title={t('dp.ret.gate.title')}>
        {t('dp.ret.gate.body')}
        {list ? ` ${t('dp.ret.gate.schedule')}` : ''}
      </Banner>
      <ListFrame<Rule>
        label={t('dp.ret.title')}
        listKey={null}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('dp.ret.count', { count: rows.length }) : lists('loading')}
        right={
          model.can.manage ? (
            <Button size="sm" variant="primary" onClick={actions?.onNewRule} heldReason={list ? null : t('dp.common.loading')}>
              <Plus size={14} aria-hidden /> {t('dp.ret.new')}
            </Button>
          ) : undefined
        }
        selection={{
          selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          actions: (
            <Button
              size="sm"
              aria-label={t('dp.ret.sweepSelected', { count: sweepable.length })}
              onClick={() => actions?.onSweepSelected?.(sweepable.map((row) => row.id))}
              heldReason={!model.can.manage ? t('dp.ret.held.manage') : sweepable.length === 0 ? t('dp.ret.sweepSelectedNone') : model.busyRule ? t('dp.common.working') : null}
            >
              <Play size={14} aria-hidden /> <SelectionLabel>{t('dp.ret.sweepSelected', { count: sweepable.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={onHelp}
        keysOpen={model.keysOpen}
        onOpen={(row) => actions?.onSweeps?.(row.id)}
        state={state}
      />
      {help}
      {selected.length > sweepable.length && sweepable.length > 0 && <p className="fw-dpret-muted">{t('dp.ret.sweepSelectedLeft', { count: selected.length - sweepable.length })}</p>}

      {list && (
        <div className="fw-dpret-cards">
          <Card header={t('dp.ret.ledgers.title')} headingLevel={3} description={t('dp.ret.ledgers.intro')} className="fw-dpret-card">
            <SummaryTable
              label={t('dp.ret.ledgers.title')}
              stackOnPhone
              columns={[t('dp.ret.col.type'), t('dp.ret.ledgers.what'), t('dp.ret.col.state')]}
              align={['left', 'left', 'left']}
              rows={list.ledgers.map((ledger) => ({
                id: ledger.recordType,
                cells: [
                  <strong key="n">{t(`dp.ret.ledger.${ledger.recordType}.name`)}</strong>,
                  t(`dp.ret.ledger.${ledger.recordType}.what`),
                  <Pill key="s" tone="neutral">
                    {t('dp.ret.ledgers.kept')}
                  </Pill>,
                ],
              }))}
            />
            <p className="fw-dpret-muted">{t('dp.ret.ledgers.words')}</p>
          </Card>
          <Card header={t('dp.ret.purges.title')} headingLevel={3} description={t('dp.ret.purges.intro')} className="fw-dpret-card">
            <SummaryTable
              label={t('dp.ret.purges.title')}
              stackOnPhone
              columns={[t('dp.ret.purges.what'), t('dp.ret.purges.when'), t('dp.ret.purges.why')]}
              align={['left', 'left', 'left']}
              rows={list.datedPurges
                .filter((purge) => purgeKnown(purge.key))
                .map((purge) => ({ id: purge.key, cells: [t(`dp.ret.purge.${purge.key}.what`), t(`dp.ret.purge.${purge.key}.when`), t(`dp.ret.purge.${purge.key}.why`)] }))}
            />
          </Card>
          <Card header={t('dp.ret.kept.title')} headingLevel={3} className="fw-dpret-card">
            <ul className="fw-dpret-kept">
              {list.keptForGood.filter(keptKnown).map((type) => (
                <li key={type}>{t(`dp.ret.kept.${type}`)}</li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <RetentionDialogs model={model} actions={actions} />
      <StepUpModal
        open={model.stepUp.open}
        title={t('dp.stepUp.title')}
        sentence={model.stepUp.sentence.startsWith('dp.') ? t(model.stepUp.sentence) : admin(model.stepUp.sentence)}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? admin(model.stepUp.problem) : null}
        confirmLabel={t('dp.stepUp.confirm')}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpClose?.()}
      />
    </section>
  )
}
