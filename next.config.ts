import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // nginx compresses responses in production; Next's own gzip only duplicates the work.
  compress: false,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.crabsmedia.com",
        pathname: "/wp-content/uploads/2025/02/logo.png",
      },
    ],
  },
};

export default nextConfig;