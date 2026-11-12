import type { IconName } from '../shared/generics/icon/icon.component';

export class Tool {
  public id: number;
  public name: string;
  public icon: string;
  /** Key combos that select the tool, as matched by `KeyboardShortcutService`:
   *  lowercase, modifiers first in ctrl → shift → alt order (`'ctrl+shift+e'`). */
  public keys: readonly string[];
  /** What the tool does, appended to its toolbar tooltip. */
  public description: string | null = null;
  /** Second icon badged over `icon`. */
  public overlayIcon: string | null = null;
  /** Material Symbols ligature, preferred over `icon` where the toolbar
   *  supports it. The quick-access wheel uses `icon`. */
  public materialIcon: string | null = null;
  /** Line icon from the redesign, preferred over both of the above. */
  public svgIcon: IconName | null = null;
  constructor(
    id: number,
    name: string,
    icon: string,
    keys: readonly string[] = [],
    description: string | null = null,
    overlayIcon: string | null = null,
    materialIcon: string | null = null
  ) {
    this.id = id;
    this.name = name;
    this.icon = icon;
    this.keys = keys;
    this.description = description;
    this.overlayIcon = overlayIcon;
    this.materialIcon = materialIcon;
  }

  /** `keys` for display, e.g. `'Ctrl + Shift + E'`. */
  get shortcut(): string | null {
    if (!this.keys.length) return null;
    return this.keys
      .map((combo) =>
        combo
          .split('+')
          .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
          .join(' + ')
      )
      .join(' / ');
  }
}

export class Tools {
  public static PAN = new Tool(
    0,
    'Pan',
    'pi pi-arrows-alt',
    ['g'],
    'Drag to move around the image. Hold Space for the same thing without switching tool.'
  );
  public static PEN = new Tool(
    1,
    'Pen',
    'pi pi-pencil',
    ['p', '1'],
    'Paint the active label freehand.'
  );
  public static LINE = new Tool(
    4,
    'Line',
    'pi pi-minus',
    ['l'],
    'Paint a straight line between two clicks.'
  );
  public static ERASER = new Tool(
    8,
    'Eraser',
    'pi pi-eraser',
    ['e', '2'],
    'Rub out painted pixels.'
  );
  public static LASSO = new Tool(
    2,
    'Lasso',
    'pi pi-cloud',
    ['shift+l', '3'],
    'Draw a closed outline and fill it with the active label.'
  );
  public static LASSO_ERASER = new Tool(
    3,
    'Lasso Eraser',
    'pi pi-cloud',
    ['ctrl+shift+e', '4'],
    'Draw a closed outline and erase everything inside it.',
    'pi pi-eraser'
  );

  public static SELECT = new Tool(
    9,
    'Select',
    'pi pi-arrow-up-left',
    ['s'],
    null,
    null,
    'ink_selection'
  );
  public static PATH = new Tool(
    5,
    'Draw shape',
    'pi pi-pen-to-square',
    ['b'],
    null,
    null,
    'shape_line'
  );
  public static RECT = new Tool(
    11,
    'Box',
    'pi pi-stop',
    ['r'],
    null,
    null,
    'rectangle'
  );
  public static ELLIPSE = new Tool(
    12,
    'Ellipse',
    'pi pi-circle',
    ['o'],
    null,
    null,
    'circle'
  );
  public static NODE = new Tool(
    6,
    'Edit points',
    'pi pi-share-alt',
    ['n'],
    null,
    null,
    'polyline'
  );

  public static VECTORIZE = new Tool(
    7,
    'Trace outline',
    'pi pi-bullseye',
    ['v'],
    'Click a painted region to turn its border into an editable shape.',
    null,
    'vr180_create2d'
  );
  public static SKELETONIZE = new Tool(
    10,
    'Trace centerline',
    'pi pi-sitemap',
    ['k'],
    'Click a painted region to turn its centerline into an editable line.',
    null,
    'route'
  );
}

// The redesign's line icons.
const SVG_ICONS: [Tool, IconName][] = [
  [Tools.PAN, 'pan'],
  [Tools.LINE, 'line'],
  [Tools.ERASER, 'eraser'],
  [Tools.LASSO, 'lasso'],
  [Tools.LASSO_ERASER, 'lassox'],
  [Tools.SELECT, 'select'],
  [Tools.PATH, 'shape'],
  [Tools.RECT, 'box'],
  [Tools.ELLIPSE, 'ellipse'],
  [Tools.NODE, 'nodes'],
  [Tools.VECTORIZE, 'trace'],
  [Tools.SKELETONIZE, 'center'],
];
for (const [tool, name] of SVG_ICONS) tool.svgIcon = name;

export const RASTER_TOOLS = [
  Tools.PEN,
  Tools.LINE,
  Tools.ERASER,
  Tools.LASSO,
  Tools.LASSO_ERASER,
];

export const VECTOR_TOOLS = [
  Tools.SELECT,
  Tools.PATH,
  Tools.RECT,
  Tools.ELLIPSE,
  Tools.NODE,
];

/** Raster ↔ vector: click a pixel region to trace it. */
export const CONVERT_TOOLS = [Tools.VECTORIZE, Tools.SKELETONIZE];

/** Every tool, for keyboard selection. */
export const ALL_TOOLS: readonly Tool[] = [
  Tools.PAN,
  ...RASTER_TOOLS,
  ...VECTOR_TOOLS,
  ...CONVERT_TOOLS,
];

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
