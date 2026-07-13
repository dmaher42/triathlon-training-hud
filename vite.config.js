import { defineConfig } from "vite";

const repositoryName = process.env.GITHUB_ACTIONS === "true"
  ? process.env.GITHUB_REPOSITORY?.split("/")[1]
  : null;

export default defineConfig({
  base: repositoryName ? `/${repositoryName}/` : "/"
});
