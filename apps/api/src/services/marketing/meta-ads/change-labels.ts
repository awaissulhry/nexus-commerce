/**
 * Meta step 21 — set-meta-labels as a draft: a label of the chosen ad account made, renamed or deleted (CMP-082, CMP-083,
 * CMP-084), and the labels of its campaigns and ad sets added, removed or replaced (CMP-065, CMP-066, AS-085–087). Pure: the
 * live state comes in (live-labels-rules.ts), the requests and the record go out.
 *
 *   create   POST /act_<id>/adlabels name                 the new label's id comes back (its undo deletes it)
 *   rename   POST /<label id> name                         undo: the old name
 *   delete   DELETE /<label id>                            only on the person's explicit ask (confirmDelete); FINAL: Meta
 *                                                          takes it off everything that carries it (the preview lists them)
 *                                                          and has no undelete — a label of the same name would be a new id
 *   add      a campaign: POST /<campaign>/adlabels [the labels added] (Meta ADDS: race-free; a name that matches no label
 *            makes it); an ad set: POST /<ad set> adlabels [its WHOLE new list] — Meta documents no adlabels edge for an ad
 *            set (RECHECK AS-085 CORRECTED) and the `adlabels` field "overrides all set of labels"; the SDK-only
 *            DELETE /<ad set>/adlabels (AS-086) is never sent: the documented full list does the same
 *   remove   POST /<campaign | ad set> adlabels [its WHOLE new list] (CMP-066: "the only documented way to remove a label")
 *   replace  the same, with the list named (what undo sends back)
 * Every label is the chosen ad account's own (its list, read live; the gateway checks each id again). Every object's list is
 * read live first and read back after (write-client.ts compares the label lists). Labels never change what an ad spends.
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { LabelCarriers, LabelledObject, LiveLabel } from './live-labels-rules.js'
import { META_LABELS_PER_OBJECT } from '../../gateway/meta-labels-rules.js'

export const LABEL_ACTIONS = ['create', 'rename', 'delete', 'add', 'remove', 'replace'] as const
export type LabelsAction = typeof LABEL_ACTIONS[number]
export type LabelledKind = 'campaign' | 'adset'

export interface LabelsRequest {
  action: LabelsAction
  name?: string
  labelId?: string
  confirmDelete?: true
  objects?: Array<{ kind: LabelledKind; id: string }>
  labelIds?: string[]
  labelNames?: string[]
  sets?: Array<{ kind: LabelledKind; id: string; labelIds: string[] }>
}

export interface LabelsLive {
  adAccountId: string
  /** The chosen ad account's labels (up to 500) and whether there are more. */
  accountLabels: LiveLabel[]
  accountLabelsMore: boolean
  /** add, remove, replace: each object named, read now. */
  objects: LabelledObject[]
  /** delete: everything that carries the label (Meta takes it off all of them). */
  carriers?: LabelCarriers | null
}

/** One object's label list in a record: as Meta read it (ids and names), or as planned (a new label by its name only). */
export interface RecordedLabel { id: string | null; name: string | null }
export interface LabelsRecord {
  op: 'create' | 'rename' | 'delete' | 'objects'
  label?: RecordedLabel
  objects?: Array<{ kind: LabelledKind; id: string; name?: string | null; labels: RecordedLabel[] }>
  /** delete, before: what carried it. */
  carriers?: LabelCarriers | null
  /** after: the labels Meta did not read back (as planned). */
  unread?: boolean
  noUndo?: string[]
}

const WORD: Readonly<Record<LabelledKind, string>> = { campaign: 'campaign', adset: 'ad set' }
const quoted = (name: string | null | undefined) => (name ? `"${name}" ` : '')
const labelWords = (labels: RecordedLabel[]) => (labels.length ? labels.map((l) => (l.name ? `"${l.name}"` : l.id)).join(', ') : 'none')
/** The ONE spelling of an object's label list on the wire: an entry by id, or by name for a label Meta makes. */
export const labelEntries = (labels: RecordedLabel[]) => JSON.stringify(labels.map((l) => (l.id ? { id: l.id } : { name: l.name })))
/** Meta documents validate_only on a campaign's labels (reference/ad-label.md) — used once ST18-03 proves an update check; an ad set has none. */
const checkOf = (kind: LabelledKind): MetaChangeRequest['check'] => (kind === 'campaign' ? 'not-yet' : 'none')

/** set-meta-labels' draft, or why not. */
export function labelsDraft(request: LabelsRequest, live: LabelsLive): MetaChangeDraft | { refusal: string } {
  const byId = new Map(live.accountLabels.map((l) => [l.id, l]))
  const notOwn = (ids: string[]) => ids.filter((id) => !byId.has(id))
  const moreNote = live.accountLabelsMore ? ' (Nexus reads the first 500 labels of the account)' : ''

  if (request.action === 'create') {
    const name = request.name
    if (!name) return { refusal: 'A new label needs its name (name).' }
    const same = live.accountLabels.find((l) => l.name === name)
    if (same) return { refusal: `The ad account has a label named "${name}" already (${same.id}): use it by its id or name (action add), or rename it.` }
    const request1: MetaChangeRequest = {
      step: 1, label: `Make label "${name}" in the ad account`, kind: 'ad', objectKind: 'adaccount', objectId: `act_${live.adAccountId}`, edge: 'adlabels',
      params: { name }, operation: 'label.create', check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      expect: { name }, readBackFields: 'id,name',
    }
    return {
      summary: `Meta: make the label "${name}" in the ad account.`,
      changes: { [`Label "${name}"`]: { from: 'none', to: 'made (empty: it labels nothing yet)' } },
      totals: { labels: 1 },
      warnings: ['Meta has no check for a new label. Undo deletes it (and takes it off whatever carries it by then).'],
      spendsMoney: [],
      skipped: [],
      requests: [request1],
      stands: { labels: live.accountLabels.map((l) => [l.id, l.name]).sort() },
      before: { op: 'create', label: { id: null, name: null } } satisfies LabelsRecord,
      after: { op: 'create', label: { id: null, name } } satisfies LabelsRecord,
    }
  }

  if (request.action === 'rename' || request.action === 'delete') {
    const id = request.labelId
    if (!id) return { refusal: `A ${request.action} names the label (labelId: meta-labels lists them).` }
    const label = byId.get(id)
    if (!label) return { refusal: `${id} is not a label of the chosen ad account${moreNote}: Nexus changes no other.` }
    if (request.action === 'rename') {
      const name = request.name
      if (!name) return { refusal: 'A rename names the new name (name).' }
      if (name === label.name) return { refusal: `Nothing to change: label ${id} is named "${name}" already.` }
      return {
        summary: `Meta: rename label ${quoted(label.name)}(${id}) to "${name}".`,
        changes: { [`Label ${id}`]: { from: label.name, to: name } },
        totals: { labels: 1 },
        warnings: ['Meta has no check for a label change. Everything that carries the label shows the new name.'],
        spendsMoney: [],
        skipped: [],
        requests: [{
          step: 1, label: `Rename label ${quoted(label.name)}(${id}) to "${name}"`, kind: 'ad', objectKind: 'adlabel', objectId: id, params: { name },
          operation: 'label.rename', check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: true, expect: { name }, readBackFields: 'id,name',
        }],
        stands: { label: [label.id, label.name] },
        before: { op: 'rename', label: { id, name: label.name } } satisfies LabelsRecord,
        after: { op: 'rename', label: { id, name } } satisfies LabelsRecord,
      }
    }
    if (request.confirmDelete !== true) return { refusal: 'A label is deleted only when the person explicitly asked to delete it (confirmDelete: true). To take it off some campaigns or ad sets, use action remove.' }
    const c = live.carriers ?? null
    const carried = c ? c.campaigns.length + c.adSets.length + c.ads.length + c.creatives.length : null
    return {
      summary: `Meta: DELETE label ${quoted(label.name)}(${id}) for good${carried ? `; Meta takes it off the ${plural(carried, 'object')} that carry it` : ''}.`,
      changes: { [`Label ${quoted(label.name)}(${id})`]: { from: carried === null ? 'carried by what Nexus could not read' : `on ${plural(carried, 'object')}`, to: 'deleted' } },
      totals: { labels: 1, ...(c ? { campaigns: c.campaigns.length, adSets: c.adSets.length, ads: c.ads.length, creatives: c.creatives.length } : {}) },
      warnings: [
        'DELETING IS FINAL: Meta has no undelete for a label and no undo is offered. A label of the same name can be made again (action create — a new id) and put back on the objects listed (action add).',
        ...(c?.more ? ['More objects carry it than Nexus lists (it reads up to 100 of each kind): they lose it too.'] : []),
        ...(carried === null ? ['Nexus could not read what carries the label: whatever does loses it.'] : []),
        'Meta has no check for a delete. A label never changes what an ad spends.',
      ],
      spendsMoney: [],
      skipped: [],
      requests: [{
        step: 1, label: `Delete label ${quoted(label.name)}(${id})`, kind: 'ad', objectKind: 'adlabel', objectId: id, params: {}, method: 'DELETE',
        operation: 'label.delete', check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      }],
      stands: { label: [label.id, label.name], carriers: c },
      before: { op: 'delete', label: { id, name: label.name }, carriers: c, noUndo: ['Meta has no undelete for a label: make one of the same name (a new id) and put it on what the record lists.'] } satisfies LabelsRecord,
      after: { op: 'delete', label: { id, name: label.name } } satisfies LabelsRecord,
      alsoDeleted: c ? { takenOff: { campaigns: c.campaigns, adSets: c.adSets, ads: c.ads, creatives: c.creatives, more: c.more } } : { takenOff: 'not read' },
    }
  }

  // add, remove, replace: each object's whole list, read now.
  const requests: MetaChangeRequest[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const before: NonNullable<LabelsRecord['objects']> = []
  const after: NonNullable<LabelsRecord['objects']> = []
  const objectOf = (kind: LabelledKind, id: string) => live.objects.find((o) => o.kind === kind && o.id === id)
  const push = (o: LabelledObject, next: RecordedLabel[], add: RecordedLabel[] | null) => {
    if (next.length > META_LABELS_PER_OBJECT) return `${WORD[o.kind]} ${quoted(o.name)}(${o.id}) would carry ${next.length} labels: Meta allows ${META_LABELS_PER_OBJECT} on one object.`
    const step = requests.length + 1
    const who = `${WORD[o.kind]} ${quoted(o.name)}(${o.id})`
    const edgeAdd = add !== null && o.kind === 'campaign'
    requests.push({
      step, label: edgeAdd ? `Add ${labelWords(add!)} to ${who}` : `Set the labels of ${who} to ${labelWords(next)}`,
      kind: o.kind, objectId: o.id, params: { adlabels: labelEntries(edgeAdd ? add! : next) },
      operation: edgeAdd ? 'campaign.labels.add' : `${o.kind}.labels`, check: checkOf(o.kind), raisesSpend: false, readBackInPost: false, budget: false, undoable: true,
      expect: { adlabels: labelEntries(next) }, readBackFields: 'id,adlabels{id,name}',
      ...(edgeAdd ? { edge: 'adlabels' as const, readBackObject: true as const } : {}),
    })
    lines.push([`${WORD[o.kind][0].toUpperCase()}${WORD[o.kind].slice(1)} ${quoted(o.name)}(${o.id})`, labelWords(o.labels), labelWords(next)])
    before.push({ kind: o.kind, id: o.id, name: o.name, labels: o.labels })
    after.push({ kind: o.kind, id: o.id, name: o.name, labels: next })
    return null
  }

  if (request.action === 'replace') {
    const sets = request.sets ?? []
    if (!sets.length) return { refusal: 'A replace names each campaign or ad set with its whole new label list (sets).' }
    const warnings: string[] = []
    for (const s of sets) {
      const o = objectOf(s.kind, s.id)
      if (!o) return { refusal: `Nexus could not read ${WORD[s.kind]} ${s.id}.` }
      const gone = notOwn(s.labelIds)
      if (gone.length) warnings.push(`${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer a label of the ad account${moreNote}: not put on ${WORD[s.kind]} ${s.id}.`)
      const next: RecordedLabel[] = [...new Set(s.labelIds)].filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)!.name }))
      const same = next.length === o.labels.length && next.every((l) => o.labels.some((x) => x.id === l.id))
      if (same) { skipped.push(`${WORD[s.kind]} ${quoted(o.name)}(${o.id}) carries exactly these labels already.`); continue }
      const problem = push(o, next, null)
      if (problem) return { refusal: problem }
    }
    return objectsDraft(`Meta: set the labels of ${plural(requests.length, 'campaign or ad set', 'campaigns and ad sets')}.`, requests, lines, skipped, before, after, live, warnings)
  }

  // add, remove: the same labels on (or off) every object named.
  const objects = request.objects ?? []
  if (!objects.length) return { refusal: `An ${request.action === 'add' ? 'add' : 'remove'} names the campaigns and ad sets (objects).` }
  const ids = [...new Set(request.labelIds ?? [])]
  const names = [...new Set(request.labelNames ?? [])]
  if (!ids.length && !names.length) return { refusal: `Name the labels to ${request.action} (labelIds, labelNames).` }
  const foreign = notOwn(ids)
  if (foreign.length) return { refusal: `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not a label of the chosen ad account${moreNote}: Nexus puts on or takes off only its own (make one with action create, or name it by labelNames).` }
  const warnings: string[] = []
  if (request.action === 'add') {
    // A name that is a label of the account already is that label (by its id); a new name is made by Meta in the same request.
    const wanted: RecordedLabel[] = [...ids.map((id) => ({ id, name: byId.get(id)!.name }))]
    const newNames: string[] = []
    for (const name of names) {
      const same = live.accountLabels.filter((l) => l.name === name)
      if (same.length > 1) return { refusal: `The ad account has ${same.length} labels named "${name}" (${same.map((l) => l.id).join(', ')}): name the one you mean by its id (labelIds).` }
      if (same.length === 1) { if (!wanted.some((w) => w.id === same[0].id)) wanted.push({ id: same[0].id, name }) } else { wanted.push({ id: null, name }); newNames.push(name) }
    }
    if (newNames.length && live.accountLabelsMore) return { refusal: `Nexus reads only the first 500 labels of the account, so it cannot tell whether ${newNames.map((n) => `"${n}"`).join(', ')} exist${newNames.length === 1 ? 's' : ''} already: name ${newNames.length === 1 ? 'it' : 'them'} by id (labelIds), or make ${newNames.length === 1 ? 'it' : 'them'} first (action create).` }
    if (newNames.length) warnings.push(`Meta makes ${newNames.length === 1 ? 'the new label' : 'the new labels'} ${newNames.map((n) => `"${n}"`).join(', ')} with the first object that takes ${newNames.length === 1 ? 'it' : 'them'} (undo takes ${newNames.length === 1 ? 'it' : 'them'} off again; the label${newNames.length === 1 ? '' : 's'} stay${newNames.length === 1 ? 's' : ''} in the account — delete with action delete).`)
    for (const t of objects) {
      const o = objectOf(t.kind, t.id)
      if (!o) return { refusal: `Nexus could not read ${WORD[t.kind]} ${t.id}.` }
      const add = wanted.filter((w) => !o.labels.some((l) => (w.id ? l.id === w.id : l.name === w.name)))
      if (!add.length) { skipped.push(`${WORD[t.kind]} ${quoted(o.name)}(${o.id}) carries ${wanted.length === 1 ? 'it' : 'them all'} already.`); continue }
      const problem = push(o, [...o.labels, ...add], add)
      if (problem) return { refusal: problem }
    }
    return objectsDraft(`Meta: add ${plural(wanted.length, 'label')} to ${plural(requests.length, 'campaign or ad set', 'campaigns and ad sets')}.`, requests, lines, skipped, before, after, live, warnings)
  }
  // remove: by id, or by the name of a label the object carries.
  for (const t of objects) {
    const o = objectOf(t.kind, t.id)
    if (!o) return { refusal: `Nexus could not read ${WORD[t.kind]} ${t.id}.` }
    const off = o.labels.filter((l) => ids.includes(l.id) || (l.name !== null && names.includes(l.name)))
    if (!off.length) { skipped.push(`${WORD[t.kind]} ${quoted(o.name)}(${o.id}) carries none of them.`); continue }
    const problem = push(o, o.labels.filter((l) => !off.includes(l)), null)
    if (problem) return { refusal: problem }
  }
  return objectsDraft(`Meta: take labels off ${plural(requests.length, 'campaign or ad set', 'campaigns and ad sets')}.`, requests, lines, skipped, before, after, live, warnings)
}

function objectsDraft(
  summary: string, requests: MetaChangeRequest[], lines: Array<[string, unknown, unknown]>, skipped: string[],
  before: NonNullable<LabelsRecord['objects']>, after: NonNullable<LabelsRecord['objects']>, live: LabelsLive, warnings: string[],
): MetaChangeDraft {
  const { changes, more } = changeLines(lines)
  return {
    summary,
    changes,
    totals: { objects: requests.length, ...(more ? { moreLines: more } : {}) },
    warnings: [
      ...warnings,
      'An ad set\'s labels go as its whole new list (Meta documents no labels edge for an ad set), a campaign\'s added labels by Meta\'s add edge and a campaign\'s removals as its whole new list; each object is read again before it is sent and read back after. Labels never change what an ad spends.',
      ...(requests.some((r) => r.kind === 'adset') ? ['Meta has no check for an ad set change.'] : []),
    ],
    spendsMoney: [],
    skipped,
    requests,
    stands: { objects: live.objects.map((o) => ({ kind: o.kind, id: o.id, labels: o.labels.map((l) => l.id).sort() })), labels: live.accountLabels.map((l) => [l.id, l.name]).sort() },
    before: { op: 'objects', objects: before } satisfies LabelsRecord,
    after: { op: 'objects', objects: after } satisfies LabelsRecord,
  }
}

/** The label lists Meta read back after a run, by object (a node's adlabels{id,name}). */
export function labelsReadBack(node: Record<string, unknown> | null): RecordedLabel[] | null {
  if (!node || !('adlabels' in node)) return node && 'id' in node ? [] : null
  const v = node.adlabels
  const rows = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { data?: unknown }).data) ? (v as { data: unknown[] }).data : []
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => ({ id: typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : null, name: typeof r.name === 'string' ? r.name : null }))
}
