import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';

import { PythonFunction, PythonFunctionParam } from '../../../lib/api';
import { PythonSegmentationService } from './python-segmentation.service';

/** The form for the arguments a Python function declared in its decorator. */
@Component({
  selector: 'app-python-params',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, InputNumberModule, SelectModule, ToggleSwitchModule],
  template: `
    @for (param of fn().params; track param.name) {
      @let id = fieldId(param.name);
      @let error = python.argError(fn(), param);
      <div class="param" [class.param--inline]="param.type === 'bool'">
        <label class="param__label" [attr.for]="id">{{ param.label }}</label>
        @switch (param.type) {
          @case ('bool') {
            <p-toggleswitch
              [inputId]="id"
              [ngModel]="python.argValue(fn(), param)"
              (ngModelChange)="python.setArg(fn(), param, $event)"
            />
          }
          @case ('enum') {
            <p-select
              [inputId]="id"
              [options]="param.choices"
              [ngModel]="python.argValue(fn(), param)"
              (ngModelChange)="python.setArg(fn(), param, $event)"
              size="small"
              appendTo="body"
              [fluid]="true"
            />
          }
          @default {
            <p-inputnumber
              [inputId]="id"
              [ngModel]="python.argValue(fn(), param)"
              (ngModelChange)="python.setArg(fn(), param, $event)"
              [min]="$any(param.min)"
              [max]="$any(param.max)"
              [step]="step(param)"
              [maxFractionDigits]="param.type === 'int' ? 0 : 10"
              [useGrouping]="false"
              [showButtons]="true"
              [invalid]="error !== null"
              size="small"
              [fluid]="true"
            />
          }
        }
        @if (error) {
          <small class="param__hint param__hint--error" role="alert">{{
            error
          }}</small>
        } @else if (param.hint) {
          <small class="param__hint">{{ param.hint }}</small>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      padding: 0.25rem 0 0.5rem;
    }

    .param {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      min-width: 0;

      &--inline {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;

        .param__hint {
          grid-column: 1 / -1;
        }
      }

      &__label {
        font-size: 0.8rem;
        font-weight: 600;
      }

      &__hint {
        opacity: 0.65;
        font-size: 0.75rem;
        line-height: 1.3;

        &--error {
          opacity: 1;
          color: var(--p-red-400);
        }
      }
    }
  `,
})
export class PythonParamsComponent {
  readonly python = inject(PythonSegmentationService);
  readonly fn = input.required<PythonFunction>();

  /** An HTML id: function names may contain spaces. */
  fieldId(field: string): string {
    const name = this.fn().name.replace(/[^\w-]+/g, '_');
    return `py-arg-${name}-${field}`;
  }

  step(param: PythonFunctionParam): number {
    return param.step ?? (param.type === 'int' ? 1 : 0.1);
  }
}
