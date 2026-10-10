import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { api, KeypointPair, PingReply, PythonFunction } from '../lib/api';
import { CorrespondencePair } from '../features/registration/registration.model';

export type InferenceStatus =
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | {
      kind: 'connected';
      /** Keypoint function names. */
      registered: string[];
      functions: PythonFunction[];
      protocolVersion: number;
    }
  | { kind: 'error'; message: string };

export interface InferenceEndpoint {
  host: string;
  port: number;
}

const ENDPOINT_KEY = 'didascalie.python.endpoint';
/** Where `didascalie.com.serve()` listens unless told otherwise. */
const DEFAULT_ENDPOINT: InferenceEndpoint = { host: '127.0.0.1', port: 5556 };
const DISCOVERY_INTERVAL_MS = 3000;

function storedEndpoint(): InferenceEndpoint {
  try {
    const parsed = JSON.parse(localStorage.getItem(ENDPOINT_KEY) ?? 'null');
    if (typeof parsed?.host === 'string' && typeof parsed?.port === 'number') {
      return { host: parsed.host, port: parsed.port };
    }
  } catch {
  }
  return DEFAULT_ENDPOINT;
}

/**
 * The bridge to the user's Python process (`didascalie.com`): where it is and
 * which functions it serves. Besides the explicit {@link connect}, a view can
 * turn on discovery, which pings the endpoint every few seconds.
 */
@Injectable({ providedIn: 'root' })
export class InferenceClientService {
  private readonly zone = inject(NgZone);

  private readonly _status = signal<InferenceStatus>({ kind: 'disconnected' });
  readonly status = this._status.asReadonly();

  /** Last endpoint that was asked for; remembered across sessions. */
  readonly endpoint = signal<InferenceEndpoint>(storedEndpoint());

  readonly functions = computed(() => {
    const s = this._status();
    return s.kind === 'connected' ? s.functions : [];
  });

  readonly segFunctions = computed(() =>
    this.functions().filter((f) => f.kind === 'seg'),
  );

  readonly sequenceSegFunctions = computed(() =>
    this.functions().filter((f) => f.kind === 'sequence_seg'),
  );

  /** Keypoint function names. */
  readonly registered = computed(() => {
    const s = this._status();
    return s.kind === 'connected' ? s.registered : [];
  });

  /** Connected, with at least one keypoint function to call. */
  readonly isReady = computed(() => this.registered().length > 0);

  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryUsers = 0;
  /** Calls in flight. The Python server answers one request at a time, so a
   *  discovery ping sent meanwhile would time out. */
  private inFlight = 0;

  async connect(host: string, port: number): Promise<void> {
    this._status.set({ kind: 'connecting' });
    this.endpoint.set({ host, port });
    localStorage.setItem(ENDPOINT_KEY, JSON.stringify({ host, port }));

    try {
      this.adopt(await this.track(() => api.inferenceConnect(host, port)));
    } catch (e) {
      this._status.set({ kind: 'error', message: String(e) });
      throw e;
    }
  }

  /** Run a call to the Python server, holding discovery off until it settles.
   *  Every request goes through here. */
  async track<T>(call: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await call();
    } finally {
      this.inFlight--;
    }
  }

  /** Start polling the endpoint. Balanced by {@link stopDiscovery}. */
  startDiscovery(): void {
    if (this.discoveryUsers++ > 0) return;
    // Outside the zone: the tick must not run change detection.
    this.zone.runOutsideAngular(() => {
      void this.discover();
      this.discoveryTimer = setInterval(
        () => void this.discover(),
        DISCOVERY_INTERVAL_MS,
      );
    });
  }

  stopDiscovery(): void {
    if (--this.discoveryUsers > 0) return;
    this.discoveryUsers = 0;
    if (this.discoveryTimer !== null) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
  }

  private async discover(): Promise<void> {
    if (this.inFlight > 0 || this._status().kind === 'connecting') return;
    const { host, port } = this.endpoint();
    this.inFlight++;
    try {
      const reply = await api.inferenceConnect(host, port, true);
      this.zone.run(() => this.adopt(reply));
    } catch {
      // Nobody listening is the normal case. An explicit connect's error is kept
      // for its dialog.
      if (this._status().kind === 'connected') {
        this.zone.run(() => this._status.set({ kind: 'disconnected' }));
      }
    } finally {
      this.inFlight--;
    }
  }

  /** Take a ping reply as the current state, unless it says nothing new. */
  private adopt(reply: PingReply): void {
    const next: InferenceStatus = {
      kind: 'connected',
      registered: reply.registered,
      functions: reply.functions,
      protocolVersion: reply.protocol_version,
    };
    // The signal is replaced only when the list changed.
    if (JSON.stringify(next) !== JSON.stringify(this._status())) {
      this._status.set(next);
    }
  }

  async findKeypoints(
    functionName: string,
    refFrameId: number,
    movFrameId: number,
    existing: KeypointPair[] | CorrespondencePair[],
  ): Promise<KeypointPair[]> {
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

    const wire = await this.track(() =>
      api.findKeypointsPrefill(
        functionName, refFrameId, movFrameId, convertedExisting,
      ),
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
