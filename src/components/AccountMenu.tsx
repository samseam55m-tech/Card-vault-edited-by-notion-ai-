import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { clearScrollLog, getScrollLog } from '../hooks/useViewState';
import {
  X,
  User,
  LogOut,
  CloudUpload,
  CloudDownload,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Trash2,
  ShieldAlert,
  Download,
  Upload,
  SlidersHorizontal,
  Copy,
  RefreshCw,
  Check,
  Clock,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { useCloudSync, SyncStatus } from '../hooks/useCloudSync';
import { ConflictReport } from '../schema';
import { useLocalBackup, LocalBackupStatus } from '../hooks/useLocalBackup';
import { useStore } from '../store';
import { APP_VERSION, BUILD_TIME } from '../version';

/** "3h ago" style relative time for backup freshness. */
function formatRelativeTime(ts?: number): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

/** A backup older than this (or missing) is surfaced as a warning. */
const BACKUP_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Human-readable byte size for the debug panel. */
function formatBytes(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '\u2014';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Inline keyframe styles (injected once)
// ---------------------------------------------------------------------------

const ANIMATION_STYLES = `
@keyframes accountMenuSlideIn {
  from { transform: translateX(100%); opacity: 0.8; }
  to   { transform: translateX(0);    opacity: 1; }
}
@keyframes accountMenuSlideOut {
  from { transform: translateX(0);    opacity: 1; }
  to   { transform: translateX(100%); opacity: 0.8; }
}
@keyframes accountMenuFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes accountMenuFadeOut {
  from { opacity: 1; }
  to   { opacity: 0; }
}
@keyframes cardStagger {
  from { opacity: 0; transform: translateY(12px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes avatarRingPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0.5); }
  50%      { box-shadow: 0 0 0 6px rgba(99,102,241,0); }
}
@keyframes modalEnter {
  from { opacity: 0; transform: scale(0.92) translateY(16px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  15%      { transform: translateX(-6px); }
  30%      { transform: translateX(6px); }
  45%      { transform: translateX(-4px); }
  60%      { transform: translateX(4px); }
  75%      { transform: translateX(-2px); }
  90%      { transform: translateX(2px); }
}
@keyframes successPulse {
  0%   { transform: scale(0.8); opacity: 0; }
  50%  { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes gradientRotate {
  0%   { --angle: 0deg; }
  100% { --angle: 360deg; }
}
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = ANIMATION_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

// ---------------------------------------------------------------------------
// SyncStatusBadge
// ---------------------------------------------------------------------------

function SyncStatusBadge({
  status,
  progress,
}: {
  status: SyncStatus;
  progress?: string | null;
}) {
  if (status === 'idle') return null;

  const config = {
    syncing: { icon: Loader2, text: 'Syncing...', className: 'text-accent animate-spin', bg: 'bg-accent/10 border-accent/20' },
    success: { icon: CheckCircle2, text: 'Done!', className: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
    error:   { icon: AlertCircle, text: 'Failed', className: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
    // A refused sync is not a failure and must not read as one. It also must
    // not read as success: an automatic backup that stops on a conflict leaves
    // the cloud copy untouched, and the user needs to know that nothing was
    // saved rather than assuming the backup went through.
    conflict: { icon: ShieldAlert, text: 'Sync stopped \u2014 needs your decision', className: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' },
  }[status];

  if (!config) return null;
  const Icon = config.icon;

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${config.bg} transition-all duration-300`}
      style={{ animation: 'cardStagger 0.3s ease-out both' }}
    >
      <Icon className={`w-4 h-4 ${config.className}`} />
      {/* Prefer the live step over the generic label. Splitting images makes a
          first backup a long sequence of small uploads, and "Syncing..." for
          two minutes is indistinguishable from a hang. */}
      <span className="text-sm text-text-muted">
        {status === 'syncing' && progress ? progress : config.text}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocalBackupBadge
// ---------------------------------------------------------------------------

function LocalBackupBadge({ status, error }: { status: LocalBackupStatus; error: string | null }) {
  if (status === 'idle') return null;

  const config: Record<Exclude<LocalBackupStatus, 'idle'>, { icon: React.ElementType; text: string; className: string; bg: string }> = {
    exporting: { icon: Loader2, text: 'Exporting...', className: 'text-accent animate-spin', bg: 'bg-accent/10 border-accent/20' },
    importing: { icon: Loader2, text: 'Importing...', className: 'text-accent animate-spin', bg: 'bg-accent/10 border-accent/20' },
    success:   { icon: CheckCircle2, text: 'Done!', className: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
    error:     { icon: AlertCircle, text: error || 'Failed', className: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
  };

  const c = config[status];
  const Icon = c.icon;

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${c.bg} transition-all duration-300`}
      style={{ animation: 'cardStagger 0.3s ease-out both' }}
    >
      <Icon className={`w-4 h-4 ${c.className}`} />
      <span className="text-sm text-text-muted break-words">{c.text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionCard
// ---------------------------------------------------------------------------

interface ActionCardProps {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  onClick?: () => void;
  disabled?: boolean;
  isSyncing?: boolean;
  variant?: 'default' | 'danger';
  delay?: number;
  /** Render the card as a <label> wrapper (for hidden <input type="file"> triggers) */
  asLabel?: boolean;
  htmlFor?: string;
}

function ActionCard({
  icon: Icon,
  title,
  subtitle,
  onClick,
  disabled,
  isSyncing,
  variant = 'default',
  delay = 0,
  asLabel = false,
  htmlFor,
}: ActionCardProps) {
  const isDanger = variant === 'danger';

  const className = `w-full flex items-center gap-4 px-4 py-4 rounded-2xl border backdrop-blur-sm transition-all duration-300 group ${
    disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'
  } ${
    isDanger
      ? 'bg-red-950/30 border-red-500/20 hover:bg-red-950/50 hover:border-red-500/40 hover:shadow-lg hover:shadow-red-500/5'
      : 'bg-bg-surface-hover/40 border-border-main hover:bg-bg-surface-hover/70 hover:border-border-main hover:shadow-lg hover:shadow-accent/5'
  }`;

  const inner = (
    <>
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300 ${
        isDanger
          ? 'bg-red-500/15 group-hover:bg-red-500/25 group-hover:scale-110'
          : 'bg-accent/15 group-hover:bg-accent/25 group-hover:scale-110'
      }`}>
        {isSyncing ? (
          <Loader2 className={`w-5 h-5 animate-spin ${isDanger ? 'text-red-400' : 'text-accent'}`} />
        ) : (
          <Icon className={`w-5 h-5 transition-transform duration-300 ${
            isDanger ? 'text-red-400' : 'text-accent'
          }`} />
        )}
      </div>
      <div className="text-left flex-1 min-w-0">
        <span className={`text-sm font-semibold block transition-colors duration-200 ${
          isDanger ? 'text-red-100 group-hover:text-red-50' : 'text-text-main group-hover:text-text-main'
        }`}>{title}</span>
        <span className={`text-xs block mt-0.5 transition-colors duration-200 ${
          isDanger ? 'text-red-300/60' : 'text-text-muted group-hover:text-text-muted'
        }`}>{subtitle}</span>
      </div>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-all duration-300 opacity-0 group-hover:opacity-100 translate-x-1 group-hover:translate-x-0 ${
        isDanger ? 'bg-red-500/20' : 'bg-bg-surface-hover'
      }`}>
        <svg className={`w-3 h-3 ${isDanger ? 'text-red-400' : 'text-text-muted'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </>
  );

  const style = { animation: `cardStagger 0.4s ease-out ${delay}ms both` };

  if (asLabel) {
    return (
      <label htmlFor={htmlFor} className={className} style={style}>
        {inner}
      </label>
    );
  }

  return (
    <button onClick={onClick} disabled={disabled} className={className} style={style}>
      {inner}
    </button>
  );
}

// ---------------------------------------------------------------------------
// DeleteConfirmModal
// ---------------------------------------------------------------------------

interface DeleteConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
}

function DeleteConfirmModal({ isOpen, onClose, onConfirm, isDeleting }: DeleteConfirmModalProps) {
  const [input, setInput] = useState('');
  const [shaking, setShaking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const CONFIRM_PHRASE = 'delete Google drive data';
  const isMatch = input === CONFIRM_PHRASE;

  // Reset input when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setInput('');
      setShaking(false);
      // Focus the input after the entrance animation
      setTimeout(() => inputRef.current?.focus(), 350);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const handleSubmit = () => {
    if (!isMatch) {
      setShaking(true);
      setTimeout(() => setShaking(false), 600);
      return;
    }
    onConfirm();
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ animation: 'accountMenuFadeIn 0.2s ease-out both' }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className={`relative w-full max-w-md bg-bg-surface border border-border-main rounded-2xl shadow-2xl overflow-hidden ${
          shaking ? '' : ''
        }`}
        style={{
          animation: shaking
            ? 'shake 0.5s ease-in-out'
            : 'modalEnter 0.35s cubic-bezier(0.16,1,0.3,1) both',
        }}
      >
        {/* Red warning header */}
        <div className="relative px-6 py-5 bg-gradient-to-r from-red-950/80 via-red-900/60 to-red-950/80 border-b border-red-500/30">
          <div className="absolute inset-0 opacity-30"
            style={{
              background: 'linear-gradient(90deg, transparent, rgba(239,68,68,0.15), transparent)',
              backgroundSize: '200% 100%',
              animation: 'shimmer 3s linear infinite',
            }}
          />
          <div className="relative flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-500/20 border border-red-500/30 flex items-center justify-center">
              <ShieldAlert className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-red-50">Delete Cloud Data</h3>
              <p className="text-xs text-red-300/70 mt-0.5">This action is irreversible</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-text-muted leading-relaxed">
            This will <span className="font-semibold text-red-400">permanently delete</span> your
            vault backup from Google Drive. Your local data will remain untouched, but the cloud
            copy will be gone forever and cannot be recovered.
          </p>

          <div className="bg-red-950/20 border border-red-500/15 rounded-xl px-4 py-3">
            <p className="text-xs text-text-muted mb-2.5">
              To confirm, type <span className="font-mono text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">{CONFIRM_PHRASE}</span> below:
            </p>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder={CONFIRM_PHRASE}
              disabled={isDeleting}
              className="w-full px-3.5 py-2.5 rounded-lg bg-bg-main border border-border-main text-sm text-text-main placeholder-text-muted focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 transition-all duration-200 disabled:opacity-50 font-mono"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-bg-surface/50 border-t border-border-main flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2.5 rounded-xl text-sm font-medium text-text-muted hover:text-text-main hover:bg-bg-surface-hover transition-all duration-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isMatch || isDeleting}
            className={`relative px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 ${
              isMatch
                ? 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/30 active:scale-[0.97]'
                : 'bg-red-600/20 text-red-400/50 cursor-not-allowed opacity-50'
            }`}
          >
            {isDeleting ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Deleting...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Trash2 className="w-4 h-4" />
                Confirm Delete
              </span>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// SyncConflictModal
//
// Shown when a backup or restore has been REFUSED because it would have
// destroyed data. The sync layer never resolves a conflict on its own: only
// the user knows which copy matters, so the only job here is to state plainly
// what would be lost and let them choose.
// ---------------------------------------------------------------------------

interface SyncConflictModalProps {
  isOpen: boolean;
  report: ConflictReport | null;
  direction: 'push' | 'pull';
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function SyncConflictModal({
  isOpen,
  report,
  direction,
  busy,
  onCancel,
  onConfirm,
}: SyncConflictModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onCancel]);

  if (!isOpen || !report) return null;

  const title = direction === 'push' ? 'Overwrite cloud backup?' : 'Overwrite this device?';
  const losing =
    direction === 'push'
      ? 'Changes stored in the cloud that are not on this device will be lost.'
      : 'Changes on this device that are not in the cloud backup will be lost.';
  const confirmLabel = direction === 'push' ? 'Overwrite cloud' : 'Overwrite device';

  const formatStamp = (ms?: number) =>
    ms && ms > 0 ? new Date(ms).toLocaleString() : 'unknown';

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ animation: 'accountMenuFadeIn 0.2s ease-out both' }}
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />

      <div
        className="relative w-full max-w-md bg-bg-surface border border-border-main rounded-2xl shadow-2xl overflow-hidden"
        style={{ animation: 'modalEnter 0.35s cubic-bezier(0.16,1,0.3,1) both' }}
      >
        <div className="relative px-6 py-5 bg-gradient-to-r from-amber-950/80 via-amber-900/60 to-amber-950/80 border-b border-amber-500/30">
          <div className="relative flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-amber-50">{title}</h3>
              <p className="text-xs text-amber-300/70 mt-0.5">Sync stopped to protect your data</p>
            </div>
          </div>
        </div>

        <div
          className="px-6 py-5 space-y-4 max-h-[50vh] overflow-y-auto panel-scroll"
          data-chrome-scroll-ignore="true"
        >
          <p className="text-sm text-text-muted leading-relaxed">{report.message}</p>

          <div className="bg-amber-950/20 border border-amber-500/15 rounded-xl px-4 py-3 space-y-2">
            <p className="text-xs text-amber-200/90 leading-relaxed">{losing}</p>
            <div className="text-[11px] text-text-muted space-y-1 pt-1">
              <div className="flex justify-between gap-3">
                <span>This device last changed</span>
                <span className="font-mono">{formatStamp(report.localStamp)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Cloud copy last changed</span>
                <span className="font-mono">{formatStamp(report.remoteStamp)}</span>
              </div>
            </div>
          </div>

          <p className="text-xs text-text-muted leading-relaxed">
            If you are unsure, cancel and export a local backup first. That keeps a copy of this
            device's data no matter which way you sync afterwards.
          </p>
        </div>

        <div className="px-6 py-4 bg-bg-surface/50 border-t border-border-main flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2.5 rounded-xl text-sm font-medium text-text-muted active:bg-bg-surface-hover transition-all duration-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-amber-600 text-white shadow-lg shadow-amber-500/20 active:scale-[0.97] transition-all duration-300 disabled:opacity-50"
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Working...
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Auto-backup debounce delay: 15 minutes after the last card edit
// ---------------------------------------------------------------------------

const AUTO_BACKUP_DELAY = 900_000;

// ---------------------------------------------------------------------------
// AccountMenu
// ---------------------------------------------------------------------------

export default function AccountMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const [signInError, setSignInError] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deleteSuccess, setDeleteSuccess] = useState(false);

  const {
    user, loading, error, restoring, signIn, signOutAndWipe,
    syncStatus, syncProgress, pushToCloud, pullFromCloud, deleteCloudData,
  } = useCloudSync();

  const {
    replaceState,
    clearState,
    cards,
    projects,
    promptProjects,
    tags,
    deletedHeaderBlocks,
    theme,
    stateVersion,
    lastLocalBackupAt,
    lastCloudSyncAt,
    lastMutatedAt,
    schemaInfo,
  } = useStore();

  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);

  // Why the "back up now, then sign out" route stopped short. This is rendered
  // inside the sign-out sheet itself, because the panel's own error line sits
  // behind that sheet and would never be read.
  const [signOutBackupError, setSignOutBackupError] = useState<string | null>(null);
  const [signingOutAfterBackup, setSigningOutAfterBackup] = useState(false);
  /**
   * Non-fatal note from the last restore — currently "some images could not be
   * recovered". Kept separate from `signInError` because this is not a failed
   * operation and must not be coloured or worded as one.
   */
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  // A sync that was refused as unsafe, awaiting the user's decision.
  const [pendingConflict, setPendingConflict] = useState<{
    report: ConflictReport;
    direction: 'push' | 'pull';
  } | null>(null);

  // Freshest of the two backup routes decides the health state.
  const lastBackupAt = Math.max(lastLocalBackupAt ?? 0, lastCloudSyncAt ?? 0) || undefined;
  const backupIsStale = !lastBackupAt || Date.now() - lastBackupAt > BACKUP_STALE_MS;

  // ---- Debug panel -------------------------------------------------------
  const [showDebug, setShowDebug] = useState(false);
  const [storageEstimate, setStorageEstimate] = useState('\u2014');
  const [vaultSize, setVaultSize] = useState<string | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [copiedDebug, setCopiedDebug] = useState(false);

  useEffect(() => {
    if (!showDebug) return;
    let cancelled = false;
    void (async () => {
      try {
        if (navigator.storage?.estimate) {
          const { usage, quota } = await navigator.storage.estimate();
          if (!cancelled) {
            setStorageEstimate(`${formatBytes(usage)} of ${formatBytes(quota)}`);
          }
        } else if (!cancelled) {
          setStorageEstimate('unavailable');
        }
      } catch {
        if (!cancelled) setStorageEstimate('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showDebug]);

  const imageCount = cards.reduce(
    (n, c) => n + (Array.isArray(c.images) ? c.images.length : 0),
    0,
  );

  // Measured on demand: cards embed base64 images, so stringifying the whole
  // vault can be genuinely expensive and would jank the panel on open.
  const measureVaultSize = () => {
    setMeasuring(true);
    setTimeout(() => {
      try {
        const json = JSON.stringify({ cards, projects, promptProjects, tags, deletedHeaderBlocks });
        setVaultSize(formatBytes(new Blob([json]).size));
      } catch {
        setVaultSize('failed to measure');
      } finally {
        setMeasuring(false);
      }
    }, 0);
  };

  // Scroll-restore evidence (v1.13.0). The log lives in a module-level ring
  // buffer in useViewState, so it survives every unmount along the way — which
  // is the whole point, since the interesting events happen exactly when the
  // list component is being torn down and rebuilt.
  //
  // Re-read whenever the panel opens or the user taps Refresh, rather than
  // subscribing: a live subscription would itself log-and-render in a loop.
  const [scrollLogTick, setScrollLogTick] = useState(0);
  const scrollLogEntries = React.useMemo(
    () => getScrollLog(),
    [showDebug, scrollLogTick],
  );

  const debugRows: Array<[string, string]> = [
    ['Version', APP_VERSION],
    ['Build', BUILD_TIME ? new Date(BUILD_TIME).toLocaleString() : '\u2014'],
    ['Platform', Capacitor.isNativePlatform() ? `native (${Capacitor.getPlatform()})` : 'web'],
    ['Signed in', user ? 'yes' : 'no'],
    ['Theme', theme],
    ['State version', String(stateVersion)],
    ['Cards', String(cards.length)],
    ['Images', String(imageCount)],
    ['Card groups', String(projects.length)],
    ['Prompt folders', String(promptProjects.length)],
    ['Tags', String(tags.length)],
    ['Blocks in bin', String(deletedHeaderBlocks.length)],
    ['Storage used', storageEstimate],
    ['Vault size', vaultSize ?? 'not measured'],
    [
      'Schema',
      schemaInfo.loadedFromVersion === schemaInfo.version
        ? String(schemaInfo.version)
        : `${schemaInfo.version} (migrated from ${schemaInfo.loadedFromVersion})`,
    ],
    ['Last change', lastMutatedAt > 0 ? new Date(lastMutatedAt).toLocaleString() : '\u2014'],
    ['Screen', `${window.innerWidth}\u00d7${window.innerHeight} @${window.devicePixelRatio}x`],
  ];

  const copyDiagnostics = async () => {
    const text = [
      'Roleplay Vault diagnostics',
      ...debugRows.map(([k, v]) => `${k}: ${v}`),
      // Warnings are the only diagnostic that explains WHY the vault looks the
      // way it does after a repair, so they belong in a copied bug report.
      ...(schemaInfo.warnings.length
        ? ['', 'Schema warnings:', ...schemaInfo.warnings.map(w => `- ${w}`)]
        : []),
      `User agent: ${navigator.userAgent}`,
      // The scroll-restore trace is the entire reason this build exists, and
      // copying it out is far more reliable on a phone than transcribing it.
      ...(scrollLogEntries.length
        ? [
            '',
            'Scroll restore log (newest first):',
            ...scrollLogEntries.map(e => `${e.at}ms ${e.event} ${e.key} ${e.detail}`),
          ]
        : ['', 'Scroll restore log: empty']),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedDebug(true);
      setTimeout(() => setCopiedDebug(false), 2000);
    } catch {
      // Clipboard can be unavailable in a WebView without a secure context.
      setCopiedDebug(false);
    }
  };

  const {
    status: localStatus,
    lastError: localError,
    exportVaultToLocal,
    importVaultFromLocal,
    resetStatus: resetLocalStatus,
  } = useLocalBackup();

  // Inject animation keyframes once
  useEffect(() => { injectStyles(); }, []);

  // Combine both error sources so the UI always shows the real message
  const displayError = error || signInError;
  const isSyncing = syncStatus === 'syncing';
  const isLocalBusy = localStatus === 'exporting' || localStatus === 'importing';

  // -----------------------------------------------------------------------
  // Debounced auto-backup: fires 15 minutes after the last card edit,
  // but only when signed in. Watches `cards` directly.
  // -----------------------------------------------------------------------
  const autoBackupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialCardsRef = useRef(cards);

  useEffect(() => {
    // Skip the very first render (initial load from storage)
    if (initialCardsRef.current === cards) return;

    // Only auto-backup when signed in and not currently syncing
    if (!user || isSyncing) return;

    if (autoBackupTimer.current) {
      clearTimeout(autoBackupTimer.current);
    }

    autoBackupTimer.current = setTimeout(() => {
      // Never forced. An automatic background backup must not be allowed to
      // resolve a conflict on the user's behalf; if it is refused, the sync
      // status badge reflects that and the user can decide at the manual
      // Backup button, where the explanation is actually visible.
      void pushToCloud().catch(() => {
        // Silently swallow – the syncStatus badge will show the error
      });
    }, AUTO_BACKUP_DELAY);

    return () => {
      if (autoBackupTimer.current) {
        clearTimeout(autoBackupTimer.current);
      }
    };
  }, [cards, user, isSyncing, pushToCloud]);

  // Lock body scroll when overlay is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isDeleteModalOpen) setOpen(false);
    };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, isDeleteModalOpen]);

  // Auto-clear delete success message
  useEffect(() => {
    if (!deleteSuccess) return;
    const timer = setTimeout(() => setDeleteSuccess(false), 3000);
    return () => clearTimeout(timer);
  }, [deleteSuccess]);

  // Auto-clear local backup status (success/error) after 3 seconds
  useEffect(() => {
    if (localStatus !== 'success' && localStatus !== 'error') return;
    const timer = setTimeout(() => resetLocalStatus(), 3000);
    return () => clearTimeout(timer);
  }, [localStatus, resetLocalStatus]);

  const handleSignIn = useCallback(async () => {
    setSignInError(null);
    try {
      await signIn();
    } catch (err: unknown) {
      let msg: string;
      try {
        if (err instanceof Error) {
          msg = err.message + (err.stack ? '\n\nStack: ' + err.stack : '');
        } else if (typeof err === 'string') {
          msg = err;
        } else {
          msg = JSON.stringify(err, null, 2) || String(err);
        }
      } catch {
        msg = 'Error could not be serialized: ' + Object.prototype.toString.call(err);
      }
      window.alert('[DEBUG] handleSignIn caught:\n' + msg);
      setSignInError(msg);
    }
  }, [signIn]);

  // Signing out WIPES local data (to stop account A's vault bleeding into
  // account B). That makes it the single most destructive action in the app,
  // so it is now gated behind an explicit confirm that offers to back up first.
  const performSignOut = useCallback(async () => {
    // Cancel any pending auto-backup before wiping
    if (autoBackupTimer.current) {
      clearTimeout(autoBackupTimer.current);
      autoBackupTimer.current = null;
    }
    setShowSignOutConfirm(false);
    await signOutAndWipe();
    // Reset React context to empty state so Account A's data
    // cannot accidentally be pushed to Account B's cloud
    clearState();
  }, [signOutAndWipe, clearState]);

  /**
   * What a backup attempt actually did. A caller that chains a destructive
   * step onto a backup has to be able to tell an upload that landed from one
   * that was refused, and neither of those from one that never ran at all.
   */
  type BackupAttempt =
    | { status: 'ok' }
    | { status: 'conflict' }
    | { status: 'busy' }
    | { status: 'failed'; error?: string };

  const runBackup = useCallback(
    async (force: boolean): Promise<BackupAttempt> => {
      // Never fail silently. A tap that does nothing at all is indis-
      // tinguishable from a tap that ran and had no effect, and image
      // splitting made syncs long enough that overlapping taps are easy.
      if (isSyncing) {
        setSignInError(
          'A sync is already running. Wait for it to finish, then try again.',
        );
        return { status: 'busy' };
      }
      const outcome = await pushToCloud({ force });
      if (!outcome.ok && outcome.conflict) {
        setPendingConflict({ report: outcome.conflict, direction: 'push' });
        return { status: 'conflict' };
      }
      setPendingConflict(null);
      if (!outcome.ok) {
        // Surface it on the panel too, the same way a refused restore does.
        if (outcome.error) setSignInError(outcome.error);
        return { status: 'failed', error: outcome.error };
      }
      return { status: 'ok' };
    },
    [isSyncing, pushToCloud],
  );

  const runRestore = useCallback(
    async (force: boolean) => {
      // Same reasoning as runBackup, and it matters more here. This used to
      // return silently: tapping Restore while a backup was still finishing
      // did nothing whatsoever, with no message, so the vault was left
      // untouched and it looked exactly like a restore that had run and
      // failed to remove a card.
      if (isSyncing) {
        setSignInError(
          'A sync is already running. Wait for it to finish, then try again.',
        );
        return;
      }
      setRestoreNotice(null);
      setSignInError(null);
      const outcome = await pullFromCloud({ force });

      if (!outcome.ok && outcome.conflict) {
        setPendingConflict({ report: outcome.conflict, direction: 'pull' });
        return;
      }
      setPendingConflict(null);

      if (outcome.ok && outcome.data) {
        // replaceState validates independently and can refuse. Ignoring its
        // answer would leave localforage holding the restored vault while the
        // UI still showed the old one — the two would silently disagree until
        // the next launch.
        if (!replaceState(outcome.data)) {
          setSignInError(
            'The cloud backup was downloaded but could not be applied. Nothing on this device was changed.',
          );
        } else {
          // Leave any open editor behind. `vaultEpoch` already remounts editor
          // routes so a stale draft cannot autosave itself back over the
          // restore, but stranding the user inside a card that was just
          // replaced underneath them is confusing regardless. Close the panel
          // and return to the main screen so what they see is the restored
          // vault. `replace: true` keeps the pre-restore editor out of history.
          // ...unless the restore came back incomplete. A note the user never
          // sees is the same as no note at all, so when images are missing the
          // panel stays open to say so. They still land on the main screen.
          if (outcome.warnings && outcome.warnings.length > 0) {
            setRestoreNotice(outcome.warnings.join(' '));
          } else {
            setOpen(false);
          }
          navigate('/', { replace: true });
        }
      } else if (outcome.error) {
        setSignInError(outcome.error);
      }
    },
    [isSyncing, pullFromCloud, replaceState, navigate],
  );

  // Wrapped so JSX onClick handlers cannot pass their MouseEvent in as `force`.
  const handleBackup = useCallback(() => { void runBackup(false); }, [runBackup]);
  const handleRestore = useCallback(() => { void runRestore(false); }, [runRestore]);

  /**
   * The careful sign-out route. Sign-out destroys the only local copy, so the
   * wipe has to be strictly downstream of an upload that is *confirmed* to
   * have landed.
   *
   * The original code was `await handleBackup(); await performSignOut();`.
   * `handleBackup` returns void, so that `await` resolved on the next
   * microtask while the upload was still in flight. `performSignOut` then
   * revoked the access token out from under the running push, which died at
   * `requireToken()` with "Not authenticated", and the wipe proceeded anyway.
   * Choosing the safe option was the thing that lost the data.
   */
  const backupThenSignOut = useCallback(async () => {
    setSignOutBackupError(null);
    setSigningOutAfterBackup(true);
    let attempt: BackupAttempt;
    try {
      attempt = await runBackup(false);
    } catch (err: unknown) {
      attempt = {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      setSigningOutAfterBackup(false);
    }

    if (attempt.status === 'ok') {
      await performSignOut();
      return;
    }

    if (attempt.status === 'conflict') {
      // The conflict sheet renders below this one in the stack, so step out of
      // the way and let the user answer it. Sign-out is abandoned and nothing
      // has been erased; they can sign out again once it is settled.
      setShowSignOutConfirm(false);
      return;
    }

    setSignOutBackupError(
      attempt.status === 'busy'
        ? 'A sync is already running. Wait for it to finish and try again \u2014 you are still signed in.'
        : 'The backup did not complete, so you are still signed in and nothing has been erased.' +
          (attempt.error ? ` (${attempt.error})` : ''),
    );
  }, [runBackup, performSignOut]);

  const handleConflictConfirm = useCallback(() => {
    if (!pendingConflict) return;
    const { direction } = pendingConflict;
    setPendingConflict(null);
    if (direction === 'push') {
      void runBackup(true);
    } else {
      void runRestore(true);
    }
  }, [pendingConflict, runBackup, runRestore]);

  const handleDeleteConfirm = useCallback(async () => {
    await deleteCloudData();
    setIsDeleteModalOpen(false);
    setDeleteSuccess(true);
  }, [deleteCloudData]);

  const handleExport = useCallback(() => {
    if (isLocalBusy) return;
    exportVaultToLocal();
  }, [isLocalBusy, exportVaultToLocal]);

  const overlay = (
    <div
      className={`fixed inset-0 z-[9999] isolate ${
        open ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh' }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-hidden="true"
        style={{
          animation: open ? 'accountMenuFadeIn 0.3s ease-out both' : 'accountMenuFadeOut 0.25s ease-in both',
        }}
      />

      {/* Sliding Overlay Panel */}
      <div
        className="account-menu-panel fixed inset-y-0 right-0 w-full max-w-sm bg-bg-surface/95 backdrop-blur-xl z-[10000] flex flex-col shadow-2xl border-l border-border-main"
        style={{
          paddingTop: 'var(--safe-top)',
          paddingBottom: 'var(--safe-bottom)',
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100vh',
          animation: open
            ? 'accountMenuSlideIn 0.4s cubic-bezier(0.16,1,0.3,1) both'
            : 'accountMenuSlideOut 0.3s cubic-bezier(0.4,0,1,1) both',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-main shrink-0 bg-bg-surface/50 backdrop-blur-md">
          <h2 className="text-lg font-semibold text-text-main tracking-tight">Account</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowDebug(true)}
              className="p-2 hover:bg-bg-surface-hover rounded-xl transition-all duration-200 active:scale-90"
              aria-label="Open debug panel"
              title="Debug & diagnostics"
            >
              <SlidersHorizontal className="w-5 h-5 text-text-muted hover:text-text-main transition-colors" />
            </button>
            <button
              onClick={() => setOpen(false)}
              className="p-2 -mr-2 hover:bg-bg-surface-hover rounded-xl transition-all duration-200 active:scale-90"
              aria-label="Close account menu"
            >
              <X className="w-5 h-5 text-text-muted hover:text-text-main transition-colors" />
            </button>
          </div>
        </div>

        {/* Debug & diagnostics — hidden behind the control icon in the header.
            Sits above the account panel (z-10000) so it is never clipped. */}
        {showDebug && (
          <div
            className="fixed inset-0 z-[10001] bg-bg-main flex flex-col"
            style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
            role="dialog"
            aria-modal="true"
            aria-label="Debug and diagnostics"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-main shrink-0">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight">Debug</h2>
                <p className="text-xs text-text-muted">Roleplay Vault v{APP_VERSION}</p>
              </div>
              <button
                onClick={() => setShowDebug(false)}
                className="p-2 -mr-2 hover:bg-bg-surface-hover rounded-xl transition-all active:scale-90"
                aria-label="Close debug panel"
              >
                <X className="w-5 h-5 text-text-muted" />
              </button>
            </div>

            <div className="flex-1 panel-scroll p-5 space-y-5" data-chrome-scroll-ignore="true">
              <div className="rounded-2xl border border-border-main overflow-hidden">
                {debugRows.map(([label, value], i) => (
                  <div
                    key={label}
                    className={`flex items-start justify-between gap-4 px-4 py-2.5 text-sm ${
                      i % 2 ? 'bg-bg-surface/40' : ''
                    }`}
                  >
                    <span className="text-text-muted shrink-0">{label}</span>
                    <span className="text-text-main font-medium text-right break-all">{value}</span>
                  </div>
                ))}
              </div>

              {/* ---- Scroll restore log (v1.13.0 instrumentation) ---- */}
              <div className="rounded-2xl border border-border-main overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border-main">
                  <span className="text-sm font-medium">Scroll restore log</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setScrollLogTick(t => t + 1)}
                      className="px-2.5 py-1.5 rounded-lg border border-border-main text-xs font-medium active:scale-95 transition-transform"
                    >
                      Refresh
                    </button>
                    <button
                      onClick={() => {
                        clearScrollLog();
                        setScrollLogTick(t => t + 1);
                      }}
                      className="px-2.5 py-1.5 rounded-lg border border-border-main text-xs font-medium active:scale-95 transition-transform"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                {scrollLogEntries.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-text-muted leading-relaxed">
                    Empty. Tap Clear, scroll a list, open a folder or card, come back, then
                    reopen this panel and tap Refresh.
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto" data-chrome-scroll-ignore="true">
                    {scrollLogEntries.map((e, i) => (
                      <div
                        key={`${e.at}-${i}`}
                        className={`px-4 py-2 text-[11px] leading-snug font-mono break-all ${
                          i % 2 ? 'bg-bg-surface/40' : ''
                        }`}
                      >
                        <span className="text-text-muted">{e.at}ms </span>
                        <span className="text-text-main font-semibold">{e.event}</span>
                        <span className="text-text-muted"> {e.key}</span>
                        {e.detail ? <span className="text-text-main"> {e.detail}</span> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <button
                  onClick={measureVaultSize}
                  disabled={measuring}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-border-main hover:bg-bg-surface-hover transition-colors text-sm font-medium disabled:opacity-50"
                >
                  {measuring ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4" />
                  )}
                  {measuring ? 'Measuring…' : 'Measure vault size'}
                </button>

                <button
                  onClick={() => void copyDiagnostics()}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-border-main hover:bg-bg-surface-hover transition-colors text-sm font-medium"
                >
                  {copiedDebug ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                  {copiedDebug ? 'Copied' : 'Copy diagnostics'}
                </button>

                <button
                  onClick={() => window.location.reload()}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-border-main hover:bg-bg-surface-hover transition-colors text-sm font-medium"
                >
                  <RefreshCw className="w-4 h-4" />
                  Reload app
                </button>
              </div>

              <p className="text-xs text-text-muted leading-relaxed">
                These values are read-only diagnostics. “Copy diagnostics” puts this table plus
                your device user-agent on the clipboard — handy for bug reports. Nothing here
                modifies or deletes your vault.
              </p>
            </div>
          </div>
        )}

        {/* Sign-out confirm. Sign-out wipes local data, so never do it in one
            tap — offer a backup first. */}
        {showSignOutConfirm && (
          <div className="fixed inset-0 z-[10001] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
            <div className="bg-bg-surface rounded-2xl border border-border-main shadow-2xl w-full max-w-sm p-6">
              <div className="flex items-center gap-2 mb-3">
                <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
                <h3 className="text-lg font-semibold text-text-main">Sign out?</h3>
              </div>
              <p className="text-sm text-text-muted leading-relaxed">
                Signing out <strong className="text-text-main">erases this vault from this device</strong>.
                Your Google Drive copy is kept, but anything newer than your last backup will be lost.
              </p>
              <p
                className={`mt-3 text-sm rounded-xl px-3 py-2 ${
                  backupIsStale
                    ? 'bg-amber-500/10 border border-amber-500/30 text-amber-300'
                    : 'bg-bg-surface-hover/40 border border-border-main text-text-muted'
                }`}
              >
                {lastBackupAt
                  ? `Last backed up ${formatRelativeTime(lastBackupAt)}.`
                  : 'This vault has never been backed up.'}
              </p>

              {signOutBackupError && (
                <p className="mt-3 text-sm rounded-xl px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 break-words">
                  {signOutBackupError}
                </p>
              )}

              <div className="mt-5 space-y-2">
                <button
                  onClick={() => void backupThenSignOut()}
                  disabled={isSyncing || signingOutAfterBackup}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-accent text-white font-medium text-sm disabled:opacity-50 active:scale-[0.98] transition-all"
                >
                  {isSyncing || signingOutAfterBackup ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
                  {isSyncing || signingOutAfterBackup ? 'Backing up…' : 'Back up now, then sign out'}
                </button>
                <button
                  onClick={() => void performSignOut()}
                  disabled={isSyncing || signingOutAfterBackup}
                  className="w-full px-4 py-3 rounded-xl border border-red-500/30 text-red-400 active:bg-red-500/10 font-medium text-sm disabled:opacity-50 transition-colors"
                >
                  Sign out without backing up
                </button>
                <button
                  onClick={() => { setSignOutBackupError(null); setShowSignOutConfirm(false); }}
                  disabled={signingOutAfterBackup}
                  className="w-full px-4 py-3 rounded-xl border border-border-main text-text-muted active:bg-bg-surface-hover font-medium text-sm disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Content */}
        {/* `panel-scroll` adds overscroll-behavior: contain so this scroller
            no longer chains into the page behind it, and
            data-chrome-scroll-ignore stops it from driving the page's
            hide-on-scroll header / bottom nav. */}
        <div className="flex-1 panel-scroll p-5 space-y-6" data-chrome-scroll-ignore="true">

          {/* Show a subtle loading state while silently restoring session */}
          {restoring && !user && (
            <div className="flex flex-col items-center text-center pt-8 pb-4">
              <Loader2 className="w-8 h-8 text-accent animate-spin mb-4" />
              <p className="text-text-muted text-sm">Restoring session...</p>
            </div>
          )}

          {!restoring && user ? (
            <div className="flex flex-col items-center text-center pt-4 pb-2">
              {/* Avatar with animated gradient ring */}
              <div
                className="relative w-22 h-22 rounded-full p-[3px] mb-4"
                style={{
                  background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 70%, white), var(--accent))',
                  backgroundSize: '300% 300%',
                  animation: 'avatarRingPulse 3s ease-in-out infinite',
                  width: '88px',
                  height: '88px',
                }}
              >
                <div className="w-full h-full rounded-full overflow-hidden bg-bg-main">
                  {user.photoUrl ? (
                    <img
                      src={user.photoUrl}
                      alt={user.displayName}
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-full h-full bg-bg-surface-hover flex items-center justify-center">
                      <User className="w-10 h-10 text-text-muted" />
                    </div>
                  )}
                </div>
              </div>

              <h3 className="text-xl font-bold text-text-main tracking-tight">{user.displayName}</h3>
              <p className="text-sm text-text-muted mt-1 font-mono">{user.email}</p>

              {/* Backup health — surfaces how long the vault has gone unprotected. */}
              <div
                className={`mt-5 w-full rounded-2xl border px-4 py-3 text-left ${
                  backupIsStale
                    ? 'border-amber-500/30 bg-amber-500/10'
                    : 'border-border-main bg-bg-surface-hover/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  {backupIsStale ? (
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                  )}
                  <span className="text-sm font-medium text-text-main">
                    {lastBackupAt ? `Last backed up ${formatRelativeTime(lastBackupAt)}` : 'Never backed up'}
                  </span>
                </div>
                <div className="mt-2 space-y-1 text-xs text-text-muted">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3 shrink-0" />
                    <span>Cloud: {formatRelativeTime(lastCloudSyncAt)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3 shrink-0" />
                    <span>Local file: {formatRelativeTime(lastLocalBackupAt)}</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => { setSignOutBackupError(null); setShowSignOutConfirm(true); }}
                disabled={loading}
                className="mt-5 flex items-center gap-2 px-5 py-2.5 rounded-xl border border-border-main bg-bg-surface-hover/30 text-text-muted hover:bg-bg-surface-hover hover:text-text-main hover:border-border-main transition-all duration-300 disabled:opacity-50 active:scale-[0.97]"
              >
                <LogOut className="w-4 h-4" />
                <span className="text-sm font-medium">Sign Out</span>
              </button>
            </div>
          ) : !restoring ? (
            <div className="flex flex-col items-center text-center pt-8 pb-4">
              <div
                className="w-20 h-20 rounded-full bg-gradient-to-br from-bg-surface-hover to-bg-surface border border-border-main flex items-center justify-center mb-5"
                style={{ animation: 'cardStagger 0.4s ease-out both' }}
              >
                <User className="w-10 h-10 text-text-muted" />
              </div>
              <p className="text-text-muted text-sm mb-6 max-w-[240px] leading-relaxed">
                Sign in with your Google account to back up and restore your vault data across devices.
              </p>

              {displayError && (
                <div
                  className="flex items-center gap-2 mb-4 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 max-w-[280px] backdrop-blur-sm"
                  style={{ animation: 'cardStagger 0.3s ease-out both' }}
                >
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-red-400 text-xs text-left break-all">{displayError}</p>
                </div>
              )}

              <button
                onClick={handleSignIn}
                disabled={loading}
                className="relative flex items-center gap-3 px-6 py-3 rounded-xl bg-accent text-white font-semibold shadow-lg shadow-accent/25 hover:shadow-accent/40 hover:brightness-110 active:scale-[0.97] transition-all duration-300 disabled:opacity-50"
                style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
              >
                {loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                    <path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" opacity=".8" />
                    <path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" opacity=".6" />
                    <path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" opacity=".4" />
                  </svg>
                )}
                <span>Sign in with Google</span>
              </button>
            </div>
          ) : null}

          {user && (
            <>
              {/* Section divider - Cloud Sync */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border-main" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-bg-surface/95 px-3 text-xs font-semibold text-text-muted uppercase tracking-widest">Cloud Sync</span>
                </div>
              </div>

              {/* Cloud Action Cards */}
              <div className="space-y-3">
                <ActionCard
                  icon={CloudUpload}
                  title="Backup to Cloud"
                  subtitle="Upload your vault to Google Drive"
                  onClick={handleBackup}
                  disabled={isSyncing}
                  isSyncing={isSyncing && syncStatus === 'syncing'}
                  delay={0}
                />

                <ActionCard
                  icon={CloudDownload}
                  title="Restore from Cloud"
                  subtitle="Replace local data with cloud backup"
                  onClick={handleRestore}
                  disabled={isSyncing}
                  isSyncing={isSyncing && syncStatus === 'syncing'}
                  delay={80}
                />

                <ActionCard
                  icon={Trash2}
                  title="Delete Cloud Data"
                  subtitle="Permanently erase your remote backup"
                  onClick={() => setIsDeleteModalOpen(true)}
                  disabled={isSyncing}
                  variant="danger"
                  delay={160}
                />

                {/* Status badge */}
                <div className="px-1 pt-1">
                  <SyncStatusBadge status={syncStatus} progress={syncProgress} />
                </div>

                {/* Incomplete-restore note */}
                {restoreNotice && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-200/90">{restoreNotice}</p>
                  </div>
                )}

                {/* Delete success message */}
                {deleteSuccess && (
                  <div
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20"
                    style={{ animation: 'successPulse 0.5s ease-out both' }}
                  >
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm text-emerald-300">Cloud data deleted successfully</span>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Local Data section – always visible, works without sign-in */}
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border-main" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-bg-surface/95 px-3 text-xs font-semibold text-text-muted uppercase tracking-widest">Local Data</span>
              </div>
            </div>

            <div className="space-y-3">
              <ActionCard
                icon={Download}
                title="Export Vault to File"
                subtitle="Save a JSON backup to your device"
                onClick={handleExport}
                disabled={isLocalBusy}
                isSyncing={localStatus === 'exporting'}
                delay={0}
              />

              {/* Hidden file input that the label-based ActionCard triggers */}
              <input
                id="vault-import-input"
                type="file"
                accept="application/json"
                onChange={importVaultFromLocal}
                className="sr-only"
                disabled={isLocalBusy}
              />

              <ActionCard
                icon={Upload}
                title="Import Vault from File"
                subtitle="Overwrite local data with a JSON backup"
                asLabel
                htmlFor="vault-import-input"
                disabled={isLocalBusy}
                isSyncing={localStatus === 'importing'}
                delay={80}
              />

              {/* Status badge */}
              <div className="px-1 pt-1">
                <LocalBackupBadge status={localStatus} error={localError} />
              </div>
            </div>
          </>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-main shrink-0 bg-bg-surface/50 backdrop-blur-md">
          <p className="text-xs text-text-muted text-center">
            Your data is stored privately in your Google Drive.
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Trigger: Profile Avatar stays in the header */}
      <button
        onClick={() => setOpen(true)}
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 overflow-hidden border-2 border-border-main hover:border-accent/70 transition-all duration-300 ml-auto hover:shadow-lg hover:shadow-accent/10 active:scale-95"
        aria-label="Open account menu"
      >
        {user?.photoUrl ? (
          <img
            src={user.photoUrl}
            alt={user.displayName}
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-full h-full bg-bg-surface-hover flex items-center justify-center">
            <User className="w-5 h-5 text-text-muted" />
          </div>
        )}
      </button>

      {/* Portal: render overlay on document.body to escape header stacking context */}
      {createPortal(overlay, document.body)}

      {/* Delete Confirmation Modal */}
      <SyncConflictModal
        isOpen={pendingConflict !== null}
        report={pendingConflict?.report ?? null}
        direction={pendingConflict?.direction ?? 'push'}
        busy={isSyncing}
        onCancel={() => setPendingConflict(null)}
        onConfirm={handleConflictConfirm}
      />

      <DeleteConfirmModal
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirm={handleDeleteConfirm}
        isDeleting={isSyncing}
      />
    </>
  );
}
