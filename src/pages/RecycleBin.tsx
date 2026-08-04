import React, { useState, useMemo } from 'react';
import { useStore } from '../store';
import { Trash2, Image as ImageIcon, FileText, AlignLeft } from 'lucide-react';
import { cn } from '../utils';
import ConfirmModal from '../components/ConfirmModal';
import { RecycleBinItem } from '../components/RecycleBinItem';

export default function RecycleBin() {
  const { cards, promptProjects, deletedHeaderBlocks, updateCard, updatePromptProject, deleteCard, deletePromptProject, updateDeletedHeaderBlocks } = useStore();
  const [activeTab, setActiveTab] = useState<'cards' | 'prompts' | 'blocks'>('cards');
  const [blockSubTab, setBlockSubTab] = useState<'card' | 'prompt'>('card');
  
  const [itemToDelete, setItemToDelete] = useState<{ id: string, type: 'card' | 'prompt' | 'block' } | null>(null);
  const [isEmptyingBin, setIsEmptyingBin] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const deletedCards = useMemo(() => cards.filter(c => c.deletedAt), [cards]);
  const deletedPrompts = useMemo(() => promptProjects.filter(p => p.deletedAt), [promptProjects]);
  const deletedCardBlocks = useMemo(() => deletedHeaderBlocks.filter(b => b.sourceType === 'card'), [deletedHeaderBlocks]);
  const deletedPromptBlocks = useMemo(() => deletedHeaderBlocks.filter(b => b.sourceType === 'prompt'), [deletedHeaderBlocks]);

  const getDaysRemaining = (deletedAt: number) => {
    const daysPassed = Math.floor((Date.now() - deletedAt) / (1000 * 60 * 60 * 24));
    return Math.max(0, 90 - daysPassed);
  };

  const handleRestoreCard = React.useCallback(async (id: string) => {
    const card = cards.find(c => c.id === id);
    if (card) {
      await updateCard({ ...card, deletedAt: undefined });
    }
  }, [cards, updateCard]);

  const handleRestorePrompt = React.useCallback(async (id: string) => {
    const project = promptProjects.find(p => p.id === id);
    if (project) {
      await updatePromptProject({ ...project, deletedAt: undefined });
    }
  }, [promptProjects, updatePromptProject]);

  const handleRestoreBlock = React.useCallback(async (id: string) => {
    const block = deletedHeaderBlocks.find(b => b.id === id);
    if (!block) return;

    // Track whether the block actually made it back to a parent. Previously the
    // block was removed from the bin unconditionally, so if the source card or
    // prompt had been permanently deleted the block was silently destroyed:
    // it vanished from the bin and was never restored anywhere.
    let restored = false;

    if (block.sourceType === 'card') {
      const card = cards.find(c => c.id === block.sourceId);
      if (card) {
        const { deletedAt, sourceId, sourceType, ...restBlock } = block;
        // Don't create a duplicate if the block is somehow already present.
        const alreadyThere = (card.headerBlocks || []).some(b => b.id === restBlock.id);
        await updateCard({
          ...card,
          deletedAt: undefined, // Nested recovery: restore the parent card too
          headerBlocks: alreadyThere
            ? (card.headerBlocks || [])
            : [...(card.headerBlocks || []), restBlock]
        });
        restored = true;
      }
    } else {
      const project = promptProjects.find(p => p.id === block.sourceId);
      if (project) {
        const { deletedAt, sourceId, sourceType, ...restBlock } = block;
        const alreadyThere = (project.blocks || []).some(b => b.id === restBlock.id);
        await updatePromptProject({
          ...project,
          deletedAt: undefined, // Nested recovery: restore the parent prompt too
          blocks: alreadyThere
            ? (project.blocks || [])
            : [...(project.blocks || []), restBlock]
        });
        restored = true;
      }
    }

    if (!restored) {
      // Keep the block in the bin so the user doesn't lose it.
      setRestoreError(
        block.sourceType === 'card'
          ? 'The card this block came from no longer exists, so it cannot be restored. Recreate the card first.'
          : 'The prompt folder this block came from no longer exists, so it cannot be restored. Recreate the folder first.'
      );
      return;
    }

    await updateDeletedHeaderBlocks(deletedHeaderBlocks.filter(b => b.id !== id));
  }, [deletedHeaderBlocks, cards, promptProjects, updateCard, updatePromptProject, updateDeletedHeaderBlocks]);

  const handleDeleteItem = React.useCallback((id: string, type: 'card' | 'prompt' | 'block') => {
    setItemToDelete({ id, type });
  }, []);

  const handleHardDelete = async () => {
    if (!itemToDelete) return;
    
    if (itemToDelete.type === 'card') {
      await deleteCard(itemToDelete.id);
    } else if (itemToDelete.type === 'prompt') {
      await deletePromptProject(itemToDelete.id);
    } else if (itemToDelete.type === 'block') {
      await updateDeletedHeaderBlocks(deletedHeaderBlocks.filter(b => b.id !== itemToDelete.id));
    }
    
    setItemToDelete(null);
  };

  const handleEmptyBin = async () => {
    if (activeTab === 'cards') {
      for (const card of deletedCards) {
        await deleteCard(card.id);
      }
    } else if (activeTab === 'prompts') {
      for (const prompt of deletedPrompts) {
        await deletePromptProject(prompt.id);
      }
    } else if (activeTab === 'blocks') {
      const remainingBlocks = deletedHeaderBlocks.filter(b => b.sourceType !== blockSubTab);
      await updateDeletedHeaderBlocks(remainingBlocks);
    }
    setIsEmptyingBin(false);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* This page had NO top offset at all, so the app header sat directly on
          top of the Cards / Prompts / Blocks tab switcher. That is why the
          "Blocks" tab (where deleted header blocks live) looked missing — it
          was rendered underneath the header and could not be tapped. */}
      <div
        className="px-4 pb-4 flex items-center justify-end shrink-0 border-b border-border-main overflow-x-auto scrollbar-hide"
        style={{ paddingTop: 'calc(var(--app-header-h) + 16px)' }}
      >
        <div className="flex bg-bg-surface rounded-xl p-1 border border-border-main shrink-0">
          <button
            onClick={() => setActiveTab('cards')}
            className={cn(
              "px-4 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2",
              activeTab === 'cards' ? "bg-bg-surface-hover text-text-main" : "text-text-muted hover:text-text-main"
            )}
          >
            <FileText className="w-4 h-4" />
            Cards
          </button>
          <button
            onClick={() => setActiveTab('prompts')}
            className={cn(
              "px-4 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2",
              activeTab === 'prompts' ? "bg-bg-surface-hover text-text-main" : "text-text-muted hover:text-text-main"
            )}
          >
            <ImageIcon className="w-4 h-4" />
            Prompts
          </button>
          <button
            onClick={() => setActiveTab('blocks')}
            className={cn(
              "px-4 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2",
              activeTab === 'blocks' ? "bg-bg-surface-hover text-text-main" : "text-text-muted hover:text-text-main"
            )}
          >
            <AlignLeft className="w-4 h-4" />
            Blocks
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto p-4"
        style={{ paddingBottom: 'var(--page-pad-bottom)' }}
      >
        {activeTab === 'cards' && (
          <div className="space-y-3">
            <div className="flex justify-between items-center mb-4">
              <p className="text-sm text-text-muted">Items are kept for 90 days before permanent deletion.</p>
              {deletedCards.length > 0 && (
                <button 
                  onClick={() => setIsEmptyingBin(true)}
                  className="text-sm text-red-400 hover:text-red-300 transition-colors"
                >
                  Empty Recycle Bin
                </button>
              )}
            </div>
            
            {deletedCards.length === 0 ? (
              <div className="text-center text-text-muted mt-20">
                <Trash2 className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="font-medium">No deleted cards</p>
                <p className="text-sm mt-1 opacity-70">Deleted cards will appear here for 90 days.</p>
              </div>
            ) : (
              deletedCards.map(card => (
                <RecycleBinItem
                  key={card.id}
                  item={card}
                  type="card"
                  daysRemaining={getDaysRemaining(card.deletedAt!)}
                  onRestore={handleRestoreCard}
                  onDelete={handleDeleteItem}
                />
              ))
            )}
          </div>
        )}

        {activeTab === 'prompts' && (
          <div className="space-y-3">
            <div className="flex justify-between items-center mb-4">
              <p className="text-sm text-text-muted">Items are kept for 90 days before permanent deletion.</p>
              {deletedPrompts.length > 0 && (
                <button 
                  onClick={() => setIsEmptyingBin(true)}
                  className="text-sm text-red-400 hover:text-red-300 transition-colors"
                >
                  Empty Recycle Bin
                </button>
              )}
            </div>
            
            {deletedPrompts.length === 0 ? (
              <div className="text-center text-text-muted mt-20">
                <Trash2 className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="font-medium">No deleted prompt projects</p>
                <p className="text-sm mt-1 opacity-70">Deleted prompts will appear here for 90 days.</p>
              </div>
            ) : (
              deletedPrompts.map(project => (
                <RecycleBinItem
                  key={project.id}
                  item={project}
                  type="prompt"
                  daysRemaining={getDaysRemaining(project.deletedAt!)}
                  onRestore={handleRestorePrompt}
                  onDelete={handleDeleteItem}
                />
              ))
            )}
          </div>
        )}

        {activeTab === 'blocks' && (
          <div className="space-y-3">
            {restoreError && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
              >
                <span className="flex-1">{restoreError}</span>
                <button
                  onClick={() => setRestoreError(null)}
                  className="shrink-0 font-medium text-red-200 hover:text-white transition-colors"
                  aria-label="Dismiss"
                >
                  Dismiss
                </button>
              </div>
            )}
            <div className="flex justify-between items-center mb-4">
              <div className="flex bg-bg-surface rounded-xl p-1 border border-border-main">
                <button
                  onClick={() => setBlockSubTab('card')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-colors",
                    blockSubTab === 'card' ? "bg-bg-surface-hover text-text-main" : "text-text-muted hover:text-text-main"
                  )}
                >
                  Entry Page
                </button>
                <button
                  onClick={() => setBlockSubTab('prompt')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-sm font-medium transition-colors",
                    blockSubTab === 'prompt' ? "bg-bg-surface-hover text-text-main" : "text-text-muted hover:text-text-main"
                  )}
                >
                  Prompt Gallery
                </button>
              </div>
              
              {(blockSubTab === 'card' ? deletedCardBlocks : deletedPromptBlocks).length > 0 && (
                <button 
                  onClick={() => setIsEmptyingBin(true)}
                  className="text-sm text-red-400 hover:text-red-300 transition-colors"
                >
                  Empty Recycle Bin
                </button>
              )}
            </div>
            
            {(blockSubTab === 'card' ? deletedCardBlocks : deletedPromptBlocks).length === 0 ? (
              <div className="text-center text-text-muted mt-20">
                <Trash2 className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="font-medium">No deleted header blocks</p>
                <p className="text-sm mt-1 opacity-70">Deleted blocks will appear here for 90 days.</p>
              </div>
            ) : (
              (blockSubTab === 'card' ? deletedCardBlocks : deletedPromptBlocks).map(block => {
                const sourceName = block.sourceType === 'card' 
                  ? cards.find(c => c.id === block.sourceId)?.name || 'Unknown Card'
                  : promptProjects.find(p => p.id === block.sourceId)?.name || 'Unknown Prompt';
                  
                return (
                  <RecycleBinItem
                    key={block.id}
                    item={{ ...block, name: `${block.title || 'Untitled Block'} (From: ${sourceName})` }}
                    type="block"
                    daysRemaining={getDaysRemaining(block.deletedAt!)}
                    onRestore={handleRestoreBlock}
                    onDelete={handleDeleteItem}
                  />
                );
              })
            )}
          </div>
        )}
      </div>

      <ConfirmModal 
        isOpen={!!itemToDelete || isEmptyingBin}
        title={isEmptyingBin ? "Empty Recycle Bin" : "Delete Permanently"}
        message={isEmptyingBin ? "Permanently delete all items in Recycle Bin? This cannot be undone." : "Permanently delete this block? This cannot be undone."}
        confirmText="Delete Permanently"
        onConfirm={isEmptyingBin ? handleEmptyBin : handleHardDelete}
        onCancel={() => {
          setItemToDelete(null);
          setIsEmptyingBin(false);
        }}
      />
    </div>
  );
}
