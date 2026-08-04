import { Card } from './types';
import { VaultData } from './schema';

/**
 * Image externalisation (recommendation 2b).
 *
 * WHAT THIS IS FOR
 * ----------------
 * Cards store their images as base64 data URLs inside `Card.images`. That is
 * fine locally, but it means the cloud vault is one JSON document containing
 * every image the user has ever added — 16 MB in the user's real vault. Every
 * backup re-serialised and re-uploaded all of it, as a single non-resumable
 * multipart request, which is why a backup took ~30 seconds and why an
 * interrupted one was dangerous.
 *
 * This module rewrites the vault on its way OUT to Drive so that each image
 * lives in its own small Drive file, and rewrites it again on the way back IN.
 *
 * THE DELIBERATE LIMIT: THIS IS A TRANSPORT CONCERN, NOT A STORAGE ONE
 * -------------------------------------------------------------------
 * Local storage keeps images inline, exactly as before. Nothing about the
 * store, the components, or the local export file changes.
 *
 * That is a deliberate boundary, and it is worth defending. `CardItem`,
 * `RecycleBinItem` and `EntryPage` all use `card.images[0]` directly as an
 * `<img src>`. Splitting images locally too would mean every one of those
 * sites has to resolve a reference asynchronously before it can paint, the app
 * would need a blob cache with its own eviction rules, and an offline-first
 * app would suddenly have image slots that can fail to load. All of that risk
 * buys nothing for the reported problem, which is upload size.
 *
 * A local export therefore remains ONE self-contained file that restores
 * completely on its own. Per §2.3 of the handover the delivered artifact is
 * the most trustworthy thing in the system; the same reasoning says the
 * user's own backup file should not become a manifest pointing at Drive.
 *
 * CONTENT ADDRESSING
 * ------------------
 * A blob is named by a hash of its own bytes, so:
 *   - the same image used on five cards uploads once;
 *   - an unchanged image is recognised as already-present and skipped, which
 *     is what turns the second and every later backup into a small upload;
 *   - uploads are idempotent, so a retry after a dropped connection cannot
 *     produce duplicates.
 */

/** Marks an externalised image inside a serialised vault. */
export const IMAGE_REF_PREFIX = 'vaultimg:';

/** Filename prefix for image blobs in the Drive appDataFolder. */
export const IMAGE_BLOB_PREFIX = 'img_';

export function isImageRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(IMAGE_REF_PREFIX);
}

export function imageRefFor(hash: string): string {
  return `${IMAGE_REF_PREFIX}${hash}`;
}

export function hashFromRef(ref: string): string {
  return ref.slice(IMAGE_REF_PREFIX.length);
}

export function blobNameFor(hash: string): string {
  return `${IMAGE_BLOB_PREFIX}${hash}`;
}

export function hashFromBlobName(name: string): string | null {
  if (!name.startsWith(IMAGE_BLOB_PREFIX)) return null;
  const hash = name.slice(IMAGE_BLOB_PREFIX.length);
  return hash.length > 0 ? hash : null;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Non-cryptographic fallback, used only when `crypto.subtle` is unavailable.
 *
 * A Capacitor WebView normally counts as a secure context, so SubtleCrypto
 * should be there. But if it is ever missing, throwing would take the entire
 * backup down — a far worse outcome than a weaker name. This mixes two
 * independent 32-bit accumulators and appends the exact length, which for
 * naming purposes is ample: a collision needs two different images of
 * identical byte length that also collide in both accumulators.
 *
 * Tagged `f` so a fallback-named blob is distinguishable from a SHA-256 one
 * in a file listing, and so the two schemes can never be confused for each
 * other if a device switches between them.
 */
function fallbackHash(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)) >>> 0;
  }
  const a = h1.toString(16).padStart(8, '0');
  const b = h2.toString(16).padStart(8, '0');
  return `f${a}${b}${value.length.toString(16)}`;
}

/** Content hash of one image string. Stable across devices and sessions. */
/**
 * Hashing the same image twice is pure waste, and a 400-image vault hashes
 * every image on every backup. The key is the image string itself, which is
 * already in memory and held by the vault, so the entry costs a pointer.
 */
const hashCache = new Map<string, string>();

/** Loose bound so a long session of image churn cannot grow this forever. */
const HASH_CACHE_LIMIT = 4000;

export async function hashImage(value: string): Promise<string> {
  const cached = hashCache.get(value);
  if (cached !== undefined) return cached;

  const hash = await computeImageHash(value);
  if (hashCache.size >= HASH_CACHE_LIMIT) hashCache.clear();
  hashCache.set(value, hash);
  return hash;
}

async function computeImageHash(value: string): Promise<string> {
  const subtle =
    typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null;

  if (!subtle) return fallbackHash(value);

  try {
    const bytes = new TextEncoder().encode(value);
    const digest = await subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    // 40 hex chars (160 bits) is far more than enough to make an accidental
    // collision impossible in a personal vault, and keeps filenames short.
    return `s${hex.slice(0, 40)}`;
  } catch {
    return fallbackHash(value);
  }
}

// ---------------------------------------------------------------------------
// Dehydrate: inline images -> references + blobs to upload
// ---------------------------------------------------------------------------

export interface DehydratedVault {
  /** The vault with every inline image replaced by a `vaultimg:` reference. */
  vault: VaultData;
  /** hash -> the original image string, for every image the vault references. */
  blobs: Map<string, string>;
}

const usableImage = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/**
 * Replace every inline image with a content-addressed reference.
 *
 * Values that are already references are passed through untouched, so this is
 * safe to run over a vault that came from an interrupted earlier attempt.
 */
export async function dehydrateVaultImages(
  vault: VaultData,
): Promise<DehydratedVault> {
  const blobs = new Map<string, string>();

  const cards: Card[] = [];
  for (const card of vault.cards) {
    if (!Array.isArray(card.images) || card.images.length === 0) {
      cards.push(card);
      continue;
    }

    const images: string[] = [];
    for (const image of card.images) {
      if (!usableImage(image)) continue;
      if (isImageRef(image)) {
        images.push(image);
        continue;
      }
      const hash = await hashImage(image);
      // Keyed by hash, so the same picture on many cards is stored once.
      if (!blobs.has(hash)) blobs.set(hash, image);
      images.push(imageRefFor(hash));
    }

    cards.push({ ...card, images });
  }

  return { vault: { ...vault, cards }, blobs };
}

/** Every image hash a vault refers to. Used to find orphaned blobs. */
// ---------------------------------------------------------------------------
// Transfer helpers
// ---------------------------------------------------------------------------

/**
 * How many image transfers may be in flight at once.
 *
 * The cost of moving 400 small files is almost entirely round-trip latency,
 * not bandwidth, so transferring them one at a time leaves the connection
 * idle for most of the operation. Six is a deliberate middle: enough to hide
 * latency, few enough to stay well clear of Drive's per-user rate limits and
 * to avoid swamping a phone's radio.
 */
export const IMAGE_TRANSFER_CONCURRENCY = 6;

/**
 * Run `worker` over every item, at most `limit` at a time.
 *
 * `next++` needs no lock: JavaScript only switches tasks at an `await`, so
 * each runner reads and increments the cursor atomically with respect to the
 * others.
 */
export async function runPooled<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  const total = items.length;
  let next = 0;
  let completed = 0;

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, total)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= total) return;
        await worker(items[index]);
        completed++;
        onProgress?.(completed, total);
      }
    },
  );

  await Promise.all(runners);
}

/**
 * Index every image already held inline in a vault, as content hash -> image.
 *
 * This is what makes a restore fast. Images are named by their own content,
 * so an image the device already has is byte-identical to the one in the
 * cloud and there is no reason to download it. Restoring onto the device that
 * made the backup therefore fetches almost nothing; only a genuinely new
 * device has to pull the whole library down.
 */
export async function indexVaultImages(
  vault: VaultData,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();

  for (const card of vault.cards) {
    if (!Array.isArray(card.images)) continue;
    for (const image of card.images) {
      if (!usableImage(image) || isImageRef(image)) continue;
      const hash = await hashImage(image);
      if (!index.has(hash)) index.set(hash, image);
    }
  }

  return index;
}

export function collectImageRefs(vault: VaultData): Set<string> {
  const hashes = new Set<string>();
  for (const card of vault.cards) {
    if (!Array.isArray(card.images)) continue;
    for (const image of card.images) {
      if (isImageRef(image)) hashes.add(hashFromRef(image));
    }
  }
  return hashes;
}

/** True if this vault carries any externalised image. */
export function hasImageRefs(vault: VaultData): boolean {
  return collectImageRefs(vault).size > 0;
}

// ---------------------------------------------------------------------------
// Rehydrate: references -> inline images
// ---------------------------------------------------------------------------

export interface RehydratedVault {
  vault: VaultData;
  /** Hashes the vault referenced that could not be resolved. */
  missing: string[];
}

/**
 * Put the real images back.
 *
 * A reference that cannot be resolved is DROPPED from its card rather than
 * left in place or allowed to abort the restore. Three reasons, in order of
 * importance:
 *
 *   1. Everything else about that card — name, summary, tags, every header
 *      block — is intact and is what the user actually came back for. Losing
 *      a restore entirely because one picture is missing would be a far worse
 *      failure than a card with a missing picture.
 *   2. Leaving the raw `vaultimg:...` string in `images` would feed it
 *      straight into an `<img src>`, producing a broken-image icon with no
 *      explanation, and it would then be written back to local storage as if
 *      it were a real image.
 *   3. The caller receives the list of missing hashes and reports it, so the
 *      loss is stated plainly instead of being discovered later.
 */
export function rehydrateVaultImages(
  vault: VaultData,
  resolve: (hash: string) => string | undefined,
): RehydratedVault {
  const missing = new Set<string>();

  const cards = vault.cards.map(card => {
    if (!Array.isArray(card.images) || card.images.length === 0) return card;
    if (!card.images.some(isImageRef)) return card;

    const images: string[] = [];
    for (const image of card.images) {
      if (!usableImage(image)) continue;
      if (!isImageRef(image)) {
        images.push(image);
        continue;
      }
      const hash = hashFromRef(image);
      const resolved = resolve(hash);
      if (resolved === undefined) {
        missing.add(hash);
        continue;
      }
      images.push(resolved);
    }

    return { ...card, images };
  });

  return { vault: { ...vault, cards }, missing: Array.from(missing) };
}
