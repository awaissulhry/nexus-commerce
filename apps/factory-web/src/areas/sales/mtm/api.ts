import { z } from 'zod'
import { mtmCheckView, templateRulesView, type MtmCheckBody } from '@nexus/factory-domain/product/mtm-rules/contracts'
import {
  alteredView,
  appointmentView,
  bookedView,
  fittingsTabView,
  recordedResultView,
  resultView,
  type BookBody,
  type CancelBody,
  type CloseBody,
  type MoveBody,
  type ResultBody,
} from '@nexus/factory-domain/sales/fittings/contracts'
import {
  documentUnitsView,
  profileRecordView,
  profilesView,
  recordedView,
  repeatView,
  reviewedView,
  templateView,
  worksheetVersionView,
  type NewProfileBody,
  type NewRevisionBody,
  type ReviewBody,
} from '@nexus/factory-domain/sales/mtm/contracts'
import type { ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Sales › Made-to-measure (SCR-036, the rider profile, the worksheet tab; B-W2b-362 on B-W2b-358's and B-W2b-360's
 * API, B-W2b-171's measurement link and B-W2b-248's check), each answer checked against the API's own contracts where
 * factory-domain holds them (zod drops unknown fields), else against a shape of ours. Every write carries one Idempotency-Key
 * per attempt (the caller keeps it for a retry) and the version it read where the API asks one. The API's English (`why`,
 * `message`, a rule check's `detail`, a fitting result's `next`) is never shown: the screens say their own words from codes,
 * states and figures (model.ts). No money: a made-to-measure unit's price is the quote's.
 */

export type ProfilesView = z.infer<typeof profilesView>
export type ProfileRow = ProfilesView['rows'][number]
export type Tiles = ProfilesView['tiles']
export type ProfileRecord = z.infer<typeof profileRecordView>
export type Revision = ProfileRecord['revisions'][number]
export type TemplatePoint = NonNullable<ProfileRecord['template']>['points'][number]
export type Unit = ProfileRecord['units'][number]
export type Worksheet = z.infer<typeof worksheetVersionView>
export type Recorded = z.infer<typeof recordedView>
export type Reviewed = z.infer<typeof reviewedView>
export type RepeatFacts = z.infer<typeof repeatView>
export type DocumentUnits = z.infer<typeof documentUnitsView>
export type FittingsTab = z.infer<typeof fittingsTabView>
export type AppointmentRow = FittingsTab['appointments'][number]
export type Appointment = z.infer<typeof appointmentView>
export type Booked = z.infer<typeof bookedView>
export type FittingResult = z.infer<typeof resultView>
export type RecordedResult = z.infer<typeof recordedResultView>
export type Altered = z.infer<typeof alteredView>
export type MtmCheck = z.infer<typeof mtmCheckView>
export type TemplateView = z.infer<typeof templateView>
export type TemplateRules = z.infer<typeof templateRulesView>
export type { ReviewStatus }

const enc = encodeURIComponent
const PROFILES = '/sales/mtm/profiles'
const profilePath = (id: string) => `${PROFILES}/${enc(id)}`
const keyed = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
const clean = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== '')) as Record<string, string | number | boolean>

// ---- rider profiles (B-W2b-358) -------------------------------------------------------------------------------------------

/** One page of rider profiles (the newest revision of each rider's garment type). */
export const PAGE_SIZE = 50

export interface ProfilesQuery {
  q?: string
  garmentType?: string | null
  partyId?: string | null
  review?: ReviewStatus | null
  old?: boolean | null
  offset?: number
}

export function listProfiles(api: ApiClient, query: ProfilesQuery, signal?: AbortSignal): Promise<ProfilesView> {
  return api.get(PROFILES, {
    query: clean({ q: query.q?.trim() || undefined, garmentType: query.garmentType ?? undefined, partyId: query.partyId ?? undefined, review: query.review ?? undefined, old: query.old === null || query.old === undefined ? undefined : String(query.old), limit: PAGE_SIZE, offset: query.offset ?? 0 }),
    schema: profilesView,
    signal,
  })
}

export async function getProfile(api: ApiClient, profileId: string, signal?: AbortSignal): Promise<ProfileRecord> {
  return (await api.get(profilePath(profileId), { schema: z.object({ profile: profileRecordView }), signal })).profile
}

export function recordProfile(api: ApiClient, body: NewProfileBody, idempotencyKey?: string): Promise<Recorded> {
  return api.post(PROFILES, { body, schema: recordedView, ...keyed(idempotencyKey) })
}

export function recordRevision(api: ApiClient, profileId: string, body: NewRevisionBody, idempotencyKey?: string): Promise<Recorded> {
  return api.post(`${profilePath(profileId)}/revisions`, { body, schema: recordedView, ...keyed(idempotencyKey) })
}

export function reviewProfile(api: ApiClient, profileId: string, body: Partial<ReviewBody> & Pick<ReviewBody, 'decision'>, idempotencyKey?: string): Promise<Reviewed> {
  return api.post(`${profilePath(profileId)}/review`, { body, schema: reviewedView, ...keyed(idempotencyKey) })
}

export async function readRepeat(api: ApiClient, profileId: string, signal?: AbortSignal): Promise<RepeatFacts> {
  return (await api.get(`${profilePath(profileId)}/repeat`, { schema: z.object({ repeatFacts: repeatView }), signal })).repeatFacts
}

const quoteAnswer = z.object({ quote: z.object({ id: z.string(), number: z.string(), version: z.number().int() }) })
export type QuoteRef = z.infer<typeof quoteAnswer>['quote']

export async function repeatOrder(api: ApiClient, profileId: string, body: { quoteId: string; version: number; fromLineId?: string; measuredOk: boolean }, idempotencyKey?: string): Promise<{ quote: QuoteRef; lineId: string }> {
  return api.post(`${profilePath(profileId)}/repeat`, { body, schema: quoteAnswer.extend({ lineId: z.string() }), ...keyed(idempotencyKey) })
}

export async function listWorksheets(api: ApiClient, profileId: string, signal?: AbortSignal): Promise<Worksheet[]> {
  return (await api.get(`${profilePath(profileId)}/worksheets`, { schema: z.object({ worksheets: z.array(worksheetVersionView) }), signal })).worksheets
}

const madeWorksheet = z.object({ worksheet: z.object({ id: z.string(), version: z.number().int(), fileId: z.string(), made: z.boolean() }), worksheets: z.array(worksheetVersionView) })
export type MadeWorksheet = z.infer<typeof madeWorksheet>

/** The worksheet kept as a version (the same contents answer the newest, `made` false: nothing written). */
export function makeWorksheet(api: ApiClient, profileId: string, body: { companyId: string; language: 'it' | 'en' }, idempotencyKey?: string): Promise<MadeWorksheet> {
  return api.post(`${profilePath(profileId)}/worksheets`, { body, schema: madeWorksheet, ...keyed(idempotencyKey) })
}

const presigned = z.object({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() })

/** A short-lived address of one worksheet version (its opening is recorded on the profile). */
export function openWorksheet(api: ApiClient, profileId: string, documentId: string, idempotencyKey?: string): Promise<{ worksheet: { id: string; version: number; fileId: string }; download: z.infer<typeof presigned> }> {
  return api.post(`${profilePath(profileId)}/worksheets/${enc(documentId)}/open`, { body: {}, schema: z.object({ worksheet: z.object({ id: z.string(), version: z.number().int(), fileId: z.string() }), download: presigned }), ...keyed(idempotencyKey) })
}

export async function orderUnits(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<DocumentUnits> {
  return (await api.get(`/sales/orders/${enc(orderId)}/made-to-measure`, { schema: z.object({ made: documentUnitsView }), signal })).made
}

// ---- a new quote with a unit ("Use in a new quote") ---------------------------------------------------------------------

/** W1's quote maker: a DRAFT quote of the rider's customer (the unit is added next). */
export async function createQuote(api: ApiClient, body: { companyId: string; partyId: string; contactId?: string | null }, idempotencyKey?: string): Promise<QuoteRef> {
  return (await api.post('/sales/quotes', { body: clean(body), schema: quoteAnswer, ...keyed(idempotencyKey) })).quote
}

/** A made-to-measure unit on a DRAFT quote (B-W2b-358): one piece of its base size, on the rider's newest revision. */
export async function addUnit(api: ApiClient, quote: Pick<QuoteRef, 'id' | 'version'>, body: { styleId: string; colourwayId: string; measurementProfileId: string; baseSize?: string | null }, idempotencyKey?: string): Promise<QuoteRef> {
  return (await api.post(`/sales/quotes/${enc(quote.id)}/lines/made-to-measure`, { body: { version: quote.version, ...clean(body) }, schema: quoteAnswer, ...keyed(idempotencyKey) })).quote
}

// ---- the check (B-W2b-248) -------------------------------------------------------------------------------------------------

/** The one check of a measurement set: against a style (base size, alterations, certificate) or a template alone (its rules). */
export async function checkMeasures(api: ApiClient, body: MtmCheckBody, signal?: AbortSignal): Promise<MtmCheck> {
  return (await api.post('/product/made-to-measure/check', { body, schema: z.object({ check: mtmCheckView }), signal })).check
}

// ---- styles for a unit and for the check ------------------------------------------------------------------------------

const styleOption = z.object({ id: z.string(), code: z.string(), name: z.string(), mtmAllowed: z.boolean(), sizes: z.array(z.string()), baseSize: z.string().nullable() })
export type StyleOption = z.infer<typeof styleOption>

/** The styles flagged made to measure (PRD-017) the caller reads. */
export async function listMtmStyles(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<StyleOption[]> {
  return (await api.get('/product/styles', { query: clean({ mtmAllowed: 'true', status: 'OPEN', companyId: companyId ?? undefined, limit: 200 }), schema: z.object({ styles: z.array(styleOption) }), signal })).styles
}

const styleDetail = styleOption.extend({
  measurementTemplate: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  colourways: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string() })),
})
export type StyleDetail = z.infer<typeof styleDetail>

export async function getStyle(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<StyleDetail> {
  return (await api.get(`/product/styles/${enc(styleId)}`, { schema: z.object({ style: styleDetail }), signal })).style
}

// ---- measurement templates (garment types) --------------------------------------------------------------------------

const templateOption = z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: z.record(z.string(), z.string()), productType: z.string(), companyId: z.string().nullable(), status: z.enum(['ACTIVE', 'ARCHIVED']), rulesOn: z.boolean(), points: z.number().int() })
export type TemplateOption = z.infer<typeof templateOption>

export async function listTemplates(api: ApiClient, query: { status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'; q?: string } = {}, signal?: AbortSignal): Promise<{ templates: TemplateOption[]; more: boolean }> {
  return api.get('/product/measurement-templates', { query: clean({ status: query.status ?? 'ACTIVE', q: query.q?.trim() || undefined, limit: 200 }), schema: z.object({ templates: z.array(templateOption), more: z.boolean() }), signal })
}

export async function getTemplate(api: ApiClient, templateId: string, signal?: AbortSignal): Promise<TemplateView> {
  return (await api.get(`/product/measurement-templates/${enc(templateId)}`, { schema: z.object({ template: templateView }), signal })).template
}

// ---- customers, riders and people -------------------------------------------------------------------------------------

const partyOption = z.object({ id: z.string(), code: z.string(), legalName: z.string() })
export type PartyOption = z.infer<typeof partyOption>

export async function findCustomers(api: ApiClient, q: string, companyId: string | null, signal?: AbortSignal): Promise<PartyOption[]> {
  return (await api.get('/parties', { query: clean({ q: q.trim() || undefined, role: 'CUSTOMER', status: 'ACTIVE', companyId: companyId ?? undefined, limit: 50 }), schema: z.object({ parties: z.array(partyOption) }), signal })).parties
}

const contactOption = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), status: z.string(), roles: z.array(z.string()).default([]) })
export type ContactOption = z.infer<typeof contactOption>

/** A customer's active contacts (a rider is a contact with the RIDER role, listed first). */
export async function listContacts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<ContactOption[]> {
  const answer = await api.get(`/parties/${enc(partyId)}`, { schema: z.object({ party: z.object({ contacts: z.array(contactOption) }) }), signal })
  return answer.party.contacts.filter((contact) => contact.status === 'ACTIVE').sort((a, b) => Number(b.roles.includes('RIDER')) - Number(a.roles.includes('RIDER')) || a.name.localeCompare(b.name))
}

const person = z.object({ id: z.string(), name: z.string() })
export type Person = z.infer<typeof person>

/** The office people a measurer or a fitter may be (tasks.manage; else only the person themself). */
export async function listPeople(api: ApiClient, signal?: AbortSignal): Promise<Person[]> {
  return (await api.get('/tasks/assignees', { schema: z.object({ people: z.array(person) }), signal })).people
}

// ---- the measurement link and what came back (B-W2b-171) ----------------------------------------------------------------

const linkAnswer = z.object({
  link: z.object({ id: z.string(), profileId: z.string(), expiresAt: z.string(), email: z.string().nullable(), photos: z.enum(['REQUIRED', 'OPTIONAL']) }),
  url: z.string().nullable(),
  delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable(),
})
export type LinkAnswer = z.infer<typeof linkAnswer>

export interface LinkBody {
  profileId: string
  companyId: string
  contactId?: string
  email?: string
  send: boolean
  photos: 'REQUIRED' | 'OPTIONAL'
  language: 'it' | 'en'
  expiresInDays: number
}

export function sendMeasureLink(api: ApiClient, body: LinkBody, idempotencyKey?: string): Promise<LinkAnswer> {
  return api.post('/sales/measure-links', { body: clean({ ...body }), schema: linkAnswer, ...keyed(idempotencyKey) })
}

const measurement = z.object({ value: z.string(), unit: z.string() })
const sentAnswer = z.object({
  profile: z.object({ id: z.string(), riderName: z.string(), garmentType: z.string(), latestRevision: z.number().int() }),
  revisions: z.array(
    z.object({
      id: z.string(),
      revision: z.number().int(),
      submittedAt: z.string(),
      takenBy: z.string(),
      link: z.object({ id: z.string(), email: z.string().nullable(), contactName: z.string().nullable() }),
      notice: z.object({ id: z.string(), label: z.string(), at: z.string() }),
      measurements: z.record(z.string(), measurement),
      photos: z.array(z.object({ view: z.enum(['FRONT', 'SIDE', 'BACK']), fileId: z.string(), status: z.string() })),
      photosDeleteAfter: z.string().nullable(),
    }),
  ),
  links: z.array(z.object({ id: z.string(), recordId: z.string(), email: z.string().nullable(), createdAt: z.string(), expiresAt: z.string(), uses: z.number().int(), maxUses: z.number().int(), revoked: z.boolean(), photos: z.enum(['REQUIRED', 'OPTIONAL']) })),
})
export type Sent = z.infer<typeof sentAnswer>
export type SentRevision = Sent['revisions'][number]
export type SentPhoto = SentRevision['photos'][number]

/** Who sent what over the rider's chain: each revision sent by link (its photos, the notice), and the links made. */
export function readSent(api: ApiClient, profileId: string, signal?: AbortSignal): Promise<Sent> {
  return api.get(`/sales/measurement-profiles/${enc(profileId)}/sent`, { schema: sentAnswer, signal })
}

/** One body photo, its stripped copy, for 60 s (the opening is recorded). */
export function openPhoto(api: ApiClient, profileId: string, fileId: string): Promise<{ file: { id: string; view: 'FRONT' | 'SIDE' | 'BACK' }; download: z.infer<typeof presigned> }> {
  return api.post(`/sales/measurement-profiles/${enc(profileId)}/photos/${enc(fileId)}/open`, { body: {}, schema: z.object({ file: z.object({ id: z.string(), view: z.enum(['FRONT', 'SIDE', 'BACK']) }), download: presigned }) })
}

/** The day a revision's photos are deleted (with why; the cron deletes them then). */
export function setPhotosDeleteAfter(api: ApiClient, profileId: string, body: { deleteAfter: string; reason: string }): Promise<{ profile: { id: string; photosDeleteAfter: string } }> {
  return api.post(`/sales/measurement-profiles/${enc(profileId)}/photos-delete-after`, { body, schema: z.object({ profile: z.object({ id: z.string(), photosDeleteAfter: z.string() }) }) })
}

// ---- fittings (B-W2b-360) ---------------------------------------------------------------------------------------------------

export async function readFittings(api: ApiClient, profileId: string, signal?: AbortSignal, /* B-W2b-F38: the screen's company, for its reminder switch */ companyId?: string | null): Promise<FittingsTab> {
  return (await api.get(`${profilePath(profileId)}/fittings`, { query: companyId ? { companyId } : {}, schema: z.object({ fittings: fittingsTabView }), signal })).fittings
}

const APPOINTMENTS = '/sales/fittings/appointments'
const appointmentPath = (id: string) => `${APPOINTMENTS}/${enc(id)}`

export function bookFitting(api: ApiClient, body: Partial<BookBody> & Pick<BookBody, 'companyId' | 'partyId' | 'kind' | 'startsAt' | 'endsAt' | 'place'>, idempotencyKey?: string): Promise<Booked> {
  return api.post(APPOINTMENTS, { body, schema: bookedView, ...keyed(idempotencyKey) })
}

export async function getAppointment(api: ApiClient, appointmentId: string, signal?: AbortSignal): Promise<Appointment> {
  return (await api.get(appointmentPath(appointmentId), { schema: z.object({ appointment: appointmentView }), signal })).appointment
}

export function moveAppointment(api: ApiClient, appointmentId: string, body: Partial<MoveBody> & Pick<MoveBody, 'version'>, idempotencyKey?: string): Promise<Booked> {
  return api.request('PATCH', appointmentPath(appointmentId), { body, schema: bookedView, ...keyed(idempotencyKey) })
}

export async function closeAppointment(api: ApiClient, appointmentId: string, body: Partial<CloseBody> & Pick<CloseBody, 'version' | 'status'>, idempotencyKey?: string): Promise<Appointment> {
  return (await api.post(`${appointmentPath(appointmentId)}/close`, { body, schema: z.object({ appointment: appointmentView }), ...keyed(idempotencyKey) })).appointment
}

export function cancelAppointment(api: ApiClient, appointmentId: string, body: Partial<CancelBody> & Pick<CancelBody, 'version' | 'reason'>, idempotencyKey?: string): Promise<Booked> {
  return api.post(`${appointmentPath(appointmentId)}/cancel`, { body, schema: bookedView, ...keyed(idempotencyKey) })
}

export function inviteAgain(api: ApiClient, appointmentId: string, body: { version: number; language?: 'it' | 'en' }, idempotencyKey?: string): Promise<Booked> {
  return api.post(`${appointmentPath(appointmentId)}/invite`, { body, schema: bookedView, ...keyed(idempotencyKey) })
}

export function recordResult(api: ApiClient, body: Partial<ResultBody> & Pick<ResultBody, 'verdict'>, idempotencyKey?: string): Promise<RecordedResult> {
  return api.post('/sales/fittings/results', { body, schema: recordedResultView, ...keyed(idempotencyKey) })
}

export function openAlteration(api: ApiClient, resultId: string, body: { version: number; movePromise?: boolean }, idempotencyKey?: string): Promise<Altered> {
  return api.post(`/sales/fittings/results/${enc(resultId)}/alteration`, { body, schema: alteredView, ...keyed(idempotencyKey) })
}

export async function nameResultRevision(api: ApiClient, resultId: string, body: { version: number; profileId: string }, idempotencyKey?: string): Promise<FittingResult> {
  return (await api.post(`/sales/fittings/results/${enc(resultId)}/revision`, { body, schema: z.object({ result: resultView }), ...keyed(idempotencyKey) })).result
}

// ---- proofs of the rider's quotes (B-W2b-165) -----------------------------------------------------------------------------

const proof = z.object({ fileId: z.string(), name: z.string(), shape: z.enum(['PDF', 'PICTURE']), versionNo: z.number().int(), state: z.enum(['READY', 'UPLOADING', 'CHECKING', 'REFUSED']), sharedWithCustomer: z.boolean(), addedAt: z.string() })
const acceptedProofs = z.object({ signerName: z.string().nullable(), acceptedAt: z.string(), proofs: z.array(z.object({ fileId: z.string(), name: z.string(), versionNo: z.number().int() })) })
const proofsAnswer = z.object({
  quoteId: z.string(),
  versions: z.array(z.object({ versionId: z.string(), revision: z.number().int(), status: z.string(), current: z.boolean(), sentAt: z.string().nullable(), proofs: z.array(proof), accepted: acceptedProofs.nullable() })),
})
export type QuoteProofs = z.infer<typeof proofsAnswer>
export type Proof = z.infer<typeof proof>

/** The proofs a quote carries per version, with what the customer accepted (quotes.view). */
export function readQuoteProofs(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<QuoteProofs> {
  return api.get(`/sales/quotes/${enc(quoteId)}/proofs`, { schema: proofsAnswer, signal })
}
