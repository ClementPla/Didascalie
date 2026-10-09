import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { ProgressBarModule } from 'primeng/progressbar';
import { UIStateService } from '../../services/uistate.service';
@Component({
    selector: 'app-loading',
    imports: [ProgressBarModule],
    templateUrl: './loading.component.html',
    styleUrl: './loading.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingComponent {  uiStateService = inject(UIStateService);

}
