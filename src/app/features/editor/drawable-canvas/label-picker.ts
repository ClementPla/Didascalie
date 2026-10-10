import { MenuItem } from 'primeng/api';

import { LabelsService } from '../../../services/labels/labels.service';

/**
 * The labels as context-menu entries, the active one ticked.
 *
 * Build them when the menu opens, not from a getter: PrimeNG menus react to the
 * array's identity, and a fresh array on every change-detection pass rebuilds
 * the overlay under the cursor and swallows the click.
 */
export function labelPickerItems(labels: LabelsService): MenuItem[] {
  const active = labels.activeLabel;
  return labels.listSegmentationLabels.map((label) => ({
    label: label.label,
    icon: label === active ? 'pi pi-check' : 'pi pi-fw',
    style: { 'border-left': `4px solid ${label.color}` },
    command: () => labels.activate(label),
  }));
}
