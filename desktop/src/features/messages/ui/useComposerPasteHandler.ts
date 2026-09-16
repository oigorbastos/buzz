import * as React from "react";
import type { Editor } from "@tiptap/react";
import { handleAgentSnapshotPaste } from "@/features/messages/lib/agentSnapshotClipboard";
import type { BlobDescriptor } from "@/shared/api/tauri";
import { hasMentionClipboardHtml } from "@/features/messages/lib/normalizeMentionClipboard";
import { handleMentionClipboardPaste } from "@/features/messages/lib/mentionClipboardPaste";
import type { BindPastedMentionIdentities } from "@/features/messages/lib/mentionPasteBinding";
import { getBuzzCodeBlockClipboardText } from "@/shared/lib/codeBlockClipboard";
import { readImageFromSystemClipboard } from "@/shared/api/tauriMedia";

export function useComposerPasteHandler(options: {
  editor: Editor | null;
  /**
   * Teaches the composer each `name → pubkey` pair a Buzz copy carried, once
   * trusted state vouches for it. Without it, a paste binds nothing.
   */
  bindMentionIdentities?: BindPastedMentionIdentities;
  scrollToBottom: () => void;
  setPendingImeta: (
    update: (current: BlobDescriptor[]) => BlobDescriptor[],
  ) => void;
  uploadFile: (file: File) => Promise<unknown>;
}) {
  const uploadFileRef = React.useRef(options.uploadFile);
  uploadFileRef.current = options.uploadFile;
  const bindMentionIdentitiesRef = React.useRef(options.bindMentionIdentities);
  bindMentionIdentitiesRef.current = options.bindMentionIdentities;
  React.useEffect(() => {
    const editor = options.editor;
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        handlePaste: (view, event) => {
          const mediaItem = Array.from(event.clipboardData?.items ?? []).find(
            (item) => item.kind === "file",
          );
          if (mediaItem) {
            const file = mediaItem.getAsFile();
            if (file) void uploadFileRef.current(file);
            return true;
          }
          // WebKitGTK (Linux) fires `paste` with an empty DataTransfer when
          // the clipboard holds only an image: no items, no files, no text.
          // WebView2 and WKWebView expose such images as a file item above,
          // so reaching here with a fully empty event is the Linux signature.
          // Read the image natively and feed it through the same upload path.
          if (isEmptyClipboardEvent(event)) {
            void readImageFromSystemClipboard()
              .then((file) => {
                if (file) void uploadFileRef.current(file);
              })
              .catch(() => {
                // Nothing on the clipboard the webview could show us either;
                // a failed native read leaves the paste as the no-op it was.
              });
            return true;
          }
          const codeBlockText = getBuzzCodeBlockClipboardText(
            event.clipboardData,
          );
          if (codeBlockText !== null) {
            event.preventDefault();
            editor
              .chain()
              .focus()
              .insertContent([
                {
                  type: "codeBlock",
                  content:
                    codeBlockText.length > 0
                      ? [{ type: "text", text: codeBlockText }]
                      : [],
                },
                { type: "paragraph" },
              ])
              .run();
            options.scrollToBottom();
            return true;
          }
          if (handleAgentSnapshotPaste(event, options.setPendingImeta))
            return true;
          const clipboardData = event.clipboardData;
          const html = clipboardData?.getData("text/html");
          if (clipboardData && html && hasMentionClipboardHtml(html)) {
            if (clipboardData.getData("text/plain").includes("\n")) {
              options.scrollToBottom();
            }
            return handleMentionClipboardPaste({
              bindMentionIdentities: bindMentionIdentitiesRef.current,
              clipboardData,
              preventDefault: () => event.preventDefault(),
              view,
            });
          }
          if ((clipboardData?.getData("text/plain") ?? "").includes("\n"))
            options.scrollToBottom();
          return false;
        },
      },
    });
  }, [options.editor, options.scrollToBottom, options.setPendingImeta]);
}

function isEmptyClipboardEvent(event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  if (!data) return true;
  if (data.items.length > 0 || data.files.length > 0) return false;
  return (
    data.types.length === 0 &&
    data.getData("text/plain") === "" &&
    data.getData("text/html") === ""
  );
}
