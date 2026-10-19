/**
 * Amazon A+ content (2026-10-19) — the A+ client as Amazon's model has the calls: every operation's method, path, query
 * (includedDataSet as ONE comma-separated value, asinSet comma-joined, the Uploads query), body, ledger name, read kind
 * and idempotent flag; answers unwrapped; every failure a plain sentence; the market resolved from this business's
 * Marketplace row. The gateway (`amazonSellerFetch`), the account resolver and the publish mode are mocked: nothing
 * leaves the machine.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: { marketplace: { findFirst: vi.fn() } } }))
vi.mock('../../lib/amazon-sp-client.js')
vi.mock('../gateway/amazon-sdk.js', () => ({ amazonSellerFetch: vi.fn() }))
vi.mock('../amazon-publish-gate.service.js')

import prisma from '../../db.js'
import { amazonAccount } from '../../lib/amazon-sp-client.js'
import { amazonSellerFetch } from '../gateway/amazon-sdk.js'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { WorkspaceError } from '../../lib/workspace-context.js'
import {
  AplusError, aplusErrorSentence, aplusLiveState, createContentDocument, createUploadDestination, describeAplusMessages,
  getContentDocument, listAllAsinRelations, listContentDocumentAsinRelations, postContentDocumentApprovalSubmission,
  postContentDocumentAsinRelations, postContentDocumentSuspendSubmission, resolveAplusMarket, searchContentDocuments,
  searchContentPublishRecords, updateContentDocument, validateContentDocumentAsinRelations, type AplusDocument,
} from './aplus-client.js'

const fetchMock = vi.mocked(amazonSellerFetch)
const findMarket = vi.mocked(prisma.marketplace.findFirst) as unknown as ReturnType<typeof vi.fn>
const T = { accountId: 'acct-1', marketplaceId: 'APJ6JRA9NG5V4' }
const DOC: AplusDocument = { name: 'Giacca', contentType: 'EBC', locale: 'it-IT', contentModuleList: [{ contentModuleType: 'STANDARD_TEXT', standardText: { body: { textList: [{ value: 'Testo' }] } } }] }
const METADATA = { name: 'Giacca', marketplaceId: 'APJ6JRA9NG5V4', status: 'APPROVED', badgeSet: ['STANDARD'], updateTime: '2026-10-18T10:00:00Z' }

/** Answer the next gateway calls, in order. */
function answer(...answers: Array<{ status?: number; body?: unknown } | Error>) {
  for (const a of answers) {
    if (a instanceof Error) fetchMock.mockRejectedValueOnce(a)
    else fetchMock.mockResolvedValueOnce(new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status ?? 200 }))
  }
}
/** What the gateway was asked, call by call. */
const sent = () => fetchMock.mock.calls.map(([input]) => input as { accountId?: string; method?: string; path: string; operation?: string; body?: unknown; kind?: string; idempotent?: boolean })
const queryOf = (path: string) => new URLSearchParams(path.split('?')[1] ?? '')
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a failure') }, (error: unknown) => error as AplusError)

beforeEach(() => {
  fetchMock.mockReset()
  findMarket.mockReset()
  vi.mocked(amazonAccount).mockReset()
  vi.mocked(getAmazonPublishMode).mockReset()
})

describe('the A+ operations', () => {
  it('searchContentDocuments: GET with the marketplace and page token; records, next page and warnings', async () => {
    answer({ body: { contentMetadataRecords: [{ contentReferenceKey: 'k1', contentMetadata: METADATA }], nextPageToken: 'next/2=', warnings: [{ code: 'W', message: 'w' }] } })
    const page = await searchContentDocuments(T, 'tok/1+=')
    expect(sent()).toEqual([{ accountId: 'acct-1', method: 'GET', path: '/aplus/2020-11-01/contentDocuments?marketplaceId=APJ6JRA9NG5V4&pageToken=tok%2F1%2B%3D', operation: 'aplus.searchContentDocuments' }])
    expect(page).toEqual({ records: [{ contentReferenceKey: 'k1', contentMetadata: METADATA }], nextPageToken: 'next/2=', warnings: [{ code: 'W', message: 'w' }] })
  })

  it('getContentDocument: includedDataSet is ONE comma-separated value; the key is encoded', async () => {
    answer({ body: { contentRecord: { contentReferenceKey: 'k/1', contentMetadata: METADATA, contentDocument: DOC } } }, { body: { contentRecord: { contentReferenceKey: 'k/1', contentMetadata: METADATA } } })
    const full = await getContentDocument(T, 'k/1')
    const meta = await getContentDocument(T, 'k/1', 'METADATA')
    const [first, second] = sent()
    expect(first).toEqual({ accountId: 'acct-1', method: 'GET', path: '/aplus/2020-11-01/contentDocuments/k%2F1?marketplaceId=APJ6JRA9NG5V4&includedDataSet=CONTENTS,METADATA', operation: 'aplus.getContentDocument' })
    expect(queryOf(first.path).getAll('includedDataSet')).toEqual(['CONTENTS,METADATA'])
    expect(queryOf(second.path).getAll('includedDataSet')).toEqual(['METADATA'])
    expect(full).toEqual({ record: { contentReferenceKey: 'k/1', contentMetadata: METADATA, contentDocument: DOC }, warnings: [] })
    expect(meta.record.contentDocument).toBeNull()
  })

  it('listContentDocumentAsinRelations: METADATA, a comma-joined asinSet and the page token; ASINs with their badges', async () => {
    answer({ body: { asinMetadataSet: [{ asin: 'B000000001', badgeSet: ['CONTENT_PUBLISHED'], parent: 'B000000000', title: 'Giacca', contentReferenceKeySet: ['k1'] }, { asin: 'B000000002' }], nextPageToken: 'p2' } })
    const page = await listContentDocumentAsinRelations(T, 'k1', { metadata: true, asins: ['B000000001', 'B000000002'], pageToken: 'p1' })
    expect(sent()[0].path).toBe('/aplus/2020-11-01/contentDocuments/k1/asins?marketplaceId=APJ6JRA9NG5V4&includedDataSet=METADATA&asinSet=B000000001,B000000002&pageToken=p1')
    expect(sent()[0].operation).toBe('aplus.listContentDocumentAsinRelations')
    expect(page).toEqual({
      asins: [
        { asin: 'B000000001', badgeSet: ['CONTENT_PUBLISHED'], parent: 'B000000000', title: 'Giacca', imageUrl: null, contentReferenceKeySet: ['k1'] },
        { asin: 'B000000002', badgeSet: [], parent: null, title: null, imageUrl: null, contentReferenceKeySet: [] },
      ],
      nextPageToken: 'p2',
      warnings: [],
    })
  })

  it('listAllAsinRelations: follows the pages; complete is false when the page limit stops it', async () => {
    answer({ body: { asinMetadataSet: [{ asin: 'B000000001' }], nextPageToken: 'p2' } }, { body: { asinMetadataSet: [{ asin: 'B000000002' }] } })
    const all = await listAllAsinRelations(T, 'k1', { metadata: true })
    expect(all.asins.map((a) => a.asin)).toEqual(['B000000001', 'B000000002'])
    expect(all.complete).toBe(true)
    expect(queryOf(sent()[1].path).get('pageToken')).toBe('p2')
    fetchMock.mockReset()
    answer({ body: { asinMetadataSet: [{ asin: 'B000000001' }], nextPageToken: 'p2' } })
    expect(await listAllAsinRelations(T, 'k1', { maxPages: 1 })).toMatchObject({ complete: false })
    expect(queryOf(sent()[0].path).has('includedDataSet')).toBe(false)
  })

  it('validateContentDocumentAsinRelations: a POST sent as a read, asinSet in the query; a 200 can carry errors', async () => {
    const errors = [{ code: 'CONTENT_FAILED_VALIDATION', message: "We can't read one of the images that you uploaded.", details: '' }]
    answer({ body: { errors, warnings: [{ code: 'ASIN_FAILED_VALIDATION', message: '', details: 'INVALIDASIN' }] } })
    const check = await validateContentDocumentAsinRelations(T, DOC, ['B000000001', 'B000000002'])
    expect(sent()).toEqual([{ accountId: 'acct-1', method: 'POST', path: '/aplus/2020-11-01/contentAsinValidations?marketplaceId=APJ6JRA9NG5V4&asinSet=B000000001,B000000002', operation: 'aplus.validateContentDocumentAsinRelations', body: { contentDocument: DOC }, kind: 'read' }])
    expect(check).toEqual({ errors: [{ code: 'CONTENT_FAILED_VALIDATION', message: "We can't read one of the images that you uploaded." }], warnings: [{ code: 'ASIN_FAILED_VALIDATION', message: '', details: 'INVALIDASIN' }] })
    answer({ body: { errors: [] } })
    await validateContentDocumentAsinRelations(T, DOC)
    expect(sent()[1].path).toBe('/aplus/2020-11-01/contentAsinValidations?marketplaceId=APJ6JRA9NG5V4')
  })

  it('create (never repeated), update and the ASIN set (idempotent): their paths, bodies and answers', async () => {
    answer({ body: { contentReferenceKey: 'new-key', warnings: [] } }, { body: { contentReferenceKey: 'k1' } }, { body: {} }, { body: {} })
    expect(await createContentDocument(T, DOC)).toEqual({ contentReferenceKey: 'new-key', warnings: [] })
    expect(await updateContentDocument(T, 'k1', DOC)).toEqual({ contentReferenceKey: 'k1', warnings: [] })
    expect(await postContentDocumentAsinRelations(T, 'k1', ['B000000001'])).toEqual({ warnings: [] })
    await postContentDocumentAsinRelations(T, 'k1', [])
    expect(sent()).toEqual([
      { accountId: 'acct-1', method: 'POST', path: '/aplus/2020-11-01/contentDocuments?marketplaceId=APJ6JRA9NG5V4', operation: 'aplus.createContentDocument', body: { contentDocument: DOC }, idempotent: false },
      { accountId: 'acct-1', method: 'POST', path: '/aplus/2020-11-01/contentDocuments/k1?marketplaceId=APJ6JRA9NG5V4', operation: 'aplus.updateContentDocument', body: { contentDocument: DOC }, idempotent: true },
      { accountId: 'acct-1', method: 'POST', path: '/aplus/2020-11-01/contentDocuments/k1/asins?marketplaceId=APJ6JRA9NG5V4', operation: 'aplus.postContentDocumentAsinRelations', body: { asinSet: ['B000000001'] }, idempotent: true },
      { accountId: 'acct-1', method: 'POST', path: '/aplus/2020-11-01/contentDocuments/k1/asins?marketplaceId=APJ6JRA9NG5V4', operation: 'aplus.postContentDocumentAsinRelations', body: { asinSet: [] }, idempotent: true },
    ])
  })

  it('publish records, submit and suspend', async () => {
    answer(
      { body: { publishRecordList: [{ marketplaceId: 'APJ6JRA9NG5V4', locale: 'it_IT', asin: 'B000000001', contentType: 'EBC', contentReferenceKey: 'k1' }], nextPageToken: 'n' } },
      { body: {} }, { body: { warnings: [] } },
    )
    expect(await searchContentPublishRecords(T, 'B000000001')).toEqual({
      records: [{ marketplaceId: 'APJ6JRA9NG5V4', locale: 'it_IT', asin: 'B000000001', contentType: 'EBC', contentSubType: null, contentReferenceKey: 'k1' }],
      nextPageToken: 'n', warnings: [],
    })
    await postContentDocumentApprovalSubmission(T, 'k1')
    await postContentDocumentSuspendSubmission(T, 'k1')
    expect(sent()).toEqual([
      { accountId: 'acct-1', method: 'GET', path: '/aplus/2020-11-01/contentPublishRecords?marketplaceId=APJ6JRA9NG5V4&asin=B000000001', operation: 'aplus.searchContentPublishRecords' },
      { accountId: 'acct-1', method: 'POST', path: '/aplus/2020-11-01/contentDocuments/k1/approvalSubmissions?marketplaceId=APJ6JRA9NG5V4', operation: 'aplus.postContentDocumentApprovalSubmission', idempotent: false },
      { accountId: 'acct-1', method: 'POST', path: '/aplus/2020-11-01/contentDocuments/k1/suspendSubmissions?marketplaceId=APJ6JRA9NG5V4', operation: 'aplus.postContentDocumentSuspendSubmission', idempotent: false },
    ])
  })

  it('createUploadDestination: the Uploads path and query (marketplaceIds, contentMD5, contentType); the payload unwrapped', async () => {
    answer({ status: 201, body: { payload: { uploadDestinationId: 'aplus-media/sc/abc.jpg', url: 'https://aplus-media.s3.amazonaws.com/?key=sc%2Fabc.jpg&policy=P', headers: { 'Content-Type': 'image/jpeg', ignored: 5 } } } })
    const destination = await createUploadDestination(T, { contentMD5: 'rL0Y20zC+Fzt72VPzMSk2A==', contentType: 'image/jpeg' })
    const [call] = sent()
    expect(call).toMatchObject({ accountId: 'acct-1', method: 'POST', operation: 'uploads.createUploadDestinationForResource', idempotent: false })
    expect(call.path.split('?')[0]).toBe('/uploads/2020-11-01/uploadDestinations/aplus/2020-11-01/contentDocuments')
    expect(Object.fromEntries(queryOf(call.path))).toEqual({ marketplaceIds: 'APJ6JRA9NG5V4', contentMD5: 'rL0Y20zC+Fzt72VPzMSk2A==', contentType: 'image/jpeg' })
    expect(destination).toEqual({ uploadDestinationId: 'aplus-media/sc/abc.jpg', url: 'https://aplus-media.s3.amazonaws.com/?key=sc%2Fabc.jpg&policy=P', headers: { 'Content-Type': 'image/jpeg' } })
  })

  it('aplusLiveState: status from METADATA, the ASINs and the ones published on (CONTENT_PUBLISHED)', async () => {
    answer(
      { body: { contentRecord: { contentReferenceKey: 'k1', contentMetadata: { ...METADATA, status: 'SUBMITTED' } } } },
      { body: { asinMetadataSet: [{ asin: 'B000000002', badgeSet: ['CONTENT_NOT_PUBLISHED'] }, { asin: 'B000000001', badgeSet: ['CONTENT_PUBLISHED'] }] } },
    )
    expect(await aplusLiveState(T, 'k1')).toEqual({ status: 'SUBMITTED', updateTime: '2026-10-18T10:00:00Z', asins: ['B000000001', 'B000000002'], publishedAsins: ['B000000001'], complete: true })
    expect(queryOf(sent()[0].path).get('includedDataSet')).toBe('METADATA')
    expect(queryOf(sent()[1].path).get('includedDataSet')).toBe('METADATA')
  })
})

describe('failures, in plain words', () => {
  const amazonError = (status: number, errors: unknown[]) => ({ status, body: { errors } })

  it('400: a field check names the module (from 1) and the field path', async () => {
    answer(amazonError(400, [
      { code: 'InvalidInput', message: 'The request is not valid, please check the inputs and try again.', details: 'Request failed validation: createContentDocument.postContentDocumentRequest.contentDocument.contentModuleList[0].premiumImageText.headline: length must be between 1 and 80' },
      { code: 'InvalidInput', message: 'The request is not valid, please check the inputs and try again.', details: 'Request failed validation: createContentDocument.postContentDocumentRequest.contentDocument.locale: must match "^[a-z]{2,}-[A-Z0-9]{2,}$"' },
    ]))
    const error = await failure(createContentDocument(T, DOC))
    expect(error).toBeInstanceOf(AplusError)
    expect(error).toMatchObject({ code: 'invalid', status: 400, operation: 'aplus.createContentDocument' })
    expect(error.amazon).toHaveLength(2)
    expect(aplusErrorSentence(error)).toBe('Amazon refused it: module 1, premiumImageText.headline: length must be between 1 and 80; locale: must match "^[a-z]{2,}-[A-Z0-9]{2,}$".')
  })

  it('400: a JSON shape error names the property; Brand Story without Brand Registry says so', async () => {
    answer(amazonError(400, [{ code: 'InvalidInput', message: 'The request syntax is malformed and unparseable, please check the inputs and try again.', details: "JSON, line: 1, column: 118, unexpected property name: 'body', expected property names: [description, headline]" }]))
    expect(aplusErrorSentence(await failure(createContentDocument(T, DOC))))
      .toBe("Amazon refused it: JSON, line: 1, column: 118, unexpected property name: 'body', expected property names: [description, headline].")
    answer(amazonError(400, [{ code: 'InvalidInput', message: "User [A1B2C3] shouldn't be using project type: [BrandStory]" }]))
    expect(aplusErrorSentence(await failure(createContentDocument(T, { ...DOC, contentType: 'BrandStory' }))))
      .toBe('Amazon refused it: this seller account cannot make Brand Story content. Brand Story needs the brand enrolled in Amazon Brand Registry.')
  })

  it('403, 404, 429 and 5xx', async () => {
    answer(
      amazonError(403, [{ code: 'Unauthorized', message: 'The A+ content belongs to another marketplace: DE.' }]),
      amazonError(404, [{ code: 'NOT_FOUND', message: 'Not found' }, { code: 'NOT_FOUND', message: 'Not found' }]),
      amazonError(429, [{ code: 'QuotaExceeded', message: 'You exceeded your quota' }]),
      amazonError(503, []),
    )
    const forbidden = await failure(getContentDocument(T, 'k1'))
    expect(forbidden.code).toBe('forbidden')
    expect(aplusErrorSentence(forbidden)).toBe('Amazon refused access (The A+ content belongs to another marketplace: DE). The Nexus Amazon app may lack the Product Listing role, the document may be in another market, or an ASIN is not in your brand.')
    const missing = await failure(getContentDocument(T, 'k1'))
    expect([missing.code, aplusErrorSentence(missing)]).toEqual(['not_found', 'Amazon has no such A+ document in this market.'])
    const busy = await failure(getContentDocument(T, 'k1'))
    expect([busy.code, aplusErrorSentence(busy)]).toEqual(['throttled', 'Amazon is busy (too many A+ requests at once); ask again in a minute.'])
    const down = await failure(getContentDocument(T, 'k1'))
    expect([down.code, down.status, aplusErrorSentence(down)]).toEqual(['unavailable', 503, "Amazon's A+ service did not work just now (HTTP 503); ask again in a few minutes."])
  })

  it('a gateway refusal (a dry run answers 200) is refused, with what was not sent', async () => {
    const dryRun = Object.assign(new Error('Dry run: this aplus.createContentDocument would be sent to Amazon. Nothing was sent.'), { name: 'GatewayRefusal', outcome: 'would_send', code: 'DRY_RUN', statusCode: 200 })
    answer(dryRun)
    const error = await failure(createContentDocument(T, DOC))
    expect(error).toMatchObject({ code: 'refused', status: 200, operation: 'aplus.createContentDocument' })
    expect(aplusErrorSentence(error)).toBe('Dry run: this aplus.createContentDocument would be sent to Amazon. Nothing was sent.')
    answer(Object.assign(new Error('Held, nothing sent: the Amazon account "Xavia" needs to be reconnected (needs_reauth).'), { name: 'GatewayRefusal', outcome: 'held', statusCode: 409 }))
    expect(aplusErrorSentence(await failure(getContentDocument(T, 'k1')))).toBe('Held, nothing sent: the Amazon account "Xavia" needs to be reconnected (needs_reauth).')
  })

  it('no answer: a write may or may not have applied; a read is asked again', async () => {
    const noAnswer = () => Object.assign(new Error('Amazon did not answer (aplus.x): timeout'), { name: 'GatewayNoAnswer', errorClass: 'timeout' })
    answer(noAnswer(), noAnswer())
    const write = await failure(updateContentDocument(T, 'k1', DOC))
    expect([write.code, aplusErrorSentence(write)]).toEqual(['no_answer', 'Amazon did not answer; it may or may not have applied it — read it with aplus-content before asking again.'])
    const read = await failure(getContentDocument(T, 'k1'))
    expect(aplusErrorSentence(read)).toBe('Amazon did not answer; ask again in a minute.')
  })

  it('an account the gateway cannot use is refused; an unreadable 200 is unexpected; other errors are said as Nexus\'s', async () => {
    answer(new WorkspaceError('amazon_account_unavailable', 'Reconnect the selected Amazon seller account.', 409))
    expect(aplusErrorSentence(await failure(getContentDocument(T, 'k1')))).toBe('Reconnect the selected Amazon seller account.')
    answer({ body: { somethingElse: true } })
    const odd = await failure(searchContentDocuments(T))
    expect([odd.code, aplusErrorSentence(odd)]).toEqual(['unexpected', 'Amazon answered aplus.searchContentDocuments in a form Nexus does not read (HTTP 200).'])
    answer({ status: 201, body: { payload: { url: 'https://aplus-media.s3.amazonaws.com/?policy=SECRET' } } })
    const noId = await failure(createUploadDestination(T, { contentMD5: 'x', contentType: 'image/png' }))
    expect(noId.code).toBe('unexpected')
    expect(aplusErrorSentence(noId)).not.toContain('SECRET')
    expect(aplusErrorSentence(new Error('boom'))).toBe('Nexus could not finish the A+ call: boom')
  })

  it('describeAplusMessages words a validation result the same way', () => {
    expect(describeAplusMessages([
      { code: 'InvalidInput', message: 'x', details: 'Request failed validation: validateContentDocumentAsinRelations.postContentDocumentRequest.contentDocument.contentModuleList[2].premiumHotspotImageText.hotSpots[1]: hotspot placement out of bounds' },
      { code: 'CONTENT_FAILED_VALIDATION', message: "We can't read one of the images that you uploaded.", details: '' },
    ])).toBe("module 3, premiumHotspotImageText.hotSpots[1]: hotspot placement out of bounds; We can't read one of the images that you uploaded")
  })
})

describe('resolveAplusMarket', () => {
  const ITALY = { code: 'IT', name: 'Amazon Italy', marketplaceId: 'APJ6JRA9NG5V4', language: 'it', languages: ['it'] }
  const UK = { code: 'UK', name: 'Amazon UK', marketplaceId: 'A1F83G8C2ARO7P', language: 'en', languages: ['en'] }
  const BELGIUM = { code: 'BE', name: 'Amazon Belgium', marketplaceId: 'AMEN7PMS3EDWL', language: 'fr', languages: ['fr', 'nl'] }

  beforeEach(() => {
    vi.mocked(amazonAccount).mockResolvedValue({ id: 'acct-1' } as never)
    vi.mocked(getAmazonPublishMode).mockReturnValue('dry-run')
  })

  it('Italy: the marketplace, the market\'s first language, it-IT, the account and the publish mode', async () => {
    findMarket.mockResolvedValue(ITALY)
    expect(await resolveAplusMarket({ market: ' it ' })).toEqual({ accountId: 'acct-1', marketplaceId: 'APJ6JRA9NG5V4', market: 'IT', marketName: 'Amazon Italy', language: 'it', locale: 'it-IT', publishMode: 'dry-run' })
    expect(findMarket).toHaveBeenCalledWith({ where: { channel: 'AMAZON', code: 'IT' }, select: { code: true, name: true, marketplaceId: true, language: true, languages: true } })
    expect(amazonAccount).toHaveBeenCalledWith({ accountId: undefined })
  })

  it('GB is the UK market, and its locale is en-GB; the account named is the one resolved', async () => {
    findMarket.mockResolvedValue(UK)
    vi.mocked(amazonAccount).mockResolvedValue({ id: 'acct-uk' } as never)
    expect(await resolveAplusMarket({ market: 'GB', accountId: 'acct-uk' })).toMatchObject({ market: 'UK', locale: 'en-GB', accountId: 'acct-uk' })
    expect(findMarket.mock.calls[0][0]).toMatchObject({ where: { channel: 'AMAZON', code: 'UK' } })
    expect(amazonAccount).toHaveBeenCalledWith({ accountId: 'acct-uk' })
  })

  it('a language must be one of the market\'s; any tag form of it is accepted', async () => {
    findMarket.mockResolvedValue(BELGIUM)
    expect(await resolveAplusMarket({ market: 'BE', language: 'NL_be' })).toMatchObject({ language: 'nl', locale: 'nl-BE' })
    expect(await resolveAplusMarket({ market: 'BE' })).toMatchObject({ language: 'fr', locale: 'fr-BE' })
    expect(await resolveAplusMarket({ market: 'BE', language: 'de' })).toEqual({ error: 'Amazon BE content is written in fr or nl; "de" is not one of its languages.' })
    expect(await resolveAplusMarket({ market: 'BE', language: '??' })).toEqual({ error: 'Amazon BE content is written in fr or nl; "??" is not one of its languages.' })
  })

  it('a market this business does not have, or without a marketplace id, is not found; no account is resolved', async () => {
    findMarket.mockResolvedValue(null)
    expect(await resolveAplusMarket({ market: 'DE' })).toEqual({ error: 'The Amazon market DE is not found in this business (business-overview lists its markets).' })
    findMarket.mockResolvedValue({ ...ITALY, marketplaceId: null })
    expect(await resolveAplusMarket({ market: 'IT' })).toEqual({ error: 'The Amazon market IT is not found in this business (business-overview lists its markets).' })
    expect(amazonAccount).not.toHaveBeenCalled()
  })

  it('no Amazon account in this business is not found, with the resolver\'s reason', async () => {
    findMarket.mockResolvedValue(ITALY)
    vi.mocked(amazonAccount).mockRejectedValue(new WorkspaceError('amazon_account_unavailable', 'Connect an Amazon seller account in Channels before using Amazon.', 409))
    expect(await resolveAplusMarket({ market: 'IT' })).toEqual({ error: 'Amazon account not found for this business: Connect an Amazon seller account in Channels before using Amazon.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
