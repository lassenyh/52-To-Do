import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifestFilename: "manifest.webmanifest",
      includeAssets: [],
      workbox: {
        navigateFallback: "/index.html"
      },
      manifest: {
        name: "52",
        short_name: "52",
        description: "Track 52 things you want to complete this year.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#0f1115",
        background_color: "#0f1115",
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png"
          }
        ]
      }
    })
  ]
});

