/// <reference lib="webworker" />

/**
 * Meshes the label volumes off the main thread.
 *
 * Holds one occupancy grid per label (downsampled by `lod`) and meshes it in
 * bricks. The initial build runs as background work; an edit (`slab`) diffs
 * the changed grid layers to find the region that actually changed and queues
 * only the bricks around it, ahead of any background work. Work is done in
 * short slices so edits arriving mid-build are picked up promptly.
 */

import { MeshKind, MesherRequest, MesherResponse, MeshUpdate } from './mesher.protocol';
import {
  Grid,
  blockBrickCount,
  blockBricksInRange,
  downsampleSlab,
  meshBlockBrick,
  meshSurfaceBrick,
  surfaceBrickCount,
  surfaceBricksInRange,
} from './volume-mesher';

interface Task {
  label: number;
  kind: MeshKind;
  brick: number;
}

/** Time budget of one work slice, ms. */
const SLICE_MS = 12;

let gen = -1;
let width = 0;
let height = 0;
let lod = 1;
let B = 32;
let grids: Grid[] = [];
let blocksEnabled = false;

/** Edits: keyed so a brick edited twice is meshed once, in first-edit order. */
const urgent = new Map<string, Task>();
let background: Task[] = [];
let backgroundDone = 0;
let backgroundTotal = 0;
let scheduled = false;

addEventListener('message', ({ data }: MessageEvent<MesherRequest>) => {
  switch (data.type) {
    case 'init':
      init(data);
      break;
    case 'slab':
      if (data.gen === gen) applySlab(data.label, data.z0, new Uint8Array(data.data));
      break;
    case 'blocks':
      if (data.gen === gen) setBlocks(data.enabled);
      break;
  }
});

function init(msg: Extract<MesherRequest, { type: 'init' }>): void {
  gen = msg.gen;
  width = msg.width;
  height = msg.height;
  lod = msg.lod;
  B = msg.brick;
  blocksEnabled = msg.blocks;
  const nx = Math.ceil(width / lod);
  const ny = Math.ceil(height / lod);
  const nz = Math.ceil(msg.depth / lod);
  grids = msg.labels.map((buffer) => {
    const grid: Grid = { nx, ny, nz, data: new Uint8Array(nx * ny * nz) };
    downsampleSlab(new Uint8Array(buffer), width, height, lod, grid, 0);
    return grid;
  });

  urgent.clear();
  background = [];
  for (let label = 0; label < grids.length; label++) {
    queueAll(background, label, 'surface');
    if (blocksEnabled) queueAll(background, label, 'blocks');
  }
  backgroundDone = 0;
  backgroundTotal = background.length;
  schedule();
}

function setBlocks(enabled: boolean): void {
  if (enabled === blocksEnabled) return;
  blocksEnabled = enabled;
  if (!enabled) {
    background = background.filter((t) => t.kind !== 'blocks');
    for (const [key, task] of urgent) if (task.kind === 'blocks') urgent.delete(key);
    return;
  }
  const tasks: Task[] = [];
  for (let label = 0; label < grids.length; label++) queueAll(tasks, label, 'blocks');
  background.push(...tasks);
  backgroundTotal += tasks.length;
  schedule();
}

function brickCounts(kind: MeshKind, grid: Grid): [number, number, number] {
  const count = kind === 'surface' ? surfaceBrickCount : blockBrickCount;
  return [count(grid.nx, B), count(grid.ny, B), count(grid.nz, B)];
}

function queueAll(into: Task[], label: number, kind: MeshKind): void {
  const [bx, by, bz] = brickCounts(kind, grids[label]);
  for (let brick = 0; brick < bx * by * bz; brick++) into.push({ label, kind, brick });
}

/** Re-grid the changed slices and queue the bricks around what changed. */
function applySlab(label: number, z0: number, slab: Uint8Array): void {
  const grid = grids[label];
  if (!grid) return;
  const { nx, ny } = grid;
  const layerSize = nx * ny;
  const gz0 = Math.floor(z0 / lod);
  const layers = Math.ceil(slab.length / (width * height) / lod);
  const gz1 = Math.min(gz0 + layers, grid.nz) - 1;
  if (gz1 < gz0) return;

  const before = grid.data.slice(gz0 * layerSize, (gz1 + 1) * layerSize);
  downsampleSlab(slab, width, height, lod, grid, gz0);

  // Bounding box of the grid voxels that actually changed.
  let x0 = nx, x1 = -1, y0 = ny, y1 = -1, z0c = grid.nz, z1c = -1;
  for (let l = 0; l <= gz1 - gz0; l++) {
    const after = grid.data.subarray((gz0 + l) * layerSize, (gz0 + l + 1) * layerSize);
    const old = before.subarray(l * layerSize, (l + 1) * layerSize);
    for (let y = 0; y < ny; y++) {
      const row = y * nx;
      for (let x = 0; x < nx; x++) {
        if (after[row + x] !== old[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          z0c = Math.min(z0c, gz0 + l);
          z1c = Math.max(z1c, gz0 + l);
        }
      }
    }
  }
  if (x1 < 0) return; // same occupancy at this level of detail

  const kinds: MeshKind[] = blocksEnabled ? ['surface', 'blocks'] : ['surface'];
  for (const kind of kinds) {
    const inRange = kind === 'surface' ? surfaceBricksInRange : blockBricksInRange;
    const rx = inRange(x0, x1, grid.nx, B);
    const ry = inRange(y0, y1, grid.ny, B);
    const rz = inRange(z0c, z1c, grid.nz, B);
    if (!rx || !ry || !rz) continue;
    const [bx, by] = brickCounts(kind, grid);
    for (let k = rz[0]; k <= rz[1]; k++) {
      for (let j = ry[0]; j <= ry[1]; j++) {
        for (let i = rx[0]; i <= rx[1]; i++) {
          const brick = (k * by + j) * bx + i;
          urgent.set(`${kind}:${label}:${brick}`, { label, kind, brick });
        }
      }
    }
  }
  schedule();
}

/** Yield between work slices through a message rather than `setTimeout`,
 *  which browsers clamp and throttle; incoming requests still interleave. */
const yielder = new MessageChannel();
yielder.port1.onmessage = () => work();

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  yielder.port2.postMessage(null);
}

function work(): void {
  scheduled = false;
  const updates: MeshUpdate[] = [];
  const transfer: Transferable[] = [];
  const start = performance.now();
  let backgroundProgressed = false;

  while (performance.now() - start < SLICE_MS) {
    let task: Task | undefined;
    let isUrgent = false;
    const next = urgent.entries().next();
    if (!next.done) {
      urgent.delete(next.value[0]);
      task = next.value[1];
      isUrgent = true;
    } else if (background.length > 0) {
      task = background.pop();
      backgroundDone++;
      backgroundProgressed = true;
    } else {
      break;
    }
    if (!task) break;

    const mesh = meshBrick(task);
    // A background brick with nothing in it has nothing to replace.
    if (!isUrgent && mesh.indices.length === 0) continue;
    updates.push({ ...task, mesh });
    // Empty meshes share one constant; transferring would detach it.
    if (mesh.indices.length > 0) {
      transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer);
    }
  }

  if (updates.length > 0) {
    post({ type: 'meshes', gen, updates }, transfer);
  }
  if (backgroundProgressed) {
    post({ type: 'progress', gen, done: backgroundDone, total: backgroundTotal });
  }
  if (urgent.size > 0 || background.length > 0) schedule();
}

function meshBrick(task: Task) {
  const grid = grids[task.label];
  const [bx, by] = brickCounts(task.kind, grid);
  const i = task.brick % bx;
  const j = Math.floor(task.brick / bx) % by;
  const k = Math.floor(task.brick / (bx * by));
  return task.kind === 'surface'
    ? meshSurfaceBrick(grid, B, i, j, k)
    : meshBlockBrick(grid, B, i, j, k);
}

function post(message: MesherResponse, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}
