const url = process.argv[2]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const r = (await p.$queryRawUnsafe<any[]>(`SELECT "schemaDefinition" def, "fetchedAt" FROM "CategorySchema" WHERE channel='AMAZON' AND "productType"='SUIT' AND "marketplace"='IT' ORDER BY "fetchedAt" DESC LIMIT 1`))[0]
if (!r) { console.log('no SUIT/IT schema'); process.exit(0) }
const props = r.def?.properties ?? {}
const nm = props?.variation_theme?.items?.properties?.name ?? {}
const en: string[] = nm.enum ?? [], dep: string[] = nm.$lifecycle?.enumDeprecated ?? []
const canonSeg = (s: string) => { const t=s.replace(/_?NAME$/i,''); const k=t.toLowerCase().replace(/[\s_-]/g,''); return ({colore:'color',colour:'color',farbe:'color',couleur:'color',taglia:'size',taille:'size',talla:'size','größe':'size',groesse:'size',stylename:'style'} as any)[k]??k }
const want = ['fittype','size','color']
const matches = en.filter(t => { const s=t.split('/').map(x=>x.trim()).filter(Boolean).map(canonSeg); return s.length===want.length && [...s].sort().join('|')===[...want].sort().join('|') })
console.log('SUIT/IT enum size:', en.length, '| deprecated:', dep.length, '| fetchedAt', r.fetchedAt.toISOString())
console.log('set-matches for [fittype,size,color]:', JSON.stringify(matches.map(t=>({code:t, deprecated:dep.includes(t), inOrder: t.split('/').map(x=>canonSeg(x.trim())).join('/')===want.join('/')}))))
for (const k of ['color','size','fit_type','size_name','color_name','style']) console.log(`  property ${k}: ${props[k] ? 'present title="'+(props[k].title??'')+'"' : 'ABSENT'}`)
await p.$disconnect()
