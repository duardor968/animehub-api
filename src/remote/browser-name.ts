// Order matters: Edge, Opera, Samsung and Vivaldi also say Chrome and Safari;
// Chrome also says Safari.
const browsers: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\b(Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];
const systems: [RegExp, string][] = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/** «Chrome en Windows», from the User-Agent; null when neither is known. */
export function browserName(userAgent: string | undefined): string | null {
  const ua = userAgent?.slice(0, 1024) ?? '';
  const browser = browsers.find(([pattern]) => pattern.test(ua))?.[1];
  const system = systems.find(([pattern]) => pattern.test(ua))?.[1];
  if (!browser && !system) return null;
  return system
    ? `${browser ?? 'Navegador'} en ${system}`
    : (browser ?? 'Navegador');
}
