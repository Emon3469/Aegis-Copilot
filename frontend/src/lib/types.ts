export type Role = "user" | "assistant";

export interface Source {
  type: "internal" | "web";
  title: string;
  source: string;
  url?: string | null;
  page?: number | null;
}

export interface AnswerMeta {
  route?: string;
  model?: string;
  latency_ms?: number;
  support_status?: string;
  usefulness?: string;
  used_web_search?: boolean;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  steps?: string[];
  sources?: Source[];
  meta?: AnswerMeta;
  streaming?: boolean;
  error?: string;
}

export interface Chat {
  id: string;
  title: string;
  folderId: string | null;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export interface Folder {
  id: string;
  name: string;
}

export type StreamEvent =
  | { type: "status"; text: string }
  | { type: "reset" }
  | { type: "token"; text: string }
  | { type: "sources"; sources: Source[] }
  | ({ type: "done"; answer: string; sources: Source[]; trace: string[] } & AnswerMeta)
  | { type: "error"; message: string; detail?: string };

export interface Health {
  status: string;
  warm: boolean;
  knowledge_base: string;
  llm: { provider: string; model: string; healthy: boolean }[];
  web_search: boolean;
}

export interface Stats {
  total: number;
  avg_latency_ms: number;
  web_searches: number;
  grounded_rate: number;
  routes: Record<string, number>;
}
