/** `n noun`, with an `s` unless n is 1. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The text of a rejection. Tauri rejects with the backend's message as a
 *  plain string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
