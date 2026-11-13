import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto'
import type { VapidKeys } from './web-push'

/**
 * Test support for push (B-W2b-385): a browser's side of Web Push — its subscription keys and the decryption of what the push
 * service hands it (RFC 8291 / RFC 8188 aes128gcm, the mirror of web-push.ts encryptForDevice) — and a made-up VAPID pair.
 * Tests use it to read each push exactly as the phone would, so the text per reader (PLT-152) is checked on the wire.
 */

const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac('sha256', key).update(data).digest()

/** A made-up VAPID key pair (local and test only). */
export function testVapid(subject = 'mailto:push-test@example.com'): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url'), subject }
}

export interface TestBrowser {
  /** What the browser's PushSubscription.toJSON().keys gives. */
  readonly keys: { readonly p256dh: string; readonly auth: string }
  /** Opens one pushed body (aes128gcm) as this browser: the JSON it carried. */
  open(body: Uint8Array): unknown
}

/** A browser that turned push on: its own P-256 key pair and auth secret. */
export function testBrowser(): TestBrowser {
  const ecdh = createECDH('prime256v1')
  const publicKey = ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') },
    open(body) {
      const data = Buffer.from(body)
      const salt = data.subarray(0, 16)
      const idLength = data[20]!
      const serverPublic = data.subarray(21, 21 + idLength)
      const sealed = data.subarray(21 + idLength)
      const shared = ecdh.computeSecret(serverPublic)
      const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), publicKey, serverPublic, Buffer.from([1])]))
      const prk = hmac(salt, ikm)
      const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16)
      const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12)
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(sealed.subarray(sealed.length - 16))
      const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
      // The last record ends with its delimiter 0x02 (then no padding).
      const end = padded.lastIndexOf(2)
      return JSON.parse(padded.subarray(0, end).toString('utf8'))
    },
  }
}
