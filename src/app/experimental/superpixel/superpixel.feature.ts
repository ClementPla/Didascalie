import { PostProcessOption } from '../../Core/tools';
import { ExperimentalFeatureDescriptor } from '../descriptor';
import { SuperpixelService } from './superpixel.service';
import { SuperpixelSettingsComponent } from './superpixel-settings.component';

export const SUPERPIXEL_FEATURE: ExperimentalFeatureDescriptor = {
  flag: 'superpixel',
  label: 'Superpixel refinement',
  description: 'Snap brush strokes to superpixel boundaries.',
  postProcess: [
    {
      option: PostProcessOption.SUPERPIXEL,
      description:
        'Snap the brush stroke to superpixel boundaries, keeping only the ' +
        'touched superpixels that match the dominant color under the stroke.',
      settingsComponent: SuperpixelSettingsComponent,
      run: (injector) => injector.get(SuperpixelService).refineStroke(),
    },
  ],
  onImageLoaded: (injector) => injector.get(SuperpixelService).onImageLoaded(),
  getOverlay: (injector) => injector.get(SuperpixelService).visibleOverlay(),
  onDisabled: (injector) => injector.get(SuperpixelService).onFeatureDisabled(),
};
