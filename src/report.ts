// What one sync run did, per path.
export type Outcome =
  | "pulled"
  | "moved"
  | "downloaded"
  | "deleted"
  | "pending"
  | "kept"
  | "pushed"
  | "blocked"
  | "conflict"
  | "failed"
  | "error";

export interface Event {
  path: string;
  outcome: Outcome;
  detail?: string;
}
export interface Stats {
  written: number;
  unchanged: number;
  deleted: number;
  pushed: number;
  pending: number;
  conflicts: number;
  errors: number;
}
export interface Report {
  project: string;
  startedAt: string;
  finishedAt: string;
  dry: boolean;
  boards: string[];
  stats: Stats;
  events: Event[];
}

export const emptyStats = (): Stats => ({
  written: 0,
  unchanged: 0,
  deleted: 0,
  pushed: 0,
  pending: 0,
  conflicts: 0,
  errors: 0,
});

const COUNTER: Partial<Record<Outcome, keyof Stats>> = {
  pulled: "written",
  moved: "written",
  downloaded: "written",
  deleted: "deleted",
  pending: "pending",
  pushed: "pushed",
  conflict: "conflicts",
  failed: "errors",
  error: "errors",
  blocked: "errors",
};

export class Recorder {
  readonly events: Event[] = [];
  readonly stats = emptyStats();

  add(outcome: Outcome, path: string, detail?: string): void {
    this.events.push(detail ? { path, outcome, detail } : { path, outcome });
    const key = COUNTER[outcome];
    if (key) this.stats[key] += 1;
  }

  unchanged(): void {
    this.stats.unchanged += 1;
  }
}

/** Plain text for terminals and agents: one line per event, then the totals. */
export function formatReport(r: Report): string {
  const ms = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
  const lines = [`synced "${r.project}" (${(ms / 1000).toFixed(1)}s)`];
  if (r.dry) lines.push("dry run: nothing written");
  const width = Math.max(0, ...r.events.map((e) => e.outcome.length));
  for (const e of r.events) {
    lines.push(`${e.outcome.padEnd(width)}  ${e.path}${e.detail ? `  (${e.detail})` : ""}`);
  }
  const s = r.stats;
  lines.push(
    `written ${s.written}, unchanged ${s.unchanged}, deleted ${s.deleted}, pushed ${s.pushed}, ` +
      `pending ${s.pending}, conflicts ${s.conflicts}, errors ${s.errors}`,
  );
  return `${lines.join("\n")}\n`;
}
