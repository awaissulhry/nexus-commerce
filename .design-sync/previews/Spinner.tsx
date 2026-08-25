import { Button, Spinner } from '@nexus/design-system'

const sizeLabel: React.CSSProperties = { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }

/** `size` is a px diameter — the ring's 2px stroke stays constant, so small reads as small. */
export const Sizes = () => (
  <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
    {[14, 16, 22, 28].map((s) => (
      <div key={s} style={{ textAlign: 'center' }}>
        <div style={{ height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spinner size={s} />
        </div>
        <div style={sizeLabel}>{s === 16 ? '16 · default' : s}</div>
      </div>
    ))}
  </div>
)

/** Inline beside the sentence that says what is loading — never a bare ring on its own. */
export const InlineLoading = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--text-secondary)' }}>
      <Spinner size={14} />
      Syncing 1,284 listings with Amazon DE…
    </span>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--text-secondary)' }}>
      <Spinner size={14} />
      Pulling the last 30 days of Sponsored Products spend…
    </span>
  </div>
)

/** In a button while a live write is in flight: the button is disabled, the label says the verb. */
export const InButton = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <Button variant="secondary" disabled>
      <Spinner size={13} /> Applying 41 bids…
    </Button>
    <Button variant="secondary" size="sm" disabled>
      <Spinner size={12} /> Exporting…
    </Button>
  </div>
)

/** A panel that has nothing to show yet — centred ring plus the reason it is waiting. */
export const PanelLoading = () => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      padding: '28px 20px',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--nds-radius-lg)',
    }}
  >
    <Spinner size={26} />
    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Building the placement report…</span>
    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Amazon queues these serially; usually under a minute.</span>
  </div>
)
