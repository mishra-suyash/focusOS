/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["firebase-admin"],
  // plan/19 §4.2 — the OAuth discovery documents Claude reads. `.well-known` paths can't be App Router
  // folders, so they're rewritten to ordinary route handlers. The suffixed forms are the RFC 9728/8414
  // path-insertion variants a client may try for the /api/mcp resource.
  async rewrites() {
    return [
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/metadata/protected-resource" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/metadata/protected-resource" },
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/metadata/authorization-server" },
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/metadata/authorization-server" }
    ];
  },
  // Plan §9.3: Day Planner + Calendar merged into one /plan destination (U4). Old deep
  // links keep working — Next forwards unmatched query params (e.g. /planner/day?date=…)
  // to the destination automatically.
  async redirects() {
    return [
      { source: "/planner/day", destination: "/plan/day", permanent: false },
      { source: "/planner", destination: "/plan/day", permanent: false },
      { source: "/calendar", destination: "/plan/calendar", permanent: false },
      { source: "/plan", destination: "/plan/day", permanent: false },
      // plan/14 §5.1 — /reviews/weekly absorbed as /plan/week's Step 1 (Look back).
      { source: "/reviews/weekly", destination: "/plan/week", permanent: false }
    ];
  }
};

export default nextConfig;
