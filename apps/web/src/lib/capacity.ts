// Free slots of the platform for the catalogue and the scenario card. The numbers are a nicety, not the content of
// the page: a slow orchestrator must not hold the page back, so the wait is short, and the two components of one
// render (and a prefetch) share a single request.
import "server-only";
import { cache } from "react";
import { orchestrator } from "./orchestrator";

export type Capacity = { all: { active: number; max: number }; kubernetes: { active: number; max: number } };

/** the default 5 s of the orchestrator client is an eternity on the render path */
export const CAPACITY_TIMEOUT_MS = 1000;

export const getCapacity = cache(async (): Promise<Capacity | null> => {
  const r = await orchestrator<Capacity>("/capacity", { timeoutMs: CAPACITY_TIMEOUT_MS });
  return r.status === 200 ? r.body : null;
});
