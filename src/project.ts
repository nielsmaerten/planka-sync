// Finding the configured project and its boards, and which of those boards to mirror.
import type { BoardFilter } from "./config.ts";
import type { Board, Planka, Project } from "./planka.ts";

export function findProject(projects: Project[], wanted: string): Project {
  const project = projects.find((p) => p.id === wanted || p.name === wanted);
  if (!project) {
    const names = projects.map((p) => `"${p.name}"`).join(", ") || "none";
    throw new Error(`no visible project matches "${wanted}"; visible: ${names}`);
  }
  return project;
}

export interface Selection {
  /** Boards to mirror, in project order. */
  boards: Board[];
  /** Boards of the project left out by the filter. */
  excluded: Board[];
  /** Filter entries that name no board of the project; usually a renamed board or a typo. */
  unmatched: string[];
}

/** Applies `boards:` from the config; an entry matches a board by id or by exact name. */
export function selectBoards(all: Board[], filter: BoardFilter | undefined): Selection {
  if (!filter) return { boards: all, excluded: [], unmatched: [] };
  const wanted = "include" in filter ? filter.include : filter.exclude;
  const matches = (b: Board): boolean => wanted.some((w) => w === b.id || w === b.name);
  const unmatched = wanted.filter((w) => !all.some((b) => w === b.id || w === b.name));
  const keep = "include" in filter ? matches : (b: Board) => !matches(b);
  return {
    boards: all.filter(keep),
    excluded: all.filter((b) => !keep(b)),
    unmatched,
  };
}

/** The configured project and all of its boards, in Planka order. */
export async function projectBoards(
  api: Planka,
  wanted: string,
): Promise<{ project: Project; boards: Board[] }> {
  const { projects, boards } = await api.discover();
  const project = findProject(projects, wanted);
  return { project, boards: boards.filter((b) => b.projectId === project.id) };
}
