export function isSupportedChromeBrowser(): boolean {
  const userAgent = navigator.userAgent.toLowerCase();

  if (userAgent.includes('micromessenger') || !userAgent.includes('chrome')) {
    return false;
  }

  return typeof (navigator as Navigator & { brave?: unknown }).brave !== 'object';
}
