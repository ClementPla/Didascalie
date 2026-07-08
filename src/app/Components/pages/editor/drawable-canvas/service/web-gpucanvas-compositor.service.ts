import { Injectable } from '@angular/core';

/**
 * GPU compositor for the uint8-per-label model. Each label mask is uploaded as
 * a layer of an `r8uint` texture array; a per-layer 256-entry palette buffer
 * maps values to colours. The composite shader writes the top-most nonzero
 * layer's colour per pixel, matching the CPU path.
 */
@Injectable({ providedIn: 'root' })
export class WebGPUCanvasCompositorService {
  private device: GPUDevice | null = null;

  private compositePipeline: GPUComputePipeline | null = null;
  private edgePipeline: GPUComputePipeline | null = null;
  private initialized = false;

  // Persistent resources (sized by prepareResources)
  private outputTexture: GPUTexture | null = null;
  private edgeOutputTexture: GPUTexture | null = null;
  private maskTextureArray: GPUTexture | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private edgeUniformBuffer: GPUBuffer | null = null;
  private stagingBuffer: GPUBuffer | null = null;
  private visibilityBuffer: GPUBuffer | null = null;
  private paletteBuffer: GPUBuffer | null = null;

  private isProcessing = false;

  private cachedWidth = 0;
  private cachedHeight = 0;
  private cachedLayerCount = 0;

  // ==========================================
  // Init / teardown
  // ==========================================

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (!navigator.gpu) return false;

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      this.device = await adapter.requestDevice();

      await this.createCompositePipeline();
      await this.createEdgePipeline();

      // Only advertise WebGPU if it produces provably-correct output — this
      // guards the auto-enabled GPU path against a driver/shader mismatch that
      // would otherwise render wrong masks silently (no exception to catch).
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
   * Composite a tiny known pattern and check the exact result: value→colour
   * mapping via the palette, top-most-layer-wins ordering, and transparency.
   * rgba8unorm stores 0/255 exactly, so the comparison is exact.
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

      return (
        eq(px(0), [255, 0, 0, 255]) && // layer 0 only -> red
        eq(px(1), [0, 0, 255, 255]) && // both set -> top layer (blue) wins
        eq(px(2), [0, 0, 0, 0]) && //     neither -> transparent
        eq(px(3), [0, 0, 255, 255]) //   layer 1 only -> blue
      );
    } catch (error) {
      console.error('WebGPU self-test error:', error);
      return false;
    }
  }

  destroy(): void {
    this.outputTexture?.destroy();
    this.edgeOutputTexture?.destroy();
    this.maskTextureArray?.destroy();
    this.stagingBuffer?.destroy();
    this.visibilityBuffer?.destroy();
    this.paletteBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.edgeUniformBuffer?.destroy();

    this.outputTexture = null;
    this.edgeOutputTexture = null;
    this.maskTextureArray = null;
    this.stagingBuffer = null;
    this.visibilityBuffer = null;
    this.paletteBuffer = null;
    this.uniformBuffer = null;
    this.edgeUniformBuffer = null;

    this.cachedWidth = 0;
    this.cachedHeight = 0;
    this.cachedLayerCount = 0;
  }

  public get isInitialized(): boolean {
    return this.initialized;
  }

  // ==========================================
  // Resource preparation
  // ==========================================

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
    this.edgeOutputTexture?.destroy();
    this.maskTextureArray?.destroy();
    this.stagingBuffer?.destroy();
    this.visibilityBuffer?.destroy();
    this.paletteBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.edgeUniformBuffer?.destroy();

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

    this.edgeOutputTexture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    // One 8-bit unsigned integer per pixel per label.
    this.maskTextureArray = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: arrayLayers },
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.edgeUniformBuffer = this.device.createBuffer({
      size: 16,
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

    // Packed RGBA (u32) per value (256) per layer.
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

  // ==========================================
  // Pipeline creation
  // ==========================================

  private async createCompositePipeline(): Promise<void> {
    const shaderCode = `
      struct Uniforms {
        width: u32,
        height: u32,
        layerCount: u32,
        _pad: u32,
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

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let x = global_id.x;
        let y = global_id.y;
        if (x >= uniforms.width || y >= uniforms.height) { return; }

        var finalColor = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        for (var i = 0u; i < uniforms.layerCount; i++) {
          if (visibilityFlags[i] == 0u) { continue; }
          let v = textureLoad(masks, vec2<i32>(i32(x), i32(y)), i32(i), 0).r;
          if (v == 0u) { continue; }
          // Later (higher-index) layers paint over earlier ones.
          finalColor = unpack(palette[i * 256u + v]);
        }
        textureStore(outputTexture, vec2<i32>(i32(x), i32(y)), finalColor);
      }
    `;

    const module = this.device!.createShaderModule({ code: shaderCode });
    this.compositePipeline = this.device!.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  private async createEdgePipeline(): Promise<void> {
    const shaderCode = `
      struct Uniforms {
        width: u32,
        height: u32,
        threshold: f32,
        edgeWidth: f32,
      }

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      @group(0) @binding(1) var inputTexture: texture_2d<f32>;
      @group(0) @binding(2) var outputTexture: texture_storage_2d<rgba8unorm, write>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let x = i32(global_id.x);
        let y = i32(global_id.y);
        if (u32(x) >= uniforms.width || u32(y) >= uniforms.height) { return; }

        let center = textureLoad(inputTexture, vec2<i32>(x, y), 0);

        // Background never becomes an edge — that's what previously turned the
        // transparent side of a boundary into a black outline.
        if (center.a == 0.0) {
          textureStore(outputTexture, vec2<i32>(x, y), vec4<f32>(0.0));
          return;
        }

        if (x < 1 || y < 1 || u32(x) >= uniforms.width - 1u || u32(y) >= uniforms.height - 1u) {
          textureStore(outputTexture, vec2<i32>(x, y), vec4<f32>(center.rgb, 1.0));
          return;
        }

        // A pixel is an edge when a 4-neighbour has a different colour — this
        // catches label↔label / instance boundaries, not just label↔background.
        let l = textureLoad(inputTexture, vec2<i32>(x - 1, y), 0);
        let r = textureLoad(inputTexture, vec2<i32>(x + 1, y), 0);
        let u = textureLoad(inputTexture, vec2<i32>(x, y - 1), 0);
        let d = textureLoad(inputTexture, vec2<i32>(x, y + 1), 0);
        let isEdge = any(center != l) || any(center != r) || any(center != u) || any(center != d);

        if (isEdge) {
          textureStore(outputTexture, vec2<i32>(x, y), vec4<f32>(center.rgb, 1.0));
        } else {
          textureStore(outputTexture, vec2<i32>(x, y), vec4<f32>(0.0));
        }
      }
    `;

    const module = this.device!.createShaderModule({ code: shaderCode });
    this.edgePipeline = this.device!.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  // ==========================================
  // Composite
  // ==========================================

  async compositeMasks(
    masks: Uint8Array[],
    palettes: Uint8Array[],
    visibilityFlags: boolean[],
    width: number,
    height: number,
    edgesOnly = false,
    edgeThreshold = 0.1
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
      !this.edgeOutputTexture ||
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
      // Upload each mask into its array slice (1 byte/pixel).
      for (let i = 0; i < masks.length; i++) {
        this.device.queue.writeTexture(
          { texture: this.maskTextureArray, origin: { x: 0, y: 0, z: i } },
          masks[i],
          { bytesPerRow: width, rowsPerImage: height },
          { width, height, depthOrArrayLayers: 1 }
        );
      }

      // Visibility flags, zero-padded to the prepared layer count.
      const visibilityData = new Uint32Array(this.cachedLayerCount);
      for (let i = 0; i < masks.length; i++) {
        visibilityData[i] = visibilityFlags[i] ? 1 : 0;
      }
      this.device.queue.writeBuffer(this.visibilityBuffer, 0, visibilityData);

      // Palettes packed as u32 RGBA per (layer, value).
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

      // Pass 1: composite
      const compositeUniforms = new Uint32Array([width, height, masks.length, 0]);
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, compositeUniforms);

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

      let finalTexture: GPUTexture = this.outputTexture;

      // Pass 2: edge detection
      if (edgesOnly) {
        const edgeUniforms = new ArrayBuffer(16);
        new Uint32Array(edgeUniforms, 0, 2).set([width, height]);
        new Float32Array(edgeUniforms, 8, 2).set([edgeThreshold, 1.0]);
        this.device.queue.writeBuffer(this.edgeUniformBuffer!, 0, edgeUniforms);

        const edgeBindGroup = this.device.createBindGroup({
          layout: this.edgePipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.edgeUniformBuffer! } },
            { binding: 1, resource: this.outputTexture.createView() },
            { binding: 2, resource: this.edgeOutputTexture.createView() },
          ],
        });

        const edgePass = encoder.beginComputePass();
        edgePass.setPipeline(this.edgePipeline!);
        edgePass.setBindGroup(0, edgeBindGroup);
        edgePass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        edgePass.end();

        finalTexture = this.edgeOutputTexture;
      }

      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      encoder.copyTextureToBuffer(
        { texture: finalTexture },
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
