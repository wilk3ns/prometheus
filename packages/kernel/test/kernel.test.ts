import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  CanonicalJsonError,
  createUuidV7Generator,
  EU27_ISO2,
  fixedClock,
  isEu27,
  isSha256Hex,
  isUuid,
  sha256Hex,
} from '../src/index.js';

describe('[T1-G1] kernel', () => {
  it('sha256Hex hashes bytes and utf-8 strings identically', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
    expect(isSha256Hex(sha256Hex(''))).toBe(true);
    expect(isSha256Hex('XYZ')).toBe(false);
  });

  it('canonicalJson sorts keys recursively and rejects unstable values', () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: 2 }] })).toBe(
      '{"a":[true,null,{"c":2,"d":"x"}],"b":1}',
    );
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
  });

  it('uuidv7 ids are valid, versioned and strictly increasing within one millisecond', () => {
    const gen = createUuidV7Generator(fixedClock(new Date('2026-11-26T00:00:00Z')));
    const ids = Array.from({ length: 2000 }, () => gen.next());
    for (const id of ids) {
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]?.slice(0, 13)).toBe(
      `${Date.parse('2026-11-26T00:00:00Z').toString(16).padStart(12, '0').slice(0, 8)}-${Date.parse('2026-11-26T00:00:00Z').toString(16).padStart(12, '0').slice(8)}`,
    );
  });

  it('EU27 holds exactly 27 member states', () => {
    expect(new Set(EU27_ISO2).size).toBe(27);
    expect(isEu27('DE')).toBe(true);
    expect(isEu27('AZ')).toBe(false);
    expect(isEu27('TR')).toBe(false);
  });
});
