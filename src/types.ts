export interface Tag {
  id: string;
  name: string;
  color: string;
  isCustom?: boolean;
}

export interface HeaderBlockVariation {
  id: string;
  name: string;
  content: string;
  copyCount?: number;
}

export interface HeaderBlock {
  id: string;
  title: string;
  content: string;
  variations?: HeaderBlockVariation[];
  activeVariationId?: string;
  copyCount?: number;
  lastCopiedVariation?: string;
  isSwapped?: boolean;
  isOriginal?: boolean;
  order?: number;
  nextVariationNumber?: number;
}

export interface DeletedHeaderBlock extends HeaderBlock {
  deletedAt: number;
  sourceId: string; // ID of the card or prompt project it came from
  sourceType: 'card' | 'prompt';
}

export interface CardVariation {
  id: string;
  name: string;
  headerBlocks: HeaderBlock[];
}

export interface Card {
  id: string;
  name: string;
  images: string[];
  summary: string;
  mainTag?: string;
  tags: string[];
  headerBlocks: HeaderBlock[];
  variations?: CardVariation[];
  activeVariationId?: string;
  createdAt: number;
  updatedAt?: number;
  isPinned?: boolean;
  order?: number;
  deletedAt?: number;
  nextGenerationNumber?: number;
}

export interface Project {
  id: string;
  name: string;
  cardIds: string[];
  createdAt: number;
  /** Epoch ms of the last edit. Added in schema 2; backfilled from createdAt. */
  updatedAt?: number;
  color?: string;
  deletedAt?: number;
  isPinned?: boolean;
}

export interface PromptHistory {
  id: string;
  date: number;
  blocks: HeaderBlock[];
}

export interface PromptProject {
  id: string;
  name: string;
  createdAt: number;
  /** Epoch ms of the last edit. Added in schema 2; backfilled from createdAt. */
  updatedAt?: number;
  color?: string;
  blocks: HeaderBlock[];
  history: PromptHistory[];
  deletedAt?: number;
  isPinned?: boolean;
}
