import { Tag } from './types';

/**
 * The starter tag set.
 *
 * Extracted out of `store.tsx` in v1.3.0 so that `schema.ts` can use it as the
 * empty-tags fallback without importing the store — the store imports the
 * schema, so the reverse edge would be a cycle. `store.tsx` re-exports this
 * symbol, so existing `import { DEFAULT_TAGS } from '../store'` call sites
 * (currently `useLocalBackup`) keep working unchanged.
 */
export const DEFAULT_TAGS: Tag[] = [
  { id: '1', name: 'Fantasy', color: 'bg-red-500' },
  { id: '2', name: 'Sci-Fi', color: 'bg-accent' },
  { id: '3', name: 'Modern', color: 'bg-green-500' },
  { id: '4', name: 'Historical', color: 'bg-yellow-500' },
  { id: '5', name: 'Horror', color: 'bg-purple-500' },
  { id: '6', name: 'Romance', color: 'bg-pink-500' },
  { id: '7', name: 'Action', color: 'bg-orange-500' },
  { id: '8', name: 'Mystery', color: 'bg-teal-500' },
  { id: '9', name: 'Slice of Life', color: 'bg-indigo-500' },
  { id: '10', name: 'Magic', color: 'bg-violet-500' },
  { id: '11', name: 'Cyberpunk', color: 'bg-cyan-500' },
  { id: '12', name: 'Steampunk', color: 'bg-amber-500' },
  { id: '13', name: 'Post-Apocalyptic', color: 'bg-stone-500' },
  { id: '14', name: 'Superhero', color: 'bg-rose-500' },
  { id: '15', name: 'Supernatural', color: 'bg-fuchsia-500' },
  { id: '16', name: 'Mythology', color: 'bg-emerald-500' },
  { id: '17', name: 'Space Opera', color: 'bg-sky-500' },
  { id: '18', name: 'Urban Fantasy', color: 'bg-lime-500' },
  { id: '19', name: 'Dystopian', color: 'bg-zinc-500' },
  { id: '20', name: 'Isekai', color: 'bg-slate-500' },
];
