import React, { useEffect, useState, useMemo } from 'react';
import { Search, Plus, X, FolderPlus, SlidersHorizontal, Folder, Trash2, Pin, PinOff } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { Card } from '../types';
import CardItem from '../components/CardItem';
import ConfirmModal from '../components/ConfirmModal';
import { motion, AnimatePresence } from 'motion/react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy } from '@dnd-kit/sortable';
import { useScrollDirection } from '../hooks/useScrollDirection';
import { useLayout, LAYOUT_HIDE_SLIDE_PX } from '../components/Layout';
import { useIsReturnVisit, useScrollRestoration, useStickyState } from '../hooks/useViewState';
import { setMorphOrigin } from '../morphOrigin';

const HIDE_SLIDE_PX = LAYOUT_HIDE_SLIDE_PX;

export default function MainScreen() {
  const { cards, projects, addProject, updateProject, tags, deleteCard, updateCard, updateCards, loading, vaultEpoch } = useStore();
  const navigate = useNavigate();
  const { setSelectionActive } = useLayout();

  // AnimatePresence unmounts this page on navigation, so anything held in
  // plain useState is gone by the time the user presses back. The keys below
  // include `vaultEpoch` so a cloud restore or sign-out wipe resets the view
  // for free rather than leaving a search pointed at cards that no longer
  // exist.
  const viewKey = `main:${vaultEpoch}`;
  const isReturnVisit = useIsReturnVisit(viewKey);
  const scrollRef = useScrollRestoration<HTMLDivElement>(viewKey, !loading);

  const [searchQuery, setSearchQuery] = useStickyState(`${viewKey}:searchQuery`, '');
  // Selection mode and the modal flags stay plain local state on purpose:
  // returning to a screen with a delete confirmation still open would be
  // alarming, not convenient.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [showGroupSelect, setShowGroupSelect] = useState(false);

  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [selectedSearchTags, setSelectedSearchTags] = useStickyState<Set<string>>(`${viewKey}:searchTags`, new Set());
  // 'manual' = respect the drag-and-drop `order` field. Previously the order
  // check ran unconditionally *before* the sort switch, so as soon as cards had
  // an `order` (which drag-reorder assigns to every card) all five dropdown
  // options silently did nothing. Manual order is now its own explicit mode.
  const [sortBy, setSortBy] = useStickyState<'manual' | 'dateDesc' | 'dateAsc' | 'nameAsc' | 'nameDesc' | 'editedDesc'>(`${viewKey}:sortBy`, 'manual');
  const [showDates, setShowDates] = useStickyState(`${viewKey}:showDates`, false);
  const [startDate, setStartDate] = useStickyState(`${viewKey}:startDate`, '');
  const [endDate, setEndDate] = useStickyState(`${viewKey}:endDate`, '');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  
  const [searchFilter, setSearchFilter] = useStickyState<'all' | 'headerBlocks' | 'cards'>(`${viewKey}:searchFilter`, 'all');
  const { barsVisible } = useScrollDirection(5);

  // Lock bars visible when in selection mode
  const effectiveVisible = barsVisible || selectionMode;

  // Sync selection mode to Layout so the Layout header also stays visible
  React.useEffect(() => {
    setSelectionActive(selectionMode);
    return () => setSelectionActive(false);
  }, [selectionMode, setSelectionActive]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 500,
        tolerance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = cards.findIndex(item => item.id === active.id);
      const newIndex = cards.findIndex(item => item.id === over.id);
      
      const newCards = arrayMove(cards, oldIndex, newIndex);
      const updatedCards = newCards.map((item: Card, index: number) => ({ ...item, order: index }));
      updateCards(updatedCards);
    }
  };

  const filteredCards = useMemo(() => {
    const activeCards = cards.filter(c => !c.deletedAt);
    let result = activeCards.filter(card => {
      const searchLower = searchQuery.toLowerCase();
      
      let matchesText = false;
      if (searchFilter === 'all' || searchFilter === 'cards') {
        matchesText = matchesText || (card.name || '').toLowerCase().includes(searchLower) ||
                      (card.summary || '').toLowerCase().includes(searchLower);
      }
      if (searchFilter === 'all' || searchFilter === 'headerBlocks') {
        matchesText = matchesText || (card.headerBlocks || []).some(b => (b.title || '').toLowerCase().includes(searchLower) || (b.content || '').toLowerCase().includes(searchLower));
      }
      
      const matchesTags = selectedSearchTags.size === 0 || 
                          Array.from(selectedSearchTags).every(tagId => (card.tags || []).includes(tagId));
                          
      let matchesDate = true;
      if (startDate) {
        matchesDate = matchesDate && card.createdAt >= new Date(startDate).getTime();
      }
      if (endDate) {
        matchesDate = matchesDate && card.createdAt <= new Date(endDate).getTime() + 86400000;
      }
      
      return matchesText && matchesTags && matchesDate;
    });

    // A1: Sort by lastEdited timestamp, falling back to createdAt
    result.sort((a, b) => {
      if (sortBy === 'manual' && a.order !== undefined && b.order !== undefined) {
        return a.order - b.order;
      }

      switch (sortBy) {
        case 'editedDesc':
          return (Number(b.updatedAt || b.createdAt) || 0) - (Number(a.updatedAt || a.createdAt) || 0);
        case 'dateDesc':
          return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
        case 'dateAsc':
          return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
        case 'nameAsc': return a.name.localeCompare(b.name);
        case 'nameDesc': return b.name.localeCompare(a.name);
        default: return 0;
      }
    });

    return result;
  }, [cards, searchQuery, searchFilter, selectedSearchTags, sortBy, startDate, endDate]);

  const pinnedCards = useMemo(() => filteredCards.filter(c => c.isPinned), [filteredCards]);
  const unpinnedCards = useMemo(() => filteredCards.filter(c => !c.isPinned), [filteredCards]);

  const handleLongPress = React.useCallback((id: string) => {
    setSelectionMode(prevMode => {
      if (!prevMode) {
        setSelectedCards(new Set([id]));
        return true;
      }
      return prevMode;
    });
  }, []);

  const toggleSelection = React.useCallback((id: string) => {
    setSelectedCards(prev => {
      const newSelection = new Set(prev);
      if (newSelection.has(id)) {
        newSelection.delete(id);
        if (newSelection.size === 0) {
          setSelectionMode(false);
        }
      } else {
        newSelection.add(id);
      }
      return newSelection;
    });
  }, []);

  // v1.13.0: no card is ever enrolled in motion's layout projection any more.
  // The card hands us the box it currently occupies and the editor overlay
  // animates itself out of that box by hand (see `src/morphOrigin.ts`). That
  // removes both the per-card `openingCardId` state and the one-frame
  // requestAnimationFrame deferral, which only existed to give motion a
  // measured "from" node it never actually registered.
  const handleCardClick = React.useCallback((id: string, rect?: DOMRect) => {
    if (rect) setMorphOrigin(id, rect);
    navigate(`/entry/${id}`);
  }, [navigate]);

  const handleTogglePinSingle = React.useCallback((card: Card) => {
    updateCard({ ...card, isPinned: !card.isPinned });
  }, [updateCard]);

  const handleTogglePin = async () => {
    const cardsToUpdate = Array.from(selectedCards)
      .map(id => cards.find(c => c.id === id))
      .filter((c): c is Card => c !== undefined);
    
    if (cardsToUpdate.length > 0) {
      const allPinned = cardsToUpdate.every(c => c.isPinned);
      const updatedCards = cardsToUpdate.map(c => ({ ...c, isPinned: !allPinned }));
      await updateCards(updatedCards);
    }
    setSelectionMode(false);
    setSelectedCards(new Set());
  };

  const handleAddToGroup = async (projectId: string) => {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      const newCardIds = Array.from(new Set([...project.cardIds, ...Array.from(selectedCards)]));
      await updateProject({ ...project, cardIds: newCardIds });
    }
    setSelectionMode(false);
    setSelectedCards(new Set());
    setShowGroupSelect(false);
  };

  return (
    <div className="w-full h-full overflow-hidden relative">
      {/* ── ABSOLUTE TOP HEADER (search / selection bar) ──
           Starts at top-0, padding-top accounts for safe-area + Layout header (56px).
           Translates by the SAME fixed px as Layout header → no ghost gap. */}
      <div
        className="absolute top-0 left-0 right-0 z-[90] bg-bg-main will-change-transform"
        style={{
          paddingTop: 'var(--app-header-h)',
          transform: `translateY(${effectiveVisible ? '0px' : `-${HIDE_SLIDE_PX}px`})`,
          transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: '0 1px 0 0 var(--border-main)',
        }}
      >
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <AnimatePresence mode="wait">
            {selectionMode ? (
              <motion.div 
                key="selection"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex-1 flex items-center justify-between bg-bg-surface rounded-xl p-2 border border-border-main"
              >
                <div className="flex items-center gap-3">
                  <button onClick={() => { setSelectionMode(false); setSelectedCards(new Set()); }} className="p-2 hover:bg-bg-surface-hover rounded-lg">
                    <X className="w-5 h-5" />
                  </button>
                  <span className="font-medium">{selectedCards.size} selected</span>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={handleTogglePin}
                    className="p-1.5 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-lg transition-colors"
                    title="Toggle Pin"
                  >
                    {Array.from(selectedCards).every(id => cards.find(c => c.id === id)?.isPinned) ? <PinOff className="w-5 h-5" /> : <Pin className="w-5 h-5" />}
                  </button>
                  <button 
                    onClick={() => setShowGroupSelect(true)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-text-main text-bg-main rounded-lg font-medium hover:bg-text-secondary"
                  >
                    <FolderPlus className="w-4 h-4" />
                    <span className="hidden sm:inline">Add to Group</span>
                  </button>
                  <button 
                    onClick={() => setShowDeleteConfirm(true)}
                    className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="search"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="flex-1 flex items-center gap-2"
              >
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted" />
                  <input 
                    type="text"
                    placeholder="Search cards..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full bg-bg-surface border border-border-main rounded-xl pl-10 pr-4 py-2.5 text-text-main focus:outline-none"
                  />
                </div>
                <button 
                  onClick={() => setShowAdvancedSearch(true)}
                  className="p-2.5 bg-bg-surface border border-border-main rounded-xl hover:bg-bg-surface-hover transition-colors"
                >
                  <SlidersHorizontal className="w-5 h-5 text-text-muted" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        
        {/* Search Pills */}
        {!selectionMode && searchQuery && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="flex gap-2 overflow-x-auto scrollbar-hide pb-1"
          >
            <button
              onClick={() => setSearchFilter('all')}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${searchFilter === 'all' ? 'bg-text-main text-bg-main' : 'bg-bg-surface text-text-muted hover:bg-bg-surface-hover'}`}
            >
              All Results
            </button>
            <button
              onClick={() => setSearchFilter('cards')}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${searchFilter === 'cards' ? 'bg-text-main text-bg-main' : 'bg-bg-surface text-text-muted hover:bg-bg-surface-hover'}`}
            >
              Cards Only
            </button>
            <button
              onClick={() => setSearchFilter('headerBlocks')}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${searchFilter === 'headerBlocks' ? 'bg-text-main text-bg-main' : 'bg-bg-surface text-text-muted hover:bg-bg-surface-hover'}`}
            >
              Header Blocks Only
            </button>
          </motion.div>
        )}
      </div>
      </div>

      {/* ── FULL-HEIGHT SCROLL CONTAINER ── sits behind absolute headers */}
      <div
        ref={scrollRef}
        className="w-full h-full overflow-y-auto px-4"
        style={{
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'none',
          paddingTop: 'var(--page-pad-top-toolbar)',
          paddingBottom: 'var(--page-pad-bottom)',
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          {pinnedCards.length > 0 && (
            <div className="mb-8">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4 px-2">Pinned</h3>
              <SortableContext
                items={pinnedCards.map(c => c.id)}
                strategy={rectSortingStrategy}
              >
                <div className="columns-2 gap-4 space-y-4">
                  {pinnedCards.map((card, i) => (
                    <CardItem 
                      key={card.id} 
                      card={card} 
                      tags={tags}
                      showDates={showDates}
                      onTogglePin={handleTogglePinSingle}
                      selected={selectionMode ? selectedCards.has(card.id) : undefined}
                      onSelect={selectionMode ? toggleSelection : undefined}
                      onLongPress={handleLongPress}
                      onClick={handleCardClick}
                      staggerIndex={isReturnVisit ? -1 : i}
                    />
                  ))}
                </div>
              </SortableContext>
            </div>
          )}

          {pinnedCards.length > 0 && unpinnedCards.length > 0 && (
            <div className="h-px bg-bg-surface-hover/50 w-full mb-8" />
          )}

          {unpinnedCards.length > 0 && (
            <div>
              {pinnedCards.length > 0 && <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4 px-2">Others</h3>}
              <SortableContext
                items={unpinnedCards.map(c => c.id)}
                strategy={rectSortingStrategy}
              >
                <div className="columns-2 gap-4 space-y-4">
                  {unpinnedCards.map((card, i) => (
                    <CardItem 
                      key={card.id} 
                      card={card} 
                      tags={tags}
                      showDates={showDates}
                      onTogglePin={handleTogglePinSingle}
                      selected={selectionMode ? selectedCards.has(card.id) : undefined}
                      onSelect={selectionMode ? toggleSelection : undefined}
                      onLongPress={handleLongPress}
                      onClick={handleCardClick}
                      staggerIndex={isReturnVisit ? -1 : i + pinnedCards.length}
                    />
                  ))}
                </div>
              </SortableContext>
            </div>
          )}
        </DndContext>
        {filteredCards.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-text-muted mt-20">
            <Search className="w-16 h-16 opacity-20 mb-4" />
            <p className="font-medium text-base">{searchQuery ? 'No cards found.' : 'No cards yet'}</p>
            <p className="text-sm mt-1 opacity-70">{searchQuery ? 'Try a different search term.' : 'Tap + to create your first card.'}</p>
          </div>
        )}
      </div>

      {/* ── ABSOLUTE FAB ── hides with bottom nav */}
      <button 
        onClick={() => navigate('/entry')}
        className="absolute z-[90] w-14 h-14 rounded-2xl shadow-2xl flex items-center justify-center bg-text-main text-bg-main active:scale-[0.92] transition-transform will-change-transform"
        style={{
          right: 16,
          bottom: 'calc(var(--safe-bottom, 0px) + 80px + 16px)',
          transform: `translateY(${effectiveVisible ? '0px' : `${HIDE_SLIDE_PX}px`})`,
          transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <Plus className="w-8 h-8" />
      </button>

      {/* Group Select Modal */}
      {showGroupSelect && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-end sm:items-center justify-center p-4">
          <div className="bg-bg-surface rounded-t-2xl sm:rounded-2xl p-6 w-full max-w-sm border border-border-main shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Select Group</h3>
              <button onClick={() => setShowGroupSelect(false)}><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {projects.length === 0 ? (
                <p className="text-text-muted text-center py-4">No groups available. Create one from the menu.</p>
              ) : (
                projects.map(project => (
                  <button 
                    key={project.id}
                    onClick={() => handleAddToGroup(project.id)}
                    className="w-full text-left px-4 py-3 rounded-xl hover:bg-bg-surface-hover transition-colors flex items-center gap-3"
                  >
                    <Folder className="w-5 h-5 text-text-muted" />
                    <span>{project.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Advanced Search Modal — A7: Fix overflow for sort dropdown */}
      {showAdvancedSearch && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div 
            className="bg-bg-surface rounded-t-2xl sm:rounded-2xl p-6 w-full max-w-md border border-border-main shadow-2xl flex flex-col max-h-[90vh]"
            style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))', overflow: 'visible' }}
          >
            <div className="flex justify-between items-center mb-6 shrink-0">
              <h3 className="text-lg font-semibold">Advanced Search</h3>
              <button onClick={() => setShowAdvancedSearch(false)}><X className="w-5 h-5" /></button>
            </div>
            
            <div className="space-y-6 overflow-y-auto scrollbar-hide flex-1" style={{ overflow: 'visible' }}>
              <div style={{ overflow: 'visible' }}>
                <h4 className="text-sm font-medium text-text-muted mb-3">Sort By</h4>
                <select 
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value as any)}
                  className="w-full bg-bg-main border border-border-main rounded-xl px-4 py-2.5 text-text-main focus:outline-none"
                  style={{ boxShadow: 'none' }}
                  onFocus={e => { e.target.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.5)'; }}
                  onBlur={e => { e.target.style.boxShadow = 'none'; }}
                >
                  <option value="manual">Custom Order</option>
                  <option value="dateDesc">Newest First</option>
                  <option value="dateAsc">Oldest First</option>
                  <option value="editedDesc">Newly Edited</option>
                  <option value="nameAsc">Name (A-Z)</option>
                  <option value="nameDesc">Name (Z-A)</option>
                </select>
              </div>

              <div>
                <label className="flex items-center justify-between cursor-pointer">
                  <h4 className="text-sm font-medium text-text-muted">Show Dates on Cards</h4>
                  <div className={`relative w-10 h-6 rounded-full transition-colors ${showDates ? 'bg-accent' : 'bg-bg-main border border-border-main'}`}
                    onClick={() => setShowDates(prev => !prev)}
                  >
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${showDates ? 'translate-x-5' : 'translate-x-1'}`} />
                  </div>
                </label>
              </div>

              <div>
                <h4 className="text-sm font-medium text-text-muted mb-3">Date Range</h4>
                <div className="flex gap-2">
                  <input 
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="flex-1 bg-bg-main border border-border-main rounded-xl px-3 py-2 text-text-main focus:outline-none text-sm"
                    onFocus={e => { e.target.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.5)'; }}
                    onBlur={e => { e.target.style.boxShadow = 'none'; }}
                  />
                  <input 
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="flex-1 bg-bg-main border border-border-main rounded-xl px-3 py-2 text-text-main focus:outline-none text-sm"
                    onFocus={e => { e.target.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.5)'; }}
                    onBlur={e => { e.target.style.boxShadow = 'none'; }}
                  />
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-text-muted mb-3">Filter by Tags</h4>
                <div className="flex flex-wrap gap-2 max-h-60 overflow-y-auto pr-2">
                  {tags.map(tag => {
                    const isSelected = selectedSearchTags.has(tag.id);
                    return (
                      <button
                        key={tag.id}
                        onClick={() => {
                          const newTags = new Set(selectedSearchTags);
                          if (isSelected) newTags.delete(tag.id);
                          else newTags.add(tag.id);
                          setSelectedSearchTags(newTags);
                        }}
                        className={`text-xs font-medium px-3 py-1.5 rounded-full transition-all border ${
                          isSelected 
                            ? `${tag.color} text-text-main border-transparent` 
                            : 'bg-bg-main text-text-muted border-border-main hover:border-accent'
                        }`}
                      >
                        {tag.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-border-main flex justify-end gap-3 shrink-0">
              <button 
                onClick={() => {
                  setSelectedSearchTags(new Set());
                  setStartDate('');
                  setEndDate('');
                  setSortBy('dateDesc');
                  setShowDates(false);
                }}
                className="px-4 py-2 rounded-xl font-medium text-text-muted hover:bg-bg-surface-hover transition-colors"
              >
                Reset
              </button>
              <button 
                onClick={() => setShowAdvancedSearch(false)}
                className="px-4 py-2 rounded-xl font-medium bg-text-main text-bg-main hover:bg-text-secondary transition-colors"
              >
                Apply Filters
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal 
        isOpen={showDeleteConfirm}
        title="Delete Cards"
        message={`Are you sure you want to move ${selectedCards.size} selected card(s) to the recycle bin?`}
        confirmText="Move to Bin"
        onConfirm={async () => {
          const cardsToUpdate = Array.from(selectedCards)
            .map(id => cards.find(c => c.id === id))
            .filter((c): c is Card => c !== undefined)
            .map(c => ({ ...c, deletedAt: Date.now() }));
          
          if (cardsToUpdate.length > 0) {
            await updateCards(cardsToUpdate);
          }
          
          setSelectionMode(false);
          setSelectedCards(new Set());
          setShowDeleteConfirm(false);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
