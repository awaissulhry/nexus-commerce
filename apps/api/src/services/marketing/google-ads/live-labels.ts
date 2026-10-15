/**
 * Google Ads changes, G5 (2026-10-15) — the account's labels and what carries them, read live from Google: the "from"
 * side of set-google-labels and remove-google-labels. One GAQL query per part, on the account's change allowance
 * (write-client.ts `liveRows`).
 *
 * Fields checked on 2026-10-15 in the v25 field reference (developers.google.com/google-ads/api/fields/v25/…):
 *   label: label.id, label.name, label.status, label.text_label.background_color, label.text_label.description —
 *     selectable and filterable.
 *   campaign_label (attributed: campaign, label), ad_group_label (ad_group, campaign, label), ad_group_ad_label
 *     (ad_group, ad_group_ad, campaign, label), ad_group_criterion_label (ad_group, ad_group_criterion, campaign, label):
 *     their resource_name and the attributed resources' fields are selectable; label.id is filterable from each.
 * Resource names (v25 reference): customers/{c}/labels/{label}, campaignLabels/{campaign}~{label},
 * adGroupLabels/{adGroup}~{label}, adGroupAdLabels/{adGroup}~{ad}~{label}, adGroupCriterionLabels/{adGroup}~{criterion}~{label}.
 */
import { gaqlId } from './live.js'
import { byGoogleId } from './live-keywords.js'
import { liveRows } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

/** What a label can be put on: a campaign, an ad group, an ad (`adGroupId~adId`), a keyword (`adGroupId~criterionId`). */
export type LabelTargetKind = 'campaign' | 'ad-group' | 'ad' | 'keyword'
export const LABEL_TARGET_KINDS: readonly LabelTargetKind[] = ['campaign', 'ad-group', 'ad', 'keyword']

export interface LiveLabel {
  labelId: string
  name: string
  /** `#rrggbb` (or `#rgb`) as Google holds it; null when none. */
  color: string | null
  description: string | null
}

export interface LiveLabelLink {
  labelId: string
  kind: LabelTargetKind
  /** The item's id as the change tools name it (campaign / ad group: its id; ad and keyword: `adGroupId~childId`). */
  id: string
  /** The item in words (a campaign's or ad group's name, a keyword's text, `ad 123`). */
  name: string
}

/** Every label of the account that is not removed. */
export const LIVE_LABELS_QUERY =
  'SELECT label.id, label.name, label.status, label.text_label.background_color, label.text_label.description ' +
  "FROM label WHERE label.status = 'ENABLED'"

const inLabels = (labelIds: string[]) => labelIds.map((id) => gaqlId(id, 'The label')).join(', ')

/** What carries the given labels, one query per kind of item. */
export function liveLabelLinksQuery(kind: LabelTargetKind, labelIds: string[]): string {
  const where = `WHERE label.id IN (${inLabels(labelIds)})`
  switch (kind) {
    case 'campaign': return `SELECT campaign.id, campaign.name, label.id FROM campaign_label ${where}`
    case 'ad-group': return `SELECT ad_group.id, ad_group.name, label.id FROM ad_group_label ${where}`
    case 'ad': return `SELECT ad_group.id, ad_group_ad.ad.id, label.id FROM ad_group_ad_label ${where}`
    case 'keyword': return `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, label.id FROM ad_group_criterion_label ${where}`
  }
}

export function liveLabelOf(row: Json): LiveLabel {
  const l = row.label ?? {}
  return { labelId: str(l.id) ?? '', name: str(l.name) ?? '', color: str(l.textLabel?.backgroundColor), description: str(l.textLabel?.description) }
}

export function liveLabelLinkOf(kind: LabelTargetKind, row: Json): LiveLabelLink {
  const labelId = str(row.label?.id) ?? ''
  switch (kind) {
    case 'campaign': return { labelId, kind, id: str(row.campaign?.id) ?? '', name: str(row.campaign?.name) ?? '' }
    case 'ad-group': return { labelId, kind, id: str(row.adGroup?.id) ?? '', name: str(row.adGroup?.name) ?? '' }
    case 'ad': {
      const adId = str(row.adGroupAd?.ad?.id) ?? ''
      return { labelId, kind, id: `${str(row.adGroup?.id) ?? ''}~${adId}`, name: `ad ${adId}` }
    }
    case 'keyword': return { labelId, kind, id: `${str(row.adGroup?.id) ?? ''}~${str(row.adGroupCriterion?.criterionId) ?? ''}`, name: str(row.adGroupCriterion?.keyword?.text) ?? '' }
  }
}

/** The account's labels, by name. */
export async function liveLabels(target: GoogleAdsTarget): Promise<LiveLabel[]> {
  const rows = await liveRows<Json>(target, LIVE_LABELS_QUERY, 'ads.search.live.labels')
  return rows.map(liveLabelOf).sort((a, b) => a.name.localeCompare(b.name) || byGoogleId(a.labelId, b.labelId))
}

/** What carries the given labels, for the kinds of item asked (one query per kind); in a stable order. */
export async function liveLabelLinks(target: GoogleAdsTarget, labelIds: string[], kinds: readonly LabelTargetKind[]): Promise<LiveLabelLink[]> {
  if (!labelIds.length) return []
  const out: LiveLabelLink[] = []
  for (const kind of kinds) {
    const rows = await liveRows<Json>(target, liveLabelLinksQuery(kind, [...new Set(labelIds)]), 'ads.search.live.label-links')
    out.push(...rows.map((row) => liveLabelLinkOf(kind, row)))
  }
  return out.sort((a, b) => byGoogleId(a.labelId, b.labelId) || a.kind.localeCompare(b.kind) || byGoogleId(a.id, b.id))
}
