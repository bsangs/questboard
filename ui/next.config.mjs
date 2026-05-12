/** @type {import('next').NextConfig} */
const apiPort = process.env.BOARD_SERVER_PORT || "3031";

const nextConfig = {
  // output: 'standalone' 은 PM2 의 next start 진입점과 호환 안 됨 (server.js 별도 경로).
  // 로컬 단일 사용자라 standalone 의 노드모듈 최소화 이점도 없으니 제거.
  reactStrictMode: true,
  transpilePackages: ["@questboard/core"],
  typescript: { ignoreBuildErrors: false },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${apiPort}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
