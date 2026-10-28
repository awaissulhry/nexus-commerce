import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../lib/api/client'
import { listFiles, postNote, requestUpload, sendEmail, setThreadStatus } from './api'
import { parseLiveData } from './live'
import { sendNotice } from './RecordPanels'
import { apiErrorFrom } from '../lib/api/errors'
import { putToStore, sha256Hex, storeHeaders, storeUrl, StoreError } from './store'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(answer: () => Response) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => answer())
  const api = createApiClient({ baseUrl: '/api', fetch: fetch as unknown as typeof globalThis.fetch, company: 'DEMO', csrfToken: () => 'csrf-1' })
  const sent = (index = 0) => {
    const [url, init] = fetch.mock.calls[index]!
    const headers = new Headers(init.headers)
    return { url, method: init.method, headers, body: init.body ? JSON.parse(String(init.body)) : undefined }
  }
  return { api, fetch, sent }
}

const RECORD = { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000001' }
const FILE = {
  id: 'f1',
  companyId: 'c1',
  recordType: 'Certificate',
  recordId: RECORD.id,
  kind: 'CERTIFICATE',
  originalName: 'a.pdf',
  contentType: 'application/pdf',
  sizeBytes: 10,
  sha256: '0'.repeat(64),
  status: 'PENDING_UPLOAD',
  visibility: ['OFFICE'],
  retainUntil: null,
  quarantineReason: null,
  availableAt: null,
  deletedAt: null,
  version: 1,
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T10:00:00.000Z',
}

describe('the record panels call the API through its one client', () => {
  it('writes an internal note with its mentions and files, the CSRF token, the company and an idempotency key', async () => {
    const { api, sent } = client(() => json(201, {}))
    await postNote(api, RECORD, { body: 'Check the batch', mentions: ['u1'], attachments: ['f1'] })
    const call = sent()
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`/api/threads/Certificate/${RECORD.id}/notes`)
    expect(call.body).toEqual({ body: 'Check the batch', mentions: ['u1'], attachments: ['f1'] })
    expect(call.headers.get('x-csrf-token')).toBe('csrf-1')
    expect(call.headers.get('x-factory-company')).toBe('DEMO')
    expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('sends a mail to the party from the thread; an empty subject is left to the API', async () => {
    const { api, sent } = client(() => json(201, {}))
    await sendEmail(api, RECORD, { to: ['buyer@example.com'], subject: undefined, body: 'Hello', attachments: [] })
    expect(sent().url).toBe(`/api/threads/Certificate/${RECORD.id}/emails`)
    expect(sent().body).toEqual({ to: ['buyer@example.com'], body: 'Hello', attachments: [] })
  })

  it('closes a thread with the version it read (COL-078)', async () => {
    const { api, sent } = client(() => json(200, {}))
    await setThreadStatus(api, RECORD, 'CLOSED', 4)
    expect(sent().method).toBe('PUT')
    expect(sent().body).toEqual({ status: 'CLOSED', version: 4 })
  })

  it('announces an upload with its audience: the floor names the site, a party audience names the party', async () => {
    const answer = () => json(201, { file: FILE, upload: { method: 'PUT', url: '/local-files?token=t', headers: { 'content-type': 'application/pdf' }, expiresAt: '2026-10-28T10:05:00.000Z' } })
    const announce = { companyId: 'c1', record: RECORD, kind: 'CERTIFICATE' as const, name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), floorSiteId: 's1', partyId: 'p1' }
    const office = client(answer)
    await requestUpload(office.api, { ...announce, visibility: ['OFFICE'] })
    expect(office.sent().body).toEqual({ companyId: 'c1', recordType: 'Certificate', recordId: RECORD.id, kind: 'CERTIFICATE', originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64), visibility: ['OFFICE'] })
    const shared = client(answer)
    await requestUpload(shared.api, { ...announce, visibility: ['OFFICE', 'FLOOR', 'PARTNER'] })
    expect(shared.sent().body).toMatchObject({ visibility: ['OFFICE', 'FLOOR', 'PARTNER'], floorSiteId: 's1', partyId: 'p1' })
  })

  it('reads a record\'s files, and refuses an answer it does not understand', async () => {
    const { api, sent } = client(() => json(200, { files: [{ ...FILE, status: 'AVAILABLE' }] }))
    expect((await listFiles(api, RECORD)).files[0]?.status).toBe('AVAILABLE')
    expect(sent().url).toBe(`/api/files?recordType=Certificate&recordId=${RECORD.id}`)
    await expect(listFiles(client(() => json(200, { files: [{ ...FILE, status: 'GONE' }] })).api, RECORD)).rejects.toMatchObject({ kind: 'contract' })
  })
})

describe('the file bytes go straight to the store', () => {
  it('reaches the local store through this app, R2 at its own https address, and nothing else', () => {
    expect(storeUrl('/local-files?token=abc')).toBe('/api/local-files?token=abc')
    expect(storeUrl('https://bucket.r2.example.com/key?X-Amz=1')).toBe('https://bucket.r2.example.com/key?X-Amz=1')
    expect(storeUrl('http://127.0.0.1:8190/local-files?token=a')).toBe('http://127.0.0.1:8190/local-files?token=a')
    expect(() => storeUrl('http://elsewhere.example.com/x')).toThrow()
    expect(() => storeUrl('//elsewhere.example.com/x')).toThrow()
    expect(() => storeUrl('javascript:alert(1)')).toThrow()
  })

  it('sends only the signed headers, and says when the store refused', async () => {
    expect([...storeHeaders({ headers: { 'content-type': 'application/pdf', 'content-length': '10', 'x-amz-checksum-sha256': 'abc' } }).keys()].sort()).toEqual(['content-type', 'x-amz-checksum-sha256'])
    const fetch = vi.fn(async () => new Response(null, { status: 200 }))
    await putToStore({ method: 'PUT', url: '/local-files?token=t', headers: { 'content-type': 'application/pdf' }, expiresAt: '' }, new Blob(['x']), fetch as unknown as typeof globalThis.fetch)
    expect(fetch).toHaveBeenCalledWith('/api/local-files?token=t', expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }))
    const refused = vi.fn(async () => new Response(null, { status: 403 }))
    await expect(putToStore({ method: 'PUT', url: 'https://r2.example.com/k', headers: {}, expiresAt: '' }, new Blob(['x']), refused as unknown as typeof globalThis.fetch)).rejects.toBeInstanceOf(StoreError)
    expect(refused).toHaveBeenCalledWith('https://r2.example.com/k', expect.objectContaining({ credentials: 'omit' }))
  })

  it('hashes the bytes as the store checks them (SHA-256, lower-case hex)', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('a refused mail says what was refused, in the panel\'s words', () => {
  const refusal = (status: number, code: string, paths: string[] = []) => apiErrorFrom(status, { error: { code, message: 'english', issues: paths.map((path) => ({ path, message: 'english' })) } })
  it('names the missing sending address, a refused recipient, a missing subject, a file that cannot go', () => {
    expect(sendNotice(refusal(400, 'validation_failed', ['body/identityId'])).key).toBe('notice.noSender')
    expect(sendNotice(refusal(400, 'validation_failed', ['body/to/1'])).key).toBe('notice.badRecipient')
    expect(sendNotice(refusal(400, 'validation_failed', ['body/subject'])).key).toBe('notice.noSubject')
    expect(sendNotice(refusal(400, 'validation_failed', ['body/attachments/0'])).key).toBe('notice.attachmentsRefused')
    expect(sendNotice(refusal(400, 'validation_failed', ['body/mentions/0'])).key).toBe('notice.mentionsRefused')
    expect(sendNotice(refusal(400, 'validation_failed', ['body/other'])).key).toBe('notice.invalid')
    expect(sendNotice(refusal(409, 'invalid_state')).key).toBe('notice.sendConflict')
    expect(sendNotice(refusal(403, 'forbidden')).key).toBe('notice.forbidden')
  })
})

describe('the live stream', () => {
  it('reads a change message and drops anything else', () => {
    expect(parseLiveData('{"type":"file.available","fields":{"recordType":"Certificate","recordId":"r1"},"companyId":"c1"}')).toEqual({ type: 'file.available', fields: { recordType: 'Certificate', recordId: 'r1' } })
    expect(parseLiveData('not json')).toBeNull()
    expect(parseLiveData('{"fields":{}}')).toBeNull()
    expect(parseLiveData('{"type":"x"}')).toEqual({ type: 'x', fields: {} })
  })
})
