export class Tool {
  public id: number;
  public name: string;
  public icon: string;
  public shortcut: string | null = null;
  /** One line saying what the tool does, shown in its toolbar tooltip. The
   *  toolbar only prints a tool's name while it is the selected one, so this
   *  is the only place the vector tools explain themselves. */
  public description: string | null = null;
  /** Second icon badged over `icon`, for tools that are a combination of two
   *  others (the lasso eraser is a lasso plus an eraser). */
  public overlayIcon: string | null = null;
  /** Material Symbols ligature name, preferred over `icon` where the toolbar
   *  supports it. PrimeIcons has no good glyph for tracing an outline or a
   *  centerline. `icon` stays set as the fallback, and is what the
   *  quick-access wheel uses — it renders icons as CSS classes only. */
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

  // Vector tools: a different class of tool (SVG shapes, not raster masks).
  public static SELECT = new Tool(
    9,
    'Select',
    'pi pi-arrow-up-left',
    'S',
    'Click a shape to move, duplicate or delete it as a whole.',
    null,
    'ink_selection'
  );
  public static PATH = new Tool(
    5,
    'Draw shape',
    'pi pi-pen-to-square',
    'B',
    'Click to place points and build a new outline or line.',
    null,
    'shape_line'
  );
  public static NODE = new Tool(
    6,
    'Edit points',
    'pi pi-share-alt',
    'N',
    'Drag the individual points of an existing shape.',
    null,
    'polyline'
  );

  // Convert tools: click a connected region of pixels to trace it into shapes.
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

/** Raster (mask) tools. Pan is deliberately not one of them — see NAV_TOOLS. */
export const RASTER_TOOLS = [
  Tools.PEN,
  Tools.LINE,
  Tools.ERASER,
  Tools.LASSO,
  Tools.LASSO_ERASER,
];

/** Navigation. Split out of the raster group so the toolbar's leading segment
 *  keeps its position when tool-specific options appear and disappear. */
export const NAV_TOOLS = [Tools.PAN];

/** Every raster-canvas tool, pan included — what the quick-access wheel offers. */
export const ALL_TOOLS = [...NAV_TOOLS, ...RASTER_TOOLS];

/** Vector drawing/selection tools, rendered as a distinct toolbar group. */
export const VECTOR_TOOLS = [Tools.SELECT, Tools.PATH, Tools.NODE];

/** Convert tools (raster ↔ vector): click a pixel region to trace it. Paired in
 *  the toolbar with the Rasterize action button. */
export const CONVERT_TOOLS = [Tools.VECTORIZE, Tools.SKELETONIZE];

export enum PostProcessOption {
  MEDSAM = 'MedSAM',
  OTSU = 'Otsu',
  FLOODFILL = 'Flood Fill',
  SUPERPIXEL = 'Superpixel',
}

/** Stable post-processing modes, in the order the tool settings panel shows
 *  them. Otsu and Flood Fill come first: both are deterministic, stroke-bounded
 *  operators sharing one set of refinement controls.
 *
 *  Experimental modes (MedSAM, Superpixel, …) are contributed by
 *  `src/app/experimental/registry.ts` and appended only while the
 *  experimental-features switch is on (see FeatureFlagsService). */
export const postProcessingOptions = [
  PostProcessOption.OTSU,
  PostProcessOption.FLOODFILL,
];

/** Modes refined by the shared invert / smooth / connectivity controls. */
export const REFINABLE_POST_PROCESS: readonly PostProcessOption[] = [
  PostProcessOption.OTSU,
  PostProcessOption.FLOODFILL,
];
