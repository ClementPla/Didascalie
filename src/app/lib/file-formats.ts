/**
 * The file formats a folder scan can take, as the import toggles show them.
 * Mirrors `IMAGE_EXTENSIONS`, `video::EXTENSIONS` and `MICROSCOPY_EXTENSIONS`
 * on the Rust side.
 */
export interface FileFormat {
  label: string;
  /** Lowercase, without the dot. */
  extensions: string[];
}

export interface FileFormatGroup {
  label: string;
  formats: FileFormat[];
}

export const FILE_FORMAT_GROUPS: readonly FileFormatGroup[] = [
  {
    label: 'Images',
    formats: [
      { label: 'PNG', extensions: ['png'] },
      { label: 'JPEG', extensions: ['jpg', 'jpeg'] },
      { label: 'BMP', extensions: ['bmp'] },
      { label: 'TIFF / OME-TIFF', extensions: ['tif', 'tiff'] },
      { label: 'WebP', extensions: ['webp'] },
    ],
  },
  {
    label: 'Videos',
    formats: [
      { label: 'MP4', extensions: ['mp4', 'm4v'] },
      { label: 'MOV', extensions: ['mov'] },
      { label: 'MKV', extensions: ['mkv'] },
      { label: 'WebM', extensions: ['webm'] },
      { label: 'AVI', extensions: ['avi'] },
    ],
  },
  {
    // Read through Bio-Formats.
    label: 'Microscopy',
    formats: [
      { label: 'Zeiss CZI', extensions: ['czi'] },
      { label: 'Leica LIF', extensions: ['lif'] },
      { label: 'Nikon ND2', extensions: ['nd2'] },
      { label: 'Zeiss LSM', extensions: ['lsm'] },
      { label: 'Zeiss ZVI', extensions: ['zvi'] },
      { label: 'Olympus OIB/OIF', extensions: ['oib', 'oif'] },
      { label: 'Olympus VSI', extensions: ['vsi'] },
      { label: 'Imaris IMS', extensions: ['ims'] },
      { label: 'Whole slide (SVS, NDPI, SCN, BIF)', extensions: ['svs', 'ndpi', 'scn', 'bif'] },
      { label: 'DeltaVision', extensions: ['dv', 'r3d'] },
      { label: 'Gatan DM', extensions: ['dm3', 'dm4'] },
      { label: 'MetaMorph STK', extensions: ['stk'] },
    ],
  },
];

export const FILE_FORMATS: readonly FileFormat[] = FILE_FORMAT_GROUPS.flatMap((g) => g.formats);

/** Every format on: the default. */
export const ALL_EXTENSIONS: string[] = FILE_FORMATS.flatMap((f) => f.extensions);
