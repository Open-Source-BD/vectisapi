import type { ProxyResult } from './proxyClient';

/**
 * Bot-wall challenge detection. When a target sits behind Cloudflare/Akamai/etc.
 * bot protection, a server-side proxy fetch from a datacenter IP gets an
 * interstitial "are you human / enable JS" page (HTTP 403 or 503) instead of the
 * real response. We detect that so the caller can retry the request browser-direct
 * (from the user's residential IP, like Postman desktop).
 *
 * CRITICAL: signatures match the challenge INTERSTITIAL page, not mere vendor
 * presence. An interstitial means the edge blocked the request before it reached
 * the origin — which is what makes auto-retrying even a POST safe (the origin never
 * processed it). A normal 403 JSON from an API that merely happens to run behind
 * Cloudflare must NOT match.
 */

export interface BotChallenge {
  vendor: string;
}

interface Signature {
  vendor: string;
  /** Header-based signal (keys are lowercased, matching ProxyResult.headers). */
  header?: (h: Record<string, string>) => boolean;
  /** Interstitial body marker. */
  body?: RegExp;
}

const SIGNATURES: Signature[] = [
  {
    vendor: 'Cloudflare',
    header: (h) => (h['cf-mitigated'] ?? '').toLowerCase().includes('challenge'),
    body: /challenges\.cloudflare\.com|cf[_-]chl[_-]opt|window\._cf_chl|<title>\s*Just a moment|Attention Required!\s*\|\s*Cloudflare|Enable JavaScript and cookies to continue/i,
  },
  {
    vendor: 'Akamai',
    // Akamai Bot Manager / "Access Denied" interstitials.
    body: /Pardon Our Interruption|Reference\s*#[0-9a-f]{2}\.[0-9a-f]|err\.fp=akamai|akamai\.net\/errors|Bot Manager/i,
  },
  {
    vendor: 'PerimeterX',
    // PerimeterX / HUMAN press-and-hold captcha interstitial.
    body: /px-captcha|Access to this page has been denied because we believe|perimeterx|\/\/client\.perimeterx\.net|_pxAppId/i,
  },
  {
    vendor: 'DataDome',
    body: /datadome|geo\.captcha-delivery\.com|captcha-delivery\.com|dd_cookie_test|"datadome"/i,
  },
];

/**
 * Returns the challenge vendor when `result` is a bot-wall interstitial, else null.
 * Status-gated first (only 403/503) so normal 2xx responses never pay a body scan.
 */
export function detectBotChallenge(result: Pick<ProxyResult, 'status' | 'headers' | 'rawText'>): BotChallenge | null {
  if (result.status !== 403 && result.status !== 503) return null;

  for (const sig of SIGNATURES) {
    if (sig.header && sig.header(result.headers)) return { vendor: sig.vendor };
    if (sig.body && sig.body.test(result.rawText)) return { vendor: sig.vendor };
  }
  return null;
}
