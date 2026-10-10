// `status`: what the mirror points at, whether a watcher syncs it, and what is pending.
import { type BoardFilter, type Config, readCredential } from "./config.ts";
import { type WatcherStatus, watcherStatus } from "./lock.ts";
import type { Report } from "./report.ts";
import { Store } from "./state.ts";
import { validateRoot } from "./validate.ts";

/** `only "A", "B"` or `all but "C"`, for the status line. */
function describeFilter(filter: BoardFilter): string {
  const [mode, names] =
    "include" in filter ? ["only", filter.include] : ["all but", filter.exclude];
  return `${mode} ${names.map((n) => `"${n}"`).join(", ")}`;
}

function describeWatcher(w: WatcherStatus): string {
  if (w.state === "none") return "none; run `npx planka-sync` after editing";
  if (w.state === "stale")
    return `none (stale pid file for ${w.pid}; the next --watch replaces it)`;
  const t = w.timings;
  const timings = t ? `: pushes ${t.quiet}s after the last write, polls every ${t.poll}s` : "";
  return `running (pid ${w.pid})${timings}`;
}

/** `status`: server, project, watcher, pending changes, conflicts, last run. */
export function printStatus(cfg: Config, json: boolean): number {
  const v = validateRoot(cfg.root);
  const last = new Store(cfg.root).readJson<Report>("last-run.json");
  const signedIn = readCredential(cfg.root) !== null;
  const watcher = watcherStatus(cfg.root);
  if (json) {
    const out = { config: cfg, signedIn, watcher, validation: v, lastRun: last };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  console.log(`server:    ${cfg.server}`);
  console.log(`project:   ${cfg.projectName ?? cfg.project} (${cfg.project})`);
  if (cfg.boards) console.log(`boards:    ${describeFilter(cfg.boards)}`);
  console.log(`signed in: ${signedIn ? "yes" : "no (run `npx planka-sync login`)"}`);
  console.log(`watcher:   ${describeWatcher(watcher)}`);
  console.log(`last sync: ${last ? `${last.finishedAt}, ${last.stats.errors} errors` : "never"}`);
  const conflicts = v.errors.filter((e) => e.includes("unresolved conflict")).length;
  console.log(
    `pending:   ${v.pending.length} changes, ${conflicts} conflicts, ${v.errors.length} errors`,
  );
  for (const p of v.pending) console.log(`  ${p}`);
  for (const e of v.errors) console.log(`  error: ${e}`);
  return 0;
}
