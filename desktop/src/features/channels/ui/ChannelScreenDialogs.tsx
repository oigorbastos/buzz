import { WelcomeAgentCreateDialog } from "@/features/channels/ui/WelcomeAgentCreateDialog";
import { DeleteMessageConfirmDialog } from "@/features/messages/ui/DeleteMessageConfirmDialog";

type ChannelScreenDialogsProps = {
  emptyDeleteId: string | null;
  guideName: string;
  isWelcomeAgentCreateOpen: boolean;
  isWelcomeAgentCreateSending: boolean;
  onCreateWelcomeAgentInChat: () => void;
  onCreateWelcomeAgentManually: () => void;
  onDeleteMessage: (message: { id: string }) => Promise<void> | void;
  onEditTargetChange: (value: string | null) => void;
  onEmptyDeleteIdChange: (value: string | null) => void;
  onWelcomeAgentCreateOpenChange: (open: boolean) => void;
  welcomeAgentCreateError?: string | null;
};

/** Welcome-agent creation and empty-edit deletion dialogs for ChannelScreen. */
export function ChannelScreenDialogs({
  emptyDeleteId,
  guideName,
  isWelcomeAgentCreateOpen,
  isWelcomeAgentCreateSending,
  onCreateWelcomeAgentInChat,
  onCreateWelcomeAgentManually,
  onDeleteMessage,
  onEditTargetChange,
  onEmptyDeleteIdChange,
  onWelcomeAgentCreateOpenChange,
  welcomeAgentCreateError,
}: ChannelScreenDialogsProps) {
  return (
    <>
      <WelcomeAgentCreateDialog
        guideName={guideName}
        isSending={isWelcomeAgentCreateSending}
        onCreateInChat={onCreateWelcomeAgentInChat}
        onCreateManually={onCreateWelcomeAgentManually}
        onOpenChange={onWelcomeAgentCreateOpenChange}
        open={isWelcomeAgentCreateOpen}
        sendError={welcomeAgentCreateError}
      />
      <DeleteMessageConfirmDialog
        onConfirm={() => {
          if (emptyDeleteId) {
            onEditTargetChange(null);
            void onDeleteMessage({ id: emptyDeleteId });
          }
          onEmptyDeleteIdChange(null);
        }}
        onOpenChange={(open) => {
          if (!open) onEmptyDeleteIdChange(null);
        }}
        open={emptyDeleteId !== null}
      />
    </>
  );
}
