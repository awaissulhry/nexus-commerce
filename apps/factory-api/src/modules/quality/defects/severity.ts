import { SAFETY_LAW, SAFETY_RULE, SEVERITY_CLASSES } from '@nexus/factory-domain/quality/defects/severity'
import type { CommandCaller } from '../../../core/command'
import { officeOf } from './access'

/**
 * The severity classes with the safety rule (B-W2b-90; QHS-002; design quality.defects df-severity: "Text per class;
 * 'Critical = safety or compliance failure; never accepted (AQL 0)' locked with LawRef to Reg. 2016/425").
 *
 *   GET /quality/severity   quality.defects.view: critical, major and minor with their words and what each means (Italian
 *                           and English), the acceptance number the rule fixes (critical: 0), which class is locked and
 *                           the law it rests on, and how many active defects of the library each class holds by default.
 *                           `editable` false: the texts are fixed until a place keeps a tenant's own (a schema need); the
 *                           critical text stays locked even then.
 *
 * The rule itself is factory-domain quality/defects/severity (acceptanceProblem, recordedClassProblem,
 * acceptedDecisionProblem): the inspection, AQL and NCR steps call it in their commands; the vocabulary read gives each
 * defect the classes a record may give it.
 */
export async function readSeverity(caller: CommandCaller) {
  officeOf(caller)
  return caller.withClient(async (client) => {
    const counts = await client.defectCode.groupBy({ by: ['severity'], where: { active: true, parentId: { not: null } }, _count: { _all: true } })
    const defectsOf = (klass: string) => counts.find((row) => row.severity === klass)?._count._all ?? 0
    return {
      classes: SEVERITY_CLASSES.map((entry) => ({
        class: entry.class,
        rank: entry.rank,
        words: { ...entry.words },
        meaning: { ...entry.meaning },
        acceptanceNumber: entry.acceptanceNumber,
        locked: entry.locked,
        law: entry.law,
        defects: defectsOf(entry.class),
      })),
      safetyRule: { ...SAFETY_RULE, law: SAFETY_LAW },
      editable: false,
    }
  })
}
