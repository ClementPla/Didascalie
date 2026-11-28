/** Where a sequence stands, as the gallery, navigator and inspector show it. */
export type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

/** Reviewed once every frame is; annotated once any frame is touched. */
export function sequenceStatus(reviewed: number, annotated: number, total: number): SequenceStatus {
  if (total > 0 && reviewed >= total) return 'reviewed';
  if (reviewed > 0 || annotated > 0) return 'annotated';
  return 'empty';
}
