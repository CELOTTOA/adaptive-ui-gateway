import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { publicationFiles } from "./publication-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = await publicationFiles(root);
const failures = [];
const patterns = [
  ["provider/github token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xai-[A-Za-z0-9]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/],
  ["AWS access identifier", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["personal Windows path", /[A-Z]:[\\/]Users[\\/][A-Za-z0-9._-]+[\\/]/],
];
const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const fixturePath = "tests/fixtures/tls/test-only.key.pem";
const normalizeLines = (content) => content.replaceAll("\r\n", "\n");
const fixture = normalizeLines(await readFile(resolve(root, fixturePath), "utf8"));
// Exact known local credential values are compared in memory, never printed.
let knownSecrets = [];
try {
  const env = await readFile(resolve(root, ".envlocal"), "utf8");
  knownSecrets = env.split(/\r?\n/).filter((line) => /^\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=/.test(line))
    .map((line) => line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, ""))
    .filter((value) => value.length >= 16);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function scan(label, content, allowFixture = false) {
  for (const [name, pattern] of patterns) {
    if (pattern.test(content)) failures.push(`${label}: ${name}`);
  }
  if (privateKey.test(content) && !(allowFixture && normalizeLines(content) === fixture)) {
    failures.push(`${label}: unapproved private key`);
  }
  if (knownSecrets.some((secret) => content.includes(secret))) failures.push(`${label}: matches a local secret`);
}

const fileSet = new Set(files);
for (const file of files) {
  const buffer = await readFile(resolve(root, file));
  if (buffer.includes(0)) continue;
  const content = buffer.toString("utf8");
  scan(file, content, file === fixturePath);
  if (file.endsWith(".md")) {
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#")[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      const absolute = resolve(dirname(resolve(root, file)), decodeURIComponent(target));
      const relative = absolute.slice(root.length + 1).replaceAll("\\", "/");
      if (!absolute.startsWith(root + "/") && !absolute.startsWith(root + "\\")) {
        failures.push(`${file}: link outside publication root`);
      } else if (!fileSet.has(relative)) failures.push(`${file}: missing publication link ${relative}`);
    }
  }
}

let historyCount = 0;
if (process.argv.includes("--history")) {
  const objects = spawnSync("git", ["rev-list", "--objects", "--all"], { cwd: root, encoding: "utf8" });
  if (objects.status !== 0) throw new Error("Cannot enumerate Git history");
  const paths = new Map();
  for (const line of objects.stdout.trim().split("\n")) {
    const [oid, ...path] = line.split(" ");
    paths.set(oid, path.join(" "));
  }
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root, input: [...paths.keys()].join("\n") + "\n", maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("Cannot read Git objects");
  let offset = 0;
  while (offset < result.stdout.length) {
    const end = result.stdout.indexOf(10, offset);
    const [oid, type, sizeText] = result.stdout.subarray(offset, end).toString().split(" ");
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) throw new Error("Invalid Git object header");
    const body = result.stdout.subarray(end + 1, end + 1 + size);
    if (type === "blob" && !body.includes(0)) {
      historyCount++;
      scan(`history ${oid.slice(0, 12)} (${paths.get(oid)})`, body.toString("utf8"), paths.get(oid) === fixturePath);
    }
    offset = end + 1 + size + 1;
  }
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`Publication checks passed: ${files.length} source files, ${historyCount} historical text blobs.`);
  console.log("Checked relative document links, common credential patterns, local-secret matches and private-key exceptions.");
  console.log("This targeted check is not an exhaustive secret scan or a security audit.");
}
