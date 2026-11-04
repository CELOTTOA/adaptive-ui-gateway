import { mkdir, copyFile, writeFile, lstat, readFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { publicationFiles } from "./publication-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv[2];
if (!requested) throw new Error("Usage: node scripts/export-publication.mjs .local/publication/source");
const target = resolve(root, requested);
const inside = relative(resolve(root, ".local"), target);
if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
  throw new Error("Publication target must be a new directory inside .local");
}
try {
  await lstat(target);
  throw new Error("Target already exists; choose a fresh directory to preserve review artifacts");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const files = await publicationFiles(root);
const manifest = [];
for (const file of files) {
  const destination = resolve(target, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, file), destination);
  manifest.push({ file, sha256: createHash("sha256").update(await readFile(destination)).digest("hex") });
}
await writeFile(`${target}.manifest.json`, JSON.stringify({ files: manifest }, null, 2) + "\n");
console.log(`Exported ${files.length} reviewed source files to ${target}`);
console.log("Excluded local credentials, generated builds, node_modules, loose artwork and .git history.");
