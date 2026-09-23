// Comment files: pull, update, create and delete, decided per file against the base copy.
import { COMMENTS_DIR } from "./card.ts";
import type { Op } from "./diff.ts";
import type { LocalCard } from "./local.ts";
import type { FileSpec } from "./model.ts";
import type { Manifest } from "./state.ts";
import { CONFLICT_SUFFIX } from "./validate.ts";
import { type RemoteCard, type Resolve, verdict } from "./verdict.ts";

export interface CommentPlan {
  pull: FileSpec[];
  conflicts: FileSpec[];
  unresolved: FileSpec[];
  /** Edits or deletions of another user's comment: refused before any API call. */
  blocked: FileSpec[];
  ops: Op[];
}

export interface CommentInput {
  local: LocalCard;
  remote: RemoteCard;
  previous: Manifest;
  base: (key: string) => string | null;
  hasConflict: (path: string) => boolean;
  resolve: Resolve;
  /** Whether the signed-in user may change a comment by this author. */
  canEdit: (author: string | undefined) => boolean;
}

const nameOf = (f: FileSpec): string => f.path.slice(f.path.lastIndexOf("/") + 1);

function planExisting(input: CommentInput, f: FileSpec, plan: CommentPlan): void {
  const { local, previous } = input;
  const name = nameOf(f);
  const path = `${local.dir}/${COMMENTS_DIR}/${name}`;
  if (input.hasConflict(path)) return void plan.unresolved.push(f);
  const content = local.comments.get(name);
  if (content === undefined) {
    // Produced before and now gone: the user removed it. Never produced: pull it.
    if (!(path in previous.files) && !(f.path in previous.files)) plan.pull.push(f);
    else change(input, f, plan, { op: "comment-delete", commentId: f.id! });
    return;
  }
  const v = input.resolve(verdict(content, f.content, input.base(f.baseKey)));
  if (v === "pull") plan.pull.push(f);
  else if (v === "conflict") plan.conflicts.push(f);
  else change(input, f, plan, { op: "comment-update", commentId: f.id!, text: content.trimEnd() });
}

/** A change to a comment goes through only when the signed-in user may change it. */
function change(input: CommentInput, f: FileSpec, plan: CommentPlan, op: Op): void {
  if (input.canEdit(f.author)) plan.ops.push(op);
  else plan.blocked.push(f);
}

/** Decides per comment file; new local files become comments. */
export function planComments(input: CommentInput): CommentPlan {
  const plan: CommentPlan = { pull: [], conflicts: [], unresolved: [], blocked: [], ops: [] };
  const remoteNames = new Set(input.remote.comments.map(nameOf));
  for (const f of input.remote.comments) planExisting(input, f, plan);
  for (const [name, content] of input.local.comments) {
    if (remoteNames.has(name) || name.endsWith(CONFLICT_SUFFIX)) continue;
    const path = `${input.local.dir}/${COMMENTS_DIR}/${name}`;
    if (content.trim() === "") continue;
    plan.ops.push({ op: "comment-create", path, text: content.trimEnd() });
  }
  return plan;
}
