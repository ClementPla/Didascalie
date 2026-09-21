import { BrickMesh } from './volume-mesher';

export type MeshKind = 'surface' | 'blocks';

/** Messages to the mesher worker. `gen` tags everything with the `init` it
 *  belongs to, so replies to a superseded volume are dropped. */
export type MesherRequest =
  | {
      type: 'init';
      gen: number;
      width: number;
      height: number;
      depth: number;
      /** Grid voxel = `lod³` full-resolution voxels. */
      lod: number;
      /** Brick edge, in grid voxels. */
      brick: number;
      /** One full-resolution `W*H*D` mask per label (transferred). */
      labels: ArrayBuffer[];
      blocks: boolean;
    }
  | {
      /** Full-resolution slices `[z0, z0 + n)` of one label changed. `z0` is a
       *  multiple of `lod` and `n` covers whole grid layers. */
      type: 'slab';
      gen: number;
      label: number;
      z0: number;
      data: ArrayBuffer;
    }
  | { type: 'blocks'; gen: number; enabled: boolean };

export interface MeshUpdate {
  label: number;
  kind: MeshKind;
  /** Flat brick index within its kind's brick grid. */
  brick: number;
  /** Empty when the brick no longer has any geometry. */
  mesh: BrickMesh;
}

export type MesherResponse =
  | { type: 'meshes'; gen: number; updates: MeshUpdate[] }
  /** Background (initial) meshing progress. */
  | { type: 'progress'; gen: number; done: number; total: number };
