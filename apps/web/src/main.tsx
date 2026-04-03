import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Missing #root mount node.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
