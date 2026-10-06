/**
 * ADS PLAYBOOK PB-5a — the hook the playbook's other parts plug into (PB-5 spec §4): the hourly-plan groups (PB-8), the
 * harvest rule (PB-6b) and the isolation rule (PB-7) are each an `ArtifactCompiler`, one import and one entry in
 * ARTIFACT_COMPILERS. EMPTY in PB-5a: a build or an adopt writes its slot links and nothing else.
 *
 *   preview     every op's preview shows what each compiler would do (no writes)
 *   compile     after the slot links of a build or an adopt: each compiler creates (or updates) its artifacts DISABLED and
 *               returns their links, written as AdsPlaybookLink { kind, key, refId, origin built, compiledVersion }
 *   setEnabled  START switches them on, STOP off (PB-5b)
 *
 * A compiler's errors become the op's errors (a build is then PARTIAL); a compiler never throws the run away.
 */
import type { AdsActor } from '../ads-mutation.service.js'
import type { TemplateDoc } from './doc.js'

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

/** PB-8: rankGroupCompiler · PB-6b: the harvest rule · PB-7: the isolation rule. */
export const ARTIFACT_COMPILERS: readonly ArtifactCompiler[] = []

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
