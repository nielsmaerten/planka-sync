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

export interface Config {
  root: string;
  server: string;
  /** Planka project id. */
  project: string;
  /** Informational; the id is what the sync uses. */
  projectName?: string;
  /** Refuse a run that would trash more cards than this. */
  deletionCap: number;
}

interface ConfigFile {
  server?: string;
  project?: string | number;
  projectName?: string;
  deletionCap?: number;
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
  };
}

export function writeConfig(cfg: Config): void {
  const doc = {
    server: cfg.server,
    project: cfg.project,
    ...(cfg.projectName ? { projectName: cfg.projectName } : {}),
    ...(cfg.deletionCap !== DEFAULT_DELETION_CAP ? { deletionCap: cfg.deletionCap } : {}),
  };
  const header =
    "# planka-sync: which Planka project this directory mirrors. Safe to commit.\n" +
    "# The credential lives in .planka-sync/ (gitignored); run `npx planka-sync login` to renew it.\n";
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
