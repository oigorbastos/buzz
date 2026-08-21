import * as React from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { Button } from "@/shared/ui/button";

import {
  copyApprovedPresetUrl,
  getBrowserRuntimeState,
  getBrowserSecurityStatus,
  hideBrowserChild,
  mountBrowserChild,
  navigateBrowserBack,
  navigateBrowserForward,
  navigateBrowserHome,
  openApprovedPresetExternally,
  reloadBrowser,
  setBrowserChildBounds,
} from "./browserClient";
import { recordBrowserMetric } from "./browserMetrics";
import {
  buildWorkspaceProfile,
  workspaceProfilesMatch,
  workspaceSurfaceLabel,
} from "./browserProfile";
import type {
  BrowserBounds,
  BrowserPreset,
  BrowserPresetId,
  BrowserRuntimeState,
  BrowserSecurityStatus,
} from "./browserTypes";
import { BrowserToolbar } from "./BrowserToolbar";

type LoadState =
  | { kind: "error"; message: string }
  | { kind: "loading" }
  | { kind: "ready"; status: BrowserSecurityStatus };

function elementBounds(element: HTMLElement): BrowserBounds | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function boundsKey(bounds: BrowserBounds) {
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .map((value) => value.toFixed(2))
    .join(":");
}

function hasBlockingOverlay() {
  return Boolean(
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [data-testid="boot-splash-overlay"], [data-testid="onboarding-entering-curtain"], [data-testid="community-change-overlay"], [data-testid="relay-connection-overlay"], [data-testid="relay-error-overlay"], .buzz-huddle-shell[data-huddle-open="true"], [data-sonner-toast], [data-radix-popper-content-wrapper], [data-state="open"][role="menu"], [data-state="open"][role="listbox"]',
    ),
  );
}

export function BrowserScreen() {
  const [loadState, setLoadState] = React.useState<LoadState>({
    kind: "loading",
  });
  const [selectedPreset, setSelectedPreset] =
    React.useState<BrowserPresetId | null>(null);
  const [runtimeState, setRuntimeState] =
    React.useState<BrowserRuntimeState | null>(null);
  const [runtimeError, setRuntimeError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [retryGeneration, setRetryGeneration] = React.useState(0);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const lifecycleRef = React.useRef({
    epoch: 0,
    queue: Promise.resolve(),
  });

  React.useEffect(() => {
    let cancelled = false;
    setLoadState({ kind: "loading" });
    if (retryGeneration === 0) recordBrowserMetric("surface_opened");

    void getBrowserSecurityStatus()
      .then((status) => {
        if (cancelled) return;
        if (!workspaceProfilesMatch(buildWorkspaceProfile, status.profile)) {
          setSelectedPreset(null);
          setLoadState({
            kind: "error",
            message:
              "O perfil do renderer não corresponde à política nativa deste build.",
          });
          return;
        }
        if (!status.remote_content_enabled) {
          setSelectedPreset(null);
          setLoadState({
            kind: "error",
            message:
              "A navegação integrada está disponível no Buzz para Windows.",
          });
          return;
        }
        if (!status.configured || status.presets.length === 0) {
          setSelectedPreset(null);
          setLoadState({
            kind: "error",
            message: "Este build não possui destinos Web aprovados.",
          });
          return;
        }
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

  React.useEffect(() => {
    if (!selectedPreset || !status?.remote_content_enabled) return;
    const host = hostRef.current;
    if (!host) return;
    if (retryGeneration > 0) setRuntimeError(null);

    let cancelled = false;
    let mounted = false;
    let childVisible = false;
    let lastBounds = "";
    let frame = 0;
    const epoch = lifecycleRef.current.epoch + 1;
    lifecycleRef.current.epoch = epoch;

    const enqueue = (operation: () => Promise<void>) => {
      const next = lifecycleRef.current.queue
        .catch(() => undefined)
        .then(operation);
      lifecycleRef.current.queue = next.catch(() => undefined);
    };

    const fail = (error: unknown) => {
      if (cancelled) return;
      setRuntimeError(
        error instanceof Error
          ? error.message
          : "Não foi possível abrir o destino dentro do Buzz.",
      );
      enqueue(async () => {
        await hideBrowserChild().catch(() => undefined);
        childVisible = false;
      });
    };

    const syncBounds = () => {
      frame = 0;
      enqueue(async () => {
        if (cancelled || lifecycleRef.current.epoch !== epoch) return;
        if (hasBlockingOverlay()) {
          await hideBrowserChild().catch(() => undefined);
          childVisible = false;
          return;
        }
        const bounds = elementBounds(host);
        if (!bounds) return;
        const key = boundsKey(bounds);
        if (mounted && childVisible && key === lastBounds) return;
        lastBounds = key;
        try {
          const state =
            mounted && childVisible
              ? await setBrowserChildBounds(bounds)
              : await mountBrowserChild(selectedPreset, bounds);
          if (
            cancelled ||
            lifecycleRef.current.epoch !== epoch ||
            hasBlockingOverlay()
          ) {
            await hideBrowserChild().catch(() => undefined);
            childVisible = false;
            return;
          }
          mounted = true;
          childVisible = true;
          setRuntimeError(null);
          setRuntimeState(state);
        } catch (error) {
          fail(error);
        }
      });
    };

    const scheduleBounds = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncBounds);
    };

    const observer = new ResizeObserver(scheduleBounds);
    const overlayObserver = new MutationObserver(scheduleBounds);
    observer.observe(host);
    overlayObserver.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: [
        "data-huddle-open",
        "data-state",
        "data-testid",
        "role",
      ],
    });
    window.addEventListener("resize", scheduleBounds);
    window.addEventListener("scroll", scheduleBounds, true);
    scheduleBounds();

    return () => {
      cancelled = true;
      lifecycleRef.current.epoch += 1;
      observer.disconnect();
      overlayObserver.disconnect();
      window.removeEventListener("resize", scheduleBounds);
      window.removeEventListener("scroll", scheduleBounds, true);
      if (frame !== 0) cancelAnimationFrame(frame);
      enqueue(async () => {
        await hideBrowserChild().catch(() => undefined);
        childVisible = false;
      });
    };
  }, [retryGeneration, selectedPreset, status?.remote_content_enabled]);

  React.useEffect(() => {
    if (!runtimeState?.mounted) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getBrowserRuntimeState()
        .then((state) => {
          if (!cancelled) setRuntimeState(state);
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runtimeState?.mounted]);

  const selectPreset = React.useCallback((preset: BrowserPresetId) => {
    setRuntimeState(null);
    setSelectedPreset(preset);
    recordBrowserMetric("preset_selected", preset);
  }, []);

  const performLinkAction = React.useCallback(
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

  const performRuntimeAction = React.useCallback(
    async (action: () => Promise<BrowserRuntimeState>) => {
      setBusy(true);
      try {
        const next = await action();
        setRuntimeState(next);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "A navegação integrada falhou.",
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
          canGoBack={runtimeState?.can_go_back ?? false}
          canGoForward={runtimeState?.can_go_forward ?? false}
          onBack={() => void performRuntimeAction(navigateBrowserBack)}
          onCopyUrl={() => void performLinkAction("copy", selected)}
          onForward={() => void performRuntimeAction(navigateBrowserForward)}
          onHome={() =>
            selectedPreset
              ? void performRuntimeAction(() =>
                  navigateBrowserHome(selectedPreset),
                )
              : undefined
          }
          onOpenExternal={() => void performLinkAction("external", selected)}
          onReload={() => void performRuntimeAction(reloadBrowser)}
          onSelectPreset={selectPreset}
          presets={presets}
          runtimeReady={Boolean(runtimeState?.mounted)}
          selectedPreset={selectedPreset}
          surfaceLabel={surfaceLabel}
        />
      </TopChromeInsetHeader>

      {loadState.kind === "error" ? (
        <main className="flex min-h-0 flex-1 items-center justify-center bg-background p-5">
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
        </main>
      ) : (
        <main
          className="relative min-h-0 flex-1 overflow-hidden bg-background"
          data-testid="browser-child-host"
          ref={hostRef}
        >
          {loadState.kind === "loading" || !runtimeState?.mounted ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              Abrindo o destino aprovado…
            </div>
          ) : null}
          {runtimeError ? (
            <section className="absolute inset-5 z-10 m-auto h-fit max-w-xl rounded-2xl border border-destructive/30 bg-card p-6 shadow-lg">
              <h1 className="text-lg font-semibold">
                Não foi possível navegar
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {runtimeError}
              </p>
              <div className="mt-5 flex gap-2">
                <Button
                  onClick={() => setRetryGeneration((value) => value + 1)}
                  variant="outline"
                >
                  <RefreshCw />
                  Tentar novamente
                </Button>
                <Button
                  onClick={() => void performLinkAction("external", selected)}
                >
                  Abrir externamente
                </Button>
              </div>
            </section>
          ) : null}
        </main>
      )}
    </div>
  );
}
