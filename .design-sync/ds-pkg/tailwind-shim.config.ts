/**
 * Emits the Tailwind utilities that two DS components depend on.
 *
 * `ToolbarButton` / `ToolbarDivider` and part of `ColumnGroupModal` are styled
 * with Tailwind utilities rather than the DS's own `.h10-ds-*` convention, so
 * they render unstyled anywhere the consuming app's Tailwind build is absent —
 * which is every design built from this bundle. This regenerates exactly those
 * utilities from apps/web's REAL config, so the values are the app's own rather
 * than hand-copied.
 *
 * `preflight` is off on purpose: the DS stylesheets are authored against the
 * app's global reset, but injecting the full reset here would change the
 * baseline for all 60 components. The narrow reset those two need lives in
 * base.css instead.
 */
import type { Config } from 'tailwindcss'
import appConfig from '../../apps/web/tailwind.config'

const config: Config = {
  ...appConfig,
  // Tailwind resolves content globs against CWD, not the config file — build.mjs
  // runs the CLI from the repo root.
  content: [
    './apps/web/src/design-system/primitives/ToolbarButton.tsx',
    './apps/web/src/design-system/components/ColumnGroupModal.tsx',
  ],
  corePlugins: { preflight: false },
}
export default config
