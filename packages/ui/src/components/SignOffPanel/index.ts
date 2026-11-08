/**
 * SignOffPanel (B-W2b-78) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet and the floor kit's button). Import this
 * folder (`@/design-system/components/SignOffPanel` in the web, `@nexus/ui/components/SignOffPanel/index` by package
 * path).
 */
export { SignOffPanel, type DutyRule, type SignOffAction, type SignOffPanelProps, type SignOffStep } from './SignOffPanel'
export { SIGN_OFF_PANEL_LABELS, type SignOffPanelLabels } from './SignOffPanelLabels'
export {
  dutyText,
  signOffCurrent,
  signOffStepHeld,
  signOffSummary,
  type DutyKind,
  type DutyRuleInput,
  type DutyState,
  type SignMethod,
  type SignOffSummary,
  type SignOffWords,
  type SignStepInput,
  type SignStepState,
} from './signOffPanelModel'
