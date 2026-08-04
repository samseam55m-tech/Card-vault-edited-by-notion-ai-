import { HardDrive, CloudOff, Download, ShieldCheck } from 'lucide-react';
import { useStore } from '../store';

/**
 * First-run explainer.
 *
 * The vault is local-only until the user signs in, and signing out wipes the
 * device copy. That is a genuinely surprising data model, so it is stated
 * up front rather than discovered after data loss.
 *
 * Visibility is driven by the persisted `hasOnboarded` flag. Existing users
 * are treated as already-onboarded (see the load path in store.tsx), so this
 * only ever appears on a genuinely fresh install.
 */
export default function Onboarding() {
  const { hasOnboarded, loading, setOnboarded } = useStore();

  // Wait for the store to hydrate, otherwise this flashes on every cold start
  // before `hasOnboarded` has been read back from storage.
  if (loading || hasOnboarded) return null;

  const points = [
    {
      icon: HardDrive,
      title: 'Your vault lives on this device',
      body: 'Cards, prompts and images are stored locally. Nothing is uploaded anywhere until you choose to sign in.',
    },
    {
      icon: CloudOff,
      title: 'Works completely offline',
      body: 'No account required. Signing in with Google is optional and only adds backup and sync.',
    },
    {
      icon: Download,
      title: 'Back up regularly',
      body: 'Export a backup file from the account panel, or sign in to sync to Google Drive. Uninstalling the app removes local data.',
    },
    {
      icon: ShieldCheck,
      title: 'Signing out clears this device',
      body: 'That keeps accounts from mixing. The app will always offer to back up first.',
    },
  ];

  return (
    <div
      className="fixed inset-0 z-[12000] bg-bg-main flex flex-col"
      style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome"
    >
      <div className="flex-1 panel-scroll px-6 pt-10 pb-6" data-chrome-scroll-ignore="true">
        <h1 className="text-3xl font-bold tracking-tight text-text-main">Roleplay Vault</h1>
        <p className="mt-2 text-sm text-text-muted leading-relaxed">
          A few things worth knowing before you start.
        </p>

        <div className="mt-8 space-y-5">
          {points.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex gap-4">
              <div className="w-10 h-10 shrink-0 rounded-xl bg-bg-surface border border-border-main flex items-center justify-center">
                <Icon className="w-5 h-5 text-accent" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-main">{title}</h2>
                <p className="mt-1 text-sm text-text-muted leading-relaxed">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="px-6 pb-4 pt-2 shrink-0 border-t border-border-main">
        <button
          onClick={() => void setOnboarded()}
          className="w-full px-4 py-3.5 rounded-xl bg-accent text-white font-semibold text-sm active:scale-[0.98] transition-transform"
        >
          Get started
        </button>
      </div>
    </div>
  );
}
