/**
 * Advertising workspace grid CONTENT roles: the Auto/Manual targeting tags, the SP/SD programme badges, the live dot
 * and the ink on those filled marks. The grid's chrome — header, cells, hover, selection, checkbox, totals, frame — is
 * the engine's (`tokens/grid.ts`), as on /products (grid audit wave 4, E1).
 */
export const workspaceVars = [
  { name: '--nds-wsgrid-auto-bg', value: 'var(--nds-blue-800)' },
  { name: '--nds-wsgrid-manual-bg', value: 'var(--nds-purple-600)' },
  { name: '--nds-wsgrid-sponsored-products-fg', value: 'var(--nds-purple-700)' },
  { name: '--nds-wsgrid-sponsored-display-fg', value: 'var(--nds-cyan-700)' },
  { name: '--nds-wsgrid-live-dot', value: 'var(--nds-green-500)' },
  { name: '--nds-wsgrid-on-accent', value: 'var(--nds-white)' },
] as const
