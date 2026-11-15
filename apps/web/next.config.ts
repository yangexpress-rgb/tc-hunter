import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@tc-hunter/db", "@tc-hunter/domain"],
  serverExternalPackages: ["@node-rs/argon2", "pg", "imapflow", "mailparser"],
  poweredByHeader: false,
  // Resume uploads go through a server action; files are capped at 5 MB in the app itself.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        // Public host (Railway): browsers only ever use HTTPS for this address, and no other site may frame it.
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
      ],
    }];
  },
};
export default config;
