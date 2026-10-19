// schemas/wom.scenario.v2.json is what external validators use; it must not drift from the zod schema (the source of truth).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMAGE_REF_RE, environmentSchema, importRecordSchema } from "../src/schema";

const mirror = JSON.parse(readFileSync(new URL("../../../schemas/wom.scenario.v2.json", import.meta.url), "utf8"));
const record = mirror.properties.scenarios.items;
const env = record.properties.environmentJson;

describe("schemas/wom.scenario.v2.json", () => {
  it("describes every field of an import record", () => {
    expect(Object.keys(record.properties).sort()).toEqual(Object.keys(importRecordSchema.shape).sort());
  });

  it("requires what the record schema requires", () => {
    const optional = Object.entries(importRecordSchema.shape)
      .filter(([, s]) => s.safeParse(undefined).success)
      .map(([k]) => k);
    expect([...record.required].sort()).toEqual(Object.keys(importRecordSchema.shape).filter((k) => !optional.includes(k)).sort());
  });

  it("describes the stored environment: every field except the file references", () => {
    const stored = Object.keys(environmentSchema.shape).filter((k) => !["build", "setup", "break", "check", "solve"].includes(k));
    expect(Object.keys(env.properties).sort()).toEqual(stored.sort());
  });

  it("knows every environment kind", () => {
    expect([...env.properties.kind.enum].sort()).toEqual([...environmentSchema.shape.kind.unwrap().options].sort());
  });

  it("uses the same image grammar and capability pattern", () => {
    expect(new RegExp(env.properties.image.pattern).source).toBe(IMAGE_REF_RE.source);
    expect(new RegExp(env.properties.images.items.pattern).source).toBe(IMAGE_REF_RE.source);
    const cap = new RegExp(env.properties.capabilities.items.pattern);
    for (const ok of ["NET_BIND_SERVICE", "CHOWN"]) expect(cap.test(ok)).toBe(true);
    for (const bad of ["CAP_CHOWN", "chown", "A", ""]) expect(cap.test(bad)).toBe(false);
  });

  it("agrees with the schema on mount paths and tmpfs sizes", () => {
    const mount = new RegExp(env.properties.writable.items.pattern);
    expect(new RegExp(env.properties.tmpfs.propertyNames.pattern).source).toBe(mount.source);
    for (const p of ["/", "/etc", "/opt/app", "/a..b", "/.hidden", "/..x"]) {
      expect(mount.test(p), p).toBe(true);
      expect(environmentSchema.shape.writable.safeParse([p]).success, p).toBe(true);
    }
    for (const p of ["/etc/../usr", "/usr/./bin", "/usr//bin", "/home/", "/..", "/."]) {
      expect(mount.test(p), p).toBe(false);
      expect(environmentSchema.shape.writable.safeParse([p]).success, p).toBe(false);
    }
    const size = new RegExp(env.properties.tmpfs.additionalProperties.pattern);
    for (const ok of ["size=64m", "size=1G", "size=512k"]) expect(size.test(ok), ok).toBe(true);
    for (const bad of ["size=64", "64m", "size=m", "mode=1777"]) expect(size.test(bad), bad).toBe(false);
  });

  it("uses the node image pattern of the schema", () => {
    const pattern = new RegExp(env.properties.cluster.properties.nodeImage.pattern);
    for (const ok of ["kindest/node:v1.37.0", `kindest/node:v1.31.1@sha256:${"a".repeat(64)}`]) {
      expect(pattern.test(ok), ok).toBe(true);
      expect(environmentSchema.shape.cluster.safeParse({ nodeImage: ok }).success, ok).toBe(true);
    }
    for (const bad of ["kindest/node:latest", "evil/node:v1.37.0", "kindest/node:v1.37"]) {
      expect(pattern.test(bad), bad).toBe(false);
      expect(environmentSchema.shape.cluster.safeParse({ nodeImage: bad }).success, bad).toBe(false);
    }
  });
});
