import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BRAND } from "@tc-hunter/domain";
import "./globals.css";

export const metadata: Metadata = { title: BRAND.name, description: BRAND.tagline };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
