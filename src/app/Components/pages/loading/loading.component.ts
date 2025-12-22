import { Component } from '@angular/core';
import { ProgressBarModule } from 'primeng/progressbar';
import { UIStateService } from '../../../Services/uistate.service';
@Component({
    selector: 'app-loading',
    imports: [ProgressBarModule],
    templateUrl: './loading.component.html',
    styleUrl: './loading.component.scss'
})
export class LoadingComponent {

  constructor(public uiStateService: UIStateService) { }

}
