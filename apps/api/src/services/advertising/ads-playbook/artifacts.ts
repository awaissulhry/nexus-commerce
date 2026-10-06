/**
 * ADS PLAYBOOK PB-5a — the hook the playbook's other parts plug into (PB-5 spec §4): the hourly-plan groups (PB-8), the
 * harvest rule (PB-6b) and the isolation rule (PB-7) are each an `ArtifactCompiler`, one import and one entry in
 * ARTIFACT_COMPILERS. The harvest and isolation rules are wired (`syncHarvestRule`, `syncIsolationRule`): each saves its
 * rule once and writes its own link (so the hook stores none for them); a build or an adopt compiles them born OFF, and
 * only START switches them on (PB-5b).
 *
 *   preview     every op's preview shows what each compiler would do (no writes)
 *   compile     after the slot links of a build or an adopt: each compiler creates (or updates) its artifacts DISABLED and
 *               returns their links, written as AdsPlaybookLink { kind, key, refId, origin built, compiledVersion }
 *   setEnabled  START switches them on, STOP off (PB-5b)
 *
 * A compiler's errors become the op's errors (a build is then PARTIAL); a compiler never throws the run away.
 */
import prisma from '../../../db.js'
import type { AdsActor } from '../ads-mutation.service.js'
import type { TemplateDoc } from './doc.js'
import { syncHarvestRule } from './harvest-rule.js'
import { syncIsolationRule } from './isolation-run.js'

export type ArtifactKind = 'rankGroup' | 'harvestRule' | 'isolationRule'

export interface ArtifactSlot {
  key: string
  campaignId: string
  adGroupId: string | null
  origin: 'built' | 'adopted'
  rankRole: 'performance' | 'research' | 'none'
}

export interface ArtifactContext {
  playbookId: string
  market: string
  productId: string
  nameToken: string
  /** Resolved: rank.roles, harvest.edges, isolation. */
  doc: TemplateDoc
  /** Every linked slot after the build / adopt. */
  slots: ArtifactSlot[]
  mode: 'build' | 'adopt' | 'start' | 'stop'
  actor: AdsActor
  changeSetId: string | null
  compiledVersion: number
}

/** One artifact a playbook owns, e.g. { key: 'rank:performance', refId: RankScheduleGroup.id }. */
export interface ArtifactLink { key: string; refId: string }

export interface ArtifactPreviewLine {
  kind: ArtifactKind
  key: string
  does: 'create' | 'update' | 'keep' | 'enable' | 'disable' | 'report'
  summary: string
  refId?: string
}

export interface ArtifactCompiler {
  kind: ArtifactKind
  /** No writes; shown in every op's preview. */
  preview(ctx: ArtifactContext, links: readonly ArtifactLink[]): Promise<ArtifactPreviewLine[]>
  /** build / adopt: created DISABLED. */
  compile(ctx: ArtifactContext, links: readonly ArtifactLink[]): Promise<{ links: ArtifactLink[]; errors: string[] }>
  /** START / STOP. */
  setEnabled(ctx: ArtifactContext, links: readonly ArtifactLink[], enabled: boolean): Promise<{ changed: string[]; errors: string[] }>
}

/**
 * A compiled rule's switch-off (STOP, PB-5b): the playbook's own rules, by their links. ensureCompiledRule never switches
 * a rule off, so STOP does it here.
 */
async function switchRulesOff(links: readonly ArtifactLink[]): Promise<{ changed: string[]; errors: string[] }> {
  const ids = links.map((l) => l.refId)
  if (!ids.length) return { changed: [], errors: [] }
  const on = await prisma.automationRule.findMany({ where: { id: { in: ids }, enabled: true }, select: { id: true } })
  if (on.length) await prisma.automationRule.updateMany({ where: { id: { in: on.map((r) => r.id) } }, data: { enabled: false } })
  return { changed: on.map((r) => r.id), errors: [] }
}

/** A compiled rule as a compiler: `sync(playbookId, { enabled })` saves it once and writes its own link. */
function ruleCompiler(kind: 'harvestRule' | 'isolationRule', key: string, words: string, sync: (playbookId: string, opts: { enabled: boolean; actor?: string }) => Promise<
  { saved?: boolean; ruleId?: string | null; enabled?: boolean; keptOff?: string; problems?: string[]; warnings?: string[] }
>): ArtifactCompiler {
  const errorsOf = (r: { saved?: boolean; ruleId?: string | null; problems?: string[] }) => (r.saved === false || (r.ruleId === null && r.problems?.length) ? r.problems ?? [] : [])
  return {
    kind,
    async preview(_ctx, links) {
      return [{ kind, key: links[0]?.key ?? key, does: links.length ? 'update' : 'create', summary: `${words}, compiled from the product's linked slots: born off — START switches it on`, ...(links[0] ? { refId: links[0].refId } : {}) }]
    },
    async compile(ctx) {
      // Born off (a build or an adopt); the rule writes its own link, so none is returned to store.
      const r = await sync(ctx.playbookId, { enabled: false, actor: ctx.actor })
      return { links: [], errors: errorsOf(r) }
    },
    async setEnabled(ctx, links, enabled) {
      if (!enabled) return switchRulesOff(links)
      const r = await sync(ctx.playbookId, { enabled: true, actor: ctx.actor })
      const errors = errorsOf(r)
      return { changed: r.enabled && r.ruleId ? [r.ruleId] : [], errors: r.keptOff ? [...errors, r.keptOff] : errors }
    },
  }
}

/** PB-6b: the harvest rule · PB-7: the isolation rule · PB-8: rankGroupCompiler. */
export const ARTIFACT_COMPILERS: readonly ArtifactCompiler[] = [
  ruleCompiler('harvestRule', 'harvest', "the product's harvest rule", syncHarvestRule),
  ruleCompiler('isolationRule', 'isolation', "the product's isolation rule", syncIsolationRule),
]

/** An artifact link as the playbook stores it (AdsPlaybookLink of its kind). */
export interface StoredArtifactLink { kind: string; key: string; refId: string }

const errorOf = (kind: string, e: unknown) => `${kind}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`

/** Every compiler's preview lines; a compiler that fails names why instead of hiding the others. */
export async function previewArtifacts(ctx: ArtifactContext, links: readonly StoredArtifactLink[], compilers: readonly ArtifactCompiler[] = ARTIFACT_COMPILERS): Promise<{ lines: ArtifactPreviewLine[]; errors: string[] }> {
  const lines: ArtifactPreviewLine[] = []
  const errors: string[] = []
  for (const c of compilers) {
    try { lines.push(...await c.preview(ctx, links.filter((l) => l.kind === c.kind))) } catch (e) { errors.push(errorOf(c.kind, e)) }
  }
  return { lines, errors }
}

/** Every compiler, after the slot links: the links each returns (to store, with its kind) and every error. */
export async function compileArtifacts(ctx: ArtifactContext, links: readonly StoredArtifactLink[], compilers: readonly ArtifactCompiler[] = ARTIFACT_COMPILERS): Promise<{ links: StoredArtifactLink[]; errors: string[] }> {
  const out: StoredArtifactLink[] = []
  const errors: string[] = []
  for (const c of compilers) {
    try {
      const r = await c.compile(ctx, links.filter((l) => l.kind === c.kind))
      out.push(...r.links.map((l) => ({ kind: c.kind, key: l.key, refId: l.refId })))
      errors.push(...r.errors.map((e) => `${c.kind}: ${e}`))
    } catch (e) { errors.push(errorOf(c.kind, e)) }
  }
  return { links: out, errors }
}
