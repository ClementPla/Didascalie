import { Injectable } from '@angular/core';
import { OutlineStyle, diagonalReach } from './outline-raster';

/**
 * GPU compositor of the label masks. Each mask is a layer of an `r8uint`
 * texture array, with a 256-entry palette per layer. The shader writes the
 * colour of the top-most nonzero layer, like the CPU path. In outline mode
 * each layer's contour band and interior get their own opacity and are
 * blended over the layers below (see `outline-raster.ts`, which it matches).
 */
@Injectable({ providedIn: 'root' })
export class WebGPUCanvasCompositorService {
  private device: GPUDevice | null = null;

  private compositePipeline: GPUComputePipeline | null = null;
  private initialized = false;

  private outputTexture: GPUTexture | null = null;
  private maskTextureArray: GPUTexture | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private stagingBuffer: GPUBuffer | null = null;
  private visibilityBuffer: GPUBuffer | null = null;
  private paletteBuffer: GPUBuffer | null = null;

  private isProcessing = false;

  private cachedWidth = 0;
  private cachedHeight = 0;
  private cachedLayerCount = 0;

  // ── Init / teardown ──────────────────────────────────────────────────────

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (!navigator.gpu) return false;

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      this.device = await adapter.requestDevice();

      await this.createCompositePipeline();

      // WebGPU is used only if it gives the exact expected output: a driver or
      // shader mismatch renders wrong masks without raising anything.
      if (!(await this.selfTest())) {
        console.warn('WebGPU self-test failed; using CPU compositor.');
        return false;
      }

      this.initialized = true;
      return true;
    } catch (error) {
      console.error('WebGPU initialization failed:', error);
      return false;
    }
  }

  /**
   * Composite a tiny known pattern and compare exactly: palette mapping,
   * top-most layer wins, transparency. Then edge mode on stacked layers: the
   * lower layer's outline must show through the upper one's interior.
   */
  private async selfTest(): Promise<boolean> {
    try {
      await this.prepareResources(2, 2, 2);

      const mask0 = new Uint8Array([1, 1, 0, 0]);
      const mask1 = new Uint8Array([0, 2, 0, 2]);
      const pal0 = new Uint8Array(256 * 4); // value 1 -> red
      pal0[1 * 4] = 255;
      pal0[1 * 4 + 3] = 255;
      const pal1 = new Uint8Array(256 * 4); // value 2 -> blue
      pal1[2 * 4 + 2] = 255;
      pal1[2 * 4 + 3] = 255;

      const out = await this.compositeMasks(
        [mask0, mask1],
        [pal0, pal1],
        [true, true],
        2,
        2
      );

      const px = (i: number) => [
        out.data[i * 4],
        out.data[i * 4 + 1],
        out.data[i * 4 + 2],
        out.data[i * 4 + 3],
      ];
      const eq = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);

      const compositeOk =
        eq(px(0), [255, 0, 0, 255]) && // layer 0 only -> red
        eq(px(1), [0, 0, 255, 255]) && // both set -> top layer (blue) wins
        eq(px(2), [0, 0, 0, 0]) && //     neither -> transparent
        eq(px(3), [0, 0, 255, 255]); //   layer 1 only -> blue
      if (!compositeOk) return false;

      // Edge mode, 5x5: a red 3x3 square (layer 0) under a blue layer covering
      // the whole image (layer 1).
      const n = 5;
      await this.prepareResources(n, n, 2);
      const square = new Uint8Array(n * n);
      for (let y = 1; y <= 3; y++) {
        for (let x = 1; x <= 3; x++) square[y * n + x] = 1;
      }
      const full = new Uint8Array(n * n).fill(2);

      const edges = await this.compositeMasks(
        [square, full],
        [pal0, pal1],
        [true, true],
        n,
        n,
        { fillAlpha: 0, contourAlpha: 1, radius: 1 }
      );
      const epx = (x: number, y: number) => {
        const i = (y * n + x) * 4;
        return [edges.data[i], edges.data[i + 1], edges.data[i + 2], edges.data[i + 3]];
      };

      return (
        eq(epx(0, 0), [0, 0, 255, 255]) && // image border -> top layer outline
        eq(epx(1, 1), [255, 0, 0, 255]) && // lower layer outline shows through
        eq(epx(3, 2), [255, 0, 0, 255]) &&
        eq(epx(2, 2), [0, 0, 0, 0]) //        interior of both -> transparent
      );
    } catch (error) {
      console.error('WebGPU self-test error:', error);
      return false;
    }
  }

  destroy(): void {
    this.outputTexture?.destroy();
    this.maskTextureArray?.destroy();
    this.stagingBuffer?.destroy();
    this.visibilityBuffer?.destroy();
    this.paletteBuffer?.destroy();
    this.uniformBuffer?.destroy();

    this.outputTexture = null;
    this.maskTextureArray = null;
    this.stagingBuffer = null;
    this.visibilityBuffer = null;
    this.paletteBuffer = null;
    this.uniformBuffer = null;

    this.cachedWidth = 0;
    this.cachedHeight = 0;
    this.cachedLayerCount = 0;
  }

  public get isInitialized(): boolean {
    return this.initialized;
  }

  // ── Resource preparation ─────────────────────────────────────────────────

  async prepareResources(width: number, height: number, layerCount: number): Promise<void> {
    if (!this.device) return;

    const cacheHit =
      this.cachedWidth === width &&
      this.cachedHeight === height &&
      this.cachedLayerCount === layerCount &&
      this.outputTexture &&
      this.stagingBuffer &&
      this.visibilityBuffer &&
      this.paletteBuffer &&
      this.maskTextureArray;

    if (cacheHit) return;

    await this.waitForCompletion();

    this.outputTexture?.destroy();
    this.maskTextureArray?.destroy();
    this.stagingBuffer?.destroy();
    this.visibilityBuffer?.destroy();
    this.paletteBuffer?.destroy();
    this.uniformBuffer?.destroy();

    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const arrayLayers = Math.max(1, layerCount);

    this.outputTexture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    this.maskTextureArray = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: arrayLayers },
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.stagingBuffer = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.visibilityBuffer = this.device.createBuffer({
      size: Math.max(arrayLayers * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // A packed RGBA (u32) per value (256) per layer.
    this.paletteBuffer = this.device.createBuffer({
      size: arrayLayers * 256 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLayerCount = arrayLayers;
  }

  private waitForCompletion(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.isProcessing) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
  }

  // ── Pipeline creation ────────────────────────────────────────────────────

  private async createCompositePipeline(): Promise<void> {
    const shaderCode = `
      struct Uniforms {
        width: u32,
        height: u32,
        layerCount: u32,
        outline: u32,
        radius: u32,
        diagonal: u32,
        fillAlpha: f32,
        contourAlpha: f32,
      }

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      @group(0) @binding(1) var masks: texture_2d_array<u32>;
      @group(0) @binding(2) var outputTexture: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(3) var<storage, read> visibilityFlags: array<u32>;
      @group(0) @binding(4) var<storage, read> palette: array<u32>;

      fn unpack(p: u32) -> vec4<f32> {
        return vec4<f32>(
          f32(p & 0xffu) / 255.0,
          f32((p >> 8u) & 0xffu) / 255.0,
          f32((p >> 16u) & 0xffu) / 255.0,
          f32((p >> 24u) & 0xffu) / 255.0
        );
      }

      // The pixel at c + d*k holds v; outside the image never does.
      fn same(c: vec2<i32>, d: vec2<i32>, k: i32, layer: i32, v: u32) -> bool {
        let p = c + d * k;
        if (p.x < 0 || p.y < 0 || p.x >= i32(uniforms.width) || p.y >= i32(uniforms.height)) {
          return false;
        }
        return textureLoad(masks, p, layer, 0).r == v;
      }

      // Edges are found per layer, before flattening, so a label stacked under
      // another keeps its own outline. Interior: the 8 rays out to the radius
      // (axes) and the diagonal reach hold v. Nearest taps first, so an edge
      // pixel exits early.
      fn interior(c: vec2<i32>, layer: i32, v: u32) -> bool {
        let r = i32(uniforms.radius);
        let s = i32(uniforms.diagonal);
        for (var k = 1; k <= r; k++) {
          if (!same(c, vec2<i32>(1, 0), k, layer, v) || !same(c, vec2<i32>(-1, 0), k, layer, v) ||
              !same(c, vec2<i32>(0, 1), k, layer, v) || !same(c, vec2<i32>(0, -1), k, layer, v)) {
            return false;
          }
          if (k <= s) {
            if (!same(c, vec2<i32>(1, 1), k, layer, v) || !same(c, vec2<i32>(-1, 1), k, layer, v) ||
                !same(c, vec2<i32>(1, -1), k, layer, v) || !same(c, vec2<i32>(-1, -1), k, layer, v)) {
              return false;
            }
          }
        }
        return true;
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let x = global_id.x;
        let y = global_id.y;
        if (x >= uniforms.width || y >= uniforms.height) { return; }
        let c = vec2<i32>(i32(x), i32(y));

        var finalColor = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        for (var i = 0u; i < uniforms.layerCount; i++) {
          if (visibilityFlags[i] == 0u) { continue; }
          let v = textureLoad(masks, c, i32(i), 0).r;
          if (v == 0u) { continue; }
          let color = unpack(palette[i * 256u + v]);
          if (uniforms.outline == 0u) {
            // Later (higher-index) layers paint over earlier ones.
            finalColor = color;
            continue;
          }
          var a = color.a * uniforms.fillAlpha;
          if (uniforms.contourAlpha > 0.0 && !interior(c, i32(i), v)) {
            a = uniforms.contourAlpha;
          }
          if (a <= 0.0) { continue; }
          // Straight-alpha "over".
          let keep = finalColor.a * (1.0 - a);
          let outA = a + keep;
          finalColor = vec4<f32>((color.rgb * a + finalColor.rgb * keep) / outA, outA);
        }
        textureStore(outputTexture, c, finalColor);
      }
    `;

    const module = this.device!.createShaderModule({ code: shaderCode });
    this.compositePipeline = this.device!.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  // ── Composite ────────────────────────────────────────────────────────────

  async compositeMasks(
    masks: Uint8Array[],
    palettes: Uint8Array[],
    visibilityFlags: boolean[],
    width: number,
    height: number,
    outline: OutlineStyle | null = null
  ): Promise<ImageData> {
    if (this.isProcessing) {
      await this.waitForCompletion();
    }

    if (
      !this.device ||
      !this.outputTexture ||
      !this.stagingBuffer ||
      !this.visibilityBuffer ||
      !this.paletteBuffer ||
      !this.maskTextureArray
    ) {
      throw new Error('GPU resources not prepared');
    }

    if (masks.length === 0) {
      return new ImageData(width, height);
    }
    if (masks.length > this.cachedLayerCount) {
      throw new Error(
        `Layer count (${masks.length}) exceeds prepared count (${this.cachedLayerCount}). Call prepareResources first.`
      );
    }

    this.isProcessing = true;

    try {
      for (let i = 0; i < masks.length; i++) {
        this.device.queue.writeTexture(
          { texture: this.maskTextureArray, origin: { x: 0, y: 0, z: i } },
          masks[i],
          { bytesPerRow: width, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 }
        );
      }

      const visibilityData = new Uint32Array(this.cachedLayerCount);
      for (let i = 0; i < masks.length; i++) {
        visibilityData[i] = visibilityFlags[i] ? 1 : 0;
      }
      this.device.queue.writeBuffer(this.visibilityBuffer, 0, visibilityData);

      const paletteData = new Uint32Array(this.cachedLayerCount * 256);
      for (let i = 0; i < masks.length; i++) {
        const pal = palettes[i];
        if (!pal) continue;
        const base = i * 256;
        for (let v = 0; v < 256; v++) {
          const p = v * 4;
          paletteData[base + v] =
            pal[p] | (pal[p + 1] << 8) | (pal[p + 2] << 16) | (pal[p + 3] << 24);
        }
      }
      this.device.queue.writeBuffer(this.paletteBuffer, 0, paletteData);

      const encoder = this.device.createCommandEncoder();

      const uniformData = new ArrayBuffer(32);
      const u32 = new Uint32Array(uniformData);
      const f32 = new Float32Array(uniformData);
      const radius = outline ? Math.max(1, Math.round(outline.radius)) : 0;
      u32[0] = width;
      u32[1] = height;
      u32[2] = masks.length;
      u32[3] = outline ? 1 : 0;
      u32[4] = radius;
      u32[5] = diagonalReach(radius);
      f32[6] = outline ? outline.fillAlpha : 0;
      f32[7] = outline ? outline.contourAlpha : 0;
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData);

      const compositeBindGroup = this.device.createBindGroup({
        layout: this.compositePipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: this.maskTextureArray.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: this.outputTexture.createView() },
          { binding: 3, resource: { buffer: this.visibilityBuffer } },
          { binding: 4, resource: { buffer: this.paletteBuffer } },
        ],
      });

      const compositePass = encoder.beginComputePass();
      compositePass.setPipeline(this.compositePipeline!);
      compositePass.setBindGroup(0, compositeBindGroup);
      compositePass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      compositePass.end();

      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      encoder.copyTextureToBuffer(
        { texture: this.outputTexture },
        { buffer: this.stagingBuffer, bytesPerRow },
        { width, height }
      );

      this.device.queue.submit([encoder.finish()]);
      await this.stagingBuffer.mapAsync(GPUMapMode.READ);

      const mapped = new Uint8ClampedArray(this.stagingBuffer.getMappedRange());
      const result = new ImageData(width, height);
      for (let y = 0; y < height; y++) {
        const srcOffset = y * bytesPerRow;
        const dstOffset = y * width * 4;
        result.data.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
      }
      this.stagingBuffer.unmap();

      return result;
    } finally {
      this.isProcessing = false;
    }
  }
}
