import { useEffect, useRef } from 'react'
import { ToolbarButton, ToolbarDivider } from '@nexus/design-system'

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'block' }}
  >
    {children}
  </svg>
)

const FilterIcon = () => <Icon><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></Icon>
const DownloadIcon = () => (
  <Icon>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </Icon>
)
const ColumnsIcon = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="12" y1="3" x2="12" y2="21" />
  </Icon>
)
const TrashIcon = () => (
  <Icon>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </Icon>
)
const RefreshIcon = () => (
  <Icon>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </Icon>
)

// The card harness clips overlays: `.ds-cell` (lib/emit.mjs) sets `overflow:hidden`,
// so a tooltip that opens ABOVE its trigger — `.h10-ds-tooltip > .tip` is
// `bottom: calc(100% + 8px)` — is cut off by the cell's top edge on hover. The
// static capture never showed it because the tip only exists while hovered or
// focused; it is visible to anyone browsing the card. Scoped to this component's
// own page, so it cannot affect another card.
if (typeof document !== 'undefined' && !document.getElementById('tbtn-overflow')) {
  const st = document.createElement('style')
  st.id = 'tbtn-overflow'
  st.textContent = '.ds-cell{overflow:visible}'
  document.head.appendChild(st)
}

const bar: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '5px 8px',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--h10-radius-lg)',
}

/** The grid toolbar it was built for: icon-only actions in groups, separated by ToolbarDivider. */
export const Toolbar = () => (
  <div style={bar}>
    <ToolbarButton icon={<FilterIcon />} label="Filter" description="Filter rows by condition" shortcut="⌘K" />
    <ToolbarButton icon={<ColumnsIcon />} label="Columns" description="Show, hide and reorder columns" shortcut="⌘G" />
    <ToolbarDivider />
    <ToolbarButton icon={<RefreshIcon />} label="Refresh" description="Re-pull the last 30 days from Amazon" />
    <ToolbarButton icon={<DownloadIcon />} label="Export" description="Download as CSV or XLSX" />
    <ToolbarDivider />
    <ToolbarButton icon={<TrashIcon />} label="Archive" description="Archive the selected campaigns" />
  </div>
)

/** The state axis: default, `active` (pressed), `disabled`. Each keeps its tooltip. */
export const States = () => (
  <div style={bar}>
    <ToolbarButton icon={<FilterIcon />} label="Filter" description="Filter rows by condition" shortcut="⌘K" />
    <ToolbarButton icon={<ColumnsIcon />} label="Columns" description="Show, hide and reorder columns" active />
    <ToolbarButton icon={<TrashIcon />} label="Archive" description="Select rows first" disabled />
  </div>
)

/** `badge` puts a blue count top-right — how many filters or hidden columns are in play. Capped at 99+. */
export const WithBadge = () => (
  <div style={bar}>
    <ToolbarButton icon={<FilterIcon />} label="Filter" description="3 filters active" shortcut="⌘K" badge={3} />
    <ToolbarButton icon={<ColumnsIcon />} label="Columns" description="12 columns hidden" badge={12} />
    <ToolbarButton icon={<DownloadIcon />} label="Export" description="128 queued exports" badge={128} />
  </div>
)

/** The hover tooltip, held open so the card shows what a user actually sees.
 *  ToolbarButton has a closed prop list — no `autoFocus` to forward — and its tip
 *  is revealed by the DS's own `:focus-within` rule, so the preview moves focus on
 *  mount rather than faking the tip with markup. */
export const WithTooltip = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button.h10-ds-tbtn')?.focus()
  }, [])
  return (
    // The tip is centred on its trigger (`left:50%; translateX(-50%)`), so a
    // trigger flush against the cell's left edge pushes it off-viewport. Indent.
    <div ref={ref} style={{ ...bar, marginTop: 56, marginLeft: 96 }}>
      <ToolbarButton icon={<FilterIcon />} label="Filter" description="Filter rows by condition" shortcut="⌘K" />
      <ToolbarButton icon={<ColumnsIcon />} label="Columns" description="Show, hide and reorder columns" shortcut="⌘G" />
    </div>
  )
}
