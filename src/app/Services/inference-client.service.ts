// services/inference-client.service.ts
import { Injectable, computed, signal } from '@angular/core';
import { api, KeypointPair } from '../lib/api';
import { CorrespondencePair } from '../Components/pages/registration/registration.model';

export type InferenceStatus =
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'connected'; registered: string[]; protocolVersion: number }
  | { kind: 'error'; message: string };

@Injectable({ providedIn: 'root' })
export class InferenceClientService {
  private readonly _status = signal<InferenceStatus>({ kind: 'disconnected' });
  readonly status = this._status.asReadonly();

  readonly isReady = computed(() => {
    const s = this._status();
    return s.kind === 'connected' && s.registered.length > 0;
  });

  readonly registered = computed(() => {
    const s = this._status();
    return s.kind === 'connected' ? s.registered : [];
  });

  async connect(host: string, port: number): Promise<void> {
    this._status.set({ kind: 'connecting' });
    
    try {
      const reply = await api.inferenceConnect(host, port);
      console.log('[inference] ping reply:', reply);   
      this._status.set({
        kind: 'connected',
        registered: reply.registered,
        protocolVersion: reply.protocol_version,
      });
    } catch (e) {
      this._status.set({ kind: 'error', message: String(e) });
      throw e;
    }
  }

  
  async findKeypoints(
    functionName: string,
    refFrameId: number,
    movFrameId: number,
    existing: KeypointPair[] | CorrespondencePair[],
  ): Promise<KeypointPair[]> {
    // Check the type of existing pairs and convert if necessary to KeypointPair[]
    const convertedExisting = existing.map((p) => {
      if ('refX' in p) {
        return p;
      } else {
        return {
          clientUuid: `converted_${Date.now()}`,
          refX: p.ref.x,
          refY: p.ref.y,
          movingX: p.moving.x,
          movingY: p.moving.y,
          source: 'user',
        } as KeypointPair;
      }
    });

    const wire = await api.findKeypointsPrefill(
      functionName, refFrameId, movFrameId, convertedExisting,
    );
    return wire.map((p, i) => ({
      clientUuid: `prefilled_${Date.now()}_${i}`,
      refX:    p[0][0],
      refY:    p[0][1],
      movingX: p[1][0],
      movingY: p[1][1],
      source:  'prefilled',
    }));
  }
}