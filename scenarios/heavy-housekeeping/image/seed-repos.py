#!/usr/bin/env python3
"""Build time only: the repositories of git-03.

  six code repositories       small text files and a short history, one pack each
  studio/assets.git           the art sources of the studio: binary files of several megabytes
  /var/lib/asset-import       the rest of the studio's archive, 14 batches of 4 files, each batch a pack of its own:
                              break.sh pushes them into studio/assets.git

The binary files are random bytes over a four-letter alphabet: they deflate about three to one, like uncompressed
artwork does, and no file is a delta of another. Everything is seeded, so the object ids are the same in every build.
"""
import os
import random
import subprocess
import sys

ROOT = "/var/lib/git"
IMPORT = "/var/lib/asset-import"
CODE = ["web/storefront.git", "web/checkout.git", "platform/billing-api.git", "platform/deploy-tools.git",
        "mobile/app.git", "docs/handbook.git"]
BIG = "studio/assets.git"
BATCHES = 15            # batch 0 is in the repository from the start, 1..14 are the import
PER_BATCH = 4
MB = 1024 * 1024
TABLE = bytes(b"\x00\x40\x80\xff"[i % 4] for i in range(256))
KINDS = ["characters", "environments", "ui", "cinematics", "props"]


def run(*args, **kw):
    subprocess.run(list(args), check=True, **kw)


def fast_import(repo, stream):
    p = subprocess.Popen(["git", "-c", "fastimport.unpackLimit=0", "-C", repo, "fast-import", "--quiet"], stdin=subprocess.PIPE)
    for chunk in stream:
        p.stdin.write(chunk)
    p.stdin.close()
    if p.wait() != 0:
        sys.exit("fast-import failed for %s" % repo)


def code_stream(name, rnd):
    mark = 0
    when = 1780000000
    for commit in range(30):
        changed = []
        todo = range(120) if commit == 0 else rnd.sample(range(120), 6)
        for n in todo:
            path = "src/mod%02d/unit%03d.txt" % (n % 12, n)
            text = "".join("%s: line %d, revision %d, %08x\n" % (path, i, commit if i % 7 == 0 else 0, rnd.getrandbits(32) if i % 7 == 0 else i)
                           for i in range(40 + n % 30))
            mark += 1
            yield b"blob\nmark :%d\ndata %d\n%s\n" % (mark, len(text), text.encode())
            changed.append((mark, path))
        when += rnd.randrange(3600, 90000)
        msg = ("Initial import of %s" % name if commit == 0 else "Change %d" % commit).encode()
        yield b"commit refs/heads/main\ncommitter Build Bot <build@example.test> %d +0000\ndata %d\n%s\n" % (when, len(msg), msg)
        for m, path in changed:
            yield b"M 100644 :%d %s\n" % (m, path.encode())
        yield b"\n"
    yield b"done\n"


def asset_batch(batch, rnd, parent):
    """one push of the studio: PER_BATCH files"""
    files = []
    for k in range(PER_BATCH):
        n = batch * PER_BATCH + k + 1
        size = int(rnd.uniform(5.5, 7.5) * MB)
        data = rnd.randbytes(size).translate(TABLE)
        yield b"blob\nmark :%d\ndata %d\n" % (k + 1, len(data))
        yield data
        yield b"\n"
        files.append((k + 1, "%s/sheet-%03d.tga" % (KINDS[n % len(KINDS)], n)))
    msg = b"assets: archive import, batch %d" % batch
    yield b"commit refs/heads/main\ncommitter Studio Archive <studio-archive@example.test> %d +0000\ndata %d\n%s\n" % (1790000000 + batch * 600, len(msg), msg)
    if parent:
        yield b"from %s\n" % parent.encode()
    for m, path in files:
        yield b"M 100644 :%d %s\n" % (m, path.encode())
    yield b"\ndone\n"


def packs(repo):
    d = os.path.join(repo, "objects", "pack")
    return {f[:-5] for f in os.listdir(d) if f.endswith(".pack")}


def main():
    for name in CODE:
        repo = os.path.join(ROOT, name)
        run("git", "init", "-q", "--bare", "-b", "main", repo)
        fast_import(repo, code_stream(name, random.Random(name)))
        run("git", "-C", repo, "repack", "-a", "-d", "-q")

    repo = os.path.join(ROOT, BIG)
    run("git", "init", "-q", "--bare", "-b", "main", repo)
    os.makedirs(os.path.join(IMPORT, "incoming"))
    rnd = random.Random(20260920)
    parent = ""
    manifest = []
    for batch in range(BATCHES):
        before = packs(repo)
        fast_import(repo, asset_batch(batch, rnd, parent))
        parent = subprocess.check_output(["git", "-C", repo, "rev-parse", "refs/heads/main"], text=True).strip()
        new = sorted(packs(repo) - before)
        if len(new) != 1:
            sys.exit("batch %d: expected one new pack, got %r" % (batch, new))
        if batch == 0:
            first = parent
        else:
            manifest.append((batch, new[0], parent))
    # the repository itself stays as it was before the import: batch 0 only; the packs of the import wait outside
    run("git", "-C", repo, "update-ref", "refs/heads/main", first)
    with open(os.path.join(IMPORT, "incoming", "MANIFEST"), "w") as f:
        for batch, pack, commit in manifest:
            size = 0
            for ext in (".pack", ".idx"):
                src = os.path.join(repo, "objects", "pack", pack + ext)
                size += os.path.getsize(src)
                os.rename(src, os.path.join(IMPORT, "incoming", pack + ext))
            f.write("%d %s %s %d\n" % (batch, pack, commit, size))
    for extra in os.listdir(os.path.join(repo, "objects", "pack")):
        if extra.endswith((".rev", ".bitmap")):
            os.unlink(os.path.join(repo, "objects", "pack", extra))


main()
