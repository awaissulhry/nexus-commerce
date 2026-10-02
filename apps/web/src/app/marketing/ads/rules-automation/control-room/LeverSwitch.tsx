'use client'

/**
 * R16 — what decides an engine (the server setting and this business's switch under it) and the switch itself, as
 * the lever drawer shows them. The Select shows the level IN FORCE (`effectiveSwitch`); a level above the server
 * setting is listed and cannot be picked.
 */
import { Select } from '@/design-system/primitives'
import { Field, KeyValue } from '@/design-system/components'
import { effectiveSwitch, leverControlLines, switchOptions, type LeverControl, type LeverMode } from './lever-control'

export function LeverSwitchSection({ control, inForce, canSwitch, busy, onChoose }: {
  control: LeverControl
  /** The lever's mode (under the account dial too), for the "In force" line. */
  inForce: LeverMode
  canSwitch: boolean
  busy: boolean
  onChoose: (to: LeverMode) => void
}) {
  return (
    <section className="acr-dw-sec" aria-label="What decides it">
      <KeyValue dense columns={3} items={leverControlLines(control, inForce)} />
      {control.switchable && (
        <Field
          label="Switch for this business"
          hint={canSwitch
            ? 'Down takes effect at its next run. Up asks first, and never goes past what the server setting allows.'
            : 'Changing it needs the ads automation permission.'}
        >
          <Select size="sm" value={effectiveSwitch(control)} disabled={!canSwitch || busy} onChange={(e) => onChoose(e.target.value as LeverMode)}>
            {switchOptions(control).map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
            ))}
          </Select>
        </Field>
      )}
    </section>
  )
}
