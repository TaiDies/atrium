export const COVERS: Record<string, string> = {
  sunset: 'linear-gradient(120deg, #ff9a8b 0%, #ff6a88 55%, #ff99ac 100%)',
  ocean: 'linear-gradient(120deg, #2e3192 0%, #1bffff 100%)',
  aurora: 'linear-gradient(120deg, #7c5cff 0%, #2ad4d9 100%)',
  forest: 'linear-gradient(120deg, #134e5e 0%, #71b280 100%)',
  peach: 'linear-gradient(120deg, #ffecd2 0%, #fcb69f 100%)',
  lavender: 'linear-gradient(120deg, #e0c3fc 0%, #8ec5fc 100%)',
  night: 'linear-gradient(120deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  citrus: 'linear-gradient(120deg, #f6d365 0%, #fda085 100%)',
  mint: 'linear-gradient(120deg, #d4fc79 0%, #96e6a1 100%)',
  slate: 'linear-gradient(120deg, #bdc3c7 0%, #2c3e50 100%)',
};

/** Whether a cover is an uploaded or linked picture (otherwise it's one of the gradients above). */
export const isImageCover = (cover: string | null | undefined) => !!cover && (cover.startsWith('/') || /^https?:\/\//i.test(cover));

/** The CSS background for a cover. `mapUrl` rewrites a picture's address (e.g. on a published page). */
export function coverStyle(cover: string | null | undefined, mapUrl?: (url: string) => string): string | undefined {
  if (!cover) return undefined;
  if (isImageCover(cover)) {
    const [url, hash = ''] = cover.split('#');
    const src = `url("${(mapUrl ? mapUrl(url) : url).replace(/"/g, '%22')}")`;
    // "#crop=x,y,w,h" (fractions of the picture): show just that part — used for animated GIFs, which
    // are kept as they are rather than cut, so they keep moving.
    const crop = /crop=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(hash);
    if (crop) {
      const [x, y, w, h] = crop.slice(1).map(Number);
      const px = w < 1 ? (x / (1 - w)) * 100 : 50;
      const py = h < 1 ? (y / (1 - h)) * 100 : 50;
      return `${px.toFixed(2)}% ${py.toFixed(2)}% / ${(100 / w).toFixed(3)}% auto no-repeat ${src}`;
    }
    const y = /y=(\d+)/.exec(hash)?.[1] ?? '50';
    return `center ${Number(y) || 50}% / cover no-repeat ${src}`;
  }
  return COVERS[cover] ?? COVERS.aurora;
}

export function randomCover() {
  const keys = Object.keys(COVERS);
  return keys[Math.floor(Math.random() * keys.length)];
}
