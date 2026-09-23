// The card files: card.yaml (metadata) and description.md (body).
import { parse } from "yaml";

export interface TaskItem {
  id?: string;
  name: string;
  done: boolean;
  assignee?: string;
}
export interface TaskGroup {
  name: string;
  items: TaskItem[];
}
export interface CardYaml {
  id?: string;
  title?: string;
  labels?: string[];
  members?: string[];
  due?: string | null;
  dueCompleted?: boolean | null;
  tasks?: TaskGroup[];
}

export const CARD_FIELDS = new Set([
  "id",
  "title",
  "labels",
  "members",
  "due",
  "dueCompleted",
  "tasks",
]);

export const CARD_FILE = "card.yaml";
export const DESCRIPTION_FILE = "description.md";
export const COMMENTS_DIR = "comments";
export const ATTACHMENTS_DIR = "attachments";
export const BOARD_FILE = "board.yaml";

/** Returns the parsed metadata, or an error message. */
export function parseCardYaml(content: string): CardYaml | string {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (err) {
    return `not valid YAML: ${(err as Error).message.split("\n")[0]}`;
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return "must be a YAML mapping";
  return raw as CardYaml;
}

export const flatTasks = (meta: CardYaml): TaskItem[] =>
  (meta.tasks ?? []).flatMap((g) => g.items ?? []);
