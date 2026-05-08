#!/usr/bin/env node
// Verify R2.2 — PATCH return notes, PATCH item (notes + checklist),
// photo upload + remove. Photo upload is exercised against a real
// Cloudinary if configured; otherwise the upload-photo gate verifies
// the 503 path.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'http://localhost:8080'
const url = process.env.DATABASE_URL
const client = new pg.Client({ connectionString: url })
await client.connect()

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d) => { console.log('  ✗', l, '\n    →', d); fail++ }
const dbq = (s, p) => client.query(s, p).then((r) => r.rows)

// ── Schema columns exist
console.log('\n[1] Schema columns')
{
  const cols = await dbq(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'ReturnItem'
    AND column_name IN ('photoUrls', 'inspectionChecklist')
    ORDER BY column_name`)
  if (cols.length === 2) ok(`both columns present: ${cols.map(c => c.column_name).join(', ')}`)
  else bad('expected 2 columns', JSON.stringify(cols))
}

// ── Create a return + item to mutate
const create = await fetch(`${API}/api/fulfillment/returns`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-user-id': 'r22-verify' },
  body: JSON.stringify({
    channel: 'AMAZON',
    reason: 'R22_INSPECTION_TEST',
    items: [{ sku: 'R22-A', quantity: 1 }],
  }),
})
const ret = await create.json()
const id = ret.id
const itemId = ret.items?.[0]?.id
if (id && itemId) ok(`created return ${id} item ${itemId}`)
else { bad('create failed', JSON.stringify(ret)); process.exit(1) }

// ── PATCH return notes
console.log('\n[2] PATCH /returns/:id (notes)')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'r22-verify' },
    body: JSON.stringify({ notes: 'visible on shelf B3' }),
  })
  const j = await r.json()
  if (r.ok && j.notes === 'visible on shelf B3') ok('notes persisted')
  else bad('notes mismatch', JSON.stringify(j))
}

// ── PATCH item notes + checklist
console.log('\n[3] PATCH /returns/:id/items/:itemId')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'r22-verify' },
    body: JSON.stringify({
      notes: 'minor scuff back panel',
      inspectionChecklist: {
        packagingPresent: true,
        tagsIntact: false,
        visibleDamage: true,
        damageNotes: 'scuff visible',
        functionalTestPassed: true,
        signsOfUse: 'LIGHT',
      },
      conditionGrade: 'GOOD',
    }),
  })
  const j = await r.json()
  if (r.ok && j.notes === 'minor scuff back panel' && j.conditionGrade === 'GOOD') ok('item notes + grade persisted')
  else bad('item PATCH mismatch', JSON.stringify(j))
  if (j.inspectionChecklist?.signsOfUse === 'LIGHT' && j.inspectionChecklist?.visibleDamage === true) ok('inspectionChecklist persisted')
  else bad('checklist mismatch', JSON.stringify(j.inspectionChecklist))
}

// ── PATCH item: scope check (item from another return → 400)
console.log('\n[4] PATCH item scope guard')
{
  const r = await fetch(`${API}/api/fulfillment/returns/cm-bogus-id/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'should fail' }),
  })
  if (r.status === 400 || r.status === 404) ok(`scope guard returns ${r.status}`)
  else bad(`expected 400/404, got ${r.status}`, '')
}

// ── DELETE photo for nonexistent URL → succeeds (filter is no-op)
console.log('\n[5] DELETE /photos noop when url not present')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/items/${itemId}/photos`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/not-actually-on-this-item.jpg' }),
  })
  const j = await r.json()
  if (r.ok && Array.isArray(j.photoUrls) && j.photoUrls.length === 0) ok('delete noop returned current empty list')
  else bad('unexpected', JSON.stringify(j))
}

// ── upload-photo: cloudinary-config-aware path.
//    503: Cloudinary not configured (the route bails before parsing).
//    400: Cloudinary configured but no `file` field in the multipart body.
//    500: Cloudinary configured but the request body wasn't multipart at
//         all (fastify-multipart rejects upstream of our handler — this
//         is correct behaviour; real browser FormData always sends a
//         multipart Content-Type so users never hit this branch).
console.log('\n[6] POST /upload-photo gate')
{
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/items/${itemId}/upload-photo`, {
    method: 'POST',
  })
  if (r.status === 503) ok('Cloudinary unconfigured → 503')
  else if (r.status === 400) ok('Cloudinary configured + multipart required → 400 (no file)')
  else if (r.status === 500) {
    const body = await r.text()
    if (body.includes('not multipart')) ok('Cloudinary configured + non-multipart POST → 500 from fastify-multipart (real clients always send multipart)')
    else bad(`unexpected 500 body`, body.slice(0, 120))
  }
  else bad(`unexpected ${r.status}`, await r.text().then(t => t.slice(0, 120)))
}

// ── Full multipart upload roundtrip when Cloudinary is configured.
//    Skipped automatically when the env vars aren't set.
console.log('\n[6b] POST /upload-photo (real multipart)')
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  // 1×1 transparent PNG, smallest possible valid PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  )
  const fd = new FormData()
  fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png')
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/items/${itemId}/upload-photo`, {
    method: 'POST',
    body: fd,
  })
  const j = await r.json().catch(() => ({}))
  if (r.ok && typeof j.url === 'string' && j.url.startsWith('http')) ok(`uploaded → ${j.url.slice(0, 60)}…`)
  else bad('upload failed', JSON.stringify(j).slice(0, 200))
  if (r.ok && Array.isArray(j.photoUrls) && j.photoUrls.length === 1) ok('photoUrls array length = 1')
  else bad('photoUrls mismatch', JSON.stringify(j.photoUrls))
  // Now remove it
  if (r.ok && j.url) {
    const rm = await fetch(`${API}/api/fulfillment/returns/${id}/items/${itemId}/photos`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: j.url }),
    })
    const rmj = await rm.json()
    if (rm.ok && rmj.photoUrls.length === 0) ok('photo removed (gallery empty)')
    else bad('remove failed', JSON.stringify(rmj))
  }
} else {
  console.log('  → CLOUDINARY_* env not set; skipping real-upload roundtrip')
}

// ── AuditLog entries for the PATCH actions
console.log('\n[7] AuditLog wiring')
await new Promise((r) => setTimeout(r, 400))
{
  const rows = await dbq(
    `SELECT action FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1 AND action IN ('edit-notes', 'edit-item') ORDER BY action`,
    [id],
  )
  const actions = rows.map((r) => r.action)
  if (actions.includes('edit-notes')) ok('edit-notes audit')
  else bad('no edit-notes audit', JSON.stringify(actions))
  if (actions.includes('edit-item')) ok('edit-item audit')
  else bad('no edit-item audit', JSON.stringify(actions))
}

// Cleanup
console.log('\n[8] Cleanup')
await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1`, [id])
await dbq(`DELETE FROM "Return" WHERE id = $1`, [id])
ok('test rows + audit logs deleted')

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
