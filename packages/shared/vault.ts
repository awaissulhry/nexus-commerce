import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export class Vault {
  private readonly key: Buffer;

  constructor(encryptionKey: string) {
    // Key must be a 64-char hex string (32 bytes) for AES-256
    if (!/^[0-9a-f]{64}$/i.test(encryptionKey)) {
      throw new Error("ENCRYPTION_KEY must be a 64-character hex string");
    }
    this.key = Buffer.from(encryptionKey, "hex");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12); // 96-bit IV recommended for GCM
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag(); // 128-bit tag ensures integrity
    // Wire format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
  }

  decrypt(ciphertext: string): string {
    const parts = ciphertext.split(":");
    if (parts.length !== 3) throw new Error("Invalid ciphertext format");
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);
    return (
      decipher.update(encrypted).toString("utf8") + decipher.final("utf8")
    );
  }
}
