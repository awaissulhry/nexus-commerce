import { Stepper } from '@nexus/design-system'

const IMPORT_STEPS = [
  { key: 'upload', label: 'Upload' },
  { key: 'map', label: 'Map columns' },
  { key: 'review', label: 'Review listings' },
  { key: 'preview', label: 'Preview' },
]

const PUBLISH_STEPS = [
  { key: 'details', label: 'Details' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'images', label: 'Images' },
  { key: 'review', label: 'Review' },
  { key: 'publish', label: 'Publish' },
]

const Note = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>
    {children}
  </div>
)

/** The eBay flat-file import wizard, mid-flow. Steps before `current` are done (check), later are muted. */
export const ImportWizard = () => (
  <div style={{ width: 460, maxWidth: '100%' }}>
    <Stepper steps={IMPORT_STEPS} current={1} />
  </div>
)

/** The three states across one flow — start, middle, end. Display-only: the parent owns `current`. */
export const Progression = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: 500, maxWidth: '100%' }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Note>{'current={0} — nothing done yet'}</Note>
      <Stepper steps={PUBLISH_STEPS} current={0} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Note>{'current={2} — two done, two upcoming'}</Note>
      <Stepper steps={PUBLISH_STEPS} current={2} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Note>{'current={4} — the last step'}</Note>
      <Stepper steps={PUBLISH_STEPS} current={4} />
    </div>
  </div>
)

/** A short two-step flow — the connector still spans between the badges. */
export const TwoStep = () => (
  <div style={{ width: 300, maxWidth: '100%' }}>
    <Stepper steps={[{ key: 'upload', label: 'Upload bulksheet' }, { key: 'apply', label: 'Apply changes' }]} current={1} />
  </div>
)
