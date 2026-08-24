// design-sync entry barrel. The DS lives in apps/web/src/design-system and is
// compiled in-app by Next.js; this barrel gives the converter one entry to
// bundle and one .d.ts tree to read the API contract from. Mirrors the DS's
// own three barrels exactly — it adds nothing and hides nothing.
export * from '../../apps/web/src/design-system/primitives/index'
export * from '../../apps/web/src/design-system/components/index'
export * from '../../apps/web/src/design-system/patterns/index'
export * from '../../apps/web/src/design-system/tokens/index'
export * from '../../apps/web/src/design-system/lib/index'

// Preview harness seam — see preview-router-host.tsx. Underscore-prefixed so
// component discovery (`^[A-Z][A-Za-z0-9]*$`) never picks it up as DS API.
export { _PreviewRouterHost } from './preview-router-host'
