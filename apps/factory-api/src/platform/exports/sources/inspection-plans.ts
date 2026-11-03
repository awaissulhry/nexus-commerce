import { QUALITY_PLANS_VIEW } from '@nexus/factory-domain/quality/plans/permissions'
import { CATEGORY_WORDS, PLAN_STAGES, VERSION_STATUSES, type PlanStage, type VersionStatus } from '@nexus/factory-domain/quality/plans/rules'
import { listPlans, type ListQuery } from '../../../modules/quality/plans/plans'
import type { PlanRow } from '../../../modules/quality/plans/contract'
import { defineExportSource } from '../source'

/**
 * Quality › Inspection plans & AQL, tab Plans (`/quality/plans`, design quality.plans pl-plans; B-W2b-92): the export of
 * the Plans grid as the screen shows it. The address is the grid's: `?stage=INCOMING|CUTTING|IN_LINE|END_OF_LINE|FINAL|
 * RETURN`, `?status=DRAFT|APPROVED|RETIRED`, `?q=` (code or name, at most 80 characters); the screen's company. Read
 * through the module's listPlans (quality.plans.view over the company), at most 500 plans, no cursor. No money; the owner
 * is an office person, named as the grid names them.
 *
 * Registered in ./index.ts by the screen step (B-W2b-104) together with its page: the registry's test asks for a real
 * Office list page at `/quality/plans`, which this API step does not build.
 */

type Query = ListQuery

/** The file's language, from the words given for it (`lang`: ours, not the catalogue's). */
const langOf = (words: (code: string) => string): 'it' | 'en' => (words('lang') === 'it' ? 'it' : 'en')
/** A chip in the file's language: a category by its words, a record by its code and name. */
const chipLabel = (chip: PlanRow['appliesTo'][number], words: (code: string) => string): string => (chip.kind === 'CATEGORY' ? (CATEGORY_WORDS[chip.value]?.[langOf(words)] ?? chip.value) : chip.label)

export const inspectionPlans = defineExportSource<Query, PlanRow>({
  listKey: 'quality.plans',
  permission: QUALITY_PLANS_VIEW,
  query(address) {
    const stage = address.get('stage') ?? ''
    const status = address.get('status') ?? ''
    const q = (address.get('q') ?? '').slice(0, 80).trim() || undefined
    return {
      ...((PLAN_STAGES as readonly string[]).includes(stage) ? { stage: stage as PlanStage } : {}),
      ...((VERSION_STATUSES as readonly string[]).includes(status) ? { status: status as VersionStatus } : {}),
      ...(q ? { q } : {}),
    }
  },
  async read(caller, query) {
    const context = caller.factoryContext
    const companyId = context?.audience === 'office' ? context.companyId : undefined
    const page = await listPlans(caller, { ...query, ...(companyId ? { companyId } : {}) })
    return { rows: page.plans, next: null }
  },
  columns: {
    code: { value: (row) => row.code },
    stage: { value: (row, words) => words(`stage.${row.stage}`) },
    name: { value: (row) => row.name },
    appliesTo: { value: (row, words) => (row.appliesTo.length === 0 ? words('appliesTo.everything') : row.appliesTo.map((chip) => chipLabel(chip, words)).join(' · ')) },
    version: { value: (row) => (row.approved ? `v${row.approved.number}` : row.draft ? `v${row.draft.number}` : row.latestNumber > 0 ? `v${row.latestNumber}` : null) },
    status: { value: (row, words) => (row.draft?.submitted ? `${words(`status.${row.status}`)} · ${words('status.waitingApproval')}` : words(`status.${row.status}`)) },
    owner: { value: (row) => row.owner?.name ?? null },
    usedBy: { value: (row) => row.usedBy },
    lastChange: { value: (row) => ({ at: row.lastChangeAt }) },
  },
  words: {
    it: {
      lang: 'it',
      'stage.INCOMING': 'In arrivo',
      'stage.CUTTING': 'Taglio',
      'stage.IN_LINE': 'In linea',
      'stage.END_OF_LINE': 'Fine linea',
      'stage.FINAL': 'Finale',
      'stage.RETURN': 'Reso',
      'status.DRAFT': 'Bozza',
      'status.APPROVED': 'Approvato',
      'status.RETIRED': 'Ritirato',
      'status.waitingApproval': 'in attesa di approvazione',
      'appliesTo.everything': 'Tutto della sua fase',
    },
    en: {
      lang: 'en',
      'stage.INCOMING': 'Incoming',
      'stage.CUTTING': 'Cutting',
      'stage.IN_LINE': 'In-line',
      'stage.END_OF_LINE': 'End of line',
      'stage.FINAL': 'Final',
      'stage.RETURN': 'Return',
      'status.DRAFT': 'Draft',
      'status.APPROVED': 'Approved',
      'status.RETIRED': 'Retired',
      'status.waitingApproval': 'waiting for approval',
      'appliesTo.everything': 'Everything of its stage',
    },
  },
})
