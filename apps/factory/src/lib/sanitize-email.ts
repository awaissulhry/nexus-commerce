/**
 * FP1.1 — email HTML sanitizer. Email bodies are UNTRUSTED INPUT even in a
 * local-first app: sanitized once at WRITE time (stored render-safe), then
 * rendered inside a sandboxed iframe whose CSP blocks remote images by
 * default (MessageBubble). Three layers; this is the first and strictest.
 * Policy: keep email formatting (tables, inline styles, links, images),
 * strip anything executable or exfiltrating (scripts, handlers, forms,
 * url() styles).
 */
import sanitizeHtml from "sanitize-html";

// value must not smuggle url(...) or expressions; otherwise permissive
const SAFE_VALUE = [/^(?:(?!url\s*\(|expression\s*\().)*$/i];

const ALLOWED_STYLES: Record<string, RegExp[]> = Object.fromEntries(
  [
    "color",
    "background-color",
    "background",
    "font",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-align",
    "text-decoration",
    "text-transform",
    "line-height",
    "letter-spacing",
    "vertical-align",
    "margin",
    "margin-top",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "padding",
    "padding-top",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "border",
    "border-top",
    "border-bottom",
    "border-left",
    "border-right",
    "border-radius",
    "border-color",
    "border-collapse",
    "width",
    "max-width",
    "min-width",
    "height",
    "display",
    "white-space",
    "word-break",
  ].map((prop) => [prop, SAFE_VALUE]),
);

export function sanitizeEmailHtml(dirty: string): string {
  return sanitizeHtml(dirty, {
    allowedTags: [
      "a", "b", "i", "em", "strong", "u", "s", "strike", "small", "sub", "sup",
      "p", "div", "span", "br", "hr", "blockquote", "pre", "code",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li",
      "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "center",
      "img", "font",
    ],
    allowedAttributes: {
      a: ["href", "name", "title", "target", "rel"], // target/rel are ADDED by transformTags — the allowlist must not strip them back out
      img: ["src", "alt", "title", "width", "height"],
      font: ["color", "face", "size"],
      td: ["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor", "style"],
      th: ["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor", "style"],
      table: ["width", "height", "align", "border", "cellpadding", "cellspacing", "bgcolor", "style"],
      "*": ["style", "align", "dir"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
    allowedStyles: { "*": ALLOWED_STYLES },
    disallowedTagsMode: "discard",
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }, true),
    },
  });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain-text part → display-safe HTML (escape + line breaks + naive links). */
export function textToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
  return `<div style="white-space: pre-wrap; word-break: break-word;">${linked}</div>`;
}
