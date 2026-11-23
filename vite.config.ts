import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Local dev: `npm run dev` (vite :5173) alongside `npm run dev:server`
    // (express :3000). The client only talks to /actions on its origin.
    proxy: {
      "/actions": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
    },
  },
});
