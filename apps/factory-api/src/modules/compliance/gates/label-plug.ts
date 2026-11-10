import type { CheckResult, GateTarget } from '@nexus/factory-domain/compliance/gates/gate'
import { labelRulesFor, type LabelRulesAnswer } from '../label-rules/gate'
import { plugGateCheck } from './plugs'

/**
 * B-W2b-253's label rules plugged into the one gate by name (B-W2b-254): a requirement whose checkKey is `label.ceMarking`,
 * `label.classWarnings`, `label.gloveMarking`, `label.qrCode` or `gpsr.contact` is computed by 253's `labelRulesFor` for the
 * label the gate reads (a released work order's frozen one, else the style's released revision's), per colourway × size and
 * the market the goods go to. A check that `blocks` is MISSING (253's words); PASS is present; NOT_APPLICABLE is not needed;
 * WARN, WAITING and UNKNOWN are shown in 253's words and never refuse. The gate's reader is never the floor role, so the
 * checks read what they need (`office: true`). No requirement rows for the four `label.*` keys are written here: they are
 * the Owner's (Rules & markets › Gates, B-W2b-265; 253's notes suggest the ON/OFF).
 */

export const LABEL_RULE_CHECK_KEYS = ['label.ceMarking', 'label.classWarnings', 'label.gloveMarking', 'label.qrCode', 'gpsr.contact'] as const

const NO_LABEL: CheckResult = { state: 'MISSING', message: 'No garment label template is set, so its marking is not known.', fix: 'set one on the style revision (Products › Labels).', facts: { code: 'label.none' }, evidence: null }

plugGateCheck(LABEL_RULE_CHECK_KEYS, { kinds: ['LABEL', 'DECLARATION'], market: false, who: 'COMPLIANCE', fix: 'labels' }, async (context) => {
  const labelTemplateId = context.labelTemplateId
  if (!labelTemplateId) return () => NO_LABEL
  const workOrder =
    context.subject?.type === 'WorkOrder' ? await context.db.workOrder.findUnique({ where: { id: context.subject.id }, select: { id: true, styleRevisionId: true } }) : null
  // One answer per colourway, size and market (several targets may share one).
  const answers = new Map<string, LabelRulesAnswer>()
  const keyOf = (target: GateTarget) => `${target.colourwayId ?? ''}|${target.size ?? ''}|${target.market?.code ?? ''}`
  for (const target of context.targets) {
    const key = keyOf(target)
    if (answers.has(key)) continue
    answers.set(
      key,
      await labelRulesFor(context.db, {
        labelTemplateId,
        styleId: context.style.row.id,
        styleRevisionId: workOrder?.styleRevisionId ?? null,
        colourwayId: target.colourwayId,
        size: target.size,
        workOrderId: workOrder?.id ?? null,
        marketCode: target.market?.code ?? null,
        day: context.day,
        office: context.office,
      }),
    )
  }
  return (_requirement, key, target) => {
    const check = answers.get(keyOf(target))?.byCheckKey.get(key)
    if (!check) return { state: 'MANUAL', message: 'The label rules do not check this here.', fix: null, facts: { code: 'label.notChecked', check: key }, evidence: null }
    const facts = { code: `label.${check.key}`, outcome: check.outcome, findings: check.findings.map((finding) => finding.path) }
    const evidence = { recordType: 'LabelTemplate', recordId: labelTemplateId, label: check.title }
    if (check.blocks) return { state: 'MISSING', message: check.words, fix: 'correct the label (Compliance › Labels & marking › Rule checks).', facts, evidence: null }
    if (check.outcome === 'PASS') return { state: 'PRESENT', message: check.words, fix: null, facts, evidence }
    if (check.outcome === 'NOT_APPLICABLE') return { state: 'NOT_NEEDED', message: check.words, fix: null, facts, evidence: null }
    return { state: 'MANUAL', message: check.words, fix: null, facts, evidence }
  }
})
