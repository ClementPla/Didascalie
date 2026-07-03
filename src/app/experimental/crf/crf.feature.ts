import { PostProcessOption } from '../../Core/tools';
import { ExperimentalFeatureDescriptor } from '../descriptor';
import { CrfService } from './crf.service';
import { CrfSettingsComponent } from './crf-settings.component';

export const CRF_FEATURE: ExperimentalFeatureDescriptor = {
  flag: 'crf',
  label: 'CRF refinement',
  description: 'Refine brush strokes with a conditional random field.',
  postProcess: [
    {
      option: PostProcessOption.CRF,
      description:
        'Snap the brush stroke to nearby color edges with a mean-field dense ' +
        'CRF, letting the boundary grow and shrink to follow the object.',
      settingsComponent: CrfSettingsComponent,
      run: (injector) => injector.get(CrfService).refineStroke(),
    },
  ],
};
