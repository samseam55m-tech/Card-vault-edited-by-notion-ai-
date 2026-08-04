import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import { IMAGE_BLOB_PREFIX, blobNameFor, hashFromBlobName } from '../imageBlobs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoogleUser {
  email: string;
  displayName: string;
  photoUrl?: string;
}

interface DriveFileMetadata {
  id: string;
  name: string;
  modifiedTime?: string;
  /**
   * Arbitrary key/value metadata Drive stores alongside the file. We mirror the
   * vault's `lastMutatedAt` stamp here so conflict detection can read it from a
   * cheap list call instead of downloading the whole vault — which, with base64
   * images embedded, can be megabytes over mobile data.
   */
  appProperties?: Record<string, string>;
}

/** What the app needs to know about the cloud vault without fetching its body. */
export interface VaultFileMeta {
  id: string;
  /** The vault's `lastMutatedAt` as recorded at upload time, if known. */
  stamp?: number;
  /** Drive's own modification time. Informational; not used for conflicts. */
  modifiedTime?: string;
}

interface UseGoogleDriveReturn {
  /** Currently signed-in user (null when signed out) */
  user: GoogleUser | null;
  /** OAuth access token for the current session */
  accessToken: string | null;
  /** True while any async operation is in progress */
  loading: boolean;
  /** Last error message, cleared on next successful operation */
  error: string | null;
  /** True while the silent-login attempt is in progress */
  restoring: boolean;

  // Auth
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;

  // Drive helpers – all operate on the hidden appDataFolder
  findVaultFile: () => Promise<string | null>;
  /** Like findVaultFile, but also returns the stored `lastMutatedAt` stamp. */
  findVaultMeta: () => Promise<VaultFileMeta | null>;
  createVaultFile: (jsonString: string, stamp?: number) => Promise<string>;
  updateVaultFile: (fileId: string, jsonString: string, stamp?: number) => Promise<void>;
  downloadVaultFile: (fileId: string) => Promise<string>;

  // Image blobs (rec 2b) – one small Drive file per distinct image
  /** Every image blob in the appDataFolder, as content hash -> Drive file id. */
  listImageBlobs: () => Promise<Map<string, string>>;
  uploadImageBlob: (hash: string, contents: string) => Promise<string>;
  downloadImageBlob: (fileId: string) => Promise<string>;
  /** Delete any appDataFolder file by id. Used to collect orphaned blobs. */
  deleteFileById: (fileId: string) => Promise<void>;

  // Convenience wrappers
  uploadVaultData: (jsonString: string, stamp?: number) => Promise<string>;
  downloadVaultData: () => Promise<string | null>;
  deleteVaultData: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAULT_FILENAME = 'vault_data.json';
const DRIVE_API = 'https://www.googleapis.com';
const DRIVE_FILES = `${DRIVE_API}/drive/v3/files`;
const DRIVE_UPLOAD = `${DRIVE_API}/upload/drive/v3/files`;

const GOOGLE_CLIENT_ID =
  '1037717798765-jscjfdk82phc7sju9jkq53157mik4deg.apps.googleusercontent.com';
const GOOGLE_SCOPES = [
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.appdata',
];

const SESSION_FLAG_KEY = 'googleAuth_hasSignedIn';

// ---------------------------------------------------------------------------
// One-time plugin initialization
// ---------------------------------------------------------------------------

let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  GoogleAuth.initialize({
    clientId: GOOGLE_CLIENT_ID,
    scopes: GOOGLE_SCOPES,
  });
  initialized = true;
}

// ---------------------------------------------------------------------------
// Error extraction helper – Capacitor native errors can be anything:
// Error instances, plain objects with .message, bare strings, numbers, null.
// ---------------------------------------------------------------------------

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    // Capacitor often returns { message: '...', code: '...' }
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.errorMessage === 'string' && obj.errorMessage) return obj.errorMessage;
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err || 'UNKNOWN_NATIVE_ERROR');
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGoogleDrive(): UseGoogleDriveReturn {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  // Keep a ref so Drive helpers always see the latest token without stale closures
  const tokenRef = useRef<string | null>(null);

  // -----------------------------------------------------------------------
  // Silent login on mount – restore session if user previously signed in
  // -----------------------------------------------------------------------

  useEffect(() => {
    const tryRestore = async () => {
      const hasSignedIn = localStorage.getItem(SESSION_FLAG_KEY);
      if (!hasSignedIn) return;

      setRestoring(true);
      try {
        ensureInitialized();
        const result = await GoogleAuth.refresh();

        if (result && result.accessToken) {
          tokenRef.current = result.accessToken;
          setAccessToken(result.accessToken);

          // Try to get user profile from a silent signIn or from the token
          // GoogleAuth.refresh() only returns the token, so we attempt signIn silently
          // to get user info. If that fails, we still have the token.
          try {
            const userResult = await GoogleAuth.signIn();
            if (userResult && userResult.authentication?.accessToken) {
              tokenRef.current = userResult.authentication.accessToken;
              setAccessToken(userResult.authentication.accessToken);
              setUser({
                email: userResult.email,
                displayName: userResult.name ?? userResult.email,
                photoUrl: userResult.imageUrl ?? undefined,
              });
            }
          } catch {
            // signIn may fail if user needs to re-consent, but we still have the refreshed token
            // We'll show the user as signed in with limited info
            setUser({
              email: 'Signed In',
              displayName: 'Google User',
              photoUrl: undefined,
            });
          }
        }
      } catch {
        // Silent restore failed – clear the flag so we don't retry every mount
        localStorage.removeItem(SESSION_FLAG_KEY);
      } finally {
        setRestoring(false);
      }
    };

    tryRestore();
  }, []);

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  const requireToken = (): string => {
    const t = tokenRef.current;
    if (!t) throw new Error('Not authenticated \u2013 call signIn() first.');
    return t;
  };

  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
  });

  const wrap = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T> => {
      setLoading(true);
      setError(null);
      try {
        return await fn();
      } catch (err: unknown) {
        const msg = extractErrorMessage(err);
        setError(msg);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // -----------------------------------------------------------------------
  // Auth – uses @codetrix-studio/capacitor-google-auth native plugin
  // -----------------------------------------------------------------------

  const signIn = useCallback(async () => {
    try {
      ensureInitialized();
    } catch (initErr: unknown) {
      const initMsg = extractErrorMessage(initErr);
      window.alert('[DEBUG] GoogleAuth.initialize() failed:\n' + initMsg);
      setError(initMsg);
      throw initErr;
    }

    try {
      const result = await GoogleAuth.signIn();

      // Debug: show the raw result so we can verify the shape
      if (!result || !result.authentication || !result.authentication.accessToken) {
        const resultDump = JSON.stringify(result, null, 2);
        window.alert('[DEBUG] signIn result missing accessToken:\n' + resultDump);
        throw new Error('signIn returned no accessToken. Raw result: ' + resultDump);
      }

      const token = result.authentication.accessToken;
      tokenRef.current = token;
      setAccessToken(token);
      setLoading(false);
      setError(null);
      setUser({
        email: result.email,
        displayName: result.name ?? result.email,
        photoUrl: result.imageUrl ?? undefined,
      });

      // Persist session flag for silent restore on next app launch
      localStorage.setItem(SESSION_FLAG_KEY, 'true');
    } catch (signInErr: unknown) {
      const msg = extractErrorMessage(signInErr);
      window.alert('[DEBUG] GoogleAuth.signIn() failed:\n' + msg);
      setError(msg);
      setLoading(false);
      throw signInErr;
    }
  }, []);

  const signOut = useCallback(async () => {
    await wrap(async () => {
      ensureInitialized();
      await GoogleAuth.signOut();
      tokenRef.current = null;
      setAccessToken(null);
      setUser(null);
      localStorage.removeItem(SESSION_FLAG_KEY);
    });
  }, [wrap]);

  // -----------------------------------------------------------------------
  // Drive API – low-level helpers
  // -----------------------------------------------------------------------

  /**
   * Search for `vault_data.json` inside the hidden appDataFolder.
   * Returns the file ID if found, or `null`.
   */
  const findVaultMeta = useCallback(async (): Promise<VaultFileMeta | null> => {
    return wrap(async () => {
      const token = requireToken();
      const q = encodeURIComponent(
        `name='${VAULT_FILENAME}' and 'appDataFolder' in parents and trashed=false`,
      );
      const res = await fetch(
        `${DRIVE_FILES}?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime,appProperties)`,
        { headers: headers(token) },
      );
      if (!res.ok) throw new Error(`Drive list failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { files: DriveFileMetadata[] };
      if (data.files.length === 0) return null;

      const file = data.files[0];
      const rawStamp = file.appProperties?.lastMutatedAt;
      const parsed = rawStamp === undefined ? NaN : Number(rawStamp);

      return {
        id: file.id,
        // Absent for files written by v1.2.0 and earlier. `undefined` means
        // "unknown", which the conflict logic treats as "cannot prove it is
        // safe" rather than "safe".
        stamp: Number.isFinite(parsed) ? parsed : undefined,
        modifiedTime: file.modifiedTime,
      };
    });
  }, [wrap]);

  const findVaultFile = useCallback(async (): Promise<string | null> => {
    const meta = await findVaultMeta();
    return meta ? meta.id : null;
  }, [findVaultMeta]);

  /**
   * Create `vault_data.json` in the appDataFolder with the given content.
   * Returns the new file ID.
   */
  const createVaultFile = useCallback(
    async (jsonString: string, stamp?: number): Promise<string> => {
      return wrap(async () => {
        const token = requireToken();

        const metadata = {
          name: VAULT_FILENAME,
          parents: ['appDataFolder'],
          ...(stamp === undefined
            ? {}
            : { appProperties: { lastMutatedAt: String(stamp) } }),
        };

        // Multipart upload so we can send metadata + content in one request.
        const boundary = '----VaultBoundary';
        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: application/json\r\n\r\n` +
          `${jsonString}\r\n` +
          `--${boundary}--`;

        const res = await fetch(
          `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime`,
          {
            method: 'POST',
            headers: {
              ...headers(token),
              'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body,
          },
        );
        if (!res.ok) throw new Error(`Drive create failed: ${res.status} ${await res.text()}`);
        const file = (await res.json()) as DriveFileMetadata;
        return file.id;
      });
    },
    [wrap],
  );

  /**
   * Overwrite the content of an existing file.
   */
  const updateVaultFile = useCallback(
    async (fileId: string, jsonString: string, stamp?: number): Promise<void> => {
      await wrap(async () => {
        const token = requireToken();

        // Multipart rather than the previous `uploadType=media`, so the content
        // and the `lastMutatedAt` stamp are written in a SINGLE request. Doing
        // them as two calls would leave a window where the file body and its
        // advertised stamp disagree, and a conflict check landing in that window
        // would reach the wrong conclusion about whose data is newer.
        const boundary = '----VaultBoundary';
        const metadata =
          stamp === undefined
            ? {}
            : { appProperties: { lastMutatedAt: String(stamp) } };

        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: application/json\r\n\r\n` +
          `${jsonString}\r\n` +
          `--${boundary}--`;

        const res = await fetch(
          `${DRIVE_UPLOAD}/${fileId}?uploadType=multipart`,
          {
            method: 'PATCH',
            headers: {
              ...headers(token),
              'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body,
          },
        );
        if (!res.ok) throw new Error(`Drive update failed: ${res.status} ${await res.text()}`);
      });
    },
    [wrap],
  );

  /**
   * Download the raw JSON string from a file.
   */
  const downloadVaultFile = useCallback(
    async (fileId: string): Promise<string> => {
      return wrap(async () => {
        const token = requireToken();
        const res = await fetch(
          `${DRIVE_FILES}/${fileId}?alt=media`,
          { headers: headers(token) },
        );
        if (!res.ok) throw new Error(`Drive download failed: ${res.status} ${await res.text()}`);
        return res.text();
      });
    },
    [wrap],
  );

  // -----------------------------------------------------------------------
  // Image blobs (rec 2b)
  // -----------------------------------------------------------------------

  /**
   * Every image blob currently in the appDataFolder, as hash -> file id.
   *
   * Paginated deliberately. A vault with a few hundred images exceeds a single
   * page, and a truncated listing does not fail loudly — it silently looks
   * like "those blobs are not there". That would re-upload images that already
   * exist, and, far worse, make the orphan sweep delete blobs the vault is
   * still using. Read every page before drawing any conclusion.
   */
  const listImageBlobs = useCallback(async (): Promise<Map<string, string>> => {
    return wrap(async () => {
      const token = requireToken();
      const found = new Map<string, string>();
      const q = encodeURIComponent(
        `'appDataFolder' in parents and trashed=false and name contains '${IMAGE_BLOB_PREFIX}'`,
      );

      let pageToken: string | undefined;
      do {
        const url =
          `${DRIVE_FILES}?spaces=appDataFolder&q=${q}&pageSize=1000` +
          `&fields=nextPageToken,files(id,name)` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

        const res = await fetch(url, { headers: headers(token) });
        if (!res.ok) {
          throw new Error(`Drive image list failed: ${res.status} ${await res.text()}`);
        }
        const data = (await res.json()) as {
          files: DriveFileMetadata[];
          nextPageToken?: string;
        };

        for (const file of data.files) {
          const hash = hashFromBlobName(file.name);
          if (hash) found.set(hash, file.id);
        }
        pageToken = data.nextPageToken;
      } while (pageToken);

      return found;
    });
  }, [wrap]);

  // The three per-blob helpers below deliberately do NOT go through `wrap`.
  // `wrap` flips `loading` and clears `error` on entry and exit; a backup of a
  // large vault calls these hundreds of times, and each call would publish two
  // state updates, re-rendering every consumer of this hook throughout the
  // upload. Errors still propagate to the caller, which is the layer that
  // knows how to describe them.

  const uploadImageBlob = useCallback(
    async (hash: string, contents: string): Promise<string> => {
      const token = requireToken();
      const metadata = { name: blobNameFor(hash), parents: ['appDataFolder'] };
      const boundary = '----VaultBoundary';
      const body =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
        `${contents}\r\n` +
        `--${boundary}--`;

      const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: {
          ...headers(token),
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      if (!res.ok) {
        throw new Error(`Image upload failed: ${res.status} ${await res.text()}`);
      }
      const file = (await res.json()) as DriveFileMetadata;
      return file.id;
    },
    [],
  );

  const downloadImageBlob = useCallback(
    async (fileId: string): Promise<string> => {
      const token = requireToken();
      const res = await fetch(`${DRIVE_FILES}/${fileId}?alt=media`, {
        headers: headers(token),
      });
      if (!res.ok) {
        throw new Error(`Image download failed: ${res.status} ${await res.text()}`);
      }
      return res.text();
    },
    [],
  );

  const deleteFileById = useCallback(async (fileId: string): Promise<void> => {
    const token = requireToken();
    const res = await fetch(`${DRIVE_FILES}/${fileId}`, {
      method: 'DELETE',
      headers: headers(token),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Drive delete failed: ${res.status} ${await res.text()}`);
    }
  }, []);

  // -----------------------------------------------------------------------
  // Convenience wrappers
  // -----------------------------------------------------------------------

  /**
   * Upload vault data – creates the file if it doesn't exist, otherwise
   * overwrites it. Returns the file ID.
   */
  const uploadVaultData = useCallback(
    async (jsonString: string, stamp?: number): Promise<string> => {
      const existingId = await findVaultFile();
      if (existingId) {
        await updateVaultFile(existingId, jsonString, stamp);
        return existingId;
      }
      return createVaultFile(jsonString, stamp);
    },
    [findVaultFile, updateVaultFile, createVaultFile],
  );

  /**
   * Download vault data. Returns the JSON string, or `null` if the file
   * doesn't exist yet.
   */
  const downloadVaultData = useCallback(async (): Promise<string | null> => {
    const existingId = await findVaultFile();
    if (!existingId) return null;
    return downloadVaultFile(existingId);
  }, [findVaultFile, downloadVaultFile]);

  /**
   * Permanently delete the vault file from Google Drive.
   * If no vault file exists, this is a no-op.
   */
  const deleteVaultData = useCallback(async (): Promise<void> => {
    const existingId = await findVaultFile();
    if (!existingId) return;

    await wrap(async () => {
      const token = requireToken();
      const res = await fetch(`${DRIVE_FILES}/${existingId}`, {
        method: 'DELETE',
        headers: headers(token),
      });
      // 204 No Content is the expected success response
      if (!res.ok && res.status !== 204) {
        throw new Error(`Drive delete failed: ${res.status} ${await res.text()}`);
      }
    });
  }, [findVaultFile, wrap]);

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  // MEMOISED DELIBERATELY — this fixes a real bug, it is not tidying.
  //
  // This hook used to return a fresh object literal on every render. Callers do
  // `useCallback(..., [drive])`, so every one of their callbacks was recreated
  // every render too; `AccountMenu`'s auto-backup effect lists `pushToCloud` in
  // its dependency array, so that effect re-fired continuously, endlessly
  // rescheduling the 15-minute backup timer. v1.2.0 worked around the symptom
  // by holding `markCloudSync` in a ref. This is the fix at the source.
  return useMemo(
    () => ({
      user,
      accessToken,
      loading,
      error,
      restoring,
      signIn,
      signOut,
      findVaultFile,
      findVaultMeta,
      createVaultFile,
      updateVaultFile,
      downloadVaultFile,
      listImageBlobs,
      uploadImageBlob,
      downloadImageBlob,
      deleteFileById,
      uploadVaultData,
      downloadVaultData,
      deleteVaultData,
    }),
    [
      user,
      accessToken,
      loading,
      error,
      restoring,
      signIn,
      signOut,
      findVaultFile,
      findVaultMeta,
      createVaultFile,
      updateVaultFile,
      downloadVaultFile,
      listImageBlobs,
      uploadImageBlob,
      downloadImageBlob,
      deleteFileById,
      uploadVaultData,
      downloadVaultData,
      deleteVaultData,
    ],
  );
}
