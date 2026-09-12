'use client'

/**
 * VP.3 — the FAMILY BAND (§3.1), canvas artboard 1:
 *
 *     AXES   ⠿ Colore [2 values]  ×  ⠿ Taglia [10 values]   + Add axis  │  20 of 20 combinations
 *            exist · 0 missing                    [Generate combinations]  [Add variant ▾]
 *
 * 🔴 The band's chrome is the DS's `.nds-pageband`, not this page's own CSS. VP.5 minted it while
 * this was being built and the mapping band (§4.1) uses the same class, so the two 40px bands cannot
 * drift into two heights — and `scripts/check-layout-v2.mjs` keys its band budget on that class, so
 * a page-local spelling reports NOT MEASURED however right it looks. The eyebrow shares ONE selector
 * list with the scope bar's, in the DS, for the same reason.
 *
 * It declares no verb of its own. `Add variant ▾` lists what `useFamilyVerbs()` already returns for
 * `contextOf('product-family')`, so the rules that decide whether a verb is offered, what it warns
 * about and how hard it asks are the registry's here as everywhere else (ruling #110). The ONE
 * primary button on the page is that menu's trigger.
 */
import { ChevronDown, Plus } from 'lucide-react'

import { Menu, usePointerReorder, type MenuItemDef } from '@/design-system/components'
import { AxisChip, Button } from '@/design-system/primitives'

import type { AxisSummary, CombinationCoverage } from './coverage'

export interface FamilyBandProps {
  axes: readonly AxisSummary[]
  coverage: CombinationCoverage
  /** Opens the existing `Manage shared axes` modal — on a chip, and on `Add axis`. */
  onManageAxes: (focus: 'list' | 'add') => void
  onGenerate: () => void
  onReorder: (keys: string[]) => void
  /** The registry's family verbs, already built by `useFamilyVerbs()`. */
  verbs: MenuItemDef[]
  /** Adds `Generate combinations…` to the menu, beside the verbs the registry owns. */
  onGenerateItem?: () => void
  disabled?: boolean
  /**
   * 🔴 Why, when `disabled`. REQUIRED in practice, not decoration: a disabled control that cannot
   * explain itself teaches the operator nothing (reference_disabled_control_cannot_explain), and on
   * this page the usual reason is a PERMISSION — measured 2026-09-11, the control census pressed
   * `Generate combinations` on an unauthenticated session and reported only that the modal never
   * appeared, because the button said nothing about being inert.
   */
  disabledReason?: string
  loading?: boolean
}

export function FamilyBand({ axes, coverage, onManageAxes, onGenerate, onReorder, verbs, onGenerateItem, disabled, disabledReason, loading }: FamilyBandProps) {
  const pointer = usePointerReorder({ disabled, horizontal: true, onMove: (from, to) => {
    const order = axes.map(axis => axis.key)
    const [key] = order.splice(from, 1); order.splice(to, 0, key)
    onReorder(order)
  } })
  const items: MenuItemDef[] = [
    ...verbs.filter(item => item.id === 'add-variation'),
    ...(onGenerateItem
      ? [{ id: 'generate-combinations', label: 'Generate combinations…', description: 'Create every combination that does not exist yet', disabled, onSelect: onGenerateItem } as MenuItemDef]
      : []),
    ...verbs.filter(item => item.id === 'attach-existing'),
  ]
  return (
    <div className="nds-pageband">
      <span className="nds-pageband-label">Axes</span>
      <div className="nds-pageband-main" data-nds-reorder-list>
        {axes.map((axis, i) => (
          <span key={axis.key} style={{ display: 'contents' }}>
            {i > 0 && <span className="nds-pageband-note" aria-hidden>×</span>}
            <AxisChip
              data-nds-reorder-item
              label={axis.label}
              count={`${axis.valueOrder?.length ?? axis.values.length} ${(axis.valueOrder?.length ?? axis.values.length) === 1 ? 'value' : 'values'}`}
              grip={axes.length > 1}
              dragHandleProps={pointer.handleProps(i)}
              disabled={disabled}
              title={disabled && disabledReason ? disabledReason : `${axis.label} — ${axis.values.map(v => v.label).join(', ') || 'no values on this family yet'}`}
              onClick={() => onManageAxes('list')}
            />
          </span>
        ))}
        <Button size="sm" variant="ghost" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={() => onManageAxes('add')}>
          <Plus size={13} aria-hidden /> Add axis
        </Button>
        <span className="nds-pageband-divider" aria-hidden />
        {/*
          🔴 The sentence branches on coverage.STATE, never on a zero, and the type now forces it —
          `combinations` is `number | null` and the arithmetic branch does not compile in the
          degenerate cases. That is not tidiness: it printed `0 of 0 combinations exist · 0 missing`
          on AIREON, whose two axes are DECLARED with nothing stored, beside a chip in the same bar
          saying 40 variants are missing axis values. One 40px band, two contradictory statements,
          both computed from the same rows. A zero that means "could not be computed" must not be
          spellable the same way as a zero that was counted (`ViewChip.count`'s own rule).
        */}
        <span className="nds-pageband-note">
          {loading ? (
            'Reading this family…'
          ) : coverage.state === 'no-axes' ? (
            'No axes yet — add one to describe how these variants differ'
          ) : coverage.state === 'no-values' ? (
            <>
              {axes.map(a => a.label).join(' and ')} {axes.length === 1 ? 'is set up' : 'are set up'}, but{' '}
              <b>{coverage.incomplete.length}</b> {coverage.incomplete.length === 1 ? 'variant carries' : 'variants carry'} no value yet —
              nothing to count until they do
            </>
          ) : (
            <>
              <b>{coverage.existing}</b> of {coverage.combinations} {coverage.combinations === 1 ? 'combination exists' : 'combinations exist'} ·{' '}
              <b>{coverage.missing?.length ?? 0}</b> missing
              {coverage.duplicates.length > 0 && <> · <b>{coverage.duplicates.length}</b> duplicates</>}
            </>
          )}
        </span>
      </div>
      <div className="nds-pageband-right">
        <Button
          size="sm"
          disabled={disabled || axes.length === 0}
          title={disabled ? disabledReason : axes.length === 0 ? 'Add an axis first — there are no combinations to generate without one' : undefined}
          onClick={onGenerate}
        >
          Generate combinations
        </Button>
        <Menu
          label={<>Add variant <ChevronDown size={14} aria-hidden /></>}
          items={items}
          align="right"
          triggerProps={{ className: 'nds-btn sm primary', 'aria-label': 'Add variant' }}
        />
      </div>
    </div>
  )
}
