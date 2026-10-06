'use client'

/**
 * R16 — what decides an engine (the server setting and this business's switch under it) and the switch itself, as
 * the engine drawer shows them. The Select shows the level IN FORCE (`effectiveSwitch`); a level above the server
 * setting is listed and cannot be picked.
 */
import { Select } from '@/design-system/primitives'
import { Field, KeyValue } from '@/design-system/components'
import { effectiveSwitch, leverControlLines, switchOptions, type LeverControl, type LeverMode } from './lever-control'
import styles from './room.module.css'

export function LeverSwitchSection({ control, canSwitch, busy, onChoose }: {
  control: LeverControl
  canSwitch: boolean
  busy: boolean
  onChoose: (to: LeverMode) => void
}) {
  return (
    <section className={styles.stack} aria-label="What decides it">
      <KeyValue dense columns={3} items={leverControlLines(control)} />
      {control.switchable && (
        <Field
          label="Level for this business"
          hint={canSwitch
            ? 'Every move asks first and takes effect at its next run. It never goes above what the server setting allows.'
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
