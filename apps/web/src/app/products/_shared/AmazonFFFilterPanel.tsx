import { FFFilterPanelBase } from './FFFilterPanelBase'
import { type AmazonFFFilterState, AMAZON_FILTER_DEFAULT } from './flat-file-filter.types'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  value: AmazonFFFilterState
  onChange: (next: AmazonFFFilterState) => void
}

export function AmazonFFFilterPanel({ open, onOpenChange, value, onChange }: Props) {
  const activeCount =
    (value.missingRequired ? 1 : 0) +
    (value.channel.parentage !== 'any' ? 1 : 0) +
    (value.channel.hasAsin !== 'any' ? 1 : 0)

  return (
    <FFFilterPanelBase
      open={open}
      onOpenChange={onOpenChange}
      missingRequired={value.missingRequired}
      onMissingRequiredChange={(v) => onChange({ ...value, missingRequired: v })}
      onReset={() => onChange(AMAZON_FILTER_DEFAULT)}
      activeCount={activeCount}
    >
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">Row type</p>
        {(['any', 'parent', 'child'] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="parentage"
              value={v}
              checked={value.channel.parentage === v}
              onChange={() => onChange({ ...value, channel: { ...value.channel, parentage: v } })}
            />
            <span className="text-sm capitalize text-slate-700 dark:text-slate-300">
              {v === 'any' ? 'Any' : v}
            </span>
          </label>
        ))}
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">Amazon ASIN</p>
        {(['any', 'yes', 'no'] as const).map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input
              type="radio"
              name="hasAsin"
              value={v}
              checked={value.channel.hasAsin === v}
              onChange={() => onChange({ ...value, channel: { ...value.channel, hasAsin: v } })}
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              {v === 'any' ? 'Any' : v === 'yes' ? 'Has ASIN' : 'No ASIN'}
            </span>
          </label>
        ))}
      </div>
    </FFFilterPanelBase>
  )
}
