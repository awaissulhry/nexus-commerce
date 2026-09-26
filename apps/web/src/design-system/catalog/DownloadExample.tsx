'use client'
import { KeyValue } from '../components/KeyValue'
import { Button } from '../primitives/Button'
import { downloadBlob, filenameFromContentDisposition } from '../lib/download'

const HEADERS = [
  'attachment; filename="nexus-products.xlsx"',
  "attachment; filename=\"prezzi.xlsx\"; filename*=UTF-8''%E2%82%AC%20prezzi.xlsx",
  'attachment',
]

export function DownloadExample() {
  return <section id="download-example"><h3>downloadBlob · downloadResponse</h3>
    <p>The one Blob to file hand-off. downloadResponse names the file from Content-Disposition (filename* wins over filename) and otherwise uses the fallback name the caller passes.</p>
    <KeyValue dense items={HEADERS.map((header) => ({ label: header, value: filenameFromContentDisposition(header) ?? 'No name — the fallback is used' }))} />
    <Button onClick={() => downloadBlob(new Blob(['sku,title\r\nEX-1,Example product\r\n'], { type: 'text/csv;charset=utf-8' }), 'nexus-example.csv')}>Download example file</Button>
  </section>
}
