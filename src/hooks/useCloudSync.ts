import { useCallback, useRef, useState } from 'react';
import localforage from 'localforage';
import { useGoogleDrive } from './useGoogleDrive';
import { useStore } from '../store';
import {
  VaultData,
  ConflictReport,
  readVault,
  writeVault,
  detectPushConflict,
  detectPullConflict,
  computeLastMutatedAt,
} from '../schema';
import {
  IMAGE_TRANSFER_CONCURRENCY,
  collectImageRefs,
  dehydrateVaultImages,
  indexVaultImages,
  rehydrateVaultImages,
  runPooled,
} from '../imageBlobs';

/**
 * Thin orchestration layer that connects the local `localforage` store
 * (keyed as `'appState'`) with the Google Drive `appDataFolder` via
 * `useGoogleDrive`.
 *
 * WHAT CHANGED IN v1.3.0
 * ----------------------
 * Both directions used to be unconditional overwrites. `pullFromCloud` replaced
 * local data without comparing anything, and `pushToCloud` PATCHed Drive
 * without ever reading what was already there. On a single device that is
 * merely crude; the moment the same account exists on two installs, whichever
 * one syncs last silently destroys the other's work.
 *
 * Both directions now consult `schema`'s conflict detection first and refuse to
 * proceed when they cannot prove the operation is non-destructive. Refusal is
 * not failure: the caller receives a `ConflictReport` describing exactly what
 * would be lost, and may re-issue the same call with `{ force: true }` once the
 * user has decided. The decision belongs to the user, not to this layer.
 */

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error' | 'conflict';

export interface SyncOutcome<T = void> {
  /** True when the operation completed and data was written. */
  ok: boolean;
  /**
   * Present when the operation was refused as unsafe. Show `conflict.message`
   * and offer to retry with `{ force: true }`.
   */
  conflict?: ConflictReport;
  /** Present on a successful pull: the normalised vault to hand to replaceState. */
  data?: T;
  /** Present when the operation failed outright. */
  error?: string;
  /**
   * Non-fatal notes about an operation that otherwise succeeded — for example
   * images the cloud could not supply. Never silently discarded: the caller is
   * expected to show these.
   */
  warnings?: string[];
}

export interface SyncOptions {
  /** Proceed even though conflict detection flagged the operation as unsafe. */
  force?: boolean;
}

export function useCloudSync() {
  const drive = useGoogleDrive();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  /**
   * Human-readable description of the current step, or null when idle.
   *
   * Splitting images turns one long request into many short ones. That is a
   * large improvement, but it also means a first backup is a sequence the user
   * can no longer interpret from a single spinner. Saying "Uploading image 12
   * of 240" is the difference between waiting and force-quitting.
   */
  const [syncProgress, setSyncProgress] = useState<string | null>(null);

  const store = useStore();

  // Refs, not dependencies. The store hands back fresh function identities on
  // every render; depending on them directly would give `pushToCloud` a new
  // identity each render, and AccountMenu's auto-backup effect lists it in its
  // dependency array. Refs keep the callbacks current without destabilising
  // this hook's exported API.
  const markCloudSyncRef = useRef(store.markCloudSync);
  markCloudSyncRef.current = store.markCloudSync;

  const setKnownRemoteStampRef = useRef(store.setKnownRemoteStamp);
  setKnownRemoteStampRef.current = store.setKnownRemoteStamp;

  /**
   * A live snapshot of the in-memory vault.
   *
   * Reading the vault from React state rather than from localforage also fixes
   * a real bug: writes to localforage are debounced by 500ms, so a push issued
   * shortly after an edit used to upload the PREVIOUS version of the vault and
   * then mark the sync as successful. The most recent edit was silently absent
   * from the backup, and nothing indicated it.
   */
  const vaultRef = useRef<VaultData>({
    cards: store.cards,
    projects: store.projects,
    promptProjects: store.promptProjects,
    tags: store.tags,
    deletedHeaderBlocks: store.deletedHeaderBlocks,
    theme: store.theme,
    lastLocalBackupAt: store.lastLocalBackupAt,
    lastCloudSyncAt: store.lastCloudSyncAt,
    hasOnboarded: store.hasOnboarded,
    lastKnownRemoteStamp: store.lastKnownRemoteStamp,
  });
  vaultRef.current = {
    cards: store.cards,
    projects: store.projects,
    promptProjects: store.promptProjects,
    tags: store.tags,
    deletedHeaderBlocks: store.deletedHeaderBlocks,
    theme: store.theme,
    lastLocalBackupAt: store.lastLocalBackupAt,
    lastCloudSyncAt: store.lastCloudSyncAt,
    hasOnboarded: store.hasOnboarded,
    lastKnownRemoteStamp: store.lastKnownRemoteStamp,
  };

  // -----------------------------------------------------------------------
  // Inspect the cloud copy without downloading it
  // -----------------------------------------------------------------------

  /**
   * Ask what a push would do, without doing it. Lets the UI warn before the
   * user commits to anything.
   */
  const inspectPush = useCallback(async (): Promise<ConflictReport> => {
    const local = vaultRef.current;
    const meta = await drive.findVaultMeta();

    if (meta && meta.stamp === undefined) {
      // A cloud file exists but predates stamping (written by v1.2.0 or
      // earlier), so there is no way to tell whether it holds edits this
      // device has never seen. Unknown is treated as unsafe rather than as
      // safe — the entire point of this change is to stop guessing. The user
      // sees this once; after the first push the file carries a stamp.
      return {
        kind: 'remote-diverged',
        safe: false,
        message:
          'The existing cloud backup was made by an older version of the app, so it cannot be compared with this device. ' +
          'Pushing will replace it.',
        localStamp: computeLastMutatedAt(local),
      };
    }

    return detectPushConflict(local, meta?.stamp);
  }, [drive]);

  // -----------------------------------------------------------------------
  // Push local state -> Google Drive
  // -----------------------------------------------------------------------
  const pushToCloud = useCallback(
    async (options: SyncOptions = {}): Promise<SyncOutcome> => {
      setSyncStatus('syncing');
      try {
        const local = vaultRef.current;

        const report = await inspectPush();
        if (!report.safe && !options.force) {
          setSyncStatus('conflict');
          return { ok: false, conflict: report };
        }

        // -------------------------------------------------------------
        // Image externalisation (rec 2b)
        //
        // THE ORDER OF THE NEXT THREE STEPS IS THE ENTIRE SAFETY ARGUMENT.
        //
        // Blobs go up FIRST; the vault JSON goes up LAST. The vault file is
        // the only thing that names blobs, so it is the commit point: until
        // it is replaced, the cloud still describes the previous backup, and
        // every blob that backup names is still present because we only ever
        // add blobs before the commit and only ever remove them after it.
        //
        // So an interrupted backup — dead battery, lost signal, force-quit —
        // leaves the cloud holding the last complete backup plus some unused
        // files. It cannot leave a vault pointing at an image that was never
        // uploaded. Writing the vault first would create exactly that, and it
        // would not be detectable until a restore months later.
        // -------------------------------------------------------------
        setSyncProgress('Preparing images…');
        const { vault: dehydrated, blobs } = await dehydrateVaultImages(local);

        const existing = await drive.listImageBlobs();
        const pending = Array.from(blobs.entries()).filter(
          ([hash]) => !existing.has(hash),
        );

        // This filter is what fixes the 30-second backup. Images are named by
        // their own content, so anything already in Drive is skipped: after
        // the first run, a backup uploads only what actually changed.
        //
        // Uploaded in parallel. One at a time left the connection idle waiting
        // out a round trip for each of 71 small files, which is where the two
        // minutes went — the cost was latency, not bandwidth.
        if (pending.length > 0) {
          setSyncProgress(`Uploading image 1 of ${pending.length}…`);
          await runPooled(
            pending,
            IMAGE_TRANSFER_CONCURRENCY,
            async ([hash, contents]) => {
              await drive.uploadImageBlob(hash, contents);
            },
            (done, total) =>
              setSyncProgress(`Uploading image ${done} of ${total}…`),
          );
        }

        setSyncProgress('Saving vault…');
        const envelope = writeVault(dehydrated, Date.now());
        const stamp = envelope.lastMutatedAt;

        await drive.uploadVaultData(JSON.stringify(envelope), stamp);

        // Record what we just wrote as the cloud state we know about. Without
        // this the very next push would see a stamp it does not recognise and
        // flag a conflict against our own upload.
        await markCloudSyncRef.current();
        await setKnownRemoteStampRef.current(stamp);

        // Sweep unreferenced blobs — AFTER the commit, never before.
        //
        // Deleting a card, or replacing its picture, leaves the old blob
        // behind; without this the appDataFolder would grow forever and the
        // storage this change was meant to save would never be given back.
        //
        // Best-effort on purpose. The backup is already complete and safe at
        // this point, so a failure to tidy up must not be reported as a failed
        // backup. Leftover files are harmless and the next push retries them.
        const referenced = collectImageRefs(dehydrated);
        const orphans = Array.from(existing.entries()).filter(
          ([hash]) => !referenced.has(hash),
        );
        if (orphans.length > 0) {
          setSyncProgress('Tidying up…');
          await runPooled(orphans, IMAGE_TRANSFER_CONCURRENCY, async ([, fileId]) => {
            try {
              await drive.deleteFileById(fileId);
            } catch (sweepErr: unknown) {
              console.warn(
                '[CloudSync] could not remove an unused image:',
                sweepErr,
              );
            }
          });
        }

        setSyncStatus('success');
        setSyncProgress(null);
        return { ok: true, conflict: report };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        console.error('[CloudSync] pushToCloud failed:', msg);
        setSyncStatus('error');
        setSyncProgress(null);
        return { ok: false, error: msg };
      }
    },
    [drive, inspectPush],
  );

  // -----------------------------------------------------------------------
  // Pull Google Drive -> local (still an overwrite, but no longer a blind one)
  // -----------------------------------------------------------------------
  const pullFromCloud = useCallback(
    async (options: SyncOptions = {}): Promise<SyncOutcome<VaultData>> => {
      setSyncStatus('syncing');
      setSyncProgress('Checking cloud backup…');
      try {
        const json = await drive.downloadVaultData();
        if (!json) {
          setSyncStatus('success');
          return { ok: false, error: 'No cloud backup found.' };
        }

        // Parse and validate BEFORE touching local storage. The old code wrote
        // whatever came back straight into localforage, so a truncated or
        // corrupt download overwrote a perfectly good local vault with rubbish.
        let parsed: VaultData;
        let remoteStamp: number | undefined;
        try {
          const result = readVault(JSON.parse(json), Date.now(), {
            treatAsExisting: true,
          });
          parsed = result.data;
          remoteStamp = result.remoteStamp ?? computeLastMutatedAt(result.data);
        } catch (parseErr: unknown) {
          const msg =
            parseErr instanceof Error ? parseErr.message : String(parseErr);
          console.error('[CloudSync] cloud backup is unreadable:', msg);
          setSyncStatus('error');
          return {
            ok: false,
            error: `The cloud backup could not be read, so nothing on this device was changed. (${msg})`,
          };
        }

        // Ask permission BEFORE fetching images. The conflict gate can refuse
        // this restore, and on a large vault the image fetch is the expensive
        // part; downloading a few hundred files only to throw them away would
        // burn the user's mobile data for a restore that never happened.
        const report = detectPullConflict(vaultRef.current, remoteStamp);
        if (!report.safe && !options.force) {
          setSyncStatus('conflict');
          setSyncProgress(null);
          return { ok: false, conflict: report };
        }

        // -------------------------------------------------------------
        // Put externalised images back (rec 2b).
        //
        // Skipped entirely for a vault written before this version, whose
        // images are still inline — `collectImageRefs` simply finds nothing.
        // Old cloud backups therefore keep restoring exactly as they did.
        // -------------------------------------------------------------
        let hydrated = parsed;
        const warnings: string[] = [];
        const needed = Array.from(collectImageRefs(parsed));

        if (needed.length > 0) {
          const contents = new Map<string, string>();

          // -----------------------------------------------------------
          // Use everything the device already has before asking the network
          // for anything.
          //
          // Images are named by their own content, so a hash the device can
          // already produce locally IS the image in the cloud, byte for byte.
          // Downloading it again is pure waste. Restoring onto the device
          // that made the backup — the common case by a wide margin — now
          // transfers no images at all; only a genuinely new device pays the
          // full download.
          // -----------------------------------------------------------
          setSyncProgress('Checking images on this device…');
          const localIndex = await indexVaultImages(vaultRef.current);

          const toFetch: string[] = [];
          for (const hash of needed) {
            const onDevice = localIndex.get(hash);
            if (onDevice !== undefined) contents.set(hash, onDevice);
            else toFetch.push(hash);
          }

          if (toFetch.length > 0) {
            setSyncProgress('Finding images…');
            const available = await drive.listImageBlobs();
            const downloadable = toFetch.filter(hash => available.has(hash));

            if (downloadable.length > 0) {
              setSyncProgress(`Fetching image 1 of ${downloadable.length}…`);
              await runPooled(
                downloadable,
                IMAGE_TRANSFER_CONCURRENCY,
                async hash => {
                  try {
                    const fileId = available.get(hash) as string;
                    contents.set(hash, await drive.downloadImageBlob(fileId));
                  } catch (imgErr: unknown) {
                    // One unreachable image must not cost the user the whole
                    // restore. Record it and carry on; the count is reported
                    // below.
                    console.warn('[CloudSync] image could not be downloaded:', hash, imgErr);
                  }
                },
                (done, total) =>
                  setSyncProgress(`Fetching image ${done} of ${total}…`),
              );
            }
          }

          const result = rehydrateVaultImages(parsed, h => contents.get(h));
          hydrated = result.vault;

          if (result.missing.length > 0) {
            warnings.push(
              result.missing.length === 1
                ? '1 image could not be recovered from the cloud backup and was left out. Everything else was restored.'
                : `${result.missing.length} images could not be recovered from the cloud backup and were left out. Everything else was restored.`,
            );
          }
        }

        setSyncProgress('Applying backup…');
        await localforage.setItem('appState', hydrated);
        await setKnownRemoteStampRef.current(remoteStamp);

        setSyncStatus('success');
        setSyncProgress(null);
        return { ok: true, data: hydrated, conflict: report, warnings };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        console.error('[CloudSync] pullFromCloud failed:', msg);
        setSyncStatus('error');
        setSyncProgress(null);
        return { ok: false, error: msg };
      }
    },
    [drive],
  );

  // -----------------------------------------------------------------------
  // Delete vault data from Google Drive
  // -----------------------------------------------------------------------
  const deleteCloudData = useCallback(async (): Promise<SyncOutcome> => {
    setSyncStatus('syncing');
    setSyncProgress('Deleting cloud backup…');
    try {
      // The vault file goes first, so that if image deletion is interrupted
      // nothing is left pointing at files that are already gone.
      await drive.deleteVaultData();

      // Images are separate files now, so deleting the vault alone would
      // leave the user's pictures — the overwhelming majority of the bytes —
      // sitting in Drive after they asked for their cloud data to be removed.
      // "Delete my cloud backup" has to mean all of it.
      const blobs = await drive.listImageBlobs();
      const ids = Array.from(blobs.values());
      let failed = 0;
      if (ids.length > 0) {
        setSyncProgress(`Deleting image 1 of ${ids.length}…`);
        await runPooled(
          ids,
          IMAGE_TRANSFER_CONCURRENCY,
          async id => {
            try {
              await drive.deleteFileById(id);
            } catch (delErr: unknown) {
              failed++;
              console.warn('[CloudSync] could not delete an image:', delErr);
            }
          },
          (done, total) =>
            setSyncProgress(`Deleting image ${done} of ${total}…`),
        );
      }

      setSyncStatus('success');
      setSyncProgress(null);
      return {
        ok: true,
        warnings:
          failed > 0
            ? [
                `${failed} image ${failed === 1 ? 'file' : 'files'} could not be deleted from Drive. Try again to remove the rest.`,
              ]
            : undefined,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err);
      console.error('[CloudSync] deleteCloudData failed:', msg);
      setSyncStatus('error');
      setSyncProgress(null);
      return { ok: false, error: msg };
    }
  }, [drive]);

  // -----------------------------------------------------------------------
  // Sign out: clear Google auth + wipe local data
  // The caller MUST also call clearState() on the store to reset React
  // context, preventing Account A's data from bleeding into Account B.
  // -----------------------------------------------------------------------
  const signOutAndWipe = useCallback(async () => {
    await drive.signOut();
    // Wipe localforage so no data remains for the next account
    await localforage.removeItem('appState');
  }, [drive]);

  return {
    /** Re-exported from useGoogleDrive for convenience */
    user: drive.user,
    loading: drive.loading,
    error: drive.error,
    restoring: drive.restoring,
    signIn: drive.signIn,

    /** Sign out + wipe local data (replaces plain signOut) */
    signOutAndWipe,

    /** Sync-specific */
    syncStatus,
    /** Current step description while syncing, or null. */
    syncProgress,
    pushToCloud,
    pullFromCloud,
    deleteCloudData,
    /** Preview what a push would do, without performing it. */
    inspectPush,
  };
}
