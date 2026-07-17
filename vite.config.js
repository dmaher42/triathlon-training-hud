import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryName = process.env.GITHUB_ACTIONS === "true"
  ? process.env.GITHUB_REPOSITORY?.split("/")[1]
  : null;
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: repositoryName ? `/${repositoryName}/` : "/",
  build: {
    rollupOptions: {
      input: {
        cycling: resolve(projectRoot, "index.html"),
        running: resolve(projectRoot, "running/index.html")
      }
    }
  }
});
