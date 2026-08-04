import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { Card, HeaderBlock, Tag, CardVariation } from '../types';
import { generateId, compressImage, cn, useUndoRedo } from '../utils';
import { Plus, X, ChevronLeft, ChevronRight, ChevronDown, Copy, Check, ImagePlus, Tag as TagIcon, Maximize, Minimize, Trash2, ZoomIn, Star, GripVertical, Undo2, Redo2 } from 'lucide-react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion, AnimatePresence } from 'motion/react';
import { useSwipeable } from 'react-swipeable';
import { useDebounce } from 'use-debounce';
import ConfirmModal from '../components/ConfirmModal';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Capacitor } from '@capacitor/core';

import { useInView } from 'react-intersection-observer';

/**
 * Save an image to the device.
 *
 * The old implementation created an <a download> element and clicked it. That
 * silently does nothing inside an Android WebView (Capacitor): the `download`
 * attribute is not honoured, so the button appeared to do nothing at all.
 *
 * On native we now write the decoded bytes to the app cache directory and hand
 * the file URI to the OS share sheet, which is the same pattern the vault
 * backup export already uses. The anchor fallback is kept for the web build.
 */
async function saveImage(dataUrl: string, baseName: string): Promise<void> {
  const safeName = (baseName || 'image').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);

  // Derive the real extension/mime from the data URL instead of always
  // claiming ".png" like the old code did.
  const match = /^data:([^;,]+)[^,]*,/.exec(dataUrl);
  const mime = match?.[1] || 'image/png';
  const ext = mime.split('/')[1]?.split('+')[0] || 'png';
  const fileName = `${safeName}.${ext}`;

  if (!Capacitor.isNativePlatform()) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return;
  }

  try {
    // Filesystem.writeFile expects bare base64 (no "data:...;base64," prefix).
    const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;

    const { uri } = await Filesystem.writeFile({
      path: fileName,
      data: base64,
      directory: Directory.Cache,
    });

    await Share.share({
      title: 'Save image',
      url: uri,
      dialogTitle: 'Save or share image',
    });
  } catch (err) {
    console.error('[EntryPage] image save failed:', err);
  }
}

// A2: Zoom modal with swipe gestures
function ZoomModal({ images, currentIndex, onClose, onIndexChange }: {
  images: string[];
  currentIndex: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [scale, setScale] = useState(1);
  const startTouch = useRef<{ x: number; y: number; time: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      startTouch.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now(),
      };
      setIsDragging(true);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!startTouch.current || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startTouch.current.x;
    const dy = e.touches[0].clientY - startTouch.current.y;
    
    if (Math.abs(dy) > Math.abs(dx) && dy > 0) {
      setDragY(dy);
      setDragX(0);
    } else {
      setDragX(dx);
      setDragY(0);
    }
  };

  const handleTouchEnd = () => {
    if (!startTouch.current) return;
    const elapsed = Date.now() - startTouch.current.time;
    const velocity = Math.abs(dragX) / Math.max(elapsed, 1);
    
    // Swipe down to dismiss
    if (dragY > 100) {
      onClose();
      return;
    }
    
    // Horizontal swipe
    if (Math.abs(dragX) > 60 || velocity > 0.5) {
      if (dragX < 0 && currentIndex < images.length - 1) {
        onIndexChange(currentIndex + 1);
      } else if (dragX > 0 && currentIndex > 0) {
        onIndexChange(currentIndex - 1);
      }
    }
    
    setDragX(0);
    setDragY(0);
    setIsDragging(false);
    startTouch.current = null;
  };

  const dismissOpacity = Math.max(0, 1 - dragY / 300);
  const dismissScale = Math.max(0.8, 1 - dragY / 1000);

  return (
    <div className="zoom-modal" style={{ opacity: dismissOpacity }}>
      <button 
        onClick={onClose}
        className="absolute top-6 right-6 p-3 bg-white/10 text-white rounded-full hover:bg-white/20 transition-colors z-50"
        style={{ top: 'calc(24px + var(--safe-top))' }}
      >
        <X className="w-6 h-6" />
      </button>
      
      <div 
        ref={containerRef}
        className="zoom-image-container"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <img 
          src={images[currentIndex]} 
          alt="Zoomed Gallery" 
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
          style={{
            transform: `translateX(${dragX}px) translateY(${dragY}px) scale(${dismissScale * scale})`,
            transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      </div>
      
      {/* Dot indicators */}
      {images.length > 1 && (
        <div className="zoom-dots">
          {images.map((_, i) => (
            <div
              key={i}
              className={`zoom-dot ${i === currentIndex ? 'active' : ''}`}
              onClick={() => onIndexChange(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const TAG_COLORS = [
  // Primary
  'bg-blue-400', 'bg-accent', 'bg-blue-600',
  'bg-indigo-400', 'bg-indigo-500', 'bg-indigo-600',
  'bg-violet-400', 'bg-violet-500', 'bg-violet-600',
  'bg-purple-400', 'bg-purple-500', 'bg-purple-600',
  'bg-fuchsia-400', 'bg-fuchsia-500', 'bg-fuchsia-600',
  // Secondary
  'bg-pink-400', 'bg-pink-500', 'bg-pink-600',
  'bg-rose-400', 'bg-rose-500', 'bg-rose-600',
  'bg-red-400', 'bg-red-500', 'bg-red-600',
  'bg-orange-400', 'bg-orange-500', 'bg-orange-600',
  'bg-amber-400', 'bg-amber-500', 'bg-amber-600',
  'bg-yellow-400', 'bg-yellow-500', 'bg-yellow-600',
  // Tertiary
  'bg-lime-400', 'bg-lime-500', 'bg-lime-600',
  'bg-green-400', 'bg-green-500', 'bg-green-600',
  'bg-emerald-400', 'bg-emerald-500', 'bg-emerald-600',
  'bg-teal-400', 'bg-teal-500', 'bg-teal-600',
  'bg-cyan-400', 'bg-cyan-500', 'bg-cyan-600',
  'bg-sky-400', 'bg-sky-500', 'bg-sky-600',
  // Neutral
  'bg-slate-400', 'bg-slate-500', 'bg-slate-600',
  'bg-zinc-400', 'bg-zinc-500', 'bg-zinc-600',
  'bg-neutral-400', 'bg-neutral-500', 'bg-neutral-600',
  'bg-stone-400', 'bg-stone-500', 'bg-stone-600'
];

interface SortableHeaderBlockItemProps {
  key?: string | number;
  block: HeaderBlock;
  onUpdate: (id: string, u: Partial<HeaderBlock>) => void;
  onRemove: (id: string) => void;
  isFullScreen: boolean;
  onExpand: (id: string) => void;
}

const SortableHeaderBlockItem = React.memo(function SortableHeaderBlockItem({ block, onUpdate, onRemove, isFullScreen, onExpand }: SortableHeaderBlockItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDeleteVariationConfirm, setShowDeleteVariationConfirm] = useState(false);
  const [localTitle, setLocalTitle] = useState(block.title);

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

  useEffect(() => {
    setLocalTitle(block.title);
  }, [block.title]);

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

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = activeContent;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    if (navigator.vibrate) navigator.vibrate(50);
    
    if (activeVariationId === 'default') {
      onUpdate(block.id, { 
        copyCount: (block.copyCount || 0) + 1,
        lastCopiedVariation: 'V1'
      });
    } else {
      const newVariations = variations.map(v => 
        v.id === activeVariationId ? { ...v, copyCount: (v.copyCount || 0) + 1 } : v
      );
      
      onUpdate(block.id, { 
        variations: newVariations,
        lastCopiedVariation: variations.find(v => v.id === activeVariationId)?.name || 'V1'
      });
    }
    
    setTimeout(() => setCopied(false), 2000);
  };

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
        "bg-bg-surface/80 backdrop-blur-md border border-border-main rounded-3xl overflow-hidden transition-all mx-2 sm:mx-8 shadow-lg relative header-block-container",
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
              "p-4 flex flex-col cursor-grab active:cursor-grabbing hover:bg-bg-surface-hover/50 transition-colors shrink-0 touch-pan-y",
              isFullScreen ? "pt-[calc(1rem+var(--safe-top))]" : ""
            )}
            onClick={() => setExpanded(!expanded)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center flex-1">
                {expanded || isFullScreen ? <ChevronDown className="w-5 h-5 text-text-muted mr-3" /> : <ChevronRight className="w-5 h-5 text-text-muted mr-3" />}
                <input 
                  type="text"
                  value={localTitle}
                  onChange={e => setLocalTitle(e.target.value)}
                  onBlur={() => onUpdate(block.id, { title: localTitle })}
                  onClick={e => e.stopPropagation()}
                  onPointerDown={e => e.stopPropagation()}
                  className="text-xl font-semibold bg-transparent border-none focus:outline-none focus:ring-0 w-full text-text-main cursor-text"
                  placeholder="Header block"
                />
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                {(expanded || isFullScreen) && (
                  <>
                    <button
                      onClick={handleUndo}
                      disabled={!canUndo}
                      className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-xl transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                      title="Undo"
                    >
                      <Undo2 className="w-5 h-5" />
                    </button>
                    <button
                      onClick={handleRedo}
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
                  className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-xl transition-colors"
                  title={isFullScreen ? "Minimize" : "Expand"}
                >
                  {isFullScreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                </button>
                <button 
                  onClick={handleCopy}
                  className="p-2 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-xl transition-colors"
                  title="Copy content"
                >
                  {copied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); onRemove(block.id); }}
                  className="p-2 text-text-muted hover:text-red-400 hover:bg-bg-surface-hover rounded-xl transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            
            {(expanded || isFullScreen) && (
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
            {(expanded || isFullScreen) && (
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
                    onChange={e => handleContentChange(e.target.value)}
                    onKeyDown={e => e.stopPropagation()}
                    placeholder="Type anything here..."
                    maxLength={20000}
                    className={cn(
                      "w-full bg-transparent border-none focus:outline-none focus:ring-0 text-text-secondary resize-y mt-4 pl-6 font-mono text-sm leading-relaxed",
                      isFullScreen ? "flex-1 resize-none" : "min-h-[200px]"
                    )}
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

export default function EntryPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { cards, tags, addCard, updateCard, addTag, deleteTag, deleteCard, addDeletedHeaderBlock } = useStore();
  
  const [name, setName] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [summary, setSummary] = useState('');
  const [mainTag, setMainTag] = useState<string | undefined>(undefined);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [headerBlocks, setHeaderBlocks] = useState<HeaderBlock[]>([]);
  const [variations, setVariations] = useState<CardVariation[]>([]);
  const [activeVariationId, setActiveVariationId] = useState<string>('default');
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  
  const [showTagModal, setShowTagModal] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0]);
  const [showDeleteTagConfirm, setShowDeleteTagConfirm] = useState(false);
  const [tagToDelete, setTagToDelete] = useState<string | null>(null);
  
  const [imageFit, setImageFit] = useState<'cover' | 'contain'>('cover');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteCardVariationConfirm, setShowDeleteCardVariationConfirm] = useState(false);
  const [showZoomModal, setShowZoomModal] = useState(false);
  // The image overlay controls used to be `opacity-0 group-hover:opacity-100`,
  // which can never become visible on a touch device (there is no hover). Tap
  // the image to toggle them instead.
  const [showImageControls, setShowImageControls] = useState(false);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [fullScreenBlockId, setFullScreenBlockId] = useState<string | null>(null);
  const [genCounter, setGenCounter] = useState<number>(1);
  const savedDefaultBlocksRef = useRef<HeaderBlock[]>([]);
  const variationsRef = useRef<CardVariation[]>([]);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const imageSwipeHandlers = useSwipeable({
    onSwipedLeft: () => setCurrentImageIndex(prev => Math.min(images.length - 1, prev + 1)),
    onSwipedRight: () => setCurrentImageIndex(prev => Math.max(0, prev - 1)),
    trackMouse: true,
    preventScrollOnSwipe: true,
  });

  // Auto-save logic.
  //
  // 1000ms was long enough that tapping back beat the save and triggered the
  // "unsaved changes" prompt. 120ms is short enough to feel instantaneous the
  // way a notes app does, while still collapsing a burst of keystrokes into a
  // single write. The store adds its own 500ms debounce before touching disk,
  // so this does NOT mean a disk write per keystroke.
  const AUTOSAVE_DEBOUNCE_MS = 120;
  const [debouncedName] = useDebounce(name, AUTOSAVE_DEBOUNCE_MS);
  const [debouncedSummary] = useDebounce(summary, AUTOSAVE_DEBOUNCE_MS);
  const [debouncedHeaderBlocks] = useDebounce(headerBlocks, AUTOSAVE_DEBOUNCE_MS);
  const [debouncedVariations] = useDebounce(variations, AUTOSAVE_DEBOUNCE_MS);
  const [debouncedActiveVariationId] = useDebounce(activeVariationId, AUTOSAVE_DEBOUNCE_MS);
  const [debouncedTags] = useDebounce(selectedTags, AUTOSAVE_DEBOUNCE_MS);
  const [debouncedImages] = useDebounce(images, AUTOSAVE_DEBOUNCE_MS);

  const isInitialMount = useRef(true);
  const currentCardId = useRef(id || generateId());
  const cardsRef = useRef(cards);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    if (id && isInitialMount.current) {
      const card = cards.find(c => c.id === id);
      if (card) {
        setName(card.name);
        setImages(card.images || []);
        setSummary(card.summary);
        setMainTag(card.mainTag);
        setSelectedTags(card.tags || []);
        
        const cardVariations = card.variations || [];
        setVariations(cardVariations);
        variationsRef.current = cardVariations;
        const activeId = card.activeVariationId || 'default';
        setActiveVariationId(activeId);
        
        // Initialize generation counter from saved card or compute from existing variations
        // Floor of 1 accounts for the implicit G1 (Default) tab
        const savedGenNum = card.nextGenerationNumber || Math.max(1, ...(cardVariations.map(v => {
          const match = v.name.match(/^G(\d+)/);
          return match ? parseInt(match[1], 10) : 0;
        })));
        setGenCounter(savedGenNum);
        
        let blocksToLoad = card.headerBlocks || [];
        if (activeId !== 'default') {
          const activeVar = cardVariations.find(v => v.id === activeId);
          if (activeVar) blocksToLoad = activeVar.headerBlocks;
        }
        
        const sortedBlocks = [...blocksToLoad].sort((a, b) => (a.order || 0) - (b.order || 0));
        setHeaderBlocks(sortedBlocks);
        savedDefaultBlocksRef.current = card.headerBlocks || [];
      }
    }
  }, [id]); // Removed cards from dependency array to prevent infinite loop


  // Track unsaved changes
  useEffect(() => {
    if (isInitialMount.current) return;
    setHasUnsavedChanges(true);
  }, [name, summary, images, selectedTags, mainTag, headerBlocks, variations, activeVariationId]);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (!debouncedName.trim()) return;

    const saveCard = async () => {
      setSaveStatus('saving');
      try {
        const existingCard = cardsRef.current?.find(c => c.id === currentCardId.current);
        const cardData: Card = {
          id: currentCardId.current,
          name: debouncedName,
          images: debouncedImages,
          summary: debouncedSummary,
          mainTag,
          tags: debouncedTags,
          headerBlocks: debouncedActiveVariationId === 'default' ? debouncedHeaderBlocks : savedDefaultBlocksRef.current,
          variations: debouncedActiveVariationId === 'default' 
            ? debouncedVariations 
            : debouncedVariations.map(v => v.id === debouncedActiveVariationId ? { ...v, headerBlocks: debouncedHeaderBlocks } : v),
          activeVariationId: debouncedActiveVariationId,
          nextGenerationNumber: genCounter,
          createdAt: id ? (cardsRef.current?.find(c => c.id === id)?.createdAt || Date.now()) : Date.now(),
          updatedAt: Date.now(),
          isPinned: existingCard?.isPinned || false,
        };

        // Opening a card seeds this editor's local state from the store, and
        // that seeding registers as a change — which is why the entry page
        // fired a save the moment it was opened, every single time, whether or
        // not anything had been edited. Compare against the stored record and
        // skip writes that would not alter it. `updatedAt` is excluded because
        // it is generated fresh above and would never match.
        const unchanged =
          existingCard &&
          JSON.stringify({ ...existingCard, updatedAt: 0 }) ===
            JSON.stringify({ ...cardData, updatedAt: 0 });
        if (unchanged) {
          setHasUnsavedChanges(false);
          setSaveStatus('idle');
          return;
        }

        const exists = cardsRef.current.some(c => c.id === currentCardId.current);
        if (exists) {
          await updateCard(cardData);
        } else {
          await addCard(cardData);
        }
        setHasUnsavedChanges(false);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } catch (err) {
        console.error('Auto-save failed:', err);
        setSaveStatus('idle');
      }
    };

    saveCard();
  }, [debouncedName, debouncedSummary, debouncedHeaderBlocks, debouncedTags, debouncedImages, mainTag, debouncedVariations, debouncedActiveVariationId]);

  const toggleFullScreenBlock = React.useCallback((id: string) => {
    setFullScreenBlockId(prev => prev === id ? null : id);
  }, []);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files) as File[];
      const compressedImages = await Promise.all(files.map(f => compressImage(f, 1200, 0.7)));
      setImages(prev => [...prev, ...compressedImages]);
    }
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
    if (currentImageIndex >= images.length - 1) {
      setCurrentImageIndex(Math.max(0, images.length - 2));
    }
  };

  const addHeaderBlock = React.useCallback(() => {
    setHeaderBlocks(prev => [...prev, { id: generateId(), title: 'New Block', content: '', order: prev.length }]);
  }, []);

  const updateHeaderBlock = React.useCallback((id: string, updates: Partial<HeaderBlock>) => {
    setHeaderBlocks(prev => prev.map(b => b.id === id ? { ...b, ...updates } : b));
  }, []);

  const [blockToDelete, setBlockToDelete] = useState<string | null>(null);

  const removeHeaderBlock = React.useCallback((id: string) => {
    setBlockToDelete(id);
  }, []);

  const confirmDeleteBlock = async () => {
    if (blockToDelete) {
      const block = headerBlocks.find(b => b.id === blockToDelete);
      if (block) {
        await addDeletedHeaderBlock({
          ...block,
          deletedAt: Date.now(),
          sourceId: currentCardId.current,
          sourceType: 'card'
        });
      }
      setHeaderBlocks(prev => prev.filter(b => b.id !== blockToDelete));
      setBlockToDelete(null);
    }
  };

  // Writes the CURRENT, non-debounced state straight through. Used when
  // leaving the editor and when the app is backgrounded, so that exiting never
  // races a pending timer. Silent by design: it runs on the way out, where an
  // alert would be both useless and alarming.
  const saveNow = React.useCallback(async () => {
    if (!name.trim()) return;

    try {
      const existingCard = cardsRef.current?.find(c => c.id === currentCardId.current);
      const cardData: Card = {
        id: currentCardId.current,
        name,
        images,
        summary,
        mainTag,
        tags: selectedTags,
        headerBlocks: activeVariationId === 'default' ? headerBlocks : savedDefaultBlocksRef.current,
        variations: activeVariationId === 'default' 
          ? variations 
          : variations.map(v => v.id === activeVariationId ? { ...v, headerBlocks } : v),
        activeVariationId,
        nextGenerationNumber: genCounter,
        createdAt: id ? (cardsRef.current?.find(c => c.id === id)?.createdAt || Date.now()) : Date.now(),
        updatedAt: Date.now(),
        isPinned: existingCard?.isPinned || false,
      };

      const exists = cardsRef.current.some(c => c.id === currentCardId.current);
      if (exists) {
        await updateCard(cardData);
      } else {
        await addCard(cardData);
      }
      setHasUnsavedChanges(false);
    } catch (err) {
      console.error('Save failed:', err);
    }
  }, [name, images, summary, mainTag, selectedTags, headerBlocks, variations, activeVariationId, genCounter, id, updateCard, addCard]);

  // Held in a ref so the listeners below can stay mounted for the lifetime of
  // the editor without being torn down and rebuilt on every keystroke.
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  // Notes-app behaviour: persist when the app is backgrounded, when the page
  // is torn down, and when this editor unmounts — not only on a timer. On
  // Android, `visibilitychange` is the event that actually fires when the user
  // swipes away or the process is about to be frozen; `beforeunload` is not
  // reliable there.
  useEffect(() => {
    const flush = () => { void saveNowRef.current(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const handleBack = () => {
    // Save first, then leave. With writes this cheap there is nothing left to
    // warn about, so the "unsaved changes" prompt no longer fires on exit.
    void saveNowRef.current();
    navigate('/');
  };

  const handleDelete = async () => {
    if (id) {
      const card = cards.find(c => c.id === id);
      if (card) {
        await updateCard({ ...card, deletedAt: Date.now() });
      }
    }
    navigate('/');
  };

  const handleCreateCustomTag = async () => {
    if (!newTagName.trim()) return;
    const newTag: Tag = {
      id: generateId(),
      name: newTagName,
      color: newTagColor,
      isCustom: true
    };
    await addTag(newTag);
    setSelectedTags(prev => [...prev, newTag.id]);
    setNewTagName('');
  };

  const handleDeleteTag = (e: React.MouseEvent, tagId: string) => {
    e.stopPropagation();
    setTagToDelete(tagId);
    setShowDeleteTagConfirm(true);
  };

  const confirmDeleteTag = async () => {
    if (!tagToDelete) return;
    await deleteTag(tagToDelete);
    setSelectedTags(prev => prev.filter(id => id !== tagToDelete));
    if (mainTag === tagToDelete) setMainTag(undefined);
    setShowDeleteTagConfirm(false);
    setTagToDelete(null);
  };

  const handleAddCardVariation = () => {
    const newVarId = generateId();
    // High-water-mark: always increment from the highest number ever assigned
    // genCounter starts at 1 (for G1 Default), so first new tab is G2
    const nextNum = genCounter + 1;
    setGenCounter(nextNum);
    
    // Save current blocks before switching
    if (activeVariationId === 'default') {
      savedDefaultBlocksRef.current = headerBlocks;
    } else {
      const updated = variationsRef.current.map(v => v.id === activeVariationId ? { ...v, headerBlocks } : v);
      variationsRef.current = updated;
    }
    
    const newVar: CardVariation = {
      id: newVarId,
      name: `G${nextNum}`,
      headerBlocks: []
    };
    const newVariations = [...variationsRef.current, newVar];
    variationsRef.current = newVariations;
    setVariations(newVariations);
    setActiveVariationId(newVarId);
    setHeaderBlocks(newVar.headerBlocks);
  };

  const handleDeleteCardVariation = () => {
    if (activeVariationId === 'default') return; // Cannot delete default variation
    
    const newVariations = variationsRef.current.filter(v => v.id !== activeVariationId);
    variationsRef.current = newVariations;
    setVariations(newVariations);
    setActiveVariationId('default');
    
    // Switch back to default variation blocks using local ref (never global store)
    setHeaderBlocks(savedDefaultBlocksRef.current);
    setShowDeleteCardVariationConfirm(false);
  };

  const handleSwitchCardVariation = (varId: string) => {
    // Don't switch if already on this tab
    if (varId === activeVariationId) return;
    
    // Save current blocks before switching
    if (activeVariationId === 'default') {
      savedDefaultBlocksRef.current = headerBlocks;
    } else {
      const updated = variationsRef.current.map(v => v.id === activeVariationId ? { ...v, headerBlocks } : v);
      variationsRef.current = updated;
      setVariations(updated);
    }
    
    setActiveVariationId(varId);
    if (varId === 'default') {
      setHeaderBlocks(savedDefaultBlocksRef.current);
    } else {
      // Read from ref to avoid stale closure
      const targetVar = variationsRef.current.find(v => v.id === varId);
      if (targetVar) setHeaderBlocks(targetVar.headerBlocks);
    }
  };

  return (
    // This page previously had no top offset, so the app header (safe-area
    // inset + 56px) sat on top of the image carousel and its Star / Download /
    // Zoom / Fit controls, making them impossible to tap.
    <div
      className="flex-1 flex flex-col h-full overflow-y-auto relative"
      style={{ paddingBottom: 'calc(var(--safe-bottom) + 96px)' }}
    >
      <div
        className="p-4 max-w-3xl mx-auto w-full space-y-6"
        style={{ paddingTop: 'calc(var(--app-header-h) + 16px)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 w-full">
            <button 
              onClick={handleBack}
              className="p-2 hover:bg-bg-surface-hover rounded-lg transition-colors shrink-0"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <input 
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Entry Name"
              className="text-3xl font-bold bg-transparent border-none focus:outline-none focus:ring-0 placeholder:text-text-muted w-full"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <AnimatePresence mode="wait">
              {saveStatus === 'saving' && (
                <motion.span 
                  key="saving"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="text-xs font-medium text-text-muted mr-2"
                >
                  Saving...
                </motion.span>
              )}
              {saveStatus === 'saved' && (
                <motion.span 
                  key="saved"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="text-xs font-medium text-emerald-500 mr-2"
                >
                  Saved ✔
                </motion.span>
              )}
            </AnimatePresence>
            <button 
              onClick={() => {
                const text = `Name: ${name}\nSummary: ${summary}\n\n${headerBlocks.map(b => `// ${b.title} //\n${b.content}`).join('\n\n')}`;
                navigator.clipboard.writeText(text);
                alert('Card text copied to clipboard!');
              }}
              className="p-3 bg-bg-surface-hover text-text-secondary rounded-xl hover:bg-bg-surface-hover transition-colors flex items-center justify-center"
              title="Export / Share Text"
            >
              <Copy className="w-5 h-5" />
            </button>
            {id && (
              <button 
                onClick={() => setShowDeleteConfirm(true)}
                className="p-3 bg-red-500/10 text-red-500 rounded-xl hover:bg-red-500/20 transition-colors flex items-center justify-center"
                title="Delete Card"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        {/* Image Gallery */}
        <div
          {...imageSwipeHandlers}
          onClick={() => setShowImageControls(v => !v)}
          className="relative w-full aspect-[4/3] bg-bg-surface rounded-2xl overflow-hidden border border-border-main flex items-center justify-center group touch-pan-y"
        >
          {images.length > 0 ? (
            <>
              <img 
                src={images[currentImageIndex]} 
                alt="Gallery" 
                className={cn("w-full h-full transition-all duration-300", imageFit === 'cover' ? 'object-cover' : 'object-contain')} 
              />
              
              {/* Image Controls */}
              <div
                className={cn(
                  "absolute inset-0 bg-black/40 transition-opacity flex items-center justify-between px-4",
                  showImageControls ? "opacity-100" : "opacity-0 pointer-events-none"
                )}
              >
                <button 
                  onClick={(e) => { e.stopPropagation(); setCurrentImageIndex(prev => Math.max(0, prev - 1)); }}
                  disabled={currentImageIndex === 0}
                  className="p-2 bg-black/50 text-text-main rounded-full disabled:opacity-30 backdrop-blur-sm"
                  aria-label="Previous image"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); setCurrentImageIndex(prev => Math.min(images.length - 1, prev + 1)); }}
                  disabled={currentImageIndex === images.length - 1}
                  className="p-2 bg-black/50 text-text-main rounded-full disabled:opacity-30 backdrop-blur-sm"
                  aria-label="Next image"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </div>
              
              {/* Top Right Actions */}
              <div
                className={cn(
                  "absolute top-4 right-4 flex gap-2 transition-opacity",
                  showImageControls ? "opacity-100" : "opacity-0 pointer-events-none"
                )}
              >
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    if (currentImageIndex !== 0) {
                      setImages(prev => {
                        const newImages = [...prev];
                        const temp = newImages[0];
                        newImages[0] = newImages[currentImageIndex];
                        newImages[currentImageIndex] = temp;
                        return newImages;
                      });
                      setCurrentImageIndex(0);
                    }
                  }}
                  className={cn("p-2 text-text-main rounded-full backdrop-blur-sm transition-colors", currentImageIndex === 0 ? "bg-yellow-500/80" : "bg-black/50 hover:bg-bg-surface-hover")}
                  title={currentImageIndex === 0 ? "Main Image" : "Set as Main Image"}
                >
                  <Star className={cn("w-4 h-4", currentImageIndex === 0 ? "fill-white" : "")} />
                </button>
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    void saveImage(images[currentImageIndex], `${name || 'image'}-${currentImageIndex + 1}`);
                  }}
                  className="p-2 bg-black/50 text-text-main rounded-full backdrop-blur-sm hover:bg-bg-surface-hover transition-colors"
                  title="Download Image"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                </button>
                <button 
                  onClick={() => setShowZoomModal(true)}
                  className="p-2 bg-black/50 text-text-main rounded-full backdrop-blur-sm hover:bg-bg-surface-hover transition-colors"
                  title="Zoom Image"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => setImageFit(prev => prev === 'cover' ? 'contain' : 'cover')}
                  className="p-2 bg-black/50 text-text-main rounded-full backdrop-blur-sm hover:bg-bg-surface-hover transition-colors"
                  title="Toggle Image Fit"
                >
                  {imageFit === 'cover' ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                </button>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2 bg-black/50 text-text-main rounded-full backdrop-blur-sm hover:bg-bg-surface-hover transition-colors"
                >
                  <ImagePlus className="w-4 h-4" />
                </button>
                <button 
                  onClick={() => removeImage(currentImageIndex)}
                  className="p-2 bg-black/50 text-text-main rounded-full backdrop-blur-sm hover:bg-red-500/80 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Dots */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5">
                {images.map((_, i) => (
                  <div key={i} className={cn("w-2 h-2 rounded-full transition-all", i === currentImageIndex ? "bg-white w-4" : "bg-white/50")} />
                ))}
              </div>
            </>
          ) : (
            <div className="text-center">
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center gap-3 text-text-muted hover:text-text-secondary transition-colors"
              >
                <div className="w-16 h-16 rounded-2xl bg-bg-surface-hover flex items-center justify-center">
                  <ImagePlus className="w-8 h-8" />
                </div>
                <span className="font-medium">Add Images</span>
              </button>
            </div>
          )}
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleImageUpload} 
            multiple 
            accept="image/*" 
            className="hidden" 
          />
        </div>

        {/* Summary & Tags */}
        <div className="space-y-4">
          <div className="flex items-start gap-4">
            <button 
              onClick={() => setShowTagModal(true)}
              className="mt-1 p-3 bg-bg-surface border border-border-main rounded-xl hover:bg-bg-surface-hover transition-colors shrink-0"
            >
              <TagIcon className="w-5 h-5 text-text-muted" />
            </button>
            <div className="flex-1 space-y-3">
              <textarea 
                value={summary}
                onChange={e => setSummary(e.target.value)}
                placeholder="Write a summary..."
                className="w-full bg-bg-surface border border-border-main rounded-xl p-4 text-text-main focus:outline-none focus:ring-2 focus:ring-accent min-h-[100px] resize-y"
              />
              {selectedTags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {mainTag && tags?.find(t => t.id === mainTag) && (
                    <span className={cn("text-xs font-bold px-3 py-1 rounded-full text-text-main ring-2 ring-white/50", tags?.find(t => t.id === mainTag)?.color)}>
                      ★ {tags?.find(t => t.id === mainTag)?.name}
                    </span>
                  )}
                  {selectedTags.filter(id => id !== mainTag).map(tagId => {
                    const tag = tags?.find(t => t.id === tagId);
                    if (!tag) return null;
                    return (
                      <span key={tag.id} className={cn("text-xs font-medium px-3 py-1 rounded-full text-text-main shadow-sm", tag.color)}>
                        {tag.name}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Header Blocks & Variations */}
        <div className="space-y-6 pt-4">
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-2">
            <button
              onClick={() => handleSwitchCardVariation('default')}
              className={cn(
                "px-4 py-1.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap",
                activeVariationId === 'default' 
                  ? "bg-text-main text-bg-main" 
                  : "bg-bg-surface border border-border-main text-text-muted hover:bg-bg-surface-hover hover:text-text-secondary"
              )}
            >
              G1 (Default)
            </button>
            {variations.map(v => (
              <button
                key={v.id}
                onClick={() => handleSwitchCardVariation(v.id)}
                className={cn(
                  "px-4 py-1.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap",
                  activeVariationId === v.id 
                    ? "bg-text-main text-bg-main" 
                    : "bg-bg-surface border border-border-main text-text-muted hover:bg-bg-surface-hover hover:text-text-secondary"
                )}
              >
                {v.name}
              </button>
            ))}
            <button
              onClick={handleAddCardVariation}
              className="p-1.5 rounded-xl bg-bg-surface border border-border-main text-text-muted hover:bg-bg-surface-hover hover:text-text-secondary transition-colors shrink-0"
              title="Add Variation"
            >
              <Plus className="w-5 h-5" />
            </button>
            {activeVariationId !== 'default' && (
              <button
                onClick={() => setShowDeleteCardVariationConfirm(true)}
                className="p-1.5 rounded-xl bg-bg-surface border border-border-main text-text-muted hover:bg-red-500/20 hover:text-red-400 transition-colors shrink-0"
                title="Delete Current Variation"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            )}
          </div>

          <DndContext 
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => {
              const { active, over } = event;
              if (over && active.id !== over.id) {
                setHeaderBlocks((items) => {
                  const oldIndex = items.findIndex(item => item.id === active.id);
                  const newIndex = items.findIndex(item => item.id === over.id);
                  const newItems = arrayMove(items, oldIndex, newIndex);
                  return newItems.map((item: HeaderBlock, index: number) => ({ ...item, order: index }));
                });
              }
            }}
          >
            <SortableContext 
              items={headerBlocks.map(b => b.id)}
              strategy={verticalListSortingStrategy}
            >
              {headerBlocks.map((block) => (
                <SortableHeaderBlockItem 
                  key={`${block.id}-${activeVariationId}`} 
                  block={block} 
                  onUpdate={updateHeaderBlock}
                  onRemove={removeHeaderBlock}
                  isFullScreen={fullScreenBlockId === block.id}
                  onExpand={toggleFullScreenBlock}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {/* Floating Add Block Button */}
      <button 
        onClick={addHeaderBlock}
        className="fab-button bg-bg-surface-hover border border-border-main text-text-main"
      >
        <Plus className="w-8 h-8" />
      </button>

      {/* A2: Zoom Modal with swipe gestures */}
      {showZoomModal && images.length > 0 && (
        <ZoomModal
          images={images}
          currentIndex={currentImageIndex}
          onClose={() => setShowZoomModal(false)}
          onIndexChange={setCurrentImageIndex}
        />
      )}

      {/* A3: Tag Modal — Modern bottom sheet redesign */}
      <AnimatePresence>
        {showTagModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 z-[60]"
              onClick={() => setShowTagModal(false)}
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 300 }}
              className="fixed inset-x-0 bottom-0 z-[60] bg-bg-surface rounded-t-[20px] border-t border-border-main shadow-2xl flex flex-col"
              style={{
                maxHeight: 'calc(85vh - var(--safe-bottom))',
                paddingBottom: 'var(--safe-bottom)',
              }}
              onClick={e => e.stopPropagation()}
            >
              {/* Drag handle */}
              <div className="w-full flex justify-center pt-3 pb-1 shrink-0">
                <div className="w-10 h-1 bg-border-main rounded-full" />
              </div>

              {/* Header */}
              <div className="flex justify-between items-center px-6 py-3 shrink-0">
                <div>
                  <h3 className="text-xl font-bold">Select Tags</h3>
                  <p className="text-xs text-text-muted mt-1">Tap to select. Double-tap for main tag.</p>
                </div>
                <button onClick={() => setShowTagModal(false)} className="p-2 hover:bg-bg-surface-hover rounded-full transition-colors"><X className="w-5 h-5" /></button>
              </div>

              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto px-6 pb-4" style={{ WebkitOverflowScrolling: 'touch' }}>
                {/* Preset Tags */}
                <div className="mb-6">
                  <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Preset Tags</h4>
                  <div className="flex flex-wrap gap-3">
                    {tags.filter(t => !t.isCustom).map(tag => {
                      const isSelected = selectedTags.includes(tag.id);
                      const isMain = mainTag === tag.id;
                      return (
                        <button
                          key={tag.id}
                          onClick={() => {
                            setSelectedTags(prev => 
                              isSelected ? prev.filter(id => id !== tag.id) : [...prev, tag.id]
                            );
                            if (isMain) setMainTag(undefined);
                          }}
                          onDoubleClick={() => {
                            if (!isSelected) {
                              setSelectedTags(prev => [...prev, tag.id]);
                            }
                            setMainTag(isMain ? undefined : tag.id);
                          }}
                          className={cn(
                            "text-sm font-medium px-4 py-2.5 rounded-full transition-all border-2 flex items-center gap-1.5 min-h-[44px]",
                            isSelected 
                              ? cn(tag.color, "text-white border-transparent shadow-lg") 
                              : "bg-transparent text-text-muted border-border-main hover:border-accent",
                            isMain ? "ring-2 ring-white/80 ring-offset-2 ring-offset-bg-surface" : "",
                            isSelected ? "chip-bounce" : ""
                          )}
                        >
                          {isMain && <span className="text-[10px]">{'\u2605'}</span>}
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Divider */}
                {tags.filter(t => t.isCustom).length > 0 && (
                  <div className="h-px bg-border-main mb-6" />
                )}

                {/* Custom Tags */}
                {tags.filter(t => t.isCustom).length > 0 && (
                  <div className="mb-6">
                    <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Custom Tags</h4>
                    <div className="flex flex-wrap gap-3">
                      {tags.filter(t => t.isCustom).map(tag => {
                        const isSelected = selectedTags.includes(tag.id);
                        const isMain = mainTag === tag.id;
                        return (
                          <button
                            key={tag.id}
                            onClick={() => {
                              setSelectedTags(prev => 
                                isSelected ? prev.filter(id => id !== tag.id) : [...prev, tag.id]
                              );
                              if (isMain) setMainTag(undefined);
                            }}
                            onDoubleClick={() => {
                              if (!isSelected) {
                                setSelectedTags(prev => [...prev, tag.id]);
                              }
                              setMainTag(isMain ? undefined : tag.id);
                            }}
                            className={cn(
                              "text-sm font-medium pl-4 pr-2 py-2 rounded-full transition-all border-2 flex items-center gap-1.5 min-h-[44px]",
                              isSelected 
                                ? cn(tag.color, "text-white border-transparent shadow-lg") 
                                : "bg-transparent text-text-muted border-border-main hover:border-accent",
                              isMain ? "ring-2 ring-white/80 ring-offset-2 ring-offset-bg-surface" : ""
                            )}
                          >
                            {isMain && <span className="text-[10px]">{'\u2605'}</span>}
                            {tag.name}
                            <div 
                              onClick={(e) => handleDeleteTag(e, tag.id)}
                              className="w-6 h-6 rounded-full bg-black/20 flex items-center justify-center hover:bg-black/40 transition-colors ml-1"
                            >
                              <X className="w-3 h-3" />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Create Custom Tag — fixed at bottom */}
              <div className="shrink-0 px-6 pt-4 pb-4 border-t border-border-main space-y-4 bg-bg-surface">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider">+ New Tag</h4>
                </div>
                <div className="flex gap-2">
                  <input 
                    type="text"
                    value={newTagName}
                    onChange={e => setNewTagName(e.target.value)}
                    placeholder="Tag name..."
                    className="flex-1 bg-bg-main border border-border-main rounded-xl px-4 py-3 text-text-main focus:outline-none"
                    onKeyDown={e => e.key === 'Enter' && handleCreateCustomTag()}
                  />
                  <button 
                    onClick={handleCreateCustomTag}
                    className="px-5 py-3 bg-accent text-white rounded-xl font-medium hover:opacity-90 transition-colors min-w-[70px]"
                  >
                    Create
                  </button>
                </div>
                {/* A3: Color picker — 8x3 grid, 24 colors */}
                <div className="grid grid-cols-8 gap-[10px]">
                  {TAG_COLORS.slice(0, 24).map(color => (
                    <button
                      key={color}
                      onClick={() => setNewTagColor(color)}
                      className={cn(
                        "w-[40px] h-[40px] rounded-[12px] transition-all flex items-center justify-center",
                        color,
                        newTagColor === color ? "ring-2 ring-white ring-offset-2 ring-offset-bg-surface scale-110" : "opacity-60 hover:opacity-100"
                      )}
                    >
                      {newTagColor === color && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          className="w-4 h-4 text-white"
                        >
                          <Check className="w-4 h-4" />
                        </motion.div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <ConfirmModal 
        isOpen={showDeleteConfirm}
        title="Delete Card"
        message="Are you sure you want to move this card to the recycle bin?"
        confirmText="Move to Bin"
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      <ConfirmModal 
        isOpen={showDeleteCardVariationConfirm}
        title="Delete Variation"
        message="Are you sure you want to delete this variation? This action cannot be undone."
        confirmText="Delete"
        onConfirm={handleDeleteCardVariation}
        onCancel={() => setShowDeleteCardVariationConfirm(false)}
      />

      <ConfirmModal 
        isOpen={!!blockToDelete}
        title="Delete Header Block"
        message="Are you sure you want to move this header block to the recycle bin?"
        confirmText="Move to Bin"
        onConfirm={confirmDeleteBlock}
        onCancel={() => setBlockToDelete(null)}
      />

      <ConfirmModal 
        isOpen={showUnsavedModal}
        title="Unsaved Changes"
        message="You have unsaved changes. Are you sure you want to leave without saving?"
        confirmText="Leave without saving"
        onConfirm={() => {
          setShowUnsavedModal(false);
          if (pendingNavigation) navigate(pendingNavigation);
        }}
        onCancel={() => {
          setShowUnsavedModal(false);
          setPendingNavigation(null);
        }}
      />

      <ConfirmModal 
        isOpen={showDeleteTagConfirm}
        title="Delete Custom Tag"
        message={`Are you sure you want to delete this custom tag? It will be removed from all cards.`}
        confirmText="Delete Tag"
        onConfirm={confirmDeleteTag}
        onCancel={() => {
          setShowDeleteTagConfirm(false);
          setTagToDelete(null);
        }}
      />
    </div>
  );
}
