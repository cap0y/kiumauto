import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 클라이언트 소스 디렉토리 설정
  root: path.resolve(__dirname, "client"),
  publicDir: path.resolve(__dirname, "public"),

  plugins: [react()],
  server: {
    port: 5000,
    host: "0.0.0.0", // 외부 접근 허용
    middlewareMode: false,
    fs: {
      strict: false,
    },
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        secure: false,
      },
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client/src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
