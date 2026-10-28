// design-sync entry barrel. The DS lives in packages/ui/src and is
// compiled in-app by Next.js; this barrel gives the converter one entry to
// bundle and one .d.ts tree to read the API contract from. Mirrors the DS's
// own three barrels exactly — it adds nothing and hides nothing.
export * from '../../packages/ui/src/primitives/index'
export * from '../../packages/ui/src/components/index'
export * from '../../packages/ui/src/patterns/index'
export * from '../../packages/ui/src/tokens/index'
export * from '../../packages/ui/src/lib/index'

// Preview harness seam — see preview-router-host.tsx. Underscore-prefixed so
// component discovery (`^[A-Z][A-Za-z0-9]*$`) never picks it up as DS API.
export { _PreviewRouterHost } from './preview-router-host'
