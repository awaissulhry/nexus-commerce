import type { Metadata } from "next";
import "./globals.css";
import AppSidebar from "@/components/layout/AppSidebar";

export const metadata: Metadata = {
  title: "Nexus Commerce",
  description: "Master catalog and multi-channel listing platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="flex h-screen bg-slate-50 overflow-hidden">
          <AppSidebar />
          <main className="flex-1 overflow-auto">
            <div className="p-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
