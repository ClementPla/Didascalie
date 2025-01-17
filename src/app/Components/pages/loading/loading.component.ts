import { Component } from '@angular/core';
import { ProgressBarModule } from 'primeng/progressbar';
import { ViewService } from '../../../Services/UI/view.service';

@Component({
  selector: 'app-loading',
  standalone: true,
  imports: [ProgressBarModule],
  templateUrl: './loading.component.html',
  styleUrl: './loading.component.scss'
})
export class LoadingComponent {

  constructor(public viewService: ViewService) { }

}
