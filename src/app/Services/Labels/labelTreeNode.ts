import { TreeNode } from "primeng/api";
import { SegLabel } from "../../Core/interface";


export function constructLabelTreeNode(labels: SegLabel[]): TreeNode[] {
    const tree: TreeNode[] = [];
    const nodeMap = new Map<string, TreeNode>();

    labels.forEach(label => {
        const parts = label.label.split('/');
        let fullPath = '';

        parts.forEach((part, index) => {
            fullPath += (fullPath ? '/' : '') + part;
            
            if (!nodeMap.has(fullPath)) {
                const newNode: TreeNode = { 
                    label: part, 
                    children: [],
                    expanded: true,
                    ...(index === parts.length - 1 && { data: label })
                };
                nodeMap.set(fullPath, newNode);

                // Find or create parent
                if (index > 0) {
                    const parentPath = parts.slice(0, index).join('/');
                    const parentNode = nodeMap.get(parentPath);
                    if (parentNode) {
                        parentNode.children!.push(newNode);
                    } else {
                        tree.push(newNode);
                    }
                } else {
                    tree.push(newNode);
                }
            }
        });
    });

    return tree;
}


