import { describe, expect, it } from "vitest";
import { summarizeDockerDf } from "../src/disk-usage";

describe("summarizeDockerDf", () => {
  it("sums the images, the build cache and separates the images built for submissions", () => {
    const u = summarizeDockerDf({
      LayersSize: 5_000,
      Images: [
        { RepoTags: ["wom-scenario/nginx-502:v1"], Size: 300 },
        { RepoTags: ["wom-scenario/nginx-502:sub-cm1abc2"], Size: 400 },
        { RepoTags: ["wom-scenario/redis-oom:sub-cm9zzz", "wom-scenario/redis-oom:other"], Size: 200 },
        { RepoTags: null, Size: 50 },
      ],
      BuildCache: [{ Size: 1_000 }, { Size: 234 }],
    });
    expect(u).toEqual({ imagesBytes: 5_000, imageCount: 4, submissionImages: 2, submissionImagesBytes: 600, buildCacheBytes: 1_234 });
  });

  it("copes with an empty daemon and with fields the daemon leaves out", () => {
    expect(summarizeDockerDf({})).toEqual({ imagesBytes: 0, imageCount: 0, submissionImages: 0, submissionImagesBytes: 0, buildCacheBytes: 0 });
    expect(summarizeDockerDf({ Images: [{ Size: 10 }, { RepoTags: [], Size: 5 }], BuildCache: null }).imagesBytes).toBe(15);
  });

  it("does not take a published scenario's own tag for a submission's", () => {
    expect(summarizeDockerDf({ Images: [{ RepoTags: ["wom-scenario/subnet-calc:v1"], Size: 1 }, { RepoTags: ["other/x:sub-1"], Size: 1 }] }).submissionImages).toBe(0);
  });
});
