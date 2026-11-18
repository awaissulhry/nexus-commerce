import type { FastifyInstance } from 'fastify'
import { newId } from '@nexus/factory-domain/core/ids'
import { freshGuard, portalBrowser } from '../../../platform/auth/portal/testing/portal'
import type { Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * fix-pr-8 (B-PR-10, the brand wall; Owner rule 2026-11-16: "One brand must not be able to see anything related to any other
 * brand. But we, as the production unit, should be able to see it all. And manage it all as well."): THE TRACES A CUSTOMER
 * LEAVES BESIDE ITS RECORDS, as the golden production world holds them. fix-pr-7 found two leaks (the mail log, the stock card)
 * only there: its customer's portal people sign in (their sign-in mails) and its orders are mailed, which the seeds alone never
 * make. `customerTraces` makes them in a world of every seed the way the golden world's people do, through the portal's and the
 * office's own routes on the shared harness (platform/auth/sessions/testing/harness.ts, the golden world's base):
 *
 *   - each ACTIVE portal person of the customer asks for a sign-in code (the portal's own sign-in mail, in the mail log);
 *   - an office person writes to the customer's first contact from its order's thread (the order mail and its message);
 *
 * and counts what the world then holds of the customer — portal people, mails, stock moves of its work orders, files and
 * threads — so a test shows each kind is there for the sweep to find. Every name and address is made up (example.com).
 */
export interface CustomerTraces {
  readonly portalPeople: number
  readonly mails: number
  readonly stockMoves: number
  readonly files: number
  readonly threads: number
}

export async function customerTraces(t: {
  readonly h: Harness
  /** The app whose test authenticator knows `session`. */
  readonly app: FastifyInstance
  /** The tenant's slug and the code of the customer's company (the portal's sign-in names both). */
  readonly tenant: string
  readonly companyCode: string
  /** An office test session of a REAL person who reaches the customer (a mail names its sender). */
  readonly session: string
  readonly partyId: string
  readonly salesOrderId: string
}): Promise<CustomerTraces> {
  const admin = async <R>(sql: string, values: unknown[] = []): Promise<R[]> => (await t.h.db.admin.query(sql, values)).rows as R[]
  // The portal's sign-in: its abuse guard on the harness clock, then one code asked per person (the mail goes after the answer).
  freshGuard(t.h)
  const people = await admin<{ email: string }>(`SELECT email FROM "User" WHERE "partyId" = $1 AND status = 'ACTIVE' ORDER BY email`, [t.partyId])
  for (const { email } of people) {
    const browser = await portalBrowser(t.h)
    const answer = await browser.post('/portal/signin/start', { tenant: t.tenant, company: t.companyCode, email })
    if (answer.status !== 200) throw new Error(`the sign-in of ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
    await t.h.auth.settled()
  }
  // The order mail: from the order's thread to the customer's first contact.
  const contact = (await admin<{ email: string }>(`SELECT email FROM "PartyContact" WHERE "partyId" = $1 AND email IS NOT NULL ORDER BY email LIMIT 1`, [t.partyId]))[0]
  if (!contact) throw new Error('the customer has no contact with an address')
  const mail = await t.app.inject({
    method: 'POST',
    url: `/threads/SalesOrder/${t.salesOrderId}/emails`,
    headers: { 'x-test-session': t.session, 'idempotency-key': newId() },
    payload: { to: [contact.email], subject: 'Made-up: your order', body: 'Made-up: your order is planned; the cut starts next week.' },
  })
  if (mail.statusCode !== 201) throw new Error(`the order mail: ${mail.statusCode} ${mail.body.slice(0, 600)}`)

  const count = async (sql: string): Promise<number> => Number((await admin<{ n: string }>(sql, [t.partyId]))[0]!.n)
  return {
    portalPeople: await count(`SELECT count(*) AS n FROM "User" WHERE "partyId" = $1`),
    mails: await count(
      `SELECT count(*) AS n FROM "EmailOutbound" WHERE ("recordType" = 'User' AND "recordId" IN (SELECT id FROM "User" WHERE "partyId" = $1))
       OR ("recordType" = 'SalesOrder' AND "recordId" IN (SELECT id FROM "SalesOrder" WHERE "partyId" = $1))`,
    ),
    stockMoves: await count(`SELECT count(*) AS n FROM "StockMove" m JOIN "WorkOrder" o ON o.id = m."workOrderId" WHERE o."partyId" = $1`),
    files: await count(`SELECT count(*) AS n FROM "StoredFile" WHERE "partyId" = $1`),
    threads: await count(`SELECT count(*) AS n FROM "Thread" WHERE "partyId" = $1`),
  }
}
