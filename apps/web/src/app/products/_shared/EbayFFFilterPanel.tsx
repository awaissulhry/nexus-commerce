import { FFFilterPanelBase } from './FFFilterPanelBase'
import { type EbayFFFilterState, EBAY_FILTER_DEFAULT } from './flat-file-filter.types'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  value: EbayFFFilterState
  onChange: (next: EbayFFFilterState) => void
}

export function EbayFFFilterPanel({ open, onOpenChange, value, onChange }: Props) {
  const activeCount =
    (value.missingRequired ? 1 : 0) +
    (value.channel.hasItemId !== 'any' ? 1 : 0) +
    (value.channel.isParent !== 'any' ? 1 : 0)

  return (
    <FFFilterPanelBase
      open={open}
      onOpenChange={onOpenChange}
      missingRequired={value.missingRequired}
      onMissingRequiredChange={(v) => onChange({ ...value, missingRequired: v })}
      onReset={() => onChange(EBAY_FILTER_DEFAULT)}
      activeCount={activeCount}
    >
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">Row type</p>
        {(['any', 'parent', 'child'] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="isParent"
              value={v}
              checked={value.channel.isParent === v}
              onChange={() => onChange({ ...value, channel: { ...value.channel, isParent: v } })}
            />
            <span className="text-sm capitalize text-slate-700 dark:text-slate-300">
              {v === 'any' ? 'Any' : v}
            </span>
          </label>
        ))}
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">eBay Item ID</p>
        {(['any', 'yes', 'no'] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="hasItemId"
              value={v}
              checked={value.channel.hasItemId === v}
              onChange={() => onChange({ ...value, channel: { ...value.channel, hasItemId: v } })}
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              {v === 'any' ? 'Any' : v === 'yes' ? 'Has Item ID' : 'No Item ID'}
            </span>
          </label>
        ))}
      </div>
    </FFFilterPanelBase>
  )
}
