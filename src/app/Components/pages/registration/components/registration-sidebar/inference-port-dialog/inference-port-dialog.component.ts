// components/inference-port-dialog/inference-port-dialog.component.ts
import {
  ChangeDetectionStrategy, Component, EventEmitter, Output, signal, inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { InferenceClientService } from '../../../../../../Services/inference-client.service';

@Component({
  selector: 'app-inference-port-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, DialogModule,
            InputTextModule, InputNumberModule],
  templateUrl: './inference-port-dialog.component.html',
})
export class InferencePortDialogComponent {
  @Output() configured = new EventEmitter<{ host: string; port: number }>();
  @Output() cancelled  = new EventEmitter<void>();

  readonly inference = inject(InferenceClientService);
  readonly statusError = (() => {
    const status = this.inference.status();
    return status.kind === 'error' ? status.message : null;
  })();
  host = signal('127.0.0.1');
  port = signal(5556);

  visible = true;

  submit(): void {
    this.configured.emit({ host: this.host(), port: this.port() });
  }
  cancel(): void {
    this.visible = false;
    this.cancelled.emit();
  }
}