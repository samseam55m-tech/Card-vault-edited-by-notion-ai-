import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDestructive?: boolean;
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  isDestructive = true,
}: ConfirmModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onCancel}
          />
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="relative bg-bg-surface border border-border-main rounded-2xl p-6 w-full max-w-sm shadow-2xl"
          >
            <div className="flex items-start gap-4 mb-6">
              <div className={`p-3 rounded-full shrink-0 ${isDestructive ? 'bg-red-500/10 text-red-500' : 'bg-bg-surface-hover text-text-main'}`}>
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-text-main mb-1">{title}</h3>
                <p className="text-sm text-text-muted leading-relaxed">{message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button 
                onClick={onCancel}
                className="px-4 py-2 rounded-xl font-medium text-text-muted hover:bg-bg-surface-hover hover:text-text-main transition-colors"
              >
                {cancelText}
              </button>
              <button 
                onClick={onConfirm}
                className={`px-4 py-2 rounded-xl font-medium transition-colors ${
                  isDestructive 
                    ? 'bg-red-500 text-text-main hover:bg-red-600' 
                    : 'bg-text-main text-bg-main hover:bg-text-secondary'
                }`}
              >
                {confirmText}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
