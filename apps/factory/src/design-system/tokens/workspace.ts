/**
 * Advertising workspace grid roles. These preserve the established advertising
 * palette while keeping reusable grid components independent of primitive ramps.
 * The advertising shell supplies its existing light presentation in either app mode.
 * Other platforms use the default Nexus grid theme.
 */
export const workspaceVars = [
  { name: '--nds-wsgrid-surface', value: 'var(--nds-white)' },
  { name: '--nds-wsgrid-surface-raised', value: 'var(--nds-grey-25)' },
  { name: '--nds-wsgrid-surface-hover', value: 'var(--nds-grey-75)' },
  { name: '--nds-wsgrid-surface-sunken', value: 'var(--nds-grey-100)' },
  { name: '--nds-wsgrid-border', value: 'var(--nds-grey-150)' },
  { name: '--nds-wsgrid-frame-border', value: 'var(--nds-grey-200)' },
  { name: '--nds-wsgrid-control-border', value: 'var(--nds-grey-300)' },
  { name: '--nds-wsgrid-icon-soft', value: 'var(--nds-grey-450)' },
  { name: '--nds-wsgrid-text-muted', value: 'var(--nds-grey-500)' },
  { name: '--nds-wsgrid-text-secondary', value: 'var(--nds-grey-600)' },
  { name: '--nds-wsgrid-text-emphasis', value: 'var(--nds-grey-700)' },
  { name: '--nds-wsgrid-text', value: 'var(--nds-grey-800)' },
  { name: '--nds-wsgrid-text-strong', value: 'var(--nds-grey-900)' },
  { name: '--nds-wsgrid-selection-bg', value: 'var(--nds-blue-50)' },
  { name: '--nds-wsgrid-accent', value: 'var(--nds-blue-600)' },
  { name: '--nds-wsgrid-accent-hover', value: 'var(--nds-blue-700)' },
  { name: '--nds-wsgrid-auto-bg', value: 'var(--nds-blue-800)' },
  { name: '--nds-wsgrid-manual-bg', value: 'var(--nds-purple-600)' },
  { name: '--nds-wsgrid-sponsored-products-fg', value: 'var(--nds-purple-700)' },
  { name: '--nds-wsgrid-sponsored-display-fg', value: 'var(--nds-cyan-700)' },
  { name: '--nds-wsgrid-live-dot', value: 'var(--nds-green-500)' },
  { name: '--nds-wsgrid-on-accent', value: 'var(--nds-white)' },
] as const
