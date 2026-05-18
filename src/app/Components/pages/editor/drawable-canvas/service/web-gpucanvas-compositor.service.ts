import { Injectable } from '@angular/core';
import { from_hex_to_rgb } from '../../../../../Core/misc/colors';

@Injectable({ providedIn: 'root' })
export class WebGPUCanvasCompositorService {
  private device: GPUDevice | null = null;

  // Pipelines
  private compositePipeline: GPUComputePipeline | null = null;
  private edgePipeline: GPUComputePipeline | null = null;
  private binarizePipeline: GPUComputePipeline | null = null;
  private initialized = false;

  // Persistent resources (sized by prepareResources)
  private outputTexture: GPUTexture | null = null;
  private edgeOutputTexture: GPUTexture | null = null;
  private inputTextureArray: GPUTexture | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private edgeUniformBuffer: GPUBuffer | null = null;
  private stagingBuffer: GPUBuffer | null = null;
  private visibilityBuffer: GPUBuffer | null = null;

  // Concurrency
  private isProcessing = false;

  // Cached dimensions
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
      await this.createBinarizePipeline();

      this.initialized = true;
      return true;
    } catch (error) {
      console.error('WebGPU initialization failed:', error);
      return false;
    }
  }

  destroy(): void {
    this.outputTexture?.destroy();
    this.edgeOutputTexture?.destroy();
    this.inputTextureArray?.destroy();
    this.stagingBuffer?.destroy();
    this.visibilityBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.edgeUniformBuffer?.destroy();

    this.outputTexture = null;
    this.edgeOutputTexture = null;
    this.inputTextureArray = null;
    this.stagingBuffer = null;
    this.visibilityBuffer = null;
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
      this.inputTextureArray;

    if (cacheHit) return;

    await this.waitForCompletion();

    // Destroy old resources
    this.outputTexture?.destroy();
    this.edgeOutputTexture?.destroy();
    this.inputTextureArray?.destroy();
    this.stagingBuffer?.destroy();
    this.visibilityBuffer?.destroy();
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

    this.inputTextureArray = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: arrayLayers },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
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
      size: Math.max(layerCount * 4, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLayerCount = layerCount;
  }

  private waitForCompletion(): Promise<void> {
    return new Promise(resolve => {
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
      @group(0) @binding(1) var inputTextures: texture_2d_array<f32>;
      @group(0) @binding(2) var outputTexture: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(3) var<storage, read> visibilityFlags: array<u32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let x = global_id.x;
        let y = global_id.y;
        if (x >= uniforms.width || y >= uniforms.height) { return; }

        var finalColor = vec4<f32>(0.0, 0.0, 0.0, 0.0);

        for (var i = 0u; i < uniforms.layerCount; i++) {
          if (visibilityFlags[i] == 0u) { continue; }

          let layerColor = textureLoad(inputTextures, vec2<i32>(i32(x), i32(y)), i32(i), 0);

          let srcAlpha = layerColor.a;
          let dstAlpha = finalColor.a;
          let outAlpha = srcAlpha + dstAlpha * (1.0 - srcAlpha);

          if (outAlpha > 0.0) {
            finalColor = vec4<f32>(
              (layerColor.rgb * srcAlpha + finalColor.rgb * dstAlpha * (1.0 - srcAlpha)) / outAlpha,
              outAlpha
            );
          }
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

      fn sobel_edge(x: i32, y: i32) -> f32 {
        let tl = textureLoad(inputTexture, vec2<i32>(x - 1, y - 1), 0).a;
        let tc = textureLoad(inputTexture, vec2<i32>(x,     y - 1), 0).a;
        let tr = textureLoad(inputTexture, vec2<i32>(x + 1, y - 1), 0).a;
        let ml = textureLoad(inputTexture, vec2<i32>(x - 1, y    ), 0).a;
        let mr = textureLoad(inputTexture, vec2<i32>(x + 1, y    ), 0).a;
        let bl = textureLoad(inputTexture, vec2<i32>(x - 1, y + 1), 0).a;
        let bc = textureLoad(inputTexture, vec2<i32>(x,     y + 1), 0).a;
        let br = textureLoad(inputTexture, vec2<i32>(x + 1, y + 1), 0).a;

        let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
        let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
        return sqrt(gx * gx + gy * gy);
      }

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let x = i32(global_id.x);
        let y = i32(global_id.y);

        if (u32(x) >= uniforms.width || u32(y) >= uniforms.height) { return; }

        if (x < 1 || y < 1 || u32(x) >= uniforms.width - 1u || u32(y) >= uniforms.height - 1u) {
          textureStore(outputTexture, vec2<i32>(x, y), vec4<f32>(0.0));
          return;
        }

        let center = textureLoad(inputTexture, vec2<i32>(x, y), 0);
        let edge = sobel_edge(x, y);

        if (edge > uniforms.threshold) {
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

  private async createBinarizePipeline(): Promise<void> {
    const shaderCode = `
      struct Uniforms {
        width: u32,
        height: u32,
        r: f32,
        g: f32,
        b: f32,
        _pad: f32,
      }

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;
      @group(0) @binding(1) var inputTexture: texture_2d<f32>;
      @group(0) @binding(2) var outputTexture: texture_storage_2d<rgba8unorm, write>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
        let x = global_id.x;
        let y = global_id.y;
        if (x >= uniforms.width || y >= uniforms.height) { return; }

        let pixel = textureLoad(inputTexture, vec2<i32>(i32(x), i32(y)), 0);
        if (pixel.a > 0.0) {
          textureStore(outputTexture, vec2<i32>(i32(x), i32(y)),
            vec4<f32>(uniforms.r, uniforms.g, uniforms.b, pixel.a));
        } else {
          textureStore(outputTexture, vec2<i32>(i32(x), i32(y)), vec4<f32>(0.0));
        }
      }
    `;

    const module = this.device!.createShaderModule({ code: shaderCode });
    this.binarizePipeline = this.device!.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  // ==========================================
  // Composite (with optional edge detection)
  // ==========================================

  async compositeCanvases(
    canvases: OffscreenCanvas[],
    visibilityFlags: boolean[],
    width: number,
    height: number,
    edgesOnly: boolean = false,
    edgeThreshold: number = 0.1
  ): Promise<ImageData> {
    if (this.isProcessing) {
      await this.waitForCompletion();
    }

    if (
      !this.device ||
      !this.outputTexture ||
      !this.stagingBuffer ||
      !this.visibilityBuffer ||
      !this.edgeOutputTexture ||
      !this.inputTextureArray
    ) {
      throw new Error('GPU resources not prepared');
    }

    if (canvases.length === 0) {
      return new ImageData(width, height);
    }

    if (canvases.length > this.cachedLayerCount) {
      throw new Error(
        `Layer count (${canvases.length}) exceeds prepared count (${this.cachedLayerCount}). Call prepareResources first.`
      );
    }

    this.isProcessing = true;

    try {
      // Upload each canvas into its slice of the cached array texture
      for (let i = 0; i < canvases.length; i++) {
        this.device.queue.copyExternalImageToTexture(
          { source: canvases[i] },
          { texture: this.inputTextureArray, origin: { x: 0, y: 0, z: i } },
          { width, height }
        );
      }

      // Visibility flags (zero-pad to cachedLayerCount so stale slots aren't read)
      const visibilityData = new Uint32Array(this.cachedLayerCount);
      for (let i = 0; i < canvases.length; i++) {
        visibilityData[i] = visibilityFlags[i] ? 1 : 0;
      }
      this.device.queue.writeBuffer(this.visibilityBuffer, 0, visibilityData);

      const encoder = this.device.createCommandEncoder();

      // Pass 1: composite
      const compositeUniforms = new Uint32Array([width, height, canvases.length, 0]);
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, compositeUniforms);

      const compositeBindGroup = this.device.createBindGroup({
        layout: this.compositePipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: this.inputTextureArray.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: this.outputTexture.createView() },
          { binding: 3, resource: { buffer: this.visibilityBuffer } },
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

      // Copy result to staging
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

  // ==========================================
  // Binarize (recolor non-transparent pixels)
  // ==========================================

  async binarizeCanvas(
    canvas: OffscreenCanvas,
    bbox: { x: number; y: number; width: number; height: number } | null,
    color: string
  ): Promise<ImageData> {
    if (!this.device || !this.binarizePipeline) {
      throw new Error('GPU not initialized');
    }

    const [r, g, b] = from_hex_to_rgb(color);
    const x0 = bbox?.x ?? 0;
    const y0 = bbox?.y ?? 0;
    const width = bbox?.width ?? canvas.width;
    const height = bbox?.height ?? canvas.height;

    const inputTexture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // GPU-side copy, no CPU readback
    this.device.queue.copyExternalImageToTexture(
      { source: canvas, origin: { x: x0, y: y0 } },
      { texture: inputTexture },
      { width, height }
    );

    const outputTexture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    const uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const uniformData = new ArrayBuffer(32);
    new Uint32Array(uniformData, 0, 2).set([width, height]);
    new Float32Array(uniformData, 8, 4).set([r / 255, g / 255, b / 255, 0]);
    this.device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const bindGroup = this.device.createBindGroup({
      layout: this.binarizePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: outputTexture.createView() },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.binarizePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();

    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const stagingBuffer = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    encoder.copyTextureToBuffer(
      { texture: outputTexture },
      { buffer: stagingBuffer, bytesPerRow },
      { width, height }
    );

    this.device.queue.submit([encoder.finish()]);
    await stagingBuffer.mapAsync(GPUMapMode.READ);

    const mapped = new Uint8ClampedArray(stagingBuffer.getMappedRange());
    const result = new ImageData(width, height);
    for (let y = 0; y < height; y++) {
      const srcOffset = y * bytesPerRow;
      const dstOffset = y * width * 4;
      result.data.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
    }
    stagingBuffer.unmap();

    inputTexture.destroy();
    outputTexture.destroy();
    stagingBuffer.destroy();
    uniformBuffer.destroy();

    return result;
  }
}