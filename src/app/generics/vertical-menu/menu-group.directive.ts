import { Directive, Input, TemplateRef } from '@angular/core';

@Directive({
  selector: '[appMenuGroup]',
  standalone: true
})
export class MenuGroupDirective {
  @Input('appMenuGroup') title: string = '';
  constructor(public templateRef: TemplateRef<any>) {}
}