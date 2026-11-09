import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import {
  editRefusal,
  editRuleFor,
  editRuleTable,
  type EditFacts,
  type EditKind,
  type EditRefusal,
  type EditRule,
  type EditRuleRow,
  type LifecycleRefusal,
  type RuleSource,
  type StyleLifecycle,
} from '@nexus/factory-domain/product/lifecycle/rules'
import type { CommandTx } from '../../../core/command'

/**
 * THE edit rule of a style (B-W2b-221; PRD-182; factory-domain product/lifecycle/rules): every product write asks it with
 * the kind of write, inside its command, after the style row is locked (W1's lockStyle / lockStyleRow, or command()'s record
 * guard on the Style), so a move of the style and the write take turns:
 *
 *   await requireEditRule(tx, styleId, 'SPEC')     // a 409 `refusal/<CODE>` in words, or nothing
 *
 * Callers (each a one-line forced edit in a W1 file, named in the step's notes): styles/styles.ts (update: DETAILS or SPEC by
 * the fields changed; garment numbering: SPEC), styles/colourways.ts (SPEC), styles/revisions.ts (a new revision:
 * NEW_REVISION), bom/revisions.ts (copy into a new draft: NEW_REVISION; release: RELEASE), bom/store.ts, routing/store.ts and
 * pieces/store.ts lockDraft (DRAFT), and this step's types/ (a style's type: SPEC). Later writes of a style (texts, pictures,
 * pattern files, GTINs, options: B-W2b-227, -236, -211's API) call it the same way.
 *
 * The rule: the ProductSettings row of the style's company, then the tenant-wide row (id = the tenant), then the default.
 */

export class EditRefusedError extends ConflictError {
  override name = 'EditRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: EditRefusal | LifecycleRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: EditRefusal | LifecycleRefusal): never => {
  throw new EditRefusedError(refusal)
}

type Reader = Pick<CommandTx, 'style' | 'styleRevision' | 'productSettings'> | FactoryClient

const RULE_COLUMNS = {
  editRuleConcept: true,
  editRuleDevelopment: true,
  editRuleSampling: true,
  editRuleApproved: true,
  editRuleInProduction: true,
  editRulePhaseOut: true,
  editRuleDiscontinued: true,
} as const

/** The company's and the tenant-wide ProductSettings rows (edit rules only); null where none. */
export async function ruleRows(db: Reader, tenantId: string, companyId: string | null): Promise<{ company: EditRuleRow | null; tenant: EditRuleRow | null }> {
  const company = companyId === null ? null : await db.productSettings.findUnique({ where: { id: companyId }, select: RULE_COLUMNS })
  const tenant = await db.productSettings.findUnique({ where: { id: tenantId }, select: RULE_COLUMNS })
  return { company, tenant }
}

export interface StyleEditRule {
  readonly styleId: string
  readonly tenantId: string
  readonly companyId: string | null
  readonly facts: EditFacts
  readonly rule: EditRule
  readonly source: RuleSource
  readonly table: { state: StyleLifecycle; rule: EditRule; source: RuleSource }[]
}

/** The style's state, its open draft and the rule in force (a read, or inside a command after the style's lock). */
export async function editRuleOf(db: Reader, styleId: string): Promise<StyleEditRule> {
  const style = await db.style.findUnique({ where: { id: styleId }, select: { id: true, tenantId: true, companyId: true, code: true, lifecycle: true } })
  if (!style) throw new NotFoundError('Style not found.')
  const draft = await db.styleRevision.findFirst({ where: { styleId, status: 'DRAFT' }, select: { revision: true }, orderBy: { revision: 'desc' } })
  const rows = await ruleRows(db, style.tenantId, style.companyId)
  const { rule, source } = editRuleFor(style.lifecycle, rows.company, rows.tenant)
  return {
    styleId,
    tenantId: style.tenantId,
    companyId: style.companyId,
    facts: { code: style.code, lifecycle: style.lifecycle, draftRevision: draft?.revision ?? null },
    rule,
    source,
    table: editRuleTable(rows.company, rows.tenant),
  }
}

/** Refuses `kind` of write to the style in words (409 `refusal/<CODE>`) when its lifecycle state's rule does not allow it. */
export async function requireEditRule(tx: CommandTx, styleId: string, kind: EditKind): Promise<void> {
  const { rule, facts } = await editRuleOf(tx, styleId)
  const refusal = editRefusal(rule, kind, facts)
  if (refusal) refuse(refusal)
}
