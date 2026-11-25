import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Event Ops",
    short_name: "Event Ops",
    description: "Live scoring, timing, and dispatch",
    start_url: "/",
    display: "standalone",
    background_color: "#FAFAF9",
    theme_color: "#4F46E5",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  };
}
