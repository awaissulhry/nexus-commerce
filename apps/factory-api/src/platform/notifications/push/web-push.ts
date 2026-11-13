import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto'

/**
 * The Web Push request (B-W2b-385; PLT-140): what a push service is sent for one device, made in memory, with node's own
 * crypto (no package):
 *
 *   - the message is encrypted for the device (RFC 8291 "Message Encryption for Web Push", content coding aes128gcm of RFC
 *     8188): a fresh P-256 key pair per message, ECDH with the device's p256dh key, HKDF with its auth secret, AES-128-GCM,
 *     one record; the push service never reads it;
 *   - the request is signed with the server's VAPID key (RFC 8292): an ES256 JWT for the push service's origin, valid 12
 *     hours, naming the operator (`mailto:` or https), and the public key beside it (`Authorization: vapid t=…, k=…`).
 *
 * The VAPID keys are the environment's secrets (FACTORY_VAPID_PUBLIC_KEY / FACTORY_VAPID_PRIVATE_KEY / FACTORY_VAPID_SUBJECT,
 * service.ts); the device's keys are its PushSubscription's sealed secret. Nothing here sends: the push runtime's transport
 * does (service.ts).
 */

export interface VapidKeys {
  /** The uncompressed P-256 public key (65 bytes), base64url: what the browser subscribes with (applicationServerKey). */
  readonly publicKey: string
  /** The private scalar (32 bytes), base64url. */
  readonly privateKey: string
  /** `mailto:…` or `https://…`: who runs the server (the push services contact them about abuse). */
  readonly subject: string
}

export interface DeviceKeys {
  readonly p256dh: string
  readonly auth: string
}

export interface PushRequest {
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

/** A message's urgency for the push service (RFC 8030 §5.3): an approval or an alert wakes the phone, the rest may wait. */
export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high'

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const fromB64url = (text: string): Buffer => Buffer.from(text.replace(/=+$/, ''), 'base64url')
const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac('sha256', key).update(data).digest()
const RECORD_SIZE = 4096

/** What is wrong with VAPID keys (null: nothing): a P-256 pair whose halves belong together, and a subject. */
export function vapidProblem(keys: VapidKeys): string | null {
  const pub = fromB64url(keys.publicKey)
  const priv = fromB64url(keys.privateKey)
  if (pub.length !== 65 || pub[0] !== 0x04) return 'FACTORY_VAPID_PUBLIC_KEY is not an uncompressed P-256 public key (65 bytes, base64url).'
  if (priv.length !== 32) return 'FACTORY_VAPID_PRIVATE_KEY is not a P-256 private key (32 bytes, base64url).'
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(priv)
    if (!ecdh.getPublicKey().equals(pub)) return 'The VAPID private key does not belong to its public key.'
  } catch {
    return 'FACTORY_VAPID_PRIVATE_KEY is not a P-256 private key.'
  }
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(keys.subject)) return 'FACTORY_VAPID_SUBJECT is a mailto: address or an https address.'
  return null
}

function signingKey(keys: VapidKeys): KeyObject {
  const pub = fromB64url(keys.publicKey)
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64url(fromB64url(keys.privateKey)), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) }, format: 'jwk' })
}

/** The VAPID Authorization header for a push service's origin (RFC 8292 §2-3). */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, now: Date): string {
  const audience = new URL(endpoint).origin
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: keys.subject })))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: signingKey(keys), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`
}

/** The message encrypted for one device (RFC 8291 §3.4; RFC 8188 header: salt, record size, the server's key). */
export function encryptForDevice(device: DeviceKeys, plaintext: Uint8Array): Uint8Array {
  const devicePublic = fromB64url(device.p256dh)
  const authSecret = fromB64url(device.auth)
  const server = createECDH('prime256v1')
  const serverPublic = server.generateKeys()
  const shared = server.computeSecret(devicePublic)
  // HKDF-Extract(auth, ecdh) then Expand with "WebPush: info" ‖ 0 ‖ device key ‖ server key (one block: 32 bytes).
  const prkKey = hmac(authSecret, shared)
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), devicePublic, serverPublic, Buffer.from([1])]))
  const salt = randomBytes(16)
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16)
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // One record: the text, then the last-record delimiter 0x02 (no padding).
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(RECORD_SIZE)
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, sealed])
}

/** The whole request for one device: encrypted body, VAPID authorization, TTL and urgency (RFC 8030). */
export function pushRequest(input: { readonly vapid: VapidKeys; readonly endpoint: string; readonly device: DeviceKeys; readonly payload: unknown; readonly ttlSeconds: number; readonly urgency: PushUrgency; readonly topic?: string; readonly now: Date }): PushRequest {
  const body = encryptForDevice(input.device, Buffer.from(JSON.stringify(input.payload), 'utf8'))
  return {
    endpoint: input.endpoint,
    headers: {
      authorization: vapidAuthorization(input.vapid, input.endpoint, input.now),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(input.ttlSeconds),
      urgency: input.urgency,
      // A newer push of the same topic replaces one the device has not fetched yet (≤ 32 base64url characters).
      ...(input.topic ? { topic: input.topic } : {}),
    },
    body,
  }
}
