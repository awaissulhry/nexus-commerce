import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { TRANSFER_MAX_FILE_BYTES } from './catalog-transfer-file.js'

export function publicSourceAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase()
    // Restrict IPv6 to global unicast, excluding mapped/transition/local ranges.
    return /^[23]/.test(a) && !a.startsWith('2001:') && !a.startsWith('2002:')
  }
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0)
}

/** Pin the validated DNS answer, limit time/bytes and refuse redirects to other destinations. */
export async function fetchCatalogSource(sourceUrl: string) {
  const url = new URL(sourceUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new Error('Use a public HTTP(S) source URL without embedded credentials or a custom port')
  const answers = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (!answers.length || answers.some(a => !publicSourceAddress(a.address))) throw new Error('Source URL must resolve to a public internet address')
  const address = answers[0]
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      lookup: ((_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)) as never,
      signal: AbortSignal.timeout(30_000), headers: { 'Accept-Encoding': 'identity' },
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Source returned HTTP ${response.statusCode}; redirects are not followed`)); return }
      if (Number(response.headers['content-length']) > TRANSFER_MAX_FILE_BYTES) { request.destroy(new Error('Source exceeds 10 MB')); return }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > TRANSFER_MAX_FILE_BYTES) request.destroy(new Error('Source exceeds 10 MB'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => resolve(Buffer.concat(chunks)))
    })
    request.on('error', reject)
  })
  return { buffer, filename: decodeURIComponent(url.pathname.split('/').pop() || 'source.csv') }
}
