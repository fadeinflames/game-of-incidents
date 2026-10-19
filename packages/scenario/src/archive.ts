// Scenario zip handling shared by the author upload (web) and the moderation test run (orchestrator).
// Defensive: path traversal, absolute paths, symlink-ish entries, size and file-count caps.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Inflate } from "fflate";

export const ZIP_MAX_BYTES = 5 * 1024 * 1024;
export const EXTRACT_MAX_BYTES = 20 * 1024 * 1024;
export const EXTRACT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const EXTRACT_MAX_FILES = 200;

export class ArchiveError extends Error {}

export type ExtractedScenario = { dir: string; files: number; bytes: number };

type ZipEntry = { name: string; method: number; packed: number; size: number; dataStart: number };

const BROKEN = "не удалось распаковать zip";
const ZIP64 = "zip64-архивы не поддерживаются";
// deflate expands at most ~1032x, so one compressed chunk can produce about 8 MB before the size check sees it
const INFLATE_CHUNK = 8 * 1024;

/** archiver leftovers (macOS resource forks and Finder files, VCS metadata): ignored entirely, not counted in any limit */
function isJunk(name: string): boolean {
  const parts = name.split("/");
  return parts.includes("__MACOSX") || parts.some((p) => p.startsWith("._") || p.startsWith(".git") || p === ".DS_Store");
}

/** a malformed archive surfaces as RangeError (read past the end) or as fflate's error on a broken deflate stream */
function asArchiveError(e: unknown): ArchiveError {
  return e instanceof ArchiveError ? e : new ArchiveError(BROKEN);
}

/**
 * Reads the central directory only: names, declared sizes and data offsets, nothing is decompressed.
 * fflate's unzipSync is not used on purpose: it allocates every entry by its declared size up front, and an entry that
 * declares less than it really holds is inflated to the end anyway (seconds of CPU for a 5 MB archive, output silently cut).
 */
function readCentralDirectory(zip: Uint8Array): ZipEntry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // end-of-central-directory record: 22 bytes followed by a comment of up to 65535 bytes
  let eocd = zip.byteLength - 22;
  const stop = Math.max(0, eocd - 0xffff);
  while (eocd >= stop && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < stop) throw new ArchiveError(BROKEN);
  const count = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || pos === 0xffffffff) throw new ArchiveError(ZIP64);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) throw new ArchiveError(BROKEN);
    const flags = dv.getUint16(pos + 8, true);
    const method = dv.getUint16(pos + 10, true);
    const packed = dv.getUint32(pos + 20, true);
    const size = dv.getUint32(pos + 24, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const local = dv.getUint32(pos + 42, true);
    if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ArchiveError(ZIP64);
    if (flags & 1) throw new ArchiveError("зашифрованные архивы не поддерживаются");
    const name = decoder.decode(zip.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + dv.getUint16(pos + 30, true) + dv.getUint16(pos + 32, true);
    if (dv.getUint32(local, true) !== 0x04034b50) throw new ArchiveError(BROKEN);
    const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    if (dataStart + packed > zip.byteLength) throw new ArchiveError(BROKEN);
    entries.push({ name, method, packed, size, dataStart });
  }
  return entries;
}

/** inflates in small chunks and stops as soon as the output outgrows the declared size: a lying header costs milliseconds */
function inflateExact(packed: Uint8Array, size: number, name: string): Uint8Array {
  const mismatch = () => new ArchiveError(`размер файла в архиве не совпадает с заявленным: ${name}`);
  const out = new Uint8Array(size);
  let written = 0;
  const inflate = new Inflate((chunk) => {
    if (written + chunk.length > size) throw mismatch();
    out.set(chunk, written);
    written += chunk.length;
  });
  for (let o = 0; o < packed.length; o += INFLATE_CHUNK) inflate.push(packed.subarray(o, o + INFLATE_CHUNK), o + INFLATE_CHUNK >= packed.length);
  if (written !== size) throw mismatch();
  return out;
}

/** unzip into `dir`; returns the folder that contains scenario.yaml (the zip root or one top-level folder) */
export function extractScenarioZip(zip: Uint8Array, dir: string): ExtractedScenario {
  if (zip.byteLength > ZIP_MAX_BYTES) throw new ArchiveError(`архив больше ${ZIP_MAX_BYTES / 1024 / 1024} МБ`);
  let entries: ZipEntry[];
  try {
    entries = readCentralDirectory(zip).filter((e) => !e.name.endsWith("/") && !isJunk(e.name));
  } catch (e) {
    throw asArchiveError(e);
  }
  const names = entries.map((e) => e.name);
  if (!names.length) throw new ArchiveError("архив пуст");
  if (names.length > EXTRACT_MAX_FILES) throw new ArchiveError(`в архиве больше ${EXTRACT_MAX_FILES} файлов`);
  // every limit is checked against the declared sizes first: nothing is decompressed or written until the whole archive fits
  let bytes = 0;
  let packed = 0;
  const root = path.resolve(dir);
  const wanted: { entry: ZipEntry; target: string }[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || name.includes("\0")) throw new ArchiveError(`недопустимый путь в архиве: ${name}`);
    if (entry.method !== 0 && entry.method !== 8) throw new ArchiveError(`неподдерживаемый метод сжатия: ${name}`);
    if (entry.method === 0 && entry.packed !== entry.size) throw new ArchiveError(BROKEN);
    if (entry.size > EXTRACT_MAX_FILE_BYTES) throw new ArchiveError(`файл больше ${EXTRACT_MAX_FILE_BYTES / 1024 / 1024} МБ: ${name}`);
    bytes += entry.size;
    if (bytes > EXTRACT_MAX_BYTES) throw new ArchiveError(`распакованный размер больше ${EXTRACT_MAX_BYTES / 1024 / 1024} МБ`);
    // records that share one compressed blob would make us inflate the same megabytes once per record (seconds of CPU)
    packed += entry.packed;
    if (packed > zip.byteLength) throw new ArchiveError(BROKEN);
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) throw new ArchiveError(`недопустимый путь в архиве: ${name}`);
    wanted.push({ entry, target });
  }
  mkdirSync(root, { recursive: true });
  for (const { entry, target } of wanted) {
    const raw = zip.subarray(entry.dataStart, entry.dataStart + entry.packed);
    let data = raw;
    if (entry.method === 8) {
      try {
        data = inflateExact(raw, entry.size, entry.name);
      } catch (e) {
        throw asArchiveError(e);
      }
    }
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data, { mode: 0o644 });
    } catch (e) {
      // a name that is both a file and a folder in the archive, or one the filesystem refuses: the archive's fault, not ours
      if (["EEXIST", "ENOTDIR", "EISDIR", "ENAMETOOLONG", "EINVAL"].includes((e as NodeJS.ErrnoException).code ?? "")) throw new ArchiveError(`недопустимый путь в архиве: ${entry.name}`);
      throw e;
    }
  }
  // scenario.yaml at the root, or inside exactly one top-level folder (how most zips of a folder look)
  const yamlAtRoot = names.includes("scenario.yaml");
  if (yamlAtRoot) return { dir: root, files: names.length, bytes };
  const tops = new Set(names.map((n) => n.split("/")[0]));
  if (tops.size === 1) {
    const top = [...tops][0];
    if (names.includes(`${top}/scenario.yaml`)) return { dir: path.join(root, top), files: names.length, bytes };
  }
  throw new ArchiveError("в архиве нет scenario.yaml (в корне или в единственной папке верхнего уровня)");
}
