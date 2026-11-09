import type { ReactNode } from "react";
import { call, native } from "./api";

export async function openExternalLink(url: string) {
  if (native) {
    await call("open_external_link", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export default function ExternalLink({ href, className, children }: {
  href: string; className?: string; children: ReactNode;
}) {
  return <a href={href} className={className} rel="noreferrer"
    onClick={event => { event.preventDefault(); void openExternalLink(href).catch(() => {}); }}>{children}</a>;
}
