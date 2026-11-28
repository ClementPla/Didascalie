import { jsonEqual } from './equal';

describe('jsonEqual', () => {
  it('compares nested arrays and objects by value', () => {
    expect(jsonEqual({ a: [1, 2], b: { c: 'x' } }, { b: { c: 'x' }, a: [1, 2] })).toBeTrue();
    expect(jsonEqual({ a: [1, 2] }, { a: [1, 3] })).toBeFalse();
    expect(jsonEqual([{ a: 1 }], [{ a: 1, b: 2 }])).toBeFalse();
    expect(jsonEqual([], {})).toBeFalse();
    expect(jsonEqual(null, {})).toBeFalse();
  });

  it('treats undefined keys as absent, like JSON', () => {
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBeTrue();
  });
});
