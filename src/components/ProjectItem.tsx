import React, { useState, useEffect, useRef } from 'react';
import { Folder, Pin } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { cn } from '../utils';
import { Project, Tag } from '../types';

interface ProjectItemProps {
  project: Project;
  isSelected: boolean;
  selectionMode: boolean;
  projectTags: (Tag | undefined)[];
  onClick: (id: string) => void;
  onLongPress: (id: string) => void;
}

export const ProjectItem = React.memo(function ProjectItem({
  project,
  isSelected,
  selectionMode,
  projectTags,
  onClick,
  onLongPress
}: ProjectItemProps) {
  const { ref: inViewRef, inView } = useInView({
    rootMargin: '600px 0px',
    triggerOnce: false,
  });

  const [itemHeight, setItemHeight] = useState<number | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (inView && contentRef.current) {
      const observer = new ResizeObserver((entries) => {
        for (let entry of entries) {
          setItemHeight(entry.contentRect.height);
        }
      });
      observer.observe(contentRef.current);
      return () => observer.disconnect();
    }
  }, [inView]);

  const style = {
    minHeight: itemHeight ? `${itemHeight}px` : '150px',
  };

  // See CardItem: a render-body `let timer` was cleared on the wrong binding
  // whenever a re-render landed between touchstart and touchend, so long-press
  // selection triggered spuriously after the finger lifted.
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
      onLongPress(project.id);
    }, 500);
  };

  const handleTouchEnd = () => clearLongPress();
  const handleTouchMove = () => clearLongPress();

  useEffect(() => clearLongPress, []);

  return (
    <div
      ref={inViewRef}
      style={style}
      onClick={() => onClick(project.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onLongPress(project.id);
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onMouseDown={handleTouchStart}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
      className={cn(
        "bg-bg-surface border rounded-3xl p-5 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all aspect-square relative group select-none",
        isSelected ? "border-accent bg-bg-surface-hover/80 shadow-lg" : "border-border-main hover:bg-bg-surface-hover hover:border-border-main hover:shadow-xl"
      )}
    >
      {inView ? (
        <div ref={contentRef} className="flex flex-col items-center justify-center w-full h-full">
          {project.isPinned && !isSelected && (
            <div className="absolute top-3 left-3 text-text-muted">
              <Pin className="w-3.5 h-3.5" />
            </div>
          )}

          <Folder className={cn("w-12 h-12 transition-colors", project.color || "text-text-muted group-hover:text-text-secondary")} />
          
          <div className="text-center w-full px-2 mt-3">
            <span className="font-semibold text-text-main line-clamp-1">{project.name}</span>
            <span className="text-xs text-text-muted mt-1 block">{(project.cardIds || []).length} cards</span>
          </div>

          {projectTags.length > 0 && (
            <div className="flex gap-1 mt-2">
              {projectTags.map((tag, i) => tag && (
                <div key={i} className={cn("w-2.5 h-2.5 rounded-full", tag.color)} title={tag.name} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});
