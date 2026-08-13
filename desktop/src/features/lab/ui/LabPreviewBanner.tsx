import { ShieldCheck } from "lucide-react";
import { isLabV2Preview } from "@/features/lab/previewMode";

export function LabPreviewBanner() {
  if (!isLabV2Preview()) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-500/25 bg-amber-500/8 px-4 py-2 text-xs text-amber-700 dark:text-amber-300"
      data-testid="lab-preview-safety-banner"
    >
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
      <strong>Safe staging · fictional data</strong>
      <span className="text-amber-700/75 dark:text-amber-300/75">
        No production relay, account, keys, or community content.
      </span>
      <span className="ml-auto font-mono text-2xs opacity-70">
        {import.meta.env.VITE_PREVIEW_COMMIT || "local preview"}
      </span>
    </div>
  );
}
