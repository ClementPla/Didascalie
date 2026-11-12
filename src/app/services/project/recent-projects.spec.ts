import {
  RECENT_PROJECTS_CAP,
  RecentProject,
  describeProjectType,
  parseRecentProjects,
  relocateRecentProject,
  setRecentPinned,
  touchRecentProject,
  updateRecentStats,
} from './recent-projects';

const entry = (path: string, last = 0, extra: Partial<RecentProject> = {}) => ({
  name: path.toUpperCase(),
  path,
  last_opened: last,
  ...extra,
});

describe('recent projects', () => {
  it('reads old entries and drops malformed ones', () => {
    const stored = JSON.stringify([
      { name: 'Old', path: '/a.dida' },
      { name: 'Newer', path: '/b.dida', last_opened: 5 },
      { path: '/no-name.dida' },
      null,
      { name: 'Bad stats', path: '/c.dida', stats: { frames: 'x' } },
    ]);
    const projects = parseRecentProjects(stored);
    expect(projects.map((p) => p.path)).toEqual(['/b.dida', '/a.dida', '/c.dida']);
    expect(projects[1].last_opened).toBe(0);
    expect(projects[2].stats).toBeUndefined();
    expect(parseRecentProjects('not json')).toEqual([]);
    expect(parseRecentProjects('{}')).toEqual([]);
  });

  it('moves a reopened project to the top, keeping its pin and stats', () => {
    const stats = { sequences: 3, frames: 10, reviewedFrames: 4, type: 'Segmentation' };
    const before = [entry('/a', 2), entry('/b', 1, { pinned: true, stats })];
    const after = touchRecentProject(before, 'Renamed', '/b', 9, { sequences: 4 });
    expect(after[0]).toEqual({
      name: 'Renamed',
      path: '/b',
      last_opened: 9,
      pinned: true,
      stats: { ...stats, sequences: 4 },
    });
    expect(after.length).toBe(2);
  });

  it('evicts the oldest unpinned projects, never pinned ones', () => {
    let projects: RecentProject[] = [entry('/pinned', 0, { pinned: true })];
    for (let i = 0; i < RECENT_PROJECTS_CAP + 5; i++) {
      projects = touchRecentProject(projects, `P${i}`, `/p${i}`, i + 1);
    }
    expect(projects.length).toBe(RECENT_PROJECTS_CAP + 1);
    expect(projects.some((p) => p.path === '/pinned')).toBeTrue();
    expect(projects.some((p) => p.path === '/p0')).toBeFalse();
  });

  it('updates stats in place and clamps reviewed frames', () => {
    const before = [entry('/a', 2), entry('/b', 1)];
    const after = updateRecentStats(before, '/b', { frames: 5, reviewedFrames: 8 });
    expect(after.map((p) => p.path)).toEqual(['/a', '/b']);
    expect(after[1].stats).toEqual({
      sequences: 0,
      frames: 5,
      reviewedFrames: 5,
      type: '',
    });
  });

  it('pins and unpins', () => {
    const pinned = setRecentPinned([entry('/a')], '/a', true);
    expect(pinned[0].pinned).toBeTrue();
    const unpinned = setRecentPinned(pinned, '/a', false);
    expect('pinned' in unpinned[0]).toBeFalse();
  });

  it('follows a relocated project, replacing a duplicate', () => {
    const before = [entry('/old', 3, { pinned: true }), entry('/new', 1)];
    const after = relocateRecentProject(before, '/old', '/new');
    expect(after).toEqual([{ ...before[0], path: '/new' }]);
  });

  it('names the project type', () => {
    expect(
      describeProjectType({ segmentation_enabled: true, classification_enabled: true }),
    ).toBe('Segmentation + Classification');
    expect(
      describeProjectType({ segmentation_enabled: true, instance_segmentation_enabled: true }),
    ).toBe('Instances');
  });
});
