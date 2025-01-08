import { Injectable } from '@angular/core';
import { BboxLabel } from '../../../../Core/interface';




@Injectable({
  providedIn: 'root'
})
export class BboxManagerService {

  listBbox: BboxLabel[] = [];

  constructor() { 

    // this.listBbox.push(
    //   {
    //     label: {
    //       label: 'bbox1',
    //       color: '#FF0000',
    //       isVisible: true,
    //       shades: null
    //     },
    //     bbox: {
    //       x: 100,
    //       y: 100,
    //       width: 100,
    //       height: 100
    //     },
    //     instance: 1
    //   }
    // );
  }
}
