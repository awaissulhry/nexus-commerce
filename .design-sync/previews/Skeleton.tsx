import { Skeleton } from '@nexus/design-system'

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 0',
  borderBottom: '1px solid var(--border-subtle)',
}

const cardStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '12px 14px',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--nds-radius-lg)',
}

/** Text placeholders: uneven widths so the block reads as prose, not as a bar chart. */
export const TextLines = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 260 }}>
    <Skeleton width={200} height={12} />
    <Skeleton width={240} height={12} />
    <Skeleton width={140} height={12} />
  </div>
)

/** A campaign grid loading: thumbnail square, name + marketplace lines, right-aligned metrics. */
export const LoadingGridRows = () => (
  <div>
    {[0, 1, 2].map((i) => (
      <div key={i} style={rowStyle}>
        <Skeleton width={32} height={32} radius={6} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
          <Skeleton width={i === 1 ? 150 : 190} height={11} />
          <Skeleton width={96} height={9} />
        </span>
        <Skeleton width={54} height={11} />
        <Skeleton width={44} height={11} />
      </div>
    ))}
  </div>
)

/** Metric tiles before the numbers land — label line short, value line tall. */
export const LoadingMetricCards = () => (
  <div style={{ display: 'flex', gap: 12 }}>
    {[0, 1, 2].map((i) => (
      <div key={i} style={cardStyle}>
        <Skeleton width={54} height={9} />
        <div style={{ height: 10 }} />
        <Skeleton width={82} height={20} radius={4} />
      </div>
    ))}
  </div>
)

/** `radius` overrides the default 4px corner — 999 makes the avatar/pill placeholders. */
export const Radii = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
    <Skeleton width={36} height={36} radius={999} />
    <Skeleton width={72} height={18} radius={999} />
    <Skeleton width={96} height={36} radius={10} />
  </div>
)
