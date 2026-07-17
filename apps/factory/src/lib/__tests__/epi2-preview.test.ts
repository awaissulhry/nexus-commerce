/** EPI2.1 — preview pipeline pure core: the inline allowlist, cid rewriting,
 * remote-image counting, Content-ID matching. */
import { describe, expect, it } from "vitest";
import { cidCacheName, countRemoteImages, matchesContentId, previewKind, rewriteCidSources } from "@/lib/inbox/preview";

describe("previewKind", () => {
  it("allows raster images and PDF, with charset params stripped", () => {
    expect(previewKind("image/jpeg")).toBe("image");
    expect(previewKind("IMAGE/PNG")).toBe("image");
    expect(previewKind("image/webp; charset=binary")).toBe("image");
    expect(previewKind("application/pdf")).toBe("pdf");
  });
  it("refuses everything else — the XSS posture", () => {
    for (const m of ["image/svg+xml", "text/html", "application/xhtml+xml", "application/msword", "application/octet-stream", null, undefined, ""]) {
      expect(previewKind(m)).toBe("none");
    }
  });
});

describe("rewriteCidSources", () => {
  const urlFor = (cid: string) => `/cid/${encodeURIComponent(cid)}`;
  it("rewrites double- and single-quoted cid sources, preserving quotes", () => {
    expect(rewriteCidSources('<img src="cid:logo@x">', urlFor)).toBe('<img src="/cid/logo%40x">');
    expect(rewriteCidSources("<img src='cid:a.b'>", urlFor)).toBe("<img src='/cid/a.b'>");
  });
  it("rewrites multiple occurrences and leaves non-cid sources alone", () => {
    const html = '<img src="cid:a"><img src="https://x/y.png"><img src="cid:b">';
    expect(rewriteCidSources(html, urlFor)).toBe('<img src="/cid/a"><img src="https://x/y.png"><img src="cid:b">'.replace('src="cid:b"', 'src="/cid/b"'));
  });
});

describe("countRemoteImages", () => {
  it("counts http(s) only — cid/data/relative don't gate", () => {
    const html = '<img src="https://t/p.gif"><img alt="x" src="http://t/q.png"><img src="cid:a"><img src="data:image/png;base64,AA"><img src="/local.png">';
    expect(countRemoteImages(html)).toBe(2);
  });
  it("zero for no images", () => {
    expect(countRemoteImages("<p>hi</p>")).toBe(0);
  });
});

describe("matchesContentId", () => {
  it("strips angle brackets and compares case-insensitively", () => {
    expect(matchesContentId("<Logo@Mail>", "logo@mail")).toBe(true);
    expect(matchesContentId("logo@mail", "logo@mail")).toBe(true);
    expect(matchesContentId("<other@mail>", "logo@mail")).toBe(false);
    expect(matchesContentId(null, "x")).toBe(false);
  });
});

describe("cidCacheName", () => {
  it("is filesystem-safe and bounded", () => {
    expect(cidCacheName("a/b\\c:d@e")).toBe("a_b_c_d_e");
    expect(cidCacheName("x".repeat(300)).length).toBe(120);
    expect(cidCacheName("")).toBe("cid");
  });
});
