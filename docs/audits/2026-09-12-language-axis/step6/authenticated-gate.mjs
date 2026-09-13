import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { Client } from 'pg'
import { tsImport } from 'tsx/esm/api'
import { databaseTarget } from '../step1/target.mjs'
const diagnostic = process.argv[2] ?? 'a'
assert.ok(['a','b','c','c-missing','d','e','f','g','h'].includes(diagnostic), 'Expected a screen sub-gate a–h')
const stem = `screen-${diagnostic}`
const here = new URL('.', import.meta.url)
const root = new URL('../../../../', import.meta.url)
const ledger = new URL('docs/pes-claims.md', root)
const announce = text => fs.appendFileSync(ledger, `\nLX Step 6 readiness · ${new Date().toISOString()} · ${text}\n`)
const target = await databaseTarget('local')
assert.equal(target.identity.database, 'nexus_development')
const c = new Client({ connectionString: target.connectionString })
let email = `lx-editor-${randomBytes(12).toString('hex')}@example.test`
const password = randomBytes(36).toString('base64url')
const secretValues = [email, password]
const safe = text => secretValues.reduce((s, value) => s.split(value).join('[redacted]'), String(text))
const { hashPassword, checkPasswordStrength } = await tsImport('../../../../apps/api/src/lib/auth/password.ts', import.meta.url)
assert.equal(checkPasswordStrength(password, [email]).ok, true)
let started = false
let output = ''
let gateExit = null
try {
  const processes = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' })
  assert.equal(processes.split('\n').filter(line => /^\s*\d+\s+(?:\S+\/)?node\s+.*scripts\/check-(editor-open|layout-v2|control-census)\.mjs/.test(line)).length, 0, 'Another browser gate is running')
  await c.connect()
  assert.equal((await c.query('SELECT current_database() AS name')).rows[0].name, 'nexus_development')
  const fixture = (await c.query('SELECT "workspaceId","productType" FROM "Product" WHERE id=$1 AND sku=$2', ['cmokmy3a40078pm0p1fvnu523', 'GALE-JACKET'])).rows[0]
  assert.ok(fixture)
  const role = (await c.query('SELECT id FROM "Role" WHERE key=$1 AND "isSystem"=true AND "requireMfa"=false', ['OPS_MANAGER'])).rows[0]
  assert.ok(role, 'Existing operator role required')
  for (const market of ['DE', 'IT']) assert.ok((await c.query('SELECT id FROM "CategorySchema" WHERE channel=$1 AND marketplace=$2 AND "productType"=$3 AND "isActive"=true LIMIT 1', ['AMAZON', market, fixture.productType])).rowCount, 'Provider-free gate requires both cached schemas')
  announce('local dedicated test-user creation starting; nexus_development only, equivalent invitation insert with the existing hashPassword helper and OPS_MANAGER workspace membership plus the same role on the legacy authorization path. Credentials remain in memory; no email or password value is recorded.')
  const priorReceiptUrl = new URL('../step4/gate-account-receipt.json', here)
  const prior = fs.existsSync(priorReceiptUrl) ? JSON.parse(fs.readFileSync(priorReceiptUrl)) : null
  const existing = prior ? (await c.query('SELECT id,email FROM "UserProfile" WHERE id=$1 AND "displayName"=$2', [prior.userId, 'Language axis editor gate'])).rows[0] : null
  if (prior) assert.ok(existing, 'The owned test user must still exist')
  if (existing) { email = existing.email; secretValues.push(email) }
  const userId = existing?.id ?? `lx4_gate_${randomUUID()}`
  const memberId = prior?.memberId ?? `lx4_gate_member_${randomUUID()}`
  const passwordHash = await hashPassword(password)
  secretValues.push(passwordHash)
  await c.query('BEGIN')
  if (existing) await c.query('UPDATE "UserProfile" SET "passwordHash"=$1,"updatedAt"=now() WHERE id=$2', [passwordHash,userId])
  else await c.query('INSERT INTO "UserProfile" (id,email,"displayName","passwordHash",status,"updatedAt") VALUES ($1,$2,$3,$4,$5,now())', [userId,email,'Language axis editor gate',passwordHash,'active'])
  if (!existing) await c.query('INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,$4,now())', [memberId,fixture.workspaceId,userId,'active'])
  if (!existing) await c.query('INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)', [memberId,role.id])
  await c.query('INSERT INTO "UserRole" (id,"userId","roleId") VALUES ($1,$2,$3) ON CONFLICT ("userId","roleId") DO NOTHING', [`lx4_gate_role_${randomUUID()}`,userId,role.id])
  await c.query('UPDATE "UserProfile" SET "permissionsVersion"="permissionsVersion"+1 WHERE id=$1', [userId])
  await c.query('COMMIT')
  const accountReceipt = { at: new Date().toISOString(), target: target.identity, userId, memberId, workspaceId: fixture.workspaceId, role: 'OPS_MANAGER', legacyRoleAssignment: true, hashAlgorithm: 'argon2id', helper: 'apps/api/src/lib/auth/password.ts', credentialsPersistedToFiles: false }
  fs.writeFileSync(new URL('gate-account-receipt.json', here), JSON.stringify(accountReceipt,null,2)+'\n')
  announce(`local dedicated test-user creation finished; user id ${userId}; existing workspace membership active; receipt gate-account-receipt.json contains no credentials.`)
  await c.end()
  const start = new Date().toISOString()
  for (const file of [`${stem}.log`, `${stem}.json`]) {
    const previous = new URL(file, here)
    if (fs.existsSync(previous)) fs.renameSync(previous, new URL(`${file}.${Date.now()}.previous`, here))
  }
  const env = { ...process.env, STUDIO_TEST_EMAIL: email, STUDIO_TEST_PASSWORD: password, STUDIO_API_BASE: 'http://localhost:8091', EDITOR_BASE: 'http://localhost:3000', EDITOR_API: 'http://localhost:8091' }
  for (const key of ['EDITOR_ONLY','EDITOR_REPS','STUDIO_STORAGE_STATE','CENSUS_STORAGE_STATE']) delete env[key]
  announce(`gate starting — Step 6 ${diagnostic}, alone on :3000 with local auth :8091 and read-only isolated route handlers :4120; authenticated measurements only. Hold API/web saves until gate finished.`)
  started = true
  console.log(`gate starting — Step 6 ${diagnostic}; credentials remain in the child process environment`)
  const child = spawn(process.execPath, ['docs/audits/2026-09-12-language-axis/step6/screen-gate.mjs', diagnostic], { cwd: root, env, stdio: ['ignore','pipe','pipe'] })
  const capture = data => { const value = safe(data.toString()); output += value; process.stdout.write(value) }
  child.stdout.on('data',capture); child.stderr.on('data',capture)
  gateExit = await new Promise((resolve,reject) => { child.on('error',reject); child.on('exit',(code,signal)=>resolve(code ?? (signal ? 128 : 1))) })
  const finish = new Date().toISOString()
  fs.writeFileSync(new URL(`${stem}.log`,here), output)
  fs.writeFileSync(new URL(`${stem}.json`,here), JSON.stringify({start,finish,command:`node docs/audits/2026-09-12-language-axis/step6/screen-gate.mjs ${diagnostic}`,base:env.EDITOR_BASE,api:env.EDITOR_API,exitCode:gateExit,diagnostic,log:`${stem}.log`,sha256:createHash('sha256').update(output).digest('hex')},null,2)+'\n')
  announce(`gate finished — exit ${gateExit}; output ${stem}.log, timing/checksum ${stem}.json. Test credentials were not written to files. Source save hold released.`)
  console.log(`gate finished — exit ${gateExit}`)
  process.exitCode = gateExit
} catch(error) {
  await c.query('ROLLBACK').catch(()=>{})
  await c.end().catch(()=>{})
  if (started) announce('gate finished — runner failed; no passing claim. Source save hold released.')
  console.error(safe(error.message)); process.exitCode=1
}
