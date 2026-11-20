import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import App from "./App";
import { applyTheme, loadTheme, themeCss } from "./theme/themes";
import { applySettings, getSettings } from "./lib/settings";

// palette CSS + saved theme before the first render, so there is no flash
const style = document.createElement("style");
style.textContent = themeCss();
document.head.appendChild(style);
applyTheme(loadTheme());
applySettings(getSettings());

// no browser context menu (Back, Reload, Print…) in a desktop app; text fields keep cut / copy / paste
document.addEventListener("contextmenu", (e) => {
  if (!(e.target as Element | null)?.closest?.("input, textarea, [contenteditable], .cm-editor")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
