import * as THREE from 'three';

import { ownerWindow } from '../../../shared/detached-window/detached-window';

export type ProjectionMode = 'max' | 'mean' | 'min' | 'depth';

/** Labels beyond this many are not drawn in the projection (bit-packed). */
export const MAX_PROJECTED_LABELS = 8;

export interface ProjectionLabel {
  color: string;
  visible: boolean;
}

export interface ProjectionStyle {
  mode: ProjectionMode;
  windowLow: number;
  windowHigh: number;
  showLabels: boolean;
  labelOpacity: number;
  /** Position along the segment for `depth` mode (0 = A, 1 = B). */
  depth: number;
}

/**
 * Renders the projection between the two curves on the GPU.
 *
 * The output is `columns × depth` pixels, one per (arc position, slice): the
 * image is reduced (max / mean / min) along the segment joining the two
 * curves' points for that column, within that slice, at about one sample per
 * pixel of segment length. Labels are reduced with OR over a bit-packed label
 * volume (bit `l` = label `l` present), and the lowest visible label found is
 * tinted over the image.
 *
 * The image and the label bits are 2D array textures, one layer per slice,
 * so an edit re-uploads only the slice it touched.
 *
 * WebGL draws into an off-screen canvas and each frame is copied onto the
 * visible 2D canvas. Shown directly, the WebGL canvas was not repainted by
 * WebKitGTK inside the zoomed/panned (CSS-transformed) container until it was
 * resized; a 2D canvas repaints reliably, and the output is small.
 */
export class ProjectionRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  private image: THREE.DataArrayTexture | null = null;
  private labels: THREE.DataArrayTexture | null = null;
  private ends: THREE.DataTexture | null = null;
  private columns = 0;
  private depth = 0;
  private renderPending = false;
  private readonly display: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D context for the projection canvas');
    this.display = context;
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas.ownerDocument.createElement('canvas'),
      antialias: false,
    });
    this.renderer.setPixelRatio(1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uImage: { value: null },
        uLabels: { value: null },
        uEnds: { value: null },
        uSize: { value: new THREE.Vector3(1, 1, 1) },
        uColumns: { value: 1 },
        uMode: { value: 0 },
        uWindow: { value: new THREE.Vector2(0, 255) },
        uHasLabels: { value: false },
        uVisible: { value: 0 },
        uLabelOpacity: { value: 0.5 },
        uDepth: { value: 0.5 },
        uColors: {
          value: Array.from({ length: MAX_PROJECTED_LABELS }, () => new THREE.Color()),
        },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Whether the GPU can hold a volume of this size as array textures. */
  supports(width: number, height: number, depth: number): boolean {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    return width <= maxSize && height <= maxSize && depth <= maxLayers;
  }

  /** The image volume (`w*h*d` luminance) and the bit-packed label volume. */
  setVolume(image: Uint8Array, labelBits: Uint8Array, w: number, h: number, d: number): void {
    this.image?.dispose();
    this.labels?.dispose();

    this.image = new THREE.DataArrayTexture(image, w, h, d);
    this.image.format = THREE.RedFormat;
    this.image.type = THREE.UnsignedByteType;
    this.image.minFilter = THREE.LinearFilter;
    this.image.magFilter = THREE.LinearFilter;
    this.image.unpackAlignment = 1;
    this.image.needsUpdate = true;

    this.labels = new THREE.DataArrayTexture(labelBits, w, h, d);
    this.labels.format = THREE.RedIntegerFormat;
    this.labels.type = THREE.UnsignedByteType;
    this.labels.internalFormat = 'R8UI';
    this.labels.minFilter = THREE.NearestFilter;
    this.labels.magFilter = THREE.NearestFilter;
    this.labels.unpackAlignment = 1;
    this.labels.needsUpdate = true;

    this.depth = d;
    const u = this.material.uniforms;
    u['uImage'].value = this.image;
    u['uLabels'].value = this.labels;
    (u['uSize'].value as THREE.Vector3).set(w, h, d);
    this.resizeOutput();
    this.requestRender();
  }

  clearVolume(): void {
    this.image?.dispose();
    this.labels?.dispose();
    this.image = this.labels = null;
    this.material.uniforms['uImage'].value = null;
    this.material.uniforms['uLabels'].value = null;
    this.depth = 0;
  }

  /** Slice `z` of the label bits changed: re-upload just that layer. */
  updateLabelSlice(z: number): void {
    if (!this.labels) return;
    this.labels.addLayerUpdate(z);
    this.labels.needsUpdate = true;
    this.requestRender();
  }

  /** Segment endpoints per column, `[ax, ay, bx, by]` in image coordinates. */
  setColumns(ends: Float32Array | null, count: number): void {
    this.ends?.dispose();
    this.ends = null;
    this.columns = ends ? count : 0;
    if (ends) {
      this.ends = new THREE.DataTexture(ends, count, 1, THREE.RGBAFormat, THREE.FloatType);
      this.ends.minFilter = THREE.NearestFilter;
      this.ends.magFilter = THREE.NearestFilter;
      this.ends.needsUpdate = true;
    }
    this.material.uniforms['uEnds'].value = this.ends;
    this.material.uniforms['uColumns'].value = Math.max(1, count);
    this.resizeOutput();
    this.requestRender();
  }

  setLabels(labels: ProjectionLabel[]): void {
    let visible = 0;
    labels.slice(0, MAX_PROJECTED_LABELS).forEach((label, i) => {
      // Raw values: this shader writes its output without colour conversion.
      (this.material.uniforms['uColors'].value as THREE.Color[])[i].setStyle(
        label.color,
        THREE.LinearSRGBColorSpace,
      );
      if (label.visible) visible |= 1 << i;
    });
    this.material.uniforms['uVisible'].value = visible;
    this.requestRender();
  }

  setStyle(style: ProjectionStyle): void {
    const u = this.material.uniforms;
    u['uMode'].value = { max: 0, mean: 1, min: 2, depth: 3 }[style.mode];
    u['uDepth'].value = style.depth;
    (u['uWindow'].value as THREE.Vector2).set(
      style.windowLow,
      Math.max(style.windowHigh, style.windowLow + 1),
    );
    u['uHasLabels'].value = style.showLabels;
    u['uLabelOpacity'].value = style.labelOpacity;
    this.requestRender();
  }

  /** Output size in pixels: columns × slices. */
  get outputSize(): { width: number; height: number } {
    return { width: this.columns, height: this.depth };
  }

  requestRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    // The frame clock of the window showing the view (it may be detached).
    ownerWindow(this.canvas).requestAnimationFrame(() => {
      this.renderPending = false;
      if (this.columns > 0 && this.depth > 0 && this.image) {
        this.renderer.render(this.scene, this.camera);
        // Same task as the render: the WebGL buffer is still intact.
        this.display.drawImage(this.renderer.domElement, 0, 0);
      }
    });
  }

  dispose(): void {
    this.clearVolume();
    this.ends?.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }

  private resizeOutput(): void {
    if (this.columns > 0 && this.depth > 0) {
      this.renderer.setSize(this.columns, this.depth, false);
      this.canvas.width = this.columns;
      this.canvas.height = this.depth;
    }
  }
}

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Image coordinates follow the editor: pixel (i, j) covers [i, i+1) × [j, j+1),
 * so a point p samples the texture at p / size and its label texel is
 * floor(p). Row 0 of the output is slice 0.
 */
const FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp int;
  precision highp sampler2DArray;
  precision highp usampler2DArray;

  uniform sampler2DArray uImage;
  uniform usampler2DArray uLabels;
  uniform sampler2D uEnds;
  uniform vec3 uSize;
  uniform int uColumns;
  uniform int uMode;
  uniform vec2 uWindow;
  uniform bool uHasLabels;
  uniform int uVisible;
  uniform float uLabelOpacity;
  uniform float uDepth;
  uniform vec3 uColors[${MAX_PROJECTED_LABELS}];
  varying vec2 vUv;

  void main() {
    int col = min(int(vUv.x * float(uColumns)), uColumns - 1);
    int depth = int(uSize.z);
    int z = min(int((1.0 - vUv.y) * uSize.z), depth - 1);
    vec4 e = texelFetch(uEnds, ivec2(col, 0), 0);
    vec2 a = e.xy;
    vec2 b = e.zw;

    const int MAX_SAMPLES = 2048;
    // Depth mode reads the single point at uDepth: the surface strokes write.
    int n = uMode == 3 ? 1 : int(clamp(ceil(length(b - a)) + 1.0, 1.0, float(MAX_SAMPLES)));
    float acc = uMode == 2 ? 1.0 : 0.0;
    float count = 0.0;
    int bits = 0;
    for (int i = 0; i < MAX_SAMPLES; i++) {
      if (i >= n) break;
      float t = uMode == 3 ? uDepth : n > 1 ? float(i) / float(n - 1) : 0.5;
      vec2 p = mix(a, b, t);
      if (p.x < 0.0 || p.y < 0.0 || p.x >= uSize.x || p.y >= uSize.y) continue;
      float v = texture(uImage, vec3(p / uSize.xy, float(z))).r;
      if (uMode == 0 || uMode == 3) acc = max(acc, v);
      else if (uMode == 1) acc += v;
      else acc = min(acc, v);
      count += 1.0;
      if (uHasLabels) bits |= int(texelFetch(uLabels, ivec3(ivec2(floor(p)), z), 0).r);
    }

    if (count == 0.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    if (uMode == 1) acc /= count;
    float g = clamp((acc * 255.0 - uWindow.x) / (uWindow.y - uWindow.x), 0.0, 1.0);
    vec3 color = vec3(g);

    bits &= uVisible;
    if (bits != 0) {
      for (int l = 0; l < ${MAX_PROJECTED_LABELS}; l++) {
        if ((bits & (1 << l)) != 0) {
          color = mix(color, uColors[l], uLabelOpacity);
          break;
        }
      }
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;
