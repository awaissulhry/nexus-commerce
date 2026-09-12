import { Button, Pill, Tag } from '../primitives'

/** Shared mapping-state contrast specimen; uses the normal pill and button contracts. */
export function MappingStatusExample() {
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-10)', color: 'var(--nds-text)' }}>
    <Pill tone="info">Follows Master</Pill>
    <Tag tone="info">Information tag</Tag>
    <Pill tone="success">Category rule</Pill>
    <Pill tone="neutral">Listing override</Pill>
    <Button variant="tonal" size="sm" aria-pressed>Selected category</Button>
  </div>
}
