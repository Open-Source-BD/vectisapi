import { describe, expect, it } from 'vitest';
import { detectBotChallenge } from './botWall';

const r = (over: Partial<{ status: number; headers: Record<string, string>; rawText: string }>) => ({
  status: 200,
  headers: {},
  rawText: '',
  ...over,
});

describe('detectBotChallenge', () => {
  it('detects Cloudflare via the cf-mitigated header', () => {
    expect(detectBotChallenge(r({ status: 403, headers: { 'cf-mitigated': 'challenge' } }))).toEqual({
      vendor: 'Cloudflare',
    });
  });

  it('detects Cloudflare via the interstitial body (Just a moment)', () => {
    const body =
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenges.cloudflare.com cf_chl_opt</body></html>';
    expect(detectBotChallenge(r({ status: 403, rawText: body }))).toEqual({ vendor: 'Cloudflare' });
  });

  it('detects Cloudflare on a 503 challenge', () => {
    expect(detectBotChallenge(r({ status: 503, rawText: 'Enable JavaScript and cookies to continue' }))).toEqual({
      vendor: 'Cloudflare',
    });
  });

  it('detects Akamai interstitials', () => {
    expect(
      detectBotChallenge(r({ status: 403, rawText: 'Pardon Our Interruption... Reference #18.abc123' }))?.vendor,
    ).toBe('Akamai');
  });

  it('detects PerimeterX / HUMAN interstitials', () => {
    expect(
      detectBotChallenge(
        r({
          status: 403,
          rawText: 'Access to this page has been denied because we believe you are using automation tools',
        }),
      )?.vendor,
    ).toBe('PerimeterX');
  });

  it('detects DataDome interstitials', () => {
    expect(
      detectBotChallenge(
        r({ status: 403, rawText: '<script src="https://geo.captcha-delivery.com/captcha/"></script>' }),
      )?.vendor,
    ).toBe('DataDome');
  });

  // --- Regressions: these MUST NOT be flagged as challenges ---

  it('does NOT match a normal 403 JSON from an API', () => {
    expect(
      detectBotChallenge(
        r({
          status: 403,
          headers: { 'content-type': 'application/json' },
          rawText: '{"error":"forbidden","message":"insufficient scope"}',
        }),
      ),
    ).toBeNull();
  });

  it('does NOT match a 403 that merely mentions cloudflare in a non-interstitial body', () => {
    expect(detectBotChallenge(r({ status: 403, rawText: '{"docs":"we use cloudflare as our CDN"}' }))).toBeNull();
  });

  it('does NOT match a normal 200 response (status-gated, no body scan)', () => {
    expect(detectBotChallenge(r({ status: 200, rawText: 'challenges.cloudflare.com Just a moment' }))).toBeNull();
  });

  it('does NOT match a 500 server error', () => {
    expect(detectBotChallenge(r({ status: 500, rawText: 'Internal Server Error' }))).toBeNull();
  });
});
