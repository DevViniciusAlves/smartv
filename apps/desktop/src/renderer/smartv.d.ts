import type { SmartvApi } from "../preload.js";

declare global {
  interface Window {
    smartv: SmartvApi;
  }
}

export {};
