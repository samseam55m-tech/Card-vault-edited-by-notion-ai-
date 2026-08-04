import localforage from 'localforage';
import { IMAGE_REF_PREFIX, hashFromRef } from './imageBlobs';

/**
 * Remembered pixel aspect ratios for card images, so a card can reserve the
 * right amount of vertical space BEFORE its image has decoded.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * `CardItem` rendered `<img loading="lazy" className="w-full h-auto">`. An
 * `h-auto` image has no height until its bytes are decoded, so every card in
 * the masonry started life at text-only height and grew the moment its picture
 * arrived. That is why the gallery visibly reflows while scrolling: each decode
 * relayouts the column beneath it.
 *
 * WHY THIS IS NOT IN schema.ts / VaultData
 * ----------------------------------------
 * The handover proposed persisting ratios in the vault. Reconnaissance says
 * that is the wrong home, for two concrete reasons:
 *
 *   1. `images: string[]` is read in 17 places across 5 files and is the exact
 *      field that `imageBlobs.ts` rewrites in both directions when it swaps
 *      inline base64 for `vaultimg:` refs during cloud sync. Changing the
 *      element type would ripple through the whole sync pipeline.
 *
 *   2. Far worse: anything written into the vault stamps `updatedAt` and
 *      `lastMutatedAt`, and those stamps ARE the conflict-detection mechanism.
 *      Ratios are discovered lazily as images decode, i.e. while scrolling, so
 *      persisting them into the vault would mark the vault dirty on scroll and
 *      could manufacture spurious "the cloud changed behind you" conflicts.
 *      A cosmetic layout fix must not be able to endanger someone's data.
 *
 * So this is a purely local, disposable cache in its own localforage key. It
 * never enters `VaultData`, needs no schema bump and no migration, is never
 * uploaded, and if it is lost or corrupt the only consequence is that ratios
 * are measured again on next view. Deleting it is always safe.
 *
 * KEYING
 * ------
 * Content-addressed where possible: an externalised image is keyed by the hash
 * already in its `vaultimg:` ref, so the same picture on five cards is measured
 * once. Inline base64 has no hash to hand and hashing megabytes on the render
 * path is not acceptable, so it uses a cheap deterministic fingerprint. A
 * collision would only mean one card briefly reserves the wrong height.
 */

const STORAGE_KEY = 'imageDims';

/** Ratio used until the real one is known. Reserving SOMETHING beats nothing. */
export const FALLBACK_IMAGE_RATIO = 4 / 3;

/** Matches the hash cache in imageBlobs.ts. Roughly 4000 * ~40B, so tiny. */
const MAX_ENTRIES = 4000;

/** Ratios arrive in bursts as a column decodes; coalesce the writes. */
const PERSIST_DEBOUNCE_MS = 800;

type DimsRecord = Record<string, number>;

/** key -> width/height. Insertion-ordered, which gives cheap FIFO eviction. */
const ratios = new Map<string, number>();

let hydrated = false;
let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Stable per-image key. Deliberately synchronous: `getImageRatio` is called
 * during render and must not await anything.
 */
export function imageDimsKey(src: string): string {
  // Deliberately a plain startsWith rather than imageBlobs' `isImageRef`.
  // That helper is declared `(value: unknown) => value is string`, so applying
  // it to a parameter already typed `string` narrows the ELSE branch to `never`
  // and every later `src.length` / `src.slice` stops compiling. A type guard
  // that widens to the type it is guarding is useless on an already-narrow
  // value; don't reintroduce it here.
  if (src.startsWith(IMAGE_REF_PREFIX)) return hashFromRef(src);
  return `len${src.length}:${src.slice(-48)}`;
}

/**
 * Load the cache into memory. Call once, before the first card paints, or the
 * first render of every session reserves fallback heights for no reason.
 * Safe to call repeatedly; only the first call does work.
 */
export async function hydrateImageDims(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = await localforage.getItem<DimsRecord>(STORAGE_KEY);
    if (stored && typeof stored === 'object') {
      Object.keys(stored).forEach(key => {
        const value = stored[key];
        if (typeof value === 'number' && isFinite(value) && value > 0) {
          ratios.set(key, value);
        }
      });
    }
  } catch (e) {
    // A broken cache is not a broken app: fall through with an empty map.
    console.warn('[imageDims] Cache unreadable; ratios will be re-measured.', e);
  }
}

/** Synchronous lookup for the render path. `undefined` = not measured yet. */
export function getImageRatio(src: string | undefined | null): number | undefined {
  if (!src) return undefined;
  return ratios.get(imageDimsKey(src));
}

/**
 * Record a ratio measured from a decoded `<img>`. Returns the stored ratio, or
 * `undefined` if the measurement was unusable (a failed decode reports 0x0).
 */
export function rememberImageRatio(
  src: string | undefined | null,
  width: number,
  height: number,
): number | undefined {
  if (!src || !width || !height) return undefined;
  const ratio = Math.round((width / height) * 1000) / 1000;
  if (!isFinite(ratio) || ratio <= 0) return undefined;

  const key = imageDimsKey(src);
  if (ratios.get(key) === ratio) return ratio;

  ratios.set(key, ratio);
  dirty = true;
  schedulePersist();
  return ratio;
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushImageDims();
  }, PERSIST_DEBOUNCE_MS);
}

/** Write the cache out. Exported so a caller can force a flush if it wants. */
export async function flushImageDims(): Promise<void> {
  if (!dirty) return;
  dirty = false;

  // FIFO eviction. Map preserves insertion order, so the front is the oldest.
  if (ratios.size > MAX_ENTRIES) {
    const keys: string[] = [];
    ratios.forEach((_value, key) => keys.push(key));
    const excess = ratios.size - MAX_ENTRIES;
    for (let i = 0; i < excess; i++) ratios.delete(keys[i]);
  }

  const out: DimsRecord = {};
  ratios.forEach((value, key) => {
    out[key] = value;
  });

  try {
    await localforage.setItem(STORAGE_KEY, out);
  } catch (e) {
    // Losing the cache costs a re-measure, nothing more. Never throw from here.
    console.warn('[imageDims] Cache could not be saved.', e);
  }
}

/** Test/debug aid: how many ratios are currently known. */
export function imageDimsCount(): number {
  return ratios.size;
}
