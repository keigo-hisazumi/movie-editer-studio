// jsdom は canvas を描けない（getContext は null を返すことにして、描かずに進める）
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
