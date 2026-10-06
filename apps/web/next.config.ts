import type { NextConfig } from "next";

// One .env file at the repository root serves the API and the web app. Values of the shell take priority.
try {
  process.loadEnvFile("../../.env");
} catch {
  // No .env file. The defaults apply.
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

const config: NextConfig = {
  // The Privy app id is public. The app secret never reaches the browser.
  env: { NEXT_PUBLIC_PRIVY_APP_ID: process.env.PRIVY_APP_ID ?? "" },
  // The browser talks to /api on the same origin. Next forwards the request to the API server.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/:path*` }];
  },
};

export default config;
