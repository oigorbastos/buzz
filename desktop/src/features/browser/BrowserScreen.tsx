import * as React from "react";
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";

import {
  copyApprovedPresetUrl,
  getBrowserSecurityStatus,
  openApprovedPresetExternally,
} from "./browserClient";
import { recordBrowserMetric } from "./browserMetrics";
import { workspaceSurfaceLabel } from "./browserProfile";
import type {
  BrowserPreset,
  BrowserPresetId,
  BrowserSecurityStatus,
} from "./browserTypes";
import { BrowserToolbar } from "./BrowserToolbar";

type LoadState =
  | { kind: "error"; message: string }
  | { kind: "loading" }
  | { kind: "ready"; status: BrowserSecurityStatus };

export function BrowserScreen() {
  const [loadState, setLoadState] = React.useState<LoadState>({
    kind: "loading",
  });
  const [selectedPreset, setSelectedPreset] =
    React.useState<BrowserPresetId | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [retryGeneration, setRetryGeneration] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoadState({ kind: "loading" });
    if (retryGeneration === 0) {
      recordBrowserMetric("surface_opened");
    }

    void getBrowserSecurityStatus()
      .then((status) => {
        if (cancelled) return;
        setLoadState({ kind: "ready", status });
        setSelectedPreset((current) =>
          status.presets.some((preset) => preset.id === current)
            ? current
            : (status.presets[0]?.id ?? null),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível consultar a fronteira de segurança.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [retryGeneration]);

  const status = loadState.kind === "ready" ? loadState.status : null;
  const presets = status?.presets ?? [];
  const selected =
    presets.find((preset) => preset.id === selectedPreset) ?? null;
  const surfaceLabel = workspaceSurfaceLabel(status?.profile ?? "disabled");

  const selectPreset = React.useCallback((preset: BrowserPresetId) => {
    setSelectedPreset(preset);
    recordBrowserMetric("preset_selected", preset);
  }, []);

  const perform = React.useCallback(
    async (action: "copy" | "external", preset: BrowserPreset | null) => {
      if (!preset) return;
      setBusy(true);
      try {
        if (action === "copy") {
          await copyApprovedPresetUrl(preset.id);
          recordBrowserMetric("url_copied", preset.id);
          toast.success("URL aprovada copiada");
        } else {
          await openApprovedPresetExternally(preset.id);
          recordBrowserMetric("opened_external", preset.id);
        }
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "A ação do Web Workspace falhou.",
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-screen">
      <TopChromeInsetHeader data-tauri-drag-region flush>
        <BrowserToolbar
          busy={busy || loadState.kind === "loading"}
          onCopyUrl={() => void perform("copy", selected)}
          onOpenExternal={() => void perform("external", selected)}
          onSelectPreset={selectPreset}
          presets={presets}
          selectedPreset={selectedPreset}
          surfaceLabel={surfaceLabel}
        />
      </TopChromeInsetHeader>

      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background p-5">
        {loadState.kind === "loading" ? (
          <p className="text-sm text-muted-foreground">
            Verificando a fronteira do Web Workspace…
          </p>
        ) : null}

        {loadState.kind === "error" ? (
          <section className="w-full max-w-xl rounded-2xl border border-destructive/30 bg-card p-6">
            <h1 className="text-lg font-semibold">
              Web Workspace indisponível
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {loadState.message}
            </p>
            <Button
              className="mt-5"
              onClick={() => setRetryGeneration((value) => value + 1)}
              variant="outline"
            >
              <RefreshCw />
              Tentar novamente
            </Button>
          </section>
        ) : null}

        {status ? (
          <section className="w-full max-w-2xl rounded-2xl border border-amber-500/25 bg-card p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-amber-500/10 p-2 text-amber-600">
                <ShieldCheck className="size-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold">
                  Navegação interna ainda bloqueada
                </h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  O renderer local e os destinos aprovados estão prontos, mas
                  esta versão do WebView2 não permite comprovar todos os gates
                  de permissões e histórico sem enfraquecer a fronteira Tauri.
                  Nenhuma página remota é carregada dentro do Buzz.
                </p>
              </div>
            </div>

            {selected ? (
              <div className="mt-5 rounded-xl border border-border/60 bg-muted/30 p-4">
                <p className="font-medium">{selected.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selected.subtitle}
                </p>
                <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
                  {selected.url_display}
                </p>
                <Button
                  className="mt-4"
                  disabled={busy}
                  onClick={() => void perform("external", selected)}
                >
                  <ExternalLink />
                  Abrir no navegador externo
                </Button>
              </div>
            ) : (
              <p className="mt-5 rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
                Este build não possui um perfil e destinos aprovados
                compatíveis.
              </p>
            )}

            <p className="mt-4 text-xs text-muted-foreground">
              Gate remoto: fechado · capability do child: nenhuma · AppManifest:{" "}
              {status.app_manifest_command_count} comandos inventariados
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
