// Pid files: the sync lock under .planka-sync/ that every sync run holds, and the watcher's pid
// file at the mirror root that tells agents the mirror is synced automatically.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR, type WatchTimings } from "./config.ts";

export const WATCHER_PID_FILE = ".planka-watcher.pid";
export const LOCK_FILE = "sync.lock";
/** The running watcher's effective timings, for `status`; the pid file stays a bare pid. */
export const WATCHER_INFO_FILE = "watcher.json";

export const lockPath = (root: string): string => join(root, STATE_DIR, LOCK_FILE);
export const watcherPath = (root: string): string => join(root, WATCHER_PID_FILE);
const infoPath = (root: string): string => join(root, STATE_DIR, WATCHER_INFO_FILE);

/** Whether a process with this pid exists (EPERM: it does, under another user). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a pid file names, or null when the file is missing or holds no pid. */
export function readPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Removes a stale pid file under a short-lived takeover guard, and only if it still names the
 * pid that was found dead: two processes that both saw the stale file must not remove each
 * other's fresh one.
 */
function removeStale(path: string, stale: number | null): void {
  const guard = `${path}.takeover`;
  try {
    writeFileSync(guard, `${process.pid}\n`, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Someone else is taking over; a guard left by a process that died meanwhile is cleared.
    if (liveHolder(guard) === null) rmSync(guard, { force: true });
    return;
  }
  try {
    if (readPid(path) === stale) rmSync(path, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
}

/**
 * Creates the pid file for this process. Returns null on success, or the pid of the process that
 * holds it. A file naming a dead process is stale and gets replaced.
 * ponytail: a recycled pid makes a stale file look live; revisit if that is ever seen.
 */
export function claimPidFile(path: string): number | null {
  mkdirSync(dirname(path), { recursive: true });
  // Three rounds: clear a dead takeover guard, remove the stale file, create ours.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readPid(path);
    if (holder !== null && holder !== process.pid && isAlive(holder)) return holder;
    removeStale(path, holder);
  }
  return readPid(path) ?? -1;
}

/** Removes the pid file if it still names this process. */
export function releasePidFile(path: string): void {
  if (readPid(path) === process.pid) rmSync(path, { force: true });
}

/** The live process holding the pid file, or null (missing or stale). */
export function liveHolder(path: string): number | null {
  const pid = readPid(path);
  return pid !== null && isAlive(pid) ? pid : null;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Takes the sync lock, waiting while another live process holds it. `onWait` is called once,
 * with the holder's pid, when the lock is busy. Returns the function that releases it.
 */
export async function acquireLock(
  root: string,
  onWait?: (holder: number) => void,
): Promise<() => void> {
  const path = lockPath(root);
  let told = false;
  for (;;) {
    const holder = claimPidFile(path);
    if (holder === null) return () => releasePidFile(path);
    if (!told) onWait?.(holder);
    told = true;
    await pause(200);
  }
}

/** Runs `fn` while holding the sync lock. */
export async function withLock<T>(
  root: string,
  onWait: (holder: number) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(root, onWait);
  try {
    return await fn();
  } finally {
    release();
  }
}

export type WatcherStatus =
  | { state: "running"; pid: number; timings: WatchTimings | null }
  | { state: "stale"; pid: number }
  | { state: "none" };

/** Records the timings of the watcher that holds the pid file. */
export function writeWatcherInfo(root: string, timings: WatchTimings): void {
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  writeFileSync(infoPath(root), `${JSON.stringify({ pid: process.pid, timings })}\n`);
}

/** Removes the watcher's files if they still belong to this process. */
export function releaseWatcher(root: string): void {
  if (readPid(watcherPath(root)) !== process.pid) return;
  rmSync(infoPath(root), { force: true });
  rmSync(watcherPath(root), { force: true });
}

/** Whether a watcher syncs this mirror, from its pid file. */
export function watcherStatus(root: string): WatcherStatus {
  const pid = readPid(watcherPath(root));
  if (pid === null) return { state: "none" };
  if (!isAlive(pid)) return { state: "stale", pid };
  let timings: WatchTimings | null = null;
  try {
    const info = JSON.parse(readFileSync(infoPath(root), "utf8")) as {
      pid: number;
      timings: WatchTimings;
    };
    if (info.pid === pid) timings = info.timings;
  } catch {
    // No info file: a watcher from an older version, or one still starting.
  }
  return { state: "running", pid, timings };
}
