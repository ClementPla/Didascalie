import { AfterViewInit, Component, ElementRef, Host, HostListener, OnInit, ViewChild } from '@angular/core';
import { QuickAccessMenuComponent } from "../editor/quick-access-menu/quick-access-menu.component";
import { ToggleSwitchModule } from 'primeng/toggleswitch';

import { FormsModule } from '@angular/forms';
@Component({
    selector: 'app-testing-zone',
    imports: [QuickAccessMenuComponent, ToggleSwitchModule, FormsModule],
    templateUrl: './testing-zone.component.html',
    styleUrl: './testing-zone.component.scss'
})


export class TestingZoneComponent implements AfterViewInit{



  @ViewChild('quickAccessMenu') quickAccessMenu!: QuickAccessMenuComponent;
  mousePosition: { x: number; y: number } | null = null;
  toggleValue: boolean = false;

  constructor() {}

  ngAfterViewInit(): void {
  }

  @HostListener('window:keydown', ['$event']) 
  onKeydown(event: KeyboardEvent) {
    if (event.key === 'Alt') {
      this.quickAccessMenu.position = this.mousePosition || { x: 0, y: 0 };
      this.quickAccessMenu.toggleOpen();
    }
  }

  updateMousePosition(event: MouseEvent) {
    this.mousePosition = { x: event.clientX, y: event.clientY };
  }

}
