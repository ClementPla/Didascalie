// Services/FrameLoader/frame-loader.service.ts

import { Injectable } from '@angular/core';
import { api, FrameImage } from '../../../lib/api';


@Injectable({ providedIn: 'root' })
export class FrameLoaderService {

  async loadAsImage(frameId: number): Promise<HTMLImageElement | null> {
    if (!Number.isFinite(frameId) || frameId < 0) {
      console.error('[FrameLoader] Invalid frame id:', frameId);
      return null;
    }

    let frameImage: FrameImage;
    try {
      frameImage = await api.getFrameImage(frameId);
    } catch (e) {
      console.error('[FrameLoader] api.getFrameImage failed for id', frameId, e);
      return null;
    }

    if (!frameImage?.image_base64) {
      console.warn('[FrameLoader] Frame has no image_base64:', frameId);
      return null;
    }

    try {
      return await this.decodeBase64(frameImage.image_base64);
    } catch (e) {
      console.error('[FrameLoader] Image decode failed for id', frameId, e);
      return null;
    }
  }

  /**
   * Convert a stringified frame id (from a UI select, route param, etc.) and
   * load it. Returns null if the string isn't a valid integer.
   *
   * Provided as a convenience for callers that already keep ids as strings.
   */
  async loadAsImageById(frameIdStr: string): Promise<HTMLImageElement | null> {
    const id = parseInt(frameIdStr, 10);
    if (Number.isNaN(id)) return null;
    return this.loadAsImage(id);
  }

  /**
   * Decode a base64 string (with or without data-URL prefix) into an
   * HTMLImageElement. Resolves once the image has its natural dimensions
   * available; rejects if the decode fails.
   */
  private decodeBase64(base64: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = base64.startsWith('data:')
        ? base64
        : `data:image/png;base64,${base64}`;
    });
  }
}