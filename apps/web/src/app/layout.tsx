import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/layout/Sidebar";
import TopBar from "@/components/layout/TopBar";

export const metadata: Metadata = {
  title: "Nexus Commerce — Seller Central",
  description: "Amazon-to-eBay synchronization engine and inventory management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="flex h-screen bg-gray-100 overflow-hidden">
          {/* ── Sidebar ─────────────────────────────────────── */}
          <Sidebar />

          {/* ── Main area (TopBar + Content) ─────────────────── */}
          <div className="flex flex-col flex-1 min-w-0">
            <TopBar />

            {/* ── Page content ────────────────────────────────── */}
            <main className="flex-1 overflow-auto">
              <div className="p-6">{children}</div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
