import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { useAbuseGuard } from '../abuse/guard'
import { usePortalOptions } from '../auth/portal/service'
import { freshGuard } from '../auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../auth/sessions/testing/harness'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../search/partner/testing/world'
import { ensureThread, writeMessage } from './threads'

/**
 * B-TH-079 (threads plan TH-6, N3, thread-G06, thread-G09, thread-G10; T1-F05, T3-F14, T3-F15, T4-F10; wall test T08 / W08, W34;
 * the Owner's rule 2026-11-16: "One brand must not be able to see anything related to any other brand"): the feed tells everything.
 *
 *   the audience view   timeline ?audience=PARTNER the shared messages only, OFFICE the office notes only; "hiddenNew" counts the
 *                       messages new to the reader that the view hides; a portal reader asking OFFICE gets none, asking ALL only the
 *                       shared ones — the view never widens a brand's view (T08)
 *   erased              a message erased after a privacy request says so (office, the portal's thread, a portal reader of the record
 *                       thread); a mail that only carries files (its text empty too) never reads as erased
 *   waiting mail        a mail for the conversation HELD for a person is counted on the office's read, with why and whether the reader
 *                       may review it (email.triage); the portal is never told
 *   skipped files       an inbound mail's files not kept are listed on its message for the office, the signature logo never
 *
 * Base seeds in one namespace (two brands included), real portal sign-ins, office sessions by the test authenticator; test rows past
 * the guards in replica mode on the admin connection. Run with `node scripts/factory/run-pg-tests.mjs platform/threads`.
 */

let h: Harness
let world: PartnerWorld
let app: FastifyInstance
let alpha: Browser
let beta: Browser
const NS = 'th079feed'
const reader = { triage: newId(), plain: newId() }
const ids = { order: '', note: '', mail: '', filesOnly: '', erased: '', file: '' }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const sessions = (): Record<string, SessionContext> => ({
  triage: { audience: 'office', tenantId: world.tenantId, actorId: reader.triage, grants: [{ permissions: ['threads.read', 'email.triage', 'files.read'], companies: 'all', sites: 'all', parties: 'all' }] },
  plain: { audience: 'office', tenantId: world.tenantId, actorId: reader.plain, grants: [{ permissions: ['threads.read', 'files.read'], companies: 'all', sites: 'all', parties: 'all' }] },
})
const asOffice = async (who: keyof typeof reader, url: string) => {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': who } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Json
}

/** An AVAILABLE file of the order, shared with P1, written straight into the table. */
async function sharedFile(recordId: string): Promise<string> {
  const id = newId()
  const store = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [world.tenantId]))[0]!.id
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256,
       "storeAccountId", "storageKey", status, visibility, "partyId", "availableAt")
     VALUES ($1, $2, $3, 'SalesOrder', $4, 'DOCUMENT', 'Made-up size chart.pdf', 'application/pdf', 100, $5, $6, $7, 'AVAILABLE', '{OFFICE,PARTNER}'::"FileAudience"[], $8, now())`,
    [id, world.tenantId, world.companyA, recordId, createHash('sha256').update(id).digest('hex'), store, `t/${world.tenantId}/c/${world.companyA}/2026/${newId()}`, world.p1],
  )
  return id
}

/** Test data past the guards (replica mode, the one admin connection). */
async function pastGuards(work: () => Promise<void>): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await work()
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}

/** A copy of a seeded received mail, naming this thread (and a message), with its status and attachments. */
async function mailFor(threadId: string, changes: { status: string; heldReason: string | null; messageId: string | null; attachments: unknown[] }): Promise<void> {
  const [source] = await admin<{ id: string }>(`SELECT id FROM "InboundEmail" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [world.tenantId])
  expect(source, 'a seeded received mail').toBeTruthy()
  await pastGuards(async () => {
    await admin(`CREATE TEMP TABLE _mail AS SELECT * FROM "InboundEmail" WHERE id = $1`, [source!.id])
    try {
      await admin(
        `UPDATE _mail SET id = $1, "sesMessageId" = $2, "emailMessageId" = NULL, "threadId" = $3, "messageId" = $4, status = $5::"InboundEmailStatus",
           "heldReason" = $6::"InboundHeldReason", attachments = $7::jsonb, "matchedBy" = NULL, "senderPartyId" = NULL, "senderContactId" = NULL`,
        [newId(), `th079-${newId()}`, threadId, changes.messageId, changes.status, changes.heldReason, JSON.stringify(changes.attachments)],
      )
      await admin(`INSERT INTO "InboundEmail" SELECT * FROM _mail`)
    } finally {
      await admin('DROP TABLE IF EXISTS _mail')
    }
  })
}

beforeAll(async () => {
  h = await startHarness('feed_depth_th079')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  const brandB = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [world.tenantId]))[0]!.id
  const buyerB = (await admin<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [world.tenantId, brandB]))[0]!
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } }))
  for (const [key, id] of Object.entries(reader)) await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [id, world.tenantId, `th079-${key}@example.com`, `Made-up ${key}`])
  ids.order = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001' AND "partyId" = $2`, [world.tenantId, world.p1]))[0]!.id
  ids.file = await sharedFile(ids.order)
  // The thread: an office note, our mail, the customer's mail of a file only (no words, an unknown sender), a mail later erased.
  const office = callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: world.officeId, grants: [], requestId: newId() })
  const { result } = await command(office, { name: 'email.send', input: { order: ids.order } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: ids.order }, world.officeId)
    const by = { kind: 'USER' as const, id: world.officeId, name: 'Seed Owner' }
    const note = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: by, bodyText: 'Internal: their credit is tight, keep it here.' })
    const mail = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: by, bodyText: 'Made-up: your order ships next week.' })
    const filesOnly = await writeMessage(tools, thread, { direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', id: null, name: null }, bodyText: '', attachments: [ids.file] })
    const erased = await writeMessage(tools, thread, { direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', id: null, name: 'Made-up Rider' }, bodyText: 'Made-up: my home address is …' })
    return { threadId: thread.id, note: note.id, mail: mail.id, filesOnly: filesOnly.id, erased: erased.id }
  })
  Object.assign(ids, { note: result.note, mail: result.mail, filesOnly: result.filesOnly, erased: result.erased })
  // The rider's message erased after a privacy request (the erasure's door blanks the name and the words; its record names it).
  await pastGuards(async () => {
    await admin(`UPDATE "Message" SET "authorName" = NULL, "bodyText" = '', "bodyHtml" = NULL WHERE id = $1`, [ids.erased])
    await admin(
      `INSERT INTO "ErasureRecord" (id, "tenantId", "companyId", "sweepId", "recordType", "recordId", method, "erasedFields", "keptFields", "erasedAt")
       VALUES ($1, $2, $3, $4, 'Message', $5, 'ANONYMISED', '{authorName,bodyText,bodyHtml}', '{}', now())`,
      [newId(), world.tenantId, world.companyA, newId(), ids.erased],
    )
  })
  // The customer's mail of a file only: one part not kept (a type files do not take), one signature logo (never listed).
  await mailFor(result.threadId, {
    status: 'MATCHED',
    heldReason: null,
    messageId: ids.filesOnly,
    attachments: [
      { kept: false, name: 'logo.ai', contentType: 'application/postscript', sizeBytes: 2048, reason: 'type_not_allowed' },
      { kept: false, name: 'signature.png', contentType: 'image/png', sizeBytes: 900, reason: 'inline' },
    ],
  })
  // A mail for the same conversation held for a person: its sender is not a contact of the customer.
  await mailFor(result.threadId, { status: 'HELD', heldReason: 'UNKNOWN_SENDER', messageId: null, attachments: [] })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions()[String(request.headers['x-test-session'])] ?? null) },
  )
  alpha = await signIn(h, world, world.people.buyer)
  beta = await signIn(h, world, { id: buyerB.id, email: buyerB.email, name: buyerB.displayName } satisfies Person)
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
})

const messageIds = (entries: Json[]): string[] => entries.filter((entry) => entry.kind === undefined || entry.kind === 'message').map((entry) => entry.id)

describe('B-TH-079: the audience view of the office’s feed', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('With the customer: the shared messages only, and the office note new to the reader is counted as hidden', async () => {
    const answer = await asOffice('plain', `/threads/SalesOrder/${ids.order}/timeline?kinds=message&audience=PARTNER`)
    expect(messageIds(answer.entries)).toEqual(expect.arrayContaining([ids.mail, ids.filesOnly, ids.erased]))
    expect(messageIds(answer.entries)).not.toContain(ids.note)
    expect(answer.hiddenNew).toBe(1)
  })

  it('Office notes: the note only, the three shared messages hidden; All hides nothing', async () => {
    const notes = await asOffice('plain', `/threads/SalesOrder/${ids.order}/timeline?kinds=message&audience=OFFICE`)
    expect(messageIds(notes.entries)).toEqual([ids.note])
    expect(notes.hiddenNew).toBe(3)
    const all = await asOffice('plain', `/threads/SalesOrder/${ids.order}/timeline?kinds=message`)
    expect(messageIds(all.entries)).toEqual(expect.arrayContaining([ids.note, ids.mail, ids.filesOnly, ids.erased]))
    expect(all.hiddenNew).toBe(0)
    const thread = await asOffice('plain', `/threads/SalesOrder/${ids.order}?audience=OFFICE`)
    expect(thread.messages.map((message: Json) => message.id)).toEqual([ids.note])
  })
})

describe('B-TH-079: erased messages, skipped files and waiting mail on the office’s read', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the erased message says so; the mail of a file only (empty text too) does not; the logo’s part is not listed', async () => {
    const thread = await asOffice('triage', `/threads/SalesOrder/${ids.order}`)
    const byId = new Map<string, Json>(thread.messages.map((message: Json) => [message.id, message]))
    expect(byId.get(ids.erased)?.erased).toBe(true)
    expect(byId.get(ids.filesOnly)?.erased).toBeUndefined()
    expect(byId.get(ids.filesOnly)?.attachments.map((file: Json) => file.id)).toEqual([ids.file])
    expect(byId.get(ids.filesOnly)?.skippedAttachments).toEqual([{ name: 'logo.ai', contentType: 'application/postscript', sizeBytes: 2048, reason: 'type_not_allowed' }])
    const timeline = await asOffice('triage', `/threads/SalesOrder/${ids.order}/timeline?kinds=message`)
    const entries = new Map<string, Json>(timeline.entries.map((entry: Json) => [entry.id, entry]))
    expect(entries.get(ids.erased)).toMatchObject({ erased: true })
    expect(entries.get(ids.filesOnly)).toMatchObject({ erased: false, attachmentCount: 1 })
    expect(entries.get(ids.filesOnly)?.skippedAttachments.map((part: Json) => part.name)).toEqual(['logo.ai'])
  })

  it('a mail held for a person is counted with why; Review only for a reader with email.triage', async () => {
    expect((await asOffice('triage', `/threads/SalesOrder/${ids.order}`)).waitingMail).toEqual({ count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: true })
    expect((await asOffice('plain', `/threads/SalesOrder/${ids.order}`)).waitingMail).toEqual({ count: 1, reasons: ['UNKNOWN_SENDER'], mayReview: false })
    expect((await asOffice('plain', `/threads/SalesOrder/${ids.order}/timeline`)).waitingMail).toMatchObject({ count: 1 })
  })
})

describe('T08: the view never widens a brand’s view; held mail and skipped files are office only', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('brand A asking for the office notes gets none; asking for all gets the shared messages only, the erased one said so', async () => {
    const notes = await alpha.get(`/threads/SalesOrder/${ids.order}?audience=OFFICE`)
    expect(notes.status, JSON.stringify(notes.body)).toBe(200)
    expect(notes.body.messages).toEqual([])
    const all = await alpha.get(`/threads/SalesOrder/${ids.order}?audience=ALL`)
    expect(all.status, JSON.stringify(all.body)).toBe(200)
    const seen = all.body.messages.map((message: Json) => message.id)
    expect(seen).toEqual(expect.arrayContaining([ids.mail, ids.filesOnly, ids.erased]))
    expect(seen).not.toContain(ids.note)
    expect(all.body.messages.find((message: Json) => message.id === ids.erased)?.erased).toBe(true)
    const text = JSON.stringify(all.body)
    expect(text).not.toMatch(/waitingMail|skippedAttachments|logo\.ai|Internal: their credit/)
    // The portal's own thread page tells the erased message too, and nothing of the office.
    const portal = await alpha.get(`/portal/threads/SalesOrder/${ids.order}`)
    expect(portal.status, JSON.stringify(portal.body)).toBe(200)
    expect(portal.body.messages.find((message: Json) => message.id === ids.erased)?.erased).toBe(true)
    expect(JSON.stringify(portal.body)).not.toMatch(/waitingMail|skippedAttachments|logo\.ai|Internal: their credit/)
  })

  it('brand B reads nothing of brand A’s thread, whatever view it asks', async () => {
    for (const audience of ['ALL', 'PARTNER', 'OFFICE']) {
      const answer = await beta.get(`/threads/SalesOrder/${ids.order}?audience=${audience}`)
      expect([200, 404], JSON.stringify(answer.body)).toContain(answer.status)
      if (answer.status === 200) {
        expect(answer.body.thread).toBeNull()
        expect(answer.body.messages).toEqual([])
      }
      expect(JSON.stringify(answer.body)).not.toMatch(/Made-up: your order ships|SEED-SO-0001/)
    }
  })
})
