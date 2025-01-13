# LabelMed Client

A powerful medical image labeling application built with [Angular CLI](https://github.com/angular/angular-cli) version 18.2.12 and [Tauri V2](https://v2.tauri.app/start/). LabelMed prioritizes privacy, speed, and ease of use for medical image annotation tasks.

## Key Features

- **Local Processing**: All operations run locally, ensuring data privacy and security
- **Multi-task Classification**: Support for multiple classification types
    - Multiclass classification
    - Multilabel classification
- **Flexible Configuration**: Easy setup for input/output folders
- **Advanced Image Processing**: Integrated OpenCV WASM for real-time image preprocessing

## Prerequisites

- Node.js and NPM
- Angular CLI
- Rust (for Tauri)

## Development

1. Install dependencies:
```bash
npm install
```

2. Start development server:
```bash
npm run tauri dev
```

## Building

Create production binaries:
```bash
npm run tauri build
```
Executables will be generated in `src-tauri/target/release/`

## Architecture

LabelMed combines multiple technologies for optimal performance:

- **Frontend**: Angular framework for responsive UI
- **Image Processing**: OpenCV WASM for client-side image operations
- **Backend Services**: 
    - Tauri/Rust for application serving and native features
    - MedSAM integration via ONNX Runtime
    - ZeroMQ for Python library communication

## Technical Stack

- Angular (Frontend Framework)
- Tauri V2 (Desktop Application Framework)
- Rust (Backend Processing)
- OpenCV WASM (Image Processing)
- ZeroMQ (Inter-process Communication)
- ONNX Runtime (ML Model Integration)

## Communication with Python
## Communication with Python

LabelMed enables seamless integration with Python scripts through ZeroMQ:

- **Real-time Communication**: Bidirectional data exchange between LabelMed and Python processes
- **Custom Model Integration**: 
    - Run your own ML models in Python
    - Send results directly to LabelMed for validation
    - Receive corrected annotations back in Python

- **Example Usage**:

```python
from pathlib import Path
from pynotate import Project
import numpy as np
from fundus_lesions_toolkit.models.segmentation import segment as segment_lesions, Dataset
from fundus_data_toolkit.functional import open_image

from fundus_lesions_toolkit.constants import LESIONS
from fundus_odmac_toolkit.models.segmentation import segment as segment_odmac
from tqdm.notebook import tqdm

segmentation_classes = ['Lesions/' + l for l in LESIONS[1:]] + ['OD', 'MAC']

classifications_classes = [{'name': 'Diabetic Retinopathy', 'classes': ['No DR', 'Mild', 'Moderate', 'Severe', 'Proliferative']}]
classification_multilabel = {'name': 'Others diseases', 'classes': ['Hypertension', 'Glaucoma', 'Myopia', 'Other']}

def run_model(filepath):
    img = open_image(filepath)
    lesions = segment_lesions(img, train_datasets=Dataset.IDRID).argmax(0).cpu().numpy()
    od_mask = segment_odmac(img).argmax(0).cpu().numpy()
    # Lesions
    masks = [255*(lesions == i).astype(np.uint8) for i in range(1, 5)]
    # OD and MAC
    masks += [255*(od_mask==i) for i in range(1, 3)] 

    # Random classification
    multilabel = np.random.choice(classification_multilabel['classes'], size=np.random.randint(0, len(classification_multilabel['classes']))).tolist()
    multiclass = np.random.choice(classifications_classes[0]['classes'], size=1).tolist()
    multilabel = None if len(multilabel) == 0 else multilabel
    
    return masks, multiclass, multilabel


with Project(project_name="FundusLesions", 
             input_dir=str(Path("inputFundus/").resolve()),
             output_dir=str(Path(".").resolve()),
             classification_classes=classifications_classes,
             classification_multilabel=classification_multilabel,
             segmentation_classes=segmentation_classes) as cli:
    for i in tqdm(range(N_IMAGES)):
        filepath = PATH_TO_IMAGE
        masks, multiclass, multilabel = run_model(filepath)
        cli.load_image(filepath, segmentation_masks=masks, multiclass_choices=multiclass, multilabel_choices=multilabel)


```

For detailed Python integration examples, see our [Python SDK Documentation (under construction)]().

