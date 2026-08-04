import React, { useState, useMemo } from 'react';
import { useScrollRestoration, useStickyState } from '../hooks/useViewState';
import { Plus, Folder, Trash2, Search, Pin, PinOff, Edit2, X, SlidersHorizontal, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { generateId, cn } from '../utils';
import ConfirmModal from '../components/ConfirmModal';
import { motion, AnimatePresence } from 'motion/react';
import { ProjectItem } from '../components/ProjectItem';
import { useScrollDirection } from '../hooks/useScrollDirection';
import { useLayout, LAYOUT_HIDE_SLIDE_PX } from '../components/Layout';

const HIDE_SLIDE_PX = LAYOUT_HIDE_SLIDE_PX;

const PROJECT_COLORS = [
  'text-text-muted', 'text-blue-400', 'text-yellow-400', 'text-green-400', 
  'text-purple-400', 'text-pink-400', 'text-orange-400', 'text-teal-400',
  'text-red-400', 'text-indigo-400', 'text-cyan-400', 'text-emerald-400'
];

export default function ProjectFiles() {
  const { projects, cards, tags, addProject, deleteProject, updateProject, loading, vaultEpoch } = useStore();

  // Search, sort, date range, tag filter and the pinned filter survive
  // navigating into a project and back. Keyed by `vaultEpoch` so a cloud
  // restore or sign-out wipe clears them. Modals and selection mode stay
  // plain local state.
  const viewKey = `projects:${vaultEpoch}`;
  const scrollRef = useScrollRestoration<HTMLDivElement>(viewKey, !loading);
  const navigate = useNavigate();
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(PROJECT_COLORS[0]);
  const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
  
  const [searchQuery, setSearchQuery] = useStickyState(`${viewKey}:searchQuery`, '');
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [projectToRename, setProjectToRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { barsVisible } = useScrollDirection(5);
  const { setSelectionActive } = useLayout();
  const effectiveVisible = barsVisible || selectionMode;

  React.useEffect(() => {
    setSelectionActive(selectionMode);
    return () => setSelectionActive(false);
  }, [selectionMode, setSelectionActive]);

  const handleDeleteSelected = async () => {
    for (const id of Array.from(selectedProjects)) {
      await deleteProject(id);
    }
    setSelectionMode(false);
    setSelectedProjects(new Set());
    setShowDeleteConfirm(false);
  };

  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [sortBy, setSortBy] = useStickyState<'dateDesc' | 'dateAsc' | 'nameAsc' | 'nameDesc'>(`${viewKey}:sortBy`, 'dateDesc');
  const [startDate, setStartDate] = useStickyState(`${viewKey}:startDate`, '');
  const [endDate, setEndDate] = useStickyState(`${viewKey}:endDate`, '');
  const [selectedSearchTags, setSelectedSearchTags] = useStickyState<Set<string>>(`${viewKey}:searchTags`, new Set());
  const [filterPinned, setFilterPinned] = useStickyState<'all' | 'pinned' | 'unpinned'>(`${viewKey}:filterPinned`, 'all');

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    const newProject = {
      id: generateId(),
      name: newGroupName,
      cardIds: [],
      createdAt: Date.now(),
      color: newGroupColor,
    };
    await addProject(newProject);
    setNewGroupName('');
    setNewGroupColor(PROJECT_COLORS[0]);
    setShowCreateGroup(false);
  };

  const handleDeleteProject = async () => {
    if (projectToDelete) {
      await deleteProject(projectToDelete);
      setProjectToDelete(null);
      setSelectedProjects(prev => {
        const next = new Set(prev);
        next.delete(projectToDelete);
        if (next.size === 0) setSelectionMode(false);
        return next;
      });
    }
  };

  const handleRenameProject = async () => {
    if (!projectToRename || !renameValue.trim()) return;
    const project = projects.find(p => p.id === projectToRename);
    if (project) {
      await updateProject({ ...project, name: renameValue });
    }
    setShowRenameModal(false);
    setProjectToRename(null);
    setRenameValue('');
    setSelectionMode(false);
    setSelectedProjects(new Set());
  };

  const handleTogglePin = async () => {
    const projectsToUpdate = Array.from(selectedProjects)
      .map(id => projects.find(p => p.id === id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    
    if (projectsToUpdate.length > 0) {
      const allPinned = projectsToUpdate.every(p => p.isPinned);
      for (const project of projectsToUpdate) {
        await updateProject({ ...project, isPinned: !allPinned });
      }
    }
    setSelectionMode(false);
    setSelectedProjects(new Set());
  };

  const handleLongPress = (id: string) => {
    if (!selectionMode) {
      setSelectionMode(true);
      setSelectedProjects(new Set([id]));
    }
  };

  const toggleSelection = (id: string) => {
    const newSelection = new Set(selectedProjects);
    if (newSelection.has(id)) {
      newSelection.delete(id);
      if (newSelection.size === 0) setSelectionMode(false);
    } else {
      newSelection.add(id);
    }
    setSelectedProjects(newSelection);
  };

  const getProjectTags = (cardIds: string[] | undefined) => {
    if (!cardIds) return [];
    const projectCards = cards.filter(c => cardIds.includes(c.id));
    const tagCounts = new Map<string, number>();
    
    projectCards.forEach(card => {
      (card.tags || []).forEach(tagId => {
        tagCounts.set(tagId, (tagCounts.get(tagId) || 0) + 1);
      });
    });

    const sortedTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tagId]) => tags?.find(t => t.id === tagId))
      .filter(Boolean);

    return sortedTags;
  };

  const handleProjectClick = React.useCallback((id: string) => {
    if (selectionMode) {
      toggleSelection(id);
    } else {
      navigate(`/project/${id}`);
    }
  }, [selectionMode, toggleSelection, navigate]);

  const handleProjectLongPress = React.useCallback((id: string) => {
    handleLongPress(id);
  }, [handleLongPress]);

  const filteredProjects = useMemo(() => {
    let filtered = projects;
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p => (p.name || '').toLowerCase().includes(query));
    }

    if (filterPinned === 'pinned') {
      filtered = filtered.filter(p => p.isPinned);
    } else if (filterPinned === 'unpinned') {
      filtered = filtered.filter(p => !p.isPinned);
    }

    if (startDate) {
      const start = new Date(startDate).getTime();
      filtered = filtered.filter(p => p.createdAt >= start);
    }
    if (endDate) {
      const end = new Date(endDate).getTime() + 86400000; // Include the whole end day
      filtered = filtered.filter(p => p.createdAt <= end);
    }

    if (selectedSearchTags.size > 0) {
      filtered = filtered.filter(p => {
        const projectTags = getProjectTags(p.cardIds);
        return Array.from(selectedSearchTags).every(tagId => 
          projectTags.some(t => t?.id === tagId)
        );
      });
    }
    
    return filtered.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      
      switch (sortBy) {
        case 'nameAsc': return a.name.localeCompare(b.name);
        case 'nameDesc': return b.name.localeCompare(a.name);
        case 'dateAsc': return a.createdAt - b.createdAt;
        case 'dateDesc':
        default: return b.createdAt - a.createdAt;
      }
    });
  }, [projects, searchQuery, filterPinned, startDate, endDate, selectedSearchTags, sortBy, cards, tags]);

  const pinnedProjects = useMemo(() => filteredProjects.filter(p => p.isPinned), [filteredProjects]);
  const unpinnedProjects = useMemo(() => filteredProjects.filter(p => !p.isPinned), [filteredProjects]);

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
      <div className="p-4 pb-4 flex flex-col gap-3">
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
                  <button onClick={() => { setSelectionMode(false); setSelectedProjects(new Set()); }} className="p-2 hover:bg-bg-surface-hover rounded-lg">
                    <X className="w-5 h-5" />
                  </button>
                  <span className="font-medium">{selectedProjects.size} selected</span>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={handleTogglePin}
                    className="p-1.5 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-lg transition-colors"
                    title="Toggle Pin"
                  >
                    {Array.from(selectedProjects).every(id => projects.find(p => p.id === id)?.isPinned) ? <PinOff className="w-5 h-5" /> : <Pin className="w-5 h-5" />}
                  </button>
                  {selectedProjects.size === 1 && (
                    <button 
                      onClick={() => {
                        const id = Array.from(selectedProjects)[0];
                        const project = projects.find(p => p.id === id);
                        if (project) {
                          setProjectToRename(id);
                          setRenameValue(project.name);
                          setShowRenameModal(true);
                        }
                      }}
                      className="p-1.5 text-text-muted hover:text-text-main hover:bg-bg-surface-hover rounded-lg transition-colors"
                      title="Rename"
                    >
                      <Edit2 className="w-5 h-5" />
                    </button>
                  )}
                  <button 
                    onClick={() => setShowDeleteConfirm(true)}
                    className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                    title="Delete"
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
                className="flex-1 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                {/* Duplicate page title removed — "Card Gallery" is already
                    rendered in the app header breadcrumb above. */}
                <div className="flex items-center gap-2 w-full">
                  <div className="relative flex-1 sm:w-64">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
                    <input
                      type="text"
                      placeholder="Search projects..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-bg-surface border border-border-main rounded-xl pl-9 pr-4 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                  <button 
                    onClick={() => setShowAdvancedSearch(true)}
                    className="p-2 bg-bg-surface border border-border-main rounded-xl hover:bg-bg-surface-hover transition-colors"
                  >
                    <SlidersHorizontal className="w-5 h-5 text-text-muted" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      </div>
      
      {/* ── FULL-HEIGHT SCROLL CONTAINER ── */}
      <div
        ref={scrollRef}
        className="w-full h-full overflow-y-auto p-4"
        style={{
          overscrollBehavior: 'none',
          // Header offset now derives from the shared --app-header-h token
          // instead of re-deriving `safe-top + 56px` by hand in every page.
          paddingTop: 'var(--page-pad-top-toolbar)',
          paddingBottom: 'var(--page-pad-bottom)',
        }}
      >
      {filteredProjects.length > 0 && (
        <div className="space-y-8">
          {pinnedProjects.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4 px-2">Pinned</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {pinnedProjects.map(project => {
                  const projectTags = getProjectTags(project.cardIds).slice(0, 3);
                  const isSelected = selectedProjects.has(project.id);
                  
                  return (
                    <ProjectItem
                      key={project.id}
                      project={project}
                      isSelected={isSelected}
                      selectionMode={selectionMode}
                      projectTags={projectTags}
                      onClick={handleProjectClick}
                      onLongPress={handleProjectLongPress}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {pinnedProjects.length > 0 && unpinnedProjects.length > 0 && (
            <div className="h-px bg-bg-surface-hover/50 w-full" />
          )}

          {unpinnedProjects.length > 0 && (
            <div>
              {pinnedProjects.length > 0 && <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4 px-2">Others</h3>}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {unpinnedProjects.map(project => {
                  const projectTags = getProjectTags(project.cardIds).slice(0, 3);
                  const isSelected = selectedProjects.has(project.id);
                  
                  return (
                    <ProjectItem
                      key={project.id}
                      project={project}
                      isSelected={isSelected}
                      selectionMode={selectionMode}
                      projectTags={projectTags}
                      onClick={handleProjectClick}
                      onLongPress={handleProjectLongPress}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {filteredProjects.length === 0 && (
        <div className="h-full flex flex-col items-center justify-center text-text-muted mt-20">
          <Folder className="w-16 h-16 opacity-20 mb-4" />
          <p className="font-medium text-base">{searchQuery ? 'No projects match your search.' : 'No projects yet'}</p>
          <p className="text-sm mt-1 opacity-70">{searchQuery ? 'Try a different search.' : 'Tap + to create your first project.'}</p>
        </div>
      )}
      </div>

      {/* ── ABSOLUTE FAB ── */}
      <button 
        onClick={() => setShowCreateGroup(true)}
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
                <h4 className="text-sm font-medium text-text-muted mb-3">Pinned Status</h4>
                <div className="flex gap-2">
                  <button
                    onClick={() => setFilterPinned('all')}
                    className={cn(
                      "flex-1 py-2 rounded-xl text-sm font-medium transition-colors",
                      filterPinned === 'all' ? "bg-text-main text-bg-main" : "bg-bg-surface-hover text-text-muted hover:bg-bg-surface-hover"
                    )}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setFilterPinned('pinned')}
                    className={cn(
                      "flex-1 py-2 rounded-xl text-sm font-medium transition-colors",
                      filterPinned === 'pinned' ? "bg-text-main text-bg-main" : "bg-bg-surface-hover text-text-muted hover:bg-bg-surface-hover"
                    )}
                  >
                    Pinned
                  </button>
                  <button
                    onClick={() => setFilterPinned('unpinned')}
                    className={cn(
                      "flex-1 py-2 rounded-xl text-sm font-medium transition-colors",
                      filterPinned === 'unpinned' ? "bg-text-main text-bg-main" : "bg-bg-surface-hover text-text-muted hover:bg-bg-surface-hover"
                    )}
                  >
                    Unpinned
                  </button>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-text-muted mb-3">Date Created</h4>
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
                        className={cn(
                          "px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-2",
                          isSelected 
                            ? "bg-text-main text-bg-main" 
                            : "bg-bg-surface-hover text-text-muted hover:bg-bg-surface-hover"
                        )}
                      >
                        <div className={cn("w-2 h-2 rounded-full", tag.color)} />
                        {tag.name}
                        {isSelected && <Check className="w-3 h-3 ml-1" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-8 pt-4 border-t border-border-main flex justify-end gap-3 shrink-0">
              <button 
                onClick={() => {
                  setSortBy('dateDesc');
                  setStartDate('');
                  setEndDate('');
                  setSelectedSearchTags(new Set());
                  setFilterPinned('all');
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

      {/* Create Group Modal */}
      {showCreateGroup && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4">
          <div className="bg-bg-surface rounded-2xl p-6 w-full max-w-sm border border-border-main shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">Create Project</h3>
            <input 
              type="text" 
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Project Name"
              className="w-full bg-bg-main border border-border-main rounded-xl px-4 py-3 text-text-main focus:outline-none focus:ring-2 focus:ring-accent mb-4"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handleCreateGroup()}
            />
            
            <div className="mb-6">
              <label className="text-sm text-text-muted mb-2 block">Icon Color</label>
              <div className="flex flex-wrap gap-2">
                {PROJECT_COLORS.map(color => (
                  <button
                    key={color}
                    onClick={() => setNewGroupColor(color)}
                    className={cn(
                      "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                      newGroupColor === color ? "bg-bg-surface-hover ring-2 ring-accent" : "hover:bg-bg-surface-hover/50"
                    )}
                  >
                    <div className={cn("w-4 h-4 rounded-full bg-current", color)} />
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setShowCreateGroup(false)}
                className="px-4 py-2 rounded-xl font-medium text-text-muted hover:bg-bg-surface-hover transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleCreateGroup}
                className="px-4 py-2 rounded-xl font-medium bg-text-main text-bg-main hover:bg-text-secondary transition-colors"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {showRenameModal && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4">
          <div className="bg-bg-surface rounded-2xl p-6 w-full max-w-sm border border-border-main shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">Rename Project</h3>
            <input 
              type="text" 
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Project Name"
              className="w-full bg-bg-main border border-border-main rounded-xl px-4 py-3 text-text-main focus:outline-none focus:ring-2 focus:ring-accent mb-6"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && handleRenameProject()}
            />
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => {
                  setShowRenameModal(false);
                  setProjectToRename(null);
                }}
                className="px-4 py-2 rounded-xl font-medium text-text-muted hover:bg-bg-surface-hover transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleRenameProject}
                className="px-4 py-2 rounded-xl font-medium bg-text-main text-bg-main hover:bg-text-secondary transition-colors"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal 
        isOpen={showDeleteConfirm}
        title="Delete Projects"
        message={`Are you sure you want to delete ${selectedProjects.size} selected project(s)? The cards inside will not be deleted.`}
        confirmText="Delete"
        onConfirm={handleDeleteSelected}
        onCancel={() => setShowDeleteConfirm(false)}
      />
      <ConfirmModal 
        isOpen={!!projectToDelete}
        title="Delete Project"
        message="Are you sure you want to delete this project? The cards inside will not be deleted."
        confirmText="Delete"
        onConfirm={handleDeleteProject}
        onCancel={() => setProjectToDelete(null)}
      />
    </div>
  );
}
