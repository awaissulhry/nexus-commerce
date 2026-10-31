/**
 * LegalGate (B-W2b-28) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that barrel
 * into every page's first load; this part brings its own stylesheet and LawRef's). Import this folder
 * (`@/design-system/components/LegalGate` in the web, `@nexus/ui/components/LegalGate/index` by package path).
 */
export { LegalGate, type LegalGateAction, type LegalGateItem, type LegalGateProps } from './LegalGate'
export { LEGAL_GATE_LABELS, type LegalGateLabels } from './LegalGateLabels'
export { legalGateFolds, legalGateHeld, legalGateSummary, type LegalGateSummary, type LegalGateWords, type LegalItemState } from './legalGateModel'
