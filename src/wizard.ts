// Interactive onboarding and login, plus their non-interactive counterparts.
import { ApiError, Client, type Credential } from "./api.ts";
import { login, LoginError, type Terms } from "./auth.ts";
import { writeScaffold } from "./agents.ts";
import {
  type Config,
  DEFAULT_DELETION_CAP,
  readConfig,
  readCredential,
  writeConfig,
  writeCredential,
} from "./config.ts";
import { Planka, type Project } from "./planka.ts";
import { ask, askSecret, choose, confirm } from "./prompt.ts";

export class UsageError extends Error {}

async function acceptTermsInteractively(terms: Terms): Promise<boolean> {
  console.log(`\nThe server asks you to accept its terms (${terms.language}):\n`);
  console.log(terms.content.trim());
  console.log();
  return confirm("Accept these terms?");
}

async function verify(server: string, cred: Credential): Promise<string> {
  const me = await new Planka(new Client(server, cred)).me();
  return me.username;
}

async function passwordLogin(server: string): Promise<Credential | null> {
  const email = await ask("Email or username:");
  const password = await askSecret("Password:");
  try {
    const token = await login(server, email, password, acceptTermsInteractively);
    return { type: "bearer", token };
  } catch (err) {
    if (!(err instanceof LoginError)) throw err;
    console.log(err.message);
    return null;
  }
}

async function apiKeyLogin(server: string): Promise<Credential | null> {
  console.log("Create an API key in Planka under your user settings, then paste it here.");
  const token = await askSecret("API key:");
  if (!token) return null;
  const cred: Credential = { type: "apiKey", token };
  try {
    await verify(server, cred);
    return cred;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.log("Planka rejected that key.");
      return null;
    }
    throw err;
  }
}

/** Asks until a credential works; returns it with the username it belongs to. */
export async function interactiveLogin(server: string): Promise<Credential> {
  for (;;) {
    const method = await choose("How do you want to sign in?", [
      "Email (or username) and password",
      "API key (for servers with single sign-on)",
    ]);
    const cred = method === 0 ? await passwordLogin(server) : await apiKeyLogin(server);
    if (!cred) continue;
    console.log(`Signed in as ${await verify(server, cred)}.`);
    return cred;
  }
}

async function chooseProject(api: Planka): Promise<Project> {
  const { projects, boards } = await api.discover();
  if (projects.length === 0) throw new Error("this user sees no projects in Planka");
  if (projects.length === 1) {
    console.log(`Mirroring the only visible project: "${projects[0]!.name}".`);
    return projects[0]!;
  }
  const labels = projects.map((p) => {
    const n = boards.filter((b) => b.projectId === p.id).length;
    return `${p.name}  (${n} board${n === 1 ? "" : "s"})`;
  });
  return projects[await choose("Which project should this directory mirror?", labels)]!;
}

async function askServer(): Promise<string> {
  for (;;) {
    const url = await ask("Planka URL (like https://planka.example.com):");
    if (/^https?:\/\/\S+$/.test(url)) return url.replace(/\/+$/, "");
    console.log("That is not a URL.");
  }
}

/** The wizard: server → login → project. Writes config, credential and scaffold. */
export async function wizard(root: string): Promise<Config> {
  console.log("This directory is not a Planka mirror yet. Let's set one up.\n");
  const server = await askServer();
  const cred = await interactiveLogin(server);
  const api = new Planka(new Client(server, cred));
  const project = await chooseProject(api);
  const cfg: Config = {
    root,
    server,
    project: project.id,
    projectName: project.name,
    deletionCap: DEFAULT_DELETION_CAP,
  };
  writeConfig(cfg);
  writeCredential(root, cred);
  const written = writeScaffold(root);
  console.log(
    `\nWrote planka-sync.yaml, .planka-sync/credentials.json${written.map((w) => `, ${w}`).join("")}.`,
  );
  return cfg;
}

/** `login`: re-authenticate an existing mirror. */
export async function relogin(root: string): Promise<void> {
  const cfg = readConfig(root);
  if (!cfg) throw new UsageError("not a mirror yet; run `npx planka-sync` without arguments first");
  writeCredential(root, await interactiveLogin(cfg.server));
}

export interface InitOptions {
  server?: string;
  project?: string;
  email?: string;
  acceptTerms?: boolean;
}

/** A credential from the environment: an API key, a bearer token, or email + PLANKA_PASSWORD. */
async function nonInteractiveCredential(server: string, opts: InitOptions): Promise<Credential> {
  const fromEnv = readCredential("/nonexistent", process.env);
  if (fromEnv) return fromEnv;
  const password = process.env.PLANKA_PASSWORD;
  if (!opts.email || !password)
    throw new UsageError(
      "no credential: set PLANKA_API_KEY or PLANKA_TOKEN, or pass --email with PLANKA_PASSWORD in the environment",
    );
  const accept = async (terms: Terms) => {
    if (opts.acceptTerms) return true;
    console.error(
      `the server requires accepting its terms (${terms.language}); pass --accept-terms`,
    );
    return false;
  };
  return { type: "bearer", token: await login(server, opts.email, password, accept) };
}

/** A directory already mirroring another server or project must not be re-pointed by accident. */
function refuseForeign(root: string, server: string, project: string): void {
  const existing = readConfig(root);
  if (!existing) return;
  const sameProject = existing.project === project || existing.projectName === project;
  if (existing.server === server && sameProject) return;
  throw new UsageError(
    `${root} already mirrors "${existing.projectName ?? existing.project}" on ${existing.server}; ` +
      "use another directory, or remove planka-sync.yaml and .planka-sync/ to start over",
  );
}

/** `init --server --project`: the wizard without questions. */
export async function initNonInteractive(root: string, opts: InitOptions): Promise<Config> {
  if (!opts.server || !opts.project)
    throw new UsageError("usage: planka-sync init --server <url> --project <name-or-id>");
  const server = opts.server.replace(/\/+$/, "");
  refuseForeign(root, server, opts.project);
  const cred = await nonInteractiveCredential(server, opts);
  const api = new Planka(new Client(server, cred));
  const { projects } = await api.discover();
  const match = projects.find((p) => p.id === opts.project || p.name === opts.project);
  if (!match) {
    const seen = projects.map((p) => `"${p.name}"`).join(", ") || "none";
    throw new Error(`no visible project named or numbered "${opts.project}"; visible: ${seen}`);
  }
  const cfg: Config = {
    root,
    server,
    project: match.id,
    projectName: match.name,
    deletionCap: DEFAULT_DELETION_CAP,
  };
  writeConfig(cfg);
  writeCredential(root, cred);
  writeScaffold(root);
  return cfg;
}
