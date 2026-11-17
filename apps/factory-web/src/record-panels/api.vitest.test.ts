import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../lib/api/client'
import { listFiles, messageSchema, postNote, requestUpload, setThreadStatus, timelineEntrySchema } from './api'
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
    await postNote(api, RECORD, { body: 'For the floor', mentions: [], attachments: [], forFloor: false })
    expect(sent(1).body).toEqual({ body: 'For the floor', mentions: [], attachments: [] })
    await postNote(api, RECORD, { body: 'For the floor', mentions: [], attachments: [], forFloor: true })
    expect(sent(2).body).toEqual({ body: 'For the floor', mentions: [], attachments: [], forFloor: true })
    expect(call.headers.get('x-csrf-token')).toBe('csrf-1')
    expect(call.headers.get('x-factory-company')).toBe('DEMO')
    expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
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

describe('the thread answer (B-W2b-F4)', () => {
  const note = { id: 'm1', direction: 'INTERNAL_NOTE', audience: 'OFFICE', channel: 'APP', body: 'x', bodyHtml: null, attachments: [], at: '2026-10-28T10:00:00.000Z' }

  it('takes a floor note the legal gate keeps back: no id, no name, and the message says so', () => {
    expect(messageSchema.parse({ ...note, author: { kind: 'WORKER', id: null, name: null }, authorHidden: true })).toMatchObject({ author: { kind: 'WORKER', id: null, name: null }, authorHidden: true })
  })

  it('a portal answer carries no flag: nobody is hidden', () => {
    expect(messageSchema.parse({ ...note, author: { kind: 'USER', name: null } }).authorHidden).toBe(false)
  })
})

describe('the timeline answer (B-W2b-F4)', () => {
  const change = { kind: 'change', id: 'c1', at: '2026-10-28T10:00:00.000Z', action: 'production.cut', status: null, fields: [], before: null, after: null, reason: null }

  it('takes a floor worker the legal gate keeps back: no id, and the row says so', () => {
    expect(timelineEntrySchema.parse({ ...change, actor: { audience: 'FLOOR', id: null }, actorHidden: true })).toMatchObject({ actor: { audience: 'FLOOR', id: null }, actorHidden: true })
    expect(
      timelineEntrySchema.parse({ kind: 'message', id: 'm1', at: change.at, direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'WORKER', id: null, name: null }, authorHidden: true, excerpt: 'x', attachmentCount: 0 }),
    ).toMatchObject({ author: { kind: 'WORKER', id: null, name: null }, authorHidden: true })
  })

  it('an office user stays as the API sent them', () => {
    expect(timelineEntrySchema.parse({ ...change, actor: { audience: 'OFFICE', id: 'u1' }, actorHidden: false })).toMatchObject({ actor: { audience: 'OFFICE', id: 'u1' }, actorHidden: false })
  })
})
