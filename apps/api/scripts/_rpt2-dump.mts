import { resolve } from 'path'
import { writeFileSync } from 'fs'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { getReportingCoverage } = await import('../src/services/advertising/ads-reporting-coverage.service.js')
const c = await getReportingCoverage()
writeFileSync(process.argv[2], JSON.stringify(c, null, 2))
console.log('wrote', process.argv[2])
process.exit(0)
