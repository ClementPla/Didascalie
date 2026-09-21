import { MaskVolumeService } from '../../services/mask-volume.service';
import { ExperimentalFeatureDescriptor } from '../descriptor';
import { CurveOverlayComponent } from './projection/curve-overlay.component';
import { VolumePanelComponent } from './volume-panel.component';

export const VOLUME3D_FEATURE: ExperimentalFeatureDescriptor = {
  flag: 'volume3d',
  label: '3D volume mode',
  description:
    'Annotate a sequence as a voxel volume, with a 3D view and a curved projection.',
  editorPanes: [VolumePanelComponent],
  canvasOverlays: [CurveOverlayComponent],
  onDisabled: (injector) => injector.get(MaskVolumeService).disable(),
};
