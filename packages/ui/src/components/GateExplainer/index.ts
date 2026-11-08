/**
 * GateExplainer (B-W2b-78) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet, LawRef's and the floor kit's button). Import
 * this folder (`@/design-system/components/GateExplainer` in the web, `@nexus/ui/components/GateExplainer/index` by
 * package path).
 */
export { GateExplainer, type GateAction, type GateCheck, type GateExplainerProps, type GateForm, type GateOverride } from './GateExplainer'
export { GATE_EXPLAINER_LABELS, type GateExplainerLabels } from './GateExplainerLabels'
export {
  gateBlockers,
  gateCheckName,
  gateHeldReason,
  gateLine,
  gateSummary,
  gateVerdict,
  type GateCheckInput,
  type GateCheckState,
  type GateSummary,
  type GateVerdict,
  type GateWords,
} from './gateExplainerModel'
