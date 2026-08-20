/** HV-R P3a — can we build the Ad Group View's pathway rows from what exists? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []; const p = (s: string) => L.push(s)

const cols = await prisma.$queryRaw<Array<{c:string}>>`SELECT column_name::text c FROM information_schema.columns WHERE table_name='AdGroup' ORDER BY ordinal_position`
p(`AdGroup columns: ${cols.map(x=>x.c).join(', ')}`)

const rows = await prisma.$queryRaw<Array<{agid:string;ag:string;st:string|null;cid:string;cname:string;ctt:string|null;cst:string|null;mkt:string|null;ap:string|null;ext:string|null;kw:bigint}>>`
  SELECT g.id agid, g.name ag, g.status::text st, c.id cid, c.name cname,
         c."targetingType"::text ctt, c.status::text cst, c.marketplace::text mkt,
         c."adProduct"::text ap, g."externalAdGroupId" ext,
         (SELECT COUNT(*) FROM "AdTarget" t WHERE t."adGroupId"=g.id AND t."isNegative"=false) kw
  FROM "AdGroup" g JOIN "Campaign" c ON c.id=g."campaignId"`
p(`\ntotal ad groups ${rows.length}`)

const role = (r: typeof rows[0]) =>
  r.ctt === 'AUTO' ? 'AUTO'
  : /(^|[^a-z])exact([^a-z]|$)/i.test(r.ag) ? 'EXACT'
  : /(^|[^a-z])phrase([^a-z]|$)/i.test(r.ag) ? 'PHRASE'
  : /(^|[^a-z])broad([^a-z]|$)/i.test(r.ag) ? 'BROAD'
  : 'unclassified'
const tally = new Map<string, number>()
for (const r of rows) tally.set(role(r), (tally.get(role(r)) ?? 0) + 1)
p(`\nby role: ${[...tally].map(([k,v])=>`${k} ${v}`).join(' · ')}`)

const sources = rows.filter(r => ['AUTO','BROAD','PHRASE'].includes(role(r)))
const dests = rows.filter(r => role(r) === 'EXACT' && r.ctt === 'MANUAL')
p(`\nSOURCE-eligible (AUTO/BROAD/PHRASE) ${sources.length}  ·  DESTINATION-eligible (MANUAL EXACT) ${dests.length}`)
p(`  sources ENABLED campaign: ${sources.filter(r=>r.cst==='ENABLED').length} · with an Amazon id: ${sources.filter(r=>r.ext).length}`)
p(`  unclassified (neither): ${rows.length - sources.length - dests.length}`)

const byMkt = new Map<string, {s:number;d:number}>()
for (const r of sources) { const m = byMkt.get(r.mkt??'?') ?? {s:0,d:0}; m.s++; byMkt.set(r.mkt??'?', m) }
for (const r of dests) { const m = byMkt.get(r.mkt??'?') ?? {s:0,d:0}; m.d++; byMkt.set(r.mkt??'?', m) }
p(`\nby marketplace (source/destination): ${[...byMkt].map(([k,v])=>`${k} ${v.s}/${v.d}`).join(' · ')}`)
p(`\nadProduct on campaigns: ${[...new Set(rows.map(r=>r.ap))].join(', ')}`)
p(`\nsample sources:`)
for (const r of sources.slice(0,6)) p(`   [${role(r)}] ${r.ag}  ←  ${r.cname} (${r.mkt}, ${r.cst}) kw=${r.kw}`)
p(`\nsample destinations:`)
for (const r of dests.slice(0,6)) p(`   ${r.ag}  ←  ${r.cname} (${r.mkt}, ${r.cst}) kw=${r.kw}`)

const assign = await prisma.$queryRaw<Array<{t:string}>>`SELECT table_name::text t FROM information_schema.tables WHERE table_name ILIKE '%Assignment%' OR table_name ILIKE '%Harvest%'`
p(`\nexisting assignment/harvest tables: ${assign.map(x=>x.t).join(', ') || 'none'}`)

console.log(L.join('\n')); await prisma.$disconnect()
