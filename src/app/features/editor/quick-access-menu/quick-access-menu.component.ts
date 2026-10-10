import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  WheelMenuComponent,
  MenuItem,
  SegmentType,
} from '../../../shared/generics/wheel-menu/wheel-menu.component';
import { Tool, Tools } from '../../../core/tools';
import { EditorService } from '../services/editor.service';
import { VectorEditorService } from '../drawable-canvas/service/vector-editor.service';
import { ConvertService } from '../drawable-canvas/service/convert.service';

@Component({
  selector: 'app-quick-access-menu',
  imports: [WheelMenuComponent],
  templateUrl: './quick-access-menu.component.html',
  styleUrl: './quick-access-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuickAccessMenuComponent {
  private editorService = inject(EditorService);
  private vectorEditor = inject(VectorEditorService);
  private convertService = inject(ConvertService);

  readonly radius = 150;

  readonly isOpen = signal(false);
  readonly position = signal<{ x: number; y: number }>({ x: 0, y: 0 });

  private readonly wheel = viewChild<WheelMenuComponent>('wheel');

  /** Whether the last visit applied an entry. Outlives the wheel: a click
   *  closes it before the key comes back up. */
  private committed = false;

  /** Built once: a new array on every change detection rebuilds the wheel.
   *  Live state is read through the `active` / `checked` callbacks. */
  readonly menuItems: MenuItem[] = this.buildItems();

  private toolItem(tool: Tool, children?: MenuItem[]): MenuItem {
    return {
      label: tool.name,
      icon: tool.icon,
      materialIcon: tool.materialIcon ?? undefined,
      command: () => this.editorService.selectTool(tool),
      active: () => this.editorService.selectedTool === tool,
      children,
    };
  }

  private get eraserOptions(): MenuItem[] {
    return [
      {
        label: 'All labels',
        icon: 'pi pi-clone',
        type: SegmentType.toggle,
        checked: () => this.editorService.eraseAll,
        command: () =>
          (this.editorService.eraseAll = !this.editorService.eraseAll),
      },
      {
        label: 'Connected',
        icon: 'pi pi-circle-fill',
        type: SegmentType.toggle,
        checked: () => this.editorService.eraserPostProcess,
        command: () =>
          (this.editorService.eraserPostProcess =
            !this.editorService.eraserPostProcess),
      },
    ];
  }

  private get drawOptions(): MenuItem[] {
    return [
      {
        label: 'Swap labels',
        icon: 'pi pi-arrow-right-arrow-left',
        type: SegmentType.toggle,
        checked: () => this.editorService.swapMarkers,
        command: () =>
          (this.editorService.swapMarkers = !this.editorService.swapMarkers),
      },
      {
        label: 'Auto-segment',
        icon: 'pi pi-sparkles',
        type: SegmentType.toggle,
        checked: () => this.editorService.penPostProcess,
        command: () =>
          (this.editorService.penPostProcess =
            !this.editorService.penPostProcess),
      },
    ];
  }

  /** The two most-used tools sit opposite each other. */
  private buildItems(): MenuItem[] {
    return [
      this.toolItem(Tools.PEN, this.drawOptions),
      this.toolItem(Tools.LINE, this.drawOptions),
      this.toolItem(Tools.LASSO, this.drawOptions),
      this.toolItem(Tools.PATH),
      this.toolItem(Tools.ERASER, this.eraserOptions),
      this.toolItem(Tools.LASSO_ERASER, this.eraserOptions),
      this.toolItem(Tools.SELECT),
      this.toolItem(Tools.NODE, [
        {
          label: 'Delete',
          icon: 'pi pi-trash',
          type: SegmentType.button,
          command: () => this.vectorEditor.deleteSelectedShape(),
        },
        {
          label: 'Fill',
          icon: 'pi pi-stop',
          type: SegmentType.toggle,
          command: () => this.vectorEditor.toggleFilled(),
        },
        {
          label: 'Close',
          icon: 'pi pi-circle',
          type: SegmentType.toggle,
          command: () => this.vectorEditor.toggleClosed(),
        },
        {
          label: 'Rasterize',
          icon: 'pi pi-th-large',
          materialIcon: 'imagesearch_roller',
          type: SegmentType.button,
          command: () => this.convertService.rasterize(),
        },
      ]),
      this.toolItem(Tools.VECTORIZE),
      this.toolItem(Tools.SKELETONIZE),
    ];
  }

  open(at: { x: number; y: number }): void {
    this.committed = false;
    this.position.set(at);
    this.isOpen.set(true);
  }

  /** Apply what is aimed at and close. False when nothing was aimed at. */
  close(): boolean {
    if (this.isOpen()) {
      this.committed = this.wheel()?.commitAimed() ?? false;
      this.isOpen.set(false);
    }
    return this.committed;
  }
}
