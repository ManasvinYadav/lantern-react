import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// App.tsx owns AuthProvider itself (App.tsx's root export wraps its whole
// tree in <AuthProvider>) — this stays the minimal Vite bootstrap: mount
// point + global stylesheet + StrictMode only.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
