"use client";

import dynamic from "next/dynamic";
import { Logo } from "./Logo";

const ChatApp = dynamic(() => import("./ChatApp").then((m) => m.ChatApp), {
  ssr: false,
  loading: () => (
    <div className="app-backdrop grid h-dvh place-items-center">
      <Logo className="size-10 animate-pulse" glow />
    </div>
  ),
});

export function ClientApp() {
  return <ChatApp />;
}
