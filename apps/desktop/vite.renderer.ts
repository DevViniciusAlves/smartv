import { defineConfig } from "vite";

// Bundles the local renderer (home + top bar). Remote service pages are
// NEVER bundled here; they load live inside a sandboxed WebContentsView.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: "src/renderer/home.html",
        bar: "src/renderer/bar.html",
      },
    },
  },
});
