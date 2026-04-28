import { Suspense } from "react";
import EbayCallbackContent from "./EbayCallbackContent";

function EbayCallbackLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-100 rounded-full mb-4">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Connecting to eBay
          </h2>
          <p className="text-sm text-gray-600">Processing eBay authorization...</p>
        </div>
      </div>
    </div>
  );
}

export default function EbayCallbackPage() {
  return (
    <Suspense fallback={<EbayCallbackLoading />}>
      <EbayCallbackContent />
    </Suspense>
  );
}
