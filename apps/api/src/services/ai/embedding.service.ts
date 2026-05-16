/**
 * MB.1 — Text embedding service.
 *
 * Single function: embedText(text) → number[1536]
 *
 * Provider: OpenAI text-embedding-3-small (1536 dims, ~$0.02/1M tokens).
 * Gated by OPENAI_API_KEY. When absent, returns a deterministic
 * unit-normalised mock vector derived from the text hash — allows
 * verifier scripts and dev runs to exercise the full RAG pipeline
 * without an API key.
 *
 * The 1536-dimension output is fixed regardless of provider so the
 * ContentEmbedding table schema (vector(1536)) never needs a migration
 * when switching embedding models. If a future model uses different
 * dimensions, update the migration and this constant together.
 */

import { logger } from '../../utils/logger.js'

export const EMBEDDING_DIMS = 1536
export const EMBEDDING_MODEL = 'text-embedding-3-small'

// ── OpenAI embeddings ─────────────────────────────────────────────────────

async function openAiEmbed(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000), // stay well under 8191-token limit
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI embeddings HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
  const vec = json.data?.[0]?.embedding
  if (!vec || vec.length !== EMBEDDING_DIMS) {
    throw new Error(`Unexpected embedding dims: ${vec?.length}`)
  }
  return vec
}

// ── Deterministic mock (no API key) ──────────────────────────────────────
// Uses a 53-bit hash of the input text to seed a simple sine-based
// pseudo-random number generator, then L2-normalises the result.
// The mock is stable across runs for the same input so verifier scripts
// get reproducible nearest-neighbour results.

function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

function mockEmbed(text: string): number[] {
  const seed = cyrb53(text)
  const vec = Array.from({ length: EMBEDDING_DIMS }, (_, i) =>
    Math.sin(seed * 0.000001 + i * 2.39996),
  )
  const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0))
  return vec.map((v) => v / norm)
}

// ── Public API ────────────────────────────────────────────────────────────

export async function embedText(text: string): Promise<number[]> {
  if (!text.trim()) return mockEmbed('empty')
  try {
    if (process.env.OPENAI_API_KEY) {
      return await openAiEmbed(text)
    }
  } catch (err) {
    logger.warn('embedding.service: OpenAI call failed, falling back to mock', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return mockEmbed(text)
}
