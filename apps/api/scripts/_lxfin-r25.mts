/**
 * LX.FIN item 1 (R-LX-25) — the two remaining translation SURFACES, measured through the real writers.
 *
 * ARM A  = the body the shipped `ProductDrawer` TranslationsTab sends today (no `contentAddress`).
 * ARM B  = the body after the fix (`{tier:'language', language:'de'}`).
 * ARM C  = the lens's bulk-generate body today (no `contentAddress`) vs D = after the fix.
 * Positive control: the router's own writer, which DOES carry an address, on the same run.
 */
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
const { default: prisma } = await import('../src/db.js')
const db = (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS current_database'))[0]
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
console.log('DISCRIMINATOR', db, 'GALE-JACKET version', gale?.version)
if (db.current_database !== 'nexus_development' || gale?.version !== 59) { console.error('REFUSING — not the local Docker database'); process.exit(2) }

const PRODUCT = 'cmtzci5kf0000njr9f8yhrsxm' // VX-TEST-3AX
const marker = `LXFIN-PROBE-${Date.now()}`
const before = {
  product: await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT }, select: { version: true, name: true } }),
  de: await prisma.productTranslation.findFirst({ where: { productId: PRODUCT, language: 'de' } }),
  total: await prisma.productTranslation.count(),
}
console.log('BEFORE', JSON.stringify(before))

const { writeTranslation } = await import('../src/services/pim/translation-write.js')
const { contentAddress } = await import('@nexus/shared/content-language')

const call = async (label: string, body: Record<string, unknown>) => {
  try {
    const row = await writeTranslation({ address: (body as any).contentAddress, expectedVersion: (body as any).expectedVersion,
      expectedTranslationVersion: (body as any).contentVersion, productId: PRODUCT, locale: 'de',
      values: { name: (body as any).name }, state: 'reviewed', userId: 'lxfin-probe', ip: '127.0.0.1' } as any)
    console.log(`${label}: RESOLVED`, JSON.stringify({ id: (row as any)?.id, name: (row as any)?.name, version: (row as any)?.version }))
    return { ok: true }
  } catch (error: any) {
    console.log(`${label}: REFUSED statusCode=${error?.statusCode ?? '(none)'} message=${JSON.stringify(error?.message)}`)
    return { ok: false, statusCode: error?.statusCode, message: error?.message }
  }
}

// ARM A — verbatim the drawer's `save()` body today.
const a = await call('ARM A (drawer TODAY, no contentAddress)', { name: marker })
// ARM A2 — verbatim the drawer's `create()` body today.
const a2 = await call('ARM A2 (drawer create TODAY, {source:"manual"})', { source: 'manual' })
// ARM B — the body after the fix.
const b = await call('ARM B (drawer AFTER the fix)', { name: marker, contentAddress: { tier: 'language', language: 'de' } })

// The lens's arm is the shared validator the route runs at products-ai.routes.ts:128.
const lens = (label: string, value: unknown) => {
  try { console.log(`${label}: ACCEPTED ${JSON.stringify(contentAddress(value, 'Content'))}`) }
  catch (e: any) { console.log(`${label}: REFUSED statusCode=${e?.statusCode} message=${JSON.stringify(e?.message)}`) }
}
lens('ARM C (lens TODAY, no contentAddress)', undefined)
lens('ARM D (lens AFTER the fix, de)', { tier: 'language', language: 'de' })
lens('ARM D2 (lens AFTER the fix, source language)', { tier: 'source' })

// Read back after >= 8 s — a response is not what was written.
await new Promise(r => setTimeout(r, 8500))
const after = {
  product: await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT }, select: { version: true } }),
  de: await prisma.productTranslation.findFirst({ where: { productId: PRODUCT, language: 'de' },
    select: { id: true, language: true, name: true, version: true, source: true, reviewedAt: true, attributes: true } }),
  total: await prisma.productTranslation.count(),
}
console.log('AFTER (read back at', new Date().toISOString(), ')', JSON.stringify(after))
console.log('MARKER STORED:', after.de?.name === marker)

// RESTORE BY VALUE.
if (!before.de && after.de) {
  await prisma.productTranslation.delete({ where: { id: after.de.id } })
  await prisma.product.update({ where: { id: PRODUCT }, data: { version: before.product.version } })
} else if (before.de) {
  await prisma.productTranslation.update({ where: { id: before.de.id }, data: before.de as any })
  await prisma.product.update({ where: { id: PRODUCT }, data: { version: before.product.version } })
}
await new Promise(r => setTimeout(r, 8500))
const restored = {
  product: await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT }, select: { version: true, name: true } }),
  de: await prisma.productTranslation.findFirst({ where: { productId: PRODUCT, language: 'de' } }),
  total: await prisma.productTranslation.count(),
}
console.log('RESTORED (read back at', new Date().toISOString(), ')', JSON.stringify({ ...restored, de: restored.de?.id ?? null }))
console.log('RESTORE EXACT:', JSON.stringify(restored.product) === JSON.stringify(before.product) && (restored.de?.id ?? null) === (before.de?.id ?? null) && restored.total === before.total)
console.log('SUMMARY', JSON.stringify({ armA: a, armA2: a2, armB: b }))
await prisma.$disconnect()
