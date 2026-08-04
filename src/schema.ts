import { Card, Project, PromptProject, Tag, DeletedHeaderBlock } from './types';
import { DEFAULT_TAGS } from './defaultTags';

/**
 * Canonical definition of the persisted vault shape, plus the pure functions
 * that read, validate, migrate and stamp it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before v1.3.0 the "what does a valid vault look like" rules were written out
 * three separate times — in the store's load effect, in `replaceState`, and in
 * `useLocalBackup.importVaultFromLocal`. They had already drifted: the import
 * path silently dropped `hasOnboarded`, `lastLocalBackupAt` and
 * `lastCloudSyncAt`, and the local export snapshot never wrote them at all.
 * A rule that must never be wrong should exist exactly once. Every entry point
 * into the vault (cold load, cloud pull, file import, legacy migration) now
 * funnels through `readVault` below.
 *
 * EVERYTHING HERE IS PURE.
 * No localforage, no Drive, no React, no `Date.now()` — callers pass `now` in.
 * That makes the migration path readable end to end and reasonable about
 * without running the app, which matters because the app cannot be run in the
 * environment where this code is written.
 */

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * Bumped to 2 in app v1.3.0 (per-record `updatedAt` + conflict detection).
 *
 * Version history:
 *   1 = implicit. Everything shipped up to and including app v1.2.0. Either an
 *       unmarked `appState` object in localforage, or a local export file
 *       carrying the legacy `version: 1` marker.
 *   2 = every record carries `updatedAt`; the envelope carries `schemaVersion`
 *       and `lastMutatedAt` so two devices can tell whose copy is newer.
 */
/**
 * 3 — cloud vaults may carry `vaultimg:` image references instead of inline
 *     base64 (see `imageBlobs.ts`). Local storage and local export files are
 *     unaffected and still hold images inline, so this bump changes nothing
 *     about how a vault is read on this device.
 *
 * The bump exists so an OLDER build that meets a newer cloud file says so.
 * `readVault` already warns rather than refusing when it meets a higher
 * version, which is the right behaviour here: every field such a build
 * understands is still exactly where it expects, and it would recover all the
 * text even if it could not resolve the pictures. Refusing would strand
 * someone holding a backup their other device cannot open.
 */
export const CURRENT_SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * The vault as held in memory and written to localforage.
 * This is the single source of truth for the persisted shape — `store.tsx`
 * aliases its `AppStateData` to this type rather than redeclaring it.
 */
export interface VaultData {
  cards: Card[];
  projects: Project[];
  promptProjects: PromptProject[];
  tags: Tag[];
  deletedHeaderBlocks: DeletedHeaderBlock[];
  theme: string;
  /** Epoch ms of the last successful local (file) backup export. */
  lastLocalBackupAt?: number;
  /** Epoch ms of the last successful push to Google Drive. */
  lastCloudSyncAt?: number;
  /** Whether the first-run explainer has been dismissed. */
  hasOnboarded?: boolean;
  /**
   * The `lastMutatedAt` stamp of the cloud file as of our last successful
   * sync in either direction. Conflict detection compares this against the
   * stamp actually sitting in Drive: if they differ, the cloud changed behind
   * our back and a blind push would destroy those edits.
   */
  lastKnownRemoteStamp?: number;
}

/**
 * What actually gets serialised to Drive and to local export files.
 *
 * Deliberately FLAT rather than `{ meta, data }`. A v1.2.0 build reading a
 * v1.3.0 cloud file still finds `cards`, `projects`, `tags` etc. exactly where
 * it expects them and keeps working — it just ignores the extra keys. Wrapping
 * the payload in an envelope object would have broken every older install the
 * moment one device upgraded. Backward compatibility in this direction is not
 * theoretical: the user side-loads APKs by hand and may run mixed versions.
 */
export interface VaultEnvelope extends VaultData {
  schemaVersion: number;
  /** Max `updatedAt`/`deletedAt` across every record. The sync comparison key. */
  lastMutatedAt: number;
  /** Epoch ms the file was written. Informational only. */
  exportedAt?: number;
}

export interface ReadVaultResult {
  data: VaultData;
  /** Schema version the input was written at, before migration. */
  fromVersion: number;
  /** True when the input needed structural upgrading. */
  migrated: boolean;
  /** The envelope stamp the input carried, if any. */
  remoteStamp?: number;
  /** Non-fatal repairs performed. Surfaced in the debug panel. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Work out which schema a blob was written at.
 * Returns -1 for input that is not a vault at all.
 */
export function detectSchemaVersion(raw: unknown): number {
  if (!isObject(raw)) return -1;

  const explicit = asNumber(raw.schemaVersion);
  if (explicit !== undefined) return explicit;

  // Local export files written by <= v1.2.0 carried a bare `version: 1`.
  const legacyExport = asNumber(raw.version);
  if (legacyExport !== undefined) return legacyExport;

  // An unmarked object with a cards array is a pre-versioning `appState`.
  if (Array.isArray(raw.cards)) return 1;

  return -1;
}

// ---------------------------------------------------------------------------
// Record stamping
// ---------------------------------------------------------------------------

/**
 * Give a record an `updatedAt` if it lacks one.
 *
 * Backfills from `createdAt` rather than `now` on purpose. Using `now` would
 * make every pre-existing record look like it was edited at migration time,
 * which would then beat a genuinely newer copy sitting in the cloud during the
 * very first conflict check after upgrading — the migration itself would cause
 * the data loss it exists to prevent.
 */
function stampRecord<T extends { createdAt?: number; updatedAt?: number }>(
  record: T,
  fallback: number,
): T {
  if (asNumber(record.updatedAt) !== undefined) return record;
  return { ...record, updatedAt: asNumber(record.createdAt) ?? fallback };
}

/**
 * The high-water mark across the whole vault: the newest moment at which any
 * record changed. This single number is what two devices compare.
 */
export function computeLastMutatedAt(data: VaultData): number {
  let max = 0;
  const bump = (n: number | undefined) => {
    if (n !== undefined && n > max) max = n;
  };

  for (const c of data.cards) {
    bump(asNumber(c.updatedAt));
    bump(asNumber(c.createdAt));
    bump(asNumber(c.deletedAt));
  }
  for (const p of data.projects) {
    bump(asNumber(p.updatedAt));
    bump(asNumber(p.createdAt));
    bump(asNumber(p.deletedAt));
  }
  for (const p of data.promptProjects) {
    bump(asNumber(p.updatedAt));
    bump(asNumber(p.createdAt));
    bump(asNumber(p.deletedAt));
  }
  for (const b of data.deletedHeaderBlocks) {
    bump(asNumber(b.deletedAt));
  }

  return max;
}

// ---------------------------------------------------------------------------
// The one true reader
// ---------------------------------------------------------------------------

/**
 * Turn anything that claims to be a vault into a valid `VaultData`, or throw.
 *
 * This is the ONLY sanctioned way to bring outside data in. Cold load from
 * localforage, cloud pull, and file import all call it, so the defensive rules
 * below cannot drift apart again.
 *
 * @param raw   Parsed JSON of unknown provenance.
 * @param now   Injected clock, keeping this function pure and testable.
 * @param opts.treatAsExisting
 *              When true, a vault missing `hasOnboarded` is assumed to belong
 *              to someone who has already used the app, so the first-run
 *              explainer stays hidden. True for cold loads, cloud pulls and
 *              imports — all of which imply pre-existing data.
 */
export function readVault(
  raw: unknown,
  now: number,
  opts: { treatAsExisting?: boolean } = {},
): ReadVaultResult {
  const fromVersion = detectSchemaVersion(raw);
  if (fromVersion === -1 || !isObject(raw)) {
    throw new Error('Not a valid vault: expected an object containing a cards array.');
  }

  const warnings: string[] = [];

  if (!Array.isArray(raw.cards)) {
    warnings.push('No cards array present; treated as an empty vault.');
  }

  // A vault written by a NEWER build than this one. Read it on a best-effort
  // basis rather than refusing: the flat envelope means the fields we know
  // about are still exactly where we expect. Refusing would strand the user
  // holding a cloud file their older device cannot open.
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    warnings.push(
      `Vault was written by a newer app version (schema ${fromVersion}, this build reads ${CURRENT_SCHEMA_VERSION}). ` +
        'Unrecognised fields were preserved as-is where possible.',
    );
  }

  const rawTags = asArray<Tag>(raw.tags);
  if (Array.isArray(raw.tags) && raw.tags.length === 0) {
    // The bug that once wiped every tag permanently. `[]` is truthy, so the
    // original `|| DEFAULT_TAGS` never fired. Treat empty as missing.
    warnings.push('Vault contained zero tags; default tag set restored.');
  }

  const cards = asArray<Card>(raw.cards).map(c => stampRecord(c, now));
  const projects = asArray<Project>(raw.projects).map(p => stampRecord(p, now));
  const promptProjects = asArray<PromptProject>(raw.promptProjects).map(p =>
    stampRecord(p, now),
  );

  const data: VaultData = {
    cards,
    projects,
    promptProjects,
    tags: rawTags.length ? rawTags : DEFAULT_TAGS,
    deletedHeaderBlocks: asArray<DeletedHeaderBlock>(raw.deletedHeaderBlocks),
    theme: typeof raw.theme === 'string' && raw.theme ? raw.theme : 'dark',
    lastLocalBackupAt: asNumber(raw.lastLocalBackupAt),
    lastCloudSyncAt: asNumber(raw.lastCloudSyncAt),
    hasOnboarded:
      typeof raw.hasOnboarded === 'boolean'
        ? raw.hasOnboarded
        : opts.treatAsExisting === true
          ? true
          : false,
    lastKnownRemoteStamp: asNumber(raw.lastKnownRemoteStamp),
  };

  return {
    data,
    fromVersion,
    migrated: fromVersion < CURRENT_SCHEMA_VERSION,
    remoteStamp: asNumber(raw.lastMutatedAt),
    warnings,
  };
}

/**
 * Purge soft-deleted records past the retention window.
 * Split out of the load path so the retention rule is stated once.
 */
export const PURGE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export function purgeExpired(data: VaultData, now: number): VaultData {
  const alive = (deletedAt?: number) =>
    !deletedAt || now - deletedAt < PURGE_AFTER_MS;

  return {
    ...data,
    cards: data.cards.filter(c => alive(c.deletedAt)),
    promptProjects: data.promptProjects.filter(p => alive(p.deletedAt)),
    deletedHeaderBlocks: data.deletedHeaderBlocks.filter(b => alive(b.deletedAt)),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Wrap in-memory state into the flat, versioned envelope written to Drive/disk. */
export function writeVault(data: VaultData, now: number): VaultEnvelope {
  return {
    ...data,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lastMutatedAt: computeLastMutatedAt(data),
    exportedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export type ConflictKind =
  | 'none'
  | 'remote-diverged'
  | 'remote-newer'
  | 'local-newer';

export interface ConflictReport {
  kind: ConflictKind;
  /** Safe to proceed without asking the user. */
  safe: boolean;
  /** One-line explanation intended for display, not logs. */
  message: string;
  localStamp: number;
  remoteStamp?: number;
}

/**
 * Decide whether pushing local state over the cloud copy would destroy edits.
 *
 * The test is NOT "is local newer than remote". Clock skew between a phone and
 * whatever wrote the cloud copy makes raw timestamp comparison unreliable.
 * Instead we ask a question that does not depend on clocks agreeing: is the
 * cloud file still the same one we last synced with? If its stamp moved since
 * we last touched it, something else wrote it and we must not clobber it.
 */
export function detectPushConflict(
  local: VaultData,
  remoteStamp: number | undefined,
): ConflictReport {
  const localStamp = computeLastMutatedAt(local);

  // No cloud file yet — first push, nothing to lose.
  if (remoteStamp === undefined) {
    return {
      kind: 'none',
      safe: true,
      message: 'No existing cloud backup; this will create one.',
      localStamp,
    };
  }

  const known = local.lastKnownRemoteStamp;

  // We have never synced with this cloud file, yet one exists. Could be a
  // reinstall, a second device, or a restored account. Not automatically safe.
  if (known === undefined) {
    return {
      kind: 'remote-diverged',
      safe: false,
      message:
        'A cloud backup already exists that this device has never synced with. ' +
        'Pushing now would replace it.',
      localStamp,
      remoteStamp,
    };
  }

  if (remoteStamp !== known) {
    return {
      kind: 'remote-diverged',
      safe: false,
      message:
        'The cloud backup changed since this device last synced. ' +
        'Pushing now would overwrite those changes.',
      localStamp,
      remoteStamp,
    };
  }

  return {
    kind: 'none',
    safe: true,
    message: 'Cloud backup is unchanged since the last sync.',
    localStamp,
    remoteStamp,
  };
}

/**
 * Decide whether pulling the cloud copy over local state would destroy edits.
 * Restore is a strict overwrite, so any local mutation the cloud has not seen
 * is about to be lost.
 */
export function detectPullConflict(
  local: VaultData,
  remoteStamp: number | undefined,
): ConflictReport {
  const localStamp = computeLastMutatedAt(local);

  if (remoteStamp === undefined) {
    return {
      kind: 'none',
      safe: true,
      message: 'No cloud backup found.',
      localStamp,
    };
  }

  const isEmptyLocal =
    local.cards.length === 0 &&
    local.projects.length === 0 &&
    local.promptProjects.length === 0;

  // Nothing on this device to lose — the common "fresh install, restore my
  // vault" path. Always safe.
  if (isEmptyLocal) {
    return {
      kind: 'none',
      safe: true,
      message: 'This device has no vault data; restoring is safe.',
      localStamp,
      remoteStamp,
    };
  }

  const known = local.lastKnownRemoteStamp;

  // Local has moved on since we last synced: there are unsaved-to-cloud edits.
  if (known === undefined || localStamp > known) {
    return {
      kind: 'local-newer',
      safe: false,
      message:
        'This device has changes that are not in the cloud backup. ' +
        'Restoring would discard them.',
      localStamp,
      remoteStamp,
    };
  }

  return {
    kind: 'remote-newer',
    safe: true,
    message: 'Cloud backup is newer than this device.',
    localStamp,
    remoteStamp,
  };
}
