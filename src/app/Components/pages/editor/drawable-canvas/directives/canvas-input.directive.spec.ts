import { CanvasInputDirective } from './canvas-input.directive';

describe('CanvasInputDirective', () => {
  it('should create an instance', () => {
    // Smoke test only; the directive's service deps aren't exercised here.
    const stub = {} as never;
    const directive = new CanvasInputDirective(stub, stub, stub, stub, stub);
    expect(directive).toBeTruthy();
  });
});
