import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { installCssSprings } from "./components/motion";
import "./index.css";

installCssSprings();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
