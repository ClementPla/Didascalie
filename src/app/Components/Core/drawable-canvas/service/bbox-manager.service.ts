import { Injectable } from '@angular/core';
import { BboxLabel } from '../../../../Core/interface';




@Injectable({
  providedIn: 'root'
})
export class BboxManagerService {

  listBbox: BboxLabel[] = [];

  constructor() { 
  }
}
