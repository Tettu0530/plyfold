import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { installCssSprings } from "./components/motion";
import { isMac } from "./lib/platform";
import "./index.css";

installCssSprings();
// macOS draws thin overlay scrollbars itself; elsewhere (Windows' classic bars, WebKitGTK) the app draws its own
if (!isMac) document.documentElement.classList.add("own-scrollbars");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
