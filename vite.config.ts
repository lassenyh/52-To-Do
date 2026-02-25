import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [],
      workbox: {
        navigateFallback: "/index.html"
      },
      manifest: {
        name: "52 to-do",
        short_name: "52 to-do",
        description: "Track 52 things you want to complete this year.",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: ".",
        icons: [
          {
            src: "icons/pwa-192x192.svg",
            sizes: "192x192",
            type: "image/svg+xml"
          },
          {
            src: "icons/pwa-512x512.svg",
            sizes: "512x512",
            type: "image/svg+xml"
          }
        ]
      }
    })
  ]
});

