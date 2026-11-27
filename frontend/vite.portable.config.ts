import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  configFile: false,
  root: frontendRoot,
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  build: {
    emptyOutDir: true,
    outDir: resolve(frontendRoot, "../build/frontend-portable"),
    rollupOptions: {
      input: resolve(frontendRoot, "portable.html"),
    },
  },
});
