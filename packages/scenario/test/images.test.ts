// The Python stand-ins and the Dockerfiles of the images nobody builds in a unit test: what can be checked without Docker.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ALLOWED_BASE_IMAGES } from "../src/lint";
import { findPython, pythonFiles, pythonSyntaxIssues } from "../src/pycheck";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const python = findPython();
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const scenarios = readdirSync(path.join(root, "scenarios")).filter((d) => readdirSync(path.join(root, "scenarios", d)).includes("scenario.yaml"));
const dockerfiles = [
  ...["images/tools", "images/egress-guard"].map((d) => path.join(root, d, "Dockerfile")),
  ...scenarios.map((s) => path.join(root, "scenarios", s, "image", "Dockerfile")).filter((f) => readdirSync(path.dirname(f)).includes("Dockerfile")),
];

describe.skipIf(!python)("python syntax of the images", () => {
  it("finds the stand-ins", () => {
    expect(pythonFiles(path.join(root, "scenarios")).length).toBeGreaterThan(20);
  });

  it.each(scenarios)("scenarios/%s/image parses", (slug) => {
    expect(pythonSyntaxIssues(path.join(root, "scenarios", slug, "image"))).toEqual([]);
  });

  it("reports a syntax error with the file and the line", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wom-pycheck-"));
    tmp.push(dir);
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "ok.py"), "print('fine')\n");
    writeFileSync(path.join(dir, "sub", "broken.py"), "def f(:\n    pass\n");
    writeFileSync(path.join(dir, "notes.txt"), "def f(:\n");
    const found = pythonSyntaxIssues(dir);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ level: "error", rule: "python-syntax" });
    expect(found[0].message).toMatch(/^sub\/broken\.py:1: /);
  });

  it("does not run the code it checks", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wom-pycheck-"));
    tmp.push(dir);
    const mark = path.join(dir, "ran.txt");
    writeFileSync(path.join(dir, "evil.py"), `open(${JSON.stringify(mark)}, 'w').write('x')\n`);
    expect(pythonSyntaxIssues(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual(["evil.py"]);
  });
});

describe.skipIf(!python)("blind-monitoring gateway: a silent connection", () => {
  // The TLS handshake runs in the accept loop. Before the timeout one client that connects and says nothing held up every other one.
  it("is dropped after the handshake timeout and counted, the accept loop goes on", () => {
    const dir = path.join(root, "scenarios", "blind-monitoring", "image");
    const script = [
      "import socket, ssl, sys, threading",
      `sys.path.insert(0, ${JSON.stringify(dir)})`,
      "import gateway",
      "gateway.HANDSHAKE_TIMEOUT_S = 0.3",
      "a, b = socket.socketpair()  # b stays silent: a client that never sends its hello",
      "class Listener:",
      "    def accept(self): return a, ('127.0.0.1', 1)",
      "srv = gateway.TLSServer.__new__(gateway.TLSServer)",
      "srv.socket = Listener()",
      "gateway.TLSServer.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)",
      "result = []",
      "def accept():",
      "    try: srv.get_request()",
      "    except OSError as e: result.append(str(e))",
      "t = threading.Thread(target=accept, daemon=True)",
      "t.start()",
      "t.join(5)",
      "if t.is_alive(): print('HUNG'); sys.exit(1)",
      "print(result, gateway.state['tls_errors'])",
    ].join("\n");
    const r = spawnSync(python!, ["-c", script], { encoding: "utf8", timeout: 20_000 });
    expect(r.stdout.trim()).toBe("['tls handshake failed'] 1");
    expect(r.status).toBe(0);
  });

  it("the stalled client of an accepted request has a read timeout as well", () => {
    const src = readFileSync(path.join(root, "scenarios", "blind-monitoring", "image", "gateway.py"), "utf8");
    expect(src).toMatch(/class Write\(BaseHTTPRequestHandler\):\s+timeout = \d+/);
  });
});

describe("Dockerfiles", () => {
  it("finds them", () => {
    expect(dockerfiles.length).toBeGreaterThan(15);
  });

  const kubectl = dockerfiles.filter((f) => /dl\.k8s\.io/.test(readFileSync(f, "utf8")));
  it("finds the images that install kubectl", () => {
    expect(kubectl.map((f) => path.relative(root, f).split(path.sep)[1]).sort()).toEqual(
      ["blind-monitoring", "cert-expired", "invisible-network", "lost-storage", "missing-permissions", "tools", "upgrade-gone-wrong"].sort(),
    );
  });

  it.each(kubectl)("%s checks the sha256 of kubectl and does not hard-code amd64", (file) => {
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/\.sha256/);
    expect(text).toMatch(/sha256sum -c/);
    expect(text).not.toMatch(/bin\/linux\/amd64/);
    // the installed file is the one that was checked, and the checksum is checked before the file gets its execute bit
    expect(text.indexOf("sha256sum -c")).toBeLessThan(text.indexOf("chmod 0755 /usr/local/bin/kubectl"));
  });

  it("every image installs the same kubectl version, the minor of the cluster", () => {
    const versions = new Set(kubectl.map((f) => /ARG KUBECTL_VERSION=(\S+)/.exec(readFileSync(f, "utf8"))?.[1]));
    expect([...versions]).toEqual(["v1.37.1"]);
  });

  it("no platform image is built on an alpine that is out of support", () => {
    for (const f of [path.join(root, "images/tools/Dockerfile"), path.join(root, "images/egress-guard/Dockerfile")]) {
      expect(/^FROM (\S+)/m.exec(readFileSync(f, "utf8"))?.[1]).toBe("alpine:3.22");
    }
    expect(ALLOWED_BASE_IMAGES).toContain("alpine:3.22");
  });
});
