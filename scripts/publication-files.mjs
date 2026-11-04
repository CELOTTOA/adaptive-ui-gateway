import { readdir } from "node:fs/promises";
import { join } from "node:path";

const roots = [".github", "apps", "packages", "examples", "tests", "docs", "scripts"];
const top = [".gitignore", ".env.example", "README.md", "LICENSE", "CONTRIBUTING.md",
  "SECURITY.md", "CHANGELOG.md", "package.json", "package-lock.json", "tsconfig.base.json",
  "adaptive-ui-gateway-architecture-spec-v0.3.md"];

/** Deliberate source snapshot: never exports the working directory wholesale. */
export async function publicationFiles(root) {
  const files = [...top];
  async function walk(directory) {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error(`Symlink requires review: ${directory}/${item.name}`);
      if (["node_modules", "dist", ".local", ".git"].includes(item.name)) continue;
      const path = `${directory}/${item.name}`;
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && !/\.(?:log|tsbuildinfo)$/.test(item.name)) files.push(path);
    }
  }
  for (const rootDirectory of roots) await walk(rootDirectory);
  return files.sort();
}
