import React, { useState, useEffect, useRef } from 'react';
import { Card } from '../types';
import { Tag } from '../types';
import { cn } from '../utils';
import { motion, AnimatePresence } from 'motion/react';
import { Pin, ChevronRight, GripVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useInView } from 'react-intersection-observer';
import { FALLBACK_IMAGE_RATIO, getImageRatio, rememberImageRatio } from '../imageDims';

interface CardItemProps {
  key?: React.Key;
  card: Card;
  selected?: boolean;
  isSortable?: boolean;
  onSelect?: (id: string) => void;
  onLongPress?: (id: string) => void;
  /**
   * Receives the card's on-screen rect alongside its id. The editor overlay
   * animates itself from exactly that box (see `src/morphOrigin.ts`), which is
   * what replaced the `layoutId` shared-element transition in v1.13.0.
   */
  onClick?: (id: string, rect?: DOMRect) => void;
  tags?: Tag[];
  onTogglePin?: (card: Card) => void;
  showDates?: boolean;
  /**
   * Position in the entrance cascade. Pass a NEGATIVE value to skip the
   * entrance animation entirely — used on back-navigation, where replaying the
   * cascade over an already-seen list reads as a flicker rather than polish.
   */
  staggerIndex?: number;
}

export default React.memo(function CardItem({ card, selected, isSortable = true, onSelect, onLongPress, onClick, tags, onTogglePin, showDates, staggerIndex = 0 }: CardItemProps) {
  const [showAllTags, setShowAllTags] = useState(false);
  const tagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ 
    id: card.id,
    disabled: !isSortable
  });

  const { ref: inViewRef, inView } = useInView({
    rootMargin: '600px 0px',
    triggerOnce: false,
  });

  const [cardHeight, setCardHeight] = useState<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);

  // The card's picture reserves its height BEFORE decoding, so the masonry does
  // not relayout as images arrive. A remembered ratio is exact; the first time
  // an image is ever seen we reserve FALLBACK_IMAGE_RATIO and correct it on
  // load. Ratios live in a local cache OUTSIDE the vault - see src/imageDims.ts
  // for why putting them in VaultData would risk manufacturing sync conflicts.
  const firstImage = card.images.length > 0 ? card.images[0] : undefined;
  const [imageRatio, setImageRatio] = useState<number | undefined>(() => getImageRatio(firstImage));

  // Re-read when the picture itself changes. Cheap, synchronous, and it also
  // picks up a ratio another card measured for the same image in the meantime.
  useEffect(() => {
    setImageRatio(getImageRatio(firstImage));
  }, [firstImage]);

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    const measured = rememberImageRatio(firstImage, img.naturalWidth, img.naturalHeight);
    if (measured && measured !== imageRatio) setImageRatio(measured);
  };

  useEffect(() => {
    if (inView && contentRef.current) {
      const observer = new ResizeObserver((entries) => {
        for (let entry of entries) {
          setCardHeight(entry.contentRect.height);
        }
      });
      observer.observe(contentRef.current);
      return () => observer.disconnect();
    }
  }, [inView]);

  // Held so the card can report its own on-screen box when tapped. The morph
  // is a hand-rolled FLIP now, so the overlay needs a real rect from us — no
  // `layoutId` means motion has no other way to find where we were.
  const nodeRef = useRef<HTMLElement | null>(null);

  const setRefs = (node: HTMLElement | null) => {
    nodeRef.current = node;
    setNodeRef(node);
    inViewRef(node);
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
    zIndex: isDragging ? 50 : 1,
    minHeight: cardHeight ? `${cardHeight}px` : '200px',
  };

  // `let timer` used to live in the render body, so every re-render created a
  // fresh binding. A re-render between touchstart and touchend (very common —
  // the parent list re-renders constantly) meant touchend cleared a *different*
  // variable than the one holding the live handle, so the long-press fired
  // after the finger had already lifted. A ref survives re-renders.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleTouchStart = () => {
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      if (onLongPress) onLongPress(card.id);
    }, 500);
  };

  const handleTouchEnd = () => clearLongPress();
  const handleTouchMove = () => clearLongPress();

  // Don't leave a pending long-press behind if the card unmounts mid-press
  // (e.g. the list re-filters), which would fire onLongPress for a gone card.
  useEffect(() => clearLongPress, []);

  const handleClick = () => {
    if (selected !== undefined && onSelect) {
      onSelect(card.id);
    } else if (onClick) {
      // Measured at tap time, before any navigation, so it describes where the
      // card genuinely is rather than where it ended up after a re-render.
      onClick(card.id, nodeRef.current?.getBoundingClientRect());
    }
  };

  const togglePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onTogglePin) onTogglePin(card);
  };

  const handleTagInteraction = (e?: React.MouseEvent | React.TouchEvent | React.UIEvent) => {
    if (e) e.stopPropagation();
    setShowAllTags(true);
    
    if (tagTimerRef.current) {
      clearTimeout(tagTimerRef.current);
    }
    
    tagTimerRef.current = setTimeout(() => {
      setShowAllTags(false);
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTo({ left: 0, behavior: 'smooth' });
      }
    }, 2000);
  };

  useEffect(() => {
    return () => {
      if (tagTimerRef.current) clearTimeout(tagTimerRef.current);
    };
  }, []);

  const mainTagId = card.mainTag || (card.tags && card.tags[0]);
  const mainTagObj = tags?.find(t => t.id === mainTagId);
  const otherTags = (card.tags || []).filter(id => id !== mainTagId).map(id => tags?.find(t => t.id === id)).filter(Boolean);

  return (
    <motion.div 
      ref={setRefs}
      style={style}
      {...attributes}
      {...listeners}
      initial={staggerIndex < 0 ? false : { opacity: 0, scale: 0.95, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={staggerIndex < 0 ? { duration: 0 } : { duration: 0.25, delay: Math.min(staggerIndex * 0.04, 0.4), ease: [0.4, 0, 0.2, 1] }}
      whileTap={{ scale: 0.98 }}
      className={cn(
        "relative rounded-3xl overflow-hidden bg-bg-surface border transition-all duration-300 cursor-pointer mb-4 break-inside-avoid shadow-lg group card-glow card-shimmer",
        selected ? "border-accent ring-2 ring-accent shadow-accent/20" : "border-border-main/50 hover:border-border-main hover:shadow-xl",
        isDragging ? "opacity-80 scale-[1.02] shadow-2xl" : ""
      )}
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onMouseDown={handleTouchStart}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {inView ? (
        <div ref={contentRef} className="h-full flex flex-col">
          {card.images.length > 0 ? (
            <div className="flex flex-col h-full">
              <div
                className="relative w-full overflow-hidden shrink-0 bg-bg-main"
                style={{ aspectRatio: String(imageRatio ?? FALLBACK_IMAGE_RATIO) }}
              >
                <img
                  src={card.images[0]}
                  alt={card.name}
                  loading="lazy"
                  decoding="async"
                  onLoad={handleImageLoad}
                  className="absolute inset-0 w-full h-full object-cover z-10 transition-transform duration-700 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-bg-main via-transparent to-transparent opacity-60 z-20 pointer-events-none" />
              </div>
              
              <div className="p-4 flex flex-col flex-1 bg-bg-surface">
                <h3 className="font-bold text-lg text-text-main mb-1.5 line-clamp-1">{card.name}</h3>
                {card.summary && (
                  <p className="text-xs text-text-muted line-clamp-2 leading-relaxed mb-3 flex-1">{card.summary}</p>
                )}
                
                {card.tags.length > 0 && (
                  <div 
                    className="relative mt-auto pt-2 border-t border-border-main/50"
                    onMouseEnter={handleTagInteraction}
                    onMouseLeave={() => handleTagInteraction()}
                    onTouchStart={handleTagInteraction}
                  >
                    <div 
                      ref={scrollContainerRef}
                      className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-1 snap-x"
                      onScroll={handleTagInteraction}
                    >
                      {mainTagObj && (
                        <span className={cn("shrink-0 snap-start text-[10px] font-bold px-2.5 py-1 rounded-full text-text-main ring-1 ring-white/20", mainTagObj.color)}>
                          {card.mainTag ? '\u2605 ' : ''}{mainTagObj.name}
                        </span>
                      )}
                      
                      {!showAllTags && otherTags.length > 0 && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleTagInteraction(); }}
                          className="shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-bg-surface-hover text-text-muted hover:text-text-main transition-colors"
                        >
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      )}

                      <AnimatePresence>
                        {showAllTags && otherTags.map(tag => tag && (
                          <motion.span 
                            initial={{ opacity: 0, scale: 0.8, width: 0 }}
                            animate={{ opacity: 1, scale: 1, width: 'auto' }}
                            exit={{ opacity: 0, scale: 0.8, width: 0 }}
                            key={tag.id} 
                            className={cn("shrink-0 snap-start text-[10px] font-medium px-2.5 py-1 rounded-full text-text-main shadow-sm", tag.color)}
                          >
                            {tag.name}
                          </motion.span>
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}
              {showDates === true && (
                <div className="mt-3 flex items-center shrink-0">
                  <div className="bg-accent text-white px-2.5 py-1 rounded-md text-[10px] font-extrabold uppercase tracking-wide shadow-md flex items-center gap-1.5 w-max">
                    {card.updatedAt ? (
                      <>
                        <span className="text-white/80">Edited:</span>
                        {new Date(Number(card.updatedAt) || Date.now()).toLocaleDateString()}
                      </>
                    ) : (
                      <>
                        <span className="text-white/80">Created:</span>
                        {new Date(Number(card.createdAt) || Date.now()).toLocaleDateString()}
                      </>
                    )}
                  </div>
                </div>
              )}
              </div>
            </div>
          ) : (
            <div className="p-5 flex flex-col h-full">
              <h3 className="font-bold text-xl text-text-main mb-2 line-clamp-1">{card.name}</h3>
              {card.summary && (
                <p className="text-sm text-text-muted line-clamp-3 leading-relaxed mb-4 flex-1">{card.summary}</p>
              )}
              
              {card.tags.length > 0 && (
                <div 
                  className="relative mt-auto pt-3 border-t border-border-main/50"
                  onMouseEnter={handleTagInteraction}
                  onMouseLeave={() => handleTagInteraction()}
                  onTouchStart={handleTagInteraction}
                >
                  <div 
                    ref={scrollContainerRef}
                    className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-1 snap-x"
                    onScroll={handleTagInteraction}
                  >
                    {mainTagObj && (
                      <span className={cn("shrink-0 snap-start text-[10px] font-bold px-2.5 py-1 rounded-full text-text-main ring-1 ring-white/20", mainTagObj.color)}>
                        {card.mainTag ? '\u2605 ' : ''}{mainTagObj.name}
                      </span>
                    )}
                    
                    {!showAllTags && otherTags.length > 0 && (
                      <button 
                        onClick={(e) => { e.stopPropagation(); handleTagInteraction(); }}
                        className="shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-bg-surface-hover text-text-muted hover:text-text-main transition-colors"
                      >
                        <ChevronRight className="w-3 h-3" />
                      </button>
                    )}

                    <AnimatePresence>
                      {showAllTags && otherTags.map(tag => tag && (
                        <motion.span 
                          initial={{ opacity: 0, scale: 0.8, width: 0 }}
                          animate={{ opacity: 1, scale: 1, width: 'auto' }}
                          exit={{ opacity: 0, scale: 0.8, width: 0 }}
                          key={tag.id} 
                          className={cn("shrink-0 snap-start text-[10px] font-medium px-2.5 py-1 rounded-full text-text-main shadow-sm", tag.color)}
                        >
                          {tag.name}
                        </motion.span>
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              )}

              {showDates === true && (
                <div className="mt-3 flex items-center shrink-0">
                  <div className="bg-accent text-white px-2.5 py-1 rounded-md text-[10px] font-extrabold uppercase tracking-wide shadow-md flex items-center gap-1.5 w-max">
                    {card.updatedAt ? (
                      <>
                        <span className="text-white/80">Edited:</span>
                        {new Date(Number(card.updatedAt) || Date.now()).toLocaleDateString()}
                      </>
                    ) : (
                      <>
                        <span className="text-white/80">Created:</span>
                        {new Date(Number(card.createdAt) || Date.now()).toLocaleDateString()}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
      
      {selected && (
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-10">
          <motion.div 
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-10 h-10 bg-text-main rounded-full flex items-center justify-center shadow-xl"
          >
            <div className="w-4 h-4 bg-bg-surface rounded-full" />
          </motion.div>
        </div>
      )}
    </motion.div>
  );
});
