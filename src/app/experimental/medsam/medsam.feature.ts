import { PostProcessOption } from '../../core/tools';
import { ExperimentalFeatureDescriptor } from '../descriptor';
import { MedsamService } from './medsam.service';
import { MedsamSettingsComponent } from './medsam-settings.component';

export const MEDSAM_FEATURE: ExperimentalFeatureDescriptor = {
  flag: 'medsam',
  label: 'MedSAM refinement',
  description: 'Refine brush strokes into masks with a SAM-style model.',
  postProcess: [
    {
      option: PostProcessOption.MEDSAM,
      description:
        'Turn the brush stroke into a mask with a SAM-style model, ' +
        'downloaded on first use. Unavailable on very large images.',
      settingsComponent: MedsamSettingsComponent,
      run: (injector) => injector.get(MedsamService).refineStroke(),
    },
  ],
  onImageLoaded: (injector) => injector.get(MedsamService).onImageLoaded(),
};
