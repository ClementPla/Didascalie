// image-adjustment-renderer.ts

import { RGBLUT, packRGBLUT } from './image-processing.model';

/**
 * Applies an RGB LUT to a source canvas, producing an output canvas.
 * Prefers WebGPU; falls back to CPU.
 *
 * The renderer is stateless from the caller's perspective: pass a source
 * and a LUT, get a canvas. Internally it caches GPU resources keyed on
 * (width, height) to avoid per-frame allocation.
 */
export class ImageAdjustmentRenderer {
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private initialized = false;
  private initFailed = false;

  // Cached GPU resources, re-created when image size changes.
  private cachedWidth = 0;
  private cachedHeight = 0;
  private inputTexture: GPUTexture | null = null;
  private outputTexture: GPUTexture | null = null;
  private lutTexture: GPUTexture | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  /** Output canvas (reused). */
  private outputCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private outputCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initFailed) return false;
    if (!('gpu' in navigator)) { this.initFailed = true; return false; }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) { this.initFailed = true; return false; }
      this.device = await adapter.requestDevice();
      await this.createPipeline();
      this.initialized = true;
      return true;
    } catch (e) {
      console.warn('ImageAdjustmentRenderer: WebGPU init failed, using CPU fallback.', e);
      this.initFailed = true;
      return false;
    }
  }

  get hasGPU(): boolean { return this.initialized; }

  destroy(): void {
    this.inputTexture?.destroy();
    this.outputTexture?.destroy();
    this.lutTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.inputTexture = null;
    this.outputTexture = null;
    this.lutTexture = null;
    this.uniformBuffer = null;
    this.cachedWidth = 0;
    this.cachedHeight = 0;
  }

  /**
   * Render `source` through `lut` into a canvas the caller can draw from.
   * Same canvas instance is returned across calls; do not retain past the
   * next call.
   */
  async render(source: HTMLCanvasElement, lut: RGBLUT): Promise<HTMLCanvasElement | OffscreenCanvas> {
    this.ensureOutputCanvas(source.width, source.height);
    if (this.initialized && this.device) {
      return this.renderGPU(source, lut);
    }
    return this.renderCPU(source, lut);
  }

  // ==========================================
  // GPU path
  // ==========================================

  private async createPipeline(): Promise<void> {
    const shader = `
      @group(0) @binding(0) var inputTex:  texture_2d<f32>;
      @group(0) @binding(1) var lutTex:    texture_2d<f32>;
      @group(0) @binding(2) var outputTex: texture_storage_2d<rgba8unorm, write>;
      @group(0) @binding(3) var<uniform>   dims: vec2<u32>;

      @compute @workgroup_size(8, 8)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let x = gid.x;
        let y = gid.y;
        if (x >= dims.x || y >= dims.y) { return; }

        let src = textureLoad(inputTex, vec2<i32>(i32(x), i32(y)), 0);
        // LUT is a 256x1 RGBA texture. Index by channel value (0..1 → 0..255).
        let ri = i32(round(src.r * 255.0));
        let gi = i32(round(src.g * 255.0));
        let bi = i32(round(src.b * 255.0));
        let rOut = textureLoad(lutTex, vec2<i32>(ri, 0), 0).r;
        let gOut = textureLoad(lutTex, vec2<i32>(gi, 0), 0).g;
        let bOut = textureLoad(lutTex, vec2<i32>(bi, 0), 0).b;

        textureStore(outputTex, vec2<i32>(i32(x), i32(y)), vec4<f32>(rOut, gOut, bOut, src.a));
      }
    `;
    const module = this.device!.createShaderModule({ code: shader });
    this.pipeline = this.device!.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  private prepareGPUResources(width: number, height: number): void {
    if (width === this.cachedWidth && height === this.cachedHeight && this.inputTexture) return;

    this.inputTexture?.destroy();
    this.outputTexture?.destroy();
    this.lutTexture?.destroy();
    this.uniformBuffer?.destroy();

    this.inputTexture = this.device!.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
             GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.outputTexture = this.device!.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.lutTexture = this.device!.createTexture({
      size: [256, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.uniformBuffer = this.device!.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device!.queue.writeBuffer(this.uniformBuffer, 0, new Uint32Array([width, height]));

    this.cachedWidth = width;
    this.cachedHeight = height;
  }

  private async renderGPU(source: HTMLCanvasElement, lut: RGBLUT): Promise<OffscreenCanvas | HTMLCanvasElement> {
    const w = source.width, h = source.height;
    this.prepareGPUResources(w, h);

    // Upload source and LUT
    this.device!.queue.copyExternalImageToTexture(
      { source }, { texture: this.inputTexture! }, { width: w, height: h }
    );
    const packed = packRGBLUT(lut);
    this.device!.queue.writeTexture(
      { texture: this.lutTexture! },
      packed,
      { bytesPerRow: 256 * 4 },
      { width: 256, height: 1 }
    );

    const bindGroup = this.device!.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.inputTexture!.createView() },
        { binding: 1, resource: this.lutTexture!.createView() },
        { binding: 2, resource: this.outputTexture!.createView() },
        { binding: 3, resource: { buffer: this.uniformBuffer! } },
      ],
    });

    const encoder = this.device!.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    // Copy GPU result to a staging buffer, read back, paint to the output canvas.
    // We could ImageBitmap-blit, but copyTextureToBuffer + ImageData is simpler
    // and works uniformly on OffscreenCanvas and HTMLCanvasElement.
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    const staging = this.device!.createBuffer({
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      { texture: this.outputTexture! },
      { buffer: staging, bytesPerRow },
      { width: w, height: h }
    );
    this.device!.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8ClampedArray(staging.getMappedRange());
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      const srcOff = y * bytesPerRow;
      const dstOff = y * w * 4;
      out.data.set(mapped.subarray(srcOff, srcOff + w * 4), dstOff);
    }
    staging.unmap();
    staging.destroy();

    this.outputCtx!.putImageData(out, 0, 0);
    return this.outputCanvas!;
  }

  // ==========================================
  // CPU path
  // ==========================================

  private renderCPU(source: HTMLCanvasElement, lut: RGBLUT): HTMLCanvasElement | OffscreenCanvas {
    const w = source.width, h = source.height;
    const srcCtx = source.getContext('2d', { willReadFrequently: true })!;
    const img = srcCtx.getImageData(0, 0, w, h);
    const d = img.data;
    const lr = lut.r, lg = lut.g, lb = lut.b;

    for (let i = 0; i < d.length; i += 4) {
      d[i]     = lr[d[i]];
      d[i + 1] = lg[d[i + 1]];
      d[i + 2] = lb[d[i + 2]];
      // alpha untouched
    }
    this.outputCtx!.putImageData(img, 0, 0);
    return this.outputCanvas!;
  }

  // ==========================================
  // Output canvas
  // ==========================================

  private ensureOutputCanvas(width: number, height: number): void {
    if (this.outputCanvas && this.outputCanvas.width === width && this.outputCanvas.height === height) return;

    // OffscreenCanvas if available, HTMLCanvasElement otherwise.
    if (typeof OffscreenCanvas !== 'undefined') {
      this.outputCanvas = new OffscreenCanvas(width, height);
    } else {
      this.outputCanvas = document.createElement('canvas');
      this.outputCanvas.width = width;
      this.outputCanvas.height = height;
    }
    this.outputCtx = this.outputCanvas.getContext('2d', { alpha: true })! as any;
  }
}