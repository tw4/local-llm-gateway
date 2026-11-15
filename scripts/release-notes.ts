#!/usr/bin/env node
// Prints the CHANGELOG.md section for a version, for the GitHub release notes.
//   node scripts/release-notes.ts 1.2.3
// Fails if the section is missing or empty, so a release cannot go out without notes.
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("usage: release-notes.ts <version>");
  process.exit(2);
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const start = lines.findIndex((l) => new RegExp(`^## \\[${escaped}\\]`).test(l));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section. Rename [Unreleased] before tagging.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end === -1) end = lines.length;
const body = lines
  .slice(start + 1, end)
  .filter((l) => !/^\[[^\]]+\]: /.test(l))   // link reference definitions
  .join("\n")
  .trim();
if (!body) {
  console.error(`The CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}
console.log(body);
