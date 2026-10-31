import { describe, expect, it } from 'vitest';
import { browserName } from './browser-name';

describe('browserName', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      'Chrome en Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
      'Edge en Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      'Safari en iPhone',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1',
      'Chrome en iPhone',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
      'Safari en macOS',
    ],
    [
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
      'Firefox en Linux',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
      'Samsung Internet en Android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 OPR/126.0.0.0',
      'Opera en Windows',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 16181.61.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      'Chrome en ChromeOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Unknown/1.0',
      'Navegador en Windows',
    ],
  ])('%s → %s', (userAgent, name) => {
    expect(browserName(userAgent)).toBe(name);
  });
  it('knows nothing of an empty or foreign User-Agent', () => {
    expect(browserName(undefined)).toBeNull();
    expect(browserName('')).toBeNull();
    expect(browserName('curl/8.0')).toBeNull();
  });
});
