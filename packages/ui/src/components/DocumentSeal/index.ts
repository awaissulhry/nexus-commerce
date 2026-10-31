/**
 * DocumentSeal (B-W2b-28) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/DocumentSeal` in the web, `@nexus/ui/components/DocumentSeal/index` by package path).
 */
export { DocumentSeal, type DocumentSealProps, type DocumentSealSigner } from './DocumentSeal'
export { DOCUMENT_SEAL_LABELS, type DocumentSealLabels } from './DocumentSealLabels'
export { hexOf, normalizeSha256, sealGroups, sealMatches, sealShort, sealSigned, sha256Hex } from './documentSealModel'
