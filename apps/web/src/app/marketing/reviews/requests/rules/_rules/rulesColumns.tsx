'use client'

/**
 * Reviews › Requests › Rules — the grid's columns: On · Name + note · Channel · Markets · First try · Sent 30 days ·
 * Rate · A/B · actions (Edit; ⋯ Duplicate as A/B, Test run, Delete…). Window and Skips are in Customise (board). The
 * cells read the page's handlers through a ref (AG's `context`), so the column definitions never change.
 */
import { memo, type RefObject } from 'react'
import { IdentityCell, actionsColumn, integerColumn, switchColumn, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import type { MenuItemDef } from '@/design-system/components'
import { Tag } from '@/design-system/primitives'
import type { GridColumnSpec } from '../../gridCustomise'
import { abBadge, type TimingTest } from '../../timing/_timing/timingTestsModel'
import { abMark, channelWords, duplicateHeld, firstTryWords, marketsWords, ruleRateWords, skipsWords, turnOnHeld, windowWords, type RuleItem } from './rulesModel'

export const MANAGE_RULES = "You need 'Manage reviews' to change review-request rules."

export interface RulesHandlers {
  /** The On switch (switchColumn reads `context.current.onSwitch`). */
  onSwitch?: (row: RuleItem, next: boolean) => void
  edit: (row: RuleItem) => void
  duplicate: (row: RuleItem) => void
  testRun: (row: RuleItem) => void
  remove: (row: RuleItem) => void
  /** Every rule (the A/B marks read it). */
  rules: readonly RuleItem[]
  /** PR J — the A/B splits (`reviewsGet('/review-timing-tests', { kind: 'AB' })`): the mark says whether one runs. */
  abTests: readonly TimingTest[]
  canManage: boolean
}

/** "A · running", "B · waiting for approval", or the copy mark alone ("A side", "B copy") when it never had a split. */
export function abCellWords(rule: RuleItem, rules: readonly RuleItem[], tests: readonly TimingTest[]): { words: string; tone: 'info' | 'warning' | 'neutral' } | null {
  const badge = abBadge(rule.id, tests)
  if (badge) return { words: `${badge.side} · ${badge.state}`, tone: badge.tone === 'info' || badge.tone === 'warning' ? badge.tone : 'neutral' }
  const mark = abMark(rule, rules)
  return mark ? { words: mark === 'A' ? 'A side' : 'B copy', tone: 'neutral' } : null
}

type Cell = ICellRendererParams<RuleItem>

const NameCell = memo(function NameCell({ data }: Cell) {
  if (!data) return null
  return <IdentityCell noImage title={data.name} titleAttr={data.name} sub={data.notes ? <span title={data.notes}>{data.notes}</span> : undefined} />
})

const FirstTryCell = memo(function FirstTryCell({ data }: Cell) {
  if (!data) return null
  const w = firstTryWords(data)
  return <IdentityCell noImage title={w.value} sub={<span>{w.sub}</span>} />
})

const AbCell = memo(function AbCell({ data, context }: Cell) {
  if (!data) return null
  const h = (context as RefObject<RulesHandlers> | undefined)?.current
  const cell = abCellWords(data, h?.rules ?? [], h?.abTests ?? [])
  if (!cell) return null
  return <Tag tone={cell.tone}>{cell.words}</Tag>
})



export const RULE_COLUMN_SPECS: readonly GridColumnSpec[] = [
  { key: 'isActive', label: 'On' },
  { key: 'name', label: 'Name', locked: true },
  { key: 'channel', label: 'Channel' },
  { key: 'markets', label: 'Markets' },
  { key: 'firstTry', label: 'First try' },
  { key: 'window', label: 'Window', hidden: true },
  { key: 'skips', label: 'Skips', hidden: true },
  { key: 'sent30', label: 'Sent 30 days' },
  { key: 'rate30', label: 'Rate' },
  { key: 'ab', label: 'A/B' },
  { key: 'actions', label: 'Actions', locked: true },
]

const hidden = (key: string) => RULE_COLUMN_SPECS.find((c) => c.key === key)?.hidden === true

export function rulesColumns(handlers: RefObject<RulesHandlers>): ColDef<RuleItem>[] {
  const h = () => handlers.current
  return [
    {
      colId: 'isActive',
      ...switchColumn<RuleItem>('isActive', {
        header: 'On',
        label: (r) => `Rule “${r.name}” is on`,
        disabledReason: (r) => {
          if (!h()?.canManage) return MANAGE_RULES
          return r.isActive ? null : turnOnHeld(r)
        },
      }),
      width: 96,
      minWidth: 90,
    },
    { colId: 'name', headerName: 'Name', field: 'name', cellRenderer: NameCell, minWidth: 220, flex: 1.6, lockPosition: 'left' },
    { colId: 'channel', headerName: 'Channel', valueGetter: (p) => (p.data ? channelWords(p.data) : ''), minWidth: 110 },
    { colId: 'markets', headerName: 'Markets', valueGetter: (p) => (p.data ? marketsWords(p.data) : ''), minWidth: 130 },
    { colId: 'firstTry', headerName: 'First try', valueGetter: (p) => (p.data ? firstTryWords(p.data).value : ''), cellRenderer: FirstTryCell, minWidth: 160 },
    { colId: 'window', headerName: 'Window', valueGetter: (p) => (p.data ? windowWords(p.data) : ''), minWidth: 110, hide: hidden('window') },
    { colId: 'skips', headerName: 'Skips', valueGetter: (p) => (p.data ? skipsWords(p.data) : ''), minWidth: 200, flex: 1, hide: hidden('skips') },
    { colId: 'sent30', headerName: 'Sent 30 days', ...integerColumn<RuleItem>('sent30'), minWidth: 110 },
    { colId: 'rate30', headerName: 'Rate', field: 'rate30', valueFormatter: (p) => ruleRateWords(p.data), tooltipValueGetter: (p) => p.data?.rateWords ?? null, type: 'rightAligned', minWidth: 120 },
    { colId: 'ab', headerName: 'A/B', valueGetter: (p) => (p.data ? abCellWords(p.data, h()?.rules ?? [], h()?.abTests ?? [])?.words ?? '' : ''), cellRenderer: AbCell, minWidth: 130 },
    actionsColumn<RuleItem>({
      prefsLabel: 'Actions',
      primary: { label: 'Edit', onClick: (r) => h()?.edit(r), ariaLabel: (r) => `Edit the rule “${r.name}”` },
      menuLabel: (r) => `More for the rule “${r.name}”`,
      items: (r): MenuItemDef[] => {
        const handlers = h()
        const manage = handlers?.canManage ? null : MANAGE_RULES
        const dup = manage ?? duplicateHeld(r, handlers?.rules ?? [])
        return [
          {
            id: 'duplicate',
            label: 'Duplicate as A/B',
            description: dup ?? 'Makes a B copy, off, to change and start',
            disabled: !!dup,
            onSelect: dup ? undefined : () => handlers?.duplicate(r),
          },
          { id: 'test', label: 'Test run', description: 'Which orders it would ask today — sends nothing', onSelect: () => handlers?.testRun(r) },
          { id: 'delete', label: 'Delete…', tone: 'danger', disabled: !!manage, description: manage ?? undefined, onSelect: manage ? undefined : () => handlers?.remove(r) },
        ]
      },
    }),
  ]
}
