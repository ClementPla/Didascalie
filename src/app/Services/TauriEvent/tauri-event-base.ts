// tauri-event-base.ts
import { OnDestroy, NgZone, Injectable } from '@angular/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

/**
 * Base class for services that handle Tauri events.
 * Provides common functionality for event registration, cleanup, and acknowledgment.
 */
@Injectable()
export abstract class TauriEventBase implements OnDestroy {
  protected unlistenFunctions: UnlistenFn[] = [];
  
  constructor(protected ngZone: NgZone) {}

  /**
   * Register a simple event listener that runs handler in NgZone
   */
  protected async registerListener<T>(
    eventName: string,
    handler: (payload: T) => void | Promise<void>
  ): Promise<void> {
    const unlisten = await listen<T>(eventName, async (event) => {
      await this.ngZone.run(async () => {
        await handler(event.payload);
      });
    });
    this.unlistenFunctions.push(unlisten);
  }

  /**
   * Register an event listener that sends acknowledgment back to Rust
   */
  protected async registerListenerWithAck<T>(
    eventName: string,
    handler: (data: T) => void | Promise<void>
  ): Promise<void> {
    interface EventPayload {
      event_id: string;
      data: T;
    }

    const unlisten = await listen<EventPayload>(eventName, async (event) => {
      try {
        await this.ngZone.run(async () => {
          await handler(event.payload.data);
        });
        
        await invoke('event_processed', {
          id: event.payload.event_id,
          success: true,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';
        
        console.error(`Error handling event ${eventName} (${event.payload.event_id}):`, errorMessage);
        
        await invoke('event_processed', {
          id: event.payload.event_id,
          success: false,
          error: errorMessage,
        });
      }
    });
    
    this.unlistenFunctions.push(unlisten);
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  protected cleanup(): void {
    this.unlistenFunctions.forEach(unlisten => unlisten());
    this.unlistenFunctions = [];
  }
}