import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
// Copies Cesium's static assets (Workers, Assets, Widgets, ThirdParty) and sets
// CESIUM_BASE_URL so the engine can load them at runtime.
import cesium from "vite-plugin-cesium";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    headers: {
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=()",
    },
  },
  // rebuildCesium: bundle Cesium as a normal (lazy-loaded) chunk. Without it the
  // plugin injects a render-blocking 5.8 MB <script src="/cesium/Cesium.js"> into
  // index.html, so every page — even login — paid for the 3D engine up front.
  plugins: [react(), cesium({ rebuildCesium: true }), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Cesium is a large WebGL renderer; isolate it in its own chunk.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite's dynamic-import preload helper. Cesium uses import(), so without
          // this rule Rollup co-locates the helper in vendor-cesium — making every
          // lazy route (and the entry) statically depend on the 4 MB Cesium chunk.
          if (id.includes("vite/preload-helper")) {
            return "vendor-runtime";
          }
          // The `cesium` package re-exports @cesium/engine — match both.
          if (id.includes("node_modules/cesium") || id.includes("node_modules/@cesium/")) {
            return "vendor-cesium";
          }
          if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) {
            return "vendor-charts";
          }
          if (id.includes("node_modules/framer-motion")) {
            return "vendor-motion";
          }
          if (id.includes("node_modules/@radix-ui") || id.includes("node_modules/lucide-react")) {
            return "vendor-ui";
          }
          if (id.includes("node_modules/@supabase")) {
            return "vendor-supabase";
          }
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/react-router-dom/")
          ) {
            return "vendor-react";
          }
          if (
            id.includes("node_modules/react-hook-form") ||
            id.includes("node_modules/@hookform") ||
            id.includes("node_modules/zod")
          ) {
            return "vendor-forms";
          }
        },
      },
    },
  },
}));
