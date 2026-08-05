/** RPT.15 — exercise the security properties, not just the happy path. */
import prisma from '../src/db.js'
import * as s from '../src/services/advertising/ads-report-shares.service.js'
const L: string[] = []
const ok = (n: string, c: boolean) => L.push(`${c ? 'PASS' : 'FAIL'}  ${n}`)

const { link, token } = await s.createShareLink({
  reportId: 'campaign', query: { reportId: 'campaign', from: '2026-07-20', to: '2026-08-02', pageSize: 5 } as never,
  label: 'security test', ttlDays: 1,
})
ok('token is long and random', token.length >= 40)
const row = await prisma.reportShareLink.findUnique({ where: { id: link.id } })
ok('raw token is NOT stored anywhere', JSON.stringify(row).includes(token) === false)
ok('only a sha256 hash is stored', /^[0-9a-f]{64}$/.test(row!.tokenHash))

const r = await s.resolveShareLink(token)
ok('valid token resolves', r.result.rows.length > 0)
ok('pageSize honoured from frozen query', r.result.rows.length <= 5)

const wrong = await s.resolveShareLink('x'.repeat(43)).then(() => 'resolved').catch((e) => e.message)
ok('unknown token denied', wrong !== 'resolved')
const short = await s.resolveShareLink('abc').then(() => 'resolved').catch((e) => e.message)
ok('short token denied', short !== 'resolved')
ok('denial message does not distinguish cause', wrong === short)

await s.revokeShareLink(link.id)
const afterRevoke = await s.resolveShareLink(token).then(() => 'resolved').catch((e) => e.message)
ok('revoked token denied immediately', afterRevoke !== 'resolved')
ok('revoked denial is indistinguishable', afterRevoke === wrong)

// expiry
const exp = await s.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign', pageSize: 5 } as never, ttlDays: 1 })
await prisma.reportShareLink.update({ where: { id: exp.link.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
const afterExpiry = await s.resolveShareLink(exp.token).then(() => 'resolved').catch((e) => e.message)
ok('expired token denied', afterExpiry !== 'resolved')

const badTtl = await s.createShareLink({ reportId: 'campaign', query: { reportId: 'campaign' } as never, ttlDays: 9999 }).then(() => 'ok').catch((e) => e.message)
ok('ttl beyond max rejected', badTtl !== 'ok')
const badReport = await s.createShareLink({ reportId: 'nope', query: {} as never }).then(() => 'ok').catch((e) => e.message)
ok('unknown reportId rejected', badReport !== 'ok')

// cleanup test rows
await prisma.reportShareLink.deleteMany({ where: { id: { in: [link.id, exp.link.id] } } })
console.error(L.join('\n') + `\nSUMMARY ${L.filter((x) => x.startsWith('PASS')).length}/${L.length} passed`)
process.exit(0)
