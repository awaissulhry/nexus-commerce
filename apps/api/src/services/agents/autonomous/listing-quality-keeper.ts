/**
 * ACP.4a — Listing-Quality Keeper (autonomous agent v1).
 *
 * The first agent that works on its own: on a schedule (or manual run) it
 * scans the catalog for listing-quality gaps, drafts concrete fixes via
 * AI-2, and QUEUES them as `apply-content` proposals in the approval
 * inbox. It never applies anything — every fix is a reversible,
 * human-approved master-content edit. This is the "agents that keep
 * working in a synced way" half of the ACP, kept safe by the same gate
 * the interactive copilot uses.
 *
 * Guardrails: capped per run (maxItems), deduped against already-pending
 * proposals, active non-deleted master products only, and a strict-JSON
 * draft (a product whose draft won't parse is skipped, never queued with
 * junk).
 */

import prisma from '../../../db.js'
import { aiDraft } from '../tools/draft.tools.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { logger } from '../../../utils/logger.js'
import type { AutonomousAgent, AutonomousAgentResult } from '../autonomous-agent.service.js'

const TITLE_MIN = 30 // Amazon titles below this read as thin.

interface Candidate {
  id: string
  sku: string
  name: string
  brand: string | null
  productType: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
}

function missingFields(p: Candidate): string[] {
  const m: string[] = []
  if (p.bulletPoints.length === 0) m.push('bulletPoints')
  if (!p.description || p.description.trim() === '') m.push('description')
  if (p.name.trim().length < TITLE_MIN) m.push('title')
  return m
}

/** Tolerant JSON extraction — strips markdown fences, takes the outermost
 *  object. Returns null when nothing parseable is present. */
function parseJsonLoose(s: string): Record<string, unknown> | null {
  const t = s
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const v = JSON.parse(t.slice(start, end + 1))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function buildApplyArgs(
  productId: string,
  fields: string[],
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  const args: Record<string, unknown> = { productId }
  if (fields.includes('title') && typeof parsed.title === 'string') {
    const t = parsed.title.trim().slice(0, 200)
    if (t) args.title = t
  }
  if (fields.includes('bulletPoints') && Array.isArray(parsed.bulletPoints)) {
    const bullets = parsed.bulletPoints
      .filter((b): b is string => typeof b === 'string' && b.trim() !== '')
      .map((b) => b.trim())
      .slice(0, 5)
    if (bullets.length > 0) args.bulletPoints = bullets
  }
  if (fields.includes('description') && typeof parsed.description === 'string') {
    const d = parsed.description.trim()
    if (d) args.description = d
  }
  // Need at least one real field beyond productId to be worth proposing.
  return Object.keys(args).length > 1 ? args : null
}

export const listingQualityKeeper: AutonomousAgent = {
  key: 'listing-quality-keeper',
  name: 'Listing-Quality Keeper',
  description:
    'Scans active products for missing bullet points / description / thin titles and queues reversible content-fix proposals.',

  async run({ runId, maxItems }): Promise<AutonomousAgentResult> {
    const result: AutonomousAgentResult = {
      scanned: 0,
      flagged: 0,
      proposed: 0,
      skippedExisting: 0,
      errors: 0,
      proposals: [],
    }

    // Products with an already-pending apply-content proposal — don't pile on.
    const pending = await prisma.agentApproval.findMany({
      where: { status: 'pending', toolName: 'apply-content' },
      select: { args: true },
    })
    const pendingIds = new Set(
      pending
        .map((p) => (p.args as { productId?: string } | null)?.productId)
        .filter((x): x is string => typeof x === 'string'),
    )

    // Over-fetch so dedupe still leaves a full batch to work with.
    const candidates = (await prisma.product.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        parentId: null,
        OR: [
          { bulletPoints: { isEmpty: true } },
          { description: null },
          { description: '' },
        ],
      },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        productType: true,
        description: true,
        bulletPoints: true,
        keywords: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: Math.max(maxItems * 4, maxItems),
    })) as Candidate[]
    result.scanned = candidates.length

    for (const p of candidates) {
      if (result.proposed >= maxItems) break
      const fields = missingFields(p)
      if (fields.length === 0) continue
      result.flagged++
      if (pendingIds.has(p.id)) {
        result.skippedExisting++
        continue
      }

      try {
        const prompt = [
          'You improve marketplace product listings for a motorcycle-gear brand.',
          `Return ONLY strict JSON (no markdown, no commentary) with EXACTLY these keys: ${fields.join(', ')}.`,
          fields.includes('title')
            ? '- title: a punchy, specific product title, 60–150 chars.'
            : '',
          fields.includes('bulletPoints')
            ? '- bulletPoints: an array of EXACTLY 5 benefit-led strings.'
            : '',
          fields.includes('description')
            ? '- description: 1–2 short paragraphs of plain text.'
            : '',
          'Write in the product\'s existing language. Keep brand names and SKUs verbatim.',
          '',
          'Product:',
          JSON.stringify(
            {
              sku: p.sku,
              name: p.name,
              brand: p.brand,
              productType: p.productType,
              description: p.description,
              bulletPoints: p.bulletPoints,
              keywords: p.keywords,
            },
            null,
            2,
          ),
        ]
          .filter(Boolean)
          .join('\n')

        const draft = await aiDraft('listing-content', prompt, 'Product', p.id)
        const parsed = parseJsonLoose(draft.suggestion)
        if (!parsed) {
          result.errors++
          continue
        }
        const applyArgs = buildApplyArgs(p.id, fields, parsed)
        if (!applyArgs) {
          result.errors++
          continue
        }

        const out = await runOrQueueTool(
          'apply-content',
          applyArgs,
          { userId: null },
          runId,
        )
        if (out.mode === 'queued' && out.approvalId) {
          result.proposed++
          result.proposals.push({
            productId: p.id,
            sku: p.sku,
            approvalId: out.approvalId,
            summary: `content: ${Object.keys(applyArgs)
              .filter((k) => k !== 'productId')
              .join('+')}`,
          })
        } else {
          result.errors++
        }
      } catch (err) {
        result.errors++
        logger.warn('listing-quality-keeper: product failed', {
          productId: p.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return result
  },
}
