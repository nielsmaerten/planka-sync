#!/usr/bin/env node
// planka-sync [verb] [flags]
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, Client } from "./api.ts";
import { LoginError } from "./auth.ts";
import { writeScaffold } from "./agents.ts";
import { type Config, readConfig, readCredential } from "./config.ts";
import { Planka } from "./planka.ts";
import { isInteractive } from "./prompt.ts";
import { formatReport, type Report } from "./report.ts";
import { Store } from "./state.ts";
import { runSync } from "./sync.ts";
import { formatValidation, validateRoot } from "./validate.ts";
import { initNonInteractive, relogin, UsageError, wizard } from "./wizard.ts";

const VERSION: string = (() => {
  try {
    const pkg = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

const USAGE = `usage: planka-sync [verb] [flags]

  (no verb)        set up this directory as a mirror (interactive), or sync it
  sync             push local changes, pull Planka's changes
                   --dry-run  --pull  --push  --yes  --renumber  --json
  validate         check the tree offline; exit 1 on errors    --json
  status           pending changes, conflicts, last run         --json
  login            sign in again (token expired, other user)
  init             non-interactive setup: --server <url> --project <name|id>
                   [--email <e>] [--accept-terms]; credential from PLANKA_API_KEY,
                   PLANKA_TOKEN, or PLANKA_PASSWORD with --email
  api <METHOD> <path> [json-body | -]   one raw request with the mirror's credential

  --dir <path>     the mirror directory (default: the working directory)
  --version, --help

exit codes: 0 ok, 1 errors reported, 2 usage or not a mirror, 3 not signed in`;

const OPTIONS = {
  dir: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  pull: { type: "boolean" },
  push: { type: "boolean" },
  yes: { type: "boolean" },
  renumber: { type: "boolean" },
  server: { type: "string" },
  project: { type: "string" },
  email: { type: "string" },
  "accept-terms": { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean" },
} as const;

type Flags = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "string" ? string : boolean;
};

interface Ctx {
  root: string;
  flags: Flags;
  rest: string[];
}

class NotSignedIn extends Error {}

function requireConfig(root: string): Config {
  const cfg = readConfig(root);
  if (!cfg)
    throw new UsageError(
      `${root} is not a Planka mirror; run \`npx planka-sync\` in a terminal to set it up (or \`init\`)`,
    );
  return cfg;
}

function connect(cfg: Config): Planka {
  const cred = readCredential(cfg.root);
  if (!cred) throw new NotSignedIn(`not signed in to ${cfg.server}; run \`npx planka-sync login\``);
  return new Planka(new Client(cfg.server, cred));
}

async function syncVerb(ctx: Ctx, cfg: Config): Promise<number> {
  const api = connect(cfg);
  writeScaffold(cfg.root);
  if (ctx.flags.pull && ctx.flags.push)
    throw new UsageError("--pull and --push exclude each other");
  const report = await runSync(cfg, api, {
    dry: ctx.flags["dry-run"],
    renumber: ctx.flags.renumber,
    conflicts: ctx.flags.pull ? "pull" : ctx.flags.push ? "push" : "ask",
    yes: ctx.flags.yes,
  });
  if (!ctx.flags["dry-run"]) new Store(cfg.root).writeJson("last-run.json", report);
  process.stdout.write(
    ctx.flags.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report),
  );
  return report.stats.errors > 0 ? 1 : 0;
}

function validateVerb(ctx: Ctx): number {
  requireConfig(ctx.root);
  const v = validateRoot(ctx.root);
  process.stdout.write(ctx.flags.json ? `${JSON.stringify(v, null, 2)}\n` : formatValidation(v));
  return v.errors.length > 0 ? 1 : 0;
}

function statusVerb(ctx: Ctx): number {
  const cfg = requireConfig(ctx.root);
  const v = validateRoot(ctx.root);
  const last = new Store(ctx.root).readJson<Report>("last-run.json");
  const signedIn = readCredential(ctx.root) !== null;
  if (ctx.flags.json) {
    process.stdout.write(
      `${JSON.stringify({ config: cfg, signedIn, validation: v, lastRun: last }, null, 2)}\n`,
    );
    return 0;
  }
  console.log(`server:    ${cfg.server}`);
  console.log(`project:   ${cfg.projectName ?? cfg.project} (${cfg.project})`);
  console.log(`signed in: ${signedIn ? "yes" : "no (run `npx planka-sync login`)"}`);
  console.log(`last sync: ${last ? `${last.finishedAt}, ${last.stats.errors} errors` : "never"}`);
  const conflicts = v.errors.filter((e) => e.includes("unresolved conflict")).length;
  console.log(
    `pending:   ${v.pending.length} changes, ${conflicts} conflicts, ${v.errors.length} errors`,
  );
  for (const p of v.pending) console.log(`  ${p}`);
  for (const e of v.errors) console.log(`  error: ${e}`);
  return 0;
}

async function apiVerb(ctx: Ctx): Promise<number> {
  const [method, path, body] = ctx.rest;
  if (!method || !path?.startsWith("/"))
    throw new UsageError("usage: planka-sync api <METHOD> </api/path> [json-body | -]");
  const api = connect(requireConfig(ctx.root));
  const payload = body === "-" ? readFileSync(0, "utf8") : body;
  try {
    const { text } = await api.client.raw(method.toUpperCase(), path, payload);
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    console.error(`${err.status} ${err.code}: ${err.message}`);
    return 1;
  }
}

async function bare(ctx: Ctx): Promise<number> {
  const cfg = readConfig(ctx.root);
  if (cfg && readCredential(ctx.root)) return syncVerb(ctx, cfg);
  if (!isInteractive()) {
    if (!cfg)
      throw new UsageError(
        `${ctx.root} is not a Planka mirror and there is no terminal for the setup; use \`init\``,
      );
    throw new NotSignedIn(
      `not signed in to ${cfg.server}; run \`npx planka-sync login\` in a terminal`,
    );
  }
  if (cfg) {
    console.log(`Mirror of ${cfg.projectName ?? cfg.project} on ${cfg.server}, but no credential.`);
    await relogin(ctx.root);
    return syncVerb(ctx, cfg);
  }
  const fresh = await wizard(ctx.root);
  console.log("Pulling the project for the first time…\n");
  const code = await syncVerb(ctx, fresh);
  console.log("\nDone. Read AGENTS.md, edit files, run `npx planka-sync` to sync.");
  return code;
}

async function initVerb(ctx: Ctx): Promise<number> {
  const cfg = await initNonInteractive(ctx.root, {
    server: ctx.flags.server,
    project: ctx.flags.project,
    email: ctx.flags.email,
    acceptTerms: ctx.flags["accept-terms"],
  });
  console.log(`set up ${ctx.root} for "${cfg.projectName}" on ${cfg.server}`);
  return syncVerb(ctx, cfg);
}

const VERBS: Record<string, (ctx: Ctx) => Promise<number> | number> = {
  sync: (ctx) => syncVerb(ctx, requireConfig(ctx.root)),
  validate: validateVerb,
  status: statusVerb,
  login: async (ctx) => {
    await relogin(ctx.root);
    return 0;
  },
  init: initVerb,
  api: apiVerb,
};

function context(argv: string[]): Ctx & { verb: string | undefined } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const flags = values as Flags;
  const root = resolve(flags.dir ?? process.cwd());
  if (!existsSync(root)) throw new UsageError(`${root} does not exist`);
  const [verb, ...rest] = positionals;
  return { root, flags, rest, verb };
}

async function main(argv: string[]): Promise<number> {
  const ctx = context(argv);
  if (ctx.flags.version) {
    console.log(`planka-sync ${VERSION}`);
    return 0;
  }
  if (ctx.flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (ctx.verb === undefined) return bare(ctx);
  const fn = VERBS[ctx.verb];
  if (!fn) throw new UsageError(`unknown verb "${ctx.verb}"\n\n${USAGE}`);
  return fn(ctx);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exit(2);
    }
    const unauthorized = err instanceof ApiError && err.status === 401;
    if (err instanceof NotSignedIn || err instanceof LoginError || unauthorized) {
      console.error(
        unauthorized
          ? `${(err as Error).message}; run \`npx planka-sync login\``
          : (err as Error).message,
      );
      process.exit(3);
    }
    console.error(process.env.PLANKA_SYNC_DEBUG ? (err as Error).stack : String(err));
    process.exit(1);
  },
);
