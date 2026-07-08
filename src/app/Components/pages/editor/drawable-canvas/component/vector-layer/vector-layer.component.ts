import { Component, ElementRef, HostListener, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

import { Rect } from '../../../../../../Core/interface';
import { LabelsService } from '../../../../../../Services/Labels/labels.service';
import { EditorService } from '../../../services/editor.service';
import { VectorEditorService } from '../../service/vector-editor.service';
import { ZoomPanService } from '../../service/zoom-pan.service';
import { Bounds, VectorNode, buildPathData } from '../../vector/vector.model';

interface RenderShape {
  id: string;
  d: string;
  color: string;
  fill: string;
  selected: boolean;
}

interface AnchorDeco {
  x: number;
  y: number;
  selected: boolean;
  first: boolean;
}

interface HandleDeco {
  ax: number;
  ay: number;
  hx: number;
  hy: number;
}


@Component({
  selector: 'app-vector-layer',
  imports: [CommonModule],
  templateUrl: './vector-layer.component.html',
  styleUrl: './vector-layer.component.scss',
})
export class VectorLayerComponent {
  @ViewChild('svg') svg: ElementRef<SVGSVGElement>;

  constructor(
    public vectorEditor: VectorEditorService,
    public labelService: LabelsService,
    public editorService: EditorService,
    private zoomPan: ZoomPanService,
  ) {}

  setViewBox(viewbox: Rect): void {
    if (!this.svg) return;
    const w = Math.max(1, viewbox.width);
    const h = Math.max(1, viewbox.height);
    this.svg.nativeElement.setAttribute(
      'viewBox',
      `${viewbox.x} ${viewbox.y} ${w} ${h}`,
    );
  }

  // ── Keyboard (only while a vector tool is active) ─────────────────────────

  @HostListener('window:keydown.escape', ['$event'])
  onEscape(e: Event): void {
    if (!this.editorService.isVectorTool() || this.isEditableTarget(e)) return;
    this.vectorEditor.cancel();
    e.preventDefault();
  }

  @HostListener('window:keydown.enter', ['$event'])
  onEnter(e: Event): void {
    if (this.isEditableTarget(e)) return;
    if (!this.editorService.isPathTool() || !this.vectorEditor.draft()) return;
    this.vectorEditor.finishDraft();
    e.preventDefault();
  }

  @HostListener('window:keydown.delete', ['$event'])
  @HostListener('window:keydown.backspace', ['$event'])
  onDelete(e: Event): void {
    if (!this.isSelectionContext() || this.isEditableTarget(e)) return;
    this.vectorEditor.deleteSelection();
    e.preventDefault();
  }

  // ── Object-level clipboard (Select/Node tools) ────────────────────────────

  @HostListener('window:keydown.control.c', ['$event'])
  @HostListener('window:keydown.meta.c', ['$event'])
  onCopy(e: Event): void {
    if (!this.isSelectionContext() || this.isEditableTarget(e)) return;
    this.vectorEditor.copySelection();
    e.preventDefault();
  }

  @HostListener('window:keydown.control.v', ['$event'])
  @HostListener('window:keydown.meta.v', ['$event'])
  onPaste(e: Event): void {
    if (!this.isSelectionContext() || this.isEditableTarget(e)) return;
    this.vectorEditor.pasteClipboard();
    e.preventDefault();
  }

  @HostListener('window:keydown.control.d', ['$event'])
  @HostListener('window:keydown.meta.d', ['$event'])
  onDuplicate(e: Event): void {
    if (!this.isSelectionContext() || this.isEditableTarget(e)) return;
    this.vectorEditor.duplicateSelection();
    e.preventDefault();
  }

  @HostListener('window:keydown.control.a', ['$event'])
  @HostListener('window:keydown.meta.a', ['$event'])
  onSelectAll(e: Event): void {
    if (!this.isSelectionContext() || this.isEditableTarget(e)) return;
    this.vectorEditor.selectAll();
    e.preventDefault();
  }

  /** True while a tool that owns an object selection is active (Select/Node). */
  private isSelectionContext(): boolean {
    return this.editorService.isSelectTool() || this.editorService.isNodeTool();
  }

  /** Don't hijack keys while the user is typing in a form control. */
  private isEditableTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    return (
      t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable
    );
  }

  // ── Committed shapes ──────────────────────────────────────────────────────

  get renderShapes(): RenderShape[] {
    const labels = this.labelService.listSegmentationLabels;
    const orderById = new Map<number, number>();
    const colorById = new Map<number, string>();
    const visibleById = new Map<number, boolean>();
    labels.forEach((l, i) => {
      orderById.set(l.id, i);
      colorById.set(l.id, l.color);
      visibleById.set(l.id, l.isVisible);
    });
    const selectedIds = new Set(this.vectorEditor.selectedIds());

    return [...this.vectorEditor.shapes()]
      .filter((s) => visibleById.get(s.labelId) !== false)
      .sort(
        (a, b) =>
          (orderById.get(a.labelId) ?? 0) - (orderById.get(b.labelId) ?? 0),
      )
      .map((s) => {
        const color = colorById.get(s.labelId) ?? '#ffffff';
        return {
          id: s.id,
          d: buildPathData(s),
          color,
          fill: s.closed && s.filled ? color + '40' : 'none',
          selected: selectedIds.has(s.id),
        };
      });
  }

  /** The Select-tool marquee rectangle (image space), or null when inactive. */
  get marqueeRect(): Bounds | null {
    return this.vectorEditor.marquee();
  }

  // ── Pen draft + rubber-band preview ───────────────────────────────────────

  get draftPath(): { d: string; color: string } | null {
    const draft = this.vectorEditor.draft();
    if (!draft) return null;
    return { d: buildPathData(draft), color: this.colorFor(draft.labelId) };
  }

  get previewLine(): { x1: number; y1: number; x2: number; y2: number } | null {
    const draft = this.vectorEditor.draft();
    const hover = this.vectorEditor.hover();
    if (!draft || !hover || draft.nodes.length === 0) return null;
    const last = draft.nodes[draft.nodes.length - 1];
    return { x1: last.x, y1: last.y, x2: hover.x, y2: hover.y };
  }

  // ── Node / handle decorations (draft or selected shape) ───────────────────

  get decoColor(): string {
    const draft = this.vectorEditor.draft();
    if (draft) return this.colorFor(draft.labelId);
    const sel = this.vectorEditor.selectedShape();
    return sel ? this.colorFor(sel.labelId) : '#ffffff';
  }

  get anchors(): AnchorDeco[] {
    const target = this.editTarget();
    if (!target) return [];
    const selectedNode = target.isDraft
      ? null
      : this.vectorEditor.selectedNodeIndex();
    return target.nodes.map((n, i) => ({
      x: n.x,
      y: n.y,
      selected: i === selectedNode,
      first: target.isDraft && i === 0,
    }));
  }

  get handles(): HandleDeco[] {
    const target = this.editTarget();
    if (!target) return [];
    const out: HandleDeco[] = [];
    for (const n of target.nodes) {
      if (!(n.inX === n.x && n.inY === n.y)) {
        out.push({ ax: n.x, ay: n.y, hx: n.inX, hy: n.inY });
      }
      if (!(n.outX === n.x && n.outY === n.y)) {
        out.push({ ax: n.x, ay: n.y, hx: n.outX, hy: n.outY });
      }
    }
    return out;
  }

  /** Screen-constant transform placing a decoration at an image-space point. */
  decoTransform(x: number, y: number): string {
    const inv = 1 / Math.max(1e-6, this.zoomPan.scale);
    return `translate(${x} ${y}) scale(${inv})`;
  }

  private editTarget(): { nodes: VectorNode[]; isDraft: boolean } | null {
    const draft = this.vectorEditor.draft();
    if (draft) {
      return this.isLabelVisible(draft.labelId)
        ? { nodes: draft.nodes, isDraft: true }
        : null;
    }
    const sel = this.vectorEditor.selectedShape();
    if (sel && this.editorService.isNodeTool() && this.isLabelVisible(sel.labelId)) {
      return { nodes: sel.nodes, isDraft: false };
    }
    return null;
  }

  private colorFor(labelId: number): string {
    return this.labelFor(labelId)?.color ?? '#ffffff';
  }

  private isLabelVisible(labelId: number): boolean {
    return this.labelFor(labelId)?.isVisible ?? true;
  }

  private labelFor(labelId: number) {
    return this.labelService.listSegmentationLabels.find((l) => l.id === labelId);
  }
}
