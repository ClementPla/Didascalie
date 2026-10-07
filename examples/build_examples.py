"""Build the Didascalie example projects from small subsets of public datasets.

Usage: python build_examples.py <download_dir> <output_dir> [name ...]

Downloads what is missing into <download_dir> (about 1 GB), then writes one
.dida file per example into <output_dir>. Names: fundus, skin, nuclei,
registration, laparoscopy, echo, brain, liver (all of them when none is given).
"""

import glob
import io
import json
import os
import sys
import zipfile

import numpy as np
import pyarrow.parquet as pq
from PIL import Image

from didascalie import DidascalieProject, Label, ProjectConfig

HF, OUT = sys.argv[1], sys.argv[2]
ONLY = set(sys.argv[3:])
MAX_SAMPLES = 20


BRATS_REPO = "MedOtter/brats2023-gli-dataset"
BRATS_FOLDER = "ASNR-MICCAI-BraTS2023-GLI-Challenge-TrainingData"
# The last two are the same patient at two time points.
BRATS_CASES = ["BraTS-GLI-00060-000", "BraTS-GLI-00036-000", "BraTS-GLI-00036-001"]
BRATS_SCANS = {"t1c": "T1c", "t2f": "FLAIR"}
LIVER_CASES = ["hepaticvessel_100", "hepaticvessel_128", "hepaticvessel_422"]


def fetch(key):
    """Download the files one example needs, unless they are already there."""
    from huggingface_hub import HfFileSystem, hf_hub_download, snapshot_download

    def get(repo, filename, folder):
        hf_hub_download(repo, filename, repo_type="dataset", local_dir=f"{HF}/{folder}")

    if key == "fundus":
        get("tyluan/FIVES", "data/test-00000-of-00001.parquet", "fives")
    elif key == "skin":
        get("MedOtter/ISIC2017", "data/train-00000-of-00030.parquet", "isic")
    elif key == "registration":
        get("MedOtter/COph100", "data/test-00000-of-00001.parquet", "coph")
    elif key == "nuclei":
        get("RationAI/PanNuke", "data/fold2-00000-of-00001.parquet", "pannuke")
    elif key == "echo":
        snapshot_download(
            "zeahub/camus-sample", repo_type="dataset", local_dir=f"{HF}/camus"
        )
    elif key == "brain":
        for case in BRATS_CASES:
            for kind in ("seg", *BRATS_SCANS):
                get(BRATS_REPO, f"{BRATS_FOLDER}/{case}/{case}-{kind}.nii.gz", "brats")
    elif key == "liver":
        for case in LIVER_CASES:
            for folder in ("imagesTr", "labelsTr"):
                get("MedOtter/msd-hepatic-vessel", f"{folder}/{case}.nii.gz", "hv")
    elif key == "laparoscopy" and not os.path.exists(f"{HF}/cholec_names.txt"):
        # The archive is 3 GB: only its index is read here, and the frames of
        # the chosen clips are fetched by range requests later.
        with HfFileSystem().open(
            "datasets/minwoosun/CholecSeg8k/data/CholecSeg8k.zip"
        ) as fh:
            names = zipfile.ZipFile(fh).namelist()
        with open(f"{HF}/cholec_names.txt", "w") as out:
            out.write("\n".join(names))


def png(b):
    return Image.open(io.BytesIO(b))


def create(filename, name, labels, tasks=None, instances=False):
    """New embedded project with its labels and multiclass tasks declared."""
    config = ProjectConfig(
        name=name,
        images_embedded=True,
        classification_enabled=bool(tasks),
        instance_segmentation_enabled=instances,
    )
    project = DidascalieProject.create(
        os.path.join(OUT, filename), name=name, config=config, overwrite=True
    )
    for i, (label, color) in enumerate(labels):
        project.add_label(
            Label(name=label, color=color, is_instance=instances, sort_order=i)
        )
    project._tasks = tasks or {}
    project._labels = labels
    return project


def finish(project):
    """Write what the application reads from the config, mark annotated frames
    reviewed, and compact the file."""
    conn = project._conn
    config = json.loads(conn.execute("SELECT config FROM project").fetchone()[0])
    config["segmentation_labels"] = [
        {"name": n, "color": c, "shades": None} for n, c in project._labels
    ]
    config["classification_tasks"] = [
        {"name": n, "classes": classes, "default": None}
        for n, classes in project._tasks.items()
    ]
    conn.execute("UPDATE project SET config = ?", (json.dumps(config),))
    conn.execute(
        "UPDATE frames SET reviewed = 1 WHERE id IN (SELECT frame_id FROM annotations)"
    )
    conn.commit()
    stats = project.get_statistics()
    project.close()
    return stats


# --------------------------------------------------------------------------
# Single images
# --------------------------------------------------------------------------


def fundus():
    """FIVES: fundus photographs with vessel masks, five per diagnosis."""
    names = {
        "A": "AMD",
        "D": "Diabetic retinopathy",
        "G": "Glaucoma",
        "N": "Normal",
    }
    project = create(
        "fundus_vessels.dida",
        "Fundus vessels (FIVES)",
        [("vessels", "#00E5FF")],
        {"diagnosis": list(names.values())},
    )
    pf = pq.ParquetFile(f"{HF}/fives/data/test-00000-of-00001.parquet")
    ids = pf.read(columns=["image_id"]).column("image_id").to_pylist()
    per_class = MAX_SAMPLES // len(names)
    wanted, seen = set(), {k: 0 for k in names}
    for i, image_id in sorted(enumerate(ids), key=lambda p: int(p[1].split("_")[1])):
        k = image_id.split("_")[-1]
        if seen[k] < per_class:
            seen[k] += 1
            wanted.add(i)
    offset = 0
    for g in range(pf.metadata.num_row_groups):
        rows = pf.read_row_group(g).to_pylist()
        for j, row in enumerate(rows):
            if offset + j not in wanted:
                continue
            mask = np.array(png(row["mask"]["bytes"]).convert("L")) > 127
            project.import_with_masks(
                png(row["image"]["bytes"]).convert("RGB"),
                {"vessels": mask},
                sequence_name=row["image_id"],
                classification={"diagnosis": [names[row["image_id"].split("_")[-1]]]},
            )
        offset += len(rows)
    return finish(project)


def skin():
    """ISIC 2017: dermoscopy. The last frames are left empty on purpose, to try
    the assisted-labelling tools on them."""
    project = create(
        "skin_lesions.dida", "Skin lesions (ISIC 2017)", [("lesion", "#FFD400")]
    )
    rows = pq.ParquetFile(f"{HF}/isic/data/train-00000-of-00030.parquet").read()
    rows = rows.to_pylist()
    # Alternate the two image sizes present in this shard.
    rows = (rows[:16:2] + rows[16:40:2])[:MAX_SAMPLES]
    annotated = 12
    for i, row in enumerate(rows):
        masks = {}
        if i < annotated:
            masks["lesion"] = np.array(png(row["mask"]["bytes"]).convert("L")) > 127
        project.import_with_masks(
            png(row["image"]["bytes"]).convert("RGB"),
            masks,
            sequence_name=row["image_id"],
        )
    return finish(project)


def nuclei():
    """PanNuke: H&E patches, one instance label per cell type, tissue as a class."""
    categories = [
        ("Neoplastic", "#FF3B30"),
        ("Inflammatory", "#34C759"),
        ("Connective", "#0A84FF"),
        ("Dead", "#FFD60A"),
        ("Epithelial", "#FF9F0A"),
    ]
    tissues = [
        "Adrenal Gland", "Bile Duct", "Bladder", "Breast", "Cervix", "Colon",
        "Esophagus", "Head & Neck", "Kidney", "Liver", "Lung", "Ovarian",
        "Pancreatic", "Prostate", "Skin", "Stomach", "Testis", "Thyroid", "Uterus",
    ]
    project = create(
        "nuclei_histology.dida",
        "Nuclei in H&E (PanNuke)",
        categories,
        {"tissue": tissues},
        instances=True,
    )
    pf = pq.ParquetFile(f"{HF}/pannuke/data/fold2-00000-of-00001.parquet")
    picked = {}
    for g in range(pf.metadata.num_row_groups):
        for row in pf.read_row_group(g).to_pylist():
            t = row["tissue"]
            # One patch per tissue, with enough nuclei of several types to look at.
            if t in picked or len(row["instances"]) < 25:
                continue
            if len(set(row["categories"])) < 2:
                continue
            picked[t] = row
        if len(picked) == len(tissues):
            break
    rows = [picked[t] for t in sorted(picked)][:MAX_SAMPLES]
    for row in rows:
        image = png(row["image"]["bytes"]).convert("RGB")
        w, h = image.size
        # Each cell type is a label; its nuclei are numbered from 1 within it.
        masks, count = {}, {}
        for inst, cat in zip(row["instances"], row["categories"]):
            name = categories[cat][0]
            count[name] = count.get(name, 0) + 1
            m = masks.setdefault(name, np.zeros((h, w), np.uint8))
            m[np.array(png(inst["bytes"]).convert("L")) > 0] = count[name]
        tissue = tissues[row["tissue"]]
        project.import_with_masks(
            image,
            masks,
            sequence_name=f"{tissue.replace(' & ', '-').replace(' ', '_')}",
            classification={"tissue": [tissue]},
        )
    return finish(project)


def registration():
    """COph100: infant fundus photographs of the same eye over several visits,
    with the manual control points as keypoint pairs against the first visit.
    The last eyes are left without pairs, to place them by hand."""
    project = create(
        "fundus_registration.dida", "Fundus registration (COph100)", [("vessels", "#00E5FF")]
    )
    rows = pq.ParquetFile(f"{HF}/coph/data/test-00000-of-00001.parquet").read()
    eyes = {}
    for row in rows.to_pylist():
        eyes.setdefault(row["eye_id"], []).append(row)
    # Eyes seen at three or four visits: enough to compare, short to browse.
    chosen = [e for e in sorted(eyes) if 3 <= len(eyes[e]) <= 4][:8]
    with_pairs = len(chosen) - 2

    def points(row):
        shapes = json.loads(row["control_points"])["shapes"]
        return {s["label"]: s["points"][0] for s in shapes}

    for n, eye in enumerate(chosen):
        visits = sorted(eyes[eye], key=lambda r: r["session"])
        ids = project.import_sequence(
            f"eye_{eye}", [png(r["image"]["bytes"]).convert("RGB") for r in visits]
        )
        if n >= with_pairs:
            continue
        # A control point carries the same number at every visit of an eye.
        reference = points(visits[0])
        for frame_id, visit in zip(ids[1:], visits[1:]):
            moving = points(visit)
            pairs = [
                (*reference[k], *moving[k])
                for k in sorted(reference, key=int)
                if k in moving
            ]
            project.add_registration(ids[0], frame_id, pairs)
    return finish(project)


# --------------------------------------------------------------------------
# Videos
# --------------------------------------------------------------------------


CHOLEC_CLASSES = {
    11: ("Abdominal wall", "#F2C6A0"),
    21: ("Liver", "#B5651D"),
    13: ("Gastrointestinal tract", "#E7469C"),
    12: ("Fat", "#E6D34A"),
    31: ("Grasper", "#00C7BE"),
    23: ("Connective tissue", "#B28DFF"),
    24: ("Blood", "#D00000"),
    25: ("Cystic duct", "#64D2FF"),
    32: ("L-hook electrocautery", "#30D158"),
    22: ("Gallbladder", "#2E8B57"),
    33: ("Hepatic vein", "#5E5CE6"),
    5: ("Liver ligament", "#FFFFFF"),
}
CHOLEC_CLIPS = [
    "video01/video01_00080",
    "video37/video37_00848",
    "video52/video52_00080",
    "video55/video55_00508",
]


def laparoscopy():
    """CholecSeg8k: four 80-frame clips from four procedures."""
    from huggingface_hub import HfFileSystem

    project = create(
        "laparoscopy_video.dida",
        "Laparoscopic cholecystectomy (CholecSeg8k)",
        list(CHOLEC_CLASSES.values()),
    )
    names = open(f"{HF}/cholec_names.txt").read().split("\n")
    with HfFileSystem().open(
        "datasets/minwoosun/CholecSeg8k/data/CholecSeg8k.zip"
    ) as fh:
        archive = zipfile.ZipFile(fh)
        for clip in CHOLEC_CLIPS:
            frames = sorted(
                n for n in names
                if n.startswith(f"CholecSeg8k/{clip}/") and n.endswith("_endo.png")
            )

            def items():
                for frame in frames:
                    image = png(archive.read(frame)).convert("RGB")
                    classes = np.array(
                        png(
                            archive.read(
                                frame.replace("_endo.png", "_endo_watershed_mask.png")
                            )
                        ).convert("L")
                    )
                    masks = {
                        name: classes == value
                        for value, (name, _) in CHOLEC_CLASSES.items()
                        if (classes == value).any()
                    }
                    yield image, masks

            project.import_sequence(clip.split("/")[1], items(), workers=4)
    return finish(project)


def echo():
    """CAMUS sample: two- and four-chamber half cycles of three patients."""
    import hdf5plugin  # noqa: F401  (registers the HDF5 compression filters)
    import h5py

    labels = {
        "LV_endo": ("Left ventricle", "#FF3B30"),
        "LV_myo": ("Myocardium", "#34C759"),
        "LA": ("Left atrium", "#0A84FF"),
    }
    quality = ["Good", "Medium", "Poor"]
    project = create(
        "echocardiography.dida",
        "Echocardiography (CAMUS sample)",
        list(labels.values()),
        {"image quality": quality},
    )
    for path in sorted(glob.glob(f"{HF}/camus/*/*/*.hdf5"), key=os.path.basename):
        with h5py.File(path) as h:
            data = h["tracks/track_0/data"]
            values = data["image/values"][:]  # dB, -60..0
            seg = data["segmentation/values"][:]
            channels = [c.decode() for c in data["segmentation/labels"][:]]
            q = h["metadata/annotations/image_quality"][()].decode()
        frames = np.clip((values + 60.0) / 60.0 * 255.0, 0, 255).astype(np.uint8)
        name = os.path.basename(path).replace("_half_sequence.hdf5", "")
        items = [
            (
                frames[t],
                {
                    labels[c][0]: seg[t, :, :, i]
                    for i, c in enumerate(channels)
                    if c in labels and seg[t, :, :, i].any()
                },
            )
            for t in range(len(frames))
        ]
        ids = project.import_sequence(name, items)
        with project.bulk():
            for frame_id in ids:
                project.add_classification(frame_id, "image quality", [q])
    return finish(project)




def axial(volume, k):
    """Slice `k` of a RAS volume in radiological display: anterior up, patient
    right on the left of the image."""
    return np.ascontiguousarray(volume[::-1, ::-1, k].T)


def brain():
    """BraTS 2023 glioma: 1 mm isotropic brain MRI with three tumour regions.
    Each case is imported twice, as T1 with contrast and as FLAIR, with the
    same masks, so the two can be compared side by side."""
    import nibabel as nib

    regions = {
        1: ("Necrotic core", "#FF3B30"),
        2: ("Edema", "#34C759"),
        3: ("Enhancing tumour", "#FFD60A"),
    }
    project = create(
        "brain_mri_tumour.dida", "Brain MRI: glioma (BraTS 2023)", list(regions.values())
    )
    for case in BRATS_CASES:
        folder = f"{HF}/brats/{BRATS_FOLDER}/{case}"
        classes = np.asarray(
            nib.as_closest_canonical(nib.load(f"{folder}/{case}-seg.nii.gz")).dataobj
        ).astype(np.uint8)
        for kind, scan in BRATS_SCANS.items():
            volume = nib.as_closest_canonical(
                nib.load(f"{folder}/{case}-{kind}.nii.gz")
            ).get_fdata(dtype=np.float32)
            # The scans are skull-stripped: zero is outside the brain.
            low, high = np.percentile(volume[volume > 0], [0.5, 99.5])
            volume = np.clip((volume - low) / (high - low) * 255.0, 0, 255)
            volume = np.where(volume > 0, np.maximum(volume, 1), 0).astype(np.uint8)
            # Keep the slices that show brain; the same range for both scans.
            brain_slices = np.flatnonzero((classes > 0).any((0, 1)) | (volume > 0).any((0, 1)))
            items = []
            for k in range(brain_slices[0], brain_slices[-1] + 1):
                c = axial(classes, k)
                masks = {
                    name: c == value
                    for value, (name, _) in regions.items()
                    if (c == value).any()
                }
                items.append((axial(volume, k), masks))
            project.import_sequence(f"{case.replace('BraTS-GLI-', 'case_')}_{scan}", items)
    return finish(project)


def liver():
    """MSD hepatic vessel: three portal-phase CT volumes as slice sequences."""
    import nibabel as nib

    project = create(
        "liver_ct_vessels.dida",
        "Liver CT: vessels and tumours (MSD)",
        [("Vessel", "#FF3B30"), ("Tumour", "#FFD60A")],
    )
    for path in [f"{HF}/hv/imagesTr/{case}.nii.gz" for case in LIVER_CASES]:
        image = nib.as_closest_canonical(nib.load(path))
        label = nib.as_closest_canonical(
            nib.load(path.replace("imagesTr", "labelsTr"))
        )
        volume = image.get_fdata(dtype=np.float32)
        classes = np.asarray(label.dataobj).astype(np.uint8)
        # Soft-tissue window (level 100 HU, width 400 HU).
        volume = np.clip((volume + 100.0) / 400.0 * 255.0, 0, 255).astype(np.uint8)

        items = []
        for k in range(volume.shape[2]):
            c = axial(classes, k)
            masks = {}
            if (c == 1).any():
                masks["Vessel"] = c == 1
            if (c == 2).any():
                masks["Tumour"] = c == 2
            items.append((axial(volume, k), masks))
        name = os.path.basename(path).replace(".nii.gz", "")
        project.import_sequence(name, items)
        sx, _, sz = image.header.get_zooms()[:3]
        print(f"  {name}: slice spacing {sz / sx:.2f} px")
    return finish(project)


BUILDERS = {
    "fundus": fundus,
    "skin": skin,
    "nuclei": nuclei,
    "registration": registration,
    "laparoscopy": laparoscopy,
    "echo": echo,
    "brain": brain,
    "liver": liver,
}

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(HF, exist_ok=True)
    for key, build in BUILDERS.items():
        if ONLY and key not in ONLY:
            continue
        fetch(key)
        print(key, build())
