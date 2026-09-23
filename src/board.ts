// Pushes additions in board.yaml: new labels and new lists (entries without an id).
import { apiError } from "./api.ts";
import { type BoardYaml, parseBoardYaml } from "./checks.ts";
import type { BoardFiles, FileSpec } from "./model.ts";
import type { Run } from "./sync.ts";
import { verdict } from "./verdict.ts";

interface Additions {
  labels: { name: string; color: string }[];
  lists: { name: string }[];
}

function validateAdditions(adds: Additions): string | null {
  for (const x of adds.labels) if (!x.name || !x.color) return "a new label needs name and color";
  for (const x of adds.lists) if (!x.name) return "a new list needs a name";
  return null;
}

/** Anything other than appended labels/lists is not pushable; returns the reason. */
function additions(local: BoardYaml, remote: BoardYaml): Additions | string {
  const withId = {
    ...local,
    labels: local.labels.filter((x) => x.id),
    lists: local.lists.filter((x) => x.id),
  };
  if (JSON.stringify(withId) !== JSON.stringify(remote))
    return "only new labels and lists can be pushed from board.yaml; other edits are undone";
  const adds: Additions = {
    labels: local.labels.filter((x) => !x.id) as Additions["labels"],
    lists: local.lists.filter((x) => !x.id),
  };
  return validateAdditions(adds) ?? adds;
}

async function create(
  run: Run,
  built: BoardFiles,
  adds: Additions,
  path: string,
): Promise<boolean> {
  const label = `${adds.labels.length} labels, ${adds.lists.length} lists`;
  if (run.dry) {
    run.rec.add("pushed", path, `would create ${label}`);
    return false;
  }
  const { boardId, listPositions } = built.index;
  const next = Math.max(0, ...listPositions.values()) + 65536;
  try {
    for (const x of adds.labels) await run.api.createLabel(boardId, x.name, x.color);
    for (const [i, x] of adds.lists.entries())
      await run.api.createList(boardId, x.name, next + i * 65536);
  } catch (err) {
    run.rec.add("failed", path, apiError(err));
    return false;
  }
  run.rec.add("pushed", path, `created ${label}`);
  return true;
}

/**
 * Push phase for board.yaml. "created": labels or lists were made, so the caller re-snapshots
 * before reconciling cards. "reset": the local edit is not pushable and Planka's version is
 * pulled over it. "none": nothing to push.
 */
export async function reconcileBoardYaml(
  run: Run,
  built: BoardFiles,
): Promise<"created" | "reset" | "none"> {
  const remote: FileSpec = built.files[0]!;
  const local = run.store.readLocal(remote.path);
  if (local === null) return "none";
  const v = verdict(local, remote.content, run.store.readBase(remote.baseKey));
  if (v === "pull") return "none";
  if (v === "conflict") {
    run.rec.add("blocked", remote.path, "board.yaml changed on both sides; Planka's version wins");
    return "reset";
  }
  const parsed = parseBoardYaml(local);
  const adds = parsed
    ? additions(parsed, parseBoardYaml(remote.content)!)
    : "board.yaml unparseable";
  if (typeof adds === "string") {
    run.rec.add("blocked", remote.path, adds);
    return "reset";
  }
  return (await create(run, built, adds, remote.path)) ? "created" : "none";
}
