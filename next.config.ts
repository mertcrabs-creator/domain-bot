import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
