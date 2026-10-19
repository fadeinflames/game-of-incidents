// What the sandbox daemon's images and build cache take on the disk (the answer of `docker system df`). The images built
// for moderator test runs (wom-scenario/<slug>:sub-<id>) and the build cache are never removed by the platform itself,
// so the numbers are what tells an operator the disk is filling up slowly, weeks before the disk guard trips.

export type DockerDiskUsage = {
  /** all image layers, bytes */
  imagesBytes: number;
  imageCount: number;
  /** images built for submissions (tag :sub-<id>); the size is an upper bound, layers shared with other images are counted in full */
  submissionImages: number;
  submissionImagesBytes: number;
  buildCacheBytes: number;
};

type Df = {
  LayersSize?: number;
  Images?: { RepoTags?: string[] | null; Size?: number }[] | null;
  BuildCache?: { Size?: number }[] | null;
};

const SUBMISSION_TAG = /^wom-scenario\/[^:]+:sub-[A-Za-z0-9]+$/;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function summarizeDockerDf(df: Df): DockerDiskUsage {
  const images = df.Images ?? [];
  const sub = images.filter((i) => (i.RepoTags ?? []).some((t) => SUBMISSION_TAG.test(t)));
  return {
    imagesBytes: num(df.LayersSize) || images.reduce((sum, i) => sum + num(i.Size), 0),
    imageCount: images.length,
    submissionImages: sub.length,
    submissionImagesBytes: sub.reduce((sum, i) => sum + num(i.Size), 0),
    buildCacheBytes: (df.BuildCache ?? []).reduce((sum, c) => sum + num(c.Size), 0),
  };
}
