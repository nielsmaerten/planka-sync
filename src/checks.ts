// Offline schema checks for card.yaml against its board.yaml.
import { parse } from "yaml";
import { CARD_FIELDS, type CardYaml, type TaskGroup, type TaskItem } from "./card.ts";

export interface BoardYaml {
  id: string;
  name: string;
  lists: { dir: string; name: string; type: string; id?: string }[];
  labels: { name: string; color?: string; id?: string }[];
  members: { user: string; role?: string }[];
}

export function parseBoardYaml(content: string): BoardYaml | null {
  let raw: Partial<BoardYaml> | null;
  try {
    raw = parse(content) as Partial<BoardYaml> | null;
  } catch {
    return null;
  }
  if (!raw || !Array.isArray(raw.lists)) return null;
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    lists: raw.lists,
    labels: raw.labels ?? [],
    members: raw.members ?? [],
  };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

type Rule = [field: keyof CardYaml, ok: (v: unknown) => boolean, message: string];
const optional = (ok: (v: unknown) => boolean) => (v: unknown) => v === undefined || ok(v);
const RULES: Rule[] = [
  ["id", optional(isString), "id must be a quoted string"],
  ["title", optional((v) => isString(v) && v.trim() !== ""), "title must be a non-empty string"],
  ["labels", optional(isStringArray), "labels must be a list of label names"],
  ["members", optional(isStringArray), "members must be a list of usernames"],
  [
    "due",
    optional((v) => v === null || (isString(v) && ISO.test(v))),
    "due must be null or an ISO 8601 timestamp (2026-09-23T17:00:00.000Z)",
  ],
  [
    "dueCompleted",
    optional((v) => v === null || isBool(v)),
    "dueCompleted must be true/false/null",
  ],
];

function checkShape(meta: CardYaml): string[] {
  const unknown = Object.keys(meta)
    .filter((k) => !CARD_FIELDS.has(k))
    .map((k) => `unknown field "${k}"`);
  const failed = RULES.filter(([field, ok]) => !ok(meta[field])).map(([, , message]) => message);
  return [...unknown, ...failed];
}

function checkGroup(group: TaskGroup, gi: number): string[] {
  if (!group || typeof group !== "object") return [`tasks[${gi}] must be a group`];
  const errors: string[] = [];
  if (!isString(group.name) || group.name.trim() === "") errors.push(`tasks[${gi}] needs a name`);
  if (!Array.isArray(group.items)) return [...errors, `tasks[${gi}] needs an items list`];
  return [
    ...errors,
    ...group.items.flatMap((item, ii) => checkItem(item, `tasks[${gi}].items[${ii}]`)),
  ];
}

const ITEM_RULES: [key: keyof TaskItem, ok: (v: unknown) => boolean, message: string][] = [
  ["name", (v) => isString(v) && v.trim() !== "", "needs a name"],
  ["done", optional(isBool), ".done must be true or false"],
  ["id", optional(isString), ".id must be a quoted string"],
  ["assignee", optional(isString), ".assignee must be a username"],
];

function checkItem(item: TaskItem, at: string): string[] {
  if (!item || typeof item !== "object") return [`${at} must be a task`];
  return ITEM_RULES.filter(([key, ok]) => !ok(item[key])).map(
    ([, , m]) => `${at}${m.startsWith(".") ? m : ` ${m}`}`,
  );
}

function checkTasks(meta: CardYaml): string[] {
  if (meta.tasks === undefined) return [];
  if (!Array.isArray(meta.tasks)) return ["tasks must be a list of groups"];
  return meta.tasks.flatMap(checkGroup);
}

const strings = (v: unknown): string[] => (isStringArray(v) ? v : []);
const assignees = (meta: CardYaml): string[] =>
  (Array.isArray(meta.tasks) ? meta.tasks : [])
    .flatMap((g) => (Array.isArray(g?.items) ? g.items : []))
    .map((t) => t?.assignee)
    .filter(isString);

function checkReferences(meta: CardYaml, board: BoardYaml): string[] {
  const labels = new Set(board.labels.map((l) => l.name));
  const members = new Set(board.members.map((m) => m.user));
  return [
    ...strings(meta.labels)
      .filter((l) => !labels.has(l))
      .map((l) => `label "${l}" does not exist on this board`),
    ...strings(meta.members)
      .filter((m) => !members.has(m))
      .map((m) => `"${m}" is not a member of this board`),
    ...assignees(meta)
      .filter((a) => !members.has(a))
      .map((a) => `task assignee "${a}" is not a member of this board`),
  ];
}

/** Errors for one card.yaml; `dir` is the list directory the card sits in. */
export function checkCard(meta: CardYaml, dir: string, board: BoardYaml): string[] {
  const list = board.lists.find((l) => l.dir === dir);
  const errors: string[] = [];
  if (!list) errors.push(`"${dir}" is not a list directory of this board`);
  else if (meta.id === undefined && list.name === list.type)
    errors.push(`new cards cannot be created in the built-in ${list.type} list`);
  if (meta.id === undefined && meta.title === undefined) errors.push("a new card needs a title");
  errors.push(...checkShape(meta), ...checkTasks(meta), ...checkReferences(meta, board));
  return errors;
}
