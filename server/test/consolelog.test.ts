import { describe, it, expect } from 'vitest';
import { ConsoleLog, signature } from '../src/consolelog';

describe('signature', () => {
  it('normalizes ids, numbers, hex and query strings', () => {
    expect(signature('Failed id=123 at 0xABC https://x/a.js?v=99 '))
      .toBe(signature('failed id=456 at 0x1f https://x/a.js?v=1'));
  });
});

describe('ConsoleLog', () => {
  it('pre-existing error recurring during feature is "recurring", new one is "fresh"', () => {
    const log = new ConsoleLog();
    log.add('WebSocket reconnect attempt 1');
    const m = log.mark();
    log.add('WebSocket reconnect attempt 2');      // same signature as before the mark
    log.add('TypeError: cannot read extrude of undefined');
    const r = log.since(m);
    expect(r.recurring.map((e) => e.text)).toEqual(['WebSocket reconnect attempt 2']);
    expect(r.fresh.map((e) => e.text)).toEqual(['TypeError: cannot read extrude of undefined']);
  });
  it('nothing after mark → empty', () => {
    const log = new ConsoleLog(); log.add('x');
    expect(log.since(log.mark())).toEqual({ fresh: [], recurring: [] });
  });
});
