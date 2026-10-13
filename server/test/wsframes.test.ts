// Frame-level decoder tests use captured bytes only (re-plan §7.1); they are added once the watch-only capture
// exists. Until then this file checks only that Ivy's own .proto files load, read in place.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSchema } from '../src/wsframes';

const ivyRepo = process.env.IVY_REPO || 'C:\\zixel\\ivyproject';

describe.skipIf(!fs.existsSync(ivyRepo))('loadSchema', () => {
  it("loads IvyPkg and PartPkg from Ivy's .proto files", () => {
    const s = loadSchema(ivyRepo);
    expect(s.IvyPkg.fullName).toBe('.ivyproto.IvyPkg');
    expect(s.PartPkg?.fullName).toBe('.ivypart.PartPkg');
    for (const f of ['header', 'appModelReq', 'appModelRsp', 'appModelNtf', 'queryReq', 'queryRsp', 'pluginReq'])
      expect(s.IvyPkg.fields[f], f).toBeDefined();
  });
});
