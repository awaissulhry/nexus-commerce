import { Kbd } from '@nexus/design-system'

const SHORTCUTS = [
  { action: 'Search campaigns, ASINs and SKUs', keys: ['⌘', 'K'] },
  { action: 'Export the current view as CSV', keys: ['⇧', '⌘', 'E'] },
  { action: 'Show, hide and reorder columns', keys: ['⌘', 'G'] },
  { action: 'Apply staged bid changes', keys: ['⌘', '↵'] },
  { action: 'Close the drawer', keys: ['Esc'] },
]

/** One chip per key — Kbd never holds a whole chord, the caller lays the keys out. */
export const Keys = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
    <Kbd>⌘</Kbd>
    <Kbd>⇧</Kbd>
    <Kbd>⌥</Kbd>
    <Kbd>↵</Kbd>
    <Kbd>Esc</Kbd>
    <Kbd>/</Kbd>
  </div>
)

/** The shortcut list in the command palette: action on the left, the chord right-aligned. */
export const ShortcutRows = () => (
  <div>
    {SHORTCUTS.map((s) => (
      <div
        key={s.action}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '7px 0',
          borderBottom: '1px solid var(--border-subtle)',
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}
      >
        <span>{s.action}</span>
        <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }}>
          {s.keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      </div>
    ))}
  </div>
)

/** Inline in running copy — the chips sit on the text baseline without stretching the line. */
export const InlineHint = () => (
  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8, color: 'var(--text-secondary)', maxWidth: 340 }}>
    Press <Kbd>⌘</Kbd> <Kbd>K</Kbd> to jump to any campaign, ASIN or SKU. Apply staged bid changes
    with <Kbd>⌘</Kbd> <Kbd>↵</Kbd> or discard them with <Kbd>Esc</Kbd>.
  </p>
)
