

export class MulticlassTask{

    constructor(public taskName: string, public classLabels: string[], public choice: string = ''){
    }
}

export class MultilabelTask{
    constructor(public taskName: string, public taskLabels: string[], public choices: string[] = []){
    }

    addLabel(label: string){
        this.taskLabels.push(label);
    }

    removeLabel(label: string){
        this.taskLabels = this.taskLabels.filter((l) => l !== label);
    }

}