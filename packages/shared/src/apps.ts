export interface StreamingApp {
  id: string;
  name: string;
  url: string;
  color: string;
}

// Para adicionar um serviço novo, inclua uma linha aqui.
// O launcher (/tv), o controle (/controle), o agente e a extensão leem esta lista.
export const STREAMING_APPS: StreamingApp[] = [
  // youtube.com/tv was discontinued for desktop browsers (shows a redirect
  // interstitial instead of the TV interface), so the regular site is used.
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com", color: "#FF0000" },
  { id: "netflix", name: "Netflix", url: "https://www.netflix.com", color: "#E50914" },
  // HBO Max migrou para "Max" (https://www.max.com) em 2023-2024.
  // No Brasil a marca voltou a "HBO Max" em 2025 (https://www.hbomax.com).
  // Mantemos hbomax.com como padrão; troque para max.com se necessário.
  { id: "hbo", name: "HBO", url: "https://www.hbomax.com", color: "#5B2BE0" },
  { id: "disney", name: "Disney+", url: "https://www.disneyplus.com", color: "#113CCF" },
];

export const APP_IDS = STREAMING_APPS.map((a) => a.id);

export function getAppUrl(id: string): string | undefined {
  return STREAMING_APPS.find((a) => a.id === id)?.url;
}
