import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { ownerWindow } from '../../shared/detached-window/detached-window';
import { MeshKind, MeshUpdate } from './mesher/mesher.protocol';
import { Volume3dSettings } from './volume3d-settings.service';

export interface SceneLabel {
  color: string;
  visible: boolean;
}

/** The 2D editor's brush, mirrored in the 3D view. */
export interface BrushCursor {
  /** Image coordinates on the current slice. */
  x: number;
  y: number;
  /** Radius in image pixels. */
  radius: number;
  color: string;
}

export interface VoxelPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * The three.js side of the 3D view: label meshes, image planes, a ray-marched
 * rendering of the image, and an orbit camera. Framework-free; the component
 * feeds it data and settings.
 *
 * # Spaces
 *
 * Everything lives under `root`, whose local space is voxel space: voxel
 * `(x, y, z)` (column, row, slice) is centred on that integer point. `root`
 * applies the slice spacing (`scale.z`) and centres the volume on the origin,
 * where the camera orbits. The camera's "up" is -y so that, seen from slice 0,
 * the volume reads like the 2D editor (rows going down).
 *
 * Rendering is on demand: nothing runs between changes.
 */
export class VolumeScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  /** Grid space of the meshes: grid voxel `g` covers voxels `[g*lod, (g+1)*lod)`. */
  private readonly meshRoot = new THREE.Group();

  private dims = { w: 1, h: 1, d: 1 };
  private settings: Volume3dSettings | null = null;
  private slice = 0;

  private labels: SceneLabel[] = [];
  private readonly groups: Record<MeshKind, THREE.Group[]> = { surface: [], blocks: [] };
  private readonly materials: Record<MeshKind, THREE.Material[]> = { surface: [], blocks: [] };
  private readonly meshes = new Map<string, THREE.Mesh>();

  private volumeTexture: THREE.Data3DTexture | null = null;
  private readonly planes: THREE.Mesh[] = [];
  private readonly planeMaterial: THREE.ShaderMaterial;
  private readonly volumeBox: THREE.Mesh;
  private readonly volumeMaterial: THREE.ShaderMaterial;
  private readonly bounds: THREE.LineSegments;
  private readonly sliceOutline: THREE.LineLoop;
  /** Where the 2D editor's brush is: a ring on the slice, plus a line through
   *  the depth so it stays visible when the slice is edge-on. */
  private readonly brushRing: THREE.Mesh;
  private readonly brushAxis: THREE.Line;

  private renderPending = false;
  private readonly raycaster = new THREE.Raycaster();

  /**
   * Dragging the slice outline changes slices: called with each new slice
   * under the pointer. Set by the view.
   */
  onSliceDrag: ((z: number) => void) | null = null;
  /** The drag in progress: the grabbed point (voxel space) and its slice. */
  private sliceDrag: { pointerId: number; anchor: THREE.Vector3; z: number } | null = null;
  private outlineHovered = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.scene.background = new THREE.Color(0x15161c);

    this.camera.up.set(0, -1, 0);
    this.scene.add(this.camera);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    // A headlight: lighting follows the view, so no side is ever unlit.
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    headlight.position.set(0.3, -0.4, 1);
    this.camera.add(headlight);

    // Registered before the orbit controls, in the capture phase, so a press
    // on the slice outline can claim the pointer before orbiting starts.
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(this.root);
    this.root.add(this.meshRoot);

    this.planeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uVolume: { value: null },
        uDims: { value: new THREE.Vector3(1, 1, 1) },
        uOpacity: { value: 1 },
        uWindow: { value: new THREE.Vector2(0, 255) },
      },
      vertexShader: PLANE_VERTEX,
      fragmentShader: PLANE_FRAGMENT,
      side: THREE.DoubleSide,
      transparent: true,
    });
    for (let i = 0; i < 3; i++) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      const plane = new THREE.Mesh(geometry, this.planeMaterial);
      plane.renderOrder = 1;
      plane.frustumCulled = false;
      this.planes.push(plane);
      this.root.add(plane);
    }

    this.volumeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uVolume: { value: null },
        uDims: { value: new THREE.Vector3(1, 1, 1) },
        uCamPos: { value: new THREE.Vector3() },
        uBoxMatrix: { value: new THREE.Matrix4() },
        uOpacity: { value: 0.5 },
        uWindow: { value: new THREE.Vector2(0, 255) },
        uMode: { value: 0 },
      },
      vertexShader: VOLUME_VERTEX,
      fragmentShader: VOLUME_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.volumeBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.volumeMaterial);
    this.volumeBox.renderOrder = 3;
    this.volumeBox.frustumCulled = false;
    this.root.add(this.volumeBox);

    this.bounds = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x5c6070 }),
    );
    this.root.add(this.bounds);

    const outline = new THREE.BufferGeometry();
    outline.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.sliceOutline = new THREE.LineLoop(
      outline,
      new THREE.LineBasicMaterial({ color: SLICE_COLOR, depthTest: false }),
    );
    this.sliceOutline.renderOrder = 4;
    this.sliceOutline.frustumCulled = false;
    this.root.add(this.sliceOutline);

    // Drawn over everything (depthTest off): it says where the brush is, and
    // being hidden inside a label surface is exactly when that matters.
    this.brushRing = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        depthTest: false,
        transparent: true,
      }),
    );
    this.brushRing.renderOrder = 5;
    this.brushRing.frustumCulled = false;
    this.brushRing.visible = false;
    this.root.add(this.brushRing);

    const axis = new THREE.BufferGeometry();
    axis.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.brushAxis = new THREE.Line(
      axis,
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.35 }),
    );
    this.brushAxis.renderOrder = 5;
    this.brushAxis.frustumCulled = false;
    this.brushAxis.visible = false;
    this.root.add(this.brushAxis);
  }

  // ==========================================
  // Data
  // ==========================================

  /** A new volume: drops all meshes and frames the camera on it. */
  setVolume(w: number, h: number, d: number, lod: number): void {
    this.dims = { w, h, d };
    this.clearMeshes();
    this.meshRoot.scale.setScalar(lod);
    // Grid voxel g is centred on the middle of its lod-wide block.
    this.meshRoot.position.setScalar((lod - 1) / 2);

    const size = new THREE.Vector3(w, h, d);
    this.volumeBox.scale.copy(size);
    this.volumeBox.position.set((w - 1) / 2, (h - 1) / 2, (d - 1) / 2);
    this.bounds.scale.copy(size);
    this.bounds.position.copy(this.volumeBox.position);
    (this.planeMaterial.uniforms['uDims'].value as THREE.Vector3).copy(size);
    (this.volumeMaterial.uniforms['uDims'].value as THREE.Vector3).copy(size);

    this.layout();
    this.resetCamera();
  }

  /** Drop the label meshes, keeping the volume. */
  clearMeshes(): void {
    for (const mesh of this.meshes.values()) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.requestRender();
  }

  /** The image volume (8-bit luminance, `w*h*d`), or null to hide it. */
  setImage(image: Uint8Array | null): void {
    this.volumeTexture?.dispose();
    this.volumeTexture = null;
    if (image) {
      this.volumeTexture = this.createVolumeTexture(image);
    }
    this.planeMaterial.uniforms['uVolume'].value = this.volumeTexture;
    this.volumeMaterial.uniforms['uVolume'].value = this.volumeTexture;
    this.applyVisibility();
    this.requestRender();
  }

  setLabels(labels: SceneLabel[]): void {
    this.labels = labels;
    for (const kind of ['surface', 'blocks'] as MeshKind[]) {
      while (this.groups[kind].length < labels.length) {
        const group = new THREE.Group();
        this.groups[kind].push(group);
        this.meshRoot.add(group);
        this.materials[kind].push(
          kind === 'surface'
            ? new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, side: THREE.DoubleSide })
            : new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }),
        );
      }
    }
    labels.forEach((label, i) => {
      for (const kind of ['surface', 'blocks'] as MeshKind[]) {
        (this.materials[kind][i] as THREE.MeshStandardMaterial).color.set(label.color);
      }
    });
    this.applyVisibility();
    this.requestRender();
  }

  applyMeshUpdates(updates: MeshUpdate[]): void {
    for (const { label, kind, brick, mesh } of updates) {
      const key = `${kind}:${label}:${brick}`;
      const existing = this.meshes.get(key);
      if (existing) {
        existing.removeFromParent();
        existing.geometry.dispose();
        this.meshes.delete(key);
      }
      const group = this.groups[kind][label];
      if (mesh.indices.length === 0 || !group) continue;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      const object = new THREE.Mesh(geometry, this.materials[kind][label]);
      object.renderOrder = kind === 'surface' ? 0 : 2;
      group.add(object);
      this.meshes.set(key, object);
    }
    this.requestRender();
  }

  /** Remove every blocks mesh (the overlay was switched off). */
  clearBlocks(): void {
    for (const [key, mesh] of this.meshes) {
      if (!key.startsWith('blocks:')) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      this.meshes.delete(key);
    }
    this.requestRender();
  }

  setSettings(settings: Volume3dSettings): void {
    this.settings = settings;
    this.root.scale.set(1, 1, settings.zSpacing);

    const surfaceOpaque = settings.surfaceOpacity >= 1;
    for (const m of this.materials.surface) {
      m.opacity = settings.surfaceOpacity;
      m.transparent = !surfaceOpaque;
      m.depthWrite = surfaceOpaque;
    }
    for (const m of this.materials.blocks) {
      m.opacity = settings.blocksOpacity;
      m.transparent = settings.blocksOpacity < 1;
      m.depthWrite = settings.blocksOpacity >= 1;
    }

    const window = new THREE.Vector2(settings.windowLow, Math.max(settings.windowHigh, settings.windowLow + 1));
    this.planeMaterial.uniforms['uOpacity'].value = settings.planesOpacity;
    (this.planeMaterial.uniforms['uWindow'].value as THREE.Vector2).copy(window);
    this.planeMaterial.depthWrite = settings.planesOpacity >= 1;
    this.volumeMaterial.uniforms['uOpacity'].value = settings.volumeOpacity;
    (this.volumeMaterial.uniforms['uWindow'].value as THREE.Vector2).copy(window);
    this.volumeMaterial.uniforms['uMode'].value = settings.volumeMode === 'mip' ? 0 : 1;

    this.layout();
    this.applyVisibility();
    this.requestRender();
  }

  /** Mirror the 2D editor's brush, or null when the cursor is off the image. */
  setBrushCursor(cursor: BrushCursor | null): void {
    this.brushRing.visible = !!cursor;
    this.brushAxis.visible = !!cursor;
    if (cursor) {
      const { x, y, radius, color } = cursor;
      // The ring is drawn in the slice plane, a hair in front of it.
      this.brushRing.position.set(x, y, this.slice + 0.01);
      this.brushRing.scale.setScalar(Math.max(radius, 0.5));
      (this.brushRing.material as THREE.MeshBasicMaterial).color.set(color);
      (this.brushAxis.material as THREE.LineBasicMaterial).color.set(color);
      const line = this.brushAxis.geometry.getAttribute('position') as THREE.BufferAttribute;
      (line.array as Float32Array).set([x, y, -0.5, x, y, this.dims.d - 0.5]);
      line.needsUpdate = true;
    }
    this.requestRender();
  }

  /** The slice being edited in 2D. */
  setSlice(z: number): void {
    this.slice = z;
    this.brushRing.position.setZ(z + 0.01);
    this.layout();
    this.requestRender();
  }

  // ==========================================
  // View
  // ==========================================

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  resetCamera(): void {
    const { w, h, d } = this.dims;
    const size = Math.max(w, h, d * (this.settings?.zSpacing ?? 1));
    this.camera.near = size / 200;
    this.camera.far = size * 20;
    // In front of slice 0, slightly above (-y) and to the right.
    this.camera.position.set(size * 0.7, -size * 0.55, -size * 1.5);
    this.controls.target.set(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /**
   * The voxel under a canvas pixel: on a visible surface or image plane, or
   * null. `x`/`y` are relative to the canvas, in CSS pixels.
   */
  pick(x: number, y: number, width: number, height: number): VoxelPoint | null {
    const ndc = new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    for (const group of this.groups.surface) if (group.visible) targets.push(group);
    for (const plane of this.planes) if (plane.visible) targets.push(plane);
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;
    const p = this.root.worldToLocal(hit.point.clone());
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.round(v)));
    return { x: clamp(p.x, this.dims.w), y: clamp(p.y, this.dims.h), z: clamp(p.z, this.dims.d) };
  }

  requestRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    // The frame clock of the window showing the view (it may be detached).
    ownerWindow(this.renderer.domElement).requestAnimationFrame(() => {
      this.renderPending = false;
      this.render();
    });
  }

  dispose(): void {
    this.clearMeshes();
    this.controls.dispose();
    this.volumeTexture?.dispose();
    for (const list of Object.values(this.materials)) list.forEach((m) => m.dispose());
    this.planeMaterial.dispose();
    this.volumeMaterial.dispose();
    this.planes.forEach((p) => p.geometry.dispose());
    this.volumeBox.geometry.dispose();
    this.bounds.geometry.dispose();
    this.sliceOutline.geometry.dispose();
    this.brushRing.geometry.dispose();
    (this.brushRing.material as THREE.Material).dispose();
    this.brushAxis.geometry.dispose();
    (this.brushAxis.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  // ==========================================
  // Dragging the slice outline
  // ==========================================

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.onSliceDrag || !this.outlineUnder(event)) return;
    // Ours, not the orbit controls' (nor a pick).
    event.stopImmediatePropagation();
    event.preventDefault();
    const anchor = this.voxelUnder(event);
    if (!anchor) return;
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.sliceDrag = { pointerId: event.pointerId, anchor, z: this.slice };
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.sliceDrag;
    if (drag && drag.pointerId === event.pointerId) {
      const z = this.sliceAlongZ(event, drag.anchor);
      if (z !== null && z !== drag.z) {
        drag.z = z;
        this.setSlice(z); // move the outline now; the editor follows
        this.onSliceDrag?.(z);
      }
      return;
    }
    if (event.buttons !== 0) return; // orbiting / panning
    const hovered = !!this.onSliceDrag && this.outlineUnder(event);
    if (hovered !== this.outlineHovered) {
      this.outlineHovered = hovered;
      (this.sliceOutline.material as THREE.LineBasicMaterial).color.set(hovered ? 0xffffff : SLICE_COLOR);
      this.renderer.domElement.style.cursor = hovered ? 'row-resize' : '';
      this.requestRender();
    }
  }

  /** A slice drag is in progress (the outline leads the editor). */
  get draggingSlice(): boolean {
    return this.sliceDrag !== null;
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.sliceDrag?.pointerId === event.pointerId) this.sliceDrag = null;
  }

  private rayAt(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /** The pointer is within a few pixels of the slice outline. */
  private outlineUnder(event: PointerEvent): boolean {
    this.rayAt(event);
    // Tolerance: ~6 screen px, in world units at the volume's distance.
    const rect = this.renderer.domElement.getBoundingClientRect();
    const distance = this.camera.position.length();
    const worldPerPixel =
      (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / Math.max(1, rect.height);
    this.raycaster.params.Line = { threshold: 6 * worldPerPixel };
    this.scene.updateMatrixWorld();
    return this.raycaster.intersectObject(this.sliceOutline).length > 0;
  }

  /** Where the pointer ray crosses the current slice's plane (voxel space). */
  private voxelUnder(event: PointerEvent): THREE.Vector3 | null {
    this.rayAt(event);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.slice).applyMatrix4(this.root.matrixWorld);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return hit ? this.root.worldToLocal(hit) : null;
  }

  /**
   * The slice along the Z line through `anchor` closest to the pointer ray:
   * the grabbed point follows the pointer as well as it can along Z.
   */
  private sliceAlongZ(event: PointerEvent, anchor: THREE.Vector3): number | null {
    this.rayAt(event);
    const toLocal = this.root.matrixWorld.clone().invert();
    const origin = this.raycaster.ray.origin.clone().applyMatrix4(toLocal);
    const through = this.raycaster.ray.origin.clone().add(this.raycaster.ray.direction).applyMatrix4(toLocal);
    const d = through.sub(origin); // ray direction, voxel space
    // Closest points between the ray (origin + s·d) and the line anchor + t·ẑ.
    const w = origin.clone().sub(anchor);
    const a = d.dot(d);
    const b = d.z;
    const denom = a - b * b; // |ẑ|² = 1
    if (Math.abs(denom) < 1e-9) return null; // looking straight down Z
    const t = (a * w.z - b * d.dot(w)) / denom;
    const z = Math.round(anchor.z + t);
    return Math.min(this.dims.d - 1, Math.max(0, z));
  }

  // ==========================================
  // Internals
  // ==========================================

  private render(): void {
    // The ray marcher works in the volume's local space: give it the camera
    // there.
    this.scene.updateMatrixWorld();
    const camLocal = this.root.worldToLocal(this.camera.position.clone());
    (this.volumeMaterial.uniforms['uCamPos'].value as THREE.Vector3).copy(camLocal);
    (this.volumeMaterial.uniforms['uBoxMatrix'].value as THREE.Matrix4).copy(this.volumeBox.matrix);
    this.renderer.render(this.scene, this.camera);
  }

  /** Position the planes and the slice outline, centre the volume. */
  private layout(): void {
    const { w, h, d } = this.dims;
    const zSpacing = this.settings?.zSpacing ?? 1;
    this.root.position.set(-(w - 1) / 2, -(h - 1) / 2, (-(d - 1) / 2) * zSpacing);

    const z = Math.min(Math.max(this.slice, 0), d - 1);
    const x = Math.round((this.settings?.planeX ?? 0.5) * (w - 1));
    const y = Math.round((this.settings?.planeY ?? 0.5) * (h - 1));
    const x0 = -0.5, x1 = w - 0.5, y0 = -0.5, y1 = h - 0.5, z0 = -0.5, z1 = d - 0.5;
    const quads: number[][] = [
      [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], // current slice (axial)
      [x, y0, z0, x, y1, z0, x, y1, z1, x, y0, z1], // sagittal
      [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], // coronal
    ];
    quads.forEach((quad, i) => {
      const attr = this.planes[i].geometry.getAttribute('position') as THREE.BufferAttribute;
      (attr.array as Float32Array).set(quad);
      attr.needsUpdate = true;
    });
    const outline = this.sliceOutline.geometry.getAttribute('position') as THREE.BufferAttribute;
    (outline.array as Float32Array).set(quads[0]);
    outline.needsUpdate = true;
  }

  private applyVisibility(): void {
    const s = this.settings;
    this.labels.forEach((label, i) => {
      if (this.groups.surface[i]) this.groups.surface[i].visible = label.visible && !!s?.showSurface;
      if (this.groups.blocks[i]) this.groups.blocks[i].visible = label.visible && !!s?.showBlocks;
    });
    const hasImage = this.volumeTexture !== null;
    for (const plane of this.planes) plane.visible = hasImage && !!s?.showPlanes;
    this.volumeBox.visible = hasImage && !!s?.showVolume;
  }

  /** Upload the image as an R8 3D texture, downsampled if it exceeds the
   *  GPU's 3D texture limit. */
  private createVolumeTexture(image: Uint8Array): THREE.Data3DTexture {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const max = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    const { w, h, d } = this.dims;
    const f = Math.max(1, Math.ceil(Math.max(w, h, d) / max));
    let data = image;
    let tw = w, th = h, td = d;
    if (f > 1) {
      tw = Math.ceil(w / f);
      th = Math.ceil(h / f);
      td = Math.ceil(d / f);
      data = new Uint8Array(tw * th * td);
      for (let z = 0; z < td; z++) {
        for (let y = 0; y < th; y++) {
          for (let x = 0; x < tw; x++) {
            data[(z * th + y) * tw + x] = image[(z * f * h + y * f) * w + x * f];
          }
        }
      }
    }
    const texture = new THREE.Data3DTexture(data, tw, th, td);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
  }
}

/** The current slice's outline. */
const SLICE_COLOR = 0xf9e2af;

// ==========================================
// Shaders
// ==========================================
// three.js compiles these as GLSL ES 3.0 (`varying`/`gl_FragColor` are mapped),
// so 3D textures are available. Positions are in voxel space; texture
// coordinates are `(p + 0.5) / dims`.

const PLANE_VERTEX = /* glsl */ `
  uniform vec3 uDims;
  varying vec3 vTex;
  void main() {
    vTex = (position + 0.5) / uDims;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLANE_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D uVolume;
  uniform float uOpacity;
  uniform vec2 uWindow;
  varying vec3 vTex;
  void main() {
    float v = texture(uVolume, vTex).r * 255.0;
    float g = clamp((v - uWindow.x) / (uWindow.y - uWindow.x), 0.0, 1.0);
    gl_FragColor = vec4(vec3(g), uOpacity);
  }
`;

const VOLUME_VERTEX = /* glsl */ `
  uniform mat4 uBoxMatrix;
  varying vec3 vPos;
  void main() {
    vPos = (uBoxMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Ray marching through the volume box, drawn on its back faces so every pixel
 * the box covers runs once, camera inside or out. `vPos` and `uCamPos` are in
 * voxel space (`uBoxMatrix` is the box's transform within it). MIP keeps the brightest windowed sample; composite
 * accumulates front to back with opacity proportional to intensity.
 */
const VOLUME_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D uVolume;
  uniform vec3 uDims;
  uniform vec3 uCamPos;
  uniform float uOpacity;
  uniform vec2 uWindow;
  uniform int uMode;
  varying vec3 vPos;

  vec2 hitBox(vec3 origin, vec3 dir, vec3 bmin, vec3 bmax) {
    vec3 inv = 1.0 / dir;
    vec3 t0 = (bmin - origin) * inv;
    vec3 t1 = (bmax - origin) * inv;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
  }

  void main() {
    vec3 dir = normalize(vPos - uCamPos);
    vec2 t = hitBox(uCamPos, dir, vec3(-0.5), uDims - 0.5);
    float t0 = max(t.x, 0.0);
    float t1 = t.y;
    if (t1 <= t0) discard;

    // About one sample per voxel, capped; jittered against banding.
    const int MAX_STEPS = 768;
    float steps = min(ceil(t1 - t0), float(MAX_STEPS));
    float dt = (t1 - t0) / steps;
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

    float peak = 0.0;
    vec4 acc = vec4(0.0);
    for (int i = 0; i < MAX_STEPS; i++) {
      if (float(i) >= steps) break;
      vec3 p = uCamPos + dir * (t0 + (float(i) + jitter) * dt);
      float v = texture(uVolume, (p + 0.5) / uDims).r * 255.0;
      float g = clamp((v - uWindow.x) / (uWindow.y - uWindow.x), 0.0, 1.0);
      if (uMode == 0) {
        peak = max(peak, g);
      } else {
        float a = 1.0 - exp(-g * uOpacity * dt * 0.05);
        acc.rgb += (1.0 - acc.a) * a * vec3(g);
        acc.a += (1.0 - acc.a) * a;
        if (acc.a > 0.98) break;
      }
    }

    if (uMode == 0) {
      gl_FragColor = vec4(vec3(peak), peak * uOpacity);
    } else {
      gl_FragColor = vec4(acc.rgb / max(acc.a, 1e-4), acc.a);
    }
  }
`;
