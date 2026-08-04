import React, { useState, useEffect, useRef } from 'react';
import { Trash2, RefreshCcw, Image as ImageIcon, FileText, AlignLeft } from 'lucide-react';
import { useInView } from 'react-intersection-observer';

interface RecycleBinItemProps {
  item: any;
  type: 'card' | 'prompt' | 'block';
  daysRemaining: number;
  onRestore: (id: string) => void;
  onDelete: (id: string, type: 'card' | 'prompt' | 'block') => void;
}

export const RecycleBinItem = React.memo(function RecycleBinItem({
  item,
  type,
  daysRemaining,
  onRestore,
  onDelete
}: RecycleBinItemProps) {
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
    minHeight: itemHeight ? `${itemHeight}px` : '80px',
  };

  return (
    <div
      ref={inViewRef}
      style={style}
      className="bg-bg-surface border border-border-main rounded-2xl p-4 flex items-center justify-between transition-colors hover:bg-bg-surface-hover"
    >
      {inView ? (
        <div ref={contentRef} className="flex items-center justify-between w-full h-full">
          <div className="flex items-center gap-4">
            {type === 'card' ? (
              item.images && item.images.length > 0 ? (
                <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0">
                  <img src={item.images[0]} alt={item.name} className="w-full h-full object-cover" loading="lazy" />
                </div>
              ) : (
                <div className="w-12 h-12 rounded-lg bg-bg-surface-hover flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5 text-text-muted" />
                </div>
              )
            ) : type === 'prompt' ? (
              <div className="w-12 h-12 rounded-lg bg-bg-surface-hover flex items-center justify-center shrink-0">
                <ImageIcon className="w-5 h-5 text-text-muted" />
              </div>
            ) : (
              <div className="w-12 h-12 rounded-lg bg-bg-surface-hover flex items-center justify-center shrink-0">
                <AlignLeft className="w-5 h-5 text-text-muted" />
              </div>
            )}
            <div>
              <h4 className="font-semibold text-text-main line-clamp-1">{item.name || item.title}</h4>
              <p className="text-xs text-text-muted mt-1">
                {daysRemaining} days remaining
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button 
              onClick={() => onRestore(item.id)}
              className="p-2 text-text-muted hover:text-green-400 hover:bg-green-500/10 rounded-lg transition-colors"
              title="Restore"
            >
              <RefreshCcw className="w-5 h-5" />
            </button>
            <button 
              onClick={() => onDelete(item.id, type)}
              className="p-2 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
              title="Delete Permanently"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});
