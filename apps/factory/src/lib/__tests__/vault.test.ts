/** F1 — secrets round-trip; tampering is detected (GCM auth tag). */
import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../vault";

beforeAll(() => {
  process.env.FACTORY_ENCRYPTION_KEY = "a".repeat(64);
});

describe("vault", () => {
  it("round-trips", () => {
    const secret = "1//refresh-token-example";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });
  it("produces distinct ciphertexts (random IV)", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });
  it("rejects tampered ciphertext", () => {
    const wire = encryptSecret("payload");
    const [iv, tag, ct] = wire.split(":");
    const flipped = ct.slice(0, -1) + (ct.endsWith("0") ? "1" : "0");
    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
  });
  it("refuses a missing/malformed key", () => {
    const prev = process.env.FACTORY_ENCRYPTION_KEY;
    process.env.FACTORY_ENCRYPTION_KEY = "too-short";
    expect(() => encryptSecret("x")).toThrow(/FACTORY_ENCRYPTION_KEY/);
    process.env.FACTORY_ENCRYPTION_KEY = prev;
  });
});
