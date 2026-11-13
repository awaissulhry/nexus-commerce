'use client'

import { useCallback, useState, type ReactNode } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, InfoTip, Input, SegmentedControl } from '@nexus/ui/primitives'
import type { LotSizing, PlanLevel } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../../lib/i18n/messages'
import { useT } from '../../../../../lib/i18n/provider'
import { rowName, type ItemRow, type Mark } from '../../params/model'
import { cellKeys, SaveMark } from '../../params/view/cells'
import { ITEM_RULES_NAMESPACE, LOT_SIZING_VALUES, lotPatch, lotWords, PLAN_LEVEL_VALUES, planLevelHeld, plain, ruleHeld, rulesOf, rulesPlan, ruleWords, type RuleCan, type RuleField, type RuleWords } from '../model'
import type { RuleInput } from '../use-item-rules'
import '../items.css'

/** The two rule dialogs of Item parameters (lot sizing with its number; plan level). */
export type RuleDialogState = { kind: 'lot'; key: string; lotSizing?: LotSizing; fixed?: string; period?: string } | { kind: 'level'; key: string; level?: PlanLevel | 'SITE' }
export const isRuleDialog = (dialog: { kind: string } | null | undefined): dialog is RuleDialogState => dialog?.kind === 'lot' || dialog?.kind === 'level'

/** Words of this part (planning-mrp-depth, `items.`); a value `items.field.<name>` (several joined by `|`) is said too. */
export function useRuleSay(): (words: RuleWords | null | undefined) => string {
  const t = useT(ITEM_RULES_NAMESPACE)
  return useCallback(
    (words: RuleWords | null | undefined) => {
      if (!words) return ''
      const params = Object.fromEntries(Object.entries(words.params ?? {}).map(([name, value]) => [name, typeof value === 'string' && value.startsWith('items.') ? value.split('|').map((key) => t(key)).join(', ') : value]))
      return t(words.key, params)
    },
    [t],
  )
}

export interface RuleColumnsContext {
  t: Translate
  say: (words: RuleWords | null | undefined) => string
  can: RuleCan
  mark: (rowKey: string, field: string) => Mark | undefined
  unitOf: (row: ItemRow) => string
  open: (dialog: RuleDialogState) => void
  onRule: (row: ItemRow, field: RuleField, input: RuleInput) => void
}

/**
 * B-W2b-335 — the W2b columns of Item parameters (design planning.settings sec:items "lot-sizing (W2b), plan by
 * size/colour/style (W2b)"; B-W2b-318's seven fields): Lot sizing (a dialog: lot for lot, a fixed lot, min/max of the row's
 * order limits, a period of days), Plan by (a dialog: the site's size-run rule, style, style and colour, or each size;
 * held for a material and without planning.strategy.manage), Scrap %, Yield % and Delay days typed in the cell (autosave
 * per cell with its mark). What the rules do sits in the cell's InfoTip, in our words. No money.
 */
export function ruleColumns(ctx: RuleColumnsContext): ColDef<ItemRow>[] {
  const { t, say, can } = ctx
  const itemsHeld = ruleHeld(can)
  const factsOf = (row: ItemRow) => ({ method: row.row?.method ?? 'ORDERS', itemKind: row.item.kind, unit: ctx.unitOf(row), minOrderQty: row.row?.minOrderQty ?? null, orderMultiple: row.row?.orderMultiple ?? null, maxOrderQty: row.row?.maxOrderQty ?? null })
  const Choice = ({ data, field, text, faint, held, tip, open }: { data: ItemRow; field: RuleField; text: string; faint: boolean; held: string | null; tip: string | null; open: () => void }) => (
    <span className="fw-pir-cell">
      <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} aria-label={t('items.cell.change', { field: t(`items.field.${field}`), item: rowName(data), value: text })} onClick={open}>
        <span className={faint ? 'fw-pir-sub' : undefined}>{text}</span>
      </Button>
      {tip ? <InfoTip tip={tip} /> : null}
      <SaveMark mark={ctx.mark(data.key, field)} />
    </span>
  )
  const LotCell = ({ data }: ICellRendererParams<ItemRow>) => {
    if (!data) return null
    const rules = rulesOf(data.row)
    const words = ruleWords(rules, factsOf(data)).filter((entry) => entry.key.startsWith('items.words.') && !entry.key.includes('level') && !entry.key.includes('scrap') && !entry.key.includes('delay'))
    return <Choice data={data} field="lotSizing" text={say(lotWords(rules, ctx.unitOf(data)))} faint={!rules || rules.lotSizing === 'LOT_FOR_LOT'} held={itemsHeld} tip={words.length > 0 ? words.map(say).join(' ') : null} open={() => ctx.open({ kind: 'lot', key: data.key })} />
  }
  const LevelCell = ({ data }: ICellRendererParams<ItemRow>) => {
    if (!data) return null
    const rules = rulesOf(data.row)
    const held = planLevelHeld(data.item.kind, can)
    const level = rules?.planLevel ?? null
    const material = held === 'items.held.material'
    const words = ruleWords(rules, factsOf(data)).filter((entry) => entry.key.includes('level'))
    return (
      <Choice
        data={data}
        field="planLevel"
        text={material ? t('items.level.perColour') : level ? t(`items.level.${level}`) : t('items.level.SITE')}
        faint={material || level === null}
        held={held}
        tip={words.length > 0 ? words.map(say).join(' ') : null}
        open={() => ctx.open({ kind: 'level', key: data.key })}
      />
    )
  }
  const NumberCell = (field: 'scrapPct' | 'yieldPct' | 'delayDays') =>
    function RuleNumber({ data }: ICellRendererParams<ItemRow>) {
      if (!data) return null
      const rules = rulesOf(data.row)
      const value = rules ? rules[field] : null
      const text = value === null ? '' : field === 'delayDays' ? t('items.days', { count: Number(value) }) : t('items.percent', { value: plain(String(value)) })
      const words = field === 'delayDays' ? ruleWords(rules, factsOf(data)).filter((entry) => entry.key === 'items.words.delay') : ruleWords(rules, factsOf(data)).filter((entry) => entry.key.includes('scrapYield'))
      return (
        <span className="fw-pir-cell num">
          <span className={value === null ? 'fw-pir-sub' : undefined}>{text || '—'}</span>
          {words.length > 0 && field !== 'scrapPct' ? <InfoTip tip={words.map(say).join(' ')} /> : null}
          <SaveMark mark={ctx.mark(data.key, field)} />
        </span>
      )
    }
  const number = (field: 'scrapPct' | 'yieldPct' | 'delayDays'): ColDef<ItemRow> => ({
    colId: field,
    headerName: t(`items.col.${field}`),
    minWidth: 120,
    flex: 0.9,
    ...(can.manageItems ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 8 } } : {}),
    valueGetter: (params) => {
      const rules = rulesOf(params.data?.row ?? null)
      return rules && rules[field] !== null ? String(rules[field]) : ''
    },
    valueSetter: (params) => {
      if (params.data) ctx.onRule(params.data, field, { raw: params.newValue })
      return false
    },
    cellRenderer: NumberCell(field),
    suppressKeyboardEvent: cellKeys(),
  })
  const choice = (colId: 'lotSizing' | 'planLevel', renderer: (params: ICellRendererParams<ItemRow>) => ReactNode, open: (row: ItemRow) => RuleDialogState, minWidth: number): ColDef<ItemRow> => ({
    colId,
    headerName: t(`items.col.${colId}`),
    minWidth,
    flex: 1.1,
    cellRenderer: renderer,
    suppressKeyboardEvent: (params: { event: KeyboardEvent; editing: boolean; data?: ItemRow }) => {
      const held = params.data ? (colId === 'planLevel' ? planLevelHeld(params.data.item.kind, can) : itemsHeld) : 'held'
      return cellKeys(!held && params.data ? () => ctx.open(open(params.data!)) : undefined)(params)
    },
  })
  return [choice('lotSizing', LotCell, (row) => ({ kind: 'lot', key: row.key }), 170), choice('planLevel', LevelCell, (row) => ({ kind: 'level', key: row.key }), 160), number('scrapPct'), number('yieldPct'), number('delayDays')]
}

/** The open rule dialog (lot sizing or plan level) of a row. */
export function RuleDialog({ dialog, rows, can, unitOf, onRule, onClose }: { dialog: RuleDialogState; rows: readonly ItemRow[] | null; can: RuleCan; unitOf: (row: ItemRow) => string; onRule?: (row: ItemRow, field: RuleField, input: RuleInput) => void; onClose: () => void }) {
  const row = (rows ?? []).find((entry) => entry.key === dialog.key) ?? null
  if (!row) return null
  return dialog.kind === 'lot' ? <LotDialog dialog={dialog} row={row} can={can} unit={unitOf(row)} onRule={onRule} onClose={onClose} /> : <LevelDialog dialog={dialog} row={row} can={can} onRule={onRule} onClose={onClose} />
}

function LotDialog({ dialog, row, can, unit, onRule, onClose }: { dialog: Extract<RuleDialogState, { kind: 'lot' }>; row: ItemRow; can: RuleCan; unit: string; onRule?: (row: ItemRow, field: RuleField, input: RuleInput) => void; onClose: () => void }) {
  const t = useT(ITEM_RULES_NAMESPACE)
  const say = useRuleSay()
  const rules = rulesOf(row.row)
  const [lotSizing, setLotSizing] = useState<LotSizing>(dialog.lotSizing ?? rules?.lotSizing ?? 'LOT_FOR_LOT')
  const [fixed, setFixed] = useState(dialog.fixed ?? (rules?.fixedLotQty ? plain(rules.fixedLotQty) : ''))
  const [period, setPeriod] = useState(dialog.period ?? (rules?.lotPeriodDays !== null && rules?.lotPeriodDays !== undefined ? String(rules.lotPeriodDays) : ''))
  const typed = lotPatch(lotSizing, fixed, period)
  const plan = 'patch' in typed ? rulesPlan(row.row, row.item.kind, typed.patch) : null
  const problem: RuleWords | null = 'words' in typed ? typed.words : plan?.kind === 'refused' ? plan.words : null
  const held = ruleHeld(can)
  const heldReason = held ? t(held) : problem ? say(problem) : plan?.kind === 'none' ? t('items.held.same') : null
  const limits = [row.row?.minOrderQty, row.row?.orderMultiple, row.row?.maxOrderQty].some((value) => value !== null && value !== undefined)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('items.lotDialog.title', { item: rowName(row) })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            heldReason={heldReason}
            onClick={() => {
              if (!plan || plan.kind !== 'write' || !('patch' in typed)) return
              onRule?.(row, 'lotSizing', { patch: typed.patch })
              onClose()
            }}
          >
            {t('items.lotDialog.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-pir-dialog">
        <SegmentedControl ariaLabel={t('items.field.lotSizing')} wrap value={lotSizing} options={LOT_SIZING_VALUES.map((value) => ({ value, label: t(`items.lot.${value}`) }))} onChange={(value) => setLotSizing(value as LotSizing)} />
        <p className="fw-pir-hint">{t(`items.lotHint.${lotSizing}`)}</p>
        {lotSizing === 'FIXED' && (
          <Field label={t('items.field.fixedLotQty')} hint={t('items.inUnit', { unit })} required>
            <Input inputMode="decimal" value={fixed} onChange={(event) => setFixed(event.target.value)} />
          </Field>
        )}
        {lotSizing === 'PERIOD' && (
          <Field label={t('items.field.lotPeriodDays')} hint={t('items.periodHint')} required>
            <Input inputMode="numeric" value={period} onChange={(event) => setPeriod(event.target.value)} />
          </Field>
        )}
        {lotSizing === 'MIN_MAX' && <p className="fw-pir-hint">{limits ? t('items.minMaxLimits', { min: row.row?.minOrderQty ? plain(row.row.minOrderQty) : '—', step: row.row?.orderMultiple ? plain(row.row.orderMultiple) : '—', max: row.row?.maxOrderQty ? plain(row.row.maxOrderQty) : '—', unit }) : t('items.minMaxNone')}</p>}
        {row.item.kind === 'FINISHED' && lotSizing !== 'LOT_FOR_LOT' && <Banner tone="info">{t('items.words.lotFinished')}</Banner>}
        {(row.row?.method ?? 'ORDERS') !== 'ORDERS' && lotSizing !== 'LOT_FOR_LOT' && <Banner tone="info">{t('items.words.onlyOrders')}</Banner>}
        {plan?.kind === 'write' && plan.cleared.length > 0 && <Banner tone="info">{say({ key: 'items.clears', params: { fields: plan.cleared.map((field) => `items.field.${field}`).join('|') } })}</Banner>}
        {problem && (
          <p className="fw-pir-problem" role="alert">
            {say(problem)}
          </p>
        )}
      </div>
    </Modal>
  )
}

function LevelDialog({ dialog, row, can, onRule, onClose }: { dialog: Extract<RuleDialogState, { kind: 'level' }>; row: ItemRow; can: RuleCan; onRule?: (row: ItemRow, field: RuleField, input: RuleInput) => void; onClose: () => void }) {
  const t = useT(ITEM_RULES_NAMESPACE)
  const say = useRuleSay()
  const rules = rulesOf(row.row)
  const [level, setLevel] = useState<PlanLevel | 'SITE'>(dialog.level ?? rules?.planLevel ?? 'SITE')
  const patch = { planLevel: level === 'SITE' ? null : level }
  const plan = rulesPlan(row.row, row.item.kind, patch)
  const held = planLevelHeld(row.item.kind, can)
  const heldReason = held ? t(held) : plan.kind === 'refused' ? say(plan.words) : plan.kind === 'none' ? t('items.held.same') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('items.levelDialog.title', { item: rowName(row) })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button
            variant="primary"
            heldReason={heldReason}
            onClick={() => {
              if (plan.kind !== 'write') return
              onRule?.(row, 'planLevel', { patch })
              onClose()
            }}
          >
            {t('items.levelDialog.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-pir-dialog">
        <SegmentedControl ariaLabel={t('items.field.planLevel')} wrap value={level} options={(['SITE', ...PLAN_LEVEL_VALUES] as const).map((value) => ({ value, label: t(`items.level.${value}`) }))} onChange={(value) => setLevel(value as PlanLevel | 'SITE')} />
        <p className="fw-pir-hint">{t(row.item.kind === 'COMPONENT' && level !== 'SITE' ? 'items.words.levelComponent' : `items.levelHint.${level}`)}</p>
        {held && <Banner tone="neutral">{t(held)}</Banner>}
      </div>
    </Modal>
  )
}
