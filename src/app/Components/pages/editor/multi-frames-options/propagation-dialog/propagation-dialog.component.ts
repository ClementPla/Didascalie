import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  model,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectButtonModule } from 'primeng/selectbutton';

import { LabelsService } from '../../../../../Services/Labels/labels.service';
import {
  PropagationLabelScope,
  PropagationScope,
  PropagationService,
} from '../../../../../Services/Labels/propagation.service';

/**
 * Confirmation dialog for copying the current frame's labels onto the rest of
 * its sequence. Propagation overwrites frames the user cannot see and cannot be
 * undone, so the affected count is stated explicitly before they commit.
 */
@Component({
  selector: 'app-propagation-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    DialogModule,
    SelectButtonModule,
  ],
  templateUrl: './propagation-dialog.component.html',
  styleUrl: './propagation-dialog.component.scss',
})
export class PropagationDialogComponent {
  private readonly propagation = inject(PropagationService);
  private readonly labels = inject(LabelsService);

  /** Two-way bound by the host so a toolbar button or shortcut can open it. */
  readonly visible = model(false);

  /** Edits the service's remembered settings directly, so confirming here also
   *  redefines what the one-click toolbar action does. */
  readonly scope = computed(() => this.propagation.settings().scope);
  readonly labelScope = computed(() => this.propagation.settings().labelScope);
  readonly running = signal(false);

  setScope(scope: PropagationScope): void {
    this.propagation.settings.update((s) => ({ ...s, scope }));
  }

  setLabelScope(labelScope: PropagationLabelScope): void {
    this.propagation.settings.update((s) => ({ ...s, labelScope }));
  }

  readonly scopeOptions = [
    { label: 'Following frames', value: 'following' as const },
    { label: 'All other frames', value: 'allOthers' as const },
  ];

  readonly targetCount = computed(
    () => this.propagation.targetFrameIds(this.scope()).length,
  );

  readonly activeLabelName = computed(
    () => this.labels.activeLabel?.label ?? null,
  );

  get labelScopeOptions() {
    const active = this.activeLabelName();
    return [
      { label: 'All labels', value: 'all' as const },
      {
        label: active ? `Only "${active}"` : 'Active label',
        value: 'active' as const,
      },
    ];
  }

  async confirm(): Promise<void> {
    this.running.set(true);
    try {
      await this.propagation.propagate();
      this.visible.set(false);
    } finally {
      this.running.set(false);
    }
  }

  cancel(): void {
    this.visible.set(false);
  }
}
