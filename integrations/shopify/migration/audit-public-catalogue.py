#!/usr/bin/env python3
"""Read-only analysis of downloaded Shopify public JSON and product HTML.

Public output cannot authorize a migration: unpublished products, inventory,
review records, metafields, Markets and application mappings need Admin access.
No Shopify writes, SKU repairs, or inferred title-based merges are performed.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import urlsplit, unquote


class Element:
    def __init__(self, tag="root", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Element):
                yield from child.walk()

    def text(self):
        return "".join(c.text() if isinstance(c, Element) else c for c in self.children)


class Document(HTMLParser):
    VOID = set("area base br col embed hr img input link meta param source track wbr".split())

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Element()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Element(tag, attrs))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, value):
        self.stack[-1].children.append(value)


def page_evidence(html, product_id):
    nodes = list(Document(html).root.walk())
    links = []
    for block in nodes:
        if block.attrs.get("data-block-type") != "product-variations":
            continue
        for node in block.walk():
            if node.tag != "a" or "href" not in node.attrs:
                continue
            path = unquote(urlsplit(node.attrs["href"]).path)
            if "/products/" not in path:
                continue
            labels = [n.text().strip() for n in node.walk()
                      if "sr-only" in n.attrs.get("class", "").split()]
            links.append({"handle": path.split("/products/", 1)[1].strip("/"),
                          "label": " ".join(labels), "href": node.attrs["href"]})
    widgets = [n for n in nodes if n.attrs.get("id") == "judgeme_product_reviews"
               and n.attrs.get("data-product-id", n.attrs.get("data-id")) == str(product_id)]
    if not widgets:
        raise ValueError(f"Expected product {product_id} review widget not found; verify page identity/template")
    summaries = [n.attrs for w in widgets for n in w.walk()
                 if "jdgm-rev-widg" in n.attrs.get("class", "").split()
                 and "data-number-of-reviews" in n.attrs]
    review_summary = None
    if len(summaries) == 1:
        a = summaries[0]
        review_summary = {"displayedCount": int(a["data-number-of-reviews"]),
                          "displayedAverage": a.get("data-average-rating"),
                          "widgetUpdatedAt": a.get("data-updated-at"),
                          "isCompleteReviewBackup": False}
    return {"colourLinks": links, "reviewSummary": review_summary,
            "pageSha256": sha256(html.encode()).hexdigest()}


def audit(raw):
    pages = sorted(raw.glob("products-page-*.json"),
                   key=lambda p: int(p.stem.rsplit("-", 1)[1]))
    if not pages:
        raise ValueError("No catalogue snapshots found")
    page_data = [json.loads(p.read_text())["products"] for p in pages]
    if page_data[-1]:
        raise ValueError("Download through an empty catalogue page to establish pagination end")
    if [int(p.stem.rsplit("-", 1)[1]) for p in pages] != list(range(1, len(pages) + 1)):
        raise ValueError("Catalogue pages must be contiguous from page 1")
    products = [p for page in page_data for p in page]
    by_handle = {p["handle"]: p for p in products}
    if len(by_handle) != len(products) or len({p["id"] for p in products}) != len(products):
        raise ValueError("Duplicate catalogue identity; pagination snapshot may have drifted")
    evidence = {}
    for p in products:
        html = (raw / f'{p["handle"]}.html').read_text()
        evidence[p["handle"]] = page_evidence(html, p["id"])

    # Connected components are candidates only. Require reciprocal complete
    # link sets and consistent labels before treating a component as a family.
    graph = {h: set() for h in by_handle}
    issues = []
    for handle, source in evidence.items():
        for link in source["colourLinks"]:
            target = link["handle"]
            if target not in by_handle:
                issues.append({"code": "LINK_OUTSIDE_PUBLIC_CATALOGUE", "source": handle, "target": target})
            else:
                graph[handle].add(target)
                graph[target].add(handle)
    visited, families = set(), []
    for start in by_handle:
        if start in visited:
            continue
        component, pending = set(), [start]
        while pending:
            handle = pending.pop()
            if handle not in component:
                component.add(handle)
                pending.extend(graph[handle] - component)
        visited.update(component)
        if len(component) < 2:
            continue
        members = sorted(component, key=lambda h: by_handle[h]["id"])
        family_issues, colours, variants = [], {}, []
        if len({by_handle[h]["title"] for h in members}) != 1:
            family_issues.append({"code": "MIXED_PRODUCT_TITLES",
                                  "titles": {h: by_handle[h]["title"] for h in members}})
        axes = {tuple(o["name"] for o in by_handle[h]["options"]) for h in members}
        if len(axes) != 1 or any(len(axis) >= 3 for axis in axes):
            family_issues.append({"code": "OPTION_AXES_REQUIRE_REVIEW"})
        for target in members:
            labels = {link["label"] for h in members for link in evidence[h]["colourLinks"]
                      if link["handle"] == target}
            if len(labels) != 1 or "" in labels:
                family_issues.append({"code": "INCONSISTENT_COLOUR_LABEL", "handle": target, "labels": sorted(labels)})
            colours[target] = sorted(labels)
        distinct = [labels[0].casefold() for labels in colours.values() if len(labels) == 1]
        if len(distinct) != len(set(distinct)):
            family_issues.append({"code": "DUPLICATE_COLOUR_LABEL"})
        spelling_equivalents = [label.replace("grey", "gray") for label in distinct]
        if len(set(spelling_equivalents)) != len(set(distinct)):
            family_issues.append({"code": "POSSIBLE_EQUIVALENT_COLOUR_LABELS",
                                  "note": "Grey/Gray differ only in spelling; inspect actual colour before assigning options."})
        for handle in members:
            p = by_handle[handle]
            linked = [link["handle"] for link in evidence[handle]["colourLinks"]]
            if set(linked) != component or len(linked) != len(set(linked)):
                family_issues.append({"code": "INCONSISTENT_LINK_SET", "handle": handle, "linked": linked})
            for v in p["variants"]:
                variants.append({"sourceProductId": str(p["id"]), "sourceHandle": handle,
                                 "sourceVariantId": str(v["id"]), "sku": v.get("sku"),
                                 "colourCandidates": colours[handle],
                                 "existingOptions": [v.get(f"option{i}") for i in (1, 2, 3)],
                                 "price": v["price"], "compareAtPrice": v.get("compare_at_price"),
                                 "available": v.get("available"), "grams": v.get("grams"),
                                 "requiresShipping": v.get("requires_shipping"), "taxable": v.get("taxable"),
                                 "destinationProductId": None, "destinationVariantId": None})
        nonempty_skus = [v["sku"] for v in variants if v["sku"]]
        duplicates = [sku for sku, count in Counter(nonempty_skus).items() if count > 1]
        if duplicates:
            family_issues.append({"code": "DUPLICATE_NONEMPTY_SKU", "skus": duplicates})
        sizes = {tuple(tuple(v.get(f"option{i}") for i in (1, 2, 3)) for v in by_handle[h]["variants"])
                 for h in members}
        families.append({"title": by_handle[members[0]]["title"], "handles": members,
                         "sourceTags": {h: by_handle[h]["tags"] for h in members},
                         "colours": colours, "variantCount": len(variants),
                         "emptySkuCount": sum(not v["sku"] for v in variants),
                         "sameOrderedSizeMatrix": len(sizes) == 1,
                         "sameDescriptionHtml": len({by_handle[h]["body_html"] for h in members}) == 1,
                         "publicLinkChecksPassed": not family_issues,
                         "issues": family_issues, "variants": variants,
                         "reviewSummaries": {h: evidence[h]["reviewSummary"] for h in members},
                         "readyToMigrate": False})
    linked_handles = {h for family in families for h in family["handles"]}
    all_variants = [v for p in products for v in p["variants"]]
    return {"generatedAt": datetime.now(timezone.utc).isoformat(),
            "status": "PUBLIC_AUDIT_ONLY_ADMIN_VERIFICATION_REQUIRED", "writesPerformed": False,
            "source": "https://xaviaracing.it/products.json?limit=250&page=1",
            "coverage": "Public default-market catalogue and server-rendered colour selectors only",
            "publicProductCount": len(products), "publicVariantCount": len(all_variants),
            "publicEmptySkuCount": sum(not v.get("sku") for v in all_variants),
            "linkedProductCount": len(linked_handles), "candidateFamilyCount": len(families),
            "linkedVariantCount": sum(f["variantCount"] for f in families),
            "linkedEmptySkuCount": sum(f["emptySkuCount"] for f in families),
            "groupsWithLinkIssues": sum(bool(f["issues"]) for f in families),
            "unlinkedHandles": sorted(set(by_handle) - linked_handles), "issues": issues,
            "families": families, "pageEvidence": evidence,
            "snapshotHashes": {p.name: sha256(p.read_bytes()).hexdigest() for p in pages}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = audit(args.raw)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k not in
                      {"families", "pageEvidence", "snapshotHashes"}}, indent=2))
