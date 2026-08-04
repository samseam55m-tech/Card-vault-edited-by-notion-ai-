import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, ArrowLeft, GripVertical, Trash2, History, Save, ChevronDown, ChevronRight, Copy, Check, Maximize2, Minimize2, Undo2, Redo2, X } from 'lucide-react';
import { useStore } from '../store';
import { generateId, cn, useUndoRedo, haptics } from '../utils';
import { HeaderBlock, PromptHistory } from '../types';
import ConfirmModal from '../components/ConfirmModal';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion, AnimatePresence } from 'motion/react';

import { useInView } from 'react-intersection-observer';

interface SortableBlockProps {
  key?: string | number;
  block: HeaderBlock;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  onUpdate: (id: string, updates: Partial<HeaderBlock>) => void;
  onDelete: (id: string) => void;
  onCopy: (e: React.MouseEvent, block: HeaderBlock) => void | Promise<void>;
  isCopied: boolean;
  onExpand: (id: string) => void;
  isFullScreen: boolean;
}

const SortableBlock = React.memo(function SortableBlock({ block, isExpanded, onToggle, onUpdate, onDelete, onCopy, isCopied, onExpand, isFullScreen }: SortableBlockProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });

  const [showDeleteVariationConfirm, setShowDeleteVariationConfirm] = useState(false);

  const { ref: inViewRef, inView } = useInView({
    rootMargin: '600px 0px',
    triggerOnce: false,
  });

  const [blockHeight, setBlockHeight] = useState<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (inView && contentRef.current) {
      const observer = new ResizeObserver((entries) => {
        for (let entry of entries) {
          setBlockHeight(entry.contentRect.height);
        }
      });
      observer.observe(contentRef.current);
      return () => observer.disconnect();
    }
  }, [inView]);

  const setRefs = (node: HTMLElement | null) => {
    setNodeRef(node);
    inViewRef(node);
  };

  const style = {
    transform: isFullScreen ? undefined : CSS.Transform.toString(transform),
    transition: isFullScreen ? undefined : transition,
    zIndex: isFullScreen ? 100 : (isDragging ? 50 : 1),
    minHeight: blockHeight ? `${blockHeight}px` : '72px',
  };

  const variations = block.variations || [{ id: 'default', name: 'V1', content: block.content }];
  const activeVariationId = block.activeVariationId || variations[0].id;

  const [variationContents, setVariationContents] = useState<Record<string, string>>(() => {
    const contents: Record<string, string> = {};
    variations.forEach(v => {
      contents[v.id] = v.content;
    });
    return contents;
  });

  const activeContent = variationContents[activeVariationId] ?? '';

  const { state: contentState, set: setContentState, undo, redo, reset, canUndo, canRedo } = useUndoRedo(activeContent);

  // Sync undo/redo state when switching tabs
  useEffect(() => {
    reset(variationContents[activeVariationId] ?? '');
  }, [activeVariationId]);

  const saveToParent = (contents: Record<string, string>) => {
    if (activeVariationId === 'default' && variations.length === 1) {
      onUpdate(block.id, { content: contents['default'] });
    } else {
      const newVariations = variations.map(v => 
        ({ ...v, content: contents[v.id] ?? v.content })
      );
      onUpdate(block.id, { variations: newVariations });
    }
  };

  const handleContentChange = (content: string) => {
    setContentState(content);
    const newContents = { ...variationContents, [activeVariationId]: content };
    setVariationContents(newContents);
    saveToParent(newContents);
  };

  const handleUndo = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newState = undo();
    if (newState !== undefined) {
      const newContents = { ...variationContents, [activeVariationId]: newState };
      setVariationContents(newContents);
      saveToParent(newContents);
    }
  };

  const handleRedo = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newState = redo();
    if (newState !== undefined) {
      const newContents = { ...variationContents, [activeVariationId]: newState };
      setVariationContents(newContents);
      saveToParent(newContents);
    }
  };

  const handleAddVariation = (e: React.MouseEvent) => {
    e.stopPropagation();
    // High-water-mark: compute next number from stored counter or fallback to scanning existing names
    const currentMax = block.nextVariationNumber || Math.max(1, ...variations.map(v => {
      const match = v.name.match(/^V(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    }));
    const nextNum = currentMax + 1;
    const newVariation = {
      id: generateId(),
      name: `V${nextNum}`,
      content: ''
    };
    
    const newContents = { ...variationContents, [newVariation.id]: '' };
    setVariationContents(newContents);
    
    const newVariations = [...variations.map(v => ({ ...v, content: newContents[v.id] ?? v.content })), newVariation];
    
    onUpdate(block.id, {
      variations: newVariations,
      activeVariationId: newVariation.id,
      nextVariationNumber: nextNum
    });
  };

  const handleVariationChange = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onUpdate(block.id, { activeVariationId: id });
  };

  const handleDeleteVariation = () => {
    if (variations.length <= 1) return;
    
    const newVariations = variations.filter(v => v.id !== activeVariationId).map(v => ({ ...v, content: variationContents[v.id] ?? v.content }));
    const newActiveId = newVariations[0].id;
    
    // Preserve the high-water-mark counter (do NOT decrement on delete)
    onUpdate(block.id, {
      variations: newVariations,
      activeVariationId: newActiveId
    });
    setShowDeleteVariationConfirm(false);
  };

  return (
    <div 
      ref={setRefs} 
      style={style}
      className={cn(
        "bg-bg-surface/80 backdrop-blur-md border rounded-3xl overflow-hidden transition-all mx-2 sm:mx-8 shadow-lg relative",
        block.isSwapped ? "border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.1)]" : 
        block.isOriginal ? "border-accent/50 shadow-[0_0_15px_rgba(59,130,246,0.1)]" : 
        "border-border-main",
        isDragging ? "opacity-80 scale-[1.02] shadow-2xl" : "",
        isFullScreen ? "fixed inset-4 z-[100] flex flex-col m-0" : ""
      )}
    >
      {inView || isFullScreen ? (
        <div ref={contentRef} className="flex flex-col h-full">
          <div 
            {...attributes} 
            {...listeners}
            className={cn(
              "p-4 flex flex-col cursor-pointer hover:bg-bg-surface-hover/50 transition-colors shrink-0 touch-pan-y",
              isFullScreen ? "pt-[calc(1rem+var(--safe-top))]" : ""
            )}
            onClick={() => onToggle(block.id)}
          >
        <div className="flex items-center justify-between">
          <div className="flex items-center flex-1">
            {isExpanded || isFullScreen ? <ChevronDown className="w-5 h-5 text-text-muted mr-3" /> : <ChevronRight className="w-5 h-5 text-text-muted mr-3" />}
            <input
              type="text"
              value={block.title}
              onChange={(e) => onUpdate(block.id, { title: e.target.value })}
              onClick={e => e.stopPropagation()}
              onPointerDown={e => e.stopPropagation()}
              className="text-xl font-semibold bg-transparent border-none focus:outline-none focus:ring-0 w-full text-text-main"
              placeholder="Block Title"
            />
            
            {block.isSwapped && (
              <span className="text-[10px] uppercase tracking-wider font-bold bg-amber-500/20 text-amber-400 px-2 py-1 rounded-md ml-2 shrink-0">
                Restored
              </span>
            )}
            {block.isOriginal && (
              <span className="text-[10px] uppercase tracking-wider font-bold bg-accent/20 text-blue-400 px-2 py-1 rounded-md ml-2 shrink-0">
                Original
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0 ml-4">
            {(isExpanded || isFullScreen) && (
              <>
                <button
                  onClick={handleUndo}
                  onPointerDown={e => e.stopPropagation()}
                  disabled={!canUndo}
                  className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-xl transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                  title="Undo"
                >
                  <Undo2 className="w-5 h-5" />
                </button>
                <button
                  onClick={handleRedo}
                  onPointerDown={e => e.stopPropagation()}
                  disabled={!canRedo}
                  className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-xl transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                  title="Redo"
                >
                  <Redo2 className="w-5 h-5" />
                </button>
                <div className="w-px h-6 bg-bg-surface-hover mx-1" />
              </>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); onExpand(block.id); }}
              onPointerDown={e => e.stopPropagation()}
              className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-xl transition-colors"
              title={isFullScreen ? "Minimize" : "Expand"}
            >
              {isFullScreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
            <button
              onClick={(e) => onCopy(e, block)}
              onPointerDown={e => e.stopPropagation()}
              className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-xl transition-colors"
              title="Copy content"
            >
              {isCopied ? <Check className="w-5 h-5 text-green-400" /> : <Copy className="w-5 h-5" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}
              onPointerDown={e => e.stopPropagation()}
              className="p-2 text-text-muted hover:text-red-400 hover:bg-bg-surface-hover rounded-xl transition-colors"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>
        
        {(isExpanded || isFullScreen) && (
          <div className="flex items-center gap-2 mt-3 ml-10 overflow-x-auto scrollbar-hide">
            {variations.map(v => (
              <button
                key={v.id}
                onClick={(e) => handleVariationChange(v.id, e)}
                className={cn(
                  "px-3 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap",
                  activeVariationId === v.id 
                    ? "bg-text-main text-bg-main" 
                    : "bg-bg-surface-hover text-text-muted hover:bg-bg-surface-hover hover:text-text-secondary"
                )}
              >
                {v.name}
              </button>
            ))}
            <button
              onClick={handleAddVariation}
              className="p-1 rounded-lg bg-bg-surface-hover text-text-muted hover:bg-bg-surface-hover hover:text-text-secondary transition-colors shrink-0"
              title="Add Variation"
            >
              <Plus className="w-4 h-4" />
            </button>
            {variations.length > 1 && (
              (() => {
                const activeVariation = variations.find(v => v.id === activeVariationId);
                const isV1Active = activeVariation?.name === 'V1';
                return (
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowDeleteVariationConfirm(true); }}
                    disabled={isV1Active}
                    className={cn(
                      "p-1 rounded-lg bg-bg-surface-hover transition-colors shrink-0",
                      isV1Active
                        ? "text-text-muted/30 cursor-not-allowed"
                        : "text-text-muted hover:bg-red-500/20 hover:text-red-400"
                    )}
                    title={isV1Active ? "V1 is the base variation and cannot be deleted" : "Delete Current Variation"}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                );
              })()
            )}
          </div>
        )}
      </div>
      
      <AnimatePresence>
        {(isExpanded || isFullScreen) && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className={cn("overflow-hidden flex flex-col", isFullScreen ? "flex-1" : "")}
          >
            <div className={cn("p-5 pt-0 border-t border-border-main/50 mt-2 relative flex flex-col", isFullScreen ? "flex-1" : "")}>
              <div className="absolute left-5 top-6 bottom-5 w-0.5 bg-bg-surface-hover rounded-full" />
              <textarea
                value={contentState}
                onChange={(e) => handleContentChange(e.target.value)}
                className={cn(
                  "w-full bg-transparent border-none focus:outline-none focus:ring-0 text-text-secondary resize-y mt-4 pl-6 font-mono text-sm leading-relaxed",
                  isFullScreen ? "flex-1 resize-none" : "min-h-[200px]"
                )}
                placeholder="Enter content here..."
                maxLength={20000}
              />
              <div className={cn(
                "flex justify-between items-center mt-2",
                isFullScreen ? "pb-[calc(0.5rem+var(--safe-bottom))] border-b border-border-main/50" : ""
              )}>
                <div className="text-xs text-text-muted">
                  {block.copyCount ? `Copied ${block.copyCount} times (Last: ${block.lastCopiedVariation || 'V1'})` : 'Never copied'}
                </div>
                <div className="text-right text-xs text-text-muted font-mono shrink-0">
                  {contentState.length} / 20,000
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
      ) : null}

      <ConfirmModal 
        isOpen={showDeleteVariationConfirm}
        title="Delete Variation"
        message={`Are you sure you want to delete this variation? This action cannot be undone.`}
        confirmText="Delete"
        onConfirm={handleDeleteVariation}
        onCancel={() => setShowDeleteVariationConfirm(false)}
      />
    </div>
  );
});

export default function PromptDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { promptProjects, updatePromptProject, addDeletedHeaderBlock } = useStore();
  
  const project = promptProjects.find(p => p.id === id);
  
  const [blocks, setBlocks] = useState<HeaderBlock[]>([]);
  const [history, setHistory] = useState<PromptHistory[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
  const hasInitializedExpanded = useRef(false);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [fullScreenBlockId, setFullScreenBlockId] = useState<string | null>(null);
  
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | number | null>(null);
  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    if (project) {
      // Sort blocks by order if available
      const sortedBlocks = [...(project.blocks || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
      setBlocks(sortedBlocks);
      setHistory(project.history || []);
      
      if (!hasInitializedExpanded.current && sortedBlocks.length > 0) {
        setExpandedBlocks(new Set(sortedBlocks.map(b => b.id)));
        hasInitializedExpanded.current = true;
      }
    }
  }, [project]);

  if (!project) {
    return (
      <div className="flex-1 flex flex-col h-full bg-bg-main items-center justify-center text-text-muted">
        <p>Project not found or loading...</p>
        <button onClick={() => navigate('/prompts')} className="mt-4 px-4 py-2 bg-bg-surface-hover rounded-lg text-text-main">Go Back</button>
      </div>
    );
  }

  const handleAddBlock = () => {
    const newBlock: HeaderBlock = {
      id: generateId(),
      title: 'New Block',
      content: '',
      order: blocks.length,
    };
    setBlocks([...blocks, newBlock]);
    setExpandedBlocks(prev => new Set(prev).add(newBlock.id));
    setHasUnsavedChanges(true);
  };

  const handleUpdateBlock = React.useCallback((id: string, updates: Partial<HeaderBlock>) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, ...updates } : b));
    setHasUnsavedChanges(true);
  }, []);

  const confirmDeleteBlock = async () => {
    if (blockToDelete) {
      const block = blocks.find(b => b.id === blockToDelete);
      if (block) {
        await addDeletedHeaderBlock({
          ...block,
          deletedAt: Date.now(),
          sourceId: project.id,
          sourceType: 'prompt'
        });
      }
      setBlocks(blocks.filter(b => b.id !== blockToDelete));
      setHasUnsavedChanges(true);
      setBlockToDelete(null);
    }
  };

  const toggleBlock = React.useCallback((id: string) => {
    setExpandedBlocks(prev => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(id)) {
        newExpanded.delete(id);
      } else {
        newExpanded.add(id);
      }
      return newExpanded;
    });
  }, []);

  const copyToClipboard = React.useCallback(async (e: React.MouseEvent, block: HeaderBlock) => {
    e.stopPropagation();
    try {
      const variations = block.variations || [{ id: 'default', name: 'V1', content: block.content }];
      const activeVariationId = block.activeVariationId || variations[0].id;
      const activeVariation = variations.find(v => v.id === activeVariationId) || variations[0];

      await navigator.clipboard.writeText(activeVariation.content);
      setCopiedId(block.id);
      
      setBlocks(prevBlocks => {
        const newBlocks = prevBlocks.map(b => {
          if (b.id === block.id) {
            if (activeVariationId === 'default') {
              return {
                ...b,
                copyCount: (b.copyCount || 0) + 1,
                lastCopiedVariation: 'V1'
              };
            } else {
              const newVariations = variations.map(v => 
                v.id === activeVariationId ? { ...v, copyCount: (v.copyCount || 0) + 1 } : v
              );
              
              return {
                ...b,
                variations: newVariations,
                lastCopiedVariation: activeVariation.name
              };
            }
          }
          return b;
        });
        
        // Save immediately to update statistics without marking as unsaved
        if (project) {
          updatePromptProject({
            ...project,
            blocks: newBlocks
          }).catch(err => console.error('Failed to update project stats: ', err));
        }
        
        return newBlocks;
      });
      
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  }, [project, updatePromptProject]);

  const handleDeleteBlock = React.useCallback((id: string) => {
    setBlockToDelete(id);
  }, []);

  const handleExpandBlock = React.useCallback((id: string) => {
    setFullScreenBlockId(prev => prev === id ? null : id);
  }, []);

  const handleDragStart = () => {
    haptics.medium();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    haptics.light();
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setBlocks((items) => {
        const oldIndex = items.findIndex(item => item.id === active.id);
        const newIndex = items.findIndex(item => item.id === over.id);
        
        const newItems = arrayMove(items, oldIndex, newIndex);
        // Update order property
        return newItems.map((item: HeaderBlock, index: number) => ({ ...item, order: index }));
      });
      setHasUnsavedChanges(true);
    }
  };

  const handleSave = async () => {
    if (!project) return;
    
    const newHistoryEntry: PromptHistory = {
      id: generateId(),
      date: Date.now(),
      blocks: project.blocks 
    };
    
    const newHistory = [newHistoryEntry, ...history].slice(0, 3);
    const cleanBlocks = blocks.map(b => ({ ...b, isSwapped: false, isOriginal: false }));
    
    await updatePromptProject({
      ...project,
      blocks: cleanBlocks,
      history: newHistory
    });
    
    setBlocks(cleanBlocks);
    setHistory(newHistory);
    setHasUnsavedChanges(false);
  };

  const handleSwapHistory = (historyEntry: PromptHistory) => {
    const markedCurrentBlocks = blocks.map(b => ({ ...b, isOriginal: true, isSwapped: false }));
    
    const newHistoryEntry: PromptHistory = {
      id: generateId(),
      date: Date.now(),
      blocks: markedCurrentBlocks
    };
    
    const newBlocks = historyEntry.blocks.map(b => ({ ...b, isSwapped: true, isOriginal: false }));
    const newHistory = [newHistoryEntry, ...history.filter(h => h.id !== historyEntry.id)].slice(0, 3);
    
    setBlocks(newBlocks);
    setHistory(newHistory);
    setHasUnsavedChanges(true);
    setShowHistory(false);
  };

  const handleBack = () => {
    if (hasUnsavedChanges) {
      setPendingNavigation(-1);
      setShowUnsavedModal(true);
    } else {
      navigate(-1);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-bg-main relative">
      {fullScreenBlockId && (
        <div className="fixed inset-0 bg-black/80 z-[90] backdrop-blur-sm" onClick={() => setFullScreenBlockId(null)} />
      )}
      
      {/* This header is `sticky top-0` inside a container that starts at the
          very top of the viewport, while the app header is an absolute overlay.
          Without the safe-area + header offset it rendered underneath the app
          header — this is the overlap seen when opening a prompt folder. */}
      <header
        className="flex items-center justify-between px-4 pb-3 border-b border-border-main bg-bg-main sticky top-0 z-40 shrink-0"
        style={{ paddingTop: 'calc(var(--app-header-h) + 12px)' }}
      >
        <div className="flex items-center gap-4 min-w-0">
          <button 
            onClick={handleBack}
            className="p-2 hover:bg-bg-surface-hover rounded-lg transition-colors shrink-0"
            aria-label="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* Folder name removed here — the app header breadcrumb already shows it. */}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              showHistory ? "bg-bg-surface-hover text-text-main" : "text-text-muted hover:bg-bg-surface-hover hover:text-text-main"
            )}
          >
            <History className="w-4 h-4" />
            <span className="hidden sm:inline">History</span>
          </button>
          <button
            onClick={handleSave}
            disabled={!hasUnsavedChanges}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              hasUnsavedChanges 
                ? "bg-text-main text-bg-main hover:bg-text-secondary" 
                : "bg-bg-surface-hover text-text-muted cursor-not-allowed"
            )}
          >
            <Save className="w-4 h-4" />
            <span className="hidden sm:inline">Save</span>
          </button>
        </div>
      </header>

      <div
        className="flex-1 overflow-y-auto p-4"
        style={{ paddingBottom: 'calc(var(--safe-bottom) + 96px)' }}
      >
        <div className="flex-1 max-w-3xl mx-auto space-y-4">
          {blocks.length === 0 ? (
            <div className="text-center text-text-muted mt-20">
              <Plus className="w-16 h-16 mx-auto mb-4 opacity-20" />
              <p className="font-medium text-base">No blocks yet</p>
              <p className="text-sm mt-1 opacity-70">Tap + to add your first block.</p>
            </div>
          ) : (
            <DndContext 
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <SortableContext 
                items={blocks.map(b => b.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-4">
                  {blocks.map((block) => (
                    <SortableBlock
                      key={block.id}
                      block={block}
                      isExpanded={expandedBlocks.has(block.id)}
                      onToggle={toggleBlock}
                      onUpdate={handleUpdateBlock}
                      onDelete={handleDeleteBlock}
                      onCopy={copyToClipboard}
                      isCopied={copiedId === block.id}
                      onExpand={handleExpandBlock}
                      isFullScreen={fullScreenBlockId === block.id}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      {/* A4: History as full-screen modal overlay */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[290]"
              onClick={() => setShowHistory(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 40 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
              /* Was z-[85], below the z-100 app header, so the top of the panel
                 was hidden underneath it. Modals sit above all app chrome. */
              className="fixed inset-4 z-[300] bg-bg-surface border border-border-main rounded-2xl shadow-2xl flex flex-col overflow-hidden"
              style={{ top: 'calc(16px + var(--safe-top))', bottom: 'calc(16px + var(--safe-bottom))' }}
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-border-main shrink-0">
                <h3 className="font-semibold text-lg flex items-center gap-2">
                  <History className="w-5 h-5 text-text-muted" />
                  Version History
                </h3>
                <button 
                  onClick={() => setShowHistory(false)} 
                  className="p-2 hover:bg-bg-surface-hover rounded-full transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="flex-1 panel-scroll p-6" data-chrome-scroll-ignore="true">
                {history.length === 0 ? (
                  <div className="text-center text-text-muted mt-10">
                    <History className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p className="text-sm">No history available yet.</p>
                    <p className="text-xs mt-1 opacity-70">Save changes to create history.</p>
                  </div>
                ) : (
                  <div className="space-y-4 max-w-md mx-auto">
                    {history.map((h) => (
                      <div key={h.id} className="bg-bg-main border border-border-main rounded-xl p-5">
                        <div className="flex items-center justify-between mb-4">
                          <span className="text-sm font-medium text-text-main">
                            {new Date(h.date).toLocaleString()}
                          </span>
                          <span className="text-xs bg-bg-surface-hover px-3 py-1.5 rounded-lg text-text-muted font-medium">
                            {h.blocks.length} blocks
                          </span>
                        </div>
                        <button
                          onClick={() => handleSwapHistory(h)}
                          className="w-full py-2.5 bg-accent/10 hover:bg-accent/20 text-accent text-sm font-semibold rounded-xl transition-colors"
                        >
                          Restore this version
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Floating Action Button */}
      <button 
        onClick={handleAddBlock}
        className="fab-button bg-text-main text-bg-main"
      >
        <Plus className="w-8 h-8" />
      </button>

      <ConfirmModal 
        isOpen={showUnsavedModal}
        title="Unsaved Changes"
        message="You have unsaved changes. Are you sure you want to leave without saving?"
        confirmText="Leave without saving"
        onConfirm={() => {
          setShowUnsavedModal(false);
          if (pendingNavigation !== null) navigate(pendingNavigation as any);
        }}
        onCancel={() => {
          setShowUnsavedModal(false);
          setPendingNavigation(null);
        }}
      />

      <ConfirmModal
        isOpen={!!blockToDelete}
        title="Delete Block"
        message="Are you sure you want to delete this block? It will be moved to the recycle bin."
        confirmText="Delete"
        onConfirm={confirmDeleteBlock}
        onCancel={() => setBlockToDelete(null)}
      />
    </div>
  );
}
