import type { ArtKey, FontKey, Theme } from "./model.ts";

export const FONTS: Record<FontKey, { label: string; head: string; body: string; href: string }> = {
  editorial: { label: "Editorial", head: "'Fraunces',Georgia,serif", body: "'Figtree',system-ui,sans-serif",
    href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Figtree:wght@400;500;600;700&display=swap" },
  grotesk: { label: "Grotesk", head: "'Bricolage Grotesque',system-ui,sans-serif", body: "'Figtree',system-ui,sans-serif",
    href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Figtree:wght@400;500;600;700&display=swap" },
  poster: { label: "Poster", head: "'Syne',system-ui,sans-serif", body: "'Manrope',system-ui,sans-serif",
    href: "https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Manrope:wght@400;500;600;700&display=swap" },
  classic: { label: "Classic", head: "'Cormorant Garamond',Georgia,serif", body: "'Jost',system-ui,sans-serif",
    href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Jost:wght@400;500;600&display=swap" },
};

export const THEMES: Record<string, { label: string; theme: Partial<Theme> }> = {
  cobalt: { label: "Cobalt", theme: { primary: "#2B4BFF", text: "#121826", bg: "#FFFFFF", surface: "#F1F3FF", accent: "#FFD23F", font: "grotesk", radius: 12 } },
  moss: { label: "Moss", theme: { primary: "#2F6B4F", text: "#14201A", bg: "#FFFFFF", surface: "#EFF4F0", accent: "#C6F432", font: "editorial", radius: 14 } },
  ember: { label: "Ember", theme: { primary: "#E4442B", text: "#1C1412", bg: "#FFFFFF", surface: "#FBEFEC", accent: "#1C1412", font: "poster", radius: 6 } },
  plum: { label: "Plum", theme: { primary: "#FF7AC6", text: "#F5EEFB", bg: "#15101F", surface: "#201833", accent: "#7DF9C2", font: "grotesk", radius: 18 } },
};

const mesh = (a: string, b: string, c: string, base: string) =>
  `radial-gradient(60% 80% at 12% 18%,${a} 0%,transparent 62%),radial-gradient(55% 70% at 88% 28%,${b} 0%,transparent 62%),radial-gradient(75% 90% at 55% 105%,${c} 0%,transparent 66%),${base}`;

export const ART: Record<ArtKey, { label: string; css: string; dark: boolean }> = {
  aurora: { label: "Aurora", dark: true, css: mesh("#7DF9C2", "#6C8CFF", "#FF8AD8", "#14172B") },
  sunset: { label: "Sunset", dark: false, css: mesh("#FFD27D", "#FF7A59", "#FF4F9A", "#FFE8D6") },
  ocean: { label: "Ocean", dark: true, css: mesh("#4DE1D2", "#2B6BFF", "#1B2A6B", "#0B1B3A") },
  dusk: { label: "Dusk", dark: true, css: mesh("#FF7AC6", "#7A5CFF", "#2B1B6B", "#150F2E") },
  meadow: { label: "Meadow", dark: false, css: mesh("#E6FF8A", "#7FD99A", "#2F9E75", "#EAF7E2") },
  citrus: { label: "Citrus", dark: false, css: mesh("#FFF08A", "#FFB43D", "#FF7A3D", "#FFF6D9") },
  rose: { label: "Rose", dark: false, css: mesh("#FFC2D9", "#FF8FB0", "#C77DFF", "#FFEAF1") },
  noir: { label: "Noir", dark: true, css: "radial-gradient(70% 90% at 85% 0%,#2C3550 0%,transparent 60%),radial-gradient(60% 80% at 0% 100%,#1B2236 0%,transparent 65%),#0C0E15" },
};
