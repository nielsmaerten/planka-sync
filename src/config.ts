// The mirror root holds a committable `planka-sync.yaml` (server, project, options) and a
// gitignored `.planka-sync/` (credential, manifest, base copies).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Credential } from "./api.ts";

export const CONFIG_FILE = "planka-sync.yaml";
export const STATE_DIR = ".planka-sync";
export const CREDENTIALS_FILE = "credentials.json";
export const DEFAULT_DELETION_CAP = 10;

/** Seconds the watcher waits: local quiet period, between polls, between full syncs. */
export interface WatchTimings {
  quiet: number;
  poll: number;
  fullSync: number;
}
export const DEFAULT_WATCH: WatchTimings = { quiet: 5, poll: 10, fullSync: 300 };
/** Floors, so that a typo cannot turn the watcher into a load test of a shared server. */
export const WATCH_MIN: WatchTimings = { quiet: 1, poll: 2, fullSync: 30 };

/** Defaults overlaid with the given values; returns the problem instead when one is invalid. */
export function watchTimings(
  base: WatchTimings,
  raw: Partial<Record<keyof WatchTimings, unknown>>,
): WatchTimings | string {
  const out = { ...base };
  for (const key of Object.keys(DEFAULT_WATCH) as (keyof WatchTimings)[]) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < WATCH_MIN[key])
      return `${key} must be a number of seconds, at least ${WATCH_MIN[key]}`;
    out[key] = v;
  }
  if (out.fullSync < out.poll) return "fullSync must be at least poll";
  return out;
}

/** Which boards of the project to mirror, by name or id; absent means all of them. */
export type BoardFilter = { include: string[] } | { exclude: string[] };

export interface Config {
  root: string;
  server: string;
  /** Planka project id. */
  project: string;
  /** Informational; the id is what the sync uses. */
  projectName?: string;
  /** Refuse a run that would trash more cards than this. */
  deletionCap: number;
  boards?: BoardFilter;
  watch: WatchTimings;
}

interface ConfigFile {
  server?: string;
  project?: string | number;
  projectName?: string;
  deletionCap?: number;
  boards?: { include?: unknown; exclude?: unknown } | null;
  watch?: Partial<Record<keyof WatchTimings, unknown>> | null;
}

function names(key: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(
      `${CONFIG_FILE}: "boards.${key}" must be a non-empty list of board names or ids`,
    );
  return raw.map((v) => {
    if (typeof v !== "string" && typeof v !== "number")
      throw new Error(
        `${CONFIG_FILE}: "boards.${key}" holds a value that is not a board name or id`,
      );
    return String(v);
  });
}

/** `boards:` with exactly one of `include` and `exclude`. */
export function parseBoardFilter(raw: ConfigFile["boards"]): BoardFilter | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${CONFIG_FILE}: "boards" needs an "include" or "exclude" list`);
  const hasInclude = raw.include !== undefined;
  const hasExclude = raw.exclude !== undefined;
  if (hasInclude === hasExclude)
    throw new Error(`${CONFIG_FILE}: "boards" needs exactly one of "include" and "exclude"`);
  return hasInclude
    ? { include: names("include", raw.include) }
    : { exclude: names("exclude", raw.exclude) };
}

export const configPath = (root: string): string => join(root, CONFIG_FILE);
export const credentialPath = (root: string): string => join(root, STATE_DIR, CREDENTIALS_FILE);

/** The config in this root, or null when the directory is not a mirror yet. */
export function readConfig(root: string): Config | null {
  const path = configPath(root);
  if (!existsSync(path)) return null;
  const raw = (parse(readFileSync(path, "utf8")) ?? {}) as ConfigFile;
  if (!raw.server || raw.project === undefined || raw.project === null)
    throw new Error(`${CONFIG_FILE}: needs "server" and "project"`);
  return {
    root,
    server: String(raw.server).replace(/\/+$/, ""),
    project: String(raw.project),
    projectName: raw.projectName,
    deletionCap: raw.deletionCap ?? DEFAULT_DELETION_CAP,
    boards: parseBoardFilter(raw.boards),
    watch: parseWatch(raw.watch),
  };
}

function parseWatch(raw: ConfigFile["watch"]): WatchTimings {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw)))
    throw new Error(`${CONFIG_FILE}: "watch" holds quiet, poll and fullSync in seconds`);
  const timings = watchTimings(DEFAULT_WATCH, raw ?? {});
  if (typeof timings === "string") throw new Error(`${CONFIG_FILE}: watch.${timings}`);
  return timings;
}

export function writeConfig(cfg: Config): void {
  const doc = {
    server: cfg.server,
    project: cfg.project,
    ...(cfg.projectName ? { projectName: cfg.projectName } : {}),
    ...(cfg.deletionCap !== DEFAULT_DELETION_CAP ? { deletionCap: cfg.deletionCap } : {}),
    ...(cfg.boards ? { boards: cfg.boards } : {}),
    ...(JSON.stringify(cfg.watch) !== JSON.stringify(DEFAULT_WATCH) ? { watch: cfg.watch } : {}),
  };
  const header =
    "# planka-sync: which Planka project this directory mirrors. Safe to commit.\n" +
    "# The credential lives in .planka-sync/ (gitignored); run `npx planka-sync login` to renew it.\n" +
    "# To mirror only some boards, add `boards:` with an `include:` or an `exclude:` list of\n" +
    "# board names (or ids). A board taken out of the mirror keeps its directory on disk.\n";
  writeFileSync(configPath(cfg.root), header + stringify(doc));
}

/** Environment first (agents, CI), then the credential file. */
export function readCredential(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Credential | null {
  if (env.PLANKA_API_KEY) return { type: "apiKey", token: env.PLANKA_API_KEY };
  if (env.PLANKA_TOKEN) return { type: "bearer", token: env.PLANKA_TOKEN };
  const path = credentialPath(root);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Credential>;
  if (!raw.token || (raw.type !== "bearer" && raw.type !== "apiKey")) return null;
  return { type: raw.type, token: raw.token };
}

export function writeCredential(root: string, cred: Credential): void {
  const path = credentialPath(root);
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
