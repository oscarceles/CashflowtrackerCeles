import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AuthGate from "./Auth";

createRoot(document.getElementById("root")).render(
  <AuthGate>
    <App />
  </AuthGate>
);
