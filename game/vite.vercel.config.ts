import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Standalone static build of the Boxing Canvas game for hosts that just
// serve a plain SPA (Vercel, Netlify, GitHub Pages, ...). The main app
// normally runs through vinext/Cloudflare Workers; this config sidesteps
// that entirely and builds app/AssetLab.tsx as an ordinary client-only
// React app with no server, no RSC, and no Cloudflare bindings.
export default defineConfig({
  root: path.resolve(dirname, "vercel-static"),
  publicDir: path.resolve(dirname, "public"),
  plugins: [react()],
  css: {
    postcss: path.resolve(dirname, "postcss.config.mjs"),
  },
  build: {
    outDir: path.resolve(dirname, "dist-vercel"),
    emptyOutDir: true,
  },
});
