import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Inflate, strToU8, zipSync, type Zippable } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveError, EXTRACT_MAX_BYTES, EXTRACT_MAX_FILE_BYTES, EXTRACT_MAX_FILES, ZIP_MAX_BYTES, extractScenarioZip } from "../src/archive";

const MB = 1024 * 1024;
const yaml = strToU8("version: 2\n");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wom-archive-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** flat zip: names are written verbatim, so traversal names survive */
const zip = (files: Zippable, level: 0 | 6 = 6) => zipSync(files, { level });

/** offsets of the central directory records, in archive order (zipSync writes no archive comment) */
function centralRecords(z: Uint8Array): number[] {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const eocd = z.byteLength - 22;
  const out: number[] = [];
  let pos = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < dv.getUint16(eocd + 10, true); i++) {
    out.push(pos);
    pos += 46 + dv.getUint16(pos + 28, true) + dv.getUint16(pos + 30, true) + dv.getUint16(pos + 32, true);
  }
  return out;
}
/** rewrites a 16- or 32-bit field of the i-th central directory record: the archive now lies about that entry */
function patch(z: Uint8Array, index: number, field: "flags" | "method" | "size", value: number): Uint8Array {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const at = centralRecords(z)[index];
  if (field === "size") dv.setUint32(at + 24, value, true);
  else dv.setUint16(at + (field === "flags" ? 8 : 10), value, true);
  return z;
}

const written = () => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : []);

describe("extractScenarioZip: accepted archives", () => {
  it("extracts a scenario zipped at the root", () => {
    const r = extractScenarioZip(zip({ "scenario.yaml": yaml, "k8s/app.yaml": strToU8("kind: Pod\n"), "check.sh": strToU8("#!/bin/sh\n") }), dir);
    expect(r).toEqual({ dir: path.resolve(dir), files: 3, bytes: yaml.length + 10 + 10 });
    expect(readFileSync(path.join(dir, "k8s", "app.yaml"), "utf8")).toBe("kind: Pod\n");
  });

  it("returns the single top-level folder when the author zipped the folder itself", () => {
    const r = extractScenarioZip(zip({ demo: { "scenario.yaml": yaml, "brief.md": strToU8("# brief\n") } }), dir);
    expect(r.dir).toBe(path.join(path.resolve(dir), "demo"));
    expect(readFileSync(path.join(r.dir, "scenario.yaml"), "utf8")).toBe("version: 2\n");
  });

  it("reads stored (uncompressed) entries", () => {
    const r = extractScenarioZip(zip({ "scenario.yaml": yaml, "brief.md": strToU8("stored\n") }, 0), dir);
    expect(readFileSync(path.join(r.dir, "brief.md"), "utf8")).toBe("stored\n");
  });

  it("round-trips a compressible file larger than one inflate chunk", () => {
    const big = strToU8("0123456789abcdef\n".repeat(60_000));
    extractScenarioZip(zip({ "scenario.yaml": yaml, "k8s/crds.yaml": big }), dir);
    expect(readFileSync(path.join(dir, "k8s", "crds.yaml")).equals(Buffer.from(big))).toBe(true);
  });

  it("finds the directory of an archive that ends with a comment", () => {
    const plain = zip({ "scenario.yaml": yaml });
    const commented = new Uint8Array(plain.byteLength + 300);
    commented.set(plain);
    commented.fill(0x50, plain.byteLength); // 'P' bytes: the scan must not stop on a partial signature
    new DataView(commented.buffer).setUint16(plain.byteLength - 2, 300, true);
    expect(extractScenarioZip(commented, dir).files).toBe(1);
  });

  it("skips .git and .DS_Store without writing or counting their bytes", () => {
    const r = extractScenarioZip(zip({ "scenario.yaml": yaml, ".git/config": strToU8("[core]\n"), "image/.DS_Store": strToU8("junk") }), dir);
    expect(r.bytes).toBe(yaml.length);
    expect(existsSync(path.join(dir, ".git"))).toBe(false);
    expect(existsSync(path.join(dir, "image", ".DS_Store"))).toBe(false);
  });

  it("ignores __MACOSX and ._* entries of a macOS zip: the single top-level folder is still found", () => {
    const r = extractScenarioZip(
      zip({
        demo: { "scenario.yaml": yaml, "._scenario.yaml": strToU8("fork"), "k8s": { "app.yaml": strToU8("kind: Pod\n"), "._app.yaml": strToU8("fork") } },
        __MACOSX: { demo: { "._scenario.yaml": strToU8("fork") } },
      }),
      dir,
    );
    expect(r.dir).toBe(path.join(path.resolve(dir), "demo"));
    expect(r.files).toBe(2);
    expect(r.bytes).toBe(yaml.length + 10);
    expect(existsSync(path.join(dir, "__MACOSX"))).toBe(false);
    expect(existsSync(path.join(dir, "demo", "._scenario.yaml"))).toBe(false);
    expect(existsSync(path.join(dir, "demo", "k8s", "._app.yaml"))).toBe(false);
  });

  it("does not count the ignored entries against the file and size limits", () => {
    const files: Zippable = { "scenario.yaml": yaml, "__MACOSX/big": new Uint8Array(EXTRACT_MAX_FILE_BYTES + 1) };
    for (let i = 0; i < EXTRACT_MAX_FILES; i++) files[`__MACOSX/._f${i}`] = strToU8("x");
    expect(extractScenarioZip(zip(files), dir).files).toBe(1);
  });
});

describe("extractScenarioZip: rejected archives", () => {
  it.each([
    ["parent traversal", "../x"],
    ["traversal in the middle", "a/../../x"],
    ["absolute path", "/etc/x"],
    ["backslashes", "a\\b"],
    ["windows traversal", "..\\x"],
    ["NUL byte", "a\0b"],
  ])("refuses %s and writes nothing", (_label, name) => {
    const z = zip({ "scenario.yaml": yaml, [name]: strToU8("x") });
    expect(() => extractScenarioZip(z, dir)).toThrowError(/недопустимый путь в архиве/);
    expect(written()).toEqual([]);
    expect(existsSync(path.join(path.dirname(dir), "x"))).toBe(false);
  });

  it("refuses an archive over the upload limit before parsing it", () => {
    expect(() => extractScenarioZip(new Uint8Array(ZIP_MAX_BYTES + 1), dir)).toThrowError(/архив больше 5 МБ/);
  });

  it.each([
    ["garbage", new Uint8Array(4096).fill(7)],
    ["too short for a zip", new Uint8Array(10)],
    ["truncated", zip({ "scenario.yaml": yaml, "brief.md": strToU8("b".repeat(5000)) }).slice(0, 60)],
  ])("refuses %s input as a broken zip", (_label, bytes) => {
    expect(() => extractScenarioZip(bytes, dir)).toThrowError(new ArchiveError("не удалось распаковать zip"));
  });

  it("refuses an empty archive and one with folders only", () => {
    expect(() => extractScenarioZip(zip({}), dir)).toThrowError(/архив пуст/);
    expect(() => extractScenarioZip(zip({ a: {}, b: {} }), dir)).toThrowError(/архив пуст/);
  });

  it("refuses more files than the limit", () => {
    const files: Zippable = { "scenario.yaml": yaml };
    for (let i = 0; i < EXTRACT_MAX_FILES; i++) files[`f${i}.txt`] = strToU8("x");
    expect(() => extractScenarioZip(zip(files), dir)).toThrowError(/больше 200 файлов/);
    expect(written()).toEqual([]);
  });

  it("refuses a single file over the per-file limit", () => {
    const z = zip({ "scenario.yaml": yaml, "big.bin": new Uint8Array(EXTRACT_MAX_FILE_BYTES + 1) });
    expect(() => extractScenarioZip(z, dir)).toThrowError(/файл больше 2 МБ: big\.bin/);
    expect(written()).toEqual([]);
  });

  it("refuses a total over the extraction limit even when every file fits", () => {
    const files: Zippable = { "scenario.yaml": yaml };
    const one = new Uint8Array(EXTRACT_MAX_FILE_BYTES);
    for (let i = 0; i <= EXTRACT_MAX_BYTES / EXTRACT_MAX_FILE_BYTES; i++) files[`f${i}.bin`] = one;
    expect(() => extractScenarioZip(zip(files), dir)).toThrowError(/распакованный размер больше 20 МБ/);
    expect(written()).toEqual([]);
  });

  it("refuses scenario.yaml in two top-level folders and one nested too deep", () => {
    expect(() => extractScenarioZip(zip({ a: { "scenario.yaml": yaml }, b: { "scenario.yaml": yaml } }), dir)).toThrowError(/нет scenario\.yaml/);
    expect(() => extractScenarioZip(zip({ a: { b: { "scenario.yaml": yaml } } }), dir)).toThrowError(/нет scenario\.yaml/);
  });

  it("refuses a name that is both a file and a folder", () => {
    const z = zip({ "scenario.yaml": yaml, a: strToU8("file"), "a/b": strToU8("child") });
    expect(() => extractScenarioZip(z, dir)).toThrowError(ArchiveError);
  });

  it("refuses encrypted entries and unknown compression methods", () => {
    expect(() => extractScenarioZip(patch(zip({ "scenario.yaml": yaml }), 0, "flags", 1), dir)).toThrowError(/зашифрованные/);
    expect(() => extractScenarioZip(patch(zip({ "scenario.yaml": yaml }), 0, "method", 12), dir)).toThrowError(/неподдерживаемый метод сжатия/);
  });
});

describe("extractScenarioZip: zip bombs", () => {
  // 64 MB of zeros deflate to about 64 KB: small enough to upload, far over every extraction limit
  const bomb = () => zip({ "scenario.yaml": yaml, "bomb.bin": new Uint8Array(64 * MB) });

  it("refuses an honest bomb by its declared size, without inflating anything", () => {
    const push = vi.spyOn(Inflate.prototype, "push");
    const z = bomb();
    expect(z.byteLength).toBeLessThan(MB);
    expect(() => extractScenarioZip(z, dir)).toThrowError(/файл больше 2 МБ: bomb\.bin/);
    expect(push).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
  });

  it("refuses an entry that declares gigabytes, without allocating them", () => {
    const z = patch(zip({ "scenario.yaml": yaml, "bomb.bin": strToU8("tiny") }), 1, "size", 0x7fffffff);
    expect(() => extractScenarioZip(z, dir)).toThrowError(/файл больше 2 МБ/);
  });

  it("stops inflating a bomb that understates its size on the first chunk", () => {
    const push = vi.spyOn(Inflate.prototype, "push");
    const z = patch(bomb(), 1, "size", 1000);
    expect(() => extractScenarioZip(z, dir)).toThrowError(/размер файла в архиве не совпадает с заявленным: bomb\.bin/);
    // scenario.yaml is one chunk; the bomb is several chunks long, and only its first one may be inflated
    expect(push).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(dir, "bomb.bin"))).toBe(false);
  });

  it("refuses an entry that holds less than it declares", () => {
    const z = patch(zip({ "scenario.yaml": yaml, "short.txt": strToU8("a".repeat(100)) }), 1, "size", 200);
    expect(() => extractScenarioZip(z, dir)).toThrowError(/не совпадает с заявленным: short\.txt/);
  });

  it("refuses a stored entry whose two sizes disagree", () => {
    const z = patch(zip({ "scenario.yaml": yaml, "s.txt": strToU8("stored") }, 0), 1, "size", 3);
    expect(() => extractScenarioZip(z, dir)).toThrowError(/не удалось распаковать zip/);
  });

  it("refuses records that share one compressed blob before inflating it once per record", () => {
    // one local entry of empty stored deflate blocks (a lot of input, no output) that every central record points at
    const blocks = 100_000;
    const blob = new Uint8Array(blocks * 5);
    for (let i = 0; i < blocks; i++) blob.set([i === blocks - 1 ? 1 : 0, 0, 0, 0xff, 0xff], i * 5);
    const records = 50;
    const name = (i: number) => strToU8(i === 0 ? "scenario.yaml" : `f${String(i).padStart(12, "0")}`);
    const z = new Uint8Array(30 + 13 + blob.length + records * (46 + 13) + 22);
    const dv = new DataView(z.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, 8, true);
    dv.setUint32(18, blob.length, true);
    dv.setUint16(26, 13, true);
    z.set(name(0), 30);
    z.set(blob, 43);
    const directory = 43 + blob.length;
    for (let i = 0; i < records; i++) {
      const at = directory + i * 59;
      dv.setUint32(at, 0x02014b50, true);
      dv.setUint16(at + 10, 8, true);
      dv.setUint32(at + 20, blob.length, true);
      dv.setUint16(at + 28, 13, true);
      z.set(name(i), at + 46);
    }
    const eocd = directory + records * 59;
    dv.setUint32(eocd, 0x06054b50, true);
    dv.setUint16(eocd + 10, records, true);
    dv.setUint32(eocd + 16, directory, true);
    const push = vi.spyOn(Inflate.prototype, "push");
    expect(() => extractScenarioZip(z, dir)).toThrowError(new ArchiveError("не удалось распаковать zip"));
    expect(push).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
    // the same blob referenced by a single record is a valid empty file
    dv.setUint16(eocd + 10, 1, true);
    expect(extractScenarioZip(z, dir).bytes).toBe(0);
  });

  it("refuses a broken deflate stream", () => {
    const z = zip({ "scenario.yaml": strToU8("version: 2\n".repeat(500)) });
    z.fill(0xff, 45, 60); // inside the compressed data of the only entry
    expect(() => extractScenarioZip(z, dir)).toThrowError(ArchiveError);
  });
});
