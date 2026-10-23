import React from "react";
import ReactDOM from "react-dom/client";
import App from "../confeitaria-metanoia-app.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("sw register failed", e));
  });
}
