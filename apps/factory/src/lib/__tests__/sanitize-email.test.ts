/** FP1.1 — the sanitizer is the inbox's security boundary; test it like one. */
import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml, textToHtml } from "../sanitize-email";

describe("sanitizeEmailHtml", () => {
  it("strips scripts, handlers and javascript: URLs", () => {
    const dirty = `<p onclick="alert(1)">hi</p><script>alert(2)</script><a href="javascript:alert(3)">x</a><img src="x" onerror="alert(4)">`;
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("onerror");
    expect(clean).not.toContain("javascript:");
    expect(clean).toContain("hi");
  });

  it("strips iframes and forms entirely", () => {
    const clean = sanitizeEmailHtml(`<iframe src="https://evil"></iframe><form action="/x"><input></form>ok`);
    expect(clean).not.toContain("iframe");
    expect(clean).not.toContain("form");
    expect(clean).toContain("ok");
  });

  it("keeps email formatting: tables, inline styles, links, images", () => {
    const clean = sanitizeEmailHtml(
      `<table><tr><td style="color: red; padding: 4px" bgcolor="#fff">cell</td></tr></table>` +
        `<a href="https://example.com">link</a><img src="https://example.com/x.png" width="10">`,
    );
    expect(clean).toContain("<table>");
    expect(clean).toContain("color:red");
    expect(clean).toContain('href="https://example.com"');
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noopener noreferrer"');
    expect(clean).toContain("<img");
  });

  it("blocks url() smuggling in styles but keeps the rest", () => {
    const clean = sanitizeEmailHtml(`<div style="color: blue; background: url(https://evil/px.gif)">x</div>`);
    expect(clean).toContain("color:blue");
    expect(clean).not.toContain("url(");
  });

  it("allows cid:/data: only on images", () => {
    const clean = sanitizeEmailHtml(`<img src="cid:logo123"><a href="data:text/html,alert">bad</a>`);
    expect(clean).toContain('src="cid:logo123"');
    expect(clean).not.toContain('href="data:');
  });
});

describe("textToHtml", () => {
  it("escapes HTML and links URLs", () => {
    const html = textToHtml(`<b>not bold</b>\nsee https://example.com/x?a=1`);
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain('<a href="https://example.com/x?a=1"');
    expect(html).toContain("white-space: pre-wrap");
  });
});
