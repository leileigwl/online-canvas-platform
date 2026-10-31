import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(currentDir, "src") },
  },
  server: {
    host: "0.0.0.0",
    proxy: { "/api": { target: "http://127.0.0.1:8001", changeOrigin: true } },
  },
});
