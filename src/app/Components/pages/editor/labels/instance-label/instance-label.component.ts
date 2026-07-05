import { Component, Input } from '@angular/core';
import { SegLabel } from '../../../../../Core/interface';
import { ProjectService } from '../../../../../Services/ProjectService/project.service';
import { generate_shades } from '../../../../../Core/misc/colors';
import { NgClass } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { LabelsService } from '../../../../../Services/Labels/labels.service';

/**
 * Instance picker for one label. Instance ids are 1-based (the id IS the pixel
 * value, so 0 is reserved for background). Each swatch is one instance; clicking
 * it selects that instance, and "New instance" advances to the next id.
 */
@Component({
  selector: 'app-instance-label',
  imports: [NgClass, ButtonModule],
  templateUrl: './instance-label.component.html',
  styleUrl: './instance-label.component.scss',
})
export class InstanceLabelComponent {
  @Input() label: SegLabel;
  shades: string[] = [];

  constructor(
    private projectService: ProjectService,
    public labelService: LabelsService
  ) {}

  ngOnInit(): void {
    this.getShades();
  }

  getShades(): string[] {
    if (this.shades.length !== this.projectService.maxInstances) {
      this.shades = generate_shades(this.label.color, this.projectService.maxInstances);
    }
    this.label.shades = this.shades;
    return this.shades;
  }

  /** Selectable instance ids for this label (1-based; id = pixel value). */
  instanceValues(): number[] {
    const n = this.getShades().length;
    return Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1);
  }

  shadeFor(value: number): string {
    const shades = this.getShades();
    return shades[value] ?? shades[value % shades.length];
  }

  /** The instance id selected for this label, or null if none / another label. */
  activeInstance(): number | null {
    const inst = this.labelService.activeSegInstance;
    return inst && inst.label === this.label && inst.instance >= 1 ? inst.instance : null;
  }

  isSelected(value: number): boolean {
    return this.activeInstance() === value;
  }

  changeActive(value: number): void {
    this.labelService.activeLabel = this.label;
    this.labelService.activeSegInstance = {
      label: this.label,
      instance: value,
      shade: this.shadeFor(value),
      id: this.label.id,
    };
  }

  /** Advance to the next instance id (activating this label). */
  newInstance(): void {
    const values = this.instanceValues();
    const current = this.activeInstance() ?? 0;
    const next = values.find((v) => v > current) ?? values[0] ?? 1;
    this.changeActive(next);
  }
}
