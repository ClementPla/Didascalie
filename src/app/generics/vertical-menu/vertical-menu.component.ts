import { Component, ContentChildren, QueryList, TemplateRef } from '@angular/core';
import { ButtonModule } from "primeng/button";
import { RippleModule } from "primeng/ripple";
import { CommonModule } from '@angular/common';
import { MenuGroupDirective } from './menu-group.directive'; // 1. Import your directive

export interface MenuGroup {
  title: string;
  template: TemplateRef<any>;
}

@Component({
  selector: 'app-vertical-menu',
  standalone: true,
  imports: [ButtonModule, RippleModule, CommonModule],
  templateUrl: './vertical-menu.component.html',
  styleUrl: './vertical-menu.component.scss'
})
export class VerticalMenuComponent {
  @ContentChildren(MenuGroupDirective) groupTemplates!: QueryList<MenuGroupDirective>;

  get groups(): MenuGroup[] {
    return this.groupTemplates?.map(item => ({
      title: item.title,
      template: item.templateRef
    })) || [];
  }
}