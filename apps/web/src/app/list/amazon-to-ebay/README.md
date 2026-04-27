# Amazon → eBay Pipeline Page

## Overview

This is a 4-column listing pipeline page that visualizes the Amazon to eBay publishing workflow with real-time job monitoring and progress tracking.

## Architecture

### Components

#### 1. **page.tsx** (Server Component)
- Location: `apps/web/src/app/list/amazon-to-ebay/page.tsx`
- Fetches initial data from backend APIs
- Renders PageHeader and passes data to client component
- Uses `cache: 'no-store'` to ensure fresh data on each request

#### 2. **AmazonToEbayClient.tsx** (Client Component)
- Location: `apps/web/src/app/list/amazon-to-ebay/AmazonToEbayClient.tsx`
- Full state management for the pipeline
- Real-time polling (2-second interval) for job progress
- Handles product selection, marketplace selection, and markup input
- Manages job lifecycle (creation, polling, completion, error handling)
- Proper cleanup of polling intervals on unmount

#### 3. **PipelineColumn.tsx** (Shared Component)
- Location: `apps/web/src/components/pipeline/PipelineColumn.tsx`
- Reusable column component for displaying pipeline stages
- Supports 4 color themes: blue, yellow, purple, green
- Displays product cards with status indicators
- Includes retry buttons for failed items

## Features

### 4-Column Pipeline

1. **AMAZON catalog** (Blue)
   - Shows all imported Amazon products
   - Displays: SKU, name, price, stock, brand
   - Read-only view

2. **READY to list** (Yellow)
   - Products not yet published to eBay
   - Checkbox selection for bulk publishing
   - Select all / deselect all functionality
   - Shows count of selected items

3. **IN PROGRESS** (Purple)
   - Products currently being published
   - Shows loading spinner during job execution
   - Displays progress percentage
   - Real-time updates via polling

4. **LIVE on eBay** (Green)
   - Successfully published products
   - Shows eBay item ID
   - Includes retry button for failed items
   - Auto-refreshes on job completion

### Control Panel

- **Marketplace Dropdown**: Select target eBay marketplace (EBAY_IT, EBAY_DE, EBAY_FR, EBAY_UK)
- **Markup Input**: Set markup percentage (0-100%) with validation
- **Selection Counter**: Shows selected products count
- **Publish Button**: Initiates bulk publish job
- **Reset Button**: Clears job state and polling
- **Job Status Display**: Shows real-time progress and item counts

## API Endpoints

### Backend Endpoints (apps/api/src/routes/listings.ts)

#### GET /api/listings/products
Fetches all imported Amazon products (ready to list)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "sku": "PROD-001",
      "name": "Product Name",
      "basePrice": 29.99,
      "amazonAsin": "B0123456789",
      "ebayItemId": null,
      "totalStock": 100,
      "brand": "Brand Name"
    }
  ]
}
```

#### GET /api/listings/published
Fetches products with ebayItemId (published to eBay)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "sku": "PROD-001",
      "name": "Product Name",
      "basePrice": 29.99,
      "amazonAsin": "B0123456789",
      "ebayItemId": "123456789",
      "totalStock": 100,
      "brand": "Brand Name"
    }
  ]
}
```

#### POST /api/listings/bulk-publish-to-ebay
Creates a bulk publish job

**Request:**
```json
{
  "productIds": ["uuid1", "uuid2"],
  "marketplace": "EBAY_UK",
  "markup": 15
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "job-1234567890-abc123",
    "status": "PENDING",
    "totalItems": 2
  }
}
```

#### GET /api/listings/bulk-publish-to-ebay/:jobId
Polls job status for progress updates

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "job-1234567890-abc123",
    "status": "IN_PROGRESS",
    "totalItems": 2,
    "processedItems": 1,
    "failedItems": 0,
    "progressPercent": 50,
    "marketplace": "EBAY_UK",
    "markup": 15,
    "createdAt": "2026-04-27T18:56:00Z",
    "updatedAt": "2026-04-27T18:56:05Z",
    "errorMessage": null
  }
}
```

## State Management

### Client State

```typescript
// Product data
const [products, setProducts] = useState<Product[]>(initialProducts);
const [published, setPublished] = useState<Product[]>(initialPublished);
const [inProgress, setInProgress] = useState<PipelineItem[]>([]);
const [readyToList, setReadyToList] = useState<PipelineItem[]>([]);

// User inputs
const [marketplace, setMarketplace] = useState<string>('EBAY_UK');
const [markup, setMarkup] = useState<number>(15);
const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());

// Job state
const [jobId, setJobId] = useState<string | null>(null);
const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
```

## Polling Logic

- **Interval**: 2 seconds (configurable via `POLLING_INTERVAL`)
- **Trigger**: Automatically starts when job is created
- **Cleanup**: Properly cleared on unmount and job completion
- **Status Handling**:
  - `PENDING` / `IN_PROGRESS`: Continue polling
  - `COMPLETED` / `job-completed`: Stop polling, refresh published list
  - `FAILED` / `job-failed`: Stop polling, display error message

## Error Handling

- **Validation**: Markup must be 0-100%
- **API Errors**: Caught and displayed in error banner
- **Polling Errors**: Logged to console, user notified
- **Retry**: Failed items show retry button
- **Network Failures**: Graceful error messages

## Cleanup

- Polling interval cleared on component unmount
- Polling interval cleared on job completion
- Polling interval cleared on job failure
- Proper use of `isMountedRef` to prevent state updates after unmount

## Usage

Navigate to `/list/amazon-to-ebay` to access the pipeline page.

### Workflow

1. Page loads and fetches initial products and published listings
2. User selects products from "READY to list" column
3. User selects marketplace and sets markup percentage
4. User clicks "Publish to eBay" button
5. Job is created and polling begins
6. Items move to "IN PROGRESS" column
7. Real-time progress updates via polling
8. On completion, items move to "LIVE on eBay" column
9. Published list auto-refreshes

## Testing

### Test Cases

1. **Polling Handles Job-Completed State**
   - Create a job and monitor status transitions
   - Verify polling stops when status is `COMPLETED` or `job-completed`
   - Verify published list refreshes automatically

2. **Polling Handles Job-Failed State**
   - Simulate a failed job
   - Verify polling stops when status is `FAILED` or `job-failed`
   - Verify error message is displayed

3. **Error Handling and Retry**
   - Test invalid markup input (>100%)
   - Test network errors during job creation
   - Test polling errors
   - Verify retry button appears on failed items
   - Verify retry functionality works

4. **Cleanup on Unmount**
   - Navigate away from page during polling
   - Verify no memory leaks
   - Verify polling interval is cleared

## Future Enhancements

- Add batch size limits for large product sets
- Implement job history/logs
- Add product filtering and search
- Support for scheduled publishing
- Webhook notifications instead of polling
- Progress bar visualization
- Bulk action history
