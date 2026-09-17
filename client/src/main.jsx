import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import AuthGate from "./AuthGate.jsx";

// Mounts the application behind the verified-user authentication gate.
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);