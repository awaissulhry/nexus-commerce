/**
 * TECH_DEBT #51 — transport primitive smoke tests.
 *
 * Cheap, no-network. The real-mode HTTP path is exercised
 * by the existing R6.3 + O.30 callsites in production-shape
 * dryRun mode; we don't mock fetch here.
 */

import { sendEmail, __test } from './transport.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}

const prevEnable = process.env.NEXUS_ENABLE_OUTBOUND_EMAILS
process.env.NEXUS_ENABLE_OUTBOUND_EMAILS = 'false'

test('isReal() defaults to false', () => {
  assert(__test.isReal() === false)
})

test('defaultFrom() honors NEXUS_EMAIL_FROM', () => {
  const prev = process.env.NEXUS_EMAIL_FROM
  process.env.NEXUS_EMAIL_FROM = 'Test <test@example.com>'
  assert(__test.defaultFrom() === 'Test <test@example.com>')
  if (prev === undefined) delete process.env.NEXUS_EMAIL_FROM
  else process.env.NEXUS_EMAIL_FROM = prev
})

test('defaultFrom() falls back to Xavia ship@xavia.it', () => {
  const prev = process.env.NEXUS_EMAIL_FROM
  delete process.env.NEXUS_EMAIL_FROM
  assert(__test.defaultFrom() === 'Xavia <ship@xavia.it>')
  if (prev !== undefined) process.env.NEXUS_EMAIL_FROM = prev
})

test('encodeAttachment base64 encodes Buffer content', () => {
  const out = __test.encodeAttachment({
    filename: 'test.pdf',
    content: Buffer.from('hello'),
    contentType: 'application/pdf',
  })
  assert(out.filename === 'test.pdf')
  assert(out.content === Buffer.from('hello').toString('base64'))
  assert(out.content_type === 'application/pdf')
})

test('encodeAttachment base64 encodes string content', () => {
  const out = __test.encodeAttachment({
    filename: 'note.txt',
    content: 'hello world',
  })
  assert(out.content === Buffer.from('hello world', 'utf8').toString('base64'))
  assert(out.content_type === undefined)
})

test('sendEmail() in dryRun returns mock result', async () => {
  const r = await sendEmail({
    to: 'a@b.com',
    subject: 'hi',
    html: '<p>hi</p>',
    tag: 'test-tag',
  })
  assert(r.ok === true, 'ok')
  assert(r.dryRun === true, 'dryRun')
  assert(r.provider === 'mock', 'provider')
  assert(r.messageId?.startsWith('mock-'))
})

test('sendEmail() accepts array recipients', async () => {
  const r = await sendEmail({
    to: ['a@b.com', 'c@d.com'],
    subject: 'multi',
    html: '<p>multi</p>',
  })
  assert(r.ok === true)
  assert(r.dryRun === true)
})

test('sendEmail() in real mode without RESEND_API_KEY returns error', async () => {
  const prevEnable = process.env.NEXUS_ENABLE_OUTBOUND_EMAILS
  const prevKey = process.env.RESEND_API_KEY
  process.env.NEXUS_ENABLE_OUTBOUND_EMAILS = 'true'
  delete process.env.RESEND_API_KEY
  try {
    const r = await sendEmail({ to: 'a@b.com', subject: 'x', html: '<p>x</p>' })
    assert(r.ok === false, 'ok=false')
    assert(r.dryRun === false, 'dryRun=false')
    assert(r.error?.includes('RESEND_API_KEY'), 'mentions key')
  } finally {
    if (prevEnable === undefined) delete process.env.NEXUS_ENABLE_OUTBOUND_EMAILS
    else process.env.NEXUS_ENABLE_OUTBOUND_EMAILS = prevEnable
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey
  }
})

;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try { await t.fn(); passed++ }
    catch (err) { failed++; console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err) }
  }
  if (prevEnable === undefined) delete process.env.NEXUS_ENABLE_OUTBOUND_EMAILS
  else process.env.NEXUS_ENABLE_OUTBOUND_EMAILS = prevEnable
  if (failed > 0) {
    console.error(`email transport.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  console.log(`email transport.test.ts: ${passed}/${passed} passed`)
})()
