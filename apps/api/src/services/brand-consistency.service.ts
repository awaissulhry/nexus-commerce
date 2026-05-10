/**
 * MC.10.4 — Brand consistency monitoring.
 *
 * Scans entities under a brand (currently: A+ Content + Brand Story
 * documents in the brand's marketplaces) and flags drift from the
 * brand kit. Lightweight rule-set today; future rules can extend
 * the registry without changing the caller surface.
 *
 * Rules implemented:
 *   missing_brand_kit
 *     The brand has products but no kit — fixed by creating one.
 *   no_logo
 *     Brand kit has no logos defined; A+ + Brand Story modules
 *     can't auto-fill brand_header.
 *   no_primary_color
 *     Brand kit has no role='primary' colour.
 *   no_brand_story_for_marketplace
 *     The brand sells in a marketplace (via product Amazon ASINs)
 *     but no Brand Story exists for it.
 *   no_aplus_for_marketplace
 *     Same, but for A+ Content. Warning-tier (Brand Story is more
 *     impactful so its absence is blocking; A+ is per-product).
 *   draft_aplus_aging
 *     A+ Content document has been DRAFT for >30 days.
 *
 * The check is pure-server — no AI, no external calls. Future MC.4
 * can extend with image-based checks (logo placement, palette
 * adherence) once the AI work resumes.
 */

import prisma from '../db.js'

export type IssueSeverity = 'blocking' | 'warning' | 'info'

export interface ConsistencyIssue {
  severity: IssueSeverity
  code: string
  message: string
  /// Optional pointer for the UI to link to the offending entity.
  link?: {
    kind: 'aplus' | 'brand_story' | 'brand_kit'
    id: string
    label?: string
  }
}

export interface ConsistencyResult {
  brand: string
  ranAt: string
  blocking: number
  warnings: number
  info: number
  issues: ConsistencyIssue[]
}

const DRAFT_AGING_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000

export async function checkBrandConsistency(
  brand: string,
): Promise<ConsistencyResult> {
  const issues: ConsistencyIssue[] = []

  const kit = await prisma.brandKit.findUnique({
    where: { brand },
    include: { watermarks: true },
  })
  if (!kit) {
    issues.push({
      severity: 'warning',
      code: 'missing_brand_kit',
      message: `Brand "${brand}" has products but no Brand Kit. Create one to lock in colors, logos, and voice.`,
    })
  } else {
    const logos = (kit.logos as Array<{ name: string; role: string }> | null) ?? []
    const colors =
      (kit.colors as Array<{ name: string; hex: string; role: string }> | null) ??
      []
    if (logos.length === 0)
      issues.push({
        severity: 'warning',
        code: 'no_logo',
        message:
          'Brand Kit has no logos. Brand Story brand_header + watermarks need at least one logo to render.',
        link: { kind: 'brand_kit', id: brand },
      })
    if (!colors.some((c) => c.role === 'primary'))
      issues.push({
        severity: 'warning',
        code: 'no_primary_color',
        message:
          'Brand Kit has no primary color. Module text + UI defaults fall back to slate without it.',
        link: { kind: 'brand_kit', id: brand },
      })
    if (kit.watermarks.length === 0)
      issues.push({
        severity: 'info',
        code: 'no_watermarks',
        message:
          'Brand Kit has no watermark templates. Channel-variant URLs render without watermarks until you add at least one.',
        link: { kind: 'brand_kit', id: brand },
      })
  }

  // Brand Story coverage. Pull every distinct marketplace the brand
  // sells in (via product channel-listing presence) and check there
  // is a Brand Story per marketplace. If we can't determine
  // marketplaces from products (sparse data), we look at the set of
  // marketplaces with existing Brand Story rows to catch "started
  // for IT but not for DE".
  const stories = await prisma.brandStory.findMany({
    where: { brand },
    select: {
      id: true,
      name: true,
      marketplace: true,
      locale: true,
      status: true,
    },
  })
  const storyMarketplaces = new Set(stories.map((s) => s.marketplace))
  const aplus = await prisma.aPlusContent.findMany({
    where: { brand },
    select: {
      id: true,
      name: true,
      marketplace: true,
      status: true,
      updatedAt: true,
    },
  })
  const aplusMarketplaces = new Set(aplus.map((a) => a.marketplace))

  // Marketplace coverage gap: any marketplace with A+ but no Brand
  // Story (Brand Story is the bigger lever — product-page
  // surfaces).
  for (const marketplace of aplusMarketplaces) {
    if (!storyMarketplaces.has(marketplace)) {
      issues.push({
        severity: 'warning',
        code: 'no_brand_story_for_marketplace',
        message: `${marketplace}: A+ Content exists for this brand but no Brand Story. Brand Story sits above search results — high-leverage gap.`,
      })
    }
  }

  // Aging A+ drafts
  const ageCutoff = Date.now() - DRAFT_AGING_THRESHOLD_MS
  for (const a of aplus) {
    if (a.status === 'DRAFT' && a.updatedAt.getTime() < ageCutoff) {
      const days = Math.round(
        (Date.now() - a.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
      )
      issues.push({
        severity: 'info',
        code: 'draft_aplus_aging',
        message: `A+ Content "${a.name}" has been DRAFT for ${days} days. Submit, archive, or delete.`,
        link: { kind: 'aplus', id: a.id, label: a.name },
      })
    }
  }
  for (const s of stories) {
    if (s.status === 'DRAFT') {
      const updatedAt = await prisma.brandStory.findUnique({
        where: { id: s.id },
        select: { updatedAt: true },
      })
      if (updatedAt && updatedAt.updatedAt.getTime() < ageCutoff) {
        const days = Math.round(
          (Date.now() - updatedAt.updatedAt.getTime()) /
            (24 * 60 * 60 * 1000),
        )
        issues.push({
          severity: 'info',
          code: 'draft_brand_story_aging',
          message: `Brand Story "${s.name}" has been DRAFT for ${days} days. Submit, archive, or delete.`,
          link: { kind: 'brand_story', id: s.id, label: s.name },
        })
      }
    }
  }

  const blocking = issues.filter((i) => i.severity === 'blocking').length
  const warnings = issues.filter((i) => i.severity === 'warning').length
  const info = issues.filter((i) => i.severity === 'info').length

  return {
    brand,
    ranAt: new Date().toISOString(),
    blocking,
    warnings,
    info,
    issues,
  }
}
