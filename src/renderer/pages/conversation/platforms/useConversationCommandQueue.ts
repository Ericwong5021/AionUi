import {
  createDefaultQueueState,
  createQueuedCommandItem,
  estimateQueueStateBytes,
  getQueueValidationFailureReason,
  MAX_QUEUED_COMMAND_FILES,
  MAX_QUEUED_COMMAND_INPUT_LENGTH,
  MAX_QUEUED_COMMANDS,
  MAX_QUEUED_COMMAND_STATE_BYTES,
  normalizeQueueState,
  removeQueuedCommand,
  reorderQueuedCommand,
  restoreQueuedCommand,
  shouldEnqueueConversationCommand,
  updateQueuedCommand,
  validateQueuedCommandItem,
  type ConversationCommandQueueItem,
  type ConversationCommandQueueState,
  type QueueValidationFailure,
  type QueueValidationFailureReason,
  type QueueValidationSuccess,
} from '@/common/chat/commandQueue';
import { useAddEventListener } from '@/renderer/utils/emitter';
import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

export {
  createDefaultQueueState,
  createQueuedCommandItem,
  estimateQueueStateBytes,
  MAX_QUEUED_COMMAND_FILES,
  MAX_QUEUED_COMMAND_INPUT_LENGTH,
  MAX_QUEUED_COMMANDS,
  MAX_QUEUED_COMMAND_STATE_BYTES,
  normalizeQueueState,
  removeQueuedCommand,
  reorderQueuedCommand,
  restoreQueuedCommand,
  shouldEnqueueConversationCommand,
  updateQueuedCommand,
  validateQueuedCommandItem,
};
export type { ConversationCommandQueueItem, ConversationCommandQueueState, QueueValidationFailureReason };

const COMMAND_QUEUE_LOG_PREFIX = '[conversation-command-queue]';

const summarizeQueuedCommand = (item: ConversationCommandQueueItem): Record<string, unknown> => ({
  id: item.id,
  createdAt: item.createdAt,
  inputLength: item.input.length,
  fileCount: item.files.length,
  preview: item.input.replace(/\s+/g, ' ').trim().slice(0, 120),
});

const logCommandQueue = (conversationId: string, event: string, payload: Record<string, unknown> = {}): void => {
  console.info(COMMAND_QUEUE_LOG_PREFIX, {
    conversationId,
    event,
    ...payload,
  });
};

const queueStore = new Map<string, ConversationCommandQueueState>();

const getStorageKey = (conversationId: string): string => `conversation-command-queue/${conversationId}`;

const isQueueValidationFailure = (
  validation: QueueValidationSuccess | QueueValidationFailure
): validation is QueueValidationFailure => !validation.ok;

const readPersistedQueueState = (conversationId: string): ConversationCommandQueueState => {
  if (queueStore.has(conversationId)) {
    return queueStore.get(conversationId) ?? createDefaultQueueState();
  }

  if (typeof window === 'undefined') {
    return createDefaultQueueState();
  }

  try {
    const stored = window.sessionStorage.getItem(getStorageKey(conversationId));
    if (!stored) {
      return createDefaultQueueState();
    }

    const parsed = JSON.parse(stored) as unknown;
    const normalized = normalizeQueueState(parsed);
    queueStore.set(conversationId, normalized);
    logCommandQueue(conversationId, 'restored', {
      itemCount: normalized.items.length,
      isPaused: normalized.isPaused,
    });
    return normalized;
  } catch (error) {
    console.warn('[conversation-command-queue] Failed to read persisted queue state:', error);
    return createDefaultQueueState();
  }
};

const removePersistedQueueState = (conversationId: string): void => {
  queueStore.delete(conversationId);
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(getStorageKey(conversationId));
    } catch (error) {
      console.warn('[conversation-command-queue] Failed to remove persisted queue state:', error);
    }
  }
};

const persistQueueState = (conversationId: string, state: ConversationCommandQueueState): void => {
  const normalized = normalizeQueueState(state);

  if (normalized.items.length === 0 && !normalized.isPaused) {
    removePersistedQueueState(conversationId);
    return;
  }

  queueStore.set(conversationId, normalized);
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(getStorageKey(conversationId), JSON.stringify(normalized));
    } catch (error) {
      console.warn('[conversation-command-queue] Failed to persist queue state:', error);
    }
  }
};

type UseConversationCommandQueueOptions = {
  conversationId: string;
  enabled?: boolean;
  isBusy: boolean;
  isHydrated?: boolean;
  onExecute: (item: ConversationCommandQueueItem) => Promise<void>;
};

type EnqueueCommandInput = Pick<ConversationCommandQueueItem, 'input' | 'files'>;
type UpdateCommandInput = Pick<ConversationCommandQueueItem, 'input'>;

const getQueueValidationMessage = (
  t: (key: string, options?: Record<string, unknown>) => string,
  reason: QueueValidationFailureReason
): string => {
  const warningKeyMap = {
    emptyInput: 'conversation.commandQueue.emptyInput',
    queueFull: 'conversation.commandQueue.queueFull',
    inputTooLong: 'conversation.commandQueue.inputTooLong',
    tooManyFiles: 'conversation.commandQueue.tooManyFiles',
    queueTooLarge: 'conversation.commandQueue.queueTooLarge',
  } as const;
  const defaultValueMap = {
    emptyInput: 'Queued commands cannot be empty.',
    queueFull: 'Queue is full. Remove a command before adding more.',
    inputTooLong: 'This queued command is too long. Shorten it before sending.',
    tooManyFiles: 'Too many files are attached to this queued command.',
    queueTooLarge: 'Queue data is too large to persist safely. Remove some queued commands first.',
  } as const;

  return t(warningKeyMap[reason], {
    count: MAX_QUEUED_COMMANDS,
    files: MAX_QUEUED_COMMAND_FILES,
    defaultValue: defaultValueMap[reason],
  });
};

export const useConversationCommandQueue = ({
  conversationId,
  enabled = true,
  isBusy,
  isHydrated = true,
  onExecute,
}: UseConversationCommandQueueOptions) => {
  const { t } = useTranslation();
  const { data = createDefaultQueueState(), mutate } = useSWR(
    [`/conversation-command-queue/${conversationId}`, conversationId, enabled],
    ([, id, isEnabled]) => (isEnabled ? readPersistedQueueState(id) : createDefaultQueueState())
  );

  const stateRef = useRef(data);
  const pausedRef = useRef(data.isPaused);
  const waitingForTurnStartRef = useRef(false);
  const waitingForTurnCompletionRef = useRef(false);
  const interactionLockedRef = useRef(false);
  const [isInteractionLocked, setIsInteractionLocked] = useState(false);
  const [executionGateVersion, setExecutionGateVersion] = useState(0);

  useEffect(() => {
    stateRef.current = data;
  }, [data]);

  useEffect(() => {
    if (waitingForTurnStartRef.current && isBusy) {
      waitingForTurnStartRef.current = false;
      waitingForTurnCompletionRef.current = true;
      logCommandQueue(conversationId, 'turn-started', {
        pendingItemCount: stateRef.current.items.length,
      });
      return;
    }

    if (waitingForTurnCompletionRef.current && !isBusy) {
      waitingForTurnCompletionRef.current = false;
      logCommandQueue(conversationId, 'turn-finished', {
        pendingItemCount: stateRef.current.items.length,
      });
    }
  }, [conversationId, isBusy]);

  useEffect(() => {
    pausedRef.current = data.isPaused;
  }, [data.isPaused]);

  useEffect(() => {
    interactionLockedRef.current = isInteractionLocked;
  }, [isInteractionLocked]);

  useEffect(() => {
    if (enabled) {
      return;
    }

    waitingForTurnStartRef.current = false;
    waitingForTurnCompletionRef.current = false;
    pausedRef.current = false;
    interactionLockedRef.current = false;
    stateRef.current = createDefaultQueueState();
    setIsInteractionLocked(false);
    removePersistedQueueState(conversationId);
    void mutate(createDefaultQueueState(), { revalidate: false });
  }, [conversationId, enabled, mutate]);

  const updateState = useCallback(
    (
      updater: (state: ConversationCommandQueueState) => ConversationCommandQueueState
    ): Promise<ConversationCommandQueueState | undefined> => {
      if (!enabled) {
        const nextState = createDefaultQueueState();
        stateRef.current = nextState;
        pausedRef.current = false;
        removePersistedQueueState(conversationId);
        return Promise.resolve(nextState);
      }

      return mutate(
        (current) => {
          const nextState = normalizeQueueState(updater(current ?? createDefaultQueueState()));
          stateRef.current = nextState;
          pausedRef.current = nextState.isPaused;
          persistQueueState(conversationId, nextState);
          return nextState;
        },
        { revalidate: false }
      );
    },
    [conversationId, enabled, mutate]
  );

  const clear = useCallback(() => {
    waitingForTurnStartRef.current = false;
    waitingForTurnCompletionRef.current = false;
    pausedRef.current = false;
    logCommandQueue(conversationId, 'cleared');
    void updateState(() => createDefaultQueueState());
  }, [conversationId, updateState]);

  useAddEventListener(
    'conversation.deleted',
    (deletedConversationId) => {
      if (deletedConversationId !== conversationId) {
        return;
      }
      clear();
      removePersistedQueueState(conversationId);
    },
    [clear, conversationId]
  );

  const enqueue = useCallback(
    ({ input, files }: EnqueueCommandInput) => {
      if (!enabled) {
        return null;
      }

      const currentState = normalizeQueueState(stateRef.current);
      const item = createQueuedCommandItem({ input, files });
      const validation = validateQueuedCommandItem(item, currentState);

      if (isQueueValidationFailure(validation)) {
        const reason: QueueValidationFailureReason = validation.reason;
        logCommandQueue(conversationId, 'enqueue-rejected', {
          reason,
          item: summarizeQueuedCommand(item),
          currentItemCount: currentState.items.length,
        });
        Message.warning(getQueueValidationMessage(t, reason));
        return null;
      }

      const nextState: ConversationCommandQueueState = {
        ...currentState,
        items: [...currentState.items, item],
      };
      stateRef.current = nextState;
      logCommandQueue(conversationId, 'enqueued', {
        item: summarizeQueuedCommand(item),
        currentItemCount: currentState.items.length,
      });
      void updateState(() => nextState);
      return item;
    },
    [conversationId, enabled, t, updateState]
  );

  const update = useCallback(
    (commandId: string, { input }: UpdateCommandInput) => {
      if (!enabled) {
        return false;
      }

      const currentState = normalizeQueueState(stateRef.current);
      const currentItem = currentState.items.find((item) => item.id === commandId);
      if (!currentItem) {
        return false;
      }

      const nextItems = updateQueuedCommand(currentState.items, commandId, { input });
      const nextState: ConversationCommandQueueState = {
        isPaused: false,
        items: nextItems,
      };
      const failureReason = getQueueValidationFailureReason(nextState);

      if (failureReason) {
        logCommandQueue(conversationId, 'update-rejected', {
          reason: failureReason,
          commandId,
          inputLength: input.length,
        });
        Message.warning(getQueueValidationMessage(t, failureReason));
        return false;
      }

      stateRef.current = nextState;
      logCommandQueue(conversationId, 'updated', {
        commandId,
        inputLength: input.length,
      });
      void updateState(() => nextState);
      return true;
    },
    [conversationId, enabled, t, updateState]
  );

  const remove = useCallback(
    (commandId: string) => {
      if (!enabled) {
        return;
      }

      logCommandQueue(conversationId, 'removed', {
        commandId,
      });
      void updateState((state) => {
        const nextItems = removeQueuedCommand(state.items, commandId);
        return {
          items: nextItems,
          isPaused: false,
        };
      });
    },
    [conversationId, enabled, updateState]
  );

  const reorder = useCallback(
    (activeCommandId: string, overCommandId: string) => {
      if (!enabled) {
        return;
      }

      logCommandQueue(conversationId, 'reordered', {
        activeCommandId,
        overCommandId,
      });
      void updateState((state) => ({
        isPaused: false,
        items: reorderQueuedCommand(state.items, activeCommandId, overCommandId),
      }));
    },
    [conversationId, enabled, updateState]
  );

  const pause = useCallback(() => {
    if (!enabled) {
      return;
    }

    pausedRef.current = true;
    waitingForTurnStartRef.current = false;
    waitingForTurnCompletionRef.current = false;
    logCommandQueue(conversationId, 'paused', {
      itemCount: data.items.length,
    });
    void updateState((state) => {
      if (state.items.length === 0) {
        pausedRef.current = false;
        return createDefaultQueueState();
      }
      return {
        ...state,
        isPaused: true,
      };
    });
  }, [conversationId, data.items.length, enabled, updateState]);

  const resume = useCallback(() => {
    if (!enabled) {
      return;
    }

    pausedRef.current = false;
    logCommandQueue(conversationId, 'resumed', {
      itemCount: data.items.length,
    });
    void updateState((state) => ({
      ...state,
      isPaused: state.items.length > 0 ? false : state.isPaused,
    }));
  }, [conversationId, data.items.length, enabled, updateState]);

  const lockInteraction = useCallback(() => {
    if (!enabled) {
      return;
    }

    interactionLockedRef.current = true;
    logCommandQueue(conversationId, 'interaction-locked', {
      itemCount: stateRef.current.items.length,
    });
    setIsInteractionLocked(true);
  }, [conversationId, enabled]);

  const unlockInteraction = useCallback(() => {
    if (!enabled) {
      return;
    }

    interactionLockedRef.current = false;
    logCommandQueue(conversationId, 'interaction-unlocked', {
      itemCount: stateRef.current.items.length,
    });
    setIsInteractionLocked(false);
  }, [conversationId, enabled]);

  const resetActiveExecution = useCallback(
    (reason: 'stop' | 'external-reset') => {
      const hadPendingTurn = waitingForTurnStartRef.current || waitingForTurnCompletionRef.current;
      waitingForTurnStartRef.current = false;
      waitingForTurnCompletionRef.current = false;

      if (!hadPendingTurn) {
        return;
      }

      logCommandQueue(conversationId, 'execution-reset', {
        reason,
        pendingItemCount: stateRef.current.items.length,
      });
      setExecutionGateVersion((version) => version + 1);
    },
    [conversationId]
  );

  useEffect(() => {
    if (
      !enabled ||
      !isHydrated ||
      pausedRef.current ||
      isBusy ||
      waitingForTurnStartRef.current ||
      waitingForTurnCompletionRef.current ||
      interactionLockedRef.current ||
      data.items.length === 0
    ) {
      return;
    }

    const [nextCommand, ...remainingCommands] = data.items;
    waitingForTurnStartRef.current = true;
    logCommandQueue(conversationId, 'dequeued', {
      item: summarizeQueuedCommand(nextCommand),
      remainingItemCount: remainingCommands.length,
    });
    void updateState(() => ({
      items: remainingCommands,
      isPaused: false,
    }));

    void onExecute(nextCommand).catch((error) => {
      console.error('[conversation-command-queue] Failed to execute queued command:', error);
      logCommandQueue(conversationId, 'execute-failed', {
        item: summarizeQueuedCommand(nextCommand),
        error: error instanceof Error ? error.message : String(error),
      });
      waitingForTurnStartRef.current = false;
      waitingForTurnCompletionRef.current = false;
      pausedRef.current = true;
      void updateState((state) => ({
        items: restoreQueuedCommand(state.items, nextCommand),
        isPaused: true,
      }));
      Message.warning(
        t('conversation.commandQueue.pausedAfterFailure', {
          defaultValue: 'The next queued command could not start. Edit, reorder, or remove it to continue.',
        })
      );
    });
  }, [
    conversationId,
    data.items,
    enabled,
    executionGateVersion,
    isBusy,
    isHydrated,
    isInteractionLocked,
    onExecute,
    t,
    updateState,
  ]);

  return {
    items: enabled ? data.items : [],
    isPaused: enabled ? data.isPaused : false,
    isInteractionLocked,
    hasPendingCommands: enabled ? data.items.length > 0 : false,
    enqueue,
    update,
    remove,
    clear,
    reorder,
    pause,
    resume,
    lockInteraction,
    unlockInteraction,
    resetActiveExecution,
  };
};
