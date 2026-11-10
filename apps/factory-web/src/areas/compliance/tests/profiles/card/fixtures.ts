import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../../../quality/_shared/fixtures'
import { failedRead, ready, reading } from '../../../../quality/_shared/model'
import { demoEvaluation, demoProfileRecord, PROFILES } from '../../substances/_demo/fixtures'
import { ProfileCardDesign, type ProfileCardCase } from '../../substances/_demo/designs/fixtures'
import { draftOf, profilesCan } from '../model'
import type { ProfileCardModel } from './view/ProfileCardView'

/**
 * SCR-048-profile — the material's compliance profile on the material record's Compliance tab (B-W2b-267; design
 * compliance.tests sec:ts-profiles "Row → the material record's Compliance tab"). Made-up data only: incomplete with what keeps
 * it so, the confirmations being edited (one save, the evaluator runs in it), complete, blocked by a failed test, the rule
 * verdicts with their law and proof, the SVHC answer against an older Candidate List, PPE innocuousness, the reading, failed
 * and read-only states.
 */

function cardModel(over: Partial<ProfileCardModel> = {}, role: RoleCase = 'owner'): ProfileCardCase {
  return {
    model: {
      prefix: PREFIX,
      itemId: PROFILES[0]!.material.id,
      can: profilesCan([...ROLE_PERMISSIONS[role]]),
      online: true,
      profile: ready(demoProfileRecord()),
      evaluation: ready(demoEvaluation()),
      draft: null,
      busy: false,
      notice: null,
      ...over,
    },
  }
}

const leather = demoProfileRecord()
const lining = demoProfileRecord(PROFILES[1]!, { labResults: [], declarationRequests: [] })
const zip = demoProfileRecord(PROFILES[2]!, { labResults: [{ resultId: 'r9', lot: { id: 'l9', code: 'DEMO-L-0390' }, test: 'NICKEL', verdict: 'FAIL', testedOn: '2026-10-21', value: '0.900', belowDetectionLimit: false, unit: 'µg/cm²/week', limit: '0.500', method: 'EN 1811', lab: 'Demo Lab', current: true }] })
const never = demoProfileRecord(PROFILES[4]!, { labResults: [], declarationRequests: [] })

export const designScreen = defineDesignScreen<ProfileCardCase>({
  screen: 'SCR-048-profile',
  title: 'Material › Compliance › Substances and evidence (the profile)',
  view: ProfileCardDesign,
  cases: [
    { id: 'incomplete', label: 'Incomplete: tannage not confirmed, declarations missing or asked, azo innocuousness missing', model: cardModel(), note: 'The evaluator’s English sentence is never shown: what keeps it from complete is said from the flags.' },
    { id: 'editing', label: 'Confirm the tannage and the origin (one save; the evaluator runs in it)', model: cardModel({ draft: { ...draftOf(leather), tannageConfirmed: true, originCountry: 'IT' } }) },
    { id: 'editing-refused', label: 'The origin typed is not two letters (Save held with why)', model: cardModel({ draft: { ...draftOf(leather), originCountry: 'ITA' } }) },
    { id: 'saved', label: 'Saved: evaluated again in the same step', model: cardModel({ notice: { key: 'done.profileSaved.INCOMPLETE', tone: 'success' } }) },
    { id: 'complete', label: 'Complete: every rule met, both confirmations', model: cardModel({ profile: ready(lining), evaluation: ready({ ...demoEvaluation('COMPLETE'), rules: demoEvaluation().rules.map((rule) => (rule.status === 'MISSING' ? { ...rule, status: 'MET' as const, metBy: 'DECLARATION' as const } : rule)) }) }) },
    { id: 'blocked', label: 'Blocked: a nickel test failed', model: cardModel({ profile: ready(zip), evaluation: ready({ ...demoEvaluation('BLOCKED'), rules: [{ ...demoEvaluation().rules[3]!, status: 'FAILED', why: null, needs: { test: 'NICKEL', declaration: 'NICKEL' } }] }) }) },
    { id: 'never', label: 'Never evaluated: no profile yet', model: cardModel({ profile: ready(never), evaluation: ready({ ...demoEvaluation(), rules: [] }) }) },
    { id: 'rules-failed', label: 'The rules’ verdicts could not be read (the rest stays)', model: cardModel({ evaluation: failedRead('problem.unavailable') }) },
    { id: 'read-only', label: 'Read-only: Confirm and Evaluate again held with why; no Request declarations', model: cardModel({}, 'readOnly') },
    { id: 'offline', label: 'Offline: the writes held', model: cardModel({ online: false }) },
    { id: 'loading', label: 'Reading the profile', model: cardModel({ profile: reading(), evaluation: reading() }) },
    { id: 'error', label: 'The profile could not be read', model: cardModel({ profile: failedRead('problem.unavailable') }) },
  ],
})
