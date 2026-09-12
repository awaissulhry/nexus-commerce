import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { productMediaQuerySchema, productMediaSaveSchema, productMediaCopySchema } from '../../../../packages/shared/dist/product-media.js'
const root = fileURLToPath(new URL('.', import.meta.url)), repo = resolve(root, '../../../..'), stubs = resolve(root, '../../2026-09-10-shopify-information/browser-fixture')
const galleries = new Map(), writes = [], revision = new Map(); let conflict = false
const types = [['front','IMAGE','Front view'],['video','VIDEO','Fit demonstration'],['rear','IMAGE','Rear view'],['external','EXTERNAL_VIDEO','External demonstration'],['broken','VIDEO','Unavailable video'],['model','MODEL_3D','3D product model']]
const assets = types.map(([id,type,alt]) => ({ id, type, alt, url: type === 'IMAGE' ? '/image.svg' : id === 'video' ? '/video.mp4' : id === 'broken' ? '/missing.mp4' : `https://example.com/${id}`, preview: type === 'IMAGE' ? '/image.svg' : null }))
const fullGallery = { version: 1, items: assets.map(asset => ({ assetId: asset.id })) }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const server = await createServer({ configFile: false, root, resolve: { alias: [
  { find: '@/lib/auth/AuthProvider', replacement: stubs + '/auth.ts' }, { find: '@/lib/backend-url', replacement: stubs + '/backend.ts' },
  { find: 'next/navigation', replacement: stubs + '/navigation.tsx' }, { find: 'next/link', replacement: stubs + '/link.tsx' }, { find: 'next/dynamic', replacement: stubs + '/dynamic.tsx' },
  { find: '@', replacement: repo + '/apps/web/src' }, { find: '@nexus/shared', replacement: repo + '/packages/shared' },
  { find: 'react-dom', replacement: repo + '/node_modules/react-dom' }, { find: 'react', replacement: repo + '/node_modules/react' },
] }, esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"development"' }, server: { hmr: false, host: '127.0.0.1', port: 3167, strictPort: true, fs: { allow: [root, repo] } }, plugins: [{ name: 'product-media-fixture', configureServer(vite) { vite.middlewares.use(async (req,res,next) => {
  const url = new URL(req.url, 'http://127.0.0.1:3167')
  const send = (value,status=200) => { res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value)) }
  if(url.pathname === '/video.mp4') { const video = await readFile(resolve(repo, 'docs/audits/2026-09-08-shopify-media/browser-fixture/demo.mp4'));res.setHeader('Content-Type','video/mp4');res.setHeader('Content-Length',video.length);return res.end(video) }
  if(url.pathname === '/missing.mp4') { res.statusCode=404;return res.end() }
  if(url.pathname === '/image.svg') { res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="white"/><path d="M120 60L50 110L20 260L90 280L120 180V350H280V180L310 280L380 260L350 110L280 60L240 95H160Z" fill="#647080" stroke="#192839" stroke-width="5"/><path d="M200 95V350" stroke="white" stroke-width="4"/></svg>') }
  if(url.pathname === '/conflict') { conflict=true;return send({ok:true}) }
  if(url.pathname === '/evidence') return send({ writes, galleries: [...galleries] })
  if(!url.pathname.startsWith('/api/')) return next()
  const buffers=[]; for await (const chunk of req) buffers.push(chunk)
  if(!url.pathname.endsWith('/product-media')) return send({error:'Fixture endpoint not implemented'},404)
  try {
    const context = productMediaQuerySchema.parse(Object.fromEntries(url.searchParams)), productId = decodeURIComponent(url.pathname.split('/')[3]), key=JSON.stringify([productId,context])
    const neutral = productId === 'product-1' ? fullGallery : {version:1,items:[{assetId:productId === 'product-2' ? 'rear' : 'front'}]}
    const rev=()=>hash([key,revision.get(key)??0,galleries.get(key)??neutral])
    if(req.method==='PUT') {
      const raw = JSON.parse(Buffer.concat(buffers).toString()), body = raw.source ? productMediaCopySchema.parse(raw) : productMediaSaveSchema.parse(raw)
      if (body.source) {
        const sourceKey = JSON.stringify([body.source.productId,body.source.context]), sourceNeutral = body.source.productId === 'product-1' ? fullGallery : {version:1,items:[{assetId:body.source.productId === 'product-2' ? 'rear' : 'front'}]}
        const sourceCollection = galleries.get(sourceKey) ?? sourceNeutral
        if (body.source.expectedRevision !== hash([sourceKey,revision.get(sourceKey)??0,sourceCollection])) return send({error:'The source gallery changed.'},409)
        body.collection=sourceCollection
      }
      if(conflict || body.expectedRevision!==rev()) {conflict=false;revision.set(key,(revision.get(key)??0)+1);return send({error:'Media changed since this editor opened. Reload the gallery before applying your changes.'},409)}
      writes.push({productId,context,collection:body.collection}); if(body.collection===null) galleries.delete(key);else galleries.set(key,body.collection);revision.set(key,(revision.get(key)??0)+1)
    }
    return send({ revision:rev(), productId, title:'Touring jacket', context, assets, collection:galleries.get(key)??neutral, hasOverride:galleries.has(key), source:galleries.has(key)?'locale':'library', missingAssetIds:[] })
  } catch { return send({error:'Invalid media request'},422) }
}) } }] })
await server.listen(); console.log('Product media QA: http://127.0.0.1:3167')
