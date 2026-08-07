/**
 * NAF.AC.1 — Charter Studio: a worker's prompt becomes an editable,
 * versioned artifact instead of a code change plus a deploy.
 *
 * Resolution law (operator decision, AC §6.1): **code default ⊕ active
 * revision**. The code charter is the floor and the fallback — if no
 * revision is active, or the row cannot be read, the code charter runs,
 * exactly like the Phase-A fail-safe. Reverting to code is therefore
 * always one click and can never fail.
 *
 * Revisions are immutable: editing writes a NEW revision, activation moves
 * a pointer, and every activation supersedes its predecessor with a
 * timestamp. Nothing is ever overwritten, so the history is the audit.
 */
import type { Prisma } from '@nexus/database'
import prisma from '../../db.js'

/** The subset of policy a revision may carry (AC.4 edits ride here too). */
export interface RevisionPolicy {
  dailyBudgetUSD?: number
  maxTokensPerRun?: number
  maxFindingsPerRun?: number
  maxEvidenceAgeHours?: number
  modelProvider?: string | null
  modelName?: string | null
}

export interface RevisionRow {
  id: string
  charterKey: string
  revision: number
  systemPrompt: string
  policy: RevisionPolicy | null
  note: string
  author: string | null
  createdAt: Date
  activatedAt: Date | null
  supersededAt: Date | null
}

export async function listRevisions(charterKey: string): Promise<RevisionRow[]> {
  const rows = await prisma.agentCharterRevision.findMany({
    where: { charterKey },
    orderBy: { revision: 'desc' },
    take: 50,
  })
  return rows as unknown as RevisionRow[]
}

/** The revision currently in force, or null when the code charter runs. */
export async function getActiveRevision(
  charterKey: string,
): Promise<RevisionRow | null> {
  const row = await prisma.agentCharterRevision.findFirst({
    where: { charterKey, activatedAt: { not: null }, supersededAt: null },
    orderBy: { activatedAt: 'desc' },
  })
  return (row as unknown as RevisionRow) ?? null
}

/** Active revisions for many charters in one read (registry hot path). */
export async function getActiveRevisions(): Promise<Map<string, RevisionRow>> {
  const rows = await prisma.agentCharterRevision.findMany({
    where: { activatedAt: { not: null }, supersededAt: null },
    orderBy: { activatedAt: 'desc' },
  })
  const out = new Map<string, RevisionRow>()
  for (const r of rows as unknown as RevisionRow[]) {
    if (!out.has(r.charterKey)) out.set(r.charterKey, r)
  }
  return out
}

export async function createRevision(input: {
  charterKey: string
  systemPrompt: string
  note: string
  policy?: RevisionPolicy
  author?: string | null
}): Promise<RevisionRow> {
  const prompt = input.systemPrompt.trim()
  const note = input.note.trim()
  if (!prompt) throw new Error('a revision needs a prompt')
  if (!note) throw new Error('a revision needs a one-line note')

  const last = await prisma.agentCharterRevision.findFirst({
    where: { charterKey: input.charterKey },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  })
  const created = await prisma.agentCharterRevision.create({
    data: {
      charterKey: input.charterKey,
      revision: (last?.revision ?? 0) + 1,
      systemPrompt: prompt,
      note,
      policy: (input.policy ?? undefined) as Prisma.InputJsonValue | undefined,
      author: input.author ?? null,
    },
  })
  return created as unknown as RevisionRow
}

/** Activate a revision: supersede whatever was in force, point at this one. */
export async function activateRevision(
  charterKey: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  const target = await prisma.agentCharterRevision.findUnique({
    where: { id: revisionId },
  })
  if (!target || target.charterKey !== charterKey) return null
  const now = new Date()
  await prisma.agentCharterRevision.updateMany({
    where: { charterKey, activatedAt: { not: null }, supersededAt: null },
    data: { supersededAt: now },
  })
  const updated = await prisma.agentCharterRevision.update({
    where: { id: revisionId },
    data: { activatedAt: now, supersededAt: null },
  })
  return updated as unknown as RevisionRow
}

/** Back to the code charter: supersede everything, activate nothing. */
export async function revertToCode(charterKey: string): Promise<{ superseded: number }> {
  const r = await prisma.agentCharterRevision.updateMany({
    where: { charterKey, activatedAt: { not: null }, supersededAt: null },
    data: { supersededAt: new Date() },
  })
  return { superseded: r.count }
}

/** A line-level diff for the studio — added / removed / unchanged. */
export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

export function diffPrompts(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // Longest-common-subsequence table — prompts are tens of lines, so the
  // O(n·m) table is cheaper than pulling in a diff dependency.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! })
      i++
    } else {
      out.push({ kind: 'added', text: b[j]! })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! })
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! })
  return out
}

/* ── AC.8 — A/B: two revisions live, alternating by run ──────────────── */

export interface AbState {
  enabled: boolean
  candidateRevisionId: string | null
}

/**
 * Which prompt this run should use. Alternating on the charter's OWN run
 * count keeps the split even without a random source (Date.now/Math.random
 * are avoided so a replay is deterministic) — and a missing candidate
 * silently means "no split", never a broken run.
 */
export async function pickRevisionForRun(
  charterKey: string,
): Promise<{ revisionId: string | null; systemPrompt: string | null; arm: 'active' | 'candidate' }> {
  const charter = await prisma.agentCharter.findFirst({
    where: { key: charterKey },
    select: { abEnabled: true, candidateRevisionId: true },
  })
  const active = await getActiveRevision(charterKey)
  if (!charter?.abEnabled || !charter.candidateRevisionId) {
    return {
      revisionId: active?.id ?? null,
      systemPrompt: active?.systemPrompt ?? null,
      arm: 'active',
    }
  }
  const runs = await prisma.agentRun.count({ where: { agentKey: charterKey, mode: { not: 'preview' } } })
  if (runs % 2 === 0) {
    return {
      revisionId: active?.id ?? null,
      systemPrompt: active?.systemPrompt ?? null,
      arm: 'active',
    }
  }
  const candidate = await prisma.agentCharterRevision.findUnique({
    where: { id: charter.candidateRevisionId },
  })
  if (!candidate || candidate.charterKey !== charterKey) {
    return {
      revisionId: active?.id ?? null,
      systemPrompt: active?.systemPrompt ?? null,
      arm: 'active',
    }
  }
  return { revisionId: candidate.id, systemPrompt: candidate.systemPrompt, arm: 'candidate' }
}

/** Compare the two arms on runs that actually happened. */
export async function compareAbArms(charterKey: string): Promise<{
  arms: Array<{
    label: string
    revisionId: string | null
    runs: number
    okRate: number | null
    findingsPerRun: number | null
    costPerRun: number | null
  }>
  callable: boolean
  note: string
}> {
  const charter = await prisma.agentCharter.findFirst({
    where: { key: charterKey },
    select: { abEnabled: true, candidateRevisionId: true },
  })
  const active = await getActiveRevision(charterKey)
  const ids = [active?.id ?? null, charter?.candidateRevisionId ?? null]
  const arms = []
  for (const [i, id] of ids.entries()) {
    const runs = await prisma.agentRun.findMany({
      where: { agentKey: charterKey, charterRevisionId: id, mode: { not: 'preview' } },
      select: { ok: true, findingCount: true, costUSD: true },
      take: 200,
    })
    arms.push({
      label: i === 0 ? 'live charter' : 'candidate',
      revisionId: id,
      runs: runs.length,
      okRate: runs.length ? runs.filter((r) => r.ok).length / runs.length : null,
      findingsPerRun: runs.length
        ? runs.reduce((s, r) => s + r.findingCount, 0) / runs.length
        : null,
      costPerRun: runs.length
        ? runs.reduce((s, r) => s + Number(r.costUSD ?? 0), 0) / runs.length
        : null,
    })
  }
  // Honesty: a handful of runs cannot tell you anything, and the UI must
  // say so rather than render a winner from noise.
  const callable = arms.every((a) => a.runs >= 5)
  return {
    arms,
    callable,
    note: callable
      ? 'Both arms have enough runs to compare.'
      : 'Not enough runs yet to call a winner — each arm needs at least 5.',
  }
}
