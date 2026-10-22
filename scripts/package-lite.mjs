// Packs lite/codex into lite/steinwall-lite-codex.zip for upload to OpenAI's plugin directory.
// A stored (uncompressed) ZIP written by hand, so packaging needs no extra dependency. Run after
// `npm run build`, which bundles the Lite script into the skill folder.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = "lite/codex";
const out = "lite/steinwall-lite-codex.zip";

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push({ name: relative(root, path).split("\\").join("/"), data: readFileSync(path) });
  }
})(root);
if (!files.some((f) => f.name === "skills/steinwall-lite/scripts/steinwall-lite.mjs")) throw new Error("Lite script missing: run npm run build first");
if (files.some((f) => f.name.startsWith("hooks/") || f.name === ".app.json")) throw new Error("Lite must not contain hooks or app references");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Fixed timestamp (2026-01-01 00:00) so the same input gives the same ZIP.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const locals = [];
const centrals = [];
let offset = 0;
for (const f of files) {
  const name = Buffer.from(f.name, "utf8");
  const crc = crc32(f.data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(f.data.length, 18);
  local.writeUInt32LE(f.data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, f.data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(f.data.length, 20);
  central.writeUInt32LE(f.data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + f.data.length;
}
const centralSize = centrals.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`${out}: ${files.length} files, ${Math.round((offset + centralSize + 22) / 1024)} KB`);
