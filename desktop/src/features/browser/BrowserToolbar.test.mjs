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
