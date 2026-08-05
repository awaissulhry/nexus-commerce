import { streamWorkbook } from '../src/services/advertising/bulksheet/spreadsheet-adapter.js'
const heads = async (p: string, sheet: string) => {
  let h: string[] = []
  await streamWorkbook(p, async (_r, hh) => { if (!h.length) h = hh }, { skipSheets: (n) => n !== sheet })
  return h
}
const amz = await heads(process.argv[2]!, 'Sponsored Products Campaigns')
const our = await heads(process.argv[3]!, 'Sponsored Products Campaigns')
const ourNoMeta = our.filter((x) => !x.startsWith('_'))
console.log(`Amazon: ${amz.length} cols   Ours: ${ourNoMeta.length} cols (+${our.length - ourNoMeta.length} hidden ours)`)
const missing = amz.filter((x) => !our.includes(x))
const extra = ourNoMeta.filter((x) => !amz.includes(x))
console.log('ORDER MATCHES EXACTLY:', JSON.stringify(amz) === JSON.stringify(ourNoMeta))
console.log('missing vs Amazon:', missing.length ? missing : '(none)')
console.log('extra vs Amazon  :', extra.length ? extra : '(none)')
