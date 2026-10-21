/**
 * Meta step 36 (2026-10-21) — the live state a lead-form change stands on, read through the gateway (GET only, the
 * business's system-user token) and step 14's checks (live-engagement.ts: the form must be one of the chosen Page's —
 * ownForm, formOnPage), never copied:
 *   - the chosen Page and whether a person accepted Meta's Lead Ads Terms for it (`leadgen_tos_accepted`, SDK page.py; the
 *     accepting person is not read) — Meta refuses a form until they are accepted, and accepting them is a person's click
 *     in Meta's screens;
 *   - one form: its name, status, question keys and types, consent-box keys (step 14's view-form read; review B1: when the
 *     Page's list answers without the form — an archived form may be left out — its own page_id must be the chosen Page,
 *     live-engagement.ts ownFormForChange, fail closed);
 *   - a form's test-lead ids (step 14's formTestLeadIds), and the test leads Nexus made on it (its own change records).
 * Nothing here reads a real lead or keeps an answer.
 */
import prisma from '../../../db.js'
import { META_LEAD_FORM_SET_TOOL } from '../../gateway/account.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal } from './live.js'
import { pageOf } from './live-media.js'
import { formTestLeadIds, liveLeadFormForChange } from './live-engagement.js'

type Row = Record<string, unknown>
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)

export interface LeadFormPage {
  pageId: string
  /** Meta's `leadgen_tos_accepted`; null when Meta did not answer it (`termsNote` says why). */
  termsAccepted: boolean | null
  termsNote?: string
}

/** The chosen Page lead forms are made on, and whether its Lead Ads Terms are accepted. */
export async function liveLeadFormPage(connectionId: string): Promise<LeadFormPage> {
  const account = await metaChosenAccount(connectionId)
  const pageId = pageOf(account)
  try {
    const read = await metaReadOne<Row>({ connectionId: account.connectionId }, { operation: 'leadforms.pageTerms', path: pageId, query: { fields: 'id,leadgen_tos_accepted' } })
    if (idText(read.body.id) !== pageId) return { pageId, termsAccepted: null, termsNote: 'Meta answered for another object than the chosen Page.' }
    return { pageId, termsAccepted: typeof read.body.leadgen_tos_accepted === 'boolean' ? read.body.leadgen_tos_accepted : null }
  } catch (err) {
    if (!(err instanceof MetaReadError) || err.failure.throttled) throw err
    return { pageId, termsAccepted: null, termsNote: `Nexus could not read whether the Page's Lead Ads Terms are accepted (${err.failure.sentence})` }
  }
}

export interface LeadFormQuestionState { key: string | null; type: string | null; options: string[] }
export interface LeadFormState {
  pageId: string
  formId: string
  name: string | null
  status: string | null
  questions: LeadFormQuestionState[]
  checkboxKeys: string[]
}

/** One form of the chosen Page as a change needs it (step 14's view-form read, after ownFormForChange). */
export async function liveLeadFormState(connectionId: string, formId: string): Promise<LeadFormState> {
  const read = await liveLeadFormForChange({ connectionId, formId }) as { pageId: string; form: { formId: string | null; name: string | null; status: string | null; questions: unknown; consentBoxes: { checkboxes: Array<{ key: string | null }> } | null } }
  const questions = (Array.isArray(read.form.questions) ? read.form.questions : Array.isArray(obj(read.form.questions)?.data) ? obj(read.form.questions)!.data as unknown[] : [])
    .map(obj).filter((q): q is Row => !!q)
    .map((q) => ({
      key: typeof q.key === 'string' ? q.key : null,
      type: typeof q.type === 'string' ? q.type : null,
      options: (Array.isArray(q.options) ? q.options : []).map(obj).filter((o): o is Row => !!o).map((o) => (typeof o.value === 'string' ? o.value : null)).filter((v): v is string => !!v),
    }))
  if (read.form.formId !== formId) throw new MetaLiveRefusal('Meta answered another form than the one asked; nothing of it is used.')
  return {
    pageId: read.pageId,
    formId,
    name: read.form.name,
    status: read.form.status,
    questions,
    checkboxKeys: (read.form.consentBoxes?.checkboxes ?? []).map((c) => c.key).filter((k): k is string => !!k),
  }
}

/** A form's test-lead ids as Meta lists them, or null with Meta's words when Meta would not list them. */
export async function liveTestLeadIds(connectionId: string, formId: string): Promise<{ ids: string[] | null; note?: string }> {
  try {
    return { ids: await formTestLeadIds({ connectionId, formId }) }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || (err instanceof MetaReadError && !err.failure.throttled)) return { ids: null, note: err.message }
    throw err
  }
}

/**
 * The test leads Nexus made on this form of this Page (its own change records, this business's only: row-level security)
 * — the only leads Nexus ever deletes (the gateway checks the same records before it sends a DELETE).
 */
export async function nexusTestLeadsOf(pageId: string, formId: string): Promise<string[]> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: META_LEAD_FORM_SET_TOOL, AND: [{ after: { path: ['formId'], equals: formId } }, { after: { path: ['pageId'], equals: pageId } }] },
    select: { after: true },
    orderBy: { executedAt: 'desc' },
    take: 50,
  })
  return [...new Set(rows.map((r) => idText(obj(r.after)?.testLeadId)).filter((id): id is string => !!id))]
}
