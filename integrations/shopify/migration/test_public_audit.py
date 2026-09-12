"""Guard the public evidence used to scope the live migration."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("public_audit", Path(__file__).with_name("audit-public-catalogue.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def product(id, handle, title="Jacket"):
    return {"id": id, "handle": handle, "title": title, "body_html": "Description",
            "options": [{"name": "Size"}], "tags": [],
            "variants": [{"id": id * 100, "sku": None, "option1": "M", "price": "99.00"}]}


def page(id, links, count=None):
    anchors = "".join(f'<a href="/products/{h}"><span class="sr-only">{label}</span></a>' for h, label in links)
    summary = "" if count is None else f'<div class="jdgm-rev-widg" data-number-of-reviews="{count}" data-average-rating="5.00"></div>'
    return (f'<div data-block-type="product-variations">{anchors}</div>'
            f'<div id="judgeme_product_reviews" data-product-id="{id}">{summary}</div>')


class PublicAuditTest(unittest.TestCase):
    def run_audit(self, products, pages):
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            (raw / "products-page-1.json").write_text(json.dumps({"products": products}))
            (raw / "products-page-2.json").write_text('{"products": []}')
            for handle, html in pages.items():
                (raw / f"{handle}.html").write_text(html)
            return module.audit(raw)

    def test_no_merges_from_matching_titles_or_recommendations(self):
        result = self.run_audit([product(1, "a"), product(2, "b")], {
            "a": page(1, []) + '<a href="/products/b" data-nexus-swatch>Black</a>',
            "b": page(2, [])})
        self.assertEqual(result["candidateFamilyCount"], 0)

    def test_valid_links_preserve_blank_skus_but_never_authorize_writes(self):
        links = [("a", "Black"), ("b", "Yellow")]
        result = self.run_audit([product(1, "a"), product(2, "b")],
                                {"a": page(1, links, 9), "b": page(2, links, 1)})
        family = result["families"][0]
        self.assertTrue(family["publicLinkChecksPassed"])
        self.assertFalse(family["readyToMigrate"])
        self.assertEqual(family["emptySkuCount"], 2)
        self.assertIsNone(family["variants"][0]["sku"])
        self.assertEqual(family["reviewSummaries"]["a"]["displayedCount"], 9)
        self.assertFalse(result["writesPerformed"])

    def test_jacket_and_pant_links_are_flagged(self):
        links = [("a", "Black"), ("b", "Black")]
        result = self.run_audit([product(1, "a"), product(2, "b", "Pant")],
                                {"a": page(1, links), "b": page(2, links)})
        codes = {i["code"] for i in result["families"][0]["issues"]}
        self.assertIn("MIXED_PRODUCT_TITLES", codes)
        self.assertIn("DUPLICATE_COLOUR_LABEL", codes)

    def test_asymmetric_links_are_not_treated_as_confirmed_family(self):
        result = self.run_audit([product(1, "a"), product(2, "b")], {
            "a": page(1, [("a", "Black"), ("b", "Yellow")]),
            "b": page(2, [("b", "Yellow")])})
        self.assertFalse(result["families"][0]["publicLinkChecksPassed"])

    def test_review_summary_is_scoped_to_source_and_missing_is_not_zero(self):
        html = page(1, []) + page(2, [], 99)
        self.assertIsNone(module.page_evidence(html, 1)["reviewSummary"])
        with self.assertRaises(ValueError):
            module.page_evidence(html, 3)

    def test_incomplete_pagination_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            (raw / "products-page-1.json").write_text(json.dumps({"products": [product(1, "a")]}))
            with self.assertRaises(ValueError):
                module.audit(raw)


if __name__ == "__main__":
    unittest.main()
