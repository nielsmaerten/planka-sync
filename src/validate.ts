// Offline check of a mirror directory: layout, card.yaml schema, references, pending changes.
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENTS_DIR,
  BOARD_FILE,
  CARD_FILE,
  COMMENTS_DIR,
  DESCRIPTION_FILE,
  parseCardYaml,
} from "./card.ts";
import { type BoardYaml, checkCard, findList, parseBoardYaml } from "./checks.ts";
import { CONFIG_FILE, STATE_DIR } from "./config.ts";
import { parsePrefixed } from "./naming.ts";
import { hash, Store } from "./state.ts";

export const CONFLICT_SUFFIX = ".conflict";

export interface Validation {
  errors: string[];
  warnings: string[];
  pending: string[];
}

/** Tool files that live in the root next to the boards. */
const ROOT_FILES = new Set([CONFIG_FILE, ".gitignore", "AGENTS.md", "README.md", "CLAUDE.md"]);
const CARD_ENTRIES = new Set([CARD_FILE, DESCRIPTION_FILE, COMMENTS_DIR, ATTACHMENTS_DIR]);
const DIR_ENTRIES = new Set([COMMENTS_DIR, ATTACHMENTS_DIR]);

interface Ctx {
  store: Store;
  v: Validation;
}

const entries = (abs: string): Dirent[] => {
  try {
    return readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
};

function entryProblem(e: Dirent): string | null {
  if (e.name.endsWith(CONFLICT_SUFFIX)) {
    const target = e.name.slice(0, -CONFLICT_SUFFIX.length);
    return `unresolved conflict; merge it into ${target}, then delete it`;
  }
  if (!CARD_ENTRIES.has(e.name))
    return `unknown entry; a card holds ${[...CARD_ENTRIES].join(", ")}`;
  if (DIR_ENTRIES.has(e.name) !== e.isDirectory())
    return `must be a ${e.isDirectory() ? "file" : "directory"}`;
  return null;
}

function checkCardLayout(ctx: Ctx, rel: string): void {
  for (const e of entries(join(ctx.store.root, rel))) {
    const problem = entryProblem(e);
    if (problem) ctx.v.errors.push(`${rel}/${e.name}: ${problem}`);
  }
  for (const e of entries(join(ctx.store.root, rel, COMMENTS_DIR)))
    if (!e.isFile() || !e.name.endsWith(".md"))
      ctx.v.errors.push(`${rel}/${COMMENTS_DIR}/${e.name}: comments are .md files`);
}

function checkCardDir(ctx: Ctx, board: BoardYaml, listDir: string, rel: string): void {
  checkCardLayout(ctx, rel);
  const yaml = ctx.store.readLocal(`${rel}/${CARD_FILE}`);
  if (yaml === null) return void ctx.v.errors.push(`${rel}/${CARD_FILE}: missing`);
  const meta = parseCardYaml(yaml);
  if (typeof meta === "string") return void ctx.v.errors.push(`${rel}/${CARD_FILE}: ${meta}`);
  for (const err of checkCard(meta, listDir, board))
    ctx.v.errors.push(`${rel}/${CARD_FILE}: ${err}`);
}

function checkListDir(ctx: Ctx, board: BoardYaml, boardDir: string, listDir: string): void {
  const rel = `${boardDir}/${listDir}`;
  const list = findList(board, listDir);
  if (!list) ctx.v.errors.push(`${rel}: not a list of this board (see ${boardDir}/${BOARD_FILE})`);
  const builtin = list !== undefined && list.name === list.type;
  for (const e of entries(join(ctx.store.root, rel))) {
    if (!e.isDirectory())
      ctx.v.errors.push(`${rel}/${e.name}: cards are directories (${rel}/NNN-<slug>/${CARD_FILE})`);
    else if (!builtin && parsePrefixed(e.name).order === null)
      ctx.v.warnings.push(`${rel}/${e.name}: no order prefix; the next sync adds one`);
    if (e.isDirectory()) checkCardDir(ctx, board, listDir, `${rel}/${e.name}`);
  }
}

function checkBoard(ctx: Ctx, boardDir: string): void {
  const board = parseBoardYaml(ctx.store.readLocal(`${boardDir}/${BOARD_FILE}`) ?? "");
  if (!board)
    return void ctx.v.errors.push(
      `${boardDir}/${BOARD_FILE}: unreadable; the next sync regenerates it`,
    );
  for (const e of entries(join(ctx.store.root, boardDir))) {
    if (e.isDirectory()) checkListDir(ctx, board, boardDir, e.name);
    else if (e.name !== BOARD_FILE)
      ctx.v.warnings.push(`${boardDir}/${e.name}: ignored by the sync`);
  }
}

function checkRoot(ctx: Ctx): void {
  for (const e of entries(ctx.store.root)) {
    if (e.name === STATE_DIR || e.name.startsWith(".git") || ROOT_FILES.has(e.name)) continue;
    if (e.isDirectory() && ctx.store.exists(`${e.name}/${BOARD_FILE}`)) checkBoard(ctx, e.name);
    else ctx.v.warnings.push(`${e.name}: not a board directory; ignored by the sync`);
  }
}

const isText = (rel: string): boolean => rel.endsWith(".md") || rel.endsWith(".yaml");

function pendingFromManifest(ctx: Ctx): Set<string> {
  const seen = new Set<string>();
  for (const [rel, entry] of Object.entries(ctx.store.load().files)) {
    const local = ctx.store.readLocal(rel);
    if (local !== null) seen.add(rel);
    if (entry.hash === null) continue;
    if (local === null) ctx.v.pending.push(`removed: ${rel}`);
    else if (hash(local) !== entry.hash) ctx.v.pending.push(`modified: ${rel}`);
  }
  return seen;
}

/** A file inside a card directory that the sync would push. */
const isCardFile = (rel: string): boolean =>
  rel.split("/").length >= 4 && (isText(rel) || rel.includes(`/${ATTACHMENTS_DIR}/`));

const isInternal = (rel: string): boolean => rel.startsWith(STATE_DIR) || rel.startsWith(".git");

/** What the next sync would push, judged offline against the manifest. */
function pendingChanges(ctx: Ctx): void {
  const seen = pendingFromManifest(ctx);
  const all = readdirSync(ctx.store.root, { recursive: true, withFileTypes: true });
  for (const e of all) {
    const rel = join(e.parentPath, e.name).slice(ctx.store.root.length + 1);
    if (isInternal(rel) || !e.isFile() || seen.has(rel)) continue;
    if (isCardFile(rel)) ctx.v.pending.push(`new: ${rel}`);
  }
}

export function validateRoot(root: string): Validation {
  const ctx: Ctx = { store: new Store(root), v: { errors: [], warnings: [], pending: [] } };
  checkRoot(ctx);
  pendingChanges(ctx);
  return ctx.v;
}

export function formatValidation(v: Validation): string {
  const lines = [
    ...v.warnings.map((w) => `warning: ${w}`),
    ...v.pending.map((p) => `pending ${p}`),
    ...v.errors.map((e) => `error: ${e}`),
    `${v.errors.length} errors, ${v.warnings.length} warnings, ${v.pending.length} pending changes`,
  ];
  return `${lines.join("\n")}\n`;
}
