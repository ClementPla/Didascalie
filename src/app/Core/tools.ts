


export class Tool{
    public id: number;
    public name: string;
    public icon: string;
    constructor(id: number, name: string, icon: string){
        this.id = id;
        this.name = name;
        this.icon = icon;
    }
}


export class Tools {
    public static PAN = new Tool(0, "Pan", "pi pi-arrows-alt");
    public static PEN = new Tool(1, "Pen", "pi pi-pencil");
    public static ERASER = new Tool(8, "Eraser", "pi pi-eraser");
    public static LASSO = new Tool(2, "Lasso", "pi pi-cloud");
    public static LASSO_ERASER = new Tool(3, "Lasso Eraser", "pi pi-cloud-slash");
    public static ALL_TOOLS = [Tools.PAN, Tools.PEN, Tools.ERASER, Tools.LASSO, Tools.LASSO_ERASER];
}

export enum PostProcessOption{
    MEDSAM = 'MedSAM',
    OTSU = 'Otsu',
    CRF = 'CRF',
  }

export const postProcessingOptions = [PostProcessOption.OTSU, PostProcessOption.MEDSAM, PostProcessOption.CRF];