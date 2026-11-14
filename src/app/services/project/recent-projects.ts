/**
 * The launcher's list of recent projects, kept in localStorage. Pure helpers
 * over the stored array, so they can be tested without a browser store.
 */

/** What the launcher shows about a project without opening it. Refreshed when
 *  the project is opened and when the gallery reloads. */
export interface RecentProjectStats {
  sequences: number;
  frames: number;
  /** Frames marked reviewed. */
  reviewedFrames: number;
  /** "Segmentation", "Classification", "Segmentation + classification"… */
  type: string;
}

export interface RecentProject {
  name: string;
  path: string;
  last_opened: number;
  /** Pinned projects are listed first and never evicted. */
  pinned?: boolean;
  stats?: RecentProjectStats;
}

/** Most unpinned projects remembered. */
export const RECENT_PROJECTS_CAP = 30;

/** Parse the stored list, dropping malformed entries. Older entries lack
 *  `last_opened`, `pinned` and `stats`. */
export function parseRecentProjects(stored: string | null): RecentProject[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as Partial<RecentProject>[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.path === 'string' && p.path && p.name)
      .map((p) => ({
        name: String(p.name),
        path: p.path!,
        last_opened: typeof p.last_opened === 'number' ? p.last_opened : 0,
        ...(p.pinned ? { pinned: true } : {}),
        ...(isStats(p.stats) ? { stats: p.stats } : {}),
      }))
      .sort((a, b) => b.last_opened - a.last_opened);
  } catch {
    return [];
  }
}

function isStats(stats: unknown): stats is RecentProjectStats {
  const s = stats as RecentProjectStats | undefined;
  return (
    !!s &&
    typeof s.sequences === 'number' &&
    typeof s.frames === 'number' &&
    typeof s.reviewedFrames === 'number' &&
    typeof s.type === 'string'
  );
}

/** Keep every pinned project and the most recent unpinned ones. */
function cap(projects: RecentProject[]): RecentProject[] {
  let unpinned = 0;
  return projects.filter((p) => p.pinned || ++unpinned <= RECENT_PROJECTS_CAP);
}

/** Record an open: the project moves to the top, keeping its pin and, unless
 *  new ones are given, its stats. */
export function touchRecentProject(
  projects: RecentProject[],
  name: string,
  path: string,
  now: number,
  stats?: Partial<RecentProjectStats>,
): RecentProject[] {
  const previous = projects.find((p) => p.path === path);
  const entry: RecentProject = {
    ...previous,
    name,
    path,
    last_opened: now,
  };
  const merged = mergeStats(previous?.stats, stats);
  if (merged) entry.stats = merged;
  return cap([entry, ...projects.filter((p) => p.path !== path)]);
}

/** Update a project's stats in place, without moving it. */
export function updateRecentStats(
  projects: RecentProject[],
  path: string,
  stats: Partial<RecentProjectStats>,
): RecentProject[] {
  return projects.map((p) => {
    if (p.path !== path) return p;
    const merged = mergeStats(p.stats, stats);
    return merged ? { ...p, stats: merged } : p;
  });
}

function mergeStats(
  previous: RecentProjectStats | undefined,
  update: Partial<RecentProjectStats> | undefined,
): RecentProjectStats | undefined {
  if (!update) return previous;
  const merged = {
    sequences: 0,
    frames: 0,
    reviewedFrames: 0,
    type: '',
    ...previous,
    ...update,
  };
  // Reviewed frames cannot outnumber frames (stale count after a removal).
  merged.reviewedFrames = Math.min(merged.reviewedFrames, merged.frames);
  return merged;
}

export function setRecentPinned(
  projects: RecentProject[],
  path: string,
  pinned: boolean,
): RecentProject[] {
  return cap(
    projects.map((p) => {
      if (p.path !== path) return p;
      const { pinned: _, ...rest } = p;
      return pinned ? { ...rest, pinned: true } : rest;
    }),
  );
}

/** The project was found at another path: the entry follows it, keeping its
 *  pin and stats. An entry already at `to` is replaced. */
export function relocateRecentProject(
  projects: RecentProject[],
  from: string,
  to: string,
): RecentProject[] {
  if (from === to) return projects;
  return projects
    .filter((p) => p.path !== to)
    .map((p) => (p.path === from ? { ...p, path: to } : p));
}

export function removeRecentProject(
  projects: RecentProject[],
  path: string,
): RecentProject[] {
  return projects.filter((p) => p.path !== path);
}

/** The project's annotation tasks in words. */
export function describeProjectType(config: {
  segmentation_enabled?: boolean;
  instance_segmentation_enabled?: boolean;
  classification_enabled?: boolean;
  text_description_enabled?: boolean;
  regression_enabled?: boolean;
}): string {
  const parts: string[] = [];
  if (config.instance_segmentation_enabled) parts.push('Instances');
  else if (config.segmentation_enabled) parts.push('Segmentation');
  if (config.classification_enabled) parts.push('Classification');
  if (config.text_description_enabled) parts.push('Text');
  if (config.regression_enabled) parts.push('Regression');
  return parts.join(' + ');
}
