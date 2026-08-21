import {
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  Home,
  RotateCw,
  ShieldAlert,
} from "lucide-react";

import { Button } from "@/shared/ui/button";

import type { BrowserPreset, BrowserPresetId } from "./browserTypes";

type BrowserToolbarProps = {
  busy: boolean;
  onCopyUrl: () => void;
  onOpenExternal: () => void;
  onSelectPreset: (preset: BrowserPresetId) => void;
  presets: BrowserPreset[];
  selectedPreset: BrowserPresetId | null;
  surfaceLabel: string;
};

const LOCKED_CONTROL_TITLE = "Disponível após o gate de segurança do WebView2";

export function BrowserToolbar({
  busy,
  onCopyUrl,
  onOpenExternal,
  onSelectPreset,
  presets,
  selectedPreset,
  surfaceLabel,
}: BrowserToolbarProps) {
  const hasPreset = selectedPreset !== null;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 px-4 py-2"
      data-testid="browser-toolbar"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" />
        <span className="hidden text-sm font-medium sm:inline">
          {surfaceLabel}
        </span>
      </div>
      <select
        aria-label="Destino do Web Workspace"
        className="h-8 min-w-44 max-w-full rounded-lg border border-input/50 bg-background px-2 text-sm"
        disabled={busy || presets.length === 0}
        onChange={(event) =>
          onSelectPreset(event.currentTarget.value as BrowserPresetId)
        }
        value={selectedPreset ?? ""}
      >
        {presets.length === 0 ? (
          <option value="">Nenhum destino configurado</option>
        ) : null}
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-1">
        <Button
          aria-label="Voltar"
          disabled
          size="icon"
          title={LOCKED_CONTROL_TITLE}
          variant="ghost"
        >
          <ArrowLeft />
        </Button>
        <Button
          aria-label="Avançar"
          disabled
          size="icon"
          title={LOCKED_CONTROL_TITLE}
          variant="ghost"
        >
          <ArrowRight />
        </Button>
        <Button
          aria-label="Recarregar"
          disabled
          size="icon"
          title={LOCKED_CONTROL_TITLE}
          variant="ghost"
        >
          <RotateCw />
        </Button>
        <Button
          aria-label="Início"
          disabled
          size="icon"
          title={LOCKED_CONTROL_TITLE}
          variant="ghost"
        >
          <Home />
        </Button>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button
          aria-label="Copiar URL aprovada"
          disabled={busy || !hasPreset}
          onClick={onCopyUrl}
          size="icon"
          title="Copiar URL aprovada"
          variant="ghost"
        >
          <Copy />
        </Button>
        <Button
          disabled={busy || !hasPreset}
          onClick={onOpenExternal}
          size="sm"
          variant="outline"
        >
          <ExternalLink />
          Abrir externamente
        </Button>
      </div>
    </div>
  );
}
