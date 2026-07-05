/**
 * F1 — secret storage for integration credentials (Google refresh token,
 * Sendcloud keys). AES-256-GCM, wire format `<iv_hex>:<authTag_hex>:<ct_hex>`
 * — same shape as the proven @nexus/shared Vault, reimplemented here with the
 * factory's OWN key env (FACTORY_ENCRYPTION_KEY, 64-char hex) so the two
 * platforms never share key material. The key is never logged or printed.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const hex = process.env.FACTORY_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "FACTORY_ENCRYPTION_KEY missing or not 64-char hex. Run `npm run setup -w @nexus/factory` to generate one into apps/factory/.env.",
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
}

export function decryptSecret(wire: string): string {
  const [ivHex, tagHex, ctHex] = wire.split(":");
  if (!ivHex || !tagHex || !ctHex) throw new Error("vault: malformed ciphertext");
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}
