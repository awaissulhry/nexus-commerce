/**
 * PinSignBlock (B-W2b-28, D22) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load, and this part brings the floor kit's PinPad, FloorButton and their stylesheet).
 * Import this folder (`@/design-system/components/PinSignBlock` in the web, `@nexus/ui/components/PinSignBlock/index` by
 * package path).
 */
export { PinSignBlock, type PinSignBlockProps, type PinSignSigner } from './PinSignBlock'
export { PIN_SIGN_BLOCK_LABELS, type PinSignBlockLabels } from './PinSignBlockLabels'
export { pinSignView, type PinSignInput, type PinSignState, type PinSignView } from './pinSignBlockModel'
