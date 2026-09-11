/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["firebase-admin"],
  // Plan §9.3: Day Planner + Calendar merged into one /plan destination (U4). Old deep
  // links keep working — Next forwards unmatched query params (e.g. /planner/day?date=…)
  // to the destination automatically.
  async redirects() {
    return [
      { source: "/planner/day", destination: "/plan/day", permanent: false },
      { source: "/planner", destination: "/plan/day", permanent: false },
      { source: "/calendar", destination: "/plan/calendar", permanent: false },
      { source: "/plan", destination: "/plan/day", permanent: false }
    ];
  }
};

export default nextConfig;
