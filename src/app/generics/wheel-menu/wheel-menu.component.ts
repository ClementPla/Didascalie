import { AfterViewInit, ChangeDetectorRef, Component, Input, OnInit, Output, ViewChild, EventEmitter } from '@angular/core';
import { NgIf, NgSwitch, NgSwitchCase, CommonModule } from '@angular/common';
import { NgFor } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { FormsModule } from '@angular/forms';
import { SliderModule } from 'primeng/slider';

export enum SegmentType {
  toggle = 'toggle',
  slider = 'slider',
  button = 'button',
}

export interface MenuItem {
  label: string;
  icon: string;
  children?: MenuItem[];
  command?: () => void;
  disabled?: boolean;
  visible?: boolean;
  styleClass?: string;
  path?: string; // Optional path for navigation
  isActive?: boolean; // Optional property to track active state
  type?: SegmentType; // Optional property to define the type of segment
  value?: any; // Optional property to hold the value of the segment
}

interface Segment {
  path: string;
  barycenter: { x: number; y: number };
  startAngle: number;
  endAngle: number;
  children?: Segment[];
}

@Component({
    selector: 'app-wheel-menu',
    imports: [NgFor, ButtonModule, SliderModule, FormsModule, CommonModule],
    templateUrl: './wheel-menu.component.html',
    styleUrl: './wheel-menu.component.scss'
})
export class WheelMenuComponent implements AfterViewInit {
  @Input() radius: number = 256;
  @Input() items: MenuItem[] = [];
  @Output() closeMenu: EventEmitter<boolean> = new EventEmitter<boolean>();
  @ViewChild('wheel') wheel!: HTMLElement;

  public segmentType = SegmentType;

  public selectedIndex: number | null = null;
  public segments: Segment[] = [];

  innerRadius = 32;
  outerRadius: number = this.radius + this.innerRadius * 3;
  constructor(private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    this.outerRadius = this.radius + this.innerRadius * 3;
    this.segments = this.buildMultiSegmentPaths();
    this.cdr.detectChanges();
  }
  buildMultiSegmentPaths(): Segment[] {
    const n = this.items.length;

    // This function generates a path for an SVG element that represents a circular segment.
    // The path starts at the top of the circle and goes around to create a segment.

    const segments: Segment[] = [];
    const angleStep = 360 / n;
    const innerRadius = this.radius / 3;
    const radius = this.radius;
    for (let i = 0; i < n; i++) {
      const startAngle = i * angleStep;
      const endAngle = (i + 1) * angleStep;

      const path = `
        M ${innerRadius * Math.cos((startAngle * Math.PI) / 180)} ${
        innerRadius * Math.sin((startAngle * Math.PI) / 180)
      }
        A ${innerRadius} ${innerRadius} 0 0 1 ${
        innerRadius * Math.cos((endAngle * Math.PI) / 180)
      } ${innerRadius * Math.sin((endAngle * Math.PI) / 180)}

        L ${radius * Math.cos((endAngle * Math.PI) / 180)} ${
        radius * Math.sin((endAngle * Math.PI) / 180)
      }
        A ${radius} ${radius} 0 0 0 ${
        radius * Math.cos((startAngle * Math.PI) / 180)
      } ${radius * Math.sin((startAngle * Math.PI) / 180)}
        Z  
      `;
      const midAngle = (startAngle + endAngle) / 2;
      // Create a barycenter for the segment
      const barycenter = {
        x:
          (innerRadius * Math.cos((midAngle * Math.PI) / 180) +
            radius * Math.cos((midAngle * Math.PI) / 180)) /
          2,
        y:
          (innerRadius * Math.sin((midAngle * Math.PI) / 180) +
            radius * Math.sin((midAngle * Math.PI) / 180)) /
          2,
      };
      let children;
       // Create a segment object
      let segment: Segment = {
        path,
        barycenter,
        startAngle,
        endAngle,
      };
      if (this.items[i].children && this.items[i].children!.length > 0) {
        children = this.items[i].children!.map((child, index) => {
          return this.getChildSegmentPath(segment, i, index);
        });
      }

      segment.children = children || [];

     
      // Add the segment to the array
      segments.push(segment);
    }

    return segments;
  }

  getViewbox(): string {
    let areTheyAnyChildren = this.items.some(
      (item) => item.children && item.children.length > 0
    );
    let dim = this.radius * 2;
    if (areTheyAnyChildren) {
      dim = this.outerRadius * 2;
    }
    const viewbox = `${-dim / 2} ${-dim / 2} ${dim} ${dim}`;
    return viewbox;
  }

  hoverSegment(index: number): void {
    this.selectedIndex = index;
  }
  focus(){
    if(this.wheel) {
      this.wheel.focus();
    }
  }
  getChildSegmentPath(parentSegment: Segment, segmentIndex: number, childIndex: number): Segment {
    const currentSegment = parentSegment;
    const nChildren = this.items[segmentIndex].children!.length;
    const startAngle = currentSegment.startAngle;
    const endAngle = currentSegment.endAngle;
    const angleDiff = endAngle - startAngle;
    // Value of current child
    const childStartAngle = startAngle + (angleDiff * childIndex) / nChildren;
    const childEndAngle =
      startAngle + (angleDiff * (childIndex + 1)) / nChildren;

    const startRadius = this.radius;
    const endRadius = this.outerRadius;
    const path = `
      M ${startRadius * Math.cos((childStartAngle * Math.PI) / 180)} ${
      startRadius * Math.sin((childStartAngle * Math.PI) / 180)
    }
      A ${startRadius} ${startRadius} 0 0 1 ${
      startRadius * Math.cos((childEndAngle * Math.PI) / 180)
    } ${startRadius * Math.sin((childEndAngle * Math.PI) / 180)}

      L ${endRadius * Math.cos((childEndAngle * Math.PI) / 180)} ${endRadius * Math.sin((childEndAngle * Math.PI) / 180)}
      A ${endRadius} ${endRadius} 0 0 0 ${
      endRadius * Math.cos((childStartAngle * Math.PI) / 180)
    } ${endRadius * Math.sin((childStartAngle * Math.PI) / 180)}
      Z
    `;
    const midAngle = (childStartAngle + childEndAngle) / 2;
    return {
      path,
      barycenter: {
        x: (startRadius * Math.cos((midAngle * Math.PI) / 180) +
            endRadius * Math.cos((midAngle * Math.PI) / 180)) /
          2,
        y: (startRadius * Math.sin((midAngle * Math.PI) / 180) +
            endRadius * Math.sin((midAngle * Math.PI) / 180)) /
          2
      },
      startAngle: childStartAngle,
      endAngle: childEndAngle
    };
  }

  callCommand(item: MenuItem): void {
    if (!item.command) {
      return;
    }
    item.command();
    this.closeMenu.emit(true);
  }
}
