import {
  Component,
  ElementRef,
  EventEmitter,
  HostBinding,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  Output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * Folder drop zone: combines HTML drag events (for visual hover state) with
 * Tauri's native drop event (for actual filesystem paths). HTML drops are
 * sandboxed in webviews and give us no path, so we use them only for the UI
 * and let Tauri provide the real data.
 *
 * The component owns the Tauri listener while mounted and cleans up on
 * destroy. Only one of these should be live at a time per window (the listener
 * is global), so we mount this component once on the page that needs it.
 */
@Component({
  selector: 'app-folder-drop-zone',
  standalone: true,
  imports: [CommonModule, ButtonModule],
  templateUrl: './folder-drop-zone.component.html',
  styleUrl: './folder-drop-zone.component.scss',
})
export class FolderDropZoneComponent implements OnInit, OnDestroy {
  /** Currently selected folder path, or null. Drives the resting visual. */
  @Input() folderPath: string | null = null;

  /** Compact mode: smaller drop zone, used when a folder is already chosen. */
  @Input() compact = false;

  @Output() folderChange = new EventEmitter<string>();

  readonly hovering = signal(false);

  private unlistenDrop?: UnlistenFn;
  constructor(private elementRef: ElementRef<HTMLElement>) {}
  async ngOnInit(): Promise<void> {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const webview = getCurrentWebview();
      this.unlistenDrop = await webview.onDragDropEvent((event) => {
        if (event.payload.type === 'over') {
          this.hovering.set(this.pointInside(event.payload.position));
          return;
        }
        if (event.payload.type === 'leave') {
          this.hovering.set(false);
          return;
        }
        if (event.payload.type === 'drop') {
          const inside = this.pointInside(event.payload.position);
          this.hovering.set(false);
          if (!inside) return;
          this.handleDroppedPaths(event.payload.paths ?? []);
        }
      });
    } catch (e) {
      console.error('[drop-zone] failed to attach tauri listener:', e);
    }
  }

  private pointInside(p: { x: number; y: number }): boolean {
    const el =
      ((this as any).hostElement as HTMLElement | undefined) ??
      this.elementRef?.nativeElement;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = p.x / dpr;
    const y = p.y / dpr;
    return (
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    );
  }

  ngOnDestroy(): void {
    this.unlistenDrop?.();
  }

  // ==========================================
  // HTML drag for hover visuals only
  // ==========================================

  @HostListener('dragenter', ['$event'])
  @HostListener('dragover', ['$event'])
  onDragEnter(event: DragEvent): void {
    event.preventDefault();
    this.hovering.set(true);
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    // Browsers fire dragleave when crossing child element boundaries;
    // re-check whether the cursor actually left our box.
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (
      event.clientX <= rect.left ||
      event.clientX >= rect.right ||
      event.clientY <= rect.top ||
      event.clientY >= rect.bottom
    ) {
      this.hovering.set(false);
    }
  }

  // We don't handle 'drop' here — Tauri swallows it and dispatches its own.

  @HostBinding('class.is-hovering')
  get hoveringClass(): boolean {
    return this.hovering();
  }

  @HostBinding('class.is-compact')
  get compactClass(): boolean {
    return this.compact;
  }

  @HostBinding('class.has-folder')
  get hasFolderClass(): boolean {
    return !!this.folderPath;
  }

  // ==========================================
  // Browse fallback
  // ==========================================

  async browse(): Promise<void> {
    const folder = await open({ directory: true });
    if (folder) this.folderChange.emit(folder as string);
  }

  clear(): void {
    this.folderChange.emit('');
  }

  private handleDroppedPaths(paths: string[]): void {
    if (paths.length === 0) return;
    const path = paths[0]; // first one wins; we already decided single-folder.
    this.folderChange.emit(path);
  }
}
