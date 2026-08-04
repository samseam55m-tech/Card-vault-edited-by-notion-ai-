import React, { useEffect, useState, useMemo } from 'react';
import { useScrollRestoration, useStickyState } from '../hooks/useViewState';
import { setMorphOrigin } from '../morphOrigin';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import CardItem from '../components/CardItem';
import ConfirmModal from '../components/ConfirmModal';
import { Plus, X, ArrowLeft, GripVertical, Trash2, Search, SlidersHorizontal, FolderPlus, Pin, PinOff } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy } from '@dnd-kit/sortable';
import { useScrollDirection } from '../hooks/useScrollDirection';
import { useLayout, LAYOUT_HIDE_SLIDE_PX } from '../components/Layout';

const HIDE_SLIDE_PX = LAYOUT_HIDE_SLIDE_PX;

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { projects, cards, updateProject, updateCards, tags, loading, vaultEpoch } = useStore();

  // Scoped per project as well as per vault epoch: each project keeps its own
  // search and sort, and opening a different project starts clean rather than
  // inheriting the last one's filters.
  const viewKey = `project:${id ?? 'unknown'}:${vaultEpoch}`;
  const scrollRef = useScrollRestoration<HTMLDivElement>(viewKey, !loading);
  
  const project = projects.find(p => p.id === id);
  
  const [searchQuery, setSearchQuery] = useStickyState(`${viewKey}:searchQuery`, '');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedToAdd, setSelectedToAdd] = useState<Set<string>>(new Set());

  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [selectedSearchTags, setSelectedSearchTags] = useStickyState<Set<string>>(`${viewKey}:searchTags`, new Set());
  const [sortBy, setSortBy] = useStickyState<'dateDesc' | 'dateAsc' | 'nameAsc' | 'nameDesc'>(`${viewKey}:sortBy`, 'dateDesc');
  const [startDate, setStartDate] = useStickyState(`${viewKey}:startDate`, '');
  const [endDate, setEndDate] = useStickyState(`${viewKey}:endDate`, '');
  const [searchFilter, setSearchFilter] = useStickyState<'all' | 'headerBlocks' | 'cards'>(`${viewKey}:searchFilter`, 'all');
  const { barsVisible } = useScrollDirection(5);
  const { setSelectionActive } = useLayout();
  const effectiveVisible = barsVisible || selectionMode;

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

  const projectCards = useMemo(() => {
    if (!project) return [];
    let _cards = (project.cardIds || []).map(cardId => cards.find(c => c.id === cardId && !c.deletedAt)).filter(Boolean) as typeof cards;
    
    _cards = _cards.filter(card => {
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

    return _cards.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      
      switch (sortBy) {
        case 'dateDesc': return b.createdAt - a.createdAt;
        case 'dateAsc': return a.createdAt - b.createdAt;
        case 'nameAsc': return a.name.localeCompare(b.name);
        case 'nameDesc': return b.name.localeCompare(a.name);
        default: return 0;
      }
    });
  }, [project, cards, searchQuery, searchFilter, selectedSearchTags, sortBy, startDate, endDate]);

  const pinnedCards = useMemo(() => projectCards.filter(c => c.isPinned), [projectCards]);
  const unpinnedCards = useMemo(() => projectCards.filter(c => !c.isPinned), [projectCards]);

  if (!project) {
    return <div className="p-4 text-center text-text-muted">Project not found</div>;
  }

  const availableCards = cards.filter(c => !(project.cardIds || []).includes(c.id) && !c.deletedAt);

  const handleAddCards = async () => {
    const newCardIds = [...(project.cardIds || []), ...Array.from(selectedToAdd)];
    await updateProject({ ...project, cardIds: newCardIds });
    setShowAddModal(false);
    setSelectedToAdd(new Set());
  };

  const toggleAddSelection = React.useCallback((cardId: string) => {
    setSelectedToAdd(prev => {
      const newSelection = new Set(prev);
      if (newSelection.has(cardId)) {
        newSelection.delete(cardId);
      } else {
        newSelection.add(cardId);
      }
      return newSelection;
    });
  }, []);

  const handleLongPress = React.useCallback((cardId: string) => {
    setSelectionMode(prevMode => {
      if (!prevMode) {
        setSelectedCards(new Set([cardId]));
        return true;
      }
      return prevMode;
    });
  }, []);

  const toggleSelection = React.useCallback((cardId: string) => {
    setSelectedCards(prev => {
      const newSelection = new Set(prev);
      if (newSelection.has(cardId)) {
        newSelection.delete(cardId);
        if (newSelection.size === 0) {
          setSelectionMode(false);
        }
      } else {
        newSelection.add(cardId);
      }
      return newSelection;
    });
  }, []);

  // v1.13.0: the morph is a hand-rolled FLIP driven by the card's own measured
  // rect, so nothing here needs to enrol a card in layout projection or defer
  // the navigation by a frame. See `src/morphOrigin.ts`.
  const handleCardClick = React.useCallback((id: string, rect?: DOMRect) => {
    if (rect) setMorphOrigin(id, rect);
    navigate(`/entry/${id}`);
  }, [navigate]);

  const handleTogglePinSingle = React.useCallback((card: typeof cards[0]) => {
    updateCards([{ ...card, isPinned: !card.isPinned }]);
  }, [updateCards]);

  const handleRemoveSelected = async () => {
    const newCardIds = project.cardIds.filter(id => !selectedCards.has(id));
    await updateProject({ ...project, cardIds: newCardIds });
    setSelectionMode(false);
    setSelectedCards(new Set());
  };

  const handleTogglePin = async () => {
    const cardsToUpdate = Array.from(selectedCards)
      .map(id => cards.find(c => c.id === id))
      .filter((c): c is typeof cards[0] => c !== undefined);
    
    if (cardsToUpdate.length > 0) {
      const allPinned = cardsToUpdate.every(c => c.isPinned);
      const updatedCards = cardsToUpdate.map(c => ({ ...c, isPinned: !allPinned }));
      await updateCards(updatedCards);
    }
    setSelectionMode(false);
    setSelectedCards(new Set());
  };

  const handleDeleteSelected = async () => {
    const cardsToUpdate = Array.from(selectedCards)
      .map(cardId => cards.find(c => c.id === cardId))
      .filter((c): c is typeof cards[0] => c !== undefined)
      .map(c => ({ ...c, deletedAt: Date.now() }));
    
    if (cardsToUpdate.length > 0) {
      await updateCards(cardsToUpdate);
    }
    
    setSelectionMode(false);
    setSelectedCards(new Set());
    setShowDeleteConfirm(false);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = project.cardIds.findIndex(id => id === active.id);
      const newIndex = project.cardIds.findIndex(id => id === over.id);
      
      const newCardIds = arrayMove(project.cardIds, oldIndex, newIndex);
      await updateProject({ ...project, cardIds: newCardIds });
    }
  };

  return (
    <div className="w-full h-full overflow-hidden relative">
      {/* ── ABSOLUTE TOP HEADER ── */}
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
          <button onClick={() => navigate('/projects')} className="p-2 hover:bg-bg-surface-hover rounded-lg -ml-2 shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </button>
          
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
                    onClick={handleRemoveSelected}
                    className="flex items-center gap-2 px-3 py-1.5 bg-bg-surface-hover text-text-main rounded-lg font-medium hover:bg-bg-surface-hover"
                    title="Remove from project"
                  >
                    <X className="w-4 h-4" />
                    <span className="hidden sm:inline">Remove</span>
                  </button>
                  <button 
                    onClick={() => setShowDeleteConfirm(true)}
                    className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                    title="Move to Recycle Bin"
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
                    placeholder={`Search in ${project.name}...`}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full bg-bg-surface border border-border-main rounded-xl pl-10 pr-4 py-2.5 text-text-main focus:outline-none focus:ring-2 focus:ring-accent"
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

      {/* ── FULL-HEIGHT SCROLL CONTAINER ── */}
      <div
        ref={scrollRef}
        className="w-full h-full overflow-y-auto px-4"
        style={{
          overscrollBehavior: 'none',
          paddingTop: 'var(--page-pad-top-toolbar)',
          paddingBottom: 'var(--page-pad-bottom)',
        }}
      >
        {projectCards.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-text-muted">
            <Plus className="w-16 h-16 opacity-20 mb-4" />
            <p className="font-medium text-base">This project is empty</p>
            <p className="text-sm mt-1 opacity-70">Tap + to add cards to this project.</p>
          </div>
        ) : (
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
                  <div className="columns-2 sm:columns-3 gap-4 space-y-4">
                    {pinnedCards.map(card => (
                      <CardItem 
                        key={card.id} 
                        card={card} 
                        tags={tags}
                        onTogglePin={handleTogglePinSingle}
                        selected={selectionMode ? selectedCards.has(card.id) : undefined}
                        onSelect={selectionMode ? toggleSelection : undefined}
                        onLongPress={handleLongPress}
                        onClick={handleCardClick}
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
                  <div className="columns-2 sm:columns-3 gap-4 space-y-4">
                    {unpinnedCards.map(card => (
                      <CardItem 
                        key={card.id} 
                        card={card} 
                        tags={tags}
                        onTogglePin={handleTogglePinSingle}
                        selected={selectionMode ? selectedCards.has(card.id) : undefined}
                        onSelect={selectionMode ? toggleSelection : undefined}
                        onLongPress={handleLongPress}
                        onClick={handleCardClick}
                      />
                    ))}
                  </div>
                </SortableContext>
              </div>
            )}
          </DndContext>
        )}
      </div>

      {/* ── ABSOLUTE FAB ── */}
      <button 
        onClick={() => setShowAddModal(true)}
        className="absolute z-[90] w-14 h-14 rounded-2xl shadow-2xl flex items-center justify-center bg-text-main text-bg-main active:scale-[0.92] will-change-transform"
        style={{
          right: 16,
          bottom: 'calc(var(--safe-bottom, 0px) + 80px + 16px)',
          transform: `translateY(${effectiveVisible ? '0px' : `${HIDE_SLIDE_PX}px`})`,
          transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <Plus className="w-8 h-8" />
      </button>

      {/* Add Cards Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-end sm:items-center justify-center p-4">
          <div className="bg-bg-surface rounded-t-2xl sm:rounded-2xl p-6 w-full max-w-2xl border border-border-main shadow-2xl max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center mb-4 shrink-0">
              <h3 className="text-lg font-semibold">Add Cards to Project</h3>
              <button onClick={() => setShowAddModal(false)}><X className="w-5 h-5" /></button>
            </div>
            
            <div className="flex-1 overflow-y-auto mb-4 pr-2">
              {availableCards.length === 0 ? (
                <p className="text-text-muted text-center py-8">No available cards to add.</p>
              ) : (
                <div className="columns-2 sm:columns-3 gap-3 space-y-3">
                  {availableCards.map(card => (
                    <CardItem 
                      key={card.id} 
                      card={card} 
                      tags={tags}
                      onTogglePin={handleTogglePinSingle}
                      selected={selectedToAdd.has(card.id)}
                      isSortable={false}
                      onClick={toggleAddSelection}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 pt-4 border-t border-border-main flex justify-end gap-3">
              <button 
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 rounded-xl font-medium text-text-muted hover:bg-bg-surface-hover transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleAddCards}
                disabled={selectedToAdd.size === 0}
                className="px-4 py-2 rounded-xl font-medium bg-text-main text-bg-main hover:bg-text-secondary transition-colors disabled:opacity-50 disabled:hover:bg-text-main"
              >
                Add {selectedToAdd.size > 0 ? `(${selectedToAdd.size})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Advanced Search Modal */}
      {showAdvancedSearch && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div 
            className="bg-bg-surface rounded-t-2xl sm:rounded-2xl p-6 w-full max-w-md border border-border-main shadow-2xl flex flex-col max-h-[90vh]"
            style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}
          >
            <div className="flex justify-between items-center mb-6 shrink-0">
              <h3 className="text-lg font-semibold">Advanced Search</h3>
              <button onClick={() => setShowAdvancedSearch(false)}><X className="w-5 h-5" /></button>
            </div>
            
            <div className="space-y-6 overflow-y-auto scrollbar-hide flex-1">
              <div>
                <h4 className="text-sm font-medium text-text-muted mb-3">Sort By</h4>
                <select 
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value as any)}
                  className="w-full bg-bg-main border border-border-main rounded-xl px-4 py-2.5 text-text-main focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <option value="dateDesc">Newest First</option>
                  <option value="dateAsc">Oldest First</option>
                  <option value="nameAsc">Name (A-Z)</option>
                  <option value="nameDesc">Name (Z-A)</option>
                </select>
              </div>

              <div>
                <h4 className="text-sm font-medium text-text-muted mb-3">Date Range</h4>
                <div className="flex gap-2">
                  <input 
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="flex-1 bg-bg-main border border-border-main rounded-xl px-3 py-2 text-text-main focus:outline-none focus:ring-2 focus:ring-accent text-sm"
                  />
                  <input 
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="flex-1 bg-bg-main border border-border-main rounded-xl px-3 py-2 text-text-main focus:outline-none focus:ring-2 focus:ring-accent text-sm"
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
                }}
                className="px-4 py-2 rounded-xl font-medium text-text-muted hover:bg-bg-surface-hover transition-colors"
              >
                Reset
              </button>
              <button 
                onClick={() => setShowAdvancedSearch(false)}
                className="px-6 py-2 rounded-xl font-medium bg-text-main text-bg-main hover:bg-text-secondary transition-colors"
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
        onConfirm={handleDeleteSelected}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
