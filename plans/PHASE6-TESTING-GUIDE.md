# Phase 6: Publishing Engine - Testing Guide

## Overview

This guide provides comprehensive testing procedures for the Phase 6 Publishing Engine implementation. It covers unit tests, integration tests, and manual end-to-end testing.

## Test Environment Setup

### Prerequisites
- API server running on `http://localhost:3001`
- Frontend running on `http://localhost:3000`
- PostgreSQL database with test data
- eBay sandbox credentials configured in `.env`

### Environment Variables Required
```
EBAY_APP_ID=your_app_id
EBAY_CERT_ID=your_cert_id
EBAY_AUTH_URL=https://api.sandbox.ebay.com/identity/v1/oauth2/token
EBAY_API_BASE=https://api.sandbox.ebay.com
EBAY_FULFILLMENT_POLICY_ID=your_policy_id
EBAY_PAYMENT_POLICY_ID=your_policy_id
EBAY_RETURN_POLICY_ID=your_policy_id
```

## Unit Tests

### EbayPublishService Tests

**File:** `apps/api/src/services/__tests__/ebay-publish.service.test.ts`

#### Test Cases

1. **Valid Draft Publishing**
   - Input: Valid draft with all required fields
   - Expected: Returns PublishResult with listingId and listingUrl
   - Status: ✅ Implemented

2. **Draft Not Found**
   - Input: Non-existent draftId
   - Expected: Throws "Draft not found" error
   - Status: ✅ Implemented

3. **Invalid Draft Status**
   - Input: Draft with status !== "DRAFT"
   - Expected: Throws "not in DRAFT status" error
   - Status: ✅ Implemented

4. **Missing eBay Title**
   - Input: Draft with empty ebayTitle
   - Expected: Throws "ebayTitle" validation error
   - Status: ✅ Implemented

5. **Missing Category ID**
   - Input: Draft with empty categoryId
   - Expected: Throws "categoryId" validation error
   - Status: ✅ Implemented

6. **Missing HTML Description**
   - Input: Draft with empty htmlDescription
   - Expected: Throws "htmlDescription" validation error
   - Status: ✅ Implemented

7. **Missing Product**
   - Input: Draft with null product
   - Expected: Throws "Product not found" error
   - Status: ✅ Implemented

8. **Missing Product SKU**
   - Input: Draft with product.sku = null
   - Expected: Throws "SKU" validation error
   - Status: ✅ Implemented

### Running Unit Tests

```bash
cd apps/api
npm run test -- ebay-publish.service.test.ts
```

## Integration Tests

### API Endpoint Tests

**Endpoint:** `POST /api/listings/:draftId/publish`

#### Test Case 1: Successful Publish

**Setup:**
1. Create a product with SKU "TEST-PUBLISH-001"
2. Generate a draft listing for the product
3. Verify draft status is "DRAFT"

**Request:**
```bash
curl -X POST http://localhost:3001/api/listings/{draftId}/publish \
  -H "Content-Type: application/json"
```

**Expected Response (200):**
```json
{
  "success": true,
  "data": {
    "success": true,
    "draftId": "draft-123",
    "productId": "product-123",
    "listingId": "123456789",
    "listingUrl": "https://www.ebay.com/itm/123456789",
    "publishedAt": "2026-04-24T22:43:00.000Z",
    "message": "Listing published successfully"
  }
}
```

**Verification:**
- [ ] DraftListing.status updated to "PUBLISHED"
- [ ] DraftListing.publishedAt set to current timestamp
- [ ] VariantChannelListing record created
- [ ] VariantChannelListing.externalListingId = listingId
- [ ] VariantChannelListing.listingStatus = "ACTIVE"
- [ ] VariantChannelListing.listingUrl populated

#### Test Case 2: Draft Not Found

**Request:**
```bash
curl -X POST http://localhost:3001/api/listings/nonexistent-id/publish \
  -H "Content-Type: application/json"
```

**Expected Response (404):**
```json
{
  "success": false,
  "error": {
    "code": "DRAFT_NOT_FOUND",
    "message": "Draft not found",
    "details": { "draftId": "nonexistent-id" }
  }
}
```

#### Test Case 3: Draft Already Published

**Setup:**
1. Create and publish a draft
2. Attempt to publish the same draft again

**Request:**
```bash
curl -X POST http://localhost:3001/api/listings/{draftId}/publish \
  -H "Content-Type: application/json"
```

**Expected Response (409):**
```json
{
  "success": false,
  "error": {
    "code": "DRAFT_ALREADY_PUBLISHED",
    "message": "Draft has already been published",
    "details": { "draftId": "draft-123" }
  }
}
```

#### Test Case 4: Invalid Draft Data

**Setup:**
1. Create a draft with missing required fields (e.g., empty ebayTitle)

**Request:**
```bash
curl -X POST http://localhost:3001/api/listings/{draftId}/publish \
  -H "Content-Type: application/json"
```

**Expected Response (400):**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_DRAFT_DATA",
    "message": "Draft missing required field: ebayTitle",
    "details": { "draftId": "draft-123" }
  }
}
```

#### Test Case 5: eBay API Error

**Setup:**
1. Mock eBay API to return error
2. Attempt to publish a valid draft

**Expected Response (502):**
```json
{
  "success": false,
  "error": {
    "code": "EBAY_API_ERROR",
    "message": "Failed to publish to eBay",
    "details": { "error": "eBay API error details" }
  }
}
```

## End-to-End Manual Testing

### Workflow: Generate → Preview → Publish

#### Step 1: Navigate to Generator Page
1. Open browser to `http://localhost:3000/listings/generate`
2. Verify page loads with product list
3. Verify "Ready to Generate" section shows products without drafts

#### Step 2: Generate a Listing Draft
1. Click "Generate" button on a product
2. Verify loading state shows "Generating..."
3. Verify success notification appears
4. Verify product moves to "Generated Listings" section
5. Verify draft appears in table with eBay title preview

#### Step 3: Open Preview Modal
1. Click "Preview" button on generated listing
2. Verify modal opens with:
   - Product name and SKU in header
   - eBay Title (with character count)
   - Category ID
   - Item Specifics (grid layout)
   - Description Preview (HTML rendered)
   - Raw HTML details section
3. Verify "Publish to eBay" button is visible and enabled

#### Step 4: Publish to eBay
1. Click "Publish to eBay" button
2. Verify button shows loading state with spinner
3. Verify button text changes to "Publishing..."
4. Wait for response (5-10 seconds)
5. Verify success notification appears: "Listing published to eBay successfully!"
6. Verify modal closes automatically
7. Verify product is removed from "Generated Listings" section

#### Step 5: Verify Database Changes
1. Check DraftListing record:
   ```sql
   SELECT id, status, publishedAt FROM "DraftListing" 
   WHERE id = 'draft-id' LIMIT 1;
   ```
   - Verify status = "PUBLISHED"
   - Verify publishedAt is set to current timestamp

2. Check VariantChannelListing record:
   ```sql
   SELECT * FROM "VariantChannelListing" 
   WHERE externalListingId IS NOT NULL 
   LIMIT 1;
   ```
   - Verify channel = "EBAY"
   - Verify externalListingId is populated
   - Verify listingStatus = "ACTIVE"
   - Verify listingUrl contains eBay URL

### Error Scenario Testing

#### Scenario 1: Network Error During Publish
1. Disconnect network or mock network failure
2. Click "Publish to eBay"
3. Verify error notification appears
4. Verify button returns to normal state
5. Verify product remains in "Generated Listings"

#### Scenario 2: eBay API Failure
1. Mock eBay API to return 500 error
2. Click "Publish to eBay"
3. Verify error notification shows: "Failed to publish to eBay"
4. Verify button returns to normal state
5. Verify draft status remains "DRAFT"

#### Scenario 3: Publish Same Draft Twice
1. Publish a draft successfully
2. Refresh page
3. Attempt to publish the same draft again
4. Verify error notification shows: "Draft has already been published"

## Performance Testing

### Load Testing

**Objective:** Verify system handles multiple concurrent publish requests

**Test Setup:**
```bash
# Using Apache Bench
ab -n 100 -c 10 -X POST http://localhost:3001/api/listings/draft-id/publish
```

**Expected Results:**
- Response time < 5 seconds per request
- No database connection errors
- No memory leaks
- All requests complete successfully

### Database Performance

**Query Performance:**
```sql
-- Verify indexes are used
EXPLAIN ANALYZE
SELECT * FROM "DraftListing" 
WHERE id = 'draft-id' 
INCLUDE (product);
```

**Expected:** Index scan, not sequential scan

## Regression Testing

### Existing Features
- [ ] AI Listing Generation still works
- [ ] Product listing still displays correctly
- [ ] Inventory management unaffected
- [ ] Other marketplace integrations unaffected

### Database Integrity
- [ ] No orphaned DraftListing records
- [ ] No orphaned VariantChannelListing records
- [ ] Foreign key constraints maintained
- [ ] Cascade deletes work correctly

## Success Criteria

✅ All unit tests pass
✅ All integration tests pass
✅ End-to-end workflow completes successfully
✅ Error handling works for all scenarios
✅ Database records created correctly
✅ UI provides proper feedback (loading, success, error)
✅ Published items removed from queue
✅ No performance degradation
✅ No regressions in existing features

## Troubleshooting

### Issue: "Draft not found" error
**Solution:** Verify draftId is correct and draft exists in database

### Issue: "eBay API error" response
**Solution:** 
- Check eBay credentials in .env
- Verify eBay API is accessible
- Check eBay sandbox status

### Issue: Modal doesn't close after publish
**Solution:**
- Check browser console for JavaScript errors
- Verify API response is valid JSON
- Check network tab for failed requests

### Issue: Database records not created
**Solution:**
- Verify Prisma migrations are up to date
- Check database connection
- Verify user has write permissions

## Test Checklist

- [ ] Unit tests created and passing
- [ ] Integration tests created and passing
- [ ] Manual end-to-end test completed
- [ ] Error scenarios tested
- [ ] Performance verified
- [ ] Regression tests passed
- [ ] Documentation updated
- [ ] Code review completed
- [ ] Ready for production deployment

## Next Steps

1. Run all tests in CI/CD pipeline
2. Deploy to staging environment
3. Perform final QA testing
4. Deploy to production
5. Monitor for errors in production
6. Gather user feedback
