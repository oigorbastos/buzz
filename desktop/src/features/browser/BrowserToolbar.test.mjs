import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BrowserToolbar } from "./BrowserToolbar.tsx";

test("toolbar exposes the approved MVP controls without an address bar", () => {
  const html = renderToStaticMarkup(
    createElement(BrowserToolbar, {
      busy: false,
      canGoBack: true,
      canGoForward: false,
      onBack() {},
      onCopyUrl() {},
      onForward() {},
      onHome() {},
      onOpenExternal() {},
      onReload() {},
      onSelectPreset() {},
      presets: [
        {
          id: "mission-control",
          label: "Mission Control",
          subtitle: "Operação Alis",
          url_display: "http://approved.example/mission",
        },
      ],
      runtimeReady: true,
      selectedPreset: "mission-control",
      surfaceLabel: "Web",
    }),
  );

  for (const label of [
    "Destino do Web Workspace",
    "Voltar",
    "Avançar",
    "Recarregar",
    "Início",
    "Copiar URL aprovada",
    "Abrir externamente",
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.equal(html.includes('type="text"'), false);
  assert.doesNotMatch(html, /aria-label="Voltar"[^>]*disabled/);
  assert.match(html, /aria-label="Avançar"[^>]*disabled/);
  assert.doesNotMatch(html, /aria-label="Recarregar"[^>]*disabled/);
});

test("toolbar keeps native navigation disabled until the child is mounted", () => {
  const html = renderToStaticMarkup(
    createElement(BrowserToolbar, {
      busy: false,
      canGoBack: false,
      canGoForward: false,
      onBack() {},
      onCopyUrl() {},
      onForward() {},
      onHome() {},
      onOpenExternal() {},
      onReload() {},
      onSelectPreset() {},
      presets: [
        {
          id: "sessions",
          label: "Sessions",
          subtitle: "LLM",
          url_display: "https://approved.example/",
        },
      ],
      runtimeReady: false,
      selectedPreset: "sessions",
      surfaceLabel: "Web",
    }),
  );

  assert.match(html, /aria-label="Recarregar"[^>]*disabled/);
  assert.match(html, /aria-label="Início"[^>]*disabled/);
  assert.doesNotMatch(html, /aria-label="Copiar URL aprovada"[^>]*disabled/);
});
