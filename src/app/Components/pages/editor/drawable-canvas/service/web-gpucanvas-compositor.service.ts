import { Injectable } from '@angular/core';
import { from_hex_to_rgb } from '../../../../../Core/misc/colors';


@Injectable({ providedIn: 'root' })
export class WebGPUCanvasCompositorService {
  private device: GPUDevice | null = null;
  private compositePipeline: GPUComputePipeline | null = null;
  private edgePipeline: GPUComputePipeline | null = null;
  private initialized = false;

  // Persistent Resources
  private outputTexture: GPUTexture | null = null;
  private edgeOutputTexture: GPUTexture | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private edgeUniformBuffer: GPUBuffer | null = null;
  private stagingBuffer: GPUBuffer | null = null;
  private visibilityBuffer: GPUBuffer | null = null;

  // Concurrency control
  private isProcessing = false;

  // Cache dimensions
  private cachedWidth = 0;
  private cachedHeight = 0;
  private cachedLayerCount = 0;
  private binarizePipeline: GPUComputePipeline | null = null;

  async prepareResources(width: number, height: number, layerCount: number): Promise<void> {
    if (!this.device) return;

    if (
      this.cachedWidth === width &&
      this.cachedHeight === height &&
      this.cachedLayerCount === layerCount &&
      this.outputTexture &&
      this.stagingBuffer &&
      this.visibilityBuffer
    ) {
      return;
    }

    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

    // Destroy old resources
    this.outputTexture?.destroy();
    this.edgeOutputTexture?.destroy();
    this.stagingBuffer?.destroy();
    this.visibilityBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.edgeUniformBuffer?.destroy();

    // Composite output (also used as edge input)
    this.outputTexture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Edge detection output
    this.edgeOutputTexture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
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

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (!navigator.gpu) return false;

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      this.device = await adapter.requestDevice();

      await this.createCompositePipeline();
      await this.createEdgePipeline();
      this.initialized = true;
      return true;
    } catch (error) {
      console.error('WebGPU initialization failed:', error);
      return false;
    }
  }

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

          // Standard source-over alpha compositing
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

    const shaderModule = this.device!.createShaderModule({ code: shaderCode });
    this.compositePipeline = this.device!.createComputePipeline({
      layout: 'auto',
      compute: { module: shaderModule, entryPoint: 'main' },
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

      // Sobel kernels for edge detection
      fn sobel_edge(x: i32, y: i32) -> f32 {
        // Sobel X kernel
        // -1  0  1
        // -2  0  2
        // -1  0  1
        
        // Sobel Y kernel
        // -1 -2 -1
        //  0  0  0
        //  1  2  1

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

        // Skip border pixels
        if (x < 1 || y < 1 || u32(x) >= uniforms.width - 1u || u32(y) >= uniforms.height - 1u) {
          textureStore(outputTexture, vec2<i32>(x, y), vec4<f32>(0.0, 0.0, 0.0, 0.0));
          return;
        }

        let center = textureLoad(inputTexture, vec2<i32>(x, y), 0);
        let edge = sobel_edge(x, y);

        if (edge > uniforms.threshold) {
          // Edge detected - keep original color with full alpha
          textureStore(outputTexture, vec2<i32>(x, y), vec4<f32>(center.rgb, 1.0));
        } else {
          // Not an edge - make transparent
          textureStore(outputTexture, vec2<i32>(x, y), vec4<f32>(0.0, 0.0, 0.0, 0.0));
        }
      }
    `;

    const shaderModule = this.device!.createShaderModule({ code: shaderCode });
    this.edgePipeline = this.device!.createComputePipeline({
      layout: 'auto',
      compute: { module: shaderModule, entryPoint: 'main' },
    });
  }

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
      !this.edgeOutputTexture
    ) {
      throw new Error('GPU Resources not prepared');
    }

    this.isProcessing = true;

    try {
      // Update visibility buffer
      const visibilityData = new Uint32Array(visibilityFlags.map(v => (v ? 1 : 0)));
      this.device.queue.writeBuffer(this.visibilityBuffer, 0, visibilityData);

      const commandEncoder = this.device.createCommandEncoder();
      const inputTextures = await this.createTextureArray(canvases, width, height);

      // === PASS 1: Composite all layers ===
      const compositeUniformData = new Uint32Array([width, height, canvases.length, 0]);
      this.device.queue.writeBuffer(this.uniformBuffer!, 0, compositeUniformData);

      const compositeBindGroup = this.device.createBindGroup({
        layout: this.compositePipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer! } },
          { binding: 1, resource: inputTextures.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: this.outputTexture.createView() },
          { binding: 3, resource: { buffer: this.visibilityBuffer } },
        ],
      });

      const compositePass = commandEncoder.beginComputePass();
      compositePass.setPipeline(this.compositePipeline!);
      compositePass.setBindGroup(0, compositeBindGroup);
      compositePass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      compositePass.end();

      // Determine which texture to read from
      let finalTexture = this.outputTexture;

      // === PASS 2: Edge detection (if enabled) ===
      if (edgesOnly) {
        // Update edge uniforms
        const edgeUniformData = new ArrayBuffer(16);
        const edgeUniformU32 = new Uint32Array(edgeUniformData);
        const edgeUniformF32 = new Float32Array(edgeUniformData);
        edgeUniformU32[0] = width;
        edgeUniformU32[1] = height;
        edgeUniformF32[2] = edgeThreshold; // threshold
        edgeUniformF32[3] = 1.0; // edge width (reserved for future use)
        this.device.queue.writeBuffer(this.edgeUniformBuffer!, 0, edgeUniformData);

        const edgeBindGroup = this.device.createBindGroup({
          layout: this.edgePipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.edgeUniformBuffer! } },
            { binding: 1, resource: this.outputTexture.createView() },
            { binding: 2, resource: this.edgeOutputTexture.createView() },
          ],
        });

        const edgePass = commandEncoder.beginComputePass();
        edgePass.setPipeline(this.edgePipeline!);
        edgePass.setBindGroup(0, edgeBindGroup);
        edgePass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        edgePass.end();

        finalTexture = this.edgeOutputTexture;
      }

      // === Copy result to staging buffer ===
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      commandEncoder.copyTextureToBuffer(
        { texture: finalTexture },
        { buffer: this.stagingBuffer, bytesPerRow },
        { width, height }
      );

      this.device.queue.submit([commandEncoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();

      // Read back result
      await this.stagingBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8ClampedArray(this.stagingBuffer.getMappedRange());

      const result = new ImageData(width, height);
      for (let y = 0; y < height; y++) {
        const srcOffset = y * bytesPerRow;
        const dstOffset = y * width * 4;
        result.data.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
      }

      this.stagingBuffer.unmap();
      inputTextures.destroy();

      return result;
    } finally {
      this.isProcessing = false;
    }
  }

  private waitForCompletion(): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (!this.isProcessing) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }

  private async createTextureArray(
    canvases: OffscreenCanvas[],
    width: number,
    height: number
  ): Promise<GPUTexture> {
    const texture = this.device!.createTexture({
      size: { width, height, depthOrArrayLayers: canvases.length },
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    for (let i = 0; i < canvases.length; i++) {
      this.device!.queue.copyExternalImageToTexture(
        { source: canvases[i] },
        { texture, origin: { x: 0, y: 0, z: i } },
        { width, height }
      );
    }
    return texture;
  }

  public get isInitialized(): boolean {
    return this.initialized;
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
        // Replace color, keep alpha
        textureStore(outputTexture, vec2<i32>(i32(x), i32(y)), 
          vec4<f32>(uniforms.r, uniforms.g, uniforms.b, pixel.a));
      } else {
        textureStore(outputTexture, vec2<i32>(i32(x), i32(y)), vec4<f32>(0.0));
      }
    }
  `;

  const shaderModule = this.device!.createShaderModule({ code: shaderCode });
  this.binarizePipeline = this.device!.createComputePipeline({
    layout: 'auto',
    compute: { module: shaderModule, entryPoint: 'main' },
  });
}

async binarizeCanvas(
  canvas: OffscreenCanvas,
  bbox: { x: number; y: number; width: number; height: number } | null,
  color: string
): Promise<ImageData> {
  if (!this.device || !this.binarizePipeline) {
    throw new Error('GPU not initialized');
  }

  const [r, g, b] = from_hex_to_rgb(color);
  const width = bbox?.width ?? canvas.width;
  const height = bbox?.height ?? canvas.height;

  // Create input texture from canvas region
  const inputTexture = this.device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  // Copy canvas region to texture
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.getImageData(bbox?.x ?? 0, bbox?.y ?? 0, width, height);
  this.device.queue.writeTexture(
    { texture: inputTexture },
    imgData.data,
    { bytesPerRow: width * 4 },
    { width, height }
  );

  // Output texture
  const outputTexture = this.device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });

  // Uniforms
  const uniformBuffer = this.device.createBuffer({
    size: 32, // 2 u32 + 4 f32 (padded)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  
  const uniformData = new ArrayBuffer(32);
  new Uint32Array(uniformData, 0, 2).set([width, height]);
  new Float32Array(uniformData, 8, 4).set([r / 255, g / 255, b / 255, 0]);
  this.device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  // Bind group
  const bindGroup = this.device.createBindGroup({
    layout: this.binarizePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: inputTexture.createView() },
      { binding: 2, resource: outputTexture.createView() },
    ],
  });

  // Execute
  const commandEncoder = this.device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(this.binarizePipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
  passEncoder.end();

  // Read back
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const stagingBuffer = this.device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  commandEncoder.copyTextureToBuffer(
    { texture: outputTexture },
    { buffer: stagingBuffer, bytesPerRow },
    { width, height }
  );

  this.device.queue.submit([commandEncoder.finish()]);
  await this.device.queue.onSubmittedWorkDone();

  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8ClampedArray(stagingBuffer.getMappedRange());

  const result = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    const srcOffset = y * bytesPerRow;
    const dstOffset = y * width * 4;
    result.data.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
  }

  stagingBuffer.unmap();

  // Cleanup
  inputTexture.destroy();
  outputTexture.destroy();
  stagingBuffer.destroy();
  uniformBuffer.destroy();

  return result;
}
}