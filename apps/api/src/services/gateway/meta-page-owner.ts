/**
 * Meta step 36 (2026-10-21) — the owner check of a change made AS the chosen Facebook Page (a write rule with
 * `auth: 'page'`, meta-lead-form-rules.ts). Before the gateway reads the Page's token (meta-page-token.ts) and sends
 * anything, the object the change names must be:
 *   page      the business's CHOSEN Page itself (its PAGE MetaAccountLink, row-level security: never another business's);
 *   leadform  a lead form OF that Page: one create-meta-lead-form made there (Nexus's own change records), else ONE live
 *             read of the form through this gateway (`GET /<form>?fields=id,page_id,questions{type}`, the business's
 *             system-user token): the same id must come back, its `page_id` must be the chosen Page and it must have
 *             questions (SDK leadgenform.py: `page_id`, `questions` — only a lead form has both);
 *   testlead  a TEST lead Nexus made itself on a form of that Page (set-meta-lead-form's change records): a real lead is
 *             never in them, so Nexus never deletes one (LD-039: Meta documents deleting for test leads only).
 * And every id inside the body: a form's intro photo (`context_card.cover_photo_id`) must be a photo OF the chosen Page
 * (ONE live read `GET /<photo>?fields=id,from{id},width,height`: the same id, `from` the chosen Page, a width and height —
 * a post, video, album or comment has no such pair).
 * Anything else — another business's Page, form or lead, a node of another kind, an id Meta cannot place — gets nothing
 * sent, and the sentence never names the other business's asset. Lanes C2 (posts) and C4 (comments, messages) add their
 * own kinds here.
 */
import { metaChosenPageOf, metaPageObjectNexusMade } from './account.js'
import type { MetaJudgedWrite, MetaWriteKind } from './meta-calls.js'
// Step 39's one read for an owner check, through the gateway (its read gate, ledger and rate bucket).
import type { MetaCheckRead } from './meta-brand-safety-owner.js'

/** The kinds this check confirms (every rule marked `auth: 'page'` names one of them). */
export const META_PAGE_KINDS: ReadonlySet<MetaWriteKind> = new Set<MetaWriteKind>(['page', 'leadform', 'testlead'])

type Problem = { code: string; sentence: string } | null
const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null
const rowsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { data?: unknown }).data) ? (v as { data: unknown[] }).data : [])

/** Why this change made as the chosen Page is refused for this connection, or null (its object and body ids are the Page's). */
export async function metaPageOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string | undefined, read: MetaCheckRead): Promise<Problem> {
  const id = write.objectId
  if (!kind || !META_PAGE_KINDS.has(kind as MetaWriteKind) || !write.kinds?.includes(kind as MetaWriteKind)) {
    return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: a change made as the Facebook Page names the kind of object it changes (the Page, a lead form of it, a test lead Nexus made), and ${id} is not named so.` }
  }
  if (write.auth !== 'page') return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${id} is a Page object, and only a change made as the Page writes one.` }
  const pageId = await metaChosenPageOf(connectionId)
  if (!pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: 'Nothing was sent to Meta: this business has no Facebook Page chosen through this Meta connection, so Nexus changes nothing made as a Page.' }
  const problem = kind === 'page' ? (id === pageId ? null : { code: 'META_PAGE_NOT_CHOSEN', sentence: `Nothing was sent to Meta: ${id} is not the Facebook Page this business chose through this connection.` })
    : kind === 'leadform' ? await formOfPage(id, pageId, read)
      : await testLeadNexusMade(id, pageId)
  return problem ?? bodyIdsProblem(write, pageId, read)
}

async function formOfPage(formId: string, pageId: string, read: MetaCheckRead): Promise<Problem> {
  if (await metaPageObjectNexusMade('leadform', formId, pageId)) return null
  const answer = await read(formId, { fields: 'id,page_id,questions{type}' })
  if (!answer.body) {
    const notForm = /nonexisting field/i.test(answer.words ?? '')
    return notForm
      ? { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${formId} is not a lead form (Meta: ${answer.words}).` }
      : { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm that lead form ${formId} is of the Facebook Page this business chose${answer.words ? ` (Meta: ${answer.words})` : ''}.` }
  }
  if (idOf(answer.body.id) !== formId) return { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Meta answered another object than lead form ${formId}.` }
  if (idOf(answer.body.page_id) !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `Nothing was sent to Meta: lead form ${formId} is not a form of the Facebook Page this business chose.` }
  if (!rowsOf(answer.body.questions).length) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${formId} is not a lead form Nexus can confirm (Meta names no questions on it).` }
  return null
}

async function testLeadNexusMade(leadId: string, pageId: string): Promise<Problem> {
  if (await metaPageObjectNexusMade('testlead', leadId, pageId)) return null
  return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: ${leadId} is not a test lead Nexus made on a lead form of the Facebook Page this business chose. Nexus deletes only its own test leads, never a real lead (a person deletes another test lead in Meta's lead ads testing tool).` }
}

async function bodyIdsProblem(write: MetaJudgedWrite, pageId: string, read: MetaCheckRead): Promise<Problem> {
  for (const inner of write.ids ?? []) {
    if (inner.kind !== 'pagephoto' || !/^\d{1,25}$/.test(inner.id)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: 'Nothing was sent to Meta: this change names an id inside its body that Nexus does not check.' }
    const answer = await read(inner.id, { fields: 'id,from{id},width,height' })
    const from = answer.body?.from && typeof answer.body.from === 'object' ? idOf((answer.body.from as Record<string, unknown>).id) : null
    const sized = (v: unknown) => typeof v === 'number' && v > 0
    if (!answer.body) {
      return /nonexisting field/i.test(answer.words ?? '')
        ? { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not a photo (Meta: ${answer.words}).` }
        : { code: 'META_PAGE_UNCONFIRMED', sentence: `Nothing was sent to Meta: Nexus could not confirm that photo ${inner.id} is the chosen Facebook Page's${answer.words ? ` (Meta: ${answer.words})` : ''}.` }
    }
    if (idOf(answer.body.id) !== inner.id || from !== pageId) return { code: 'META_PAGE_NOT_CHOSEN', sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not a photo of the Facebook Page this business chose.` }
    if (!sized(answer.body.width) || !sized(answer.body.height)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `Nothing was sent to Meta: inside this change, ${inner.id} is not a photo Nexus can confirm.` }
  }
  return null
}
