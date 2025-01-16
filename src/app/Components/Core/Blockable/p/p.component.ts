import { Component, ElementRef, Input } from '@angular/core';
import { NgStyle, NgClass } from '@angular/common';
import { BlockableUI } from 'primeng/api';

@Component({
    selector: 'blockable-p',
    standalone: true,
    imports: [NgStyle, NgClass],
    template: `        
        <p [ngStyle]="style" [ngClass]="class" ><ng-content></ng-content></p>
    `
})
export class BlockableP implements BlockableUI {

    @Input() style: any;
    @Input() class: any;

    constructor(private el: ElementRef) {
    }

    getBlockableElement(): HTMLElement { 
        return this.el.nativeElement;
    }

}