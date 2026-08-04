import localforage from 'localforage';
import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { Card, Project, Tag, PromptProject, DeletedHeaderBlock } from './types';
import { DEFAULT_TAGS } from './defaultTags';
import {
  VaultData,
  readVault,
  purgeExpired,
  computeLastMutatedAt,
  CURRENT_SCHEMA_VERSION,
} from './schema';
import { hydrateImageDims } from './imageDims';

// Re-exported so existing `import { DEFAULT_TAGS } from '../store'` call sites
// keep working. The constant itself now lives in ./defaultTags to break the
// store <-> schema import cycle.
export { DEFAULT_TAGS };

/**
 * The persisted vault shape is defined once, in ./schema. This alias keeps the
 * long-standing local name so the rest of the file reads unchanged.
 */
type AppStateData = VaultData;

const EMPTY_STATE: AppStateData = {
  cards: [],
  projects: [],
  promptProjects: [],
  tags: DEFAULT_TAGS,
  deletedHeaderBlocks: [],
  theme: 'dark',
  lastLocalBackupAt: undefined,
  lastCloudSyncAt: undefined,
  hasOnboarded: false,
  lastKnownRemoteStamp: undefined,
};

interface AppState extends AppStateData {
  addCard: (card: Card) => Promise<void>;
  updateCard: (card: Card) => Promise<void>;
  updateCards: (cards: Card[]) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  addProject: (project: Project) => Promise<void>;
  updateProject: (project: Project) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  addPromptProject: (project: PromptProject) => Promise<void>;
  updatePromptProject: (project: PromptProject) => Promise<void>;
  deletePromptProject: (id: string) => Promise<void>;
  addTag: (tag: Tag) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
  addDeletedHeaderBlock: (block: DeletedHeaderBlock) => Promise<void>;
  updateDeletedHeaderBlocks: (blocks: DeletedHeaderBlock[]) => Promise<void>;
  setTheme: (theme: string) => Promise<void>;
  /**
   * Replace the entire state from an external source (e.g. cloud restore).
   * Accepts unvalidated input and normalises it through `readVault`.
   * Returns false (and changes nothing) if the input is not a usable vault.
   */
  replaceState: (incoming: unknown) => boolean;
  /** Reset state to empty defaults (used on sign-out to prevent data bleeding) */
  clearState: () => void;
  /** Record that a local backup file was just exported successfully. */
  markLocalBackup: () => Promise<void>;
  /** Record that a cloud push just succeeded. */
  markCloudSync: () => Promise<void>;
  /** Dismiss the first-run explainer. */
  setOnboarded: () => Promise<void>;
  /**
   * Record the cloud file's `lastMutatedAt` after a successful sync in either
   * direction. This is the anchor conflict detection compares against.
   */
  setKnownRemoteStamp: (stamp: number) => Promise<void>;
  /** The vault's current high-water mark: newest `updatedAt` across all records. */
  lastMutatedAt: number;
  /** How the stored vault was read on load (schema version, migration, warnings). */
  schemaInfo: SchemaInfo;
  /** Monotonically increasing counter that bumps on every state mutation */
  stateVersion: number;
  /**
   * Bumps ONLY when the vault is replaced from outside (cloud restore,
   * sign-out wipe) — never on ordinary edits. Editors that seed local draft
   * state once on mount key themselves on this so a restore remounts them
   * against the restored data instead of autosaving a stale draft back over
   * it. Distinct from `stateVersion`, which drives auto-backup and must not
   * fire for external replacements.
   */
  vaultEpoch: number;
  loading: boolean;
}

const StoreContext = createContext<AppState | undefined>(undefined);

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Incremented whenever in-memory state is replaced wholesale from outside the
 * app (cloud restore, sign-out wipe).
 *
 * Why this exists: `saveToStorage` schedules a write 500ms out, and the
 * callback closes over the state it was handed at schedule time. If a restore
 * landed while such a write was pending, that timer would fire *after* the
 * restore had written the cloud vault to disk and silently overwrite it with
 * the pre-restore snapshot. The user would see a correct restore, relaunch the
 * app, and find their old data back. Any write scheduled under a previous
 * epoch is stale by definition and must never reach disk.
 */
let storageEpoch = 0;

/** Invalidate pending writes. Call immediately before applying a restore. */
const bumpStorageEpoch = () => {
  storageEpoch += 1;
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
};

const saveToStorage = (state: AppStateData) => {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  const scheduledUnder = storageEpoch;
  saveTimeout = setTimeout(async () => {
    // Checked inside the callback, not at schedule time: the epoch may have
    // moved between scheduling and firing, which is precisely the race.
    if (scheduledUnder !== storageEpoch) {
      console.warn(
        '[Store] Dropped a queued write that predates a restore/wipe.',
      );
      return;
    }
    await localforage.setItem('appState', state);
  }, 500);
};

/**
 * Typed as `unknown` on purpose: whatever is on disk may predate the current
 * schema or have been written by a newer build. Proving it is a vault is
 * `readVault`'s job, not the caller's.
 */
const loadFromStorage = async (): Promise<unknown> => {
  return await localforage.getItem('appState');
};

/**
 * Rebuild a vault from the pre-`appState` per-key layout (`card_*`,
 * `promptProject_*`, `deletedHeaderBlock_*`, plus `projects` and `tags`).
 * Returns null when there is nothing there to migrate.
 */
const loadLegacyPerKeyVault = async (): Promise<Record<string, unknown> | null> => {
  const keys = await localforage.keys();
  const oldCards: Card[] = [];
  const oldPromptProjects: PromptProject[] = [];
  const oldDeletedBlocks: DeletedHeaderBlock[] = [];

  for (const key of keys) {
    if (key.startsWith('card_')) {
      const item = await localforage.getItem<Card>(key);
      if (item) oldCards.push(item);
    } else if (key.startsWith('promptProject_')) {
      const item = await localforage.getItem<PromptProject>(key);
      if (item) oldPromptProjects.push(item);
    } else if (key.startsWith('deletedHeaderBlock_')) {
      const item = await localforage.getItem<DeletedHeaderBlock>(key);
      if (item) oldDeletedBlocks.push(item);
    }
  }

  const oldProjects = (await localforage.getItem<Project[]>('projects')) || [];
  const oldTags = (await localforage.getItem<Tag[]>('tags')) || DEFAULT_TAGS;

  const foundAnything =
    oldCards.length > 0 ||
    oldPromptProjects.length > 0 ||
    oldDeletedBlocks.length > 0 ||
    oldProjects.length > 0;

  if (!foundAnything) return null;

  return {
    cards: oldCards,
    projects: oldProjects,
    promptProjects: oldPromptProjects,
    tags: oldTags,
    deletedHeaderBlocks: oldDeletedBlocks,
    theme: 'dark',
    // Migrating means there was pre-existing data: not a first run.
    hasOnboarded: true,
  };
};

/** Diagnostics about how the vault on disk was read. Surfaced in the debug panel. */
export interface SchemaInfo {
  /** Schema version this build writes. */
  version: number;
  /** Schema version the stored vault was written at. */
  loadedFromVersion: number;
  /** True when the stored vault needed upgrading on load. */
  migrated: boolean;
  /** Non-fatal repairs or compatibility notes from the last load. */
  warnings: string[];
}

export const StoreProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AppStateData>({ ...EMPTY_STATE });
  const [loading, setLoading] = useState(true);
  const [stateVersion, setStateVersion] = useState(0);
  const [vaultEpoch, setVaultEpoch] = useState(0);
  const [schemaInfo, setSchemaInfo] = useState<SchemaInfo>({
    version: CURRENT_SCHEMA_VERSION,
    loadedFromVersion: CURRENT_SCHEMA_VERSION,
    migrated: false,
    warnings: [],
  });

  useEffect(() => {
    const loadData = async () => {
      try {
        // Card image aspect ratios, so the masonry reserves the right heights on
        // the very first paint instead of reflowing as pictures decode. This is
        // a disposable LOCAL cache in its own key - deliberately NOT part of the
        // vault, because writing it would stamp `lastMutatedAt` and could invent
        // sync conflicts (see src/imageDims.ts). Awaited before the vault is
        // read so the ratios are in memory before any card renders; a failure
        // in there is swallowed, so this cannot block or break the load.
        await hydrateImageDims();

        const stored = await loadFromStorage();
        const source = stored ?? (await loadLegacyPerKeyVault());

        // Genuinely empty device: a real first run. Leave EMPTY_STATE in place
        // (hasOnboarded stays false so the explainer shows).
        if (!source) return;

        const now = Date.now();
        const result = readVault(source, now, { treatAsExisting: true });
        const data = purgeExpired(result.data, now);

        setState(data);
        setSchemaInfo({
          version: CURRENT_SCHEMA_VERSION,
          loadedFromVersion: result.fromVersion,
          migrated: result.migrated,
          warnings: result.warnings,
        });

        // Persist the upgraded shape straight away rather than waiting for the
        // next user edit to flush it. `readVault` is pure and purely additive,
        // so the worst case is rewriting an equivalent object. Doing it here
        // means the migration runs once instead of on every cold start, and a
        // later crash cannot leave a half-migrated vault on disk.
        if (result.migrated || !stored) {
          await localforage.setItem('appState', data);
        }
      } catch (e) {
        // A vault that cannot be parsed is NOT replaced with defaults. Writing
        // an empty state here would destroy the only copy. Stay on the empty
        // in-memory state and leave the bytes on disk untouched so they remain
        // recoverable.
        console.error('[Store] Vault load failed; stored data left intact.', e);
        setSchemaInfo(prev => ({
          ...prev,
          warnings: [
            ...prev.warnings,
            'Stored vault could not be read. It has been left untouched on disk \u2014 restore from a backup rather than editing, or the unreadable copy may be overwritten.',
          ],
        }));
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  /**
   * Stamp a record as edited now.
   *
   * Every user-initiated write goes through this so `updatedAt` cannot be
   * forgotten at a call site. Deliberately applied in the action rather than
   * inside `updateState`, because `updateState` only ever sees the whole vault
   * and has no idea which individual record changed.
   */
  const touch = <T extends { updatedAt?: number }>(record: T): T => ({
    ...record,
    updatedAt: Date.now(),
  });

  const updateState = async (updater: (prev: AppStateData) => AppStateData) => {
    setState(prev => {
      const next = updater(prev);
      saveToStorage(next);
      return next;
    });
    setStateVersion(v => v + 1);
  };

  /**
   * Replace the entire in-memory state from an external source (e.g. cloud
   * restore). This does NOT write to localforage because the caller
   * (useCloudSync.pullFromCloud) already persisted the data.
   */
  const replaceState = useCallback((incoming: unknown): boolean => {
    let parsed: AppStateData;
    try {
      // One shared normalisation path. This function used to re-implement the
      // empty-tags fallback and the `|| []` defaults by hand, which is exactly
      // how they drifted out of step with the load path.
      parsed = readVault(incoming, Date.now(), { treatAsExisting: true }).data;
    } catch (e) {
      console.error('[Store] replaceState rejected unusable vault data.', e);
      return false;
    }

    // Kill any debounced write still holding pre-restore state before the new
    // vault goes into memory, and tell mounted editors to re-seed.
    bumpStorageEpoch();
    setVaultEpoch(e => e + 1);

    setState(prev => ({
      ...parsed,
      // Backup-freshness timestamps describe THIS device's backup history, not
      // the contents of the restored file. Keep ours when the incoming copy
      // has nothing to say about them.
      lastLocalBackupAt: parsed.lastLocalBackupAt ?? prev.lastLocalBackupAt,
      lastCloudSyncAt: parsed.lastCloudSyncAt ?? prev.lastCloudSyncAt,
      lastKnownRemoteStamp: parsed.lastKnownRemoteStamp ?? prev.lastKnownRemoteStamp,
      // Restoring a backup is not a first run — never re-show onboarding here.
      hasOnboarded: true,
    }));
    // Do NOT bump stateVersion here – this is an external replace, not a
    // user-initiated mutation, so it should not trigger auto-backup.
    return true;
  }, []);

  /**
   * Reset state to empty defaults. Used on sign-out to guarantee that
   * Account A's data cannot bleed into Account B's cloud.
   * localforage is wiped by the caller (useCloudSync.signOutAndWipe).
   */
  const clearState = useCallback(() => {
    // Same reasoning as replaceState: a queued write from the signed-in
    // session must not resurrect that account's data after the wipe.
    bumpStorageEpoch();
    setVaultEpoch(e => e + 1);
    setState({ ...EMPTY_STATE });
    // Do NOT bump stateVersion – this is a wipe, not a user edit.
  }, []);

  const addCard = async (card: Card) => {
    const stamped = touch(card);
    await updateState(prev => {
      if (prev.cards.some(c => c.id === stamped.id)) {
        return { ...prev, cards: prev.cards.map(c => c.id === stamped.id ? stamped : c) };
      }
      return { ...prev, cards: [...prev.cards, stamped] };
    });
  };

  const updateCard = async (card: Card) => {
    const stamped = touch(card);
    await updateState(prev => ({ ...prev, cards: prev.cards.map(c => c.id === stamped.id ? stamped : c) }));
  };

  const updateCards = async (updatedCards: Card[]) => {
    // One shared timestamp for the whole batch: these edits happened together
    // (a drag-reorder, a bulk tag change), so they should not be smeared across
    // several milliseconds and look like separate events to the sync layer.
    const now = Date.now();
    const stamped = updatedCards.map(c => ({ ...c, updatedAt: now }));
    await updateState(prev => {
      const updatedMap = new Map(stamped.map(c => [c.id, c]));
      return { ...prev, cards: prev.cards.map(c => updatedMap.has(c.id) ? updatedMap.get(c.id)! : c) };
    });
  };

  const deleteCard = async (id: string) => {
    await updateState(prev => ({ ...prev, cards: prev.cards.filter(c => c.id !== id) }));
  };

  const addProject = async (project: Project) => {
    const stamped = touch(project);
    await updateState(prev => {
      if (prev.projects.some(p => p.id === stamped.id)) {
        return { ...prev, projects: prev.projects.map(p => p.id === stamped.id ? stamped : p) };
      }
      return { ...prev, projects: [...prev.projects, stamped] };
    });
  };

  const updateProject = async (project: Project) => {
    const stamped = touch(project);
    await updateState(prev => ({ ...prev, projects: prev.projects.map(p => p.id === stamped.id ? stamped : p) }));
  };

  const deleteProject = async (id: string) => {
    await updateState(prev => ({ ...prev, projects: prev.projects.filter(p => p.id !== id) }));
  };

  const addPromptProject = async (project: PromptProject) => {
    const stamped = touch(project);
    await updateState(prev => {
      if (prev.promptProjects.some(p => p.id === stamped.id)) {
        return { ...prev, promptProjects: prev.promptProjects.map(p => p.id === stamped.id ? stamped : p) };
      }
      return { ...prev, promptProjects: [...prev.promptProjects, stamped] };
    });
  };

  const updatePromptProject = async (project: PromptProject) => {
    const stamped = touch(project);
    await updateState(prev => ({ ...prev, promptProjects: prev.promptProjects.map(p => p.id === stamped.id ? stamped : p) }));
  };

  const deletePromptProject = async (id: string) => {
    await updateState(prev => ({ ...prev, promptProjects: prev.promptProjects.filter(p => p.id !== id) }));
  };

  const addTag = async (tag: Tag) => {
    await updateState(prev => {
      if (prev.tags.some(t => t.id === tag.id)) {
        return { ...prev, tags: prev.tags.map(t => t.id === tag.id ? tag : t) };
      }
      return { ...prev, tags: [...prev.tags, tag] };
    });
  };

  const deleteTag = async (id: string) => {
    await updateState(prev => {
      const newTags = prev.tags.filter(t => t.id !== id);
      const newCards = prev.cards.map(c => ({
        ...c,
        tags: c.tags ? c.tags.filter(t => t !== id) : [],
        mainTag: c.mainTag === id ? undefined : c.mainTag
      }));
      return { ...prev, tags: newTags, cards: newCards };
    });
  };

  const addDeletedHeaderBlock = async (block: DeletedHeaderBlock) => {
    await updateState(prev => {
      if (prev.deletedHeaderBlocks.some(b => b.id === block.id)) {
        return { ...prev, deletedHeaderBlocks: prev.deletedHeaderBlocks.map(b => b.id === block.id ? block : b) };
      }
      return { ...prev, deletedHeaderBlocks: [...prev.deletedHeaderBlocks, block] };
    });
  };

  const updateDeletedHeaderBlocks = async (blocks: DeletedHeaderBlock[]) => {
    await updateState(prev => ({ ...prev, deletedHeaderBlocks: blocks }));
  };

  const setTheme = async (theme: string) => {
    await updateState(prev => ({ ...prev, theme }));
  };

  const markLocalBackup = async () => {
    await updateState(prev => ({ ...prev, lastLocalBackupAt: Date.now() }));
  };

  const markCloudSync = async () => {
    await updateState(prev => ({ ...prev, lastCloudSyncAt: Date.now() }));
  };

  const setOnboarded = async () => {
    await updateState(prev => ({ ...prev, hasOnboarded: true }));
  };

  const setKnownRemoteStamp = async (stamp: number) => {
    await updateState(prev => ({ ...prev, lastKnownRemoteStamp: stamp }));
  };

  return (
    <StoreContext.Provider value={{ 
      ...state,
      addCard, updateCard, updateCards, deleteCard, 
      addProject, updateProject, deleteProject, 
      addPromptProject, updatePromptProject, deletePromptProject,
      addTag, deleteTag, addDeletedHeaderBlock, updateDeletedHeaderBlocks, setTheme,
      markLocalBackup, markCloudSync, setOnboarded, setKnownRemoteStamp,
      lastMutatedAt: computeLastMutatedAt(state),
      schemaInfo,
      replaceState, clearState, stateVersion, vaultEpoch, loading 
    }}>
      {children}
    </StoreContext.Provider>
  );
};

export const useStore = () => {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used within a StoreProvider');
  return context;
};
