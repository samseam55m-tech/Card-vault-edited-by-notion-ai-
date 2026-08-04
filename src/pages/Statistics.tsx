import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Copy, FileText, Image as ImageIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '../utils';
import { StatItem } from '../components/StatItem';

export default function Statistics() {
  const { cards, promptProjects } = useStore();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'cards' | 'prompts'>('cards');

  const cardStats = useMemo(() => {
    const activeCards = cards.filter(c => !c.deletedAt);
    const allStats: any[] = [];

    activeCards.forEach(card => {
      // Process G1 (Default)
      (card.headerBlocks || []).forEach(block => {
        if (block.copyCount && block.copyCount > 0) {
          allStats.push({
            ...block,
            parentId: card.id,
            parentName: card.name,
            type: 'card',
            generationName: 'G1',
            variationName: 'V1',
            copyCount: block.copyCount
          });
        }
        if (block.variations) {
          block.variations.forEach(v => {
            if (v.copyCount && v.copyCount > 0) {
              allStats.push({
                ...block,
                parentId: card.id,
                parentName: card.name,
                type: 'card',
                generationName: 'G1',
                variationName: v.name,
                copyCount: v.copyCount
              });
            }
          });
        }
      });

      // Process other generations
      if (card.variations) {
        card.variations.forEach(gen => {
          (gen.headerBlocks || []).forEach(block => {
            if (block.copyCount && block.copyCount > 0) {
              allStats.push({
                ...block,
                parentId: card.id,
                parentName: card.name,
                type: 'card',
                generationName: gen.name,
                variationName: 'V1',
                copyCount: block.copyCount
              });
            }
            if (block.variations) {
              block.variations.forEach(v => {
                if (v.copyCount && v.copyCount > 0) {
                  allStats.push({
                    ...block,
                    parentId: card.id,
                    parentName: card.name,
                    type: 'card',
                    generationName: gen.name,
                    variationName: v.name,
                    copyCount: v.copyCount
                  });
                }
              });
            }
          });
        });
      }
    });

    return allStats.sort((a, b) => (b.copyCount || 0) - (a.copyCount || 0));
  }, [cards]);

  const promptStats = useMemo(() => {
    const activePrompts = promptProjects.filter(p => !p.deletedAt);
    const allStats: any[] = [];

    activePrompts.forEach(project => {
      (project.blocks || []).forEach(block => {
        if (block.copyCount && block.copyCount > 0) {
          allStats.push({
            ...block,
            parentId: project.id,
            parentName: project.name,
            type: 'prompt',
            variationName: 'V1',
            copyCount: block.copyCount
          });
        }
        if (block.variations) {
          block.variations.forEach(v => {
            if (v.copyCount && v.copyCount > 0) {
              allStats.push({
                ...block,
                parentId: project.id,
                parentName: project.name,
                type: 'prompt',
                variationName: v.name,
                copyCount: v.copyCount
              });
            }
          });
        }
      });
    });

    return allStats.sort((a, b) => (b.copyCount || 0) - (a.copyCount || 0));
  }, [promptProjects]);

  const currentStats = activeTab === 'cards' ? cardStats : promptStats;

  const handleStatClick = React.useCallback((stat: any) => {
    navigate(stat.type === 'card' ? `/entry/${stat.parentId}` : `/prompt/${stat.parentId}`);
  }, [navigate]);

  return (
    // `pt-[72px]` was a hard-coded guess that is smaller than the real header
    // (safe-area inset + 56px). On a device with a punch-hole cutout the header
    // covered the page. Now driven by the --app-header-h token.
    <div
      className="flex-1 flex flex-col h-full overflow-y-auto p-4"
      style={{
        paddingTop: 'var(--page-pad-top)',
        paddingBottom: 'var(--page-pad-bottom)',
      }}
    >
      {/* The page name is already shown in the app header breadcrumb, so the
          large in-page duplicate heading has been removed. Only the tab
          switcher remains here. */}
      <div className="flex items-center justify-end mb-6 px-2">
        
        <div className="flex bg-bg-surface rounded-xl p-1 border border-border-main">
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
        </div>
      </div>

      {currentStats.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-text-muted mt-20">
          <Copy className="w-16 h-16 opacity-20 mb-4" />
          <p className="font-medium text-base">No copies recorded yet</p>
          <p className="text-sm mt-1 opacity-70">Copy header blocks to see statistics here.</p>
        </div>
      ) : (
        <div className="space-y-4 max-w-3xl mx-auto w-full">
          {currentStats.map((stat, index) => (
            <StatItem
              key={`${stat.parentId}-${stat.id}-${stat.generationName || 'default'}-${stat.variationName}`}
              stat={stat}
              index={index}
              onClick={handleStatClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
