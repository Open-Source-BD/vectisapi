import { describe, it, expect } from 'vitest';
import { createSseParser } from './parseSse';

describe('createSseParser', () => {
  it('parses a simple event', () => {
    const p = createSseParser();
    expect(p.push('data: hello\n\n')).toEqual([{ event: 'message', data: 'hello', id: undefined, retry: undefined }]);
  });

  it('joins multi-line data and applies event + id', () => {
    const p = createSseParser();
    const evs = p.push('event: chat\nid: 7\ndata: a\ndata: b\n\n');
    expect(evs[0]).toMatchObject({ event: 'chat', data: 'a\nb', id: '7' });
    expect(p.lastId()).toBe('7');
  });

  it('buffers a frame split across chunks', () => {
    const p = createSseParser();
    expect(p.push('data: par')).toEqual([]);
    expect(p.push('tial\n\n')).toEqual([{ event: 'message', data: 'partial', id: undefined, retry: undefined }]);
  });

  it('ignores comments/heartbeats and CRLF, strips one leading space', () => {
    const p = createSseParser();
    expect(p.push(': keep-alive\r\n\r\n')).toEqual([]); // comment + blank, no data → no event
    expect(p.push('data:no-space\r\n\r\n')).toEqual([
      { event: 'message', data: 'no-space', id: undefined, retry: undefined },
    ]);
  });

  it('strips a leading BOM', () => {
    const p = createSseParser();
    expect(p.push('﻿data: x\n\n')[0].data).toBe('x');
  });

  it('captures retry and keeps lastId across events', () => {
    const p = createSseParser();
    p.push('id: 1\ndata: a\n\n');
    const evs = p.push('retry: 3000\ndata: b\n\n');
    expect(evs[0]).toMatchObject({ data: 'b', id: '1', retry: 3000 });
    expect(p.lastId()).toBe('1');
  });
});
