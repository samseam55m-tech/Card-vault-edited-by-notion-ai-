import React, { useState, useEffect, useRef } from 'react';
import { Copy } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { cn } from '../utils';

interface StatItemProps {
  stat: any;
  index: number;
  onClick: (stat: any) => void;
}

export const StatItem = React.memo(function StatItem({ stat, index, onClick }: StatItemProps) {
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
    minHeight: itemHeight ? `${itemHeight}px` : '72px',
  };

  return (
    <div
      ref={inViewRef}
      style={style}
      onClick={() => onClick(stat)}
      className="bg-bg-surface border border-border-main rounded-2xl p-4 flex items-center justify-between cursor-pointer hover:bg-bg-surface-hover transition-colors"
    >
      {inView ? (
        <div ref={contentRef} className="flex items-center justify-between w-full h-full">
          <div className="flex items-center gap-4">
            <div className="w-8 h-8 rounded-full bg-bg-surface-hover flex items-center justify-center text-text-muted font-bold text-sm shrink-0">
              #{index + 1}
            </div>
            <div>
              <h3 className="font-semibold text-text-main line-clamp-1">
                {stat.title} 
                <span className="text-xs text-text-muted ml-2">
                  ({stat.generationName ? `${stat.generationName} - ` : ''}{stat.variationName})
                </span>
              </h3>
              <p className="text-sm text-text-muted line-clamp-1">
                from {stat.parentName}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-text-muted bg-bg-main px-3 py-1.5 rounded-lg border border-border-main shrink-0">
            <Copy className="w-4 h-4" />
            <span className="font-medium">{stat.copyCount}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
});
