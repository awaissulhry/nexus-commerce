/** FP1.1 — reply threading lives or dies on these headers. */
import { describe, expect, it } from "vitest";
import { buildReplyMime, encodeHeaderValue, replySubject } from "../google/mime";

const decodeRaw = (b64url: string) => Buffer.from(b64url, "base64url").toString("utf8");

describe("replySubject", () => {
  it("prefixes Re: exactly once", () => {
    expect(replySubject("Order 652")).toBe("Re: Order 652");
    expect(replySubject("Re: Order 652")).toBe("Re: Order 652");
    expect(replySubject("RE:  Order 652")).toBe("RE:  Order 652");
  });
});

describe("encodeHeaderValue", () => {
  it("leaves ASCII alone, RFC-2047-encodes the rest", () => {
    expect(encodeHeaderValue("Order 652")).toBe("Order 652");
    const enc = encodeHeaderValue("Perché è così");
    expect(enc).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(Buffer.from(enc.slice(10, -2), "base64").toString("utf8")).toBe("Perché è così");
  });
});

describe("buildReplyMime", () => {
  const base = {
    from: "factory@example.com",
    to: ["customer@example.com"],
    subject: "Re: AWA ORDER 652/2026",
    inReplyTo: "<abc123@mail.gmail.com>",
    text: "Ciao Mario,\n\nconfermiamo l'ordine.",
  };

  it("carries all three threading ingredients' header half", () => {
    const raw = decodeRaw(buildReplyMime(base));
    expect(raw).toContain("In-Reply-To: <abc123@mail.gmail.com>");
    expect(raw).toContain("References: <abc123@mail.gmail.com>");
    expect(raw).toContain("Subject: Re: AWA ORDER 652/2026");
    expect(raw).toContain("To: customer@example.com");
  });

  it("omits threading headers when there is nothing to thread to", () => {
    const raw = decodeRaw(buildReplyMime({ ...base, inReplyTo: null }));
    expect(raw).not.toContain("In-Reply-To");
    expect(raw).not.toContain("References");
  });

  it("round-trips UTF-8 body via base64", () => {
    const raw = decodeRaw(buildReplyMime(base));
    const bodyB64 = raw.split("\r\n\r\n").pop()!.replace(/\r\n/g, "");
    expect(Buffer.from(bodyB64, "base64").toString("utf8")).toContain("confermiamo l'ordine");
  });

  it("builds multipart/mixed with attachments", () => {
    const raw = decodeRaw(
      buildReplyMime({
        ...base,
        attachments: [{ filename: "quote.pdf", mimeType: "application/pdf", content: Buffer.from("PDFDATA") }],
      }),
    );
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain('Content-Disposition: attachment; filename="quote.pdf"');
    expect(raw).toContain(Buffer.from("PDFDATA").toString("base64"));
  });

  it("returns base64url (no +, /, =)", () => {
    const b64url = buildReplyMime(base);
    expect(b64url).not.toMatch(/[+/=]/);
  });
});
