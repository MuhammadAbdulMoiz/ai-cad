import { describe, it, expect } from 'vitest';
import { isProfileLockError } from '../src/browser';

describe('isProfileLockError', () => {
  it('matches profile-lock messages', () => {
    expect(isProfileLockError('Failed: ProcessSingleton lock held')).toBe(true);
    expect(isProfileLockError('profile is locked by another process')).toBe(true);
    expect(isProfileLockError('user data directory already in use')).toBe(true);
  });
  it('matches the real message from a second concurrent launch', () => {
    expect(isProfileLockError('browserType.launchPersistentContext: Opening in existing browser session. This usually means that the profile is already in use by another instance of Chromium.')).toBe(true);
  });
  it('does not match a spawn failure whose call log lists BlockOriginHeaderModificationOnRedirect', () => {
    const observed = 'browserType.launchPersistentContext: spawn UNKNOWN\nCall log:\n'
      + '  - <launching> chrome.exe --disable-features=Translate,BlockOriginHeaderModificationOnRedirect,PaintHolding --no-sandbox';
    expect(isProfileLockError(observed)).toBe(false);
  });
});
