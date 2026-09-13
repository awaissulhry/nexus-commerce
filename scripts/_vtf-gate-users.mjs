import { open } from './_vtf-db.mjs'
const c = await open()
const q = async (s) => (await c.query(s)).rows
console.log('orphan gate users:', (await q(`SELECT count(*)::int n FROM "UserProfile" WHERE id LIKE 'vtgate_%' OR email LIKE 'vt-gate-%'`))[0].n)
console.log('orphan gate roles:', (await q(`SELECT count(*)::int n FROM "Role" WHERE id LIKE 'vtgate_role_%'`))[0].n)
console.log('orphan memberships:', (await q(`SELECT count(*)::int n FROM "WorkspaceMembership" WHERE id LIKE 'vtgate_member_%'`))[0].n)
await c.end()
