// Process-level safety net: an error nobody caught is logged as a structured line and the process leaves in an orderly
// way. Without this Node prints a raw stack to stderr and exits at once, with the terminals cut and nothing in the JSON log.
import type { EventEmitter } from "node:events";

export type FatalGuardDeps = {
  proc: Pick<EventEmitter, "on"> & { exit(code?: number): unknown };
  log: (fields: Record<string, unknown>, msg: string) => void;
  /** stops accepting work and lets in-flight requests end; the process exits when it settles or after graceMs, whichever is first */
  cleanup?: () => Promise<void> | void;
  graceMs?: number;
};

/** Sandboxes outlive the orchestrator by design, and the supervisor restarts it: exiting is cheap, running on in an unknown state is not. */
export function installFatalHandlers(deps: FatalGuardDeps): void {
  let leaving = false;
  const leave = () => {
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      deps.proc.exit(1);
    };
    const timer = setTimeout(exit, deps.graceMs ?? 3000);
    try {
      Promise.resolve(deps.cleanup?.()).then(
        () => (clearTimeout(timer), exit()),
        () => (clearTimeout(timer), exit()),
      );
    } catch {
      clearTimeout(timer);
      exit();
    }
  };
  const onFatal = (kind: string) => (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    deps.log({ err, kind }, leaving ? "another fatal error while leaving" : "fatal: unhandled error, shutting down");
    if (leaving) return;
    leaving = true;
    leave();
  };
  deps.proc.on("uncaughtException", onFatal("uncaughtException"));
  deps.proc.on("unhandledRejection", onFatal("unhandledRejection"));
}
