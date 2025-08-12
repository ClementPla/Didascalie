import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  ViewChild,
} from '@angular/core';
import {
  WheelMenuComponent,
  MenuItem,
  SegmentType,
} from '../../../../generics/wheel-menu/wheel-menu.component';
import { ALL_TOOLS, Tools } from '../../../../Core/tools';
import { NgClass } from '@angular/common';
import { EditorService } from '../../../../Services/UI/editor.service';

@Component({
  selector: 'app-quick-access-menu',
  standalone: true,
  imports: [WheelMenuComponent, NgClass],
  templateUrl: './quick-access-menu.component.html',
  styleUrl: './quick-access-menu.component.scss',
})
export class QuickAccessMenuComponent {
  @ViewChild('quickAccessMenu') quickAccessMenu!: WheelMenuComponent;

  constructor(
    private cdr: ChangeDetectorRef,
    private editorService: EditorService
  ) {}

  public radius: number = 200;

  public isOpen: boolean = false;

  public position: { x: number; y: number } = { x: 0, y: 0 };

  getMenuItems(): MenuItem[] {
    return [
      {
        label: Tools.PAN.name,
        icon: Tools.PAN.icon,
        command: () => this.editorService.selectTool(Tools.PAN),
      },
      {
        label: Tools.LASSO_ERASER.name,
        icon: Tools.LASSO_ERASER.icon,
        command: () => this.editorService.selectTool(Tools.LASSO_ERASER),
        children: [
          {
            label: 'Erase all labels',
            icon: Tools.LASSO_ERASER.icon,
            command: () =>
              (this.editorService.eraseAll = !this.editorService.eraseAll),
            type: SegmentType.toggle,
          },
          {
            label: 'Erase connected',
            icon: Tools.LASSO_ERASER.icon,
            command: () =>
              (this.editorService.eraserPostProcess =
                !this.editorService.eraserPostProcess),
            type: SegmentType.toggle,
          },
        ],
      },
      {
        label: Tools.ERASER.name,
        icon: Tools.ERASER.icon,
        command: () => this.editorService.selectTool(Tools.ERASER),
        children: [
          {
            label: 'Erase all labels',
            icon: Tools.LASSO_ERASER.icon,
            command: () =>
              (this.editorService.eraseAll = !this.editorService.eraseAll),
            type: SegmentType.toggle,
          },
          {
            label: 'Erase connected',
            icon: Tools.LASSO_ERASER.icon,
            command: () =>
              (this.editorService.eraserPostProcess =
                !this.editorService.eraserPostProcess),
            type: SegmentType.toggle,
          },
        ],
      },

      {
        label: Tools.PEN.name,
        icon: Tools.PEN.icon,
        command: () => this.editorService.selectTool(Tools.PEN),
        children: [
          {
            label: 'Swap labels',
            icon: Tools.PEN.icon,
            command: () =>
              (this.editorService.swapMarkers =
                !this.editorService.swapMarkers),
            type: SegmentType.toggle,
          },
        ],
      },
      {
        label: Tools.LASSO.name,
        icon: Tools.LASSO.icon,
        command: () => this.editorService.selectTool(Tools.LASSO),
        children: [
          {
            label: 'Swap labels',
            icon: Tools.LASSO.icon,
            command: () =>
              (this.editorService.swapMarkers =
                !this.editorService.swapMarkers),
            type: SegmentType.toggle,
          },
        ],
      },
      {
        label: Tools.LINE.name,
        icon: Tools.LINE.icon,
        command: () => this.editorService.selectTool(Tools.LINE),
        children: [
          {
            label: 'Swap labels',
            icon: Tools.LINE.icon,
            command: () =>
              (this.editorService.swapMarkers =
                !this.editorService.swapMarkers),
            type: SegmentType.toggle,
          },
        ],
      },
    ];
  }

  open() {
    this.isOpen = true;
    // Wait until Angular finishes DOM updates
    this.cdr.detectChanges(); // flush the change so the element is visible
    this.quickAccessMenu.focus();
  }

  close() {
    this.isOpen = false;
  }

  toggleOpen() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }
}
