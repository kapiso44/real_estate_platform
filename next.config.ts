import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Photos are hotlinked from Otodom's CDN; we never re-host the files.
    remotePatterns: [{ protocol: "https", hostname: "ireland.apollo.olxcdn.com" }],
  },
};

export default nextConfig;
