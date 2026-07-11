/**
 * FS3 — pure @mention token math for MentionTextarea. Client-side ONLY: the
 * server keeps resolving handles exactly as before (src/lib/comments.ts
 * resolveMentions — email, email prefix, dotted display name, first name).
 * `handleFor` mirrors the dotted-display-name rule so an inserted handle is
 * guaranteed to resolve.
 */

export interface MentionToken {
  /** index of the `@` in the text */
  start: number;
  /** what has been typed after the `@` (may be empty) */
  query: string;
}

// characters that may legally appear inside a handle (matches the server's
// MENTION_RE token class: word chars, dot, plus, hyphen — dash LAST so the
// class never forms an accidental range)
const HANDLE_CHAR = /[\w.+-]/;

/**
 * The active mention token at the caret, or null. A token starts at an `@`
 * that begins the text or follows whitespace, and runs in handle characters
 * up to the caret with no whitespace in between. ONE inner `@` is allowed
 * (email handles, mirroring the server's optional @domain part) — an `@`
 * glued to a preceding word without an opener stays a plain email.
 */
export function mentionQueryAt(text: string, caret: number): MentionToken | null {
  if (caret < 1 || caret > text.length) return null;
  let i = caret - 1;
  let innerAt = false;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") {
      // an opener: `@` at the start of the text or after whitespace
      if (i === 0 || /\s/.test(text[i - 1])) return { start: i, query: text.slice(i + 1, caret) };
      // otherwise it may be the single @domain separator of an email handle
      if (innerAt) return null;
      innerAt = true;
      i--;
      continue;
    }
    if (!HANDLE_CHAR.test(ch)) return null;
    i--;
  }
  return null;
}

/** Replace the active token with `@handle ` and report the new caret position. */
export function insertMention(text: string, token: MentionToken, caret: number, handle: string): { text: string; caret: number } {
  const inserted = `@${handle} `;
  const next = text.slice(0, token.start) + inserted + text.slice(caret);
  return { text: next, caret: token.start + inserted.length };
}

/** The dotted handle the server resolves for a display name ("Ada Lovelace" → "ada.lovelace"). */
export const handleFor = (displayName: string): string => displayName.trim().toLowerCase().replace(/\s+/g, ".");
