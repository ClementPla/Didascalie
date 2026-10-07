# Example projects

Eight small `.dida` projects built from public datasets, to try Didascalie without
preparing data. Each one is a subset of at most 20 samples (images, clips or
volumes) with the images embedded, so the file opens on its own.

| File | Content | Try |
| --- | --- | --- |
| `fundus_vessels.dida` | 20 fundus photographs with vessel masks, 5 per diagnosis | Skeletonize and vectorize, classification, gallery filters |
| `skin_lesions.dida` | 20 dermoscopy images, 12 with a lesion mask and 8 left empty | Otsu and flood fill on the empty frames, training a model from the 12 reviewed ones |
| `nuclei_histology.dida` | 19 H&E patches (one per tissue), each nucleus an instance of one of 5 cell types | Instance segmentation, several labels on one image, edge display |
| `fundus_registration.dida` | 8 infant eyes photographed at 3 or 4 visits; 6 with keypoint pairs against the first visit, 2 without | Frame registration: overlay and checkerboard on the 6, placing keypoints by hand on the 2 |
| `laparoscopy_video.dida` | 4 clips of 80 frames from 4 procedures, 12 classes | The inspector, side-by-side comparison |
| `echocardiography.dida` | 6 ultrasound sequences: 2- and 4-chamber views of 3 patients | The inspector on both views of a patient; only the first and last frames are annotated, so the others are free for label propagation |
| `brain_mri_tumour.dida` | 3 brain MRI volumes (1 mm isotropic, 134 to 149 slices) with 3 tumour regions, each as T1 with contrast and as FLAIR; two are the same patient at two time points | 3D volume mode (experimental) with the default slice spacing; the inspector with T1c and FLAIR side by side |
| `liver_ct_vessels.dida` | 3 abdominal CT volumes (46 to 48 slices) with vessels and tumours | 3D volume mode (experimental); set **Slice spacing** to about 6.5 |

Frames that carry ground-truth masks are marked reviewed.

## Sources and licences

The projects inherit the licence of the data they contain. Cite the original
authors if you reuse them.

| File | Dataset | Hugging Face repository | Licence |
| --- | --- | --- | --- |
| `fundus_vessels.dida` | FIVES (Jin et al., *Scientific Data*, 2022) | `tyluan/FIVES` | CC BY 4.0 |
| `skin_lesions.dida` | ISIC 2017 challenge (Codella et al., ISBI 2018) | `MedOtter/ISIC2017` | CC0 1.0 |
| `nuclei_histology.dida` | PanNuke (Gamper et al., 2019) | `RationAI/PanNuke` | CC BY-NC-SA 4.0 |
| `fundus_registration.dida` | COph100 (Hu et al., *Scientific Data*, 2025), images from Timkovič et al. (*Scientific Data*, 2024) | `MedOtter/COph100` | CC BY 4.0 |
| `laparoscopy_video.dida` | CholecSeg8k (Hong et al., 2020), from Cholec80 | `minwoosun/CholecSeg8k` | CC BY-NC-SA 4.0 |
| `echocardiography.dida` | CAMUS (Leclerc et al., *IEEE TMI*, 2019) | `zeahub/camus-sample` | CC BY-NC-SA 4.0 |
| `brain_mri_tumour.dida` | BraTS 2023 adult glioma (Baid et al., 2021; Menze et al., *IEEE TMI*, 2015) | `MedOtter/brats2023-gli-dataset` | CC BY 4.0 |
| `liver_ct_vessels.dida` | Medical Segmentation Decathlon, task 8 (Antonelli et al., *Nature Communications*, 2022) | `MedOtter/msd-hepatic-vessel` | CC BY-SA 4.0 |

## What was changed

- **Fundus**: masks binarised. The diagnosis comes from the file name.
- **Nuclei**: each cell type is an instance label, and its nuclei are numbered
  from 1 within each image.
- **Registration**: the 10 manual control points of each image are paired by
  number with those of the eye's first visit. The model-generated vessel masks
  of the source are not imported.
- **Laparoscopy**: classes come from the `watershed_mask` images. The black
  background and the unlabelled borders are not imported.
- **Echocardiography**: intensities (-60 to 0 dB) rescaled to 8 bits.
- **Brain MRI**: each scan rescaled to 8 bits between its 0.5th and 99.5th
  percentiles, slices without brain removed, radiological orientation. The T1c
  and FLAIR sequences of a case carry the same masks.
- **Liver CT**: intensities windowed to -100..300 HU and stored as 8-bit slices,
  in radiological orientation (patient right on the left of the image).

`build_examples.py` rebuilds the files from the Hugging Face downloads. It needs
`pydidascalie`, `pyarrow`, `nibabel`, `h5py`, `hdf5plugin` and `huggingface_hub`.
