/**
 * HV-R P3a — the Ad Group View's rows: every ad group that can SOURCE a harvest, and every one
 * that can RECEIVE it.
 *
 * The Keyword Harvest tab's second view is, in the operator's study, *"the application layer"* —
 * *"it might show you 200 rows… its primary function is to manage where the rules are applied"*
 * and *"you do it here by detaching the rule from that specific ad group"*. Until now it derived
 * its rows from `actions[0].mappings`, which only a BUILDER rule writes, and **all five harvest
 * rules in this account are ENGINE rules with zero mappings** — so the view rendered 0 rows and
 * structurally always would.
 *
 * This module answers the question the view is actually for: *which of my ad groups is harvesting,
 * and which is not?* An ad group with no rule attached is the interesting row, not a missing one.
 *
 * 🔴 **Read-only.** P3b adds the assignment table and the writes; nothing here mutates anything,
 * and nothing here invents an assignment that does not exist.
 *
 * Measured on prod 2026-08-20 (`apps/api/scripts/_hvr-pathways.mts`): 289 ad groups → **122
 * sources · 53 destinations**, IT 77/33 · DE 24/11 · FR 13/6 · ES 8/3; 51 of the 122 sit in an
 * ENABLED campaign and all 122 carry an Amazon id.
 */
import prisma from '../../db.js'
import { roleOf, type HvMatchRole } from './harvest-destination.service.js'

export interface PathwayAdGroup {
  id: string
  name: string
  campaignId: string
  campaignName: string
  campaignStatus: string | null
  /** AUTO | MANUAL — the campaign's, which is a real field unlike the ad group's */
  campaignTargeting: string | null
  marketplace: string | null
  /** SPONSORED_PRODUCTS | SPONSORED_BRANDS | SPONSORED_DISPLAY */
  adProduct: string | null
  adGroupStatus: string | null
  /** the funnel's own classifier — never a name guess alone; see `roleOf` */
  role: HvMatchRole | null
  /** the normalised match types actually present on this ad group's positive targets */
  matchTypes: string[]
  /** positive targets in the ad group */
  targetCount: number
  /** null ⇒ local-only; it has never reached Amazon and cannot source or receive anything live */
  externalAdGroupId: string | null
}

export interface HarvestPathways {
  sources: PathwayAdGroup[]
  destinations: PathwayAdGroup[]
  totals: {
    adGroups: number
    sources: number
    destinations: number
    /** neither a source nor a destination — product-targeting and unclassifiable ad groups */
    neither: number
    /** of `sources`, how many sit in an ENABLED campaign */
    sourcesLive: number
  }
}

/**
 * A SOURCE produces search terms to harvest FROM.
 *
 * Auto, broad and phrase ad groups all surface customer queries their targets did not name
 * literally. An EXACT ad group does not — its search terms are, by construction, the keyword
 * itself, so harvesting from it can only re-create what is already there. That is why H10's own
 * builder offers auto/broad/phrase as sources and why the promote path's match-type filter reads
 * BROAD, PHRASE and the two auto-expression families.
 */
const SOURCE_ROLES: HvMatchRole[] = ['AUTO', 'BROAD', 'PHRASE']

/**
 * A DESTINATION receives the harvested keyword as an EXACT target.
 *
 * Restricted to manual keyword-targeted campaigns, which is the constraint SellerApp states
 * explicitly and the reason it matters: a destination that could be an AUTO campaign makes the
 * funnel loop back on itself — the term is promoted into the very campaign it was discovered in
 * and immediately competes with its own source.
 */
const isDestination = (ag: PathwayAdGroup) => ag.role === 'EXACT' && ag.campaignTargeting !== 'AUTO'

/** Amazon writes the same match type two ways while two ingests fight over it — normalise once. */
const normaliseType = (t: string | null | undefined) =>
  String(t ?? '').trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '')

export async function listHarvestPathways(): Promise<HarvestPathways> {
  const ags = await prisma.adGroup.findMany({
    select: {
      id: true, name: true, campaignId: true, status: true, externalAdGroupId: true,
      campaign: { select: { name: true, status: true, targetingType: true, marketplace: true, adProduct: true } },
      targets: { select: { expressionType: true, isNegative: true } },
    },
    orderBy: { name: 'asc' },
  })

  const all: PathwayAdGroup[] = ags.map((a) => {
    const positives = a.targets.filter((t) => !t.isNegative)
    return {
      id: a.id,
      name: a.name,
      campaignId: a.campaignId,
      campaignName: a.campaign?.name ?? '',
      campaignStatus: a.campaign?.status ?? null,
      campaignTargeting: a.campaign?.targetingType ?? null,
      marketplace: a.campaign?.marketplace ?? null,
      adProduct: a.campaign?.adProduct ?? null,
      adGroupStatus: a.status ?? null,
      role: roleOf(a.name, a.targets),
      matchTypes: [...new Set(positives.map((t) => normaliseType(t.expressionType)).filter(Boolean))].sort(),
      targetCount: positives.length,
      externalAdGroupId: a.externalAdGroupId ?? null,
    }
  })

  const sources = all.filter((a) => a.role != null && SOURCE_ROLES.includes(a.role))
  const destinations = all.filter(isDestination)

  return {
    sources,
    destinations,
    totals: {
      adGroups: all.length,
      sources: sources.length,
      destinations: destinations.length,
      neither: all.length - sources.length - destinations.length,
      sourcesLive: sources.filter((a) => a.campaignStatus === 'ENABLED').length,
    },
  }
}
