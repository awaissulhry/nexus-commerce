#!/usr/bin/env -S npx tsx
/** Supplemental P3 family. It does not change the five existing sweep/speed families or their dictionary. */
import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import { sheetFixtureDatabaseConfig } from './sheet-fixture-target.mjs'
import { marketCatalogueRows } from '../../apps/api/src/services/pim/market-catalogue.ts'

const args = process.argv.slice(2)
const argument = (key: string) => { const at = args.indexOf(key); return at >= 0 ? args[at + 1] : undefined }
const output = argument('--out')
const smokeFile = argument('--smoke-seed') ?? process.env.SMOKE_SEED
if (!output || !smokeFile) throw new Error('--out and --smoke-seed are required')
const smoke = JSON.parse(readFileSync(smokeFile, 'utf8')) as { email?: string }
if (!smoke.email?.startsWith('smoke-owner-') || !smoke.email.endsWith('@example.test')) throw new Error('Use the synthetic smoke owner')
const database = sheetFixtureDatabaseConfig(argument('--url') ?? process.env.NEXUS_TEST_LOCAL_PG_URL ?? '')
const nonce = randomBytes(8).toString('hex')
const workspace = `e2e_sheet_editors_${nonce}`
const family = `${workspace}_parent`
const children = [`${workspace}_child_1`, `${workspace}_child_2`]
const dictionary = `${workspace}_dictionary`, group = `${workspace}_group`
const name = `E2E editor proof ${nonce}`
const records = [{ material: 'cotton', percentage: 100, fixtureTag: 'keep-first' }, { material: 'polyester', percentage: 0, fixtureTag: 'keep-second' }]
const protectors = [{ zone: 'shoulder', standard: 'EN 1621-1', level: '1' }, { zone: 'elbow', standard: 'EN 1621-1', level: '2' }]
const attributes = [
  { code: 'p3composition', label: 'P3 composition', type: 'text', scope: 'global', validation: {
    shape: 'list', maxItems: 30, recordFields: [
      { key: 'material', label: 'Material code', kind: 'text', required: true },
      { key: 'percentage', label: 'Percentage', kind: 'number', required: true, min: 0, max: 100 },
    ],
  } },
  // Native field selection requires this exact code, and recordFields must not take priority over its editor.
  { code: 'impactProtectors', label: 'Impact protectors', type: 'text', scope: 'global', validation: {} },
  { code: 'p3note', label: 'P3 note', type: 'textarea', scope: 'per_variant', validation: {} },
  { code: 'p3size', label: 'P3 size', type: 'text', scope: 'per_variant', validation: {} },
]
// Same made-up jacket outline as design-system/catalog/MediaPickersExample.tsx::drawn.
// Embedded vectors need no remote host or extra listener; this fixture makes no image-speed or upload claim.
const picture = (ink: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><path d="M60 40 L140 40 L170 80 L150 90 L150 170 L50 170 L50 90 L30 80 Z" fill="none" stroke="${ink}" stroke-width="6"/><rect x="70" y="90" width="60" height="14" rx="7" fill="${ink}"/></svg>`)}`
const client = new pg.Client(database)
await client.connect()
let outputCreated = false
let commitAttempted = false
try {
  await client.query('BEGIN')
  const owner = await client.query(`SELECT u.id, r.id AS "roleId" FROM "UserProfile" u
    JOIN "UserRole" ur ON ur."userId" = u.id JOIN "Role" r ON r.id = ur."roleId"
    WHERE u.email = $1 AND u.status = 'active' AND r.key = 'OWNER'`, [smoke.email])
  if (owner.rowCount !== 1) throw new Error('The exact synthetic active owner must already exist')
  await client.query(`INSERT INTO "Workspace" (id, name, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,$3,$1,now())`, [workspace, name, owner.rows[0].id])
  await client.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',now())`, [`${workspace}_member`, workspace, owner.rows[0].id])
  await client.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [`${workspace}_member`, owner.rows[0].roleId])
  await client.query(`SELECT set_config('nexus.workspace_id',$1,true)`, [workspace])
  // The new RLS workspace needs its own normal catalogue; another business's IT rows are not visible here.
  for (const market of marketCatalogueRows()) {
    await client.query(`INSERT INTO "Marketplace" (id,channel,code,name,"marketplaceId",region,currency,language,languages,
      "domainUrl","vatRate","taxInclusive","isActive","updatedAt")
      VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
    [market.channel, market.code, market.name, market.marketplaceId, market.region, market.currency, market.language,
      market.languages, market.domainUrl, market.vatRate, market.taxInclusive, market.isActive])
  }
  await client.query(`INSERT INTO "AttributeGroup" (id,code,label,"updatedAt") VALUES ($1,'p3_editors','P3 editors',now())`, [group])
  await client.query(`INSERT INTO "ProductFamily" (id,code,label,"updatedAt") VALUES ($1,'p3_editor_family','P3 editor family',now())`, [dictionary])
  for (const [index, attribute] of attributes.entries()) {
    const id = `${workspace}_${attribute.code}`
    await client.query(`INSERT INTO "CustomAttribute" (id,code,label,type,scope,"groupId",validation,"sortOrder","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now())`, [id, attribute.code, attribute.label, attribute.type, attribute.scope, group, JSON.stringify(attribute.validation), index])
    await client.query(`INSERT INTO "FamilyAttribute" (id,"familyId","attributeId",channels,"sortOrder","updatedAt") VALUES ($1,$2,$3,'{}',$4,now())`, [`${id}_link`, dictionary, id, index])
  }
  // Legacy axis names remain legitimate; the canonical axes editor owns their reorder endpoint.
  await client.query(`INSERT INTO "Product" (id,sku,name,"basePrice","isParent","familyId","variationAxes","updatedAt")
    VALUES ($1,$2,$3,49.90,true,$4,$5,now())`, [family, `E2E-EDITORS-${nonce}`, name, dictionary, ['p3note', 'p3size']])
  for (const [index, id] of children.entries()) {
    const note = `Original note ${index + 1}\nKeep this second line`, size = index ? 'L' : 'M'
    // R-23: a variant's axis values live in ONE store, `categoryAttributes.variations` (category-attributes-write.ts
    // `writeVariationValues`); the sheet's attribute write keeps the flat key and mirrors an axis edit into that store
    // (bulk-edit.service.ts `writeAttrMerge` → `variationAttributePatch`). Seed the shape the app itself writes, so an
    // edit and its restore round-trip to the exact seeded bag.
    const attributes = { p3composition: records, p3note: note, p3size: size, variations: { p3note: note, p3size: size } }
    await client.query(`INSERT INTO "Product" (id,sku,name,"basePrice","parentId","familyId","categoryAttributes","impactProtectors","localizedContent","updatedAt")
      VALUES ($1,$2,$3,49.90,$4,$5,$6::jsonb,$7::jsonb,'{"it":{}}'::jsonb,now())`, [id, `E2E-EDITORS-${nonce}-${index + 1}`, `${name} ${size}`, family, dictionary, JSON.stringify(attributes), JSON.stringify(protectors)])
    for (const [position, ink] of ['black', '#2458d6'].entries()) {
      await client.query(`INSERT INTO "ProductImage" (id,"productId",url,alt,type,"sortOrder",width,height,"mimeType","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,200,200,'image/svg+xml',now())`, [`${id}_photo_${position + 1}`, id, picture(ink), `P3 jacket view ${position + 1}`, position ? 'ALT' : 'MAIN', position])
    }
  }
  // A failed output write must not leave an unreported committed fixture. Never replace a prior run's evidence.
  const descriptor = openSync(output, 'wx', 0o600)
  outputCreated = true
  try { writeFileSync(descriptor, JSON.stringify({ workspace, nonce, family, children, name, dictionary, records, protectors }, null, 2)) }
  finally { closeSync(descriptor) }
  commitAttempted = true
  await client.query('COMMIT')
  console.log(`Created one private P3 editor workspace and a three-product family (${nonce})`)
} catch (error) {
  try { await client.query('ROLLBACK') }
  finally {
    if (outputCreated && !commitAttempted) unlinkSync(output)
    if (commitAttempted) console.error(`COMMIT outcome unconfirmed. Fixture locator retained at ${output}; verify its workspace/nonce before retrying.`)
  }
  throw error
} finally { await client.end() }
