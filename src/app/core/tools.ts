export class Tool {
  public id: number;
  public name: string;
  public icon: string;
  public shortcut: string | null = null;
  /** What the tool does, appended to its toolbar tooltip. */
  public description: string | null = null;
  /** Second icon badged over `icon`. */
  public overlayIcon: string | null = null;
  /** Material Symbols ligature, preferred over `icon` where the toolbar
   *  supports it. The quick-access wheel uses `icon`. */
  public materialIcon: string | null = null;
  constructor(
    id: number,
    name: string,
    icon: string,
    shortcut: string | null = null,
    description: string | null = null,
    overlayIcon: string | null = null,
    materialIcon: string | null = null
  ) {
    this.id = id;
    this.name = name;
    this.icon = icon;
    this.shortcut = shortcut;
    this.description = description;
    this.overlayIcon = overlayIcon;
    this.materialIcon = materialIcon;
  }
}

export class Tools {
  public static PAN = new Tool(
    0,
    'Pan',
    'pi pi-arrows-alt',
    'G',
    'Drag to move around the image. Hold Space for the same thing without switching tool.'
  );
  public static PEN = new Tool(
    1,
    'Pen',
    'pi pi-pencil',
    'P',
    'Paint the active label freehand.'
  );
  public static LINE = new Tool(
    4,
    'Line',
    'pi pi-minus',
    'L',
    'Paint a straight line between two clicks.'
  );
  public static ERASER = new Tool(
    8,
    'Eraser',
    'pi pi-eraser',
    'E',
    'Rub out painted pixels.'
  );
  public static LASSO = new Tool(
    2,
    'Lasso',
    'pi pi-cloud',
    'Shift + L',
    'Draw a closed outline and fill it with the active label.'
  );
  public static LASSO_ERASER = new Tool(
    3,
    'Lasso Eraser',
    'pi pi-cloud',
    'Shift + Ctrl + E',
    'Draw a closed outline and erase everything inside it.',
    'pi pi-eraser'
  );

  public static SELECT = new Tool(
    9,
    'Select',
    'pi pi-arrow-up-left',
    'S',
    null,
    null,
    'ink_selection'
  );
  public static PATH = new Tool(
    5,
    'Draw shape',
    'pi pi-pen-to-square',
    'B',
    null,
    null,
    'shape_line'
  );
  public static RECT = new Tool(
    11,
    'Box',
    'pi pi-stop',
    'R',
    null,
    null,
    'rectangle'
  );
  public static ELLIPSE = new Tool(
    12,
    'Ellipse',
    'pi pi-circle',
    'O',
    null,
    null,
    'circle'
  );
  public static NODE = new Tool(
    6,
    'Edit points',
    'pi pi-share-alt',
    'N',
    null,
    null,
    'polyline'
  );

  public static VECTORIZE = new Tool(
    7,
    'Trace outline',
    'pi pi-bullseye',
    'V',
    'Click a painted region to turn its border into an editable shape.',
    null,
    'vr180_create2d'
  );
  public static SKELETONIZE = new Tool(
    10,
    'Trace centerline',
    'pi pi-sitemap',
    'K',
    'Click a painted region to turn its centerline into an editable line.',
    null,
    'route'
  );
}

export const RASTER_TOOLS = [
  Tools.PEN,
  Tools.LINE,
  Tools.ERASER,
  Tools.LASSO,
  Tools.LASSO_ERASER,
];

/** Apart from the raster group, so the toolbar's leading segment keeps its
 *  position when tool options appear. */
export const NAV_TOOLS = [Tools.PAN];

export const VECTOR_TOOLS = [
  Tools.SELECT,
  Tools.PATH,
  Tools.RECT,
  Tools.ELLIPSE,
  Tools.NODE,
];

/** Raster ↔ vector: click a pixel region to trace it. */
export const CONVERT_TOOLS = [Tools.VECTORIZE, Tools.SKELETONIZE];

export enum PostProcessOption {
  MEDSAM = 'MedSAM',
  OTSU = 'Otsu',
  FLOODFILL = 'Flood Fill',
  SUPERPIXEL = 'Superpixel',
}

/** Stable post-processing modes, in display order. Experimental ones come
 *  from `src/app/experimental/registry.ts`. */
export const postProcessingOptions = [
  PostProcessOption.OTSU,
  PostProcessOption.FLOODFILL,
];

/** Modes refined by the shared invert / smooth / connectivity controls. */
export const REFINABLE_POST_PROCESS: readonly PostProcessOption[] = [
  PostProcessOption.OTSU,
  PostProcessOption.FLOODFILL,
];
