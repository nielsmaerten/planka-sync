// `planka-sync --watch`: sync in a loop until stopped. A local write starts a pass once the mirror
// has been quiet for a while; a cheap poll of each board starts one when Planka changed; a full
// pass runs periodically for what the poll cannot see (comment edits, new boards).
import { type FSWatcher, watch as watchFs } from "node:fs";
import { ApiError, apiError } from "./api.ts";
import { type Config, type WatchTimings, watchTimings } from "./config.ts";
import { isForeign, type MirrorState, mirrorState, relevant } from "./foreign.ts";
import {
  acquireLock,
  claimPidFile,
  liveHolder,
  lockPath,
  releasePidFile,
  watcherPath,
} from "./lock.ts";
import type { Planka, Snapshot } from "./planka.ts";
import type { Report } from "./report.ts";
import { hash, Store } from "./state.ts";
import { runSync } from "./sync.ts";
import { UsageError } from "./wizard.ts";

/** A board snapshot's hash, without the download URLs (they could be signed per request). */
export function fingerprint(snap: Snapshot): string {
  return hash(
    JSON.stringify(snap, (key, value: unknown) => {
      if (key !== "data" || value === null || typeof value !== "object") return value;
      const { url: _url, thumbnailUrls: _thumbs, ...rest } = value as Record<string, unknown>;
      return rest;
    }),
  );
}

const clock = (): string => new Date().toLocaleTimeString("en-GB", { hour12: false });

/** One line per pass, then the paths it touched. */
export function formatPass(reason: string, r: Report): string {
  const s = r.stats;
  const lines = [
    `${clock()}  ${reason.padEnd(6)}  pushed ${s.pushed}, written ${s.written}, ` +
      `deleted ${s.deleted}, pending ${s.pending}, conflicts ${s.conflicts}, errors ${s.errors}`,
  ];
  for (const e of r.events)
    lines.push(`          ${e.outcome}  ${e.path}${e.detail ? `  (${e.detail})` : ""}`);
  return lines.join("\n");
}

const fatal = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

type Timer = ReturnType<typeof setTimeout>;

export class Watcher {
  private readonly store: Store;
  private readonly fetchBoard: (id: string) => Promise<Snapshot>;
  private state: MirrorState;
  private baselines = new Map<string, string>();
  private captured = new Map<string, string>();
  private readonly buffer = new Set<string>();
  private running = false;
  private polling = false;
  private pollFailing = false;
  private failures = 0;
  private wanted: string | null = null;
  private quietTimer: Timer | null = null;
  private flushTimer: Timer | null = null;
  private fullTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private fsWatcher: FSWatcher | null = null;
  private settle: { resolve: (code: number) => void; reject: (err: unknown) => void } | null = null;

  private readonly cfg: Config;
  private readonly api: Planka;
  private readonly timings: WatchTimings;
  private readonly log: (line: string) => void;

  constructor(
    cfg: Config,
    api: Planka,
    timings: WatchTimings,
    log: (line: string) => void = console.log,
  ) {
    this.cfg = cfg;
    this.api = api;
    this.timings = timings;
    this.log = log;
    this.store = new Store(cfg.root);
    this.state = mirrorState(this.store);
    // Every snapshot a pass takes doubles as the poll's baseline for that board; the last one
    // taken is what the pass left on disk.
    const original = api.snapshot;
    this.fetchBoard = original;
    api.snapshot = async (id) => {
      const snap = await original(id);
      this.captured.set(id, fingerprint(snap));
      return snap;
    };
  }

  /** Runs until SIGINT or SIGTERM (resolves 0) or a lost credential (rejects). */
  run(): Promise<number> {
    const holder = claimPidFile(watcherPath(this.cfg.root));
    if (holder !== null)
      throw new UsageError(`a watcher (pid ${holder}) already syncs ${this.cfg.root}`);
    process.on("exit", () => this.release());
    const done = new Promise<number>((resolve, reject) => (this.settle = { resolve, reject }));
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => this.stop(() => this.settle?.resolve(0)));
    this.fsWatcher = watchFs(this.cfg.root, { recursive: true }, (_event, name) =>
      this.onEvent(name),
    );
    this.pollTimer = setInterval(() => void this.poll(), this.timings.poll * 1000);
    const t = this.timings;
    this.log(
      `${clock()}  watching ${this.cfg.root} (quiet ${t.quiet}s, poll ${t.poll}s, full sync ${t.fullSync}s)`,
    );
    this.request("start");
    return done;
  }

  private release(): void {
    releasePidFile(watcherPath(this.cfg.root));
    releasePidFile(lockPath(this.cfg.root));
  }

  private stop(then: () => void): void {
    for (const t of [this.quietTimer, this.flushTimer, this.fullTimer, this.retryTimer])
      if (t) clearTimeout(t);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.fsWatcher?.close();
    this.release();
    then();
  }

  private onEvent(name: string | null): void {
    if (name !== null && !relevant(this.state, name)) return;
    this.buffer.add(name ?? "");
    this.scheduleFlush(200);
  }

  private scheduleFlush(ms: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), ms);
  }

  /** Judges buffered events once no sync is writing: during one, every write looks foreign. */
  private flush(): void {
    this.flushTimer = null;
    if (this.buffer.size === 0) return;
    if (this.running || liveHolder(lockPath(this.cfg.root)) !== null)
      return this.scheduleFlush(500);
    this.state = mirrorState(this.store);
    const paths = [...this.buffer];
    this.buffer.clear();
    // An empty name means the event did not say which path: assume a change.
    if (paths.some((rel) => rel === "" || isForeign(this.store, this.state, rel))) this.quiet();
  }

  private quiet(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.request("local");
    }, this.timings.quiet * 1000);
  }

  /** Asks for a pass; it waits for a running pass and for local writes to go quiet. */
  private request(reason: string): void {
    this.wanted ??= reason;
    if (this.running || this.quietTimer || this.retryTimer) return;
    void this.pass();
  }

  private async pass(): Promise<void> {
    this.running = true;
    const reason = this.wanted ?? "sync";
    this.wanted = null;
    try {
      await this.syncOnce(reason);
      this.failures = 0;
    } catch (err) {
      this.failed(err);
    } finally {
      this.running = false;
      this.state = mirrorState(this.store);
      this.scheduleFull();
      if (this.buffer.size > 0) this.scheduleFlush(200);
      if (this.wanted && !this.quietTimer && !this.retryTimer) void this.pass();
    }
  }

  private async syncOnce(reason: string): Promise<void> {
    const release = await acquireLock(this.cfg.root, (pid) =>
      this.log(`${clock()}  waiting for the sync by pid ${pid}`),
    );
    try {
      this.captured = new Map();
      const report = await runSync(this.cfg, this.api, { conflicts: "ask" });
      this.store.writeJson("last-run.json", report);
      this.baselines = this.captured;
      this.log(formatPass(reason, report));
    } finally {
      release();
    }
  }

  private failed(err: unknown): void {
    if (fatal(err)) return this.stop(() => this.settle?.reject(err));
    this.failures += 1;
    const wait = Math.min(this.timings.poll * 2 ** (this.failures - 1), this.timings.fullSync);
    this.log(`${clock()}  error   ${apiError(err)}; retrying in ${wait}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.request("retry");
    }, wait * 1000);
  }

  private scheduleFull(): void {
    if (this.fullTimer) clearTimeout(this.fullTimer);
    this.fullTimer = setTimeout(() => this.request("full"), this.timings.fullSync * 1000);
  }

  /** Whether any mirrored board differs from its baseline; one request per board. */
  private async remoteChanged(): Promise<boolean> {
    for (const [id, before] of this.baselines)
      if (fingerprint(await this.fetchBoard(id)) !== before) return true;
    return false;
  }

  private async poll(): Promise<void> {
    if (this.running || this.polling || this.retryTimer || this.wanted) return;
    this.polling = true;
    try {
      if (await this.remoteChanged()) this.request("remote");
      this.reachable(null);
    } catch (err) {
      if (fatal(err)) return this.stop(() => this.settle?.reject(err));
      this.reachable(err);
    } finally {
      this.polling = false;
    }
  }

  /** Logs the first failed poll of a streak and the first good one after it. */
  private reachable(err: unknown): void {
    const failing = err !== null;
    if (failing && !this.pollFailing) this.log(`${clock()}  poll    ${apiError(err)}`);
    if (!failing && this.pollFailing) this.log(`${clock()}  poll    reachable again`);
    this.pollFailing = failing;
  }
}

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
