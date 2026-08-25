/**
 * ER1 (C9) — THE status pill, extracted so both channels render one component.
 *
 * Now a Nexus DS <Pill>. It still takes the console's legacy `cls` vocabulary
 * (ok / warn / bad / arch / muted) because ~30 call sites compute it from data;
 * `pillTone` maps that to the DS Tone union, and records why each mapping is
 * colour-safe.
 */
import { Pill } from '@/design-system/primitives'
import { pillTone } from './pillTone'

export function StatusPill({ label, cls, title }: { label: string; cls: string; title?: string }) {
  return (
    <Pill tone={pillTone(cls)} title={title}>
      {label}
    </Pill>
  )
}
