import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

import {
  buildWorkspaceProfile,
  canMountBrowserSurface,
} from "@/features/browser/browserProfile";
import { useFeatureEnabled, usePreviewFeatureWarning } from "@/shared/features";

const BrowserScreen = React.lazy(async () => {
  const module = await import("@/features/browser/BrowserScreen");
  return { default: module.BrowserScreen };
});

export const Route = createFileRoute("/browser")({
  component: BrowserRouteComponent,
});

function BrowserRouteComponent() {
  const enabled = useFeatureEnabled("browser");
  const canMount = canMountBrowserSurface(enabled, buildWorkspaceProfile);

  if (!canMount) {
    return (
      <main
        className="flex h-full items-center justify-center p-6"
        data-testid="browser-preview-locked"
      >
        <section className="max-w-lg rounded-2xl border border-border/60 bg-card p-6">
          <h1 className="text-lg font-semibold">Web Workspace fechado</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Ative o preview em Configurações e use um build com perfil
            operacional aprovado. Nenhum comando Browser foi executado.
          </p>
        </section>
      </main>
    );
  }

  return (
    <React.Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Preparando Web Workspace…
        </div>
      }
    >
      {buildWorkspaceProfile === "operator" ? <BrowserPreviewWarning /> : null}
      <BrowserScreen />
    </React.Suspense>
  );
}

function BrowserPreviewWarning() {
  usePreviewFeatureWarning("browser");
  return null;
}
