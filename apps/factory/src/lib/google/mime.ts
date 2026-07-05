/**
 * FP1.1 — RFC 2822 MIME builder for Gmail replies. Threading requires ALL
 * THREE (F0-ARCHITECTURE §Gmail): the send call's threadId, In-Reply-To /
 * References headers, and a matching Subject — this module owns the last
 * two. Pure function, unit-tested; returns base64url raw for messages.send.
 */

export type MimeAttachment = { filename: string; mimeType: string; content: Buffer };

export type ReplyMimeInput = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  inReplyTo?: string | null; // the last inbound message's RFC Message-ID (with <>)
  text: string;
  attachments?: MimeAttachment[];
};

const needsEncoding = (s: string) => /[^\x20-\x7e]/.test(s);

/** RFC 2047 encoded-word (UTF-8, B-encoding) for non-ASCII header values. */
export function encodeHeaderValue(value: string): string {
  if (!needsEncoding(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** "Re: x" exactly once, case-insensitive, whitespace-tolerant. */
export function replySubject(original: string): string {
  const s = (original ?? "").trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

const wrap76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");

export function buildReplyMime(input: ReplyMimeInput): string {
  const headers: string[] = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeHeaderValue(input.subject)}`,
    ...(input.inReplyTo
      ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]
      : []),
    "MIME-Version: 1.0",
  ];

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(input.text, "utf8").toString("base64")),
  ].join("\r\n");

  let raw: string;
  if (!input.attachments?.length) {
    raw = [...headers, textPart].join("\r\n");
  } else {
    const boundary = `factory_${Math.random().toString(36).slice(2)}_boundary`;
    const parts = [
      textPart,
      ...input.attachments.map((att) =>
        [
          `Content-Type: ${att.mimeType || "application/octet-stream"}; name="${att.filename.replace(/"/g, "")}"`,
          "Content-Transfer-Encoding: base64",
          `Content-Disposition: attachment; filename="${att.filename.replace(/"/g, "")}"`,
          "",
          wrap76(att.content.toString("base64")),
        ].join("\r\n"),
      ),
    ];
    raw = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      ...parts.flatMap((p) => [`--${boundary}`, p]),
      `--${boundary}--`,
    ].join("\r\n");
  }

  return Buffer.from(raw, "utf8").toString("base64url");
}
