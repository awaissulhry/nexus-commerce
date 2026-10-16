/**
 * Google Ads programme 2, G14a (2026-10-16) — custom audiences (Google Ads "custom segments": people by the keywords
 * they search or are interested in, the sites they visit, the apps they use): pure builders. No call here.
 *
 * Google's rules, checked 2026-10-16 with curl (reference/rpc/v25/CustomAudience, CustomAudienceOperation,
 * CustomAudienceMember, CustomAudienceTypeEnum, CustomAudienceMemberTypeEnum, CustomAudienceStatusEnum,
 * CustomAudienceErrorEnum, MutateCustomAudiencesRequest / Response; googleapis v25 services/custom_audience_service.proto;
 * the guide docs/remarketing/audience-segments/custom-audiences):
 *   - GoogleAdsService.Mutate has NO custom audience operation (MutateOperation v25 lists none): custom audiences go to
 *     CustomAudienceService.MutateCustomAudiences, `POST /v25/customers/{id}/customAudiences:mutate` {operations[],
 *     validate_only} — it has validate_only, and no partial failure (all or nothing). Results: results[].resource_name.
 *   - CustomAudienceOperation: create, update (+ update_mask), remove (customers/{c}/customAudiences/{id}).
 *     CustomAudienceError CANNOT_REMOVE_WHILE_IN_USE: a custom audience a campaign or ad group uses cannot be removed.
 *   - name: required on create, unique for the account ignoring case (NAME_ALREADY_USED). status and id are Output only.
 *     type: AUTO | SEARCH for a new one ("INTEREST or PURCHASE_INTENT is not allowed for newly created custom audience");
 *     INVALID_TYPE_CHANGE: Google may refuse a type change (its check says so).
 *   - members: "If members are presented in UPDATE operation, existing members will be overridden" — Nexus always sends
 *     the full list (what is there, with the asked additions and removals). A member is KEYWORD (at most 10 words and 80
 *     characters), URL ("An HTTP URL, protocol-included — at most 2048 characters"), APP (an Android package name) or
 *     PLACE_CATEGORY (Google's id); "It can only be created or removed but not changed". MEMBER_TYPE_AND_PARAMETER_
 *     ALREADY_EXISTED: a member twice is refused, so Nexus sends each once.
 *
 * Money: a custom audience spends nothing; the campaigns that use it do. A change that lets it reach more people
 * (members added, another type) is SPENDS MONEY when a campaign that serves uses it (change-audience-uses.ts).
 */
import { changeLines, keywordTextProblem, plural, type GoogleChangeDraft } from './change-draft.js'
import { narrowLine, placesOf, placesWords, widenLines, type UseContext } from './change-audience-uses.js'
import { ACCOUNT_CALL } from './account-client.js'
import { memberJson, memberKey, type AudienceMember, type LiveCustomAudience } from './live-goals-audiences.js'

export const CUSTOM_AUDIENCE_TYPES = ['AUTO', 'SEARCH'] as const
export type CustomAudienceType = typeof CUSTOM_AUDIENCE_TYPES[number]
export const NEW_CUSTOM_AUDIENCE = (n: number) => `new-custom-audience-${n}`
const APP_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

export interface CustomAudienceRequest {
  create?: Array<{ name: string; description?: string; type?: CustomAudienceType; members: AudienceMember[] }>
  change?: Array<{
    customAudienceId: string
    name?: string
    description?: string
    type?: CustomAudienceType
    /** The full new member list (replaces), or … */
    members?: AudienceMember[]
    /** … members added to and taken from the list there. */
    addMembers?: AudienceMember[]
    removeMembers?: AudienceMember[]
  }>
  remove?: string[]
}

export interface CustomAudienceFields { customAudienceId: string; name?: string | null; description?: string | null; type?: string | null; members?: AudienceMember[] }
export interface CustomAudienceRecord {
  audiences: CustomAudienceFields[]
  created: Array<{ customAudienceId: string; name: string }>
  removed: Array<{ customAudienceId: string; name: string | null; type: string | null; members: AudienceMember[] }>
}

export function memberProblem(m: AudienceMember): string | null {
  const v = m.value.trim()
  switch (m.type) {
    case 'KEYWORD': { const p = keywordTextProblem(v); return p ? `keyword "${v.slice(0, 60)}" ${p}` : null }
    case 'URL': return /^https?:\/\/\S+$/i.test(v) && v.length <= 2048 ? null : `"${v.slice(0, 60)}" is not a web address with http:// or https:// (at most 2048 characters)`
    case 'APP': return APP_RE.test(v) && v.length <= 255 ? null : `"${v.slice(0, 60)}" is not an Android package name (com.example.app)`
    case 'PLACE_CATEGORY': return /^\d{1,20}$/.test(v) ? null : `place category "${v.slice(0, 60)}" is not Google's id (digits)`
  }
}

/** Members once each, in a stable order (the list Google gets and Nexus compares). */
export function membersOf(list: AudienceMember[]): AudienceMember[] {
  const seen = new Map<string, AudienceMember>()
  for (const m of list) {
    const clean = { type: m.type, value: m.value.trim() }
    if (!seen.has(memberKey(clean))) seen.set(memberKey(clean), clean)
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, m]) => m)
}
const sameMembers = (a: AudienceMember[], b: AudienceMember[]) => membersOf(a).map(memberKey).join('\n') === membersOf(b).map(memberKey).join('\n')
const memberWords = (list: AudienceMember[]) => {
  const count = (t: string, w: string, many?: string) => { const n = list.filter((m) => m.type === t).length; return n ? plural(n, w, many) : '' }
  return [count('KEYWORD', 'keyword'), count('URL', 'web address', 'web addresses'), count('APP', 'app'), count('PLACE_CATEGORY', 'place category', 'place categories')].filter(Boolean).join(', ') || 'no member'
}

export function customAudienceDraft(customer: string, request: CustomAudienceRequest, live: { customAudiences: LiveCustomAudience[] } & Partial<UseContext>): GoogleChangeDraft | { refusal: string } {
  const creates = request.create ?? []
  const changes = request.change ?? []
  const removes = [...new Set(request.remove ?? [])].sort()
  if (!creates.length && !changes.length && !removes.length) return { refusal: 'Say what to change: create, change or remove.' }
  const ctx: UseContext = { uses: live.uses ?? [], audiences: live.audiences ?? [] }
  const byId = new Map(live.customAudiences.map((a) => [a.customAudienceId, a]))
  const taken = (name: string, except?: string) => live.customAudiences.some((a) => a.customAudienceId !== except && (a.name ?? '').trim().toLowerCase() === name.trim().toLowerCase())
  const createOps: Array<Record<string, unknown>> = []
  const updateOps: Array<Record<string, unknown>> = []
  const removeOps: Array<Record<string, unknown>> = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: CustomAudienceRecord = { audiences: [], created: [], removed: [] }
  const after: CustomAudienceRecord = { audiences: [], created: [], removed: [] }
  const newNames = new Set<string>()
  const membersProblem = (list: AudienceMember[], what: string): string | null => {
    for (const m of list) {
      const p = memberProblem(m)
      if (p) return `${what}: ${p}.`
    }
    return null
  }

  for (const [i, c] of creates.entries()) {
    const name = c.name.trim()
    const what = `New custom segment "${name}"`
    if (!name) return { refusal: 'A custom segment has a name.' }
    if (taken(name) || newNames.has(name.toLowerCase())) return { refusal: `${what}: a custom segment with this name exists (Google keeps the names unique, ignoring case).` }
    newNames.add(name.toLowerCase())
    const problem = membersProblem(c.members, what)
    if (problem) return { refusal: problem }
    const members = membersOf(c.members)
    if (!members.length) return { refusal: `${what}: name at least one keyword, web address or app.` }
    if (members.length < c.members.length) skipped.push(`${what}: ${plural(c.members.length - members.length, 'member')} named twice, sent once.`)
    const type = c.type ?? 'AUTO'
    createOps.push({ create: { name, ...(c.description?.trim() ? { description: c.description.trim() } : {}), type, members: members.map(memberJson) } })
    after.created.push({ customAudienceId: NEW_CUSTOM_AUDIENCE(i + 1), name })
    lines.push([`new custom segment: ${name}`, null, `${type}, ${memberWords(members)}`])
  }
  if (creates.length) warnings.push('A new custom segment reaches nobody until a campaign uses it (set-google-audiences, a Demand Gen or Display ad group, or a reusable audience): that is where it can spend.')

  const seen = new Set<string>()
  for (const ch of changes) {
    const a = byId.get(ch.customAudienceId)
    if (!a) return { refusal: `Custom segment ${ch.customAudienceId} is not in the account (or is removed). google-ads-live view lookup, lookup custom-audiences lists them.` }
    if (seen.has(a.customAudienceId) || removes.includes(a.customAudienceId)) return { refusal: `Custom segment ${a.customAudienceId} is named twice (change and remove are one or the other).` }
    seen.add(a.customAudienceId)
    const what = `Custom segment "${a.name ?? a.customAudienceId}"`
    if (ch.members && (ch.addMembers?.length || ch.removeMembers?.length)) return { refusal: `${what}: give members (the full list) or addMembers / removeMembers, not both.` }
    const was: CustomAudienceFields = { customAudienceId: a.customAudienceId }
    const now: CustomAudienceFields = { customAudienceId: a.customAudienceId }
    const body: Record<string, unknown> = { resourceName: `${customer}/customAudiences/${a.customAudienceId}` }
    const mask: string[] = []
    const set = (key: 'name' | 'description' | 'type', from: string | null, to: string | undefined) => {
      if (to === undefined) return
      if ((from ?? '') === to) { skipped.push(`${what}: ${key} is already "${to}".`); return }
      ;(was as unknown as Record<string, unknown>)[key] = from
      ;(now as unknown as Record<string, unknown>)[key] = to
      body[key] = to
      mask.push(key)
      lines.push([`${a.name}: ${key}`, from ?? '(none)', to || '(none)'])
    }
    if (ch.name !== undefined) {
      const name = ch.name.trim()
      if (!name) return { refusal: `${what}: a name cannot be empty.` }
      if (taken(name, a.customAudienceId) || newNames.has(name.toLowerCase())) return { refusal: `${what}: another custom segment is called "${name}".` }
      set('name', a.name, name)
    }
    set('description', a.description, ch.description?.trim())
    set('type', a.type, ch.type)
    const asked = [...(ch.members ?? []), ...(ch.addMembers ?? []), ...(ch.removeMembers ?? [])]
    const problem = membersProblem(asked, what)
    if (problem) return { refusal: problem }
    let members = a.members
    if (ch.members) members = membersOf(ch.members)
    if (ch.addMembers?.length || ch.removeMembers?.length) {
      const gone = new Set((ch.removeMembers ?? []).map(memberKey))
      const missing = (ch.removeMembers ?? []).filter((m) => !a.members.some((x) => memberKey(x) === memberKey(m)))
      if (missing.length) skipped.push(`${what}: ${missing.map((m) => `"${m.value}"`).slice(0, 5).join(', ')} is not in it.`)
      members = membersOf([...a.members.filter((m) => !gone.has(memberKey(m))), ...(ch.addMembers ?? [])])
    }
    const membersAsked = !!ch.members || !!ch.addMembers?.length || !!ch.removeMembers?.length
    if (membersAsked && sameMembers(members, a.members)) skipped.push(`${what}: it already has exactly these members.`)
    else if (membersAsked) {
      if (!members.length) return { refusal: `${what}: a custom segment keeps at least one member (remove it instead).` }
      was.members = membersOf(a.members)
      now.members = members
      body.members = members.map(memberJson)
      mask.push('members')
      const added = members.filter((m) => !a.members.some((x) => memberKey(x) === memberKey(m)))
      const dropped = a.members.filter((m) => !members.some((x) => memberKey(x) === memberKey(m)))
      lines.push([`${a.name}: members`, memberWords(a.members), `${memberWords(members)}${added.length ? ` (+${added.length})` : ''}${dropped.length ? ` (−${dropped.length})` : ''}`])
      const places = placesOf(ctx, 'CUSTOM_AUDIENCE', a.customAudienceId)
      if (added.length) {
        const out = widenLines(what, `gets ${plural(added.length, 'new member')} (${added.slice(0, 3).map((m) => `"${m.value}"`).join(', ')}${added.length > 3 ? ' …' : ''})`, places.positive)
        spends.push(...out.spends)
        warnings.push(...out.warnings)
      } else warnings.push(...narrowLine(what, `loses ${plural(dropped.length, 'member')}`, places.positive))
    }
    if (now.type !== undefined) {
      const out = widenLines(what, `is matched another way (${a.type} → ${now.type})`, placesOf(ctx, 'CUSTOM_AUDIENCE', a.customAudienceId).positive)
      spends.push(...out.spends)
      warnings.push(...out.warnings)
    }
    if (!mask.length) continue
    updateOps.push({ update: body, updateMask: mask.join(',') })
    before.audiences.push(was)
    after.audiences.push(now)
  }

  for (const id of removes) {
    const a = byId.get(id)
    if (!a) return { refusal: `Custom segment ${id} is not in the account (or is already removed).` }
    const direct = ctx.uses.filter((u) => u.kind === 'CUSTOM_AUDIENCE' && u.id === id)
    if (direct.length) return { refusal: `Custom segment "${a.name ?? id}" is used by ${placesWords(direct)}: Google does not remove a custom segment in use (CANNOT_REMOVE_WHILE_IN_USE). Take it off them first (set-google-audiences, set-google-campaign-type).` }
    removeOps.push({ remove: `${customer}/customAudiences/${id}` })
    lines.push([`custom segment ${a.name ?? id}`, memberWords(a.members), 'REMOVED'])
    const removed = { customAudienceId: id, name: a.name, type: a.type, members: membersOf(a.members) }
    before.removed.push(removed)
    after.removed.push(removed)
    if (ctx.audiences.some((x) => x.definition.segments.some((s) => s.kind === 'CUSTOM_AUDIENCE' && s.id === id))) {
      warnings.push(`Custom segment "${a.name ?? id}" is part of a reusable audience: Google may refuse to remove it.`)
    }
  }
  if (removes.length) warnings.push('A removed custom segment cannot be restored; undo does not make it again.')

  const operations = [...createOps, ...updateOps, ...removeOps]
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ') || 'every custom segment is already so.'}` }
  const { changes: table, more } = changeLines(lines)
  const parts = [
    after.created.length ? `make ${plural(after.created.length, 'custom segment')}` : '',
    after.audiences.length ? `change ${plural(after.audiences.length, 'custom segment')}` : '',
    after.removed.length ? `remove ${plural(after.removed.length, 'custom segment')} for good` : '',
  ].filter(Boolean)
  return {
    summary: `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.`,
    changes: table,
    totals: { created: after.created.length, changed: after.audiences.length, removed: after.removed.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    // ONE call of CustomAudienceService (account-client.ts): its operations, all or nothing.
    operations: [{ [ACCOUNT_CALL]: { path: 'customAudiences:mutate', body: { operations } } }],
    stands: {
      audiences: live.customAudiences.filter((a) => seen.has(a.customAudienceId) || removes.includes(a.customAudienceId))
        .map((a) => `${a.customAudienceId}:${a.name}:${a.description ?? ''}:${a.type}:${membersOf(a.members).map(memberKey).join('|')}`).sort(),
      names: creates.length || changes.some((c) => c.name !== undefined) ? live.customAudiences.map((a) => (a.name ?? '').toLowerCase()).sort() : [],
      uses: [...seen, ...removes].sort().map((id) => {
        const p = placesOf(ctx, 'CUSTOM_AUDIENCE', id)
        return `${id}:${[...p.positive, ...p.negative].map((u) => `${u.campaignId}/${u.campaignStatus}/${u.levelStatus}/${u.status}`).sort().join(',')}`
      }),
    },
    before,
    after,
  }
}

/** After the run: the ids Google gave the custom segments it made (results in operation order; creates go first). */
export function customAudienceRecordAfterRun(after: CustomAudienceRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): CustomAudienceRecord {
  const made = responses.map((r) => r.accountResult?.resourceName)
  const out = structuredClone(after)
  out.created = out.created.map((c, i) => {
    const name = made[i]
    return name && name.includes('/customAudiences/') ? { ...c, customAudienceId: name.slice(name.lastIndexOf('/') + 1) } : c
  })
  return out
}
