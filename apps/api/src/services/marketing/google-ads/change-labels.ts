/**
 * Google Ads changes, G5 (2026-10-15) — labels: make labels, change a label's name, description or colour, put labels on
 * campaigns, ad groups, ads and keywords and take them off (one atomic request), and remove labels for good (its own
 * request, only when the person asked for it).
 *
 * Google's rules, checked 2026-10-15 in the v25 reference (Label, TextLabel, LabelOperation, CampaignLabelOperation,
 * AdGroupLabelOperation, AdGroupAdLabelOperation, AdGroupCriterionLabelOperation, LabelError):
 *   - a label's name is 1 to 80 characters and unique in the account (DUPLICATE_NAME); its description at most 200
 *     characters; its background colour `#rrggbb` or `#rgb`;
 *   - a link is made (create) or taken off (remove by resource name), never updated; a label made in the same request is
 *     named by a temporary id (`customers/{c}/labels/-1`);
 *   - a label cannot go on a negative keyword (CANNOT_APPLY_LABEL_TO_NEGATIVE_AD_GROUP_CRITERION); at most 50 labels per
 *     item (Google's check says so when it is passed).
 * Money: a label changes nothing that serves — nothing here spends. A rule or script inside Google Ads that picks items
 * by label would act on what carries it: the preview says so.
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import type { LiveCampaign } from './live.js'
import type { LiveStatusItem } from './live-campaigns.js'
import type { LabelTargetKind, LiveLabel, LiveLabelLink } from './live-labels.js'
import type { GoogleMutateOperation } from './write-client.js'

export const LABEL_COLOR = /^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/
export const LABEL_NAME_MAX = 80
export const LABEL_DESCRIPTION_MAX = 200

export interface LabelChangeRequest {
  /** New labels. */
  create?: Array<{ name: string; description?: string; color?: string }>
  /** New name, description or colour of existing labels ('' clears a description or a colour). */
  edit?: Array<{ labelId: string; name?: string; description?: string; color?: string }>
  /** Labels to put on items: an existing label (`labelId`) or one of `create` (`newLabel`, its name). */
  attach?: Array<{ labelId?: string; newLabel?: string; kind: LabelTargetKind; id: string }>
  /** Labels to take off items. */
  detach?: Array<{ labelId: string; kind: LabelTargetKind; id: string }>
}

export interface LabelLiveState {
  labels: LiveLabel[]
  /** What carries the labels the request names. */
  links: LiveLabelLink[]
  campaigns: LiveCampaign[]
  /** Ad groups, ads and keywords the request puts a label on (live-campaigns.ts liveStatuses). */
  items: LiveStatusItem[]
}

export interface LabelLinkRecord { labelId: string; kind: LabelTargetKind; id: string }
export interface LabelEditRecord { labelId: string; name: string; description: string | null; color: string | null }

/** What the change replaced (before) and wrote (after); a label it made is `new:<n>` until the run names Google's id. */
export interface LabelChangeRecord {
  created: Array<{ labelId: string; name: string }>
  edited: LabelEditRecord[]
  attached: LabelLinkRecord[]
  detached: LabelLinkRecord[]
}

export const NEW_LABEL = 'new:'
/** A refusal raised inside the builder; labelChangeDraft answers it as `{ refusal }`. */
class LabelRefusal extends Error {}
const KIND_WORD: Record<LabelTargetKind, string> = { campaign: 'campaign', 'ad-group': 'ad group', ad: 'ad', keyword: 'keyword' }

/** Google's resource name and MutateOperation kind of the link between an item and a label. */
export function labelLinkOperation(customer: string, kind: LabelTargetKind, id: string, label: string): { op: string; field: string; item: string; link: string } {
  const labelId = label.slice(label.lastIndexOf('/') + 1)
  switch (kind) {
    case 'campaign': return { op: 'campaignLabelOperation', field: 'campaign', item: `${customer}/campaigns/${id}`, link: `${customer}/campaignLabels/${id}~${labelId}` }
    case 'ad-group': return { op: 'adGroupLabelOperation', field: 'adGroup', item: `${customer}/adGroups/${id}`, link: `${customer}/adGroupLabels/${id}~${labelId}` }
    case 'ad': return { op: 'adGroupAdLabelOperation', field: 'adGroupAd', item: `${customer}/adGroupAds/${id}`, link: `${customer}/adGroupAdLabels/${id}~${labelId}` }
    case 'keyword': return { op: 'adGroupCriterionLabelOperation', field: 'adGroupCriterion', item: `${customer}/adGroupCriteria/${id}`, link: `${customer}/adGroupCriterionLabels/${id}~${labelId}` }
  }
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
/** A campaign or ad group is named by its id; an ad or a keyword by `adGroupId~adId` / `adGroupId~criterionId`. */
const idShapeOk = (kind: LabelTargetKind, id: string) => (kind === 'campaign' || kind === 'ad-group' ? /^\d{1,20}$/ : /^\d{1,20}~\d{1,20}$/).test(id)
const idShapeProblem = (kind: LabelTargetKind, id: string) =>
  idShapeOk(kind, id) ? null : `"${id}" is not ${kind === 'ad' ? 'an ad id (adGroupId~adId)' : kind === 'keyword' ? 'a keyword id (adGroupId~criterionId)' : `a ${KIND_WORD[kind]} id (digits)`}.`
const linkKey = (l: { labelId: string; kind: string; id: string }) => `${l.labelId}|${l.kind}|${l.id}`

function textProblem(what: string, value: { name?: string; description?: string; color?: string }): string | null {
  if (value.name !== undefined && (value.name.trim().length < 1 || value.name.trim().length > LABEL_NAME_MAX)) return `${what}: a label name is 1 to ${LABEL_NAME_MAX} characters.`
  if (value.description !== undefined && value.description.length > LABEL_DESCRIPTION_MAX) return `${what}: a label description is at most ${LABEL_DESCRIPTION_MAX} characters.`
  if (value.color !== undefined && value.color !== '' && !LABEL_COLOR.test(value.color)) return `${what}: a colour is #rrggbb or #rgb (e.g. #1a73e8).`
  return null
}

/** The item a label goes on, as it is now (a campaign from the campaign list, the rest from liveStatuses), or null. */
function itemNow(kind: LabelTargetKind, id: string, live: LabelLiveState): { name: string; negative?: boolean } | null {
  if (kind === 'campaign') {
    const c = live.campaigns.find((x) => x.campaignId === id)
    return c ? { name: c.name } : null
  }
  const item = live.items.find((x) => x.kind === kind && x.id === id)
  return item && item.status !== 'REMOVED' ? { name: item.name, negative: item.negative } : null
}

const labelsList = (labels: LiveLabel[]) => (labels.length ? ` Labels now: ${labels.slice(0, 20).map((l) => `"${l.name}" (${l.labelId})`).join(', ')}${labels.length > 20 ? ' …' : ''}.` : ' The account has no label yet.')

/** The change of a set-google-labels request, from the live state: a draft, or a refusal in words. Pure. */
export function labelChangeDraft(customer: string, request: LabelChangeRequest, live: LabelLiveState): GoogleChangeDraft | { refusal: string } {
  try {
    return buildLabelChange(customer, request, live)
  } catch (err) {
    if (err instanceof LabelRefusal) return { refusal: err.message }
    throw err
  }
}

function buildLabelChange(customer: string, request: LabelChangeRequest, live: LabelLiveState): GoogleChangeDraft {
  const create = request.create ?? []
  const edit = request.edit ?? []
  const attach = request.attach ?? []
  const detach = request.detach ?? []
  if (create.length + edit.length + attach.length + detach.length === 0) throw new LabelRefusal('Say what to change: create, edit, attach or detach.')
  const labelById = new Map(live.labels.map((l) => [l.labelId, l]))
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: LabelChangeRecord = { created: [], edited: [], attached: [], detached: [] }
  const after: LabelChangeRecord = { created: [], edited: [], attached: [], detached: [] }
  const labelRes = (id: string | number) => `${customer}/labels/${id}`

  // 1. new labels (temporary ids -1, -2 …, so links of this request can point at them)
  const newByName = new Map<string, { temp: string; name: string; index: number }>()
  create.forEach((c, i) => {
    const name = c.name.trim()
    const problem = textProblem(`New label "${name}"`, c)
    if (problem) throw new LabelRefusal(problem)
    if (live.labels.some((l) => sameName(l.name, name))) throw new LabelRefusal(`A label named "${name}" already exists: Google refuses a second one (label names are unique). Use its labelId.`)
    if (newByName.has(name.toLowerCase())) throw new LabelRefusal(`The new label "${name}" is named twice.`)
    const temp = labelRes(-(i + 1))
    newByName.set(name.toLowerCase(), { temp, name, index: i })
    const textLabel = { ...(c.description ? { description: c.description } : {}), ...(c.color ? { backgroundColor: c.color } : {}) }
    operations.push({ labelOperation: { create: { resourceName: temp, name, ...(Object.keys(textLabel).length ? { textLabel } : {}) } } })
    lines.push([`new label "${name}"`, '(none)', [c.description, c.color].filter(Boolean).join(', ') || 'made'])
    after.created.push({ labelId: `${NEW_LABEL}${i}`, name })
  })

  // 2. name, description, colour of existing labels
  const seenEdits = new Set<string>()
  for (const e of edit) {
    const l = labelById.get(e.labelId)
    if (!l) throw new LabelRefusal(`Label ${e.labelId} is not in this account (or it is removed).${labelsList(live.labels)}`)
    if (seenEdits.has(e.labelId)) throw new LabelRefusal(`Label "${l.name}" is named twice in edit.`)
    seenEdits.add(e.labelId)
    const problem = textProblem(`Label "${l.name}"`, e)
    if (problem) throw new LabelRefusal(problem)
    const name = e.name?.trim()
    if (name !== undefined && !sameName(name, l.name) && (live.labels.some((x) => x.labelId !== l.labelId && sameName(x.name, name)) || newByName.has(name.toLowerCase()))) {
      throw new LabelRefusal(`A label named "${name}" already exists: Google refuses a second one.`)
    }
    const next: LabelEditRecord = {
      labelId: l.labelId,
      name: name ?? l.name,
      description: e.description === undefined ? l.description : e.description || null,
      color: e.color === undefined ? l.color : e.color || null,
    }
    const mask: string[] = []
    const update: Record<string, unknown> = { resourceName: labelRes(l.labelId) }
    const textLabel: Record<string, string> = {}
    if (next.name !== l.name) { mask.push('name'); update.name = next.name }
    // A field in the update mask but not in the body is CLEARED (Google's REST rule): that is how '' clears one.
    if (next.description !== l.description) { mask.push('text_label.description'); if (next.description) textLabel.description = next.description }
    if ((next.color ?? '').toLowerCase() !== (l.color ?? '').toLowerCase()) { mask.push('text_label.background_color'); if (next.color) textLabel.backgroundColor = next.color }
    if (!mask.length) { skipped.push(`Label "${l.name}" already reads so.`); continue }
    if (Object.keys(textLabel).length) update.textLabel = textLabel
    operations.push({ labelOperation: { update, updateMask: mask.join(',') } })
    if (next.name !== l.name) lines.push([`label "${l.name}" name`, l.name, next.name])
    if (next.description !== l.description) lines.push([`label "${next.name}" description`, l.description ?? '(none)', next.description ?? '(none)'])
    if ((next.color ?? '').toLowerCase() !== (l.color ?? '').toLowerCase()) lines.push([`label "${next.name}" colour`, l.color ?? '(none)', next.color ?? '(none)'])
    before.edited.push({ labelId: l.labelId, name: l.name, description: l.description, color: l.color })
    after.edited.push(next)
  }

  // 3. links: on and off
  const linked = new Set(live.links.map(linkKey))
  const seenLinks = new Set<string>()
  for (const a of attach) {
    if ((a.labelId === undefined) === (a.newLabel === undefined)) throw new LabelRefusal('Each attach names labelId (an existing label) or newLabel (a label of create), one of them.')
    const shape = idShapeProblem(a.kind, a.id)
    if (shape) throw new LabelRefusal(shape)
    const fresh = a.newLabel !== undefined ? newByName.get(a.newLabel.trim().toLowerCase()) : undefined
    if (a.newLabel !== undefined && !fresh) throw new LabelRefusal(`attach names the new label "${a.newLabel}", which create does not make.`)
    const existing = a.labelId !== undefined ? labelById.get(a.labelId) : undefined
    if (a.labelId !== undefined && !existing) throw new LabelRefusal(`Label ${a.labelId} is not in this account (or it is removed).${labelsList(live.labels)}`)
    const item = itemNow(a.kind, a.id, live)
    if (!item) throw new LabelRefusal(`${KIND_WORD[a.kind]} ${a.id} is not in this account (or it is removed). google-ads-live shows the ids.`)
    if (a.kind === 'keyword' && item.negative) throw new LabelRefusal(`${item.name} is a negative keyword: Google cannot put a label on one.`)
    const labelName = fresh?.name ?? existing!.name
    const recordId = fresh ? `${NEW_LABEL}${fresh.index}` : existing!.labelId
    const key = linkKey({ labelId: recordId, kind: a.kind, id: a.id })
    if (seenLinks.has(key)) continue
    seenLinks.add(key)
    if (!fresh && linked.has(key)) { skipped.push(`${KIND_WORD[a.kind]} "${item.name}" already carries "${labelName}".`); continue }
    const label = fresh?.temp ?? labelRes(existing!.labelId)
    const { op, field, item: itemRes } = labelLinkOperation(customer, a.kind, a.id, label)
    operations.push({ [op]: { create: { [field]: itemRes, label } } })
    lines.push([`${KIND_WORD[a.kind]} "${item.name}"`, '(no such label)', `label "${labelName}"`])
    after.attached.push({ labelId: recordId, kind: a.kind, id: a.id })
  }
  for (const d of detach) {
    const l = labelById.get(d.labelId)
    if (!l) throw new LabelRefusal(`Label ${d.labelId} is not in this account (or it is removed).${labelsList(live.labels)}`)
    const shape = idShapeProblem(d.kind, d.id)
    if (shape) throw new LabelRefusal(shape)
    const key = linkKey(d)
    if (seenLinks.has(key)) throw new LabelRefusal(`"${l.name}" on ${KIND_WORD[d.kind]} ${d.id} is named in attach and detach.`)
    seenLinks.add(key)
    const link = live.links.find((x) => linkKey(x) === key)
    if (!link) { skipped.push(`${KIND_WORD[d.kind]} ${d.id} does not carry "${l.name}".`); continue }
    const { op, link: linkRes } = labelLinkOperation(customer, d.kind, d.id, labelRes(l.labelId))
    operations.push({ [op]: { remove: linkRes } })
    lines.push([`${KIND_WORD[d.kind]} "${link.name}"`, `label "${l.name}"`, '(taken off)'])
    after.detached.push({ labelId: l.labelId, kind: d.kind, id: d.id })
  }
  if (!operations.length) throw new LabelRefusal(`Nothing to change: ${skipped.join(' ')}`)
  if (after.attached.length || after.detached.length) {
    warnings.push('A label changes nothing that serves. An automated rule or script inside Google Ads that picks items by label would act on what carries it.')
  }
  const { changes, more } = changeLines(lines)
  const parts = [
    after.created.length && `make ${plural(after.created.length, 'label')}`,
    after.edited.length && `change ${plural(after.edited.length, 'label')}`,
    after.attached.length && `put a label on ${plural(after.attached.length, 'item')}`,
    after.detached.length && `take a label off ${plural(after.detached.length, 'item')}`,
  ].filter(Boolean)
  const involved = new Set([...edit.map((e) => e.labelId), ...attach.map((a) => a.labelId).filter((x): x is string => !!x), ...detach.map((d) => d.labelId)])
  return {
    summary: `Google Ads labels: ${parts.join('; ')}.`,
    changes,
    totals: { operations: operations.length, labelsMade: after.created.length, labelsChanged: after.edited.length, attached: after.attached.length, detached: after.detached.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped,
    operations,
    stands: {
      // The labels it reads or writes, as they are now, with what carries them; the names a new label must not take.
      labels: live.labels.filter((l) => involved.has(l.labelId)).map((l) => ({ ...l, links: live.links.filter((x) => x.labelId === l.labelId).map(linkKey).sort() })),
      takenNames: create.length ? live.labels.map((l) => l.name.trim().toLowerCase()).sort() : [],
      items: attach.map((a) => `${a.kind}:${a.id}:${itemNow(a.kind, a.id, live) ? 'here' : 'gone'}`).sort(),
    },
    before,
    after,
  }
}

/** The record of a run, with the ids Google gave the labels it made (the results of the first operations, in order). */
export function labelRecordAfterRun(after: LabelChangeRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): LabelChangeRecord {
  const made = after.created.map((_, i) => {
    const name = responses[i]?.labelResult?.resourceName
    return name ? name.slice(name.lastIndexOf('/') + 1) : null
  })
  const resolve = (labelId: string) => (labelId.startsWith(NEW_LABEL) ? made[Number(labelId.slice(NEW_LABEL.length))] ?? labelId : labelId)
  return {
    created: after.created.map((c, i) => ({ labelId: made[i] ?? c.labelId, name: c.name })),
    edited: after.edited.map((e) => ({ ...e })),
    attached: after.attached.map((l) => ({ ...l, labelId: resolve(l.labelId) })),
    detached: after.detached.map((l) => ({ ...l })),
  }
}

// ── remove ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LabelRemoveRecord {
  removed: Array<{ labelId: string; name: string; description: string | null; color: string | null; carriedBy: LabelLinkRecord[] }>
}

export function labelRemoveDraft(customer: string, labelIds: string[], live: { labels: LiveLabel[]; links: LiveLabelLink[] }): GoogleChangeDraft | { refusal: string } {
  if (!labelIds.length) return { refusal: 'Name at least one label to remove.' }
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const record: LabelRemoveRecord = { removed: [] }
  for (const labelId of [...new Set(labelIds)]) {
    const l = live.labels.find((x) => x.labelId === labelId)
    if (!l) return { refusal: `Label ${labelId} is not in this account (or it is already removed).${labelsList(live.labels)}` }
    const carriedBy = live.links.filter((x) => x.labelId === labelId)
    const counts = (['campaign', 'ad-group', 'ad', 'keyword'] as const).map((k) => [k, carriedBy.filter((x) => x.kind === k).length] as const).filter(([, n]) => n > 0)
    operations.push({ labelOperation: { remove: `${customer}/labels/${labelId}` } })
    lines.push([`label "${l.name}"`, counts.length ? `on ${counts.map(([k, n]) => plural(n, KIND_WORD[k])).join(', ')}` : 'on nothing', 'REMOVED'])
    record.removed.push({ labelId, name: l.name, description: l.description, color: l.color, carriedBy: carriedBy.map((x) => ({ labelId: x.labelId, kind: x.kind, id: x.id })) })
  }
  const { changes, more } = changeLines(lines)
  const carried = record.removed.reduce((n, r) => n + r.carriedBy.length, 0)
  return {
    summary: `Google Ads: REMOVE ${plural(record.removed.length, 'label')} for good (${record.removed.slice(0, 3).map((r) => `"${r.name}"`).join(', ')}${record.removed.length > 3 ? ' …' : ''}).`,
    changes,
    totals: { operations: operations.length, removed: record.removed.length, itemsCarryingThem: carried, ...(more ? { linesNotShown: more } : {}) },
    warnings: [
      'A removal cannot be undone: Google cannot bring a removed label back (a new label with the same name is another label).',
      ...(carried ? [`The labels come off the ${plural(carried, 'item')} that carry them; nothing that serves changes.`] : []),
    ],
    spendsMoney: [],
    skipped: [],
    operations,
    stands: { removed: record.removed.map((r) => ({ labelId: r.labelId, name: r.name, carriedBy: r.carriedBy.map(linkKey).sort() })) },
    before: record,
    after: { removed: record.removed.map((r) => ({ labelId: r.labelId })) },
  }
}
