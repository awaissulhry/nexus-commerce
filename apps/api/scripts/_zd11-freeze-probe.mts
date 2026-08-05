/** Does the CURRENT (unmodified-by-me) adapter throw on a frozen sheet? */
import { createWriter } from '../src/services/advertising/bulksheet/spreadsheet-adapter.js'
const w = await createWriter()
try {
  w.addSheet({ name: 'T', columns: [{ header: 'A', type: 'text' }], freeze: { rows: 1, columns: 1 } })
  console.log('RESULT: freeze OK')
} catch (e) { console.log('RESULT: THROWS ->', (e as Error).message) }
try {
  w.addSheet({ name: 'U', columns: [{ header: 'A', type: 'text' }] })
  console.log('RESULT: no-freeze OK')
} catch (e) { console.log('RESULT: no-freeze THROWS ->', (e as Error).message) }
