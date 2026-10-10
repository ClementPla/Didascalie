import { Injectable } from '@angular/core';
import { api, FrameImage } from '../../lib/api';

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

    if (!frameImage?.imageBase64) {
      console.warn('[FrameLoader] Frame has no imageBase64:', frameId);
      return null;
    }

    try {
      return await this.decodeBase64(frameImage.imageBase64);
    } catch (e) {
      console.error('[FrameLoader] Image decode failed for id', frameId, e);
      return null;
    }
  }

  /** Load a frame from its id as a string. Null if it is not an integer. */
  async loadAsImageById(frameIdStr: string): Promise<HTMLImageElement | null> {
    const id = parseInt(frameIdStr, 10);
    if (Number.isNaN(id)) return null;
    return this.loadAsImage(id);
  }

  /** Decode a base64 string, with or without a data-URL prefix, into an image. */
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