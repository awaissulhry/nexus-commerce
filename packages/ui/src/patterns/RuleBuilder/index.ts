/**
 * RuleBuilder (B-W2b-207) — an entry point of its own, NOT re-exported by the patterns barrel (the web pulls that barrel
 * into its pages; this part brings its own stylesheet). Import this folder (`@/design-system/patterns/RuleBuilder` in the
 * web, `@nexus/ui/patterns/RuleBuilder/index` by package path).
 */
export { RuleBuilder, type RuleBuilderProps } from './RuleBuilder'
export { RULE_BUILDER_LABELS, type RuleBuilderLabels } from './RuleBuilderLabels'
export {
  newRuleRow,
  operatorNeedsValue,
  operatorsOf,
  operatorTakesMany,
  RULE_OPERATORS_BY_KIND,
  ruleHeldReason,
  ruleNumber,
  rulePreview,
  ruleProblems,
  ruleProblemText,
  ruleRowProblem,
  ruleRowText,
  ruleValueText,
  withRuleField,
  withRuleOperator,
  type RuleCombinator,
  type RuleDraft,
  type RuleField,
  type RuleFieldKind,
  type RuleFieldOption,
  type RuleOperator,
  type RulePreviewWords,
  type RuleRow,
  type RuleRowProblem,
} from './ruleBuilderModel'
