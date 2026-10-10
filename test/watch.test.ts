import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Config,
  DEFAULT_WATCH,
  readConfig,
  watchTimings,
  writeConfig,
} from "../src/config.ts";
import { isForeign, mirrorState, relevant, toMirrorPath } from "../src/foreign.ts";
import { claimPidFile, liveHolder, releasePidFile, withLock } from "../src/lock.ts";
import type { Snapshot } from "../src/planka.ts";
import { hash, Store } from "../src/state.ts";
import { fingerprint, Watcher } from "../src/watch.ts";
import { timingsFrom } from "../src/watchflags.ts";
import { ApiError } from "../src/api.ts";
import type { Planka } from "../src/planka.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "planka-sync-watch-"));
}

test("watchTimings overlays values and enforces the floors", () => {
  assert.deepEqual(watchTimings(DEFAULT_WATCH, {}), DEFAULT_WATCH);
  assert.deepEqual(watchTimings(DEFAULT_WATCH, { quiet: 2, poll: 3 }), {
    quiet: 2,
    poll: 3,
    fullSync: 300,
  });
  assert.match(String(watchTimings(DEFAULT_WATCH, { poll: 0.5 })), /^poll .* at least 2/);
  assert.match(String(watchTimings(DEFAULT_WATCH, { quiet: "5" })), /^quiet/);
  assert.match(String(watchTimings(DEFAULT_WATCH, { poll: 60, fullSync: 30 })), /^fullSync/);
});

test("config reads watch timings, writes them only when not the defaults", () => {
  const root = tempRoot();
  try {
    const base: Config = { root, server: "s", project: "7", deletionCap: 10, watch: DEFAULT_WATCH };
    writeConfig(base);
    assert.doesNotMatch(readFileSync(join(root, "planka-sync.yaml"), "utf8"), /^watch:/m);
    assert.deepEqual(readConfig(root)?.watch, DEFAULT_WATCH);
    writeConfig({ ...base, watch: { quiet: 3, poll: 10, fullSync: 120 } });
    assert.deepEqual(readConfig(root)?.watch, { quiet: 3, poll: 10, fullSync: 120 });
    writeFileSync(join(root, "planka-sync.yaml"), "server: s\nproject: 7\nwatch:\n  poll: 1\n");
    assert.throws(() => readConfig(root), /watch\.poll .* at least 2/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("timing flags override the config and are checked", () => {
  const cfg = { watch: { quiet: 3, poll: 10, fullSync: 120 } } as Config;
  assert.deepEqual(timingsFrom(cfg, { poll: "4" }), { quiet: 3, poll: 4, fullSync: 120 });
  assert.throws(() => timingsFrom(cfg, { "full-sync": "5" }), /--full-sync/);
  assert.throws(() => timingsFrom(cfg, { quiet: "soon" }), /--quiet/);
});

test("a pid file is claimed once, and a dead holder's file is replaced", async () => {
  const root = tempRoot();
  try {
    const path = join(root, "x.pid");
    assert.equal(claimPidFile(path), null);
    assert.equal(liveHolder(path), process.pid);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    writeFileSync(path, `${child.pid}\n`);
    assert.equal(claimPidFile(path), child.pid);
    child.kill();
    await new Promise((r) => child.once("exit", r));
    assert.equal(liveHolder(path), null);
    assert.equal(claimPidFile(path), null);
    releasePidFile(path);
    assert.equal(liveHolder(path), null);
    assert.equal(claimPidFile(path), null);
    assert.deepEqual(readdirSync(root), ["x.pid"], "no temp or guard files left behind");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("withLock waits for a live holder and releases afterwards", async () => {
  const root = tempRoot();
  try {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    mkdirSync(join(root, ".planka-sync"));
    writeFileSync(join(root, ".planka-sync/sync.lock"), `${child.pid}\n`);
    let waitedFor = 0;
    setTimeout(() => child.kill(), 300);
    const value = await withLock(
      root,
      (pid) => (waitedFor = pid),
      async () => 42,
    );
    assert.equal(value, 42);
    assert.equal(waitedFor, child.pid);
    assert.equal(liveHolder(join(root, ".planka-sync/sync.lock")), null);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("only changes nobody synced count as foreign", () => {
  const root = tempRoot();
  try {
    const store = new Store(root);
    const card = "main/010-todo/010-a";
    const files: Record<string, string> = {
      "main/board.yaml":
        "id: '1'\nname: Main\nlists:\n  - { dir: 010-todo, name: Todo, type: active }\n  - { dir: 020-empty, name: Empty, type: active }\nlabels: []\nmembers: []\n",
      [`${card}/card.yaml`]: "id: '9'\ntitle: A\n",
      [`${card}/description.md`]: "Hello\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    mkdirSync(join(root, "main/020-empty"));
    mkdirSync(join(root, "notes"));
    store.save({
      "main/board.yaml": { kind: "board", hash: hash(files["main/board.yaml"]!), id: "1" },
      [`${card}/card.yaml`]: {
        kind: "card",
        hash: hash(files[`${card}/card.yaml`]!),
        id: "9",
        cardId: "9",
      },
      [`${card}/description.md`]: {
        kind: "description",
        hash: hash("Hello\n"),
        id: "9",
        cardId: "9",
      },
      [`${card}/attachments/a.png`]: { kind: "attachment", hash: null, id: "5", cardId: "9" },
    });
    const state = mirrorState(store);
    const foreign = (rel: string) => isForeign(store, state, rel);

    assert.equal(relevant(state, "notes/x.md"), false, "outside every board");
    assert.equal(relevant(state, "main/010-todo/010-a/card.yaml.123.tmp"), false);
    assert.equal(relevant(state, `${card}/attachments/scratch.tmp`), true, "a user's .tmp file");
    assert.equal(relevant(state, `${card}/description.md`), true);

    assert.equal(foreign(`${card}/description.md`), false, "as the sync left it");
    writeFileSync(join(root, card, "description.md"), "Edited\n");
    assert.equal(foreign(`${card}/description.md`), true, "edited");
    assert.equal(foreign(card), false, "a directory the sync produced");
    assert.equal(foreign("main/020-empty"), false, "an empty list from board.yaml");
    mkdirSync(join(root, "main/010-todo/new-card"));
    assert.equal(foreign("main/010-todo/new-card"), true, "a new or moved directory");
    writeFileSync(join(root, "main/010-todo/new-card/card.yaml.draft"), "title: B\n");
    assert.equal(foreign("main/010-todo/new-card/card.yaml.draft"), true, "a new file");
    writeFileSync(join(root, card, "description.md.conflict"), "Theirs\n");
    assert.equal(foreign(`${card}/description.md.conflict`), false, "the sync writes those");
    rmSync(join(root, card, "description.md.conflict"));
    assert.equal(foreign(`${card}/description.md.conflict`), true, "deleting one resolves it");
    assert.equal(foreign(`${card}/attachments/a.png`), true, "removed after the sync wrote it");
    assert.equal(foreign("main/010-todo/020-gone"), false, "gone and never synced");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a board fingerprint ignores download URLs but not content", () => {
  const snap = (desc: string, url: string) =>
    ({
      item: { id: "1", name: "Main", projectId: "p" },
      included: {
        cards: [{ id: "9", description: desc }],
        attachments: [{ id: "5", type: "file", data: { url, mimeType: "text/plain", size: 3 } }],
      },
    }) as unknown as Snapshot;
  assert.equal(
    fingerprint(snap("a", "http://x/1?sig=1")),
    fingerprint(snap("a", "http://x/1?sig=2")),
  );
  assert.notEqual(fingerprint(snap("a", "http://x/1")), fingerprint(snap("b", "http://x/1")));
});

const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);

test("a stale pid file is left alone while another process is taking it over", async () => {
  const root = tempRoot();
  const dead = sleeper();
  const live = sleeper();
  try {
    const path = join(root, "x.pid");
    dead.kill();
    await new Promise((r) => dead.once("exit", r));
    writeFileSync(path, `${dead.pid}\n`);
    writeFileSync(`${path}.takeover`, `${live.pid}\n`);
    assert.notEqual(claimPidFile(path), null, "busy while the takeover runs");
    assert.equal(readFileSync(path, "utf8"), `${dead.pid}\n`, "not removed underneath it");
    live.kill();
    await new Promise((r) => live.once("exit", r));
    assert.equal(claimPidFile(path), null, "a guard whose holder died is cleared");
    assert.equal(liveHolder(path), process.pid);
  } finally {
    dead.kill();
    live.kill();
    rmSync(root, { recursive: true });
  }
});

test("event names are compared in the manifest's forward-slash form", () => {
  assert.equal(
    toMirrorPath("main\\010-todo\\010-a\\card.yaml", "\\"),
    "main/010-todo/010-a/card.yaml",
  );
  assert.equal(toMirrorPath("main/010-todo", "/"), "main/010-todo");
});

test("a pass with failed requests is retried with backoff", async () => {
  const root = tempRoot();
  try {
    let fetches = 0;
    const api = {
      me: async () => ({ username: "admin", role: "admin" }),
      discover: async () => ({
        projects: [{ id: "p", name: "P" }],
        boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
      }),
      snapshot: async () => {
        fetches += 1;
        throw new ApiError("GET /api/boards/1", 503, { code: "HTTP_503", message: "down" });
      },
    } as unknown as Planka;
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    const lines: string[] = [];
    const watcher = new Watcher(cfg, api, { quiet: 1, poll: 0.05, fullSync: 30 }, (l) =>
      lines.push(l),
    );
    const done = watcher.run();
    for (let i = 0; i < 100 && lines.filter((l) => l.includes("retrying in")).length < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    process.emit("SIGTERM");
    assert.equal(await done, 0);
    assert.ok(fetches >= 2, `fetched ${fetches} times`);
    assert.ok(lines.some((l) => l.includes("failed  main")));
    assert.ok(lines.some((l) => l.includes("1 requests failed; retrying in 0.05s")));
    assert.ok(
      lines.some((l) => l.includes("retrying in 0.1s")),
      "backoff doubles",
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("of processes claiming one pid file at the same instant, exactly one wins", async () => {
  const root = tempRoot();
  try {
    const lock = new URL("../src/lock.ts", import.meta.url).href;
    const path = join(root, "race.pid");
    const at = Date.now() + 1000;
    const script =
      `import { claimPidFile } from ${JSON.stringify(lock)};` +
      `while (Date.now() < ${at});` +
      `console.log(claimPidFile(${JSON.stringify(path)}) === null ? "won" : "lost");` +
      "setTimeout(() => {}, 1500);";
    const results = await Promise.all(
      Array.from({ length: 8 }, () => {
        const child = spawn(process.execPath, [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          script,
        ]);
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        return new Promise<string>((r) => child.once("exit", () => r(out.trim())));
      }),
    );
    assert.equal(results.filter((r) => r === "won").length, 1, results.join(","));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a credential revoked during a pass ends the watcher at the retry with the 401", async () => {
  const root = tempRoot();
  try {
    let meCalls = 0;
    const unauthorized = () =>
      new ApiError("GET /api/x", 401, { code: "E_UNAUTHORIZED", message: "revoked" });
    const api = {
      me: async () => {
        if (++meCalls > 1) throw unauthorized();
        return { username: "admin", role: "admin" };
      },
      discover: async () => ({
        projects: [{ id: "p", name: "P" }],
        boards: [{ id: "1", name: "Main", position: 1, projectId: "p" }],
      }),
      snapshot: async () => {
        throw unauthorized();
      },
    } as unknown as Planka;
    const cfg: Config = { root, server: "s", project: "p", deletionCap: 10, watch: DEFAULT_WATCH };
    const lines: string[] = [];
    const watcher = new Watcher(cfg, api, { quiet: 1, poll: 0.05, fullSync: 30 }, (l) =>
      lines.push(l),
    );
    const started = Date.now();
    await assert.rejects(watcher.run(), (err: unknown) => (err as ApiError).status === 401);
    assert.ok(Date.now() - started < 1000, "within one poll interval of backoff");
    assert.ok(lines.some((l) => l.includes("1 requests failed; retrying in 0.05s")));
    assert.equal(liveHolder(join(root, ".planka-watcher.pid")), null, "pid file released");
  } finally {
    rmSync(root, { recursive: true });
  }
});
