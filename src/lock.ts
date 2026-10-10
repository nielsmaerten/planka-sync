// Pid files: the sync lock under .planka-sync/ that every sync run holds, and the watcher's pid
// file at the mirror root that tells agents the mirror is synced automatically.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./config.ts";

export const WATCHER_PID_FILE = ".planka-watcher.pid";
export const LOCK_FILE = "sync.lock";

export const lockPath = (root: string): string => join(root, STATE_DIR, LOCK_FILE);
export const watcherPath = (root: string): string => join(root, WATCHER_PID_FILE);

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
 * Creates the pid file for this process. Returns null on success, or the pid of the live process
 * that holds it. A file naming a dead process is stale and gets replaced.
 * ponytail: a recycled pid makes a stale file look live; revisit if that is ever seen.
 */
export function claimPidFile(path: string): number | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readPid(path);
    if (holder !== null && holder !== process.pid && isAlive(holder)) return holder;
    rmSync(path, { force: true });
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
