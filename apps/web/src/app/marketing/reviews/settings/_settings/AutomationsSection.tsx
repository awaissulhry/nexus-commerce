'use client'

/**
 * Reviews › Settings › Automations — the review automations (GET /api/reviews/automation-rules): on/off, what each
 * does, when it last ran. The switch saves at once (`PATCH /api/reviews/automation-rules/:id { enabled }`, review rules
 * only) and the list is read again. "Load templates (N)" adds the review automation templates not loaded yet (they start
 * off, in trial run). A rule in trial run records what it would do and changes nothing.
 *
 * Edit: the rules builder cannot open a review automation yet, so Edit is a labelled placeholder (build spec ruling 3).
 */
import { useCallback, useMemo, useState } from 'react'
import { Card, EmptyState, useToast } from '@/design-system/components'
import { NexusGrid, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Button, InfoTip, Skeleton, Tag, Toggle } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { ReadFailed } from './ReadFailed'
import { automationLastRun, loadTemplatesButton, type AutomationRule } from './settingsModel'
import type { SettingsRead } from './useSettingsRead'
import s from './settings.module.css'

interface Ctx {
  manageHeld: string | null
  onToggle: (rule: AutomationRule, on: boolean) => void
}

const EDIT_LATER = 'Coming later: the rules builder opens review automations in a later update. Turn them on or off here.'
const TRIAL_TIP = 'Trial run: it records what it would do and changes nothing.'

function OnCell({ data, context }: ICellRendererParams<AutomationRule, unknown, Ctx>) {
  if (!data) return null
  if (context.manageHeld) {
    return <Button size="sm" variant="quiet" heldReason={context.manageHeld}>{data.enabled ? 'On' : 'Off'}</Button>
  }
  return <Toggle size="sm" checked={data.enabled} onChange={(on) => context.onToggle(data, on)} aria-label={`Automation: ${data.name}`} />
}

function NameCell({ data }: ICellRendererParams<AutomationRule>) {
  if (!data) return null
  return (
    <span className={s.cellStack}>
      <span className={s.cellLine}>
        <span className={s.cellStrong}>{data.name}</span>
        {data.dryRun && <InfoTip tip={TRIAL_TIP}><Tag tone="info">Trial run</Tag></InfoTip>}
      </span>
    </span>
  )
}

function DoesCell({ data }: ICellRendererParams<AutomationRule>) {
  return data ? <span className={s.cellStack}><span className={s.cellSub}>{data.description ?? '—'}</span></span> : null
}

function LastCell({ data }: ICellRendererParams<AutomationRule>) {
  if (!data) return null
  const last = automationLastRun(data, new Date())
  return (
    <span className={s.cellStack}>
      <span>{last.when}</span>
      <span className={s.cellSub}>{last.result}</span>
    </span>
  )
}

function EditCell({ data }: ICellRendererParams<AutomationRule>) {
  if (!data) return null
  // ⛔ KEEP — placeholder (build spec ruling 3): Edit opens the rules builder once it can open a review automation.
  return <span className={s.cellActions}><Button size="sm" variant="quiet" heldReason={EDIT_LATER} aria-label={`Edit ${data.name}`}>Edit</Button></span>
}

const COLUMNS: ColDef<AutomationRule>[] = [
  { colId: 'on', headerName: 'On', width: 80, minWidth: 72, cellRenderer: OnCell, sortable: false },
  { colId: 'name', headerName: 'Automation', flex: 1.2, minWidth: 220, cellRenderer: NameCell, autoHeight: true },
  { colId: 'does', headerName: 'What it does', flex: 2, minWidth: 260, cellRenderer: DoesCell, autoHeight: true },
  { colId: 'last', headerName: 'Last run', width: 170, minWidth: 150, cellRenderer: LastCell, autoHeight: true },
  { colId: 'edit', headerName: '', width: 90, minWidth: 80, cellRenderer: EditCell, sortable: false },
]

const getRowId = (p: { data: AutomationRule }) => p.data.id

export interface AutomationsSectionProps {
  rules: SettingsRead<{ items: AutomationRule[] }>
  templates: { total: number; missing: number } | null
  manageHeld: string | null
  /** After templates were loaded (the settings read again: how many are still missing). */
  onTemplatesLoaded: () => void
}

export function AutomationsSection({ rules, templates, manageHeld, onTemplatesLoaded }: AutomationsSectionProps) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const rows = useMemo(() => rules.data?.items ?? [], [rules.data])

  const onToggle = useCallback(async (rule: AutomationRule, on: boolean) => {
    const res = await reviewsSend<{ rule: { name: string; enabled: boolean } }>('PATCH', `/reviews/automation-rules/${encodeURIComponent(rule.id)}`, { enabled: on })
    if (res.error) {
      toast(res.error, 'danger')
      return
    }
    await rules.reload()
    emitInvalidation({ type: 'review.settings.changed' })
    toast(`“${res.data?.rule.name ?? rule.name}” is ${res.data?.rule.enabled ? 'on' : 'off'}.`, 'success')
  }, [rules, toast])

  const context = useMemo<Ctx>(() => ({ manageHeld, onToggle: (r, on) => void onToggle(r, on) }), [manageHeld, onToggle])
  const columnDefs = useMemo(() => COLUMNS, [])

  const load = templates ? loadTemplatesButton(templates) : null
  const loadTemplates = async () => {
    setLoading(true)
    const res = await reviewsSend<{ created: string[]; skippedExisting: string[] }>('POST', '/reviews/automation-rules/seed-templates')
    setLoading(false)
    if (res.error) {
      toast(res.error, 'danger')
      return
    }
    await rules.reload()
    onTemplatesLoaded()
    emitInvalidation({ type: 'review.settings.changed' })
    const n = res.data?.created.length ?? 0
    toast(n === 0 ? 'Every template was already loaded.' : `Loaded ${n} ${n === 1 ? 'template' : 'templates'}. ${n === 1 ? 'It starts' : 'They start'} off, in trial run.`, 'success')
  }

  return (
    <div className={s.section}>
      <p className={s.lead}>What Nexus does on its own when reviews arrive. A switch saves at once.</p>
      <Card
        header="Review automations"
        headingLevel={3}
        headerAction={load ? (
          <Button size="sm" onClick={() => void loadTemplates()} heldReason={manageHeld ?? (loading ? 'Loading the templates…' : load.held)}>{load.label}</Button>
        ) : undefined}
        padded={false}
      >
        {rules.error && !rules.data ? (
          <div className={s.pad}><ReadFailed error={rules.error} onRetry={() => void rules.reload()} busy={rules.loading} /></div>
        ) : !rules.data ? (
          <div className={s.skeletonRows} aria-hidden>{[0, 1, 2].map((i) => <Skeleton key={i} height={40} />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No review automations yet" description="Load the templates to start from three ready-made automations. They start off, in trial run." />
        ) : (
          <div className={s.tableScroll}>
            {/* Keyed by the permission: the cells read it from the grid's context, which AG does not re-render on. */}
            <NexusGrid<AutomationRule> key={manageHeld ? 'held' : 'free'} plain density="compact" rowData={rows} columnDefs={columnDefs} getRowId={getRowId} context={context} />
          </div>
        )}
      </Card>
    </div>
  )
}
