import { describe, expect, it } from '@effect/vitest';
import { contentParts } from './content-parts';

describe('contentParts', () => {
  it('reads the images, sounds and files a tool returned, beside its text', () => {
    expect(
      contentParts([
        { type: 'text', text: 'Photo of product 42.' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'audio', url: 'https://example.test/note.mp3', mimeType: 'audio/mpeg' },
        {
          type: 'resource',
          resource: { uri: 'file:///scans/sheet.pdf', mimeType: 'application/pdf', blob: 'JVBERi0=' },
        },
        { type: 'resource_link', uri: 'https://example.test/sheet', name: 'Product sheet' },
      ]),
    ).toEqual([
      ['part-0', { kind: 'text', text: 'Photo of product 42.' }],
      ['part-1', { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', name: undefined }],
      ['part-2', { kind: 'audio', src: 'https://example.test/note.mp3', mimeType: 'audio/mpeg', name: undefined }],
      [
        'part-3',
        { kind: 'file', src: 'data:application/pdf;base64,JVBERi0=', mimeType: 'application/pdf', name: 'sheet.pdf' },
      ],
      ['part-4', { kind: 'text', text: '[Product sheet](https://example.test/sheet)' }],
    ]);
  });

  it('leaves results without media, or with unknown blocks, to the JSON view', () => {
    expect(contentParts([{ type: 'text', text: 'only text' }])).toBeUndefined();
    expect(contentParts([{ type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'chart' }])).toBeUndefined();
    expect(contentParts([{ id: '1' }])).toBeUndefined();
    expect(contentParts({ hits: 1 })).toBeUndefined();
  });
});
