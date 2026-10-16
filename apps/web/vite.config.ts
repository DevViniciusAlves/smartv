import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        tv: "tv.html",
        controle: "controle.html",
        diag: "diag.html",
      },
    },
  },
});
