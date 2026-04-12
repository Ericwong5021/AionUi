import {
  createDefaultAcpSessionCommandQueueState,
  MAX_QUEUED_COMMAND_FILES,
  MAX_QUEUED_COMMANDS,
  type AcpSessionCommandQueueState,
  type ConversationCommandQueueItem,
  type QueueValidationFailureReason,
} from '@/common/chat/commandQueue';
import { ipcBridge } from '@/common';
import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

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

type UseAcpSessionCommandQueueOptions = {
  conversationId: string;
  enabled?: boolean;
};

type EnqueueCommandInput = Pick<ConversationCommandQueueItem, 'input' | 'files'>;
type UpdateCommandInput = Pick<ConversationCommandQueueItem, 'input'>;

export const useAcpSessionCommandQueue = ({ conversationId, enabled = true }: UseAcpSessionCommandQueueOptions) => {
  const { t } = useTranslation();
  const [state, setState] = useState<AcpSessionCommandQueueState>(createDefaultAcpSessionCommandQueueState());
  const failureIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      void ipcBridge.acpConversation.clearQueue.invoke({ conversationId });
      void ipcBridge.acpConversation.setQueueInteractionLock.invoke({ conversationId, locked: false });
      setState(createDefaultAcpSessionCommandQueueState());
      return;
    }

    let disposed = false;
    void ipcBridge.acpConversation.getQueueState.invoke({ conversationId }).then((result) => {
      if (!disposed && result?.success && result.data?.state) {
        setState(result.data.state);
      }
    });

    const unsubscribe = ipcBridge.acpConversation.queueChanged.on((event) => {
      if (event.conversationId === conversationId) {
        setState(event.state);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [conversationId, enabled]);

  useEffect(() => {
    if (!state.failure || failureIdRef.current === state.failure.id) {
      return;
    }

    failureIdRef.current = state.failure.id;
    Message.warning(
      t('conversation.commandQueue.pausedAfterFailure', {
        defaultValue: 'The next queued command could not start. Edit, reorder, or remove it to continue.',
      })
    );
  }, [state.failure, t]);

  const enqueue = useCallback(
    async ({ input, files }: EnqueueCommandInput) => {
      if (!enabled) {
        return null;
      }

      const result = await ipcBridge.acpConversation.enqueueCommand.invoke({
        conversationId,
        input,
        files,
      });

      if (!result?.success) {
        const reason = result?.data?.reason as QueueValidationFailureReason | undefined;
        Message.warning(getQueueValidationMessage(t, reason ?? 'queueTooLarge'));
        return null;
      }

      return result.data?.item ?? null;
    },
    [conversationId, enabled, t]
  );

  const update = useCallback(
    async (commandId: string, { input }: UpdateCommandInput) => {
      if (!enabled) {
        return false;
      }

      const result = await ipcBridge.acpConversation.updateQueuedCommand.invoke({
        conversationId,
        commandId,
        input,
      });

      if (!result?.success) {
        const reason = result?.data?.reason as QueueValidationFailureReason | undefined;
        if (reason) {
          Message.warning(getQueueValidationMessage(t, reason));
        }
        return false;
      }

      return Boolean(result.data?.updated);
    },
    [conversationId, enabled, t]
  );

  const remove = useCallback(
    (commandId: string) => {
      if (!enabled) {
        return;
      }

      void ipcBridge.acpConversation.removeQueuedCommand.invoke({ conversationId, commandId });
    },
    [conversationId, enabled]
  );

  const clear = useCallback(() => {
    if (!enabled) {
      return;
    }

    void ipcBridge.acpConversation.clearQueue.invoke({ conversationId });
  }, [conversationId, enabled]);

  const reorder = useCallback(
    (activeCommandId: string, overCommandId: string) => {
      if (!enabled) {
        return;
      }

      void ipcBridge.acpConversation.reorderQueue.invoke({
        conversationId,
        activeCommandId,
        overCommandId,
      });
    },
    [conversationId, enabled]
  );

  const pause = useCallback(() => {
    if (!enabled) {
      return;
    }

    void ipcBridge.acpConversation.pauseQueue.invoke({ conversationId });
  }, [conversationId, enabled]);

  const resume = useCallback(() => {
    if (!enabled) {
      return;
    }

    void ipcBridge.acpConversation.resumeQueue.invoke({ conversationId });
  }, [conversationId, enabled]);

  const lockInteraction = useCallback(() => {
    if (!enabled) {
      return;
    }

    void ipcBridge.acpConversation.setQueueInteractionLock.invoke({ conversationId, locked: true });
  }, [conversationId, enabled]);

  const unlockInteraction = useCallback(() => {
    if (!enabled) {
      return;
    }

    void ipcBridge.acpConversation.setQueueInteractionLock.invoke({ conversationId, locked: false });
  }, [conversationId, enabled]);

  const resetActiveExecution = useCallback((_reason: 'stop' | 'external-reset') => {
    return;
  }, []);

  return useMemo(
    () => ({
      items: enabled ? state.items : [],
      isPaused: enabled ? state.isPaused : false,
      isInteractionLocked: enabled ? state.isInteractionLocked : false,
      hasPendingCommands: enabled ? state.items.length > 0 : false,
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
    }),
    [
      clear,
      enabled,
      enqueue,
      lockInteraction,
      pause,
      remove,
      reorder,
      resume,
      state.isInteractionLocked,
      state.isPaused,
      state.items,
      unlockInteraction,
      update,
    ]
  );
};
