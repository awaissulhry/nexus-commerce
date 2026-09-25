# Coverage — our eBay workbooks through the product-sheet drawer (2026-09-24, private DB copy)

| file | result | values imported | excluded | refused | preview |
|---|---|---|---|---|---|
| ACCESSORIES/SLIDERS/eBay/IT/KNEE-SLIDER IT.xlsx | read | 235 | 107 | 98 | INVALID · changed 45 · unchanged 190 |
| ACCESSORIES/SLIDERS/eBay/IT/NORMAL-KNEE-SLIDER IT.xlsx | ❌ Select at least one product and a data destination | 0 | – | 27 | none |
| JACKETS/AIR MESH/eBay/IT/AIRMESH IT.xlsx | read | 755 | 293 | 168 | INVALID · changed 410 · unchanged 345 |
| JACKETS/AIREON/eBay/IT/AIREON IT.xlsx | ❌ Select at least one product and a data destination | 0 | – | 164 | none |
| JACKETS/Gale/eBay/IT/GALE IT.xlsx | read | 734 | 396 | 252 | INVALID · changed 210 · unchanged 524 |
| JACKETS/Misano/eBay/IT/MISANO IT.xlsx | ❌ Select at least one product and a data destination | 0 | – | 48 | none |
| JACKETS/Moss/eBay/IT/MOSS IT.xlsx | ❌ Select at least one product and a data destination | 0 | – | 124 | none |
| JACKETS/REGAL/eBay/IT/REGAL IT.xlsx | ❌ Select at least one product and a data destination | 0 | – | 82 | none |
| JACKETS/VENTRA/eBay/IT/VENTRA IT.xlsx | ❌ Select at least one product and a data destination | 0 | – | 123 | none |
| JACKETS/WATERPROOF/eBay/IT/WATERPROOF IT.xlsx | read | 362 | 87 | 110 | INVALID · changed 88 · unchanged 274 |
| XAVIA-eBay-IT-AIREON.xlsx | ❌ Unknown worksheet "AIREON". Use Products, Listings or Overrides. | 0 | – | – | none |
| XAVIA-eBay-IT-AIRMESH.xlsx | ❌ Unknown worksheet "AIRMESH". Use Products, Listings or Overrides. | 0 | – | – | none |
| XAVIA-eBay-IT-MOSS.xlsx | ❌ Unknown worksheet "MOSS". Use Products, Listings or Overrides. | 0 | – | – | none |
| XAVIA-eBay-IT-REGAL.xlsx | ❌ Unknown worksheet "REGAL". Use Products, Listings or Overrides. | 0 | – | – | none |
| XAVIA-eBay-IT-VENTRA.xlsx | ❌ Unknown worksheet "VENTRA". Use Products, Listings or Overrides. | 0 | – | – | none |
| XAVIA-eBay-IT-WATERPROOF.xlsx | ❌ Unknown worksheet "WATERPROOF". Use Products, Listings or Overrides. | 0 | – | – | none |

## Per column (the 4 files that were read)

| column | → Nexus field | imported | excluded — reason | refused — reason |
|---|---|---|---|---|
| `Item ID` |  | 0 | 62× Verified listing identity; shared product parentage and remote links a | 111× This Item ID, parent and SKU do not identify exactly one existing listing in thi |
| `Parent SKU` |  | 0 | 58× Verified listing identity; shared product parentage and remote links a | 30× Supply an exact SKU, numeric Item ID and valid parent/child relationship; 20× Each row needs exactly one parent row with the same Parent SKU and Item ID |
| `Title` | title | 62 |  |  |
| `Condition` | conditionId | 62 |  |  |
| `Category ID` | categoryId | 62 |  |  |
| `Variation Theme` | variationTheme | 62 |  |  |
| `Shared-SKU (Trading API)` | sharedSkuListing | 62 |  |  |
| `Format` | listingFormat | 62 |  |  |
| `Duration` | listingDuration | 62 |  |  |
| `Description` | description | 62 |  |  |
| `Best Offer` | bestOffer | 62 |  |  |
| `BO Floor (EUR)` | bestOfferFloor | 62 |  |  |
| `BO Ceiling (EUR)` | bestOfferCeiling | 62 |  |  |
| `VAT %` | vatRate | 62 |  |  |
| `Handling Days` | handlingTime | 62 |  |  |
| `Location` | itemLocationCountry | 62 |  |  |
| `Weight` | packageWeight | 62 |  |  |
| `Length` | packageLength | 62 |  |  |
| `Width` | packageWidth | 62 |  |  |
| `Height` | packageHeight | 62 |  |  |
| `Dim Unit` | dimensionUnit | 62 |  |  |
| `Image 1` | imageUrls | 62 |  |  |
| `Marca (Brand) *` | brand | 62 |  |  |
| `Materiale (Material) ○` | material | 62 |  |  |
| `Quantità` | quantita | 62 |  |  |
| `Paese di origine` | paese_di_origine | 62 |  |  |
| `SKU` |  | 0 | 62× Verified listing identity; shared product parentage and remote links a |  |
| `Parent/Child` |  | 0 | 62× Verified listing identity; shared product parentage and remote links a |  |
| `Wt Unit` |  | 0 | 62× Imported with Weight as one typed measurement |  |
| `Follow` |  | 0 | 62× Historical price, inventory, control or sync reference; use its dedica |  |
| `Buffer` |  | 0 | 62× Historical price, inventory, control or sync reference; use its dedica |  |
| `Adatto a ○` | adatto_a | 42 |  | 11× Use an exact eBay choice for Adatto a: Adulto unisex, Bambini, Donna, Ragazza, R; 9× This populated column has no unambiguous field in the current eBay schema; map o |
| `Caratteristiche (Features)` | features | 53 |  | 9× This populated column has no unambiguous field in the current eBay schema; map o |
| `Genere ⚠` |  | 0 |  | 62× This populated column has no unambiguous field in the current eBay schema; map o |
| `Paese di fabbricazione ⚠` |  | 0 |  | 62× This populated column has no unambiguous field in the current eBay schema; map o |
| `athlete ⚠` |  | 0 |  | 62× This populated column has no unambiguous field in the current eBay schema; map o |
| `Price (€)` |  | 0 | 61× Historical price, inventory, control or sync reference; use its dedica |  |
| `Colore (Color) ↕` | color | 58 |  |  |
| `Colore specifico` | colore_specifico | 58 |  |  |
| `Colore esatto` | colore_esatto | 50 |  | 8× This populated column has no unambiguous field in the current eBay schema; map o |
| `Stagione (Season)` | season | 21 |  | 32× Use an exact eBay choice for Stagione: Estate, Inverno, Tutte le stagione |
| `Stile (Style)` | style | 53 |  |  |
| `Scollatura ↕` | scollatura | 53 |  |  |
| `Chiusura (Closure / Fastening)` | closure_fastening | 53 |  |  |
| `Cura dell'indumento` | cura_dell_indumento | 53 |  |  |
| `Livello di protezione ⚠` |  | 0 |  | 53× This populated column has no unambiguous field in the current eBay schema; map o |
| `Tipo di giacca ⚠` |  | 0 |  | 53× This populated column has no unambiguous field in the current eBay schema; map o |
| `body type ⚠` |  | 0 |  | 53× This populated column has no unambiguous field in the current eBay schema; map o |
| `team name ⚠` |  | 0 |  | 53× This populated column has no unambiguous field in the current eBay schema; map o |
| `Taglia (Size) ○ ↕` | size | 50 |  |  |
| `Protezione (Protection)` | protection | 42 |  |  |
| `Quantity` |  | 0 | 42× Historical price, inventory, control or sync reference; use its dedica |  |
| `Listing Status` |  | 0 | 42× Historical price, inventory, control or sync reference; use its dedica |  |
| `Last Pushed` |  | 0 | 42× Historical price, inventory, control or sync reference; use its dedica |  |
| `Sync Status` |  | 0 | 42× Historical price, inventory, control or sync reference; use its dedica |  |
| `Status` |  | 0 | 42× Historical price, inventory, control or sync reference; use its dedica |  |
| `Qty` |  | 0 | 41× Historical price, inventory, control or sync reference; use its dedica |  |
| `Image 2` |  | 0 | 30× Imported in the ordered image URL list |  |
| `Image 3` |  | 0 | 30× Imported in the ordered image URL list |  |
| `Image 4` |  | 0 | 30× Imported in the ordered image URL list |  |
| `Image 5` |  | 0 | 30× Imported in the ordered image URL list |  |
| `Image 6` |  | 0 | 21× Imported in the ordered image URL list |  |
| `Fulfillment Policy ID` | fulfillmentPolicyId | 4 |  |  |
| `Payment Policy ID` | paymentPolicyId | 4 |  |  |
| `Return Policy ID` | returnPolicyId | 4 |  |  |
