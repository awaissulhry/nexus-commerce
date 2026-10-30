import { describe, expect, it } from 'vitest'
import { errorReportOf, isSensitiveKey, scrubContext, scrubPath, scrubText, type ReportContext } from './report'

/**
 * The redaction filter of error reports (PLT-218): no personal data, no secret and no money reaches a sink. Every value
 * below is made up.
 */

/** A made-up macOS home folder (written in parts: no real path in the repository). */
const HOME = ['', 'Users', 'someone'].join('/')
const report = (error: unknown, context?: ReportContext) => errorReportOf(error, { id: 'r1', at: '2026-10-30T10:00:00.000Z', source: 'api', ...(context ? { context } : {}) })
const everything = (value: unknown) => JSON.stringify(value)

describe('scrubText: personal data', () => {
  it.each([
    ['an e-mail', 'Unique failed for mario.rossi@example.com', 'mario.rossi@example.com'],
    ['an IBAN with spaces', 'Bank IT60 X054 2811 1010 0000 0123 456 refused', 'X054'],
    ['an IBAN', 'IBAN IT60X0542811101000000123456 refused', 'IT60X0542811101000000123456'],
    ['a codice fiscale', 'Fiscal code RSSMRA85T10A562S is not valid', 'RSSMRA85T10A562S'],
    ['a VAT number', 'VAT IT12345678901 is not valid', 'IT12345678901'],
    ['a phone number', 'Call +39 333 123 4567 now', '333 123 4567'],
    ['a user id', 'User 0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b has no role', '0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b'],
    ['a name in quotes', 'Invalid value "Mario Rossi" for the field', 'Mario Rossi'],
    ['a name under a name key', 'data: { displayName: Mario, city: Milano }', 'Mario'],
    ['a value in a database detail', 'Key ("email")=(anna@example.com) already exists', 'anna@example.com'],
    ['a value in a database detail without @', 'Key ("tenantId", "employeeCode")=(x, 00042) already exists', '00042'],
    ['a home folder', `at run (${HOME}/work/apps/factory-api/src/core/app.ts:10:5)`, 'someone'],
    ['a home folder outside the repository', 'ENOENT: open /home/someone/.config/file', 'someone'],
  ])('takes out %s', (_what, text, secret) => {
    const out = scrubText(text)
    expect(out).not.toContain(secret)
  })

  it('keeps what finds the bug: the error words, code-like names, the file inside the repository and its line', () => {
    expect(scrubText("Cannot read properties of undefined (reading 'version')")).toBe("Cannot read properties of undefined (reading 'version')")
    expect(scrubText('Invalid `prisma.device.update()` invocation')).toBe('Invalid `prisma.device.update()` invocation')
    expect(scrubText(`at run (${HOME}/work/apps/factory-api/src/core/app.ts:10:5)`)).toBe('at run (…/apps/factory-api/src/core/app.ts:10:5)')
    expect(scrubText('connect ECONNREFUSED 127.0.0.1:3310')).toBe('connect ECONNREFUSED 127.0.0.1:3310')
    expect(scrubText('Timed out at 2026-10-30T10:00:00.000Z')).toContain('2026-10-30')
  })
})

describe('scrubText: secrets', () => {
  it.each([
    ['a password', 'login failed: password=hunter2-made-up', 'hunter2-made-up'],
    ['a PIN', '{"pin": "482913"}', '482913'],
    ['a bearer token', 'Authorization: Bearer abc.def.ghi-made-up', 'abc.def.ghi-made-up'],
    ['a cookie header', 'cookie: __Host-factory_floor=s3cr3t-made-up; path=/', 's3cr3t-made-up'],
    ['a JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLW1hZGUtdXA was refused', 'eyJzdWIiOiJ4In0'],
    ['a floor device token', 'bad 0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b.0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0c.0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0d.QmFkU2VjcmV0TWFkZVVw', 'QmFkU2VjcmV0TWFkZVVw'],
    ['a SHA-256', 'hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 differs', '9f86d081884c7d659a2feaa0c55ad015'],
    ['a base64 key', 'key material Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRmdoaWprbG1ub3A= leaked', 'Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRmdoaWprbG1ub3A'],
    ['a query string', 'GET https://factory.example.com/l/abc?token=made-up-token-1 failed', 'made-up-token-1'],
    ['a link path token', 'fetch /local-files?token=made-up-token-2 failed', 'made-up-token-2'],
    ['an enrolment code', 'enrolment code: ABCD-1234 refused', 'ABCD-1234'],
  ])('takes out %s', (_what, text, secret) => {
    expect(scrubText(text)).not.toContain(secret)
  })
})

describe('scrubText: money', () => {
  it.each([
    ['euros with the sign', 'Total € 1.234,56 over the limit', '1.234,56'],
    ['euros with the code', 'Over 12.50 EUR', '12.50'],
    ['a price key', 'data: { unitPrice: new Prisma.Decimal("12.5"), quantity: 3 }', '12.5'],
    ['a cost key', '{"standardCost":"8.20"}', '8.20'],
    ['a margin key', 'margin=0.31 refused', '0.31'],
    ['a wage key', 'hourlyWage: 14.75', '14.75'],
  ])('takes out %s', (_what, text, secret) => {
    expect(scrubText(text)).not.toContain(secret)
  })
})

describe('scrubContext and scrubPath', () => {
  it('keeps only the allow-listed keys, numbers only as a status or an attempt', () => {
    const context = scrubContext({
      route: '/files/:fileId/complete',
      method: 'POST',
      statusCode: 500,
      requestId: 'req-1',
      tenantId: '0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b',
      audience: 'office',
      attempt: 3,
      ...({ actorId: '0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0c', email: 'a@example.com', price: 12, userAgent: 'x' } as object),
    })
    expect(context).toEqual({ route: '/files/:fileId/complete', method: 'POST', statusCode: 500, requestId: 'req-1', tenantId: '0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b', audience: 'office', attempt: 3 })
  })

  it('replaces the ids and numbers of a page path and drops its query and fragment', () => {
    expect(scrubPath('/w/0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0b/sales/orders/0198a3f2-1c2d-7e3f-8a4b-5c6d7e8f9a0c?tab=lines#x')).toBe('/w/:id/sales/orders/:id')
    expect(scrubPath('/floor/receive/PO-2026-0042')).toBe('/floor/receive/:n')
  })

  it('names the keys that never reach a report', () => {
    for (const key of ['password', 'resetToken', 'pinHash', 'unitPrice', 'standardCost', 'grossMargin', 'hourlyWage', 'email', 'displayName', 'badgeCode', 'apiKey', 'sessionId']) expect(isSensitiveKey(key), key).toBe(true)
    for (const key of ['status', 'route', 'quantity', 'kind', 'version']) expect(isSensitiveKey(key), key).toBe(false)
  })
})

describe('errorReportOf', () => {
  it('reports the name, code, scrubbed message, scrubbed frames and causes; never the error object itself', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5432 for maria@example.com')
    const error = Object.assign(new Error('Unique failed: Key ("code")=(SECRET-1) for luca@example.com', { cause }), {
      code: 'P2002',
      meta: { target: ['code'], email: 'luca@example.com', unitPrice: 12.5 },
      password: 'made-up-password',
    })
    error.stack = `Error: x\n    at handler (${HOME}/repo/apps/factory-api/src/platform/files/files.ts:12:3)\n    at run (file://${HOME}/repo/node_modules/fastify/lib/route.js:1:1)`
    const out = report(error, { route: '/files', statusCode: 500 })
    expect(out).toMatchObject({ id: 'r1', source: 'api', name: 'Error', code: 'P2002', context: { route: '/files', statusCode: 500 } })
    expect(out.stack).toEqual(['at handler (…/apps/factory-api/src/platform/files/files.ts:12:3)', 'at run (…/node_modules/fastify/lib/route.js:1:1)'])
    expect(out.causes).toHaveLength(1)
    const text = everything(out)
    for (const secret of ['luca@example.com', 'maria@example.com', 'SECRET-1', 'made-up-password', '12.5', 'someone']) expect(text).not.toContain(secret)
  })

  it('never serialises a thrown non-Error value', () => {
    const out = report({ email: 'x@example.com', price: 99 })
    expect(out.name).toBe('NonError')
    expect(everything(out)).not.toContain('x@example.com')
    expect(everything(out)).not.toContain('99')
  })

  it('bounds the message, the frames and the causes', () => {
    const deep = (n: number): Error => (n === 0 ? new Error('root') : new Error(`level ${n}`, { cause: deep(n - 1) }))
    const error = deep(10)
    error.message = 'x'.repeat(5_000)
    error.stack = ['Error: x', ...Array.from({ length: 100 }, (_, index) => `    at f${index} (src/a.ts:${index}:1)`)].join('\n')
    const out = report(error)
    expect(out.message.length).toBeLessThanOrEqual(500)
    expect(out.stack).toHaveLength(30)
    expect(out.causes).toHaveLength(3)
  })
})
