// Finding the configured project and its boards.
import type { Board, Planka, Project } from "./planka.ts";

export function findProject(projects: Project[], wanted: string): Project {
  const project = projects.find((p) => p.id === wanted || p.name === wanted);
  if (!project) {
    const names = projects.map((p) => `"${p.name}"`).join(", ") || "none";
    throw new Error(`no visible project matches "${wanted}"; visible: ${names}`);
  }
  return project;
}

/** Boards of one project and the directory each mirrors into. */
export async function projectBoards(
  api: Planka,
  wanted: string,
): Promise<{ project: Project; boards: Board[] }> {
  const { projects, boards } = await api.discover();
  const project = findProject(projects, wanted);
  return { project, boards: boards.filter((b) => b.projectId === project.id) };
}
