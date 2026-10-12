import { describe, it, expect } from 'vitest';
import { ConsoleLog, signature } from '../src/consolelog';

describe('signature', () => {
  it('normalizes ids, numbers, hex and query strings', () => {
    expect(signature('Failed id=123 at 0xABC https://x/a.js?v=99 '))
      .toBe(signature('failed id=456 at 0x1f https://x/a.js?v=1'));
  });
  it('keeps distinct optional-chain errors distinct', () => {
    expect(signature('TypeError: a?.b is undefined'))
      .not.toBe(signature('TypeError: a?.c is undefined'));
  });
  it('keeps distinct identifiers with digits distinct', () => {
    expect(signature('Vector3 bad')).not.toBe(signature('Vector2 bad'));
    expect(signature('ParmLength.ZH_CN13')).not.toBe(signature('ParmLength.ZH_CN14'));
  });
  it('collapses standalone numbers', () => {
    expect(signature('Failed id=5')).toBe(signature('Failed id=6'));
  });
  it('replaces uuids with #', () => {
    expect(signature('req 123e4567-e89b-12d3-a456-426614174000 failed'))
      .toBe('req # failed');
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
  it('optional-chain error after mark is fresh even if a sibling error was seen', () => {
    const log = new ConsoleLog();
    log.add('TypeError: a?.b is undefined');
    const m = log.mark();
    log.add('TypeError: a?.c is undefined');
    const r = log.since(m);
    expect(r.fresh.map((e) => e.text)).toEqual(['TypeError: a?.c is undefined']);
    expect(r.recurring).toEqual([]);
  });
  it('nothing after mark → empty', () => {
    const log = new ConsoleLog(); log.add('x');
    expect(log.since(log.mark())).toEqual({ fresh: [], recurring: [] });
  });
});
