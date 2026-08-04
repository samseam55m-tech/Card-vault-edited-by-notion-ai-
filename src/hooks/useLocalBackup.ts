import React, { useCallback, useState } from 'react';
import localforage from 'localforage';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useStore } from '../store';
import { VaultData, readVault, writeVault } from '../schema';

/**
 * Local (file-based) backup hook. Exports the current vault state as a
 * JSON file using native Capacitor plugins, and imports a previously
 * exported file back into the app, overwriting local data.
 *
 * Export pipeline:
 *   1. Stringify the React Context snapshot.
 *   2. Filesystem.writeFile -> writes natively to Directory.Cache.
 *      (Cache dir bypasses Android 11+ scoped-storage permission issues.)
 *   3. Share.share() -> opens the native Android share sheet so the user
 *      can pick "Save to device", "Save to Files", Drive, etc.
 *
 * Import pipeline (unchanged): file picker -> FileReader -> JSON.parse ->
 * strict overwrite of localforage + React context.
 */

export type LocalBackupStatus = 'idle' | 'exporting' | 'importing' | 'success' | 'error';

const EXPORT_FILENAME = 'roleplay_vault_backup.json';

export function useLocalBackup() {
  const store = useStore();
  const [status, setStatus] = useState<LocalBackupStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  /** Non-fatal notes from the last import (e.g. "tags were missing, defaults restored"). */
  const [lastWarnings, setLastWarnings] = useState<string[]>([]);

  // -----------------------------------------------------------------------
  // Export: native write via Capacitor Filesystem + Share sheet
  // -----------------------------------------------------------------------
  const exportVaultToLocal = useCallback(async () => {
    setStatus('exporting');
    setLastError(null);
    try {
      // Built by the same function that writes the cloud file, so a local
      // export and a cloud backup are byte-for-byte the same format and either
      // can be restored from either place.
      //
      // The hand-rolled snapshot this replaces silently omitted
      // `lastLocalBackupAt`, `lastCloudSyncAt` and `hasOnboarded`. Restoring
      // from such a file therefore reset the user's backup-freshness history
      // and, on a clean install, re-triggered the first-run explainer.
      const vault: VaultData = {
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

      const json = JSON.stringify(writeVault(vault, Date.now()), null, 2);

      // Write to the app's cache directory. This avoids Android 11+
      // scoped-storage permission prompts entirely.
      const writeResult = await Filesystem.writeFile({
        path: EXPORT_FILENAME,
        data: json,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });

      // Hand the native file URI to the OS share sheet so the user can
      // pick where to save it (Files app, Drive, email, etc.).
      await Share.share({
        title: 'Export Roleplay Vault',
        url: writeResult.uri,
        dialogTitle: 'Save Vault Backup',
      });

      // Record the successful export so the account panel can show backup
      // freshness ("Last backed up 3 hours ago").
      await store.markLocalBackup();

      setStatus('success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[LocalBackup] export failed:', msg);
      setLastError(msg);
      setStatus('error');
    }
  }, [store]);

  // -----------------------------------------------------------------------
  // Import: read a user-selected File, JSON.parse it, STRICTLY OVERWRITE
  // both localforage and the React context (same behaviour as cloud
  // restoreVaultData).
  // -----------------------------------------------------------------------
  const importVaultFromLocal = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset the input so selecting the same file twice still triggers onChange
      event.target.value = '';

      if (!file) return;

      setStatus('importing');
      setLastError(null);
      setLastWarnings([]);

      try {
        const text = await readFileAsText(file);

        // Validation, version detection, migration and the empty-tags fallback
        // all live in `readVault` now. This function used to re-implement them
        // by hand and had already drifted from the store's copy of the same
        // rules — which is precisely how the import path ended up discarding
        // fields the store took care to preserve.
        const result = readVault(JSON.parse(text), Date.now(), {
          treatAsExisting: true,
        });

        const newState: VaultData = {
          ...result.data,
          // Backup-freshness history belongs to this device, not to the file.
          lastLocalBackupAt: result.data.lastLocalBackupAt ?? store.lastLocalBackupAt,
          lastCloudSyncAt: result.data.lastCloudSyncAt ?? store.lastCloudSyncAt,
          lastKnownRemoteStamp:
            result.data.lastKnownRemoteStamp ?? store.lastKnownRemoteStamp,
          hasOnboarded: true,
        };

        // Strict overwrite – same pattern as cloud restore
        await localforage.setItem('appState', newState);
        if (!store.replaceState(newState)) {
          throw new Error('The backup file could not be applied to the app state.');
        }

        setLastWarnings(result.warnings);
        setStatus('success');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[LocalBackup] import failed:', msg);
        setLastError(msg);
        setStatus('error');
      }
    },
    [store],
  );

  const resetStatus = useCallback(() => {
    setStatus('idle');
    setLastError(null);
    setLastWarnings([]);
  }, []);

  return {
    status,
    lastError,
    lastWarnings,
    exportVaultToLocal,
    importVaultFromLocal,
    resetStatus,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsText(file);
  });
}
