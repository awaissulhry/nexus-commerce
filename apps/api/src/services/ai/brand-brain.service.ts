/**
 * MB.1 — Brand Brain RAG service.
 *
 * Manages the ContentEmbedding table (raw SQL only — vector(1536) is not
 * a Prisma-supported type). Provides:
 *
 *   ingestBrandKit(id)        — embed BrandKit.voiceNotes + tagline
 *   ingestBrandVoice(id)      — embed BrandVoice.body
 *   ingestAPlusContent(id)    — embed the latest APlusContentVersion snapshot
 *   ingestAllPendingContent() — batch-ingests every upserted-since-last-run row
 *   queryBrandBrain(query, opts) — cosine-nearest-neighbour retrieval
 *
 * All ContentEmbedding writes use prisma.$executeRaw; all reads use
 * prisma.$queryRaw. The snippet column stores a text excerpt (≤500 chars)
 * for the UI and for prompt injection without a follow-up DB lookup.
 *
 * gated by NEXUS_ENABLE_BRAND_BRAIN=1.
 */

import { randomUUID } from 'crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { embedText, EMBEDDING_MODEL, EMBEDDING_DIMS } from './embedding.service.js'

export const BRAND_BRAIN_ENABLED =
  process.env.NEXUS_ENABLE_BRAND_BRAIN === '1'

// ── Entity types ──────────────────────────────────────────────────────────

export type EmbeddingEntityType =
  | 'BRAND_KIT'
  | 'BRAND_VOICE'
  | 'APLUS_CONTENT'

// ── Upsert helpers ────────────────────────────────────────────────────────

function formatVector(vec: number[]): string {
  return `[${vec.join(',')}]`
}

async function upsertEmbedding(
  entityType: EmbeddingEntityType,
  entityId: string,
  field: string,
  snippet: string,
  vec: number[],
): Promise<void> {
  const id = randomUUID()
  const vecStr = formatVector(vec)
  await prisma.$executeRaw`
    INSERT INTO "ContentEmbedding"
      (id, "entityType", "entityId", "field", model, dimensions, embedding, snippet, "updatedAt")
    VALUES (
      ${id}, ${entityType}, ${entityId}, ${field},
      ${EMBEDDING_MODEL}, ${EMBEDDING_DIMS},
      ${vecStr}::vector, ${snippet.slice(0, 500)}, now()
    )
    ON CONFLICT ("entityType", "entityId", "field")
    DO UPDATE SET
      model      = EXCLUDED.model,
      dimensions = EXCLUDED.dimensions,
      embedding  = EXCLUDED.embedding,
      snippet    = EXCLUDED.snippet,
      "updatedAt" = now()
  `
}

// ── Ingest individual entities ────────────────────────────────────────────

export async function ingestBrandKit(id: string): Promise<boolean> {
  const kit = await prisma.brandKit.findUnique({
    where: { id },
    select: { id: true, brand: true, tagline: true, voiceNotes: true, notes: true },
  })
  if (!kit) return false

  const voiceText = [kit.voiceNotes, kit.notes].filter(Boolean).join('\n\n')
  const taglineText = [kit.brand, kit.tagline].filter(Boolean).join(' — ')

  if (voiceText.trim()) {
    const vec = await embedText(voiceText)
    await upsertEmbedding('BRAND_KIT', id, 'voice_notes', voiceText, vec)
  }
  if (taglineText.trim()) {
    const vec = await embedText(taglineText)
    await upsertEmbedding('BRAND_KIT', id, 'tagline', taglineText, vec)
  }
  return true
}

export async function ingestBrandVoice(id: string): Promise<boolean> {
  const bv = await prisma.brandVoice.findUnique({
    where: { id },
    select: { id: true, brand: true, marketplace: true, language: true, body: true },
  })
  if (!bv || !bv.body?.trim()) return false

  const vec = await embedText(bv.body)
  await upsertEmbedding('BRAND_VOICE', id, 'body', bv.body, vec)
  return true
}

export async function ingestAPlusContent(id: string): Promise<boolean> {
  // Embed the latest version snapshot
  const latest = await prisma.aPlusContentVersion.findFirst({
    where: { contentId: id },
    orderBy: { version: 'desc' },
    select: { id: true, contentId: true, snapshot: true },
  })
  if (!latest) return false

  const snap = latest.snapshot as Record<string, unknown> | null
  const text = snap ? JSON.stringify(snap).slice(0, 4000) : ''
  if (!text.trim()) return false

  const vec = await embedText(text)
  await upsertEmbedding('APLUS_CONTENT', id, 'latest_version', text, vec)
  return true
}

// ── Batch ingest ──────────────────────────────────────────────────────────

export interface IngestSummary {
  brandKits: number
  brandVoices: number
  aplusContents: number
  errors: number
}

export async function ingestAllPendingContent(): Promise<IngestSummary> {
  const summary: IngestSummary = { brandKits: 0, brandVoices: 0, aplusContents: 0, errors: 0 }

  // ── BrandKit ─────────────────────────────────────────────
  const kits = await prisma.brandKit.findMany({
    select: { id: true },
    take: 100,
  })
  for (const kit of kits) {
    try {
      const ok = await ingestBrandKit(kit.id)
      if (ok) summary.brandKits += 1
    } catch (err) {
      summary.errors += 1
      logger.warn('brand-brain: BrandKit ingest error', {
        id: kit.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── BrandVoice ───────────────────────────────────────────
  const voices = await prisma.brandVoice.findMany({
    where: { isActive: true },
    select: { id: true },
    take: 200,
  })
  for (const bv of voices) {
    try {
      const ok = await ingestBrandVoice(bv.id)
      if (ok) summary.brandVoices += 1
    } catch (err) {
      summary.errors += 1
      logger.warn('brand-brain: BrandVoice ingest error', {
        id: bv.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── APlusContent ─────────────────────────────────────────
  // Only embed PUBLISHED or latest-versioned content — DRAFT is noise.
  const aplus = await prisma.aPlusContent.findMany({
    where: { status: { in: ['PUBLISHED', 'APPROVED', 'SUBMITTED'] } },
    select: { id: true },
    take: 200,
  })
  for (const doc of aplus) {
    try {
      const ok = await ingestAPlusContent(doc.id)
      if (ok) summary.aplusContents += 1
    } catch (err) {
      summary.errors += 1
      logger.warn('brand-brain: APlusContent ingest error', {
        id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('brand-brain: ingest complete', { summary })
  return summary
}

// ── Vector search ─────────────────────────────────────────────────────────

export interface BrainResult {
  id: string
  entityType: string
  entityId: string
  field: string
  snippet: string
  distance: number
}

export async function queryBrandBrain(
  queryText: string,
  opts: { entityType?: EmbeddingEntityType; limit?: number } = {},
): Promise<BrainResult[]> {
  const limit = opts.limit ?? 5
  const vec = await embedText(queryText)
  const vecStr = formatVector(vec)

  try {
    let rows: BrainResult[]
    if (opts.entityType) {
      rows = await prisma.$queryRaw<BrainResult[]>`
        SELECT id, "entityType", "entityId", "field", snippet,
               embedding <=> ${vecStr}::vector AS distance
        FROM "ContentEmbedding"
        WHERE "entityType" = ${opts.entityType}
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${vecStr}::vector
        LIMIT ${limit}
      `
    } else {
      rows = await prisma.$queryRaw<BrainResult[]>`
        SELECT id, "entityType", "entityId", "field", snippet,
               embedding <=> ${vecStr}::vector AS distance
        FROM "ContentEmbedding"
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${vecStr}::vector
        LIMIT ${limit}
      `
    }
    return rows
  } catch (err) {
    // pgvector extension not available (e.g. non-Neon dev DB) — degrade gracefully
    logger.warn('brand-brain: vector search failed (pgvector unavailable?)', {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

// ── Status ────────────────────────────────────────────────────────────────

export interface BrainStatus {
  totalEmbeddings: number
  byEntityType: Array<{ entityType: string; count: number }>
  pgvectorAvailable: boolean
}

export async function getBrainStatus(): Promise<BrainStatus> {
  try {
    const rows = await prisma.$queryRaw<Array<{ entityType: string; count: bigint }>>`
      SELECT "entityType", COUNT(*)::bigint AS count
      FROM "ContentEmbedding"
      GROUP BY "entityType"
      ORDER BY "entityType"
    `
    const byEntityType = rows.map((r) => ({
      entityType: r.entityType,
      count: Number(r.count),
    }))
    const totalEmbeddings = byEntityType.reduce((a, r) => a + r.count, 0)
    return { totalEmbeddings, byEntityType, pgvectorAvailable: true }
  } catch {
    return { totalEmbeddings: 0, byEntityType: [], pgvectorAvailable: false }
  }
}
