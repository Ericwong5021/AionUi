import { uuid } from '@/common/utils';

export type ConversationCommandQueueItem = {
  id: string;
  input: string;
  files: string[];
  createdAt: number;
};

export type ConversationCommandQueueState = {
  items: ConversationCommandQueueItem[];
  isPaused: boolean;
};

export type ConversationCommandQueueFailure = {
  id: string;
  commandId: string;
  message: string;
};

export type AcpSessionCommandQueueState = ConversationCommandQueueState & {
  isInteractionLocked: boolean;
  failure: ConversationCommandQueueFailure | null;
};

export const MAX_QUEUED_COMMANDS = 20;
export const MAX_QUEUED_COMMAND_INPUT_LENGTH = 20_000;
export const MAX_QUEUED_COMMAND_FILES = 50;
export const MAX_QUEUED_COMMAND_STATE_BYTES = 256 * 1024;

export type QueueValidationFailureReason =
  | 'emptyInput'
  | 'inputTooLong'
  | 'tooManyFiles'
  | 'queueFull'
  | 'queueTooLarge';

export type QueueValidationSuccess = {
  ok: true;
  nextStateBytes: number;
};

export type QueueValidationFailure = {
  ok: false;
  reason: QueueValidationFailureReason;
};

export const createDefaultQueueState = (): ConversationCommandQueueState => ({
  items: [],
  isPaused: false,
});

export const createDefaultAcpSessionCommandQueueState = (): AcpSessionCommandQueueState => ({
  ...createDefaultQueueState(),
  isInteractionLocked: false,
  failure: null,
});

export const uniqueQueuedCommandFiles = (files: string[]): string[] => Array.from(new Set(files.filter(Boolean)));

export const isQueuedCommandInputEmpty = (input: string): boolean => input.trim().length === 0;

const measureQueueStateBytes = (state: ConversationCommandQueueState): number =>
  new TextEncoder().encode(JSON.stringify(state)).length;

const normalizeQueueItem = (item: unknown): ConversationCommandQueueItem | null => {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.input !== 'string' ||
    !Array.isArray(candidate.files) ||
    !candidate.files.every((file) => typeof file === 'string') ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return null;
  }

  const normalizedItem: ConversationCommandQueueItem = {
    id: candidate.id,
    input: candidate.input,
    files: uniqueQueuedCommandFiles(candidate.files),
    createdAt: candidate.createdAt,
  };

  if (
    isQueuedCommandInputEmpty(normalizedItem.input) ||
    normalizedItem.input.length > MAX_QUEUED_COMMAND_INPUT_LENGTH ||
    normalizedItem.files.length > MAX_QUEUED_COMMAND_FILES
  ) {
    return null;
  }

  return normalizedItem;
};

export const normalizeQueueState = (state: unknown): ConversationCommandQueueState => {
  if (!state || typeof state !== 'object') {
    return createDefaultQueueState();
  }

  const candidate = state as Partial<ConversationCommandQueueState>;
  const normalizedItems = Array.isArray(candidate.items)
    ? candidate.items.map(normalizeQueueItem).filter((item): item is ConversationCommandQueueItem => item !== null)
    : [];
  const items: ConversationCommandQueueItem[] = [];

  for (const item of normalizedItems.slice(0, MAX_QUEUED_COMMANDS)) {
    const nextItems = [...items, item];
    const nextState = {
      items: nextItems,
      isPaused: Boolean(candidate.isPaused),
    };

    if (measureQueueStateBytes(nextState) > MAX_QUEUED_COMMAND_STATE_BYTES) {
      break;
    }

    items.push(item);
  }

  return {
    items,
    isPaused: items.length > 0 ? Boolean(candidate.isPaused) : false,
  };
};

export const estimateQueueStateBytes = (state: ConversationCommandQueueState): number =>
  measureQueueStateBytes(normalizeQueueState(state));

export const createQueuedCommandItem = ({
  input,
  files,
}: Pick<ConversationCommandQueueItem, 'input' | 'files'>): ConversationCommandQueueItem => ({
  id: uuid(),
  input,
  files: uniqueQueuedCommandFiles(files),
  createdAt: Date.now(),
});

export const getQueueValidationFailureReason = (
  state: ConversationCommandQueueState
): QueueValidationFailureReason | null => {
  if (state.items.length > MAX_QUEUED_COMMANDS) {
    return 'queueFull';
  }

  if (state.items.some((item) => isQueuedCommandInputEmpty(item.input))) {
    return 'emptyInput';
  }

  if (state.items.some((item) => item.input.length > MAX_QUEUED_COMMAND_INPUT_LENGTH)) {
    return 'inputTooLong';
  }

  if (state.items.some((item) => item.files.length > MAX_QUEUED_COMMAND_FILES)) {
    return 'tooManyFiles';
  }

  if (measureQueueStateBytes(state) > MAX_QUEUED_COMMAND_STATE_BYTES) {
    return 'queueTooLarge';
  }

  return null;
};

export const validateQueuedCommandItem = (
  item: ConversationCommandQueueItem,
  state: ConversationCommandQueueState
): QueueValidationSuccess | QueueValidationFailure => {
  const nextState = {
    ...state,
    items: [...state.items, item],
  };
  const failureReason = getQueueValidationFailureReason(nextState);
  if (failureReason) {
    return { ok: false, reason: failureReason };
  }
  const nextStateBytes = measureQueueStateBytes(nextState);
  return { ok: true, nextStateBytes };
};

export const removeQueuedCommand = (
  items: ConversationCommandQueueItem[],
  commandId: string
): ConversationCommandQueueItem[] => items.filter((item) => item.id !== commandId);

export const reorderQueuedCommand = (
  items: ConversationCommandQueueItem[],
  activeCommandId: string,
  overCommandId: string
): ConversationCommandQueueItem[] => {
  const fromIndex = items.findIndex((item) => item.id === activeCommandId);
  const targetIndex = items.findIndex((item) => item.id === overCommandId);

  if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(targetIndex, 0, movedItem);
  return nextItems;
};

export const restoreQueuedCommand = (
  items: ConversationCommandQueueItem[],
  failedItem: ConversationCommandQueueItem
): ConversationCommandQueueItem[] => [failedItem, ...removeQueuedCommand(items, failedItem.id)];

export const updateQueuedCommand = (
  items: ConversationCommandQueueItem[],
  commandId: string,
  updates: Partial<Pick<ConversationCommandQueueItem, 'input' | 'files'>>
): ConversationCommandQueueItem[] =>
  items.map((item) =>
    item.id === commandId
      ? {
          ...item,
          ...updates,
          files: updates.files ? uniqueQueuedCommandFiles(updates.files) : item.files,
        }
      : item
  );

export const shouldEnqueueConversationCommand = ({
  enabled = true,
  isBusy,
  hasPendingCommands,
}: {
  enabled?: boolean;
  isBusy: boolean;
  hasPendingCommands: boolean;
}): boolean => enabled && (isBusy || hasPendingCommands);
