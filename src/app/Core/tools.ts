


export class Tool {
    public id: number;
    public name: string;
    public icon: string;
    public shortcut: string | null = null;
    constructor(id: number, name: string, icon: string, shortcut: string | null = null) {
        this.id = id;
        this.name = name;
        this.icon = icon;
        this.shortcut = shortcut;
    }
}


export class Tools {
    public static PAN = new Tool(0, "Pan", "pi pi-arrows-alt", "G");
    public static PEN = new Tool(1, "Pen", "pi pi-pencil", "P");
    public static LINE = new Tool(4, "Line", "pi pi-minus", "L");
    public static ERASER = new Tool(8, "Eraser", "pi pi-eraser", "E");
    public static LASSO = new Tool(2, "Lasso", "pi pi-cloud", "Shift + L");
    public static LASSO_ERASER = new Tool(3, "Lasso Eraser", "pi pi-cloud-slash", "Shift + Ctrl + E");
    public static ALL_TOOLS = [Tools.PAN, Tools.PEN, Tools.LINE, Tools.ERASER, Tools.LASSO, Tools.LASSO_ERASER];
}

export enum PostProcessOption {
    MEDSAM = 'MedSAM',
    OTSU = 'Otsu',
}

export const postProcessingOptions = [PostProcessOption.OTSU, PostProcessOption.MEDSAM];