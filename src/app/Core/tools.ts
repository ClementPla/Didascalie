export class Tool {
  public id: number;
  public name: string;
  public icon: string;
  public shortcut: string | null = null;
  constructor(
    id: number,
    name: string,
    icon: string,
    shortcut: string | null = null
  ) {
    this.id = id;
    this.name = name;
    this.icon = icon;
    this.shortcut = shortcut;
  }
}

export class Tools {
  public static PAN = new Tool(0, 'Pan', 'pi pi-arrows-alt', 'G');
  public static PEN = new Tool(1, 'Pen', 'pi pi-pencil', 'P');
  public static LINE = new Tool(4, 'Line', 'pi pi-minus', 'L');
  public static ERASER = new Tool(8, 'Eraser', 'pi pi-eraser', 'E');
  public static LASSO = new Tool(2, 'Lasso', 'pi pi-cloud', 'Shift + L');
  public static LASSO_ERASER = new Tool(
    3,
    'Lasso Eraser',
    'pi pi-cloud-slash',
    'Shift + Ctrl + E'
  );
  // Vector tools: a different class of tool (SVG shapes, not raster masks).
  // Select: pick / move / duplicate whole paths (object-level, not nodes).
  public static SELECT = new Tool(9, 'Select', 'pi pi-arrow-up-left', 'S');
  public static PATH = new Tool(5, 'Path', 'pi pi-pen-to-square', 'B');
  public static NODE = new Tool(6, 'Node', 'pi pi-share-alt', 'N');
  // Convert tools: click a connected region of pixels to trace it into shapes.
  // Vectorize traces the closed outer contour; Skeletonize traces the centerline.
  public static VECTORIZE = new Tool(7, 'Vectorize', 'pi pi-bullseye', 'V');
  public static SKELETONIZE = new Tool(10, 'Skeletonize', 'pi pi-sitemap', 'K');
}
export const ALL_TOOLS = [
  Tools.PAN,
  Tools.PEN,
  Tools.LINE,
  Tools.ERASER,
  Tools.LASSO,
  Tools.LASSO_ERASER,
];

/** Vector drawing/selection tools, rendered as a distinct toolbar group. */
export const VECTOR_TOOLS = [Tools.SELECT, Tools.PATH, Tools.NODE];

/** Convert tools (raster ↔ vector): click a pixel region to trace it. Paired in
 *  the toolbar with the Rasterize action button. */
export const CONVERT_TOOLS = [Tools.VECTORIZE, Tools.SKELETONIZE];

export enum PostProcessOption {
  MEDSAM = 'MedSAM',
  OTSU = 'Otsu',
  CRF = 'CRF',
  FLOODFILL = 'Flood Fill',
  SUPERPIXEL = 'Superpixel',
}

/** Stable post-processing modes. Experimental ones (CRF, Superpixel, …) are
 *  contributed by `src/app/experimental/registry.ts` and shown only while the
 *  experimental-features switch is on (see FeatureFlagsService). */
export const postProcessingOptions = [
  PostProcessOption.OTSU,
  PostProcessOption.MEDSAM,
  PostProcessOption.FLOODFILL,
];
