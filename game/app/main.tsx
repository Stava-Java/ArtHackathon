import { createRoot } from "react-dom/client";
import { AssetLab } from "./AssetLab";
import "./globals.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root container not found.");
}

createRoot(container).render(<AssetLab />);
