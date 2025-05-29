interface DragConfig {
    min: number;
    max: number;
    sensitivity: number;
}

export class DragHandler {
    private static configs: Record<string, DragConfig> = {
        opacity: {
            min: 0,
            max: 100,
            sensitivity: 1
        },
        feather: {
            min: 0,
            max: 10,
            sensitivity: 0.1
        },
        selectionSmooth: {
            min: 0,
            max: 100,
            sensitivity: 1
        },
        selectionContrast: {
            min: 0,
            max: 100,
            sensitivity: 1
        },
        selectionShiftEdge: {
            min: -100,
            max: 100,
            sensitivity: 1
        }
    };

    static calculateNewValue(
        dragTarget: string,
        startValue: number,
        startX: number,
        currentX: number
    ): number {
        const config = this.configs[dragTarget];
        if (!config) return startValue;

        const deltaX = currentX - startX;
        const newValue = startValue + (deltaX * config.sensitivity);
        
        return Math.max(
            config.min,
            Math.min(config.max, Math.round(newValue))
        );
    }
}