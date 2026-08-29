import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import {
  EBAY_SIGNED_PATH_PATTERNS,
  buildEbaySignatureBase,
  ebayContentDigest,
  ebaySignatureAppliesTo,
  signEbayRequest,
} from './signing.js';
import { createEbaySigningKey, generateLocalEd25519KeyPair, getEbaySigningKey } from './key-management.js';

/** `sig1=:<b64>:` → signature bytes. */
function signatureBytes(header: string): Buffer {
  const m = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(header);
  if (!m) throw new Error(`bad Signature header: ${header}`);
  return Buffer.from(m[1], 'base64');
}

// eBay's published Ed25519 test key (the RFC 9421 Appendix B.1.4 key), from
// github.com/eBay/digital-signature-nodejs-sdk __tests__/test.json and the
// digital-signature-verification-ebay-api README. Test material only.
const EBAY_TEST_ED25519_PRIVATE_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF\n-----END PRIVATE KEY-----';
const EBAY_TEST_ED25519_PUBLIC_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=\n-----END PUBLIC KEY-----';

describe('signEbayRequest', () => {
  it('(a) Ed25519 output verifies against an independently rebuilt RFC 9421 signature base', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwe = 'eyJ.test.jwe';
    const body = '{"orderId":"12-34567-89012","reasonForRefund":"BUYER_CANCEL"}';

    const headers = signEbayRequest({
      method: 'post',
      url: 'https://apiz.ebay.com/sell/fulfillment/v1/order/12-34567-89012/issue_refund?foo=bar',
      body,
      jwe,
      privateKeyPem,
      created: 1700000000,
    });

    // Rebuilt by hand, not via the module — this IS the contract.
    const expectedBase = [
      `"content-digest": sha-256=:${createHash('sha256').update(body, 'utf8').digest('base64')}:`,
      `"x-ebay-signature-key": ${jwe}`,
      '"@method": POST',
      '"@path": /sell/fulfillment/v1/order/12-34567-89012/issue_refund',
      '"@authority": apiz.ebay.com',
      '"@signature-params": ("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created=1700000000',
    ].join('\n');

    expect(Object.keys(headers)).toEqual(['Content-Digest', 'x-ebay-signature-key', 'Signature-Input', 'Signature']);
    expect(headers['x-ebay-signature-key']).toBe(jwe);
    expect(headers['Signature-Input']).toBe(
      'sig1=("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created=1700000000',
    );
    expect(verify(null, Buffer.from(expectedBase, 'utf8'), publicKey, signatureBytes(headers.Signature))).toBe(true);
    // A one-byte change to the base must not verify (the guard can fail).
    expect(verify(null, Buffer.from(expectedBase + ' ', 'utf8'), publicKey, signatureBytes(headers.Signature))).toBe(false);
  });

  it('(b) Content-Digest matches the RFC 9530 / eBay example', () => {
    expect(ebayContentDigest('{"hello": "world"}')).toBe('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:');
    expect(ebayContentDigest(Buffer.from('{"hello": "world"}'))).toBe('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:');
    const headers = signEbayRequest({
      method: 'POST',
      url: 'http://localhost:8080/test',
      body: '{"hello": "world"}',
      jwe: 'x',
      privateKeyPem: EBAY_TEST_ED25519_PRIVATE_PEM,
    });
    expect(headers['Content-Digest']).toBe('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:');
  });

  it('(c) GET omits Content-Digest from the headers and from the component list', () => {
    const headers = signEbayRequest({
      method: 'GET',
      url: 'https://apiz.ebay.com/sell/finances/v1/transaction?limit=5&offset=0',
      jwe: 'jwe-value',
      privateKeyPem: EBAY_TEST_ED25519_PRIVATE_PEM,
      created: 1700000000,
    });
    expect(headers['Content-Digest']).toBeUndefined();
    expect('Content-Digest' in headers).toBe(false);
    expect(headers['Signature-Input']).toBe('sig1=("x-ebay-signature-key" "@method" "@path" "@authority");created=1700000000');

    const expectedBase = [
      '"x-ebay-signature-key": jwe-value',
      '"@method": GET',
      '"@path": /sell/finances/v1/transaction',
      '"@authority": apiz.ebay.com',
      '"@signature-params": ("x-ebay-signature-key" "@method" "@path" "@authority");created=1700000000',
    ].join('\n');
    const pub = createPublicKey(EBAY_TEST_ED25519_PUBLIC_PEM);
    expect(verify(null, Buffer.from(expectedBase), pub, signatureBytes(headers.Signature))).toBe(true);

    // An empty body is "no body" too (eBay SDK: needsContentDigestValidation → length > 0).
    for (const body of ['', Buffer.alloc(0), null, undefined]) {
      const h = signEbayRequest({ method: 'GET', url: 'https://apiz.ebay.com/sell/finances/v1/payout', body, jwe: 'j', privateKeyPem: EBAY_TEST_ED25519_PRIVATE_PEM });
      expect(h['Content-Digest']).toBeUndefined();
      expect(h['Signature-Input']).toMatch(/^sig1=\("x-ebay-signature-key" "@method" "@path" "@authority"\);created=\d+$/);
    }
  });

  it('@path excludes the query string and @authority keeps an explicit port', () => {
    const built = buildEbaySignatureBase({
      method: 'get',
      url: 'http://localhost:8080/sell/finances/v1/transaction?limit=5&transaction_type=SALE#frag',
      jwe: 'j',
      created: 1,
    });
    expect(built.path).toBe('/sell/finances/v1/transaction');
    expect(built.authority).toBe('localhost:8080');
    expect(built.method).toBe('GET');
    expect(built.base).not.toContain('limit=5');
    expect(buildEbaySignatureBase({ method: 'GET', url: 'https://apiz.ebay.com:443/x', jwe: 'j', created: 1 }).authority).toBe('apiz.ebay.com');
  });

  it('(d) `created` is honoured when given, floored to an integer, and defaults to now', () => {
    const base = { method: 'GET', url: 'https://apiz.ebay.com/sell/finances/v1/payout', jwe: 'j', privateKeyPem: EBAY_TEST_ED25519_PRIVATE_PEM };
    expect(signEbayRequest({ ...base, created: 1658440308 })['Signature-Input']).toMatch(/;created=1658440308$/);
    expect(signEbayRequest({ ...base, created: 1658440308.9 })['Signature-Input']).toMatch(/;created=1658440308$/);
    const before = Math.floor(Date.now() / 1000);
    const created = Number(/created=(\d+)$/.exec(signEbayRequest(base)['Signature-Input'])![1]);
    const after = Math.floor(Date.now() / 1000);
    expect(Number.isInteger(created)).toBe(true);
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
    expect(() => signEbayRequest({ ...base, created: Number.NaN })).toThrow(/created/);
  });

  it('(e) reproduces eBay SDK test vector ED25519_SIGN byte for byte', () => {
    // digital-signature-nodejs-sdk __tests__/index.test.ts "should be able to generate 'Signature' header with given JWE"
    const jwe =
      'eyJhbGciOiJBMjU2R0NNS1ciLCJlbmMiOiJBMjU2R0NNIiwiemlwIjoiREVGIiwiaXYiOiJvSzFwdXJNVHQtci14VUwzIiwidGFnIjoiTjB4WjI4ZklZckFmYkd5UWFrTnpjZyJ9.AYdKU7ObIc7Z764OrlKpwUViK8Rphxl0xMP9v2_o9mI.1DbZiSQNRK6pLeIw.Yzp3IDV8RM_h_lMAnwGpMA4DXbaDdmqAh-65kO9xyDgzHD6s0kY3p-yO6oPR9kEcAbjGXIULeQKWVYzbfHKwXTY09Npj_mNuO5yxgZtWnL55uIgP2HL1So2dKkZRK0eyPa6DEXJT71lPtwZtpIGyq9R5h6s3kGMbqA.m4t_MX4VnlXJGx1X_zZ-KQ';
    const headers = signEbayRequest({
      method: 'POST',
      url: 'https://localhost:8080/test',
      body: '{"hello": "world"}',
      jwe,
      privateKeyPem: EBAY_TEST_ED25519_PRIVATE_PEM,
      created: 1663459378,
    });
    expect(headers['Content-Digest']).toBe('sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:');
    expect(headers['Signature-Input']).toBe(
      'sig1=("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created=1663459378',
    );
    expect(headers.Signature).toBe(
      'sig1=:gkk7dqudw21DFHDVBoRUWe/F6/2hTEmWRFDBxiN6COD4PjozXziiDFML1nFHu+0UcMXC/niltxzABjnugu4DCA==:',
    );
  });

  it('(e) reproduces the eBay verification-server README curl sample byte for byte', () => {
    // github.com/eBay/digital-signature-verification-ebay-api README "Testing a Signature"
    const jwe =
      'eyJ6aXAiOiJERUYiLCJlbmMiOiJBMjU2R0NNIiwidGFnIjoiSXh2dVRMb0FLS0hlS0Zoa3BxQ05CUSIsImFsZyI6IkEyNTZHQ01LVyIsIml2IjoiaFd3YjNoczk2QzEyOTNucCJ9.2o02pR9SoTF4g_5qRXZm6tF4H52TarilIAKxoVUqjd8.3qaF0KJN-rFHHm_P.AMUAe9PPduew09mANIZ-O_68CCuv6EIx096rm9WyLZnYz5N1WFDQ3jP0RBkbaOtQZHImMSPXIHVaB96RWshLuJsUgCKmTAwkPVCZv3zhLxZVxMXtPUuJ-ppVmPIv0NzznWCOU5Kvb9Xux7ZtnlvLXgwOFEix-BaWNomUAazbsrUCbrp514GIea3butbyxXLNi6R9TJUNh8V2uan-optT1MMyS7eMQnVGL5rYBULk.9K5ucUqAu0DqkkhgubsHHw';
    const headers = signEbayRequest({
      method: 'POST',
      url: 'http://localhost:8080/verifysignature',
      body: Buffer.from('{"hello": "world"}'),
      jwe,
      privateKeyPem: EBAY_TEST_ED25519_PRIVATE_PEM,
      created: 1658440308,
    });
    expect(headers.Signature).toBe(
      'sig1=:ZMUpAejnqrt6POSx02ltx3cT9YODV2r+Cem/BKOagDSfztKOtCsjP/MxZqmY+FVJ3/8E4BL76T9Fjty8oJnsAw==:',
    );
  });

  it('RSA keys sign with RSASSA-PKCS1-v1_5 / SHA-256', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const headers = signEbayRequest({
      method: 'POST',
      url: 'https://apiz.ebay.com/post-order/v2/return/5000012345/decide',
      body: '{"decision":"APPROVE"}',
      jwe: 'j',
      privateKeyPem,
      created: 1700000000,
    });
    const built = buildEbaySignatureBase({
      method: 'POST',
      url: 'https://apiz.ebay.com/post-order/v2/return/5000012345/decide',
      body: '{"decision":"APPROVE"}',
      jwe: 'j',
      created: 1700000000,
    });
    expect(verify('sha256', Buffer.from(built.base), publicKey, signatureBytes(headers.Signature))).toBe(true);
  });

  it('rejects unsupported key types and missing secrets', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signEbayRequest({ method: 'GET', url: 'https://apiz.ebay.com/x', jwe: 'j', privateKeyPem: pem })).toThrow(/unsupported/);
    expect(() => signEbayRequest({ method: 'GET', url: 'https://apiz.ebay.com/x', jwe: '', privateKeyPem: EBAY_TEST_ED25519_PRIVATE_PEM })).toThrow(/jwe/);
    expect(() => signEbayRequest({ method: 'GET', url: 'https://apiz.ebay.com/x', jwe: 'j', privateKeyPem: '' })).toThrow(/privateKeyPem/);
  });
});

describe('ebaySignatureAppliesTo', () => {
  it('(f) is true for every in-scope REST method', () => {
    const positives: Array<[string, string]> = [
      ['https://apiz.ebay.com/sell/finances/v1/transaction?limit=5', 'GET'],
      ['https://apiz.ebay.com/sell/finances/v1/payout/5000012345', 'GET'],
      ['https://apiz.ebay.com/sell/finances/v1/transaction_summary', 'get'],
      ['https://apiz.sandbox.ebay.com/sell/finances/v1/seller_funds_summary', 'GET'],
      ['/sell/finances/v1/transfer/123', 'GET'],
      ['https://api.ebay.com/sell/fulfillment/v1/order/12-34567-89012/issue_refund', 'POST'],
      ['https://api.ebay.com/post-order/v2/inquiry/5000012345/issue_refund', 'POST'],
      ['https://api.ebay.com/post-order/v2/casemanagement/5000012345/issue_refund', 'POST'],
      ['https://api.ebay.com/post-order/v2/return/5000012345/issue_refund', 'POST'],
      ['https://api.ebay.com/post-order/v2/return/5000012345/decide', 'POST'],
      ['https://api.ebay.com/post-order/v2/cancellation/5000012345/approve', 'POST'],
      ['https://api.ebay.com/post-order/v2/cancellation', 'POST'],
      ['post-order/v2/cancellation?x=1', 'post'],
    ];
    for (const [url, method] of positives) expect(ebaySignatureAppliesTo(url, method), `${method} ${url}`).toBe(true);
  });

  it('(f) is false for everything else', () => {
    const negatives: Array<[string, string]> = [
      ['https://api.ebay.com/sell/fulfillment/v1/order/12-34567-89012', 'GET'],
      ['https://api.ebay.com/sell/fulfillment/v1/order/12-34567-89012/issue_refund', 'GET'],
      ['https://api.ebay.com/sell/fulfillment/v1/order/12-34567-89012/shipping_fulfillment', 'POST'],
      ['https://api.ebay.com/post-order/v2/cancellation/5000012345/reject', 'POST'],
      ['https://api.ebay.com/post-order/v2/cancellation/5000012345', 'GET'],
      ['https://api.ebay.com/post-order/v2/return/5000012345', 'GET'],
      ['https://api.ebay.com/post-order/v2/return/5000012345/decide', 'GET'],
      ['https://api.ebay.com/sell/inventory/v1/inventory_item', 'GET'],
      ['https://api.ebay.com/sell/financesx/v1/transaction', 'GET'],
      ['https://api.ebay.com/commerce/identity/v1/user/', 'GET'],
      ['https://api.ebay.com/ws/api.dll', 'POST'],
    ];
    for (const [url, method] of negatives) expect(ebaySignatureAppliesTo(url, method), `${method} ${url}`).toBe(false);
  });

  it('the pattern list is extensible by the caller', () => {
    const before = EBAY_SIGNED_PATH_PATTERNS.length;
    EBAY_SIGNED_PATH_PATTERNS.push({ path: /^\/sell\/custom\/v1\/thing$/, methods: ['PUT'], label: 'test' });
    try {
      expect(ebaySignatureAppliesTo('https://api.ebay.com/sell/custom/v1/thing', 'PUT')).toBe(true);
      expect(ebaySignatureAppliesTo('https://api.ebay.com/sell/custom/v1/thing', 'GET')).toBe(false);
    } finally {
      EBAY_SIGNED_PATH_PATTERNS.splice(before);
    }
  });
});

describe('key-management', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('generateLocalEd25519KeyPair yields PEMs that sign and verify', () => {
    const pair = generateLocalEd25519KeyPair();
    expect(pair.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(pair.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const headers = signEbayRequest({ method: 'GET', url: 'https://apiz.ebay.com/sell/finances/v1/payout', jwe: 'j', privateKeyPem: pair.privateKey, created: 5 });
    const built = buildEbaySignatureBase({ method: 'GET', url: 'https://apiz.ebay.com/sell/finances/v1/payout', jwe: 'j', created: 5 });
    expect(verify(null, Buffer.from(built.base), createPublicKey(pair.publicKey), signatureBytes(headers.Signature))).toBe(true);
  });

  it('createEbaySigningKey POSTs {signingKeyCipher} to apiz.ebay.com and returns the key material', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          creationTime: 1700000000,
          expirationTime: 1731536000,
          jwe: 'eyJ.jwe',
          privateKey: 'MC4CAQAw...private',
          publicKey: 'MCowBQYD...public',
          signingKeyCipher: 'ED25519',
          signingKeyId: 'a1b2c3',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });

    const key = await createEbaySigningKey({ appAccessToken: 'v^1.1#app-token' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://apiz.ebay.com/developer/key_management/v1/signing_key');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{"signingKeyCipher":"ED25519"}');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer v^1.1#app-token');
    expect(h['Content-Type']).toBe('application/json');
    expect(key).toEqual({
      signingKeyId: 'a1b2c3',
      jwe: 'eyJ.jwe',
      privateKey: '-----BEGIN PRIVATE KEY-----\nMC4CAQAw...private\n-----END PRIVATE KEY-----',
      publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYD...public\n-----END PUBLIC KEY-----',
      signingKeyCipher: 'ED25519',
      creationTime: '1700000000',
      expirationTime: '1731536000',
    });

    await createEbaySigningKey({ appAccessToken: 't', apiBase: 'https://apiz.sandbox.ebay.com/', cipher: 'RSA' });
    expect(calls[1].url).toBe('https://apiz.sandbox.ebay.com/developer/key_management/v1/signing_key');
    expect(calls[1].init.body).toBe('{"signingKeyCipher":"RSA"}');
  });

  it('keeps a PEM-formatted key untouched and wraps a bare base64 one', async () => {
    const pair = generateLocalEd25519KeyPair();
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ jwe: 'j', privateKey: pair.privateKey, publicKey: pair.publicKey, signingKeyCipher: 'ED25519', signingKeyId: 'k' }), { status: 200 }),
    );
    const key = await createEbaySigningKey({ appAccessToken: 't' });
    expect(key.privateKey).toBe(pair.privateKey);
    expect(key.publicKey).toBe(pair.publicKey);
    expect(key.creationTime).toBeUndefined();
    // The returned private key signs directly.
    expect(() => signEbayRequest({ method: 'GET', url: 'https://apiz.ebay.com/sell/finances/v1/payout', jwe: key.jwe, privateKeyPem: key.privateKey })).not.toThrow();
  });

  it('getEbaySigningKey GETs /signing_key/{id} and never returns a private key', async () => {
    let seen = '';
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen = `${init.method} ${url}`;
      return new Response(JSON.stringify({ jwe: 'j', publicKey: 'pub', signingKeyCipher: 'ED25519', signingKeyId: 'k1', creationTime: 1, expirationTime: 2 }), { status: 200 });
    });
    const key = await getEbaySigningKey('k1', { appAccessToken: 't' });
    expect(seen).toBe('GET https://apiz.ebay.com/developer/key_management/v1/signing_key/k1');
    expect(key.signingKeyId).toBe('k1');
    expect(key.jwe).toBe('j');
    expect((key as Record<string, unknown>).privateKey).toBeUndefined();
  });

  it('throws with status + eBay error body on non-2xx, without leaking the token', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ errors: [{ errorId: 1001, message: 'Invalid access token' }] }), { status: 401, statusText: 'Unauthorized' }),
    );
    const token = 'v^1.1#SECRET-TOKEN';
    let err: Error | undefined;
    try {
      await createEbaySigningKey({ appAccessToken: token });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('401');
    expect(err!.message).toContain('Invalid access token');
    expect(err!.message).not.toContain('SECRET-TOKEN');
    expect((err as Error & { status?: number }).status).toBe(401);
  });

  it('rejects a 2xx that lacks the key material', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ signingKeyId: 'k', jwe: 'j', publicKey: 'p', signingKeyCipher: 'ED25519' }), { status: 200 }),
    );
    await expect(createEbaySigningKey({ appAccessToken: 't' })).rejects.toThrow(/privateKey/);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    await expect(createEbaySigningKey({ appAccessToken: 't' })).rejects.toThrow(/empty 204/);
  });
});
