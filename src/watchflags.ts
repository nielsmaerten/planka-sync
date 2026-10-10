// The `--watch` flags: one-shot flags it refuses, and timing flags over the config's `watch:`.
import { type Config, type WatchTimings, watchTimings } from "./config.ts";
import type { Planka } from "./planka.ts";
import { Watcher } from "./watch.ts";
import { UsageError } from "./wizard.ts";

/** Flags that make no sense for a run nobody watches. */
const NOT_WITH_WATCH = ["dry-run", "pull", "push", "yes", "renumber", "json"] as const;
const TIMING_FLAGS = { quiet: "quiet", poll: "poll", fullSync: "full-sync" } as const;

type WatchFlags = Partial<
  Record<
    (typeof NOT_WITH_WATCH)[number] | (typeof TIMING_FLAGS)[keyof WatchTimings],
    string | boolean
  >
>;

/** The config's timings, with `--quiet`, `--poll` and `--full-sync` overriding them. */
export function timingsFrom(cfg: Config, flags: WatchFlags): WatchTimings {
  const raw: Partial<Record<keyof WatchTimings, unknown>> = {};
  for (const [key, flag] of Object.entries(TIMING_FLAGS) as [keyof WatchTimings, string][]) {
    const v = flags[flag as keyof WatchFlags];
    if (typeof v === "string") raw[key] = v.trim() === "" ? Number.NaN : Number(v);
  }
  const timings = watchTimings(cfg.watch, raw);
  if (typeof timings === "string")
    throw new UsageError(
      `--${TIMING_FLAGS[timings.split(" ")[0] as keyof WatchTimings]}: ${timings}`,
    );
  return timings;
}

/** `--watch`: refuses one-shot flags, then runs the watcher. */
export function watchMirror(cfg: Config, api: Planka, flags: WatchFlags): Promise<number> {
  const bad = NOT_WITH_WATCH.filter((f) => flags[f]);
  if (bad.length > 0)
    throw new UsageError(`--watch does not combine with ${bad.map((f) => `--${f}`).join(", ")}`);
  return new Watcher(cfg, api, timingsFrom(cfg, flags)).run();
}
