export function personaEditorViewClass(mode: 'preview' | 'source'): string {
  return mode === 'source' ? 'is-source-view' : '';
}
